import { z } from 'zod'
import type { JoveDatabase } from './db'
import { createLearningRepository } from './repository'
import { sessionSchema } from './schema'
import type { PlanTask, StudySession } from '../domain/types'

const responseSchema = z.strictObject({ response: z.string().max(10_000), audioId: z.string().max(1000), heard: z.boolean() })
const itemSchema = responseSchema.extend({ cardId: z.string(), reps: z.number().int().nonnegative(),
  revealed: z.boolean(), hintUsed: z.boolean(), rating: z.number().int().min(1).max(4).optional(), skipped: z.literal('schedule-changed').optional() })
export const japaneseReviewDraft = z.strictObject({ taskId: z.string(), minutes: z.number().int().positive(),
  revision: z.number().int().nonnegative(), items: z.array(itemSchema).min(1).max(5) })
export type JapaneseReviewResponse = z.infer<typeof responseSchema>

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
      const olderChunks = new Set((await database.chunks.toArray()).filter(chunk => chunk.createdAt <= now && new Date(chunk.createdAt).toLocaleDateString('en-CA') !== date).map(chunk => chunk.id))
      const due = (await database.cards.toArray()).filter(card => olderChunks.has(card.chunkId) && card.card.due.getTime() <= now)
        .sort((a, b) => a.card.due.getTime() - b.card.due.getTime() || a.id.localeCompare(b.id))
      // One modality per expression in this block: seeing a sibling's answer
      // must not prime a second supposedly independent retrieval immediately.
      const selected: typeof due = [], seen = new Set<string>()
      for (const card of due) if (!seen.has(card.chunkId)) { selected.push(card); seen.add(card.chunkId) }
      const items = selected.slice(0, Math.min(5, task.minutes)).map(card => ({ cardId: card.id, reps: card.card.reps,
        response: '', audioId: '', heard: false, revealed: false, hintUsed: false }))
      if (!items.length) throw new Error('目前没有需要延迟复习的日语词块，请返回今日安排。')
      const session = sessionSchema.parse({ id, kind: 'japanese-review', startedAt: now, stage: 'recall',
        draft: { taskId: task.id, minutes: task.minutes, revision: 0, items } })
      await database.sessions.add(session)
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
      if (!card || card.card.reps !== item.reps) throw new Error('复习卡片已更新，请保留回答并重新打开。')
      if (response.audioId) {
        const audio = await database.audio.get(response.audioId)
        if (!audio?.blob.size || audio.kind !== 'recording') throw new Error('请先保存日语录音原件。')
      }
      Object.assign(item, response)
      if (reveal) {
        const oral = card.modality === 'speaking' || card.modality === 'transfer'
        const attempted = oral ? !!response.audioId : !!response.response.trim() && (card.modality !== 'listening' || response.heard)
        item.hintUsed = !attempted; item.revealed = true
        await repository.recordEvent({ id: `${id}:response:${item.cardId}`, type: 'REVIEW_RESPONSE', source: 'self-report', timestamp: now,
          sessionId: id, chunkId: card.chunkId, modality: card.modality, prompted: item.hintUsed,
          data: { taskId: draft.taskId, response: item.response, heard: item.heard, ...(item.audioId ? { audioId: item.audioId } : {}),
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
      await repository.reviewCard(item.cardId, rating, { expectedReps: item.reps, source: 'self-report', prompted: item.hintUsed,
        eventId: `${id}:rating:${item.cardId}`, responseEventId: `${id}:response:${item.cardId}`, sessionId: id,
        ...(item.audioId ? { audioId: item.audioId } : {}) })
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
