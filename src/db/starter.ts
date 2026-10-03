import { z } from 'zod'
import Dexie from 'dexie'
import { starterLesson, starterLessons, type StarterLesson } from '../content/starter-courses'
import { effectiveStarterFeedback, localStarterFeedback, nextStarterLesson, starterAttemptFromEvent, starterDelay, starterStages, starterRemainingMinutes, validateStarterFeedback, type StarterAttempt, type StarterStage } from '../domain/starter'
import type { StarterFeedback } from '../ai/starter-schema'
import type { Material, StudyEvent, StudySession } from '../domain/types'
import type { JoveDatabase } from './db'
import { eventSchema, sessionSchema } from './schema'
import { createLearningRepository } from './repository'
import { readLanguageDay } from './language-day'
import { languageDatabases } from '../domain/language'

const starterAdmissions = new Map<string, Promise<void>>()

/** Keep the cross-database preflight and commit in one origin-wide admission.
 * Acquire outside IndexedDB transactions; isolated/test stores use a local queue. */
async function withStarterAdmission<T>(english: JoveDatabase, admit: () => Promise<T>): Promise<T> {
  if (Dexie.currentTransaction) throw new Error('Starter admission must start outside an existing transaction')
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks) return locks.request(`jove-language-os:starter-budget:${english.name}`, { mode: 'exclusive' }, admit)
  const previous = starterAdmissions.get(english.name) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  starterAdmissions.set(english.name, pending)
  await previous
  try { return await admit() }
  finally {
    release()
    if (starterAdmissions.get(english.name) === pending) starterAdmissions.delete(english.name)
  }
}

export const starterDraftSchema = z.strictObject({
  version: z.literal(1), lessonVersion: z.number().int().min(1), revision: z.number().int().min(0),
  purpose: z.enum(['lesson', 'review']), pace: z.enum(['quick', 'standard']), minutes: z.number().int().min(1).max(12),
  contextId: z.string().min(1).max(100), response: z.string().max(500),
  mode: z.enum(['choice', 'text', 'audio-transcript']), helped: z.boolean(), helpCount: z.number().int().min(0).max(100),
  romaji: z.boolean(), audioId: z.string().max(200), audioIds: z.array(z.string().max(200)).max(100),
  lastAttemptId: z.string().max(200), activeMs: z.number().int().min(0).max(10_800_000),
  audioUnavailable: z.boolean().optional(), missingAudioIds: z.array(z.string()).optional(),
  syncReadingConflicts: z.array(z.string()).optional(),
  syncRecovery: z.strictObject({ sourceSessionId: z.string(), rootSessionId: z.string(), sourceDeviceId: z.string(), sourceVersion: z.string() }).optional(),
  workloadTaskId: z.string().optional(),
})
export type StarterDraft = z.infer<typeof starterDraftSchema>
export type StarterState = { session: StudySession; lesson: StarterLesson; draft: StarterDraft; attempts: StarterAttempt[]; feedback: StarterFeedback | null; pendingTranscription?: string }

export function starterMaterials(language: 'en' | 'ja'): Material[] {
  return starterLessons.filter(lesson => lesson.language === language).map(lesson => ({
    id: lesson.id, language, title: lesson.titleZh, topic: lesson.goalZh, difficulty: 0.05 + lesson.position * 0.01,
    duration: lesson.minutes.standard * 60, transcript: lesson.model.text, translation: lesson.model.meaningZh,
    sentences: [lesson.model.text], ...(lesson.sound.audioPath ? { audioPath: lesson.sound.audioPath } : {}),
    sourceKind: 'curated', sourceLabel: lesson.sound.sourceLabel, synthetic: !!lesson.sound.audioPath, approved: true,
    license: 'Original in-site teaching examples; synthetic demonstration is labelled separately from publisher human speech.',
    question: lesson.recognition.promptZh, answer: lesson.recognition.answerId, keywords: [], chunks: [], createdAt: Date.UTC(2026, 9, 3),
  }))
}

/** All answers are append-only events. A draft is only the current editable place,
 * so a concurrent-device conflict cannot silently rewrite a submitted answer. */
export function createStarterClassroom(database: JoveDatabase, english: JoveDatabase, active: () => boolean = () => true) {
  if (english.language !== 'en') throw new Error('Invalid account workspace')
  let owner: unknown, opened = false
  const tables = [database.sessions, database.events, database.audio, database.syncMeta, database.profiles, database.materials]
  function assertActive() { if (!opened || !active()) throw new Error('学习账号已变化，原来的回答仍保留。请重新打开课程。') }
  async function assertCurrent() {
    assertActive()
    const [local, shared] = await Promise.all([database.syncMeta.get('owner'), english.syncMeta.get('owner')])
    assertActive()
    if (local?.value !== owner || shared?.value !== owner) throw new Error('请回到原学习账号继续，记录没有被覆盖。')
  }
  async function fence() {
    assertActive()
    if (database !== english) await Dexie.waitFor(Dexie.ignoreTransaction(async () => {
      if ((await english.syncMeta.get('owner'))?.value !== owner) throw new Error('共享学习账号已变化，日语没有保存到新的账号。')
      assertActive()
    }))
    if ((await database.syncMeta.get('owner'))?.value !== owner) throw new Error('学习记录属于另一个账号，已停止保存。')
  }
  async function open() {
    owner = (await english.syncMeta.get('owner'))?.value
    if ((await database.syncMeta.get('owner'))?.value !== owner) throw new Error('先连接同一学习账号，再打开课程。')
    opened = true
    await assertCurrent()
    await createLearningRepository(database).initialize(starterMaterials(database.language))
    await assertCurrent()
  }
  async function historyIds(session: StudySession) {
    const visited = new Set<string>(), pending = [session.id]
    while (pending.length) {
      const id = pending.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      const ancestor = id === session.id ? session : await database.sessions.get(id)
      if (!ancestor) continue // a remote page may not have delivered this original yet
      if (ancestor.kind !== 'starter-classroom' || ancestor.materialId !== session.materialId) throw new Error('草稿来源与当前课程不一致，未混合历史。')
      const recovery = starterDraftSchema.parse(ancestor.draft).syncRecovery
      if (recovery) pending.push(recovery.rootSessionId, recovery.sourceSessionId)
    }
    return [...visited]
  }
  async function load(id: string): Promise<StarterState> {
    await assertCurrent()
    const session = await database.sessions.get(id), lesson = session && starterLesson(session.materialId ?? '')
    if (!session || session.kind !== 'starter-classroom' || !lesson || lesson.language !== database.language
      || !starterStages.includes(session.stage as StarterStage)) throw new Error('没有找到这次入门课；旧练习仍可从原入口继续。')
    const draft = starterDraftSchema.parse(session.draft)
    if (draft.lessonVersion !== lesson.version) throw new Error('课程已更新，原回答仍保留。请从入门课入口开始新版。')
    const events = await database.events.where('sessionId').anyOf(await historyIds(session)).toArray()
    await assertCurrent()
    const feedback = effectiveStarterFeedback(draft.lastAttemptId, events)
    const raw = draft.mode !== 'audio-transcript' && events.filter(event => event.type === 'STARTER_TRANSCRIPTION'
      && event.data?.audioId === draft.audioId).sort((a, b) => b.timestamp - a.timestamp)[0]?.data?.rawText
    return { session, lesson, draft, attempts: events.map(starterAttemptFromEvent).filter((attempt): attempt is StarterAttempt => !!attempt), feedback,
      ...(typeof raw === 'string' ? { pendingTranscription: raw } : {}) }
  }
  async function next(now = Date.now()) {
    await assertCurrent()
    const available = await remainingAllowance(now, database.language === 'ja')
    const selected = nextStarterLesson(database.language, await database.sessions.toArray(), await database.events.toArray(), now, available)
    await assertCurrent()
    return selected
  }
  async function allowance(now = Date.now()) { return remainingAllowance(now) }
  async function remainingAllowance(now: number, admitJapanese = false) {
    const day = await readLanguageDay(english, now, database.language === 'ja' ? database : undefined, { admitJapanese })
    if (day) return Math.max(0, day.allowances[database.language].remaining - day.allowances[database.language].reserved)
    const profile = await english.profiles.get('main'), events = await english.events.toArray()
    return starterRemainingMinutes(profile?.dailyMinutes ?? 45, events, now)
  }
  async function start(lessonId: string, pace: 'quick' | 'standard' = 'standard', now = Date.now(), review = false): Promise<StarterState> {
    return withStarterAdmission(english, () => startAdmitted(lessonId, pace, now, review))
  }
  async function startAdmitted(lessonId: string, pace: 'quick' | 'standard', now: number, review: boolean): Promise<StarterState> {
    await assertCurrent()
    const lesson = starterLesson(lessonId)
    if (!lesson || lesson.language !== database.language) throw new Error('这节课不属于当前语言。')
    // Resuming is not another assignment or charge, including across midnight.
    const previous = await database.sessions.filter(session => session.kind === 'starter-classroom' && session.materialId === lessonId
      && !session.id.startsWith('reading-conflict:') && !session.completedAt && session.draft.purpose === (review ? 'review' : 'lesson')).first()
    if (previous) return load(previous.id)
    // A per-tab queue cannot safely replace an origin lock for shared stores.
    // Existing drafts remain resumable on older browsers, without new reservations.
    if (english.name === languageDatabases.en && !(typeof navigator !== 'undefined' && navigator.locks)
      && (database.language === 'ja' || (await Dexie.getDatabaseNames()).includes(languageDatabases.ja))) {
      throw new Error('当前浏览器无法协调两种语言的共同时间额度，请更新浏览器后开新课；已保存的课仍可继续。')
    }
    const remaining = await remainingAllowance(now, database.language === 'ja'), minutes = review ? 3 : lesson.minutes[pace]
    if (remaining < minutes) throw new Error(`今天剩余安排不足${minutes}分钟。可继续已保存的课，或在首页减少其他安排；不会额外叠加必做任务。`)
    const sessions = await database.sessions.toArray()
    if (review) {
      const latest = sessions.filter(session => session.kind === 'starter-classroom' && session.materialId === lessonId && !!session.completedAt)
        .sort((a, b) => b.completedAt! - a.completedAt!)[0]
      if (!latest || latest.completedAt! + starterDelay > now) throw new Error('先学过这节课，再在后续时段进行延迟复习；现在可以继续原小课。')
    }
    if (!review && lesson.prerequisites.some(id => !sessions.some(session => session.kind === 'starter-classroom'
      && session.materialId === id && !!session.completedAt))) throw new Error('先从上一节入门课开始，它会教这次需要的内容。')
    let id = `starter-${database.language}-${crypto.randomUUID()}`
    const previousAttempts = (await database.events.toArray()).map(starterAttemptFromEvent).filter((attempt): attempt is StarterAttempt => !!attempt
      && attempt.lessonId === lesson.id && attempt.stage === 'transfer').sort((a, b) => b.timestamp - a.timestamp)
    const contextIndex = previousAttempts.length ? (lesson.transfer.findIndex(context => context.id === previousAttempts[0]!.contextId) + 1) % lesson.transfer.length : 0
    const contextId = review ? lesson.transfer[contextIndex]!.id : `${lesson.id}:introduced`
    await assertCurrent()
    await database.transaction('rw', tables, async () => {
      await fence()
      const concurrent = await database.sessions.filter(session => session.kind === 'starter-classroom' && session.materialId === lessonId
        && !session.id.startsWith('reading-conflict:') && !session.completedAt && session.draft.purpose === (review ? 'review' : 'lesson')).first()
      if (concurrent) { id = concurrent.id; return }
      const draft: StarterDraft = { version: 1, lessonVersion: lesson.version, revision: 0, purpose: review ? 'review' : 'lesson', pace, minutes,
        contextId, response: '', mode: 'text', helped: !review, helpCount: 0, romaji: !review && database.language === 'ja',
        audioId: '', audioIds: [], lastAttemptId: '', activeMs: 0 }
      await database.sessions.add(sessionSchema.parse({ id, kind: 'starter-classroom', materialId: lesson.id, startedAt: now,
        stage: review ? 'transfer' : 'teach', draft }))
      await database.events.add(eventSchema.parse({ id: `${id}:started`, type: 'TASK_STARTED', source: 'objective', timestamp: now,
        sessionId: id, data: { taskId: id, kind: 'starter-classroom', minutes, lessonId: lesson.id, lessonVersion: lesson.version, review } }))
      await database.profiles.update('main', { onboarded: true })
      await fence()
    })
    return load(id)
  }
  async function write(id: string, revision: number, change: (state: StudySession, draft: StarterDraft) => Promise<void> | void) {
    await assertCurrent()
    await database.transaction('rw', tables, async () => {
      await fence()
      const state = await database.sessions.get(id)
      if (!state || state.kind !== 'starter-classroom' || state.completedAt || id.startsWith('reading-conflict:')) throw new Error('这份原件只供回看。请选择接续为新草稿，不会覆盖原回答。')
      const draft = starterDraftSchema.parse(state.draft)
      if (draft.revision !== revision) throw new Error('另一处已保存更新。请重新载入后继续；这次尚未提交的文字仍在页面上。')
      await change(state, draft)
      await fence()
      draft.revision++
      await database.sessions.put(sessionSchema.parse({ ...state, draft: starterDraftSchema.parse(draft) }))
      await fence()
    })
    return load(id)
  }
  async function save(id: string, revision: number, patch: Pick<StarterDraft, 'response' | 'mode' | 'audioId' | 'romaji' | 'activeMs'>) {
    const frozen = { ...patch }
    return write(id, revision, async (_state, draft) => {
      if (frozen.audioId && (!await database.audio.get(frozen.audioId))) throw new Error('录音还未保存，请保留原件并重试。')
      draft.response = z.string().max(500).parse(frozen.response)
      draft.mode = starterDraftSchema.shape.mode.parse(frozen.mode)
      draft.audioId = frozen.audioId; draft.romaji = frozen.romaji
      if (frozen.romaji) draft.helped = true // hiding a previously exposed aid never erases its use
      draft.activeMs = Math.max(draft.activeMs, starterDraftSchema.shape.activeMs.parse(frozen.activeMs))
      if (frozen.audioId && !draft.audioIds.includes(frozen.audioId)) draft.audioIds.push(frozen.audioId)
    })
  }
  async function help(id: string, revision: number) {
    return write(id, revision, (_state, draft) => { draft.helped = true; draft.helpCount = Math.min(100, draft.helpCount + 1) })
  }
  async function foundation(id: string, revision: number, choiceId: string, now = Date.now()) {
    const choice = z.string().min(1).max(100).parse(choiceId)
    return write(id, revision, async (session, draft) => {
      const lesson = starterLesson(session.materialId ?? ''), check = lesson?.foundation?.check
      if (session.stage !== 'teach' || draft.lessonVersion !== lesson?.version || !check || !check.choices.some(item => item.id === choice))
        throw new Error('请先看本课的基础讲解，再选一个已教过的小选项。')
      await database.events.add(eventSchema.parse({ id: `${id}:foundation:${revision}`, type: 'STARTER_FOUNDATION_ATTEMPT',
        timestamp: now, sessionId: id, source: 'objective', prompted: true,
        data: { lessonId: lesson!.id, lessonVersion: lesson!.version, revision, choiceId: choice,
          correct: choice === check.answerId, ability: 'supported-script-recognition', acousticAssessed: false } }))
    })
  }
  async function recover(copyId: string, now = Date.now()) {
    await assertCurrent()
    const copy = await load(copyId)
    if (!copyId.startsWith('reading-conflict:') || !copy.draft.syncRecovery || copy.session.completedAt) throw new Error('请选择尚未结束的冲突草稿；已提交原件不能重新覆盖。')
    let id = `starter-${database.language}-${crypto.randomUUID()}`
    await database.transaction('rw', tables, async () => {
      await fence()
      const latest = await database.sessions.get(copyId)
      if (!latest || JSON.stringify(latest) !== JSON.stringify(copy.session)) throw new Error('这份草稿已更新，请重新载入后选择。')
      const existing = await database.sessions.filter(row => row.kind === 'starter-classroom' && !row.completedAt
        && (row.draft.syncRecovery as Record<string, unknown> | undefined)?.sourceSessionId === copyId).first()
      if (existing) { id = existing.id; return }
      const draft = starterDraftSchema.parse({ ...copy.draft, revision: 0,
        workloadTaskId: copy.draft.workloadTaskId ?? copy.draft.syncRecovery!.rootSessionId,
        syncRecovery: { ...copy.draft.syncRecovery!, sourceSessionId: copyId } })
      delete draft.syncReadingConflicts
      await database.sessions.add(sessionSchema.parse({ ...copy.session, id, startedAt: now, draft }))
      await database.events.add(eventSchema.parse({ id: `${id}:recovered`, type: 'STARTER_BRANCH_RECOVERED', timestamp: now,
        sessionId: id, source: 'self-report', data: { sourceSessionId: copyId, rootSessionId: draft.syncRecovery!.rootSessionId } }))
      await fence()
    })
    return load(id)
  }
  function feedbackEvent(attempt: StarterAttempt, feedback: StarterFeedback, timestamp: number, suffix = 'local'): StudyEvent {
    return eventSchema.parse({ id: `${attempt.id}:feedback:${suffix}`, type: 'STARTER_FEEDBACK', sessionId: attempt.sessionId,
      timestamp, source: feedback.source === 'ai' ? 'ai' : 'objective', prompted: attempt.prompted,
      data: { attemptId: attempt.id, lessonId: attempt.lessonId, lessonVersion: attempt.lessonVersion,
        verdict: feedback.verdict, feedbackZh: feedback.feedbackZh, correction: feedback.correction ?? '', nextAction: feedback.nextAction,
        evidence: feedback.evidence, ...(feedback.model ? { model: feedback.model } : {}), acousticAssessed: false } })
  }
  async function submit(id: string, revision: number, now = Date.now()) {
    const duplicate = await database.events.where('sessionId').equals(id).filter(event => event.type === 'STARTER_ATTEMPT' && event.data?.revision === revision).first()
    if (duplicate) return load(id)
    return write(id, revision, async (state, draft) => {
      const lesson = starterLesson(state.materialId!)!
      if (!['recognize', 'assemble', 'express', 'transfer'].includes(state.stage) || !draft.response.trim()) throw new Error('先完成这一小步；不会时可以点帮助。')
      if (draft.mode === 'audio-transcript' && (!draft.audioId || !await database.audio.get(draft.audioId))) throw new Error('先保存原录音并核对识别文字；也可以改用文字练习。')
      const attempt: StarterAttempt = { id: `${id}:attempt:${crypto.randomUUID()}`, sessionId: id, lessonId: lesson.id, lessonVersion: lesson.version,
        stage: state.stage as StarterAttempt['stage'], contextId: draft.contextId, response: draft.response.trim(),
        prompted: draft.helped || draft.romaji || draft.mode === 'choice' || ['recognize', 'assemble'].includes(state.stage),
        mode: draft.mode, timestamp: now, ...(draft.audioId ? { audioId: draft.audioId } : {}) }
      const feedback = localStarterFeedback(lesson, attempt)
      await database.events.add(eventSchema.parse({ id: attempt.id, type: 'STARTER_ATTEMPT', timestamp: now,
        sessionId: id, source: attempt.mode === 'choice' ? 'objective' : 'text', prompted: attempt.prompted,
        contextId: attempt.contextId, data: { lessonId: lesson.id, lessonVersion: lesson.version, stage: attempt.stage, contextId: attempt.contextId,
          response: attempt.response, mode: attempt.mode, revision, ...(attempt.audioId ? { audioId: attempt.audioId } : {}), acousticAssessed: false } }))
      await database.events.add(feedbackEvent(attempt, feedback, now))
      draft.lastAttemptId = attempt.id
      // The original answer was frozen above. Showing any reference/repair now
      // makes a subsequent same-context answer supported, not a fresh first pass.
      draft.helped = true
      if (['invalid', 'partial'].includes(feedback.verdict)) {
        const failures = (await database.events.where('sessionId').equals(id).toArray()).filter(event => event.type === 'STARTER_FEEDBACK'
          && event.source === 'objective' && ['invalid', 'partial'].includes(String(event.data?.verdict)))
        const stageAttempts = new Set((await database.events.where('sessionId').equals(id).toArray()).filter(event => event.type === 'STARTER_ATTEMPT'
          && event.data?.stage === state.stage && event.data.contextId === draft.contextId).map(event => event.id))
        if (failures.filter(event => stageAttempts.has(String(event.data?.attemptId))).length >= 2) {
          draft.helpCount = Math.max(2, draft.helpCount)
          if (['express', 'transfer'].includes(state.stage)) { draft.mode = 'choice'; draft.response = '' }
        }
      }
    })
  }
  async function advance(id: string, revision: number, now = Date.now(), continueUnverified = false) {
    return write(id, revision, async (state, draft) => {
      const lesson = starterLesson(state.materialId!)!
      if (state.stage !== 'teach') {
        const latest = effectiveStarterFeedback(draft.lastAttemptId, await database.events.where('sessionId').anyOf(await historyIds(state)).toArray(), now)
        const attempt = starterAttemptFromEvent((await database.events.get(draft.lastAttemptId))!)
        if (attempt && (attempt.response !== draft.response.trim() || attempt.mode !== draft.mode || (attempt.audioId ?? '') !== draft.audioId))
          throw new Error('这个回答或录音已经改过，请先核对新回答；旧反馈和新草稿都已保留。')
        if (!latest || !attempt || attempt.stage !== state.stage || attempt.contextId !== draft.contextId || ['invalid', 'partial'].includes(latest.verdict))
          throw new Error('先试着修正这一处；不会时用示范或选句继续。')
        if (latest.verdict === 'uncertain') {
          if (!continueUnverified) throw new Error('这次回答仍待核对。可以明确选择先继续教学，不会记为正确或独立掌握。')
          const continuationId = `${attempt.id}:continued-unverified:${id}`
          if (!await database.events.get(continuationId)) await database.events.add(eventSchema.parse({ id: continuationId, type: 'STARTER_UNVERIFIED_CONTINUED',
            timestamp: now, sessionId: id, source: 'self-report', data: { attemptId: attempt.id, lessonId: lesson.id } }))
        }
      }
      const next = state.stage === 'teach' ? 'recognize' : state.stage === 'recognize' ? 'assemble'
        : state.stage === 'assemble' ? 'express' : state.stage === 'express' && draft.pace === 'standard' ? 'transfer' : 'done'
      state.stage = next
      draft.response = ''; draft.audioId = ''; draft.lastAttemptId = ''; draft.helpCount = 0
      draft.mode = next === 'recognize' || next === 'assemble' ? 'choice' : 'text'
      draft.helped = ['recognize', 'assemble', 'express'].includes(next)
      if (next === 'transfer') { draft.contextId = lesson.transfer[0]!.id; draft.helped = false; draft.romaji = false }
      if (next === 'done') {
        state.completedAt = now
        await database.events.add(eventSchema.parse({ id: `${id}:completed`, type: 'TASK_COMPLETED', timestamp: now,
          sessionId: id, source: 'objective', data: { taskId: draft.workloadTaskId ?? id, kind: 'starter-classroom', lessonId: lesson.id,
            lessonVersion: lesson.version, minutes: draft.minutes, activeSeconds: Math.floor(draft.activeMs / 1000),
            timeSource: 'planned-workload', masteryAssessed: false, acousticAssessed: false } }))
      }
    })
  }
  async function saveAIFeedback(attemptId: string, value: unknown, model?: string, now = Date.now(), review = false) {
    await assertCurrent()
    const event = await database.events.get(attemptId), attempt = event && starterAttemptFromEvent(event)
    const lesson = attempt && starterLesson(attempt.lessonId)
    if (!attempt || !lesson || lesson.language !== database.language) throw new Error('找不到原回答，未保存反馈。')
    const feedback = { ...validateStarterFeedback(value, lesson, attempt), ...(model ? { model } : {}) }
    await database.transaction('rw', tables, async () => {
      await fence()
      const suffix = review ? 'ai-v2' : 'ai-v1', id = `${attemptId}:feedback:${suffix}`
      const prior = await database.events.get(id)
      if (prior) return // recoverable provider receipts never write duplicate evidence
      if (review) {
        const first = await database.events.get(`${attemptId}:feedback:ai-v1`)
        if (!await database.events.get(`${attemptId}:disputed`) || !model || !first?.data?.model || first.data.model === model)
          throw new Error('独立核对需要保留原异议，并确认使用了不同模型；这次未改变原判断。')
      }
      const result = feedbackEvent(attempt, feedback, now, suffix)
      result.data = { ...result.data, feedbackRevision: review ? 2 : 1 }
      await database.events.add(result)
      await fence()
    })
    return load(attempt.sessionId)
  }
  async function dispute(attemptId: string, now = Date.now()) {
    await assertCurrent()
    let sessionId = ''
    await database.transaction('rw', tables, async () => {
      await fence()
      const attempt = starterAttemptFromEvent((await database.events.get(attemptId))!)
      if (!attempt) throw new Error('找不到需要核对的原回答。')
      sessionId = attempt.sessionId
      const id = `${attemptId}:disputed`
      if (!await database.events.get(id)) await database.events.add(eventSchema.parse({ id, type: 'STARTER_FEEDBACK_DISPUTED',
        timestamp: now, sessionId: attempt.sessionId, source: 'self-report', data: { attemptId, lessonId: attempt.lessonId, reason: 'learner-disagrees' } }))
      await fence()
    })
    return load(sessionId)
  }
  async function recordTranscription(sessionId: string, audioId: string, rawText: string, now = Date.now()) {
    const text = z.string().trim().min(1).max(500).parse(rawText)
    await assertCurrent()
    return database.transaction('rw', tables, async () => {
      await fence()
      const session = await database.sessions.get(sessionId)
      if (!session || session.kind !== 'starter-classroom' || !starterDraftSchema.parse(session.draft).audioIds.includes(audioId)
        || !await database.audio.get(audioId)) throw new Error('未找到这节课的原录音，识别结果没有覆盖回答。')
      const id = `${sessionId}:transcript:${crypto.randomUUID()}`
      await database.events.add(eventSchema.parse({ id, type: 'STARTER_TRANSCRIPTION', timestamp: now, sessionId,
        source: 'ai', data: { audioId, rawText: text, acousticAssessed: false } }))
      await fence()
      return id
    })
  }
  return { open, assertCurrent, next, load, start, save, help, foundation, recover, submit, advance, saveAIFeedback, dispute, allowance, recordTranscription }
}
