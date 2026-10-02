import type { JoveDatabase } from './db'
import Dexie from 'dexie'
import { createLearningRepository } from './repository'
import { japaneseMaterials } from '../content/japanese'
import { japanesePlacement, japanesePlacementItems, japanesePracticeHistory, nextJapaneseLesson, japaneseStartingPoint, japaneseBeginnerStartId, japaneseCoursePractice, japaneseCorrectionsDue, japanesePracticePhaseGoal } from '../domain/japanese'
import { readLanguageDay } from './language-day'
import { assessmentSchema, eventSchema, planSchema, sessionSchema } from './schema'
import type { DailyPlan, StudySession } from '../domain/types'
import { z } from 'zod'
import { createJapaneseReview } from './japanese-review'
import { createJapaneseDialogue } from './japanese-dialogue'
import { createJapaneseReading } from './japanese-reading'
import { japaneseReadingMaterials, japaneseWrittenExercises } from '../content/japanese-reading'
import { nextJapaneseReading, nextJapaneseKana } from '../domain/japanese-reading'
import { unavailableExternalIds } from '../content/external'
import { tadokuStarterMaterials } from '../content/tadoku-catalog'
import { nextJapaneseBook } from '../domain/japanese-extensive'
import { createJapaneseExtensive } from './japanese-extensive'

/** Called only by an explicitly enabled Japanese workspace, never by English
 * bootstrap. Does not overwrite setup, learned content, cards or saved work. */
export async function initializeJapanese(database: JoveDatabase): Promise<void> {
  if (database.language !== 'ja') throw new Error('Japanese setup requires its own workspace')
  await createLearningRepository(database).initialize([...japaneseMaterials(), ...japaneseReadingMaterials(japaneseWrittenExercises), ...tadokuStarterMaterials()])
}

const text = z.string().max(10_000)
export const japanesePracticeDraft = z.strictObject({
  taskId: text, revision: z.number().int().nonnegative(), listened: z.boolean(), response: text,
  expression: text, example: text, audioId: text, retryAudioId: text, comparison: text,
  effort: z.enum(['hard', 'okay', 'easy']).optional(),
  audioUnavailable: z.boolean().optional(), missingAudioIds: z.array(text).optional(),
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
  const review = createJapaneseReview(database, checkOwner, fence)
  const sharedFence = async () => {
    if (!opened || (await english.syncMeta.get('owner'))?.value !== owner) throw new Error('学习账号已改变，请重新打开日语区。')
  }
  const dialogue = createJapaneseDialogue(database, checkOwner, fence, sharedFence)
  const reading = createJapaneseReading(database, checkOwner, fence, sharedFence)
  const books = createJapaneseExtensive(database, checkOwner, fence, sharedFence)
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
  async function startingPoint(now = Date.now()) {
    await checkOwner()
    const [diagnostic, beginner] = await Promise.all([database.assessments.get(diagnosticId), database.assessments.get(japaneseBeginnerStartId)])
    await checkOwner()
    return japaneseStartingPoint(diagnostic, beginner, now)
  }
  async function practiceGuide(sessionId: string) {
    await checkOwner()
    const session = await database.sessions.get(sessionId)
    if (!session?.materialId || session.kind !== 'japanese-practice') throw new Error('练习记录不存在')
    const assignment = await database.events.get(`${sessionId}:course-assignment`)
    const phase = assignment?.data?.coursePhase
    if (phase !== 'input' && phase !== 'application' && phase !== 'delayed-transfer') return null
    const firstAttempt = await database.events.get(`${sessionId}:independent-attempt`)
    return { phase, contextId: String(assignment!.data!.contextId), contextPrompt: String(assignment!.data!.contextPrompt),
      independentFirst: phase !== 'input', firstAttemptSaved: !!firstAttempt,
      goal: japanesePracticePhaseGoal(phase),
      coverage: '本站 Can-do 多次练习，不代表已学完整课原站内容或已经掌握。' }
  }
  async function freezeFirstAttempt(session: StudySession, draft: JapanesePracticeDraft, now: number) {
    const assignment = await database.events.get(`${session.id}:course-assignment`)
    if (!assignment) return null
    const id = `${session.id}:independent-attempt`, existing = await database.events.get(id)
    if (existing) {
      if (existing.data?.response !== draft.response) throw new Error('首答已锁定；请把对照后的修改保存在自己的例句中。')
      return existing
    }
    if (session.stage !== 'listen' || !draft.response.trim()) throw new Error('先在查看参考前保存自己的书面首答。')
    const audio = draft.audioId ? await database.audio.get(draft.audioId) : undefined
    const earlyRecording = audio?.kind === 'recording' && audio.blob.size > 0 && audio.createdAt >= session.startedAt
    if (assignment.data?.coursePhase === 'delayed-transfer' && !earlyRecording)
      throw new Error('先保存这次独立书写与新的首答录音，再看参考。')
    const event = eventSchema.parse({ id, type: 'JAPANESE_COURSE_FIRST_ATTEMPT', source: 'self-report', timestamp: now,
      sessionId: session.id, contextId: String(assignment.data!.contextId),
      data: { materialId: session.materialId!, response: draft.response, coursePhase: String(assignment.data!.coursePhase),
        ...(earlyRecording ? { audioId: draft.audioId } : {}), recordingBeforeHelp: !!earlyRecording,
        contextId: String(assignment.data!.contextId), acousticAssessed: false, masteryAssessed: false } })
    await database.events.add(event)
    return event
  }
  async function lockIndependentAttempt(sessionId: string, now = Date.now()) {
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await Dexie.waitFor(Dexie.ignoreTransaction(sharedFence)); await fence()
      const id = `${sessionId}:independent-attempt`, existing = await database.events.get(id)
      if (existing) return existing
      const session = await database.sessions.get(sessionId), assignment = await database.events.get(`${sessionId}:course-assignment`)
      if (!session || session.completedAt || session.kind !== 'japanese-practice'
        || !['application', 'delayed-transfer'].includes(String(assignment?.data?.coursePhase))) throw new Error('请从本次应用或延迟任务保存首答。')
      if (session.stage !== 'listen') throw new Error('请在查看参考前锁定独立首答；不能把对照后的回答当作首答。')
      return freezeFirstAttempt(session, japanesePracticeDraft.parse(session.draft), now)
    })
  }
  async function assignCourse(session: StudySession, now: number) {
    const assignment = japaneseCoursePractice(session.materialId!, await database.events.toArray(), now)
    await repository.recordEvent({ id: `${session.id}:course-assignment`, type: 'JAPANESE_COURSE_ASSIGNED', source: 'objective',
      timestamp: now, sessionId: session.id, contextId: assignment.contextId,
      data: { materialId: session.materialId!, coursePhase: assignment.phase, contextId: assignment.contextId, contextPrompt: assignment.contextPrompt } })
  }
  async function confirmBeginnerStart(now = Date.now()) {
    await checkOwner()
    return database.transaction('rw', database.assessments, database.profiles, database.syncMeta, async () => {
      await Dexie.waitFor(Dexie.ignoreTransaction(sharedFence))
      await fence()
      const existing = await database.assessments.get(japaneseBeginnerStartId)
      if (japaneseStartingPoint(undefined, existing, now)) return existing!
      const confirmation = assessmentSchema.parse({ id: japaneseBeginnerStartId, timestamp: now, variant: 1,
        stage: 'self-reported-beginner', responses: { startingPoint: 'beginner' },
        scores: { scriptRecognition: null, sentenceMeaning: null, listening: null, speaking: null }, completedAt: now })
      await database.assessments.put(confirmation)
      await database.profiles.update('main', { onboarded: true })
      return confirmation
    })
  }
  async function today(now = Date.now()): Promise<DailyPlan | null> {
    await checkOwner()
    const allowance = await readLanguageDay(english, now, database)
    if (!allowance) return null
    return database.transaction('rw', [database.plans, database.events, database.materials, database.assessments, database.cards, database.chunks, database.sessions, database.syncMeta], async () => {
      await fence()
      const diagnostic = await database.assessments.get(diagnosticId)
      const placement = japaneseStartingPoint(diagnostic, await database.assessments.get(japaneseBeginnerStartId), now)
      if (!placement) return null
      const date = new Date(now).toLocaleDateString('en-CA'), savedPlan = await database.plans.get(date)
      const events = await database.events.toArray(), materials = await database.materials.toArray()
      const sessions = await database.sessions.toArray()
      // Only replace an untouched initial plan. Started/completed/optional work,
      // drafts and recordings remain bound to their original tasks.
      const replaceInitialPlan = placement.basis === 'self-report' && savedPlan && savedPlan.createdAt < placement.confirmedAt
        && savedPlan.tasks.every(task => !task.done && !task.optional
          && !events.some(event => event.type === 'TASK_STARTED' && event.data?.taskId === task.id)
          && !sessions.some(session => session.draft.taskId === task.id))
      const current = replaceInitialPlan ? undefined : savedPlan
      // Curriculum exposure chooses a next task, not a higher proficiency score.
      const history = japanesePracticeHistory(events, now)
      const completedIds = new Set(history.map(event => event.data?.materialId))
      const practiced = materials.filter(material => completedIds.has(material.id))
      const target = Math.max(0.1 + (placement.conversationProbe - 1) * 0.025, ...practiced.map(material => material.difficulty))
      const probe = materials.find(material => material.id === `ja-irodori-starter-${placement.conversationProbe}`)
      const next = nextJapaneseLesson(materials, events, target, now)
      const material = !completedIds.size && probe && nextJapaneseLesson([probe], events, target, now) ? probe : next
      // Keep explicitly resolved/skipped optional rows as history, but never
      // mark them done: completed optional work legitimately consumes time.
      const completed = current?.tasks.filter(task => task.done || task.optional) ?? []
      const previous = current?.tasks.find(task => task.kind === 'listen' && !task.done && !task.optional)
      const previousReview = current?.tasks.find(task => task.kind === 'review' && !task.done && !task.optional)
      const previousDialogue = current?.tasks.find(task => task.kind === 'speak' && !task.done && !task.optional)
      const previousReading = current?.tasks.find(task => task.kind === 'learn' && !task.materialId?.startsWith('ja-kana-') && !task.done && !task.optional)
      const previousKana = current?.tasks.find(task => task.kind === 'learn' && task.materialId?.startsWith('ja-kana-') && !task.done && !task.optional)
      const minutes = allowance.allowances.ja.remaining
      const olderChunks = new Set((await database.chunks.toArray()).filter(chunk => chunk.createdAt <= now && new Date(chunk.createdAt).toLocaleDateString('en-CA') !== date).map(chunk => chunk.id))
      // No authored expression currently has a verified matching listening clip.
      // Keep its card/history, but do not schedule unrelated publisher playback.
      const due = (await database.cards.toArray()).filter(card => card.modality !== 'listening' && olderChunks.has(card.chunkId) && card.card.due.getTime() <= now)
      const corrections = japaneseCorrectionsDue(events, now)
      const lessonStarted = previous && events.some(event => event.type === 'TASK_STARTED' && event.data?.taskId === previous.id)
      // The shared 15-minute preference leaves only 7–8 minutes here. Keep one
      // useful five-minute activity instead of letting due cards consume it.
      const reviewLimit = !current && minutes >= 6 && minutes < 15 ? minutes - 5 : 5
      const reviewTask = previousReview ?? (!lessonStarted && !completed.some(task => task.kind === 'review') && (due.length || corrections.length) ? {
        id: `${date}:ja:review`, kind: 'review' as const, title: '把学过的日语真正想起来', minutes: Math.min(5, reviewLimit, new Set(due.map(card => card.chunkId)).size + Math.min(1, corrections.length)),
        reason: '先独立回答，再对照；汉字识别、听辨和表达分开复习。', done: false,
      } : undefined)
      // Never insert new reviews after completing today's planned lesson.
      const reviewMinutes = reviewTask && !completed.some(task => task.kind === 'listen') ? Math.min(reviewTask.minutes, minutes) : 0
      // After two complete introductory practices, reserve a brief real-life
      // exchange in the SAME daily allowance. Never add it to an already
      // started/finished day's older plan or double the English/Japanese budget.
      const selectedReading = nextJapaneseReading(sessions, now)
      const selectedKana = nextJapaneseKana(sessions, now, placement.kanaSupport)
      // On very short days rotate foundation with integrated work instead of
      // letting a permanent kana backlog crowd out reading/conversation.
      const foundationDay = history.length < 2 || minutes - reviewMinutes >= 18 || new Date(now).getDate() % 3 === 0
      const kanaTask = previousKana ?? (!current && foundationDay && selectedKana && minutes - reviewMinutes >= 12 ? {
        id: `${date}:ja:kana:${selectedKana.id}`, kind: 'learn' as const, title: `听读基础：${selectedKana.title}`, minutes: 3,
        reason: '每天只练一小组，与生活对话并行；原站听示范，本站存首答。字形正确不等于已经会发音。', materialId: selectedKana.id, done: false,
      } : undefined)
      const kanaMinutes = kanaTask ? Math.min(kanaTask.minutes, Math.max(0, minutes - reviewMinutes)) : 0
      const auxiliaryMinutes = Math.max(0, minutes - reviewMinutes - kanaMinutes)
      const lastAuxiliary = sessions.filter(s => s.completedAt && s.completedAt <= now && !s.materialId?.startsWith('ja-kana-') && ['japanese-dialogue', 'japanese-reading', 'japanese-extensive'].includes(s.kind))
        .sort((a, b) => a.completedAt! - b.completedAt!).at(-1)
      const selectedBook = nextJapaneseBook(materials, events, now)
      const lastReading = sessions.filter(s => s.completedAt && s.completedAt <= now && !s.materialId?.startsWith('ja-kana-')
        && ['japanese-reading', 'japanese-extensive'].includes(s.kind)).sort((a, b) => a.completedAt! - b.completedAt!).at(-1)
      const useBook = !!selectedBook && (lastReading?.kind === 'japanese-reading' || !selectedReading)
      const readingTurn = !!selectedReading && lastAuxiliary?.kind === 'japanese-dialogue' || useBook
      const lastPractice = sessions.filter(s => s.kind === 'japanese-practice' && s.completedAt && s.completedAt <= now)
        .sort((a, b) => a.completedAt! - b.completedAt!).at(-1)
      // Rotate whole activities when two meaningful blocks cannot fit. A
      // completed course practice opens an auxiliary turn, then course resumes.
      const standaloneAuxiliary = !current && history.length >= 2 && auxiliaryMinutes >= 5 && auxiliaryMinutes < 10
        && (!lastAuxiliary || !!lastPractice && lastPractice.completedAt! > lastAuxiliary.completedAt!)
      const mainReserve = material && !standaloneAuxiliary ? 5 : 0
      const integratedFloor = kanaTask ? Math.max(15, mainReserve + 5) : mainReserve + 5
      const bothIntegratedFloor = Math.max(20, integratedFloor + 5)
      const dialogueTask = previousDialogue ?? (!current && history.length >= 2 && material && auxiliaryMinutes >= integratedFloor
        && !(readingTurn && auxiliaryMinutes < bothIntegratedFloor) ? {
        id: `${date}:ja:speak:${material.id}`, kind: 'speak' as const, title: '连续回应三轮，再改一处', minutes: 5,
        reason: '系统沿用今天的话题；录音先保存，AI 不可用时可用标明的离线应答练习。', materialId: material.id, done: false,
      } : undefined)
      const dialogueMinutes = dialogueTask ? Math.min(dialogueTask.minutes, auxiliaryMinutes) : 0
      const readingSlot = auxiliaryMinutes - dialogueMinutes >= integratedFloor && (!dialogueTask || auxiliaryMinutes >= bothIntegratedFloor)
      const readingTask = previousReading ?? (!current && history.length >= 1 && useBook && readingSlot ? {
        id: `${date}:ja:learn:${selectedBook.book.id}`, kind: 'learn' as const, title: `轻松读原版：${selectedBook.book.title}`, minutes: 5,
        reason: selectedBook.continuing ? '接着上次书签读；时间到了就停，不必读完一本。'
          : selectedBook.trial ? '根据你的阅读感受试读浅一点的新等级；吃力就换，不是能力升级。'
            : '从容易的原版开始，理解大意就继续；不加翻译和测验，读感只用于下一本推荐。', materialId: selectedBook.book.id, done: false,
      } : !current && history.length >= 1 && selectedReading && readingSlot ? {
        id: `${date}:ja:learn:${selectedReading.id}`, kind: 'learn' as const, title: `读懂生活短篇：${selectedReading.title}`, minutes: 5,
        reason: selectedReading.trial ? '新难度试读，不代表已经升级；吃力就回退。理解和读法分开练。'
          : '先读意思，再试假名读法；理解与读法分别记录，不算听说成绩。', materialId: selectedReading.id, done: false,
      } : undefined)
      const readingMinutes = readingTask ? Math.min(readingTask.minutes, Math.max(0, auxiliaryMinutes - dialogueMinutes)) : 0
      const lessonMinutes = standaloneAuxiliary ? 0 : Math.max(0, auxiliaryMinutes - dialogueMinutes - readingMinutes)
      // Preserve task identity after starting; do not fill a finished day again.
      const task = previous ?? (!current && !completed.some(task => task.kind === 'listen') && material ? { id: `${date}:ja:listen:${material.id}`, kind: 'listen' as const,
        title: material.title, minutes, reason: history.at(-1)?.data?.effort === 'hard'
          ? '上次觉得吃力，今天先巩固熟悉话题；不急着加难度。'
          : '真人输入 → 回忆意思 → 自己表达 → 对照重说', materialId: material.id, done: false } : undefined)
      const tasks = [...completed, ...(reviewTask && reviewMinutes > 0 ? [{ ...reviewTask, minutes: reviewMinutes }] : []),
        ...(task && lessonMinutes > 0 ? [{ ...task, minutes: lessonMinutes }] : []), ...(kanaTask && kanaMinutes > 0 ? [{ ...kanaTask, minutes: kanaMinutes }] : []),
        ...(readingTask && readingMinutes > 0 ? [{ ...readingTask, minutes: readingMinutes }] : []),
        ...(dialogueTask && dialogueMinutes > 0 ? [{ ...dialogueTask, minutes: dialogueMinutes }] : [])]
      if (!tasks.length) return null
      const plan = planSchema.parse({ id: date, date, minutes: tasks.reduce((sum, task) => sum + (task.optional ? 0 : task.minutes), 0),
        focus: 'realWorld', tasks,
        evidenceFingerprint: `ja:${placement.basis}:${placement.confirmedAt}:${events.length}:${minutes}`, createdAt: current?.createdAt ?? now })
      await database.plans.put(plan)
      return plan
    })
  }
  async function start(taskId: string, now = Date.now()): Promise<StudySession> {
    const plan = await today(now)
    const task = plan?.tasks.find(task => task.id === taskId && !task.done && !task.optional)
    if (task?.kind === 'review') return review.start(task, now)
    if (task?.kind === 'speak') return dialogue.start(task, now)
    if (task?.kind === 'learn') return task.materialId?.startsWith('ja-tadoku-') ? books.start(task, now) : reading.start(task, now)
    if (!task?.materialId || task.minutes <= 0) throw new Error('今天的安排已更新，请返回今日任务。')
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await fence()
      const id = `ja-practice:${task.id}`, previous = await database.sessions.get(id)
      if (previous) return previous
      const draft: JapanesePracticeDraft = { taskId, revision: 0, listened: false, response: '', expression: '', example: '', audioId: '', retryAudioId: '', comparison: '' }
      const session = sessionSchema.parse({ id, kind: 'japanese-practice', materialId: task.materialId, startedAt: now, stage: 'listen', draft })
      await database.sessions.add(session)
      await assignCourse(session, now)
      await repository.recordEvent({ id: `${id}:started`, type: 'TASK_STARTED', timestamp: now, source: 'objective', sessionId: id,
        data: { taskId, materialId: task.materialId!, minutes: task.minutes } })
      return session
    })
  }
  async function save(sessionId: string, input: JapanesePracticeDraft, step: JapanesePracticeStep): Promise<StudySession> {
    const draft = japanesePracticeDraft.parse(input)
    if (!steps.includes(step)) throw new Error('无效的练习步骤')
    if (step !== 'listen' && !draft.response.trim()) throw new Error('先保存自己的首答；没听懂也可以如实写下。')
    if (['speak', 'compare'].includes(step) && !draft.listened) throw new Error('请在对照阶段实际听过原声，再进入录音。')
    if (['speak', 'compare'].includes(step) && (!draft.expression.trim() || !draft.example.trim())) throw new Error('先选一个表达，再写一句自己的话。')
    if (step === 'compare' && !draft.audioId) throw new Error('请先录下自己的回答。')
    await checkOwner()
    return database.transaction('rw', database.sessions, database.audio, database.events, database.syncMeta, async () => {
      await fence()
      const session = await database.sessions.get(sessionId)
      if (!session || session.kind !== 'japanese-practice') throw new Error('练习记录不存在')
      if (session.completedAt) throw new Error('这次练习已经保存完成，请返回今日任务。')
      const stored = japanesePracticeDraft.parse(session.draft)
      if (stored.taskId !== draft.taskId || stored.revision !== draft.revision) throw new Error('这份练习已在其他页面更新，请重新打开；当前输入未覆盖已保存内容。')
      const assignment = await database.events.get(`${sessionId}:course-assignment`)
      const independentFirst = ['application', 'delayed-transfer'].includes(String(assignment?.data?.coursePhase))
      if (step !== 'listen' && !independentFirst && !draft.listened) throw new Error('先听一段原声，再写下听懂的意思；没听懂也可以如实写下。')
      const firstAttempt = await database.events.get(`${sessionId}:independent-attempt`)
      if (step !== 'listen' && assignment?.data?.coursePhase === 'delayed-transfer' && !firstAttempt)
        throw new Error('先保存独立书写与录音首答，再展开参考和进入对照。')
      if ((step !== 'listen' && assignment) || firstAttempt)
        await freezeFirstAttempt(session, draft, Date.now())
      for (const id of [draft.audioId, draft.retryAudioId].filter(Boolean)) {
        const audio = await database.audio.get(id)
        if (!audio?.blob.size || audio.kind !== 'recording') throw new Error('请先将录音成功保存在日语区。')
      }
      const next = sessionSchema.parse({ ...session, stage: step, draft: { ...draft, revision: draft.revision + 1 } })
      await database.sessions.put(next)
      return next
    })
  }
  async function replaceUnavailable(sessionId: string, now = Date.now()): Promise<StudySession | null> {
    await today(now)
    await checkOwner()
    return database.transaction('rw', database.tables, async () => {
      await Dexie.waitFor(Dexie.ignoreTransaction(sharedFence))
      await fence()
      const session = await database.sessions.get(sessionId)
      if (!session || session.kind !== 'japanese-practice' || !session.materialId || session.completedAt) throw new Error('当前练习已改变，请返回日语今日安排。')
      const draft = japanesePracticeDraft.parse(session.draft), date = new Date(now).toLocaleDateString('en-CA')
      const plan = await database.plans.get(date), assigned = plan?.tasks.find(task => task.id === draft.taskId && task.kind === 'listen' && task.materialId === session.materialId)
      if (!plan || !assigned || assigned.done) throw new Error('这份草稿不在今天的安排中，原稿仍保留；请返回今日任务。')
      const reportId = `${sessionId}:unavailable:${date}`, previous = await database.events.get(reportId)
      if (previous) return typeof previous.data?.replacementSessionId === 'string'
        ? await database.sessions.get(previous.data.replacementSessionId) ?? null : null
      if (assigned.optional) throw new Error('这份练习已不在必做安排中，原稿仍保留。')
      const report = eventSchema.parse({ id: reportId, type: 'EXTERNAL_LINK_UNAVAILABLE', source: 'self-report', timestamp: now,
        sessionId, data: { materialId: session.materialId, taskId: assigned.id, issue: 'cannot-open', playbackObserved: false } })
      const materials = await database.materials.toArray(), events = await database.events.toArray()
      const currentMaterial = materials.find(material => material.id === session.materialId)
      if (!currentMaterial?.externalStudy || currentMaterial.language !== 'ja') throw new Error('这不是可替换的日语原站课程。')
      const history = [...events, report], unavailable = unavailableExternalIds(history, now)
      const publisherFailures = new Map<string, number>()
      for (const material of materials) if (material.externalStudy && unavailable.has(material.id)) {
        const publisher = material.externalStudy.publisher
        publisherFailures.set(publisher, (publisherFailures.get(publisher) ?? 0) + 1)
      }
      // After two distinct failures from one publisher, stop rotating through
      // its entire library. Use other saved practice without claiming listening.
      const alternative = nextJapaneseLesson(materials.filter(material => material.id !== session.materialId
        && (publisherFailures.get(material.externalStudy?.publisher ?? '') ?? 0) < 2), history, currentMaterial.difficulty, now)
      const replacement = alternative ? { ...assigned, id: `${date}:ja:listen:${alternative.id}`, title: alternative.title,
        materialId: alternative.id, reason: '原站暂时打不开，换一课难度相近的真人练习；原来的草稿和录音仍保留。' } : null
      if (replacement && plan.tasks.some(task => task.id === replacement.id)) throw new Error('替代任务已存在，请返回今日安排继续。')
      const next = replacement ? sessionSchema.parse({ id: `ja-practice:${replacement.id}`, kind: 'japanese-practice', materialId: replacement.materialId,
        startedAt: now, stage: 'listen', draft: { taskId: replacement.id, revision: 0, listened: false, response: '', expression: '', example: '', audioId: '', retryAudioId: '', comparison: '' } }) : null
      const tasks = plan.tasks.flatMap(task => task.id === assigned.id ? [{ ...task, optional: true }, ...(replacement ? [replacement] : [])] : [task])
      const updated = planSchema.parse({ ...plan, tasks, minutes: tasks.reduce((sum, task) => sum + (task.optional ? 0 : task.minutes), 0) })
      await Dexie.waitFor(Dexie.ignoreTransaction(sharedFence))
      await fence()
      await database.events.add(eventSchema.parse({ ...report, data: { ...report.data, ...(next ? { replacementSessionId: next.id } : {}) } }))
      await database.plans.put(updated)
      if (next && replacement) {
        await database.sessions.add(next)
        await assignCourse(next, now)
        await database.events.add(eventSchema.parse({ id: `${next.id}:started`, type: 'TASK_STARTED', source: 'objective', sessionId: next.id,
          timestamp: now, data: { taskId: replacement.id, materialId: replacement.materialId!, minutes: replacement.minutes } }))
      }
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
      const assignment = await database.events.get(`${sessionId}:course-assignment`)
      const firstAttempt = await database.events.get(`${sessionId}:independent-attempt`)
      if (['application', 'delayed-transfer'].includes(String(assignment?.data?.coursePhase)) && !firstAttempt)
        throw new Error('应用与延迟任务需要先保存独立书写，再对照重说；原草稿仍保留。')
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
          audioId: draft.retryAudioId, listened: true, playbackObserved: false, comprehensionVerified: false,
          ...(draft.effort ? { effort: draft.effort } : {}),
          ...(assignment?.data ?? {}), ...(firstAttempt ? { firstAttemptEventId: firstAttempt.id } : {}),
          publisherCoverageVerified: false } })
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
      const coach = await database.sessions.get(`ja-coach:${sessionId}`)
      if (coach?.kind === 'japanese-coach') await database.sessions.put({ ...coach, completedAt: now, stage: 'completed' })
      return complete
    })
  }
  return { database, repository, review, dialogue, reading, books, open, checkOwner, saveDiagnostic, startingPoint, practiceGuide, lockIndependentAttempt, confirmBeginnerStart, today, start, save, replaceUnavailable, finish, diagnosticId }
}
