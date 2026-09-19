import type { JoveDatabase } from './db'
import { createLearningRepository } from './repository'
import { japaneseStarterMaterials } from '../content/japanese'
import { japanesePlacement, japanesePlacementItems, nextJapaneseLesson } from '../domain/japanese'
import { readLanguageDay } from './language-day'
import { assessmentSchema, planSchema, sessionSchema } from './schema'
import type { DailyPlan, StudySession } from '../domain/types'
import { z } from 'zod'

/** Called only by an explicitly enabled Japanese workspace, never by English
 * bootstrap. Does not overwrite setup, learned content, cards or saved work. */
export async function initializeJapanese(database: JoveDatabase): Promise<void> {
  if (database.language !== 'ja') throw new Error('Japanese setup requires its own workspace')
  await createLearningRepository(database).initialize(japaneseStarterMaterials())
}

const text = z.string().max(10_000)
export const japanesePracticeDraft = z.strictObject({
  taskId: text, revision: z.number().int().nonnegative(), listened: z.boolean(), response: text,
  expression: text, example: text, audioId: text, retryAudioId: text, comparison: text,
})
export type JapanesePracticeDraft = z.infer<typeof japanesePracticeDraft>
const diagnosticId = 'ja-initial-diagnostic'
const steps = ['listen', 'notice', 'speak', 'compare'] as const
export type JapanesePracticeStep = typeof steps[number]

/** One immutable language/owner context; no write follows the current route. */
export function createJapaneseWorkspace(database: JoveDatabase, english: JoveDatabase) {
  if (database.language !== 'ja' || english.language !== 'en') throw new Error('Wrong learning workspace')
  const repository = createLearningRepository(database)
  let owner: unknown, opened = false
  async function checkOwner() {
    if (!opened || (await database.syncMeta.get('owner'))?.value !== owner
      || (await english.syncMeta.get('owner'))?.value !== owner) throw new Error('学习账号已改变，请保存后重新打开日语区。')
  }
  // Called inside every Japanese write transaction, after the cross-DB check.
  async function fence() {
    if ((await database.syncMeta.get('owner'))?.value !== owner) throw new Error('学习账号已改变，未覆盖原来的练习。')
  }
  async function open() {
    const enOwner = (await english.syncMeta.get('owner'))?.value
    if ((await database.syncMeta.get('owner'))?.value !== enOwner) throw new Error('请先完成同一账号的日语同步连接。')
    owner = enOwner; opened = true
    await initializeJapanese(database)
    await checkOwner()
  }
  async function saveDiagnostic(responses: Record<string, string>, finish = false, now = Date.now()) {
    const frozen = { ...responses }
    for (const [id, answer] of Object.entries(frozen)) {
      const item = japanesePlacementItems.find(item => item.id === id)
      if (!item || ![...item.choices, '跳过'].includes(answer)) throw new Error('诊断选项无效')
    }
    const result = finish ? japanesePlacement(frozen) : undefined
    await checkOwner()
    return database.transaction('rw', database.assessments, database.profiles, database.syncMeta, async () => {
      await fence()
      const current = await database.assessments.get(diagnosticId)
      if (current?.completedAt) return current
      const assessment = assessmentSchema.parse({ id: diagnosticId, timestamp: current?.timestamp ?? now, variant: 1,
        stage: finish ? 'completed' : 'script-and-meaning', responses: frozen,
        scores: result ? { scriptRecognition: result.scriptCorrect / 3, sentenceMeaning: result.meaningCorrect / 3,
          listening: null, speaking: null } : {}, ...(finish ? { completedAt: now } : {}) })
      await database.assessments.put(assessment)
      if (finish) await database.profiles.update('main', { onboarded: true })
      return assessment
    })
  }
  async function today(now = Date.now()): Promise<DailyPlan | null> {
    await checkOwner()
    const allowance = await readLanguageDay(english, now, database)
    if (!allowance) return null
    return database.transaction('rw', database.plans, database.events, database.materials, database.assessments, database.syncMeta, async () => {
      await fence()
      const diagnostic = await database.assessments.get(diagnosticId)
      if (!diagnostic?.completedAt) return null
      const date = new Date(now).toLocaleDateString('en-CA'), current = await database.plans.get(date)
      const events = await database.events.toArray(), materials = await database.materials.toArray()
      const placement = japanesePlacement(diagnostic.responses)
      // Curriculum exposure chooses a next task, not a higher proficiency score.
      const completedIds = new Set(events.filter(event => event.type === 'EXTERNAL_LISTEN_REFLECTION').map(event => event.data?.materialId))
      const practiced = materials.filter(material => completedIds.has(material.id))
      const target = Math.max(0.1 + (placement.conversationProbe - 1) * 0.025, ...practiced.map(material => material.difficulty))
      const probe = materials.find(material => material.id === `ja-irodori-starter-${placement.conversationProbe}`)
      const next = nextJapaneseLesson(materials, events, target, now)
      const material = !completedIds.size && probe && nextJapaneseLesson([probe], events, target, now) ? probe : next
      const completed = current?.tasks.filter(task => task.done) ?? []
      const previous = current?.tasks.find(task => !task.done && !task.optional)
      const minutes = allowance.allowances.ja.remaining
      // Preserve task identity after starting; do not fill a finished day again.
      const task = previous ?? (!completed.length && material ? { id: `${date}:ja:listen:${material.id}`, kind: 'listen' as const,
        title: material.title, minutes, reason: '真人输入 → 回忆意思 → 自己表达 → 对照重说', materialId: material.id, done: false } : undefined)
      if (!completed.length && (!task || minutes <= 0)) return null
      const plan = planSchema.parse({ id: date, date, minutes: completed.reduce((sum, task) => sum + (task.optional ? 0 : task.minutes), 0) + (task && minutes > 0 ? minutes : 0),
        focus: 'realWorld', tasks: [...completed, ...(task && minutes > 0 ? [{ ...task, minutes }] : [])],
        evidenceFingerprint: `ja:${diagnostic.completedAt}:${events.length}:${minutes}`, createdAt: current?.createdAt ?? now })
      await database.plans.put(plan)
      return plan
    })
  }
  async function start(taskId: string, now = Date.now()): Promise<StudySession> {
    const plan = await today(now)
    const task = plan?.tasks.find(task => task.id === taskId && !task.done && !task.optional)
    if (!task?.materialId || task.minutes <= 0) throw new Error('今天的安排已更新，请返回今日任务。')
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await fence()
      const id = `ja-practice:${task.id}`, previous = await database.sessions.get(id)
      if (previous) return previous
      const draft: JapanesePracticeDraft = { taskId, revision: 0, listened: false, response: '', expression: '', example: '', audioId: '', retryAudioId: '', comparison: '' }
      const session = sessionSchema.parse({ id, kind: 'japanese-practice', materialId: task.materialId, startedAt: now, stage: 'listen', draft })
      await database.sessions.add(session)
      await repository.recordEvent({ id: `${id}:started`, type: 'TASK_STARTED', timestamp: now, source: 'objective', sessionId: id,
        data: { taskId, materialId: task.materialId!, minutes: task.minutes } })
      return session
    })
  }
  async function save(sessionId: string, input: JapanesePracticeDraft, step: JapanesePracticeStep): Promise<StudySession> {
    const draft = japanesePracticeDraft.parse(input)
    if (!steps.includes(step)) throw new Error('无效的练习步骤')
    if (step !== 'listen' && (!draft.listened || !draft.response.trim())) throw new Error('先听一段原声，再写下听懂的意思；没听懂也可以如实写下。')
    if (['speak', 'compare'].includes(step) && (!draft.expression.trim() || !draft.example.trim())) throw new Error('先选一个表达，再写一句自己的话。')
    if (step === 'compare' && !draft.audioId) throw new Error('请先录下自己的回答。')
    await checkOwner()
    return database.transaction('rw', database.sessions, database.audio, database.syncMeta, async () => {
      await fence()
      const session = await database.sessions.get(sessionId)
      if (!session || session.kind !== 'japanese-practice') throw new Error('练习记录不存在')
      if (session.completedAt) throw new Error('这次练习已经保存完成，请返回今日任务。')
      const stored = japanesePracticeDraft.parse(session.draft)
      if (stored.taskId !== draft.taskId || stored.revision !== draft.revision) throw new Error('这份练习已在其他页面更新，请重新打开；当前输入未覆盖已保存内容。')
      for (const id of [draft.audioId, draft.retryAudioId].filter(Boolean)) {
        const audio = await database.audio.get(id)
        if (!audio?.blob.size || audio.kind !== 'recording') throw new Error('请先将录音成功保存在日语区。')
      }
      const next = sessionSchema.parse({ ...session, stage: step, draft: { ...draft, revision: draft.revision + 1 } })
      await database.sessions.put(next)
      return next
    })
  }
  async function finish(sessionId: string, now = Date.now()) {
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await fence()
      const session = await database.sessions.get(sessionId)
      if (!session || session.kind !== 'japanese-practice' || !session.materialId) throw new Error('练习记录不存在')
      if (session.completedAt) return session
      const draft = japanesePracticeDraft.parse(session.draft)
      if (session.stage !== 'compare' || !draft.listened || !draft.response.trim() || !draft.expression.trim() || !draft.example.trim()
        || !draft.comparison.trim() || !draft.audioId || !draft.retryAudioId || draft.audioId === draft.retryAudioId) throw new Error('请完成回答、两次录音和对照笔记后保存。')
      for (const id of [draft.audioId, draft.retryAudioId]) {
        const audio = await database.audio.get(id)
        if (!audio?.blob.size || audio.kind !== 'recording') throw new Error('录音原件尚未保存，练习仍保留为草稿。')
      }
      const date = new Date(now).toLocaleDateString('en-CA'), plan = await database.plans.get(date)
      const task = plan?.tasks.find(task => task.id === draft.taskId)
      // Overnight drafts remain finishable. Charge their original assignment
      // on the actual completion day, without moving it into today's plan.
      await repository.recordEvent({ id: `${sessionId}:reflection`, type: 'EXTERNAL_LISTEN_REFLECTION', timestamp: now, source: 'self-report', sessionId,
        data: { materialId: session.materialId, response: draft.response, expression: draft.expression, example: draft.example,
          audioId: draft.retryAudioId, listened: true, playbackObserved: false, comprehensionVerified: false } })
      await repository.recordEvent({ id: `${sessionId}:retry`, type: 'JAPANESE_COMPARE_RETRY', timestamp: now, source: 'self-report', sessionId,
        data: { materialId: session.materialId, audioId: draft.audioId, retryAudioId: draft.retryAudioId, comparison: draft.comparison, acousticAssessed: false } })
      const material = await database.materials.get(session.materialId)
      // Only the authored reference enters cards automatically. A learner's
      // unverified sentence is preserved as a response, not taught as correct.
      if (material?.chunks[0]) await repository.addChunk(material.chunks[0], material.id)
      if (task && plan) {
        task.done = true
        await database.plans.put(plan)
      }
      const started = await database.events.get(`${sessionId}:started`)
      const minutes = task?.minutes ?? started?.data?.minutes
      if (typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0) {
        await repository.recordEvent({ id: `${sessionId}:completed`, type: 'TASK_COMPLETED', timestamp: now, source: 'objective', sessionId,
          data: { taskId: draft.taskId, minutes, materialId: session.materialId, carriedOver: !task } })
      }
      const complete = { ...session, completedAt: now, stage: 'completed' }
      await database.sessions.put(complete)
      return complete
    })
  }
  return { database, repository, open, checkOwner, saveDiagnostic, today, start, save, finish, diagnosticId }
}
