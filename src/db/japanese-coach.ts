import { z } from 'zod'
import Dexie from 'dexie'
import type { JoveDatabase } from './db'
import { sessionSchema } from './schema'
import { evaluatedResultSchema } from '../ai/schemas'
import type { LearningProvider } from '../ai/cloud-provider'

const response = z.string().max(10000)
export const japaneseCoachDraft = z.strictObject({ revision: z.number().int().nonnegative(), text: response,
  confirmed: z.boolean(), transcript: response, audioId: z.string().default(''),
  feedback: z.array(z.strictObject({ id: z.string(), input: response, createdAt: z.number(), result: evaluatedResultSchema })).max(5),
  audioUnavailable: z.boolean().optional(), missingAudioIds: z.array(z.string()).optional(),
})

/** Coaching is retained assistance, not a source of FSRS/skill/mastery events. */
export function createJapaneseCoach(database: JoveDatabase, practiceId: string, checkOwner: () => Promise<void>, provider: LearningProvider) {
  if (database.language !== 'ja' || provider.learningLanguage !== 'ja') throw new Error('Wrong Japanese AI context')
  const id = `ja-coach:${practiceId}`
  const receivedTranscripts = new Map<string, string>()
  async function read() {
    await checkOwner()
    const session = await database.sessions.get(id)
    return session ? japaneseCoachDraft.parse(session.draft) : undefined
  }
  async function open() {
    await checkOwner()
    return database.transaction('rw', database.sessions, async () => {
      const practice = await database.sessions.get(practiceId)
      if (!practice || practice.kind !== 'japanese-practice') throw new Error('请先开始独立日语练习。')
      const existing = await database.sessions.get(id)
      if (existing) return japaneseCoachDraft.parse(existing.draft)
      const draft = { revision: 0, text: '', confirmed: false, transcript: '', audioId: '', feedback: [] }
      await database.sessions.add(sessionSchema.parse({ id, kind: 'japanese-coach', materialId: practice.materialId,
        startedAt: Date.now(), stage: 'draft', draft }))
      return japaneseCoachDraft.parse(draft)
    })
  }
  async function change(revision: number | undefined, update: (draft: z.infer<typeof japaneseCoachDraft>) => void) {
    await checkOwner()
    return database.transaction('rw', database.sessions, database.audio, database.syncMeta, async () => {
      await Dexie.waitFor(checkOwner())
      const session = await database.sessions.get(id)
      if (!session) throw new Error('请重新打开日语辅导。')
      const draft = japaneseCoachDraft.parse(session.draft)
      if (revision !== undefined && revision !== draft.revision) throw new Error('辅导记录已在其他页面更新；你的输入没有覆盖旧记录。')
      update(draft); draft.revision++
      const parsed = japaneseCoachDraft.parse(draft)
      await database.sessions.put(sessionSchema.parse({ ...session, draft: parsed }))
      return parsed
    })
  }
  const save = (revision: number, text: string, confirmed: boolean) => change(revision, draft => { draft.text = response.parse(text); draft.confirmed = confirmed })
  async function transcribe(revision: number, audioId: string, signal: AbortSignal) {
    await checkOwner()
    if ((await read())?.revision !== revision) throw new Error('回答已在其他页面更新，请先重新载入；没有再次调用转写。')
    const practice = await database.sessions.get(practiceId)
    if (!practice || ![practice.draft.audioId, practice.draft.retryAudioId].includes(audioId)) throw new Error('这段录音不属于当前练习，请重新打开草稿。')
    const original = await database.audio.get(audioId)
    if (original?.kind !== 'recording' || !original.blob.size) throw new Error('请先保存录音原件，再进行转写。')
    const receiptId = `ja-stt:${practiceId}:${audioId}`
    const receipt = await database.sessions.get(receiptId)
    let transcript = receipt?.kind === 'japanese-transcript' ? response.parse(receipt.draft.transcript) : receivedTranscripts.get(audioId)
    if (transcript === undefined) {
      transcript = response.parse(await provider.transcribe(original.blob, signal))
      receivedTranscripts.set(audioId, transcript)
    }
    const candidate = transcript
    // Persist the received candidate independently before trying to attach it to
    // a mutable answer. A conflict cannot discard a paid response or redispatch it.
    await checkOwner()
    await database.transaction('rw', database.sessions, database.syncMeta, async () => {
      await Dexie.waitFor(checkOwner())
      if (!await database.sessions.get(receiptId)) await database.sessions.add(sessionSchema.parse({ id: receiptId,
        kind: 'japanese-transcript', materialId: practice.materialId, startedAt: Date.now(), completedAt: Date.now(), stage: 'candidate',
        draft: { audioId, transcript: candidate } }))
    })
    receivedTranscripts.delete(audioId)
    signal.throwIfAborted()
    let conflict = false
    const saved = await change(undefined, current => {
      conflict = current.revision !== revision
      current.transcript = candidate; current.audioId = audioId
      if (!conflict) current.confirmed = false
    })
    if (conflict) throw new Error('转写候选已保存，但回答在其他页面变更。请重新载入；同一录音不会再次调用转写。')
    return saved
  }
  async function feedback(reference: string, target: string, signal: AbortSignal, expected: { revision: number; text: string; confirmed: boolean }) {
    const draft = await read()
    if (!draft || draft.revision !== expected.revision || draft.text !== expected.text || draft.confirmed !== expected.confirmed)
      throw new Error('回答已在其他页面变更，请先重新载入或保留本页输入；没有提交另一份回答。')
    if (!draft?.text.trim() || !draft.confirmed) throw new Error('请先保存并核对你的日语回答；转写可能有误。')
    const cached = draft.feedback.find(entry => entry.input === draft.text)
    if (cached) return draft
    if (draft.feedback.length >= 5) throw new Error('这次练习已有五条反馈，先选一处改进并完整重说，下一次再练。')
    const result = evaluatedResultSchema.parse(await provider.evaluate({ kind: 'japanese-contextual-response', text: draft.text,
      reference, targets: [target] }, signal))
    signal.throwIfAborted()
    return change(undefined, current => {
      if (current.feedback.some(entry => entry.input === draft.text)) return
      if (current.feedback.length >= 5) throw new Error('已有更新的反馈，原回答仍保留。')
      current.feedback.push({ id: crypto.randomUUID(), input: draft.text, createdAt: Date.now(), result })
    })
  }
  return { open, read, save, transcribe, feedback }
}
