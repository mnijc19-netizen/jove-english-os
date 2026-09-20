import Dexie from 'dexie'
import type { JoveDatabase } from './db'
import type { PlanTask, StudySession } from '../domain/types'
import { dueEnglishReading, englishReadingDraftSchema, englishReadingReportSchema, isEnglishReader, type EnglishReadingDraft } from '../domain/english-reading'
import { materialSchema, sessionSchema } from './schema'
import { createLearningRepository } from './repository'
import { eventOccurrenceKey, type RecordValue } from '../sync/protocol'

export function createEnglishReading(database: JoveDatabase, checkOwner: () => Promise<void>) {
  if (database.language !== 'en') throw new Error('Wrong reading workspace')
  const repository = createLearningRepository(database)
  async function occurrence(event: RecordValue) {
    return Dexie.waitFor(eventOccurrenceKey(event))
  }
  async function material(id: string) {
    const value = materialSchema.parse(await database.materials.get(id))
    if (!isEnglishReader(value)) throw new Error('原版阅读材料暂不可用，请返回今日安排。')
    return value
  }
  async function validateSource(draft: EnglishReadingDraft, materialId: string) {
    if (!draft.source) return
    const event = await database.events.get(draft.source.readingEventId), report = englishReadingReportSchema.safeParse(event?.data)
    if (event?.type !== 'ENGLISH_READING_REPORT' || event.source !== 'self-report' || !event.sessionId || !report.success
      || report.data.outcome !== 'finished' || report.data.materialId !== materialId || await occurrence(event as unknown as RecordValue) !== draft.source.readingEventKey
      || report.data.response !== draft.source.response || report.data.application !== draft.source.application) throw new Error('回忆来源尚未完整同步，请稍后重试；没有覆盖笔记。')
  }
  async function read(id: string) {
    await checkOwner()
    const session = await database.sessions.get(id)
    if (!session || session.kind !== 'english-reading' || !session.materialId) throw new Error('阅读记录不存在，请返回今日安排。')
    const draft = englishReadingDraftSchema.parse(session.draft), reader = await material(session.materialId)
    await validateSource(draft, reader.id)
    const conflicts = (await database.sessions.bulkGet(draft.syncReadingConflicts ?? [])).filter((s): s is StudySession => !!s && s.kind === 'english-reading-conflict')
    await checkOwner()
    return { session, draft, material: reader, conflicts }
  }
  async function start(task: PlanTask, now = Date.now(), free = false) {
    if (task.kind !== 'learn' || !task.id.endsWith(':reading') || !task.materialId || task.done || task.optional || task.minutes < 1 || task.minutes > 150) throw new Error('阅读安排已更新。')
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await checkOwner()
      const reader = await material(task.materialId!), id = `en-reader:${task.id}`, previous = await database.sessions.get(id)
      if (previous) return previous
      if (!reader.approved) throw new Error('这篇材料已退出新安排；旧的阅读记录仍然保留。')
      const plan = await database.plans.get(new Date(now).toLocaleDateString('en-CA')), assigned = plan?.tasks.find(t => t.id === task.id)
      if (free ? !task.id.endsWith(':free:reading') || task.minutes !== 5
        : !assigned || assigned.done || assigned.optional || assigned.materialId !== task.materialId || assigned.minutes !== task.minutes) throw new Error('今日安排已更新，请重新进入。')
      const review = task.id.endsWith(':recall:reading') ? dueEnglishReading(await database.events.toArray(), now, reader.id) : undefined
      if (task.id.endsWith(':recall:reading') && !review) throw new Error('这次回忆已经完成，请返回今日安排。')
      const draft: EnglishReadingDraft = { version: 1, revision: 0, stamp: crypto.randomUUID(), taskId: task.id, minutes: task.minutes,
        minutesRead: 0, mode: review ? 'recall' : 'read', response: '', application: '', effort: 'okay',
        ...(review ? { source: { readingEventId: review.event.id, readingEventKey: await occurrence(review.event as unknown as RecordValue), response: review.data.response, application: review.data.application, timestamp: review.event.timestamp } } : {}) }
      const session = sessionSchema.parse({ id, kind: 'english-reading', materialId: reader.id, startedAt: now, stage: 'draft', draft })
      await database.sessions.add(session)
      await repository.recordEvent({ id: `${id}:started`, type: 'TASK_STARTED', source: 'objective', timestamp: now, sessionId: id,
        data: { taskId: task.id, kind: 'reading', materialId: reader.id } })
      return session
    })
  }
  async function change(id: string, expected: EnglishReadingDraft, action: (draft: EnglishReadingDraft, session: StudySession) => Promise<void>) {
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await checkOwner()
      const session = await database.sessions.get(id)
      if (!session || session.kind !== 'english-reading' || !session.materialId || session.completedAt) throw new Error('这次阅读已结束，没有覆盖记录。')
      const draft = englishReadingDraftSchema.parse(session.draft)
      if (draft.revision !== expected.revision || draft.stamp !== expected.stamp) throw new Error('另一页面更新了阅读。请复制保留本页文字后重新进入，避免覆盖。')
      await validateSource(draft, session.materialId)
      await action(draft, session); draft.revision++; draft.stamp = crypto.randomUUID()
      const saved = sessionSchema.parse({ ...session, draft: englishReadingDraftSchema.parse(draft) })
      await database.sessions.put(saved); return saved
    })
  }
  async function save(id: string, input: EnglishReadingDraft) {
    const value = englishReadingDraftSchema.parse(input)
    return change(id, value, async draft => {
      // Frozen recall source, task, elapsed budget and reveal state cannot be supplied by the form.
      if (!draft.revealedAt) draft.response = value.response
      draft.application = value.application; draft.minutesRead = value.minutesRead; draft.effort = value.effort
      if (draft.revealedAt && value.rating) draft.rating = value.rating
    })
  }
  async function reveal(id: string, expected: EnglishReadingDraft, now = Date.now()) {
    return change(id, expected, async (draft, session) => {
      if (draft.mode !== 'recall' || draft.response.trim().length < 2 || now < session.startedAt) throw new Error('先写下现在记得的内容；想不起来可以如实写“不记得”。')
      if (!draft.revealedAt) draft.revealedAt = now
    })
  }
  async function finish(id: string, expected: EnglishReadingDraft, outcome: NonNullable<EnglishReadingDraft['outcome']> = 'finished', now = Date.now()) {
    const prior = await read(id)
    if (prior.session.completedAt) return prior.session
    return change(id, expected, async (draft, session) => {
      if (!['finished', 'too-hard', 'not-interesting', 'unavailable', 'later'].includes(outcome) || now < session.startedAt) throw new Error('阅读保存信息无效。')
      const done = outcome === 'finished', reader = await material(session.materialId!)
      if (done && (draft.minutesRead < 1 || draft.response.trim().length < 2 || draft.mode === 'recall' && (!draft.revealedAt || !draft.rating))) throw new Error('请先完成页面上的阅读或回忆步骤；仅打开链接不算完成。')
      if (draft.mode === 'read') await repository.recordEvent({ id: `${id}:report`, type: 'ENGLISH_READING_REPORT', source: 'self-report', timestamp: now, sessionId: id,
        data: { materialId: reader.id, level: reader.externalReading.level, minutesRead: draft.minutesRead, effort: outcome === 'too-hard' ? 'hard' : draft.effort,
          outcome, response: draft.response, application: draft.application, readingObserved: false, comprehensionVerified: false } })
      else if (done) await repository.recordEvent({ id: `${id}:recall`, type: 'ENGLISH_READING_RECALL', source: 'self-report', timestamp: now, sessionId: id,
        data: { materialId: reader.id, readingEventId: draft.source!.readingEventId, readingEventKey: draft.source!.readingEventKey, response: draft.response, rating: draft.rating!, readingObserved: false, comprehensionVerified: false } })
      await repository.recordEvent({ id: `${id}:terminal`, type: done ? 'TASK_COMPLETED' : 'TASK_STOPPED', source: 'objective', timestamp: now, sessionId: id,
        data: { taskId: draft.taskId, kind: 'reading', minutes: draft.minutesRead, materialId: reader.id, outcome,
          readingSelfReport: true, timeSource: 'self-report' } })
      const plan = await database.plans.get(new Date(now).toLocaleDateString('en-CA')), task = plan?.tasks.find(t => t.id === draft.taskId)
      if (plan && task) {
        if (done) { task.done = true; task.minutes = draft.minutesRead } else task.optional = true
        plan.minutes = plan.tasks.reduce((sum, t) => sum + (t.optional ? 0 : t.minutes), 0); await database.plans.put(plan)
      }
      draft.outcome = outcome; draft.savedAt = now; session.completedAt = now; session.stage = done ? 'saved' : 'stopped'
    })
  }
  return { start, read, save, reveal, finish }
}
