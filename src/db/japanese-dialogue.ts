import Dexie from 'dexie'
import { z } from 'zod'
import type { JoveDatabase } from './db'
import type { PlanTask, StudySession } from '../domain/types'
import type { LearningProvider } from '../ai/cloud-provider'
import { evaluatedResultSchema } from '../ai/schemas'
import { japaneseLessons } from '../content/japanese'
import { sessionSchema } from './schema'
import { createLearningRepository } from './repository'

const text = z.string().max(2000), audioId = z.string().max(1000).default('')
const answer = z.strictObject({ text, audioId, confirmed: z.boolean() })
const turn = answer.extend({ id: z.string(), reply: z.string().max(4000).optional(), replyKind: z.enum(['ai', 'offline']).optional(),
  attempts: z.number().int().min(0).max(2), sendingAt: z.number().optional(), failed: z.boolean().optional() })
export const japaneseDialogueDraft = z.strictObject({ revision: z.number().int().nonnegative(), taskId: z.string(), minutes: z.number().int().positive(),
  answer, transcript: text, turns: z.array(turn).max(3), comparison: text, retryAudioId: audioId,
  feedback: evaluatedResultSchema.optional(), feedbackAttempts: z.number().int().min(0).max(2), feedbackSendingAt: z.number().optional(),
  audioUnavailable: z.boolean().optional(), missingAudioIds: z.array(z.string()).optional(),
})
export type JapaneseDialogueDraft = z.infer<typeof japaneseDialogueDraft>
const offlineReplies = ['そうですか。もう少し教えてください。', 'わかりました。何か聞きたいことはありますか。', 'ありがとうございました。']

/** Saved interaction rehearsal, not a pronunciation or verified fluency score.
 * Requests retain immutable input and separate result receipts. No automatic
 * paid redispatch; two attempts per reply/summary, then an explicit offline path. */
export function createJapaneseDialogue(database: JoveDatabase, checkOwner: () => Promise<void>, fence: () => Promise<void>, sharedFence: () => Promise<void>) {
  if (database.language !== 'ja') throw new Error('Wrong Japanese dialogue workspace')
  const repository = createLearningRepository(database), received = new Map<string, unknown>()
  async function transactionFence() {
    // waitFor must not run a mixed operation that also accesses the active
    // transaction. Read only the other database outside its transaction zone,
    // then check this workspace inside its own still-active transaction.
    await Dexie.waitFor(Dexie.ignoreTransaction(sharedFence)); await fence()
  }
  async function read(id: string) {
    await checkOwner()
    const session = await database.sessions.get(id)
    if (!session || session.kind !== 'japanese-dialogue') throw new Error('日语对话记录不存在')
    await checkOwner()
    return { session, draft: japaneseDialogueDraft.parse(session.draft) }
  }
  async function change(id: string, revision: number | undefined, update: (draft: JapaneseDialogueDraft, session: StudySession) => Promise<void> | void) {
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await transactionFence()
      const session = await database.sessions.get(id)
      if (!session || session.kind !== 'japanese-dialogue' || session.completedAt) throw new Error('对话已结束或更新，原回答仍保留。')
      const draft = japaneseDialogueDraft.parse(session.draft)
      if (revision !== undefined && draft.revision !== revision) throw new Error('对话在其他页面更新，请保留本页文字并重新载入。')
      await update(draft, session); draft.revision++
      const saved = sessionSchema.parse({ ...session, draft: japaneseDialogueDraft.parse(draft) })
      await database.sessions.put(saved)
      return { session: saved, draft: japaneseDialogueDraft.parse(saved.draft) }
    })
  }
  async function original(id: string) {
    const asset = await database.audio.get(id)
    if (!asset?.blob.size || asset.kind !== 'recording') throw new Error('请先把录音原件保存在日语区。')
    return asset
  }
  async function start(task: PlanTask, now = Date.now()) {
    if (task.kind !== 'speak' || !task.materialId || task.done || task.optional || task.minutes < 1
      || !japaneseLessons.some(lesson => lesson.id === task.materialId)) throw new Error('对话安排已更新，请返回今日任务。')
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await transactionFence()
      const id = `ja-dialogue:${task.id}`, previous = await database.sessions.get(id)
      if (previous) return previous
      const draft: JapaneseDialogueDraft = { revision: 0, taskId: task.id, minutes: task.minutes, answer: { text: '', audioId: '', confirmed: false },
        transcript: '', turns: [], comparison: '', retryAudioId: '', feedbackAttempts: 0 }
      const session = sessionSchema.parse({ id, kind: 'japanese-dialogue', materialId: task.materialId, startedAt: now, stage: 'interact', draft })
      await database.sessions.add(session)
      await repository.recordEvent({ id: `${id}:started`, type: 'TASK_STARTED', source: 'objective', timestamp: now, sessionId: id,
        data: { taskId: task.id, materialId: task.materialId!, minutes: task.minutes } })
      return session
    })
  }
  async function save(id: string, revision: number, input: z.infer<typeof answer>, comparison: string) {
    const value = answer.parse(input), note = text.parse(comparison)
    return change(id, revision, async draft => {
      if (value.audioId) await original(value.audioId)
      if (draft.turns.at(-1) && !draft.turns.at(-1)!.reply && JSON.stringify(value) !== JSON.stringify(draft.answer)) throw new Error('先恢复上一轮回复；已发出的回答不会被覆盖。')
      draft.answer = value; draft.comparison = note
    })
  }
  async function attach(id: string, revision: number, assetId: string, retry = false) {
    return change(id, revision, async draft => {
      await original(assetId)
      if (retry) draft.retryAudioId = assetId
      else {
        if (draft.turns.length >= 3 || draft.turns.at(-1) && !draft.turns.at(-1)!.reply) throw new Error('这一轮已经发送，原录音仍保留。')
        draft.answer.audioId = assetId; draft.answer.confirmed = false; draft.transcript = ''
      }
    })
  }
  async function receipt(id: string) {
    await checkOwner()
    const saved = await database.sessions.get(id)
    return saved?.kind === 'japanese-dialogue-result' ? saved.draft.value : received.get(id)
  }
  async function keepReceipt(id: string, practice: StudySession, value: unknown) {
    received.set(id, value)
    await checkOwner()
    const stored = await database.transaction('rw', database.sessions, database.syncMeta, async () => {
      await transactionFence()
      const prior = await database.sessions.get(id)
      if (prior && prior.kind !== 'japanese-dialogue-result') throw new Error('回复存档冲突，未覆盖原记录。')
      if (!prior) await database.sessions.add(sessionSchema.parse({ id, kind: 'japanese-dialogue-result', materialId: practice.materialId,
        startedAt: Date.now(), completedAt: Date.now(), stage: 'received', draft: { value } }))
      return prior?.draft.value ?? value
    })
    received.delete(id)
    return stored
  }
  function verifyProvider(provider: LearningProvider) { if (provider.learningLanguage !== 'ja') throw new Error('Wrong dialogue AI language') }
  async function transcribe(id: string, revision: number, provider: LearningProvider, signal: AbortSignal) {
    verifyProvider(provider)
    signal.throwIfAborted()
    const { session, draft } = await read(id), assetId = draft.answer.audioId
    if (draft.revision !== revision || !assetId || draft.turns.at(-1) && !draft.turns.at(-1)!.reply) throw new Error('回答已更新或尚未保存录音，请重新载入。')
    const asset = await original(assetId), key = `${id}:transcript:${assetId}`
    let candidate = await receipt(key)
    if (candidate === undefined) candidate = text.parse(await provider.transcribe(asset.blob, signal))
    candidate = await keepReceipt(key, session, candidate)
    signal.throwIfAborted()
    return change(id, revision, current => {
      if (current.answer.audioId !== assetId) throw new Error('新录音已替换；旧转写候选保留，未覆盖回答。')
      current.transcript = text.parse(candidate)
    })
  }
  async function send(id: string, expected: { revision: number; answer: z.infer<typeof answer> }, provider: LearningProvider | undefined, signal: AbortSignal) {
    if (provider) verifyProvider(provider)
    signal.throwIfAborted()
    const saved = await change(id, expected.revision, async draft => {
      if (JSON.stringify(draft.answer) !== JSON.stringify(answer.parse(expected.answer))) throw new Error('本页回答和已保存版本不同，请先重新载入。')
      if (draft.turns.length >= 3 || draft.turns.at(-1) && !draft.turns.at(-1)!.reply) throw new Error('先完成上一轮回复；没有再次发送。')
      if (!draft.answer.text.trim() || !draft.answer.confirmed) throw new Error('请先核对这轮日语回答。')
      if (draft.answer.audioId) await original(draft.answer.audioId)
      draft.turns.push({ ...draft.answer, id: crypto.randomUUID(), attempts: 0 })
      draft.answer = { text: '', audioId: '', confirmed: false }; draft.transcript = ''
    })
    signal.throwIfAborted()
    return reply(id, saved.draft.turns.at(-1)!.id, provider, signal)
  }
  async function reply(id: string, turnId: string, provider: LearningProvider | undefined, signal: AbortSignal, retry = false) {
    if (provider) verifyProvider(provider)
    signal.throwIfAborted()
    let { session, draft } = await read(id)
    const key = `${id}:reply:${turnId}`
    let cached = await receipt(key)
    const current = draft.turns.find(item => item.id === turnId)
    if (!current) throw new Error('对话回合不存在')
    if (current.reply) return { session, draft }
    if (!provider) return change(id, undefined, value => {
      const index = value.turns.findIndex(item => item.id === turnId), item = value.turns[index]
      if (!item || item.reply) return
      item.reply = offlineReplies[index]!; item.replyKind = 'offline'; delete item.sendingAt
    })
    if (cached === undefined) {
      const claimed = await change(id, draft.revision, value => {
        const item = value.turns.find(item => item.id === turnId)!
        if (item.reply || item.attempts >= 2) throw new Error('本轮已完成或两次请求未成功，请用离线应答继续。')
        if (item.attempts && !retry) throw new Error('上一轮尚无确认回复。先恢复记录；重试可能再次收费。')
        if (item.sendingAt && Date.now() - item.sendingAt < 5 * 60000) throw new Error('上一轮请求仍在等待，不会重复调用。可稍后恢复，或用离线应答继续。')
        item.attempts++; item.sendingAt = Date.now(); delete item.failed
      })
      ;({ session, draft } = claimed)
      const lesson = japaneseLessons.find(item => item.id === session.materialId)!
      const messages = draft.turns.flatMap(item => [{ role: 'user' as const, content: item.text }, ...(item.reply ? [{ role: 'assistant' as const, content: item.reply }] : [])])
      try {
        signal.throwIfAborted()
        cached = z.string().trim().min(1).max(4000).parse(await provider.chat(messages, { scenario: lesson.transferZh, mode: 'three-turn everyday roleplay',
          level: lesson.course === 'starter' ? 'A1; short sentences; native Chinese learner' : 'A2; native Chinese learner', targets: [lesson.phrase] }, undefined, signal))
        cached = await keepReceipt(key, session, cached)
      } catch (failure) {
        await change(id, undefined, value => { const item = value.turns.find(item => item.id === turnId); if (item && !item.reply) { delete item.sendingAt; item.failed = true } }).catch(() => {})
        throw failure
      }
    } else cached = await keepReceipt(key, session, cached)
    signal.throwIfAborted()
    return change(id, undefined, value => {
      const item = value.turns.find(item => item.id === turnId)
      if (!item || item.reply) return
      item.reply = z.string().min(1).max(4000).parse(cached); item.replyKind = 'ai'; delete item.sendingAt
    })
  }
  async function feedback(id: string, provider: LearningProvider, signal: AbortSignal, retry = false) {
    verifyProvider(provider)
    signal.throwIfAborted()
    const { session, draft } = await read(id), key = `${id}:feedback`
    if (draft.feedback) return { session, draft }
    if (draft.turns.length !== 3 || draft.turns.some(item => !item.reply)) throw new Error('先完成三轮应答，再集中改一处。')
    let cached = await receipt(key)
    if (cached === undefined) {
      await change(id, draft.revision, value => {
        if (value.feedbackAttempts >= 2 || value.feedbackAttempts && !retry) throw new Error('先恢复原来的反馈，或对照参考完成重说；不会自动再次调用。')
        if (value.feedbackSendingAt && Date.now() - value.feedbackSendingAt < 5 * 60000) throw new Error('上一份反馈仍在等待。')
        value.feedbackAttempts++; value.feedbackSendingAt = Date.now()
      })
      try {
        signal.throwIfAborted()
        cached = evaluatedResultSchema.parse(await provider.evaluate({ kind: 'japanese-three-turn-interaction',
          text: draft.turns.map((item, index) => `${index + 1}. ${item.text}`).join('\n'),
          reference: JSON.stringify({ scenario: japaneseLessons.find(item => item.id === session.materialId)!.transferZh,
            counterparts: draft.turns.map(item => ({ text: item.reply!.slice(0, 2000), source: item.replyKind })) }),
          rubric: 'Evaluate only the learner text and contextual response, in concise Chinese. Give one priority hint and a new-context full spoken retry prompt. Accept natural alternatives. Never infer pronunciation, prosody, listening or spontaneous fluency from text. Offline counterparts are fixed rehearsal cues, not AI responses or evidence of real interaction.' }, signal))
        cached = await keepReceipt(key, session, cached)
      } catch (failure) {
        await change(id, undefined, value => { delete value.feedbackSendingAt }).catch(() => {})
        throw failure
      }
    } else cached = await keepReceipt(key, session, cached)
    signal.throwIfAborted()
    return change(id, undefined, value => { value.feedback = evaluatedResultSchema.parse(cached); delete value.feedbackSendingAt })
  }
  async function finish(id: string, now = Date.now()) {
    const prior = await read(id)
    if (prior.session.completedAt) return prior
    return change(id, prior.draft.revision, async (draft, session) => {
      if (draft.turns.length !== 3 || draft.turns.some(item => !item.reply) || !draft.comparison.trim() || !draft.retryAudioId
        || draft.turns.some(item => item.audioId === draft.retryAudioId)) throw new Error('请完成三轮应答，写下一处调整，再保存一段完整重说录音。')
      await original(draft.retryAudioId)
      const plan = await database.plans.get(new Date(now).toLocaleDateString('en-CA')), task = plan?.tasks.find(item => item.id === draft.taskId)
      if (plan && task) { task.done = true; await database.plans.put(plan) }
      await repository.recordEvent({ id: `${id}:completed`, type: 'TASK_COMPLETED', source: 'objective', timestamp: now, sessionId: id,
        data: { taskId: draft.taskId, minutes: task?.minutes ?? draft.minutes, carriedOver: !task, materialId: session.materialId!, audioId: draft.retryAudioId } })
      session.completedAt = now; session.stage = 'completed'
    })
  }
  return { start, read, save, attach, send, reply, transcribe, feedback, finish }
}
