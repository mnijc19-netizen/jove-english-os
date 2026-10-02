import { z } from 'zod'
import type { JoveDatabase } from './db'
import { createLearningRepository } from './repository'
import { sessionSchema } from './schema'
import type { PlanTask, StudySession } from '../domain/types'
import { japaneseCorrectionsDue, japaneseTransferContext } from '../domain/japanese'

const responseSchema = z.strictObject({ response: z.string().max(10_000), audioId: z.string().max(1000), heard: z.boolean() })
const itemSchema = responseSchema.extend({ cardId: z.string(), reps: z.number().int().nonnegative(),
  contextId: z.string().optional(), contextPrompt: z.string().optional(), contextRepeated: z.boolean().optional(),
  correction: z.strictObject({ id: z.string(), phase: z.enum(['retrieval', 'transfer']), materialId: z.string(),
    original: z.string(), corrected: z.string(), hint: z.string(), explanation: z.string() }).optional(),
  revealed: z.boolean(), hintUsed: z.boolean(), rating: z.number().int().min(1).max(4).optional(), skipped: z.literal('schedule-changed').optional() })
export const japaneseReviewDraft = z.strictObject({ taskId: z.string(), minutes: z.number().int().positive(),
  revision: z.number().int().nonnegative(), items: z.array(itemSchema).min(1).max(5),
  audioUnavailable: z.boolean().optional(), missingAudioIds: z.array(z.string()).optional() })
export type JapaneseReviewResponse = z.infer<typeof responseSchema>
export function japaneseReviewItemKey(item: Pick<z.infer<typeof itemSchema>, 'cardId' | 'correction'>) {
  return item.correction ? `correction:${item.correction.id}:${item.correction.phase}` : item.cardId
}

/** Same FSRS/evidence implementation, immutable Japanese database and owner.
 * A self-rated recall changes its own schedule, never acoustic/skill mastery. */
export function createJapaneseReview(database: JoveDatabase, checkOwner: () => Promise<void>, fence: () => Promise<void>) {
  if (database.language !== 'ja') throw new Error('Japanese review requires its own workspace')
  const repository = createLearningRepository(database)
  async function start(task: PlanTask, now = Date.now()): Promise<StudySession> {
    if (task.kind !== 'review' || task.done || task.optional || task.minutes <= 0) throw new Error('复习安排已更新')
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await fence()
      const id = `ja-review:${task.id}`, previous = await database.sessions.get(id)
      if (previous) return previous
      const date = new Date(now).toLocaleDateString('en-CA')
      const events = await database.events.toArray()
      const olderChunks = new Set((await database.chunks.toArray()).filter(chunk => chunk.createdAt <= now && new Date(chunk.createdAt).toLocaleDateString('en-CA') !== date).map(chunk => chunk.id))
      const due = (await database.cards.toArray()).filter(card => card.modality !== 'listening' && olderChunks.has(card.chunkId) && card.card.due.getTime() <= now)
        .sort((a, b) => a.card.due.getTime() - b.card.due.getTime() || a.id.localeCompare(b.id))
      // One modality per expression in this block: seeing a sibling's answer
      // must not prime a second supposedly independent retrieval immediately.
      const selected: typeof due = [], seen = new Set<string>()
      for (const card of due) if (!seen.has(card.chunkId)) { selected.push(card); seen.add(card.chunkId) }
      const limit = Math.min(5, task.minutes)
      const items: z.infer<typeof itemSchema>[] = []
      // Reserve one targeted correction while keeping ordinary recall available.
      for (const correction of japaneseCorrectionsDue(events, now).slice(0, 1)) {
        const data = correction.confirmation.data!
        const context = correction.phase === 'transfer' ? japaneseTransferContext(String(data.materialId), events, String(data.contextId)) : undefined
        // A correction is a saved practice item, not a fabricated FSRS card.
        // Empty optional selections preserve backup/sync reference integrity.
        items.push({ cardId: '', reps: 0,
          response: '', audioId: '', heard: false, revealed: false, hintUsed: false,
          ...(context ? { contextId: context.id, contextPrompt: context.prompt, contextRepeated: context.repeated } : {}),
          correction: { id: correction.confirmation.id, phase: correction.phase, materialId: String(data.materialId),
            original: String(data.original), corrected: String(data.corrected), hint: String(data.hint), explanation: String(data.explanation) } })
      }
      for (const card of selected.slice(0, limit - items.length)) {
        const chunk = await database.chunks.get(card.chunkId)
        const materialId = chunk?.sourceIds.find(id => id.startsWith('ja-irodori-'))
        const context = card.modality === 'transfer' && materialId ? japaneseTransferContext(materialId, events) : undefined
        items.push({ cardId: card.id, reps: card.card.reps, response: '', audioId: '', heard: false, revealed: false, hintUsed: false,
          ...(context ? { contextId: context.id, contextPrompt: context.prompt, contextRepeated: context.repeated } : {}) })
      }
      if (!items.length) throw new Error('目前没有需要延迟复习的日语词块，请返回今日安排。')
      const session = sessionSchema.parse({ id, kind: 'japanese-review', startedAt: now, stage: 'recall',
        draft: { taskId: task.id, minutes: task.minutes, revision: 0, items } })
      await database.sessions.add(session)
      for (const item of items) if (item.contextId) await repository.recordEvent({ id: `${id}:context:${japaneseReviewItemKey(item)}`,
        type: 'JAPANESE_CONTEXT_ASSIGNED', source: 'objective', timestamp: now, sessionId: id, contextId: item.contextId,
        data: { contextId: item.contextId, contextPrompt: item.contextPrompt!, repeated: item.contextRepeated ?? true } })
      await repository.recordEvent({ id: `${id}:started`, type: 'TASK_STARTED', source: 'objective', timestamp: now, sessionId: id,
        data: { taskId: task.id, minutes: task.minutes } })
      return session
    })
  }
  async function read(id: string) {
    const session = await database.sessions.get(id)
    if (!session || session.kind !== 'japanese-review') throw new Error('日语复习记录不存在')
    return { session, draft: japaneseReviewDraft.parse(session.draft) }
  }
  async function persist(session: StudySession, draft: z.infer<typeof japaneseReviewDraft>, now: number) {
    const finished = draft.items.every(item => item.rating || item.skipped)
    const saved = sessionSchema.parse({ ...session, draft, ...(finished ? { stage: 'completed', completedAt: now } : {}) })
    await database.sessions.put(saved)
    if (finished) {
      const plan = await database.plans.get(new Date(now).toLocaleDateString('en-CA'))
      const task = plan?.tasks.find(task => task.id === draft.taskId), practiced = draft.items.some(item => item.rating)
      if (task && plan) {
        task.done = practiced
        if (!practiced) { task.optional = true; plan.minutes = plan.tasks.reduce((sum, item) => sum + (item.optional ? 0 : item.minutes), 0) }
        await database.plans.put(plan)
      }
      if (practiced) await repository.recordEvent({ id: `${session.id}:completed`, type: 'TASK_COMPLETED', timestamp: now, source: 'objective', sessionId: session.id,
        data: { taskId: draft.taskId, minutes: task?.minutes ?? draft.minutes, carriedOver: !task } })
    }
    return saved
  }
  async function save(id: string, revision: number, input: JapaneseReviewResponse, reveal = false, now = Date.now()) {
    const response = responseSchema.parse(input)
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await fence()
      const { session, draft } = await read(id), item = draft.items.find(item => !item.rating && !item.skipped)
      if (!item || session.completedAt || draft.revision !== revision) throw new Error('复习已在其他页面更新，请重新打开；没有覆盖旧回答。')
      if (item.revealed) throw new Error('首答已锁定，请先完成对照；不要将修改后的答案当作独立回忆。')
      const card = await database.cards.get(item.cardId)
      if (!item.correction && (!card || card.card.reps !== item.reps)) throw new Error('复习卡片已更新，请保留回答并重新打开。')
      if (response.audioId) {
        const audio = await database.audio.get(response.audioId)
        if (!audio?.blob.size || audio.kind !== 'recording') throw new Error('请先保存日语录音原件。')
        if (item.correction) {
          const original = await database.events.get(item.correction.id)
          if (original?.data?.originalAudioId === response.audioId || audio.createdAt < session.startedAt)
            throw new Error('请为这个新情境重新录音；上次的原件继续保留。')
        }
      }
      Object.assign(item, response)
      if (reveal) {
        const oral = item.correction ? item.correction.phase === 'transfer' : card!.modality === 'speaking' || card!.modality === 'transfer'
        const attempted = oral ? !!response.audioId && (!item.correction || !!response.response.trim())
          : !!response.response.trim() && (card?.modality !== 'listening' || response.heard)
        item.hintUsed = !attempted; item.revealed = true
        await repository.recordEvent({ id: `${id}:response:${japaneseReviewItemKey(item)}`, type: 'REVIEW_RESPONSE', source: 'self-report', timestamp: now,
          sessionId: id, ...(card ? { chunkId: card.chunkId, modality: card.modality } : {}), prompted: item.hintUsed,
          data: { taskId: draft.taskId, response: item.response, heard: item.heard, ...(item.audioId ? { audioId: item.audioId } : {}),
            ...(item.contextId ? { contextId: item.contextId } : {}),
            transcriptVerified: false, acousticAssessed: false } })
      }
      draft.revision++
      const saved = sessionSchema.parse({ ...session, draft })
      await database.sessions.put(saved)
      return saved
    })
  }
  async function rate(id: string, revision: number, rating: 1 | 2 | 3 | 4, now = Date.now()) {
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await fence()
      const { session, draft } = await read(id), item = draft.items.find(item => !item.rating && !item.skipped)
      if (session.completedAt) return session
      if (!item || !item.revealed || draft.revision !== revision) throw new Error('请先保存首答并对照，再选择记忆情况。')
      const card = await database.cards.get(item.cardId)
      const audio = item.audioId ? await database.audio.get(item.audioId) : undefined
      const savedAudio = audio?.kind === 'recording' && audio.blob.size > 0
      if (item.correction) {
        const prompted = item.hintUsed || item.correction.phase === 'transfer' && (!savedAudio || !item.response.trim())
        await repository.recordEvent({ id: `${id}:correction:${japaneseReviewItemKey(item)}`, type: 'JAPANESE_CORRECTION_REVIEW', source: 'self-report',
          timestamp: now, sessionId: id, prompted,
          data: { correctionId: item.correction.id, phase: item.correction.phase, rating, response: item.response,
            ...(item.contextId ? { contextId: item.contextId, contextRepeated: item.contextRepeated ?? true } : {}),
            ...(savedAudio ? { audioId: item.audioId } : {}), masteryAssessed: false, acousticAssessed: false } })
        item.rating = rating; draft.revision++
        return persist(session, draft, now)
      }
      if (card?.modality === 'listening') {
        // Also protect already-started legacy blocks. Preserve the first answer
        // and the entire FSRS card; a generic clip cannot update this expression.
        await repository.recordEvent({ id: `${id}:unbound-listening:${item.cardId}`, type: 'JAPANESE_UNBOUND_LISTENING', source: 'self-report',
          timestamp: now, sessionId: id, chunkId: card.chunkId, modality: card.modality,
          data: { cardId: item.cardId, response: item.response, heard: item.heard, scheduleChanged: false } })
        item.rating = rating; draft.revision++
        return persist(session, draft, now)
      }
      const missingOral = (card?.modality === 'speaking' || card?.modality === 'transfer') && !savedAudio
      await repository.reviewCard(item.cardId, rating, { expectedReps: item.reps, source: 'self-report', prompted: item.hintUsed || missingOral,
        eventId: `${id}:rating:${item.cardId}`, responseEventId: `${id}:response:${item.cardId}`, sessionId: id,
        ...(item.contextId ? { contextId: item.contextId } : {}),
        ...(savedAudio ? { audioId: item.audioId } : {}) })
      item.rating = rating; draft.revision++
      return persist(session, draft, now)
    })
  }
  /** Preserve the unscheduled response, but never apply it to a card already
   * advanced by another tab/device. Remaining block items stay usable. */
  async function recover(id: string, revision: number, input: JapaneseReviewResponse, now = Date.now()) {
    const response = responseSchema.parse(input)
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await fence()
      const { session, draft } = await read(id), item = draft.items.find(item => !item.rating && !item.skipped)
      if (session.completedAt) return session
      if (!item || draft.revision !== revision) throw new Error('复习记录已更新，请保留输入并刷新。')
      const card = await database.cards.get(item.cardId)
      if (!card || card.card.reps === item.reps) throw new Error('这张卡片没有可恢复的进度冲突，请重试原来的保存。')
      if (!item.revealed) {
        if (response.audioId) {
          const audio = await database.audio.get(response.audioId)
          if (!audio?.blob.size || audio.kind !== 'recording') throw new Error('录音原件尚未保存。')
        }
        Object.assign(item, response)
      }
      item.skipped = 'schedule-changed'; draft.revision++
      await repository.recordEvent({ id: `${id}:conflict:${item.cardId}`, type: 'JAPANESE_REVIEW_CONFLICT', source: 'self-report', timestamp: now,
        sessionId: id, chunkId: card.chunkId, modality: card.modality,
        data: { taskId: draft.taskId, response: item.response, previousReps: item.reps, currentReps: card.card.reps,
          ...(item.audioId ? { audioId: item.audioId } : {}), scheduleChanged: true } })
      return persist(session, draft, now)
    })
  }
  return { start, read, save, rate, recover }
}
