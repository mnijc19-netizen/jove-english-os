import Dexie from 'dexie'
import type { JoveDatabase } from './db'
import type { PlanTask, StudySession } from '../domain/types'
import { extensiveDraftSchema, extensiveHistory, nextJapaneseBook, type ExtensiveDraft } from '../domain/japanese-extensive'
import { materialSchema, sessionSchema } from './schema'
import { createLearningRepository } from './repository'

/** Original-book reading log only: no extracted text, quizzes, translation or AI. */
export function createJapaneseExtensive(database: JoveDatabase, checkOwner: () => Promise<void>, fence: () => Promise<void>, sharedFence: () => Promise<void>) {
  if (database.language !== 'ja') throw new Error('Wrong extensive-reading workspace')
  const repository = createLearningRepository(database)
  async function transactionFence() { await Dexie.waitFor(Dexie.ignoreTransaction(sharedFence)); await fence() }
  async function book(id: string) {
    const material = materialSchema.parse(await database.materials.get(id))
    if (material.language !== 'ja' || material.externalReading?.publisher !== 'NPO 多言語多読') throw new Error('原版读物不存在，请返回今日安排。')
    return material
  }
  async function read(id: string) {
    await checkOwner()
    const session = await database.sessions.get(id)
    if (!session || session.kind !== 'japanese-extensive') throw new Error('请从今日安排进入原版多读。')
    const draft = extensiveDraftSchema.parse(session.draft), material = await book(draft.book.materialId)
    const conflicts = (await database.sessions.bulkGet(draft.syncReadingConflicts ?? [])).filter((s): s is StudySession => !!s && s.kind === 'japanese-extensive-conflict')
    const visits = extensiveHistory(await database.events.where('sessionId').equals(id).toArray(), Date.now())
    await checkOwner()
    return { session, draft, book: material, conflicts, visits }
  }
  async function change(id: string, expected: ExtensiveDraft, update: (draft: ExtensiveDraft, session: StudySession) => Promise<void>) {
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await transactionFence()
      const session = await database.sessions.get(id)
      if (!session || session.kind !== 'japanese-extensive' || session.completedAt) throw new Error('阅读已保存结束，未覆盖原记录。')
      const draft = extensiveDraftSchema.parse(session.draft)
      if (draft.revision !== expected.revision || draft.stamp !== expected.stamp || draft.book.materialId !== expected.book.materialId)
        throw new Error('其他页面更新了阅读，请保留本页文字后重新载入。')
      await update(draft, session); draft.revision++; draft.stamp = crypto.randomUUID()
      const saved = sessionSchema.parse({ ...session, draft: extensiveDraftSchema.parse(draft) })
      await database.sessions.put(saved)
      return saved
    })
  }
  async function start(task: PlanTask, now = Date.now()) {
    if (!task.materialId || task.kind !== 'learn' || task.done || task.optional || task.minutes < 1) throw new Error('原版多读安排已更新。')
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await transactionFence()
      const material = await book(task.materialId!), id = `ja-extensive:${task.id}`, previous = await database.sessions.get(id)
      if (previous) return previous
      const prior = extensiveHistory(await database.events.toArray(), now).findLast(h => h.data.materialId === material.id)
      const draft: ExtensiveDraft = { version: 1, revision: 0, stamp: crypto.randomUUID(), taskId: task.id, minutes: task.minutes, book: { materialId: material.id },
        bookmark: prior && prior.data.outcome !== 'finished' ? prior.data.bookmark : '', note: '', effort: 'okay', minutesRead: 0, spentMinutes: 0, outcome: 'continue', switched: [] }
      const session = sessionSchema.parse({ id, kind: 'japanese-extensive', materialId: material.id, startedAt: now, stage: 'read', draft })
      await database.sessions.add(session)
      await repository.recordEvent({ id: `${id}:started`, type: 'TASK_STARTED', source: 'objective', timestamp: now, sessionId: id,
        data: { taskId: task.id, minutes: task.minutes, materialId: material.id } })
      return session
    })
  }
  async function save(id: string, input: ExtensiveDraft) {
    const value = extensiveDraftSchema.parse(input)
    return change(id, value, async draft => {
      // Caller cannot rebind a book, clear spent time or forge completion.
      draft.bookmark = value.bookmark; draft.note = value.note; draft.effort = value.effort
      draft.minutesRead = value.minutesRead; draft.outcome = value.outcome
    })
  }
  async function observe(session: StudySession, draft: ExtensiveDraft, outcome: 'continue' | 'finished' | 'too-hard' | 'not-interesting' | 'unavailable', now: number) {
    if (!Number.isFinite(now) || now < session.startedAt) throw new Error('设备时间异常，请校正后保存。')
    const material = await book(draft.book.materialId)
    await repository.recordEvent({ id: `${session.id}:reading:${draft.revision}`, type: 'JAPANESE_EXTENSIVE_READING', source: 'self-report', timestamp: now, sessionId: session.id,
      data: { materialId: material.id, level: material.externalReading!.level, effort: outcome === 'too-hard' ? 'hard' : draft.effort,
        outcome, minutesRead: draft.minutesRead, bookmark: draft.bookmark, note: draft.note, playbackObserved: false, comprehensionVerified: false } })
  }
  async function switchBook(id: string, expected: ExtensiveDraft, reason: 'too-hard' | 'not-interesting' | 'unavailable', now = Date.now()) {
    if (!['too-hard', 'not-interesting', 'unavailable'].includes(reason)) throw new Error('换书原因无效')
    return change(id, extensiveDraftSchema.parse(expected), async (draft, session) => {
      if (draft.spentMinutes + draft.minutesRead >= draft.minutes) throw new Error('今天的阅读时间已用完，请先保存结束，下次自动换书。')
      await observe(session, draft, reason, now)
      const excluded = [...new Set([...draft.switched, draft.book.materialId])]
      const next = nextJapaneseBook(await database.materials.toArray(), await database.events.toArray(), now, excluded)
      if (!next) {
        // Keep the access/comfort report even when no replacement exists.
        // An optional assignment is not a completed reading or lost progress.
        const plan = await database.plans.get(new Date(now).toLocaleDateString('en-CA')), task = plan?.tasks.find(t => t.id === draft.taskId)
        if (plan && task) { task.optional = true; plan.minutes = plan.tasks.reduce((sum, t) => sum + (t.optional ? 0 : t.minutes), 0); await database.plans.put(plan) }
        // End this interrupted attempt, not the book. Preserve its self-reported
        // work once; a later attempt receives a new task/session identity.
        await repository.recordEvent({ id: `${id}:stopped`, type: 'TASK_STOPPED', source: 'objective', timestamp: now, sessionId: id,
          data: { taskId: draft.taskId, minutes: draft.spentMinutes + draft.minutesRead, materialId: session.materialId!,
            readingMaterialId: draft.book.materialId, readingSelfReport: true, timeSource: 'self-report', reason: 'no-suitable-original-book' } })
        session.stage = 'unavailable'; session.completedAt = now; draft.savedAt = now
        return
      }
      draft.switched = excluded; draft.spentMinutes += draft.minutesRead; draft.minutesRead = 0
      draft.book = { materialId: next.book.id }; draft.bookmark = next.bookmark; draft.note = ''; draft.effort = 'okay'; draft.outcome = 'continue'
      session.stage = 'read'
    })
  }
  async function finish(id: string, expected: ExtensiveDraft, now = Date.now()) {
    const prior = await read(id)
    if (prior.session.completedAt) return prior.session
    return change(id, extensiveDraftSchema.parse(expected), async (draft, session) => {
      if (draft.minutesRead < 1) throw new Error('请实际阅读后记录分钟数；只打开链接不算完成。')
      await observe(session, draft, draft.outcome, now)
      const plan = await database.plans.get(new Date(now).toLocaleDateString('en-CA')), task = plan?.tasks.find(t => t.id === draft.taskId)
      if (plan && task) { task.done = true; await database.plans.put(plan) }
      // Completion is an observed save action; its reading/time input remains
      // explicitly self-reported, never objective comprehension evidence.
      await repository.recordEvent({ id: `${id}:completed`, type: 'TASK_COMPLETED', source: 'objective', timestamp: now, sessionId: id,
        data: { taskId: draft.taskId, minutes: draft.spentMinutes + draft.minutesRead, materialId: session.materialId!, carriedOver: !task, readingSelfReport: true, timeSource: 'self-report' } })
      draft.savedAt = now; session.stage = 'completed'; session.completedAt = now
    })
  }
  return { start, read, save, switchBook, finish }
}
