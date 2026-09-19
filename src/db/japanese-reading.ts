import Dexie from 'dexie'
import type { JoveDatabase } from './db'
import type { PlanTask, StudySession } from '../domain/types'
import { japaneseReadings } from '../content/japanese-reading'
import { japaneseReadingDraft, japaneseReadingDelay, japaneseReadingResult, type JapaneseReadingDraft } from '../domain/japanese-reading'
import { sessionSchema } from './schema'
import { createLearningRepository } from './repository'

export function createJapaneseReading(database: JoveDatabase, checkOwner: () => Promise<void>, fence: () => Promise<void>, sharedFence: () => Promise<void>) {
  if (database.language !== 'ja') throw new Error('Wrong Japanese reading workspace')
  const repository = createLearningRepository(database)
  async function transactionFence() { await Dexie.waitFor(Dexie.ignoreTransaction(sharedFence)); await fence() }
  async function read(id: string) {
    await checkOwner()
    const session = await database.sessions.get(id), reading = japaneseReadings.find(r => r.id === session?.materialId)
    if (!session || session.kind !== 'japanese-reading' || !reading) throw new Error('日语阅读记录不存在，请从今日安排进入。')
    const draft = japaneseReadingDraft.parse(session.draft)
    const conflicts = (await database.sessions.bulkGet(draft.syncReadingConflicts ?? [])).filter((s): s is StudySession => !!s && s.kind === 'japanese-reading-conflict')
    await checkOwner()
    return { session, reading, draft, conflicts }
  }
  async function change(id: string, revision: number, update: (draft: JapaneseReadingDraft, session: StudySession) => Promise<void> | void) {
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await transactionFence()
      const session = await database.sessions.get(id)
      if (!session || session.kind !== 'japanese-reading' || session.completedAt) throw new Error('阅读已结束，未覆盖原回答。')
      const draft = japaneseReadingDraft.parse(session.draft)
      if (draft.revision !== revision) throw new Error('阅读在其他页面更新，请保留本页文字并重新载入。')
      await update(draft, session); draft.revision++
      const saved = sessionSchema.parse({ ...session, draft: japaneseReadingDraft.parse(draft) })
      await database.sessions.put(saved)
      return saved
    })
  }
  async function start(task: PlanTask, now = Date.now()) {
    const reading = japaneseReadings.find(r => r.id === task.materialId)
    if (!reading || task.kind !== 'learn' || task.done || task.optional || task.minutes < 1) throw new Error('阅读安排已更新。')
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await transactionFence()
      const id = `ja-reading:${task.id}`, previous = await database.sessions.get(id)
      if (previous) return previous
      const seen = (await database.sessions.toArray()).some(s => ['japanese-reading', 'japanese-reading-conflict'].includes(s.kind) && s.materialId === reading.id
        && (japaneseReadingDraft.safeParse(s.draft).data?.lockedAt !== undefined || japaneseReadingDraft.safeParse(s.draft).data?.helped === true))
      const draft: JapaneseReadingDraft = { version: 1, revision: 0, taskId: task.id, minutes: task.minutes, meaning: ['', ''], kana: ['', ''], helped: false, seen, note: '', effort: 'okay' }
      const session = sessionSchema.parse({ id, kind: 'japanese-reading', materialId: reading.id, startedAt: now, stage: 'read', draft })
      await database.sessions.add(session)
      await repository.recordEvent({ id: `${id}:started`, type: 'TASK_STARTED', source: 'objective', timestamp: now, sessionId: id,
        data: { taskId: task.id, minutes: task.minutes, materialId: reading.id } })
      return session
    })
  }
  async function save(id: string, input: JapaneseReadingDraft, action: 'save' | 'help' | 'lock' = 'save', now = Date.now()) {
    const value = japaneseReadingDraft.parse(input)
    return change(id, value.revision, async (draft, session) => {
      const reading = japaneseReadings.find(r => r.id === session.materialId)!
      if (value.meaning.some((a, i) => a && !reading.questions[i]!.choices.includes(a))) throw new Error('请选择当前阅读的选项。')
      if (draft.lockedAt !== undefined && (JSON.stringify(draft.meaning) !== JSON.stringify(value.meaning) || JSON.stringify(draft.kana) !== JSON.stringify(value.kana))) throw new Error('首答已锁定，对照后的笔记单独保存。')
      draft.note = value.note; draft.effort = value.effort
      if (draft.lockedAt === undefined) {
        draft.meaning = value.meaning; draft.kana = value.kana
        if (action === 'help') draft.helped = true
        if (action === 'lock') {
          if (!Number.isFinite(now) || now < session.startedAt) throw new Error('设备时间异常，请校正后保存。')
          draft.seen ||= (await database.sessions.toArray()).some(s => s.id !== id && s.materialId === reading.id
            && ['japanese-reading', 'japanese-reading-conflict'].includes(s.kind)
            && (japaneseReadingDraft.safeParse(s.draft).data?.helped === true || japaneseReadingDraft.safeParse(s.draft).data?.lockedAt !== undefined))
          draft.lockedAt = now; session.stage = 'compare'
          await repository.recordEvent({ id: `${id}:locked`, type: 'JAPANESE_READING_LOCK', source: 'objective', timestamp: now, sessionId: id,
            prompted: draft.helped || draft.seen, data: { materialId: reading.id, meaning: draft.meaning, kana: draft.kana, helped: draft.helped, seen: draft.seen } })
        }
      }
    })
  }
  async function finish(id: string, revision: number, now = Date.now()) {
    const prior = await read(id)
    if (prior.session.completedAt) return prior.session
    return change(id, revision, async (draft, session) => {
      if (draft.lockedAt === undefined || now < draft.lockedAt || !Number.isFinite(now) || !draft.note.trim()) throw new Error('请先保存首答，对照后写一句自己的调整或应用。')
      const reading = japaneseReadings.find(r => r.id === session.materialId)!, results = japaneseReadingResult(reading, draft)
      draft.dueAt = now + japaneseReadingDelay(reading, draft, await database.sessions.toArray(), now)
      const plan = await database.plans.get(new Date(now).toLocaleDateString('en-CA')), task = plan?.tasks.find(t => t.id === draft.taskId)
      if (plan && task) { task.done = true; await database.plans.put(plan) }
      await repository.recordEvent({ id: `${id}:result`, type: 'JAPANESE_READING_CHECK', source: 'objective', timestamp: draft.lockedAt, sessionId: id,
        prompted: draft.helped || draft.seen, data: { materialId: reading.id, meaningMatches: results.meaning.filter(Boolean).length,
          kanaMatches: results.kana.filter(Boolean).length, listeningAssessed: false, acousticAssessed: false, dueAt: draft.dueAt } })
      await repository.recordEvent({ id: `${id}:completed`, type: 'TASK_COMPLETED', source: 'objective', timestamp: now, sessionId: id,
        data: { taskId: draft.taskId, minutes: task?.minutes ?? draft.minutes, materialId: reading.id, carriedOver: !task } })
      session.stage = 'completed'; session.completedAt = now
    })
  }
  return { start, read, save, finish }
}
