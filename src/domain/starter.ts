import { createEmptyCard, fsrs, Rating } from 'ts-fsrs'
import { starterLesson, starterLessons, type StarterLesson } from '../content/starter-courses'
import { starterFeedbackSchema, type StarterFeedback } from '../ai/starter-schema'
import type { LearningLanguage } from './language'
import type { StudyEvent, StudySession } from './types'

export const starterStages = ['teach', 'recognize', 'assemble', 'express', 'transfer', 'done'] as const
export type StarterStage = typeof starterStages[number]
export const starterDelay = 24 * 60 * 60_000
/** Single-language cold-start fallback shared by the entry and admission. */
export function starterRemainingMinutes(dailyMinutes: number, events: StudyEvent[], now: number) {
  const day = new Date(now).toLocaleDateString('en-CA'), receipts = new Map<string, number>(), started = new Map<string, number>()
  const today = events.filter(event => event.timestamp <= now && new Date(event.timestamp).toLocaleDateString('en-CA') === day)
  for (const event of today) if (event.type === 'TASK_COMPLETED' && typeof event.data?.taskId === 'string'
    && typeof event.data.minutes === 'number') receipts.set(event.data.taskId, event.data.minutes)
  for (const event of today) if (event.type === 'TASK_STARTED' && event.source === 'objective'
    && event.data?.kind === 'starter-classroom' && typeof event.data.taskId === 'string'
    && typeof event.data.minutes === 'number' && !receipts.has(event.data.taskId)) started.set(event.data.taskId, event.data.minutes)
  return Math.max(0, dailyMinutes - [...receipts.values(), ...started.values()].reduce((sum, minutes) => sum + minutes, 0))
}
/** Same ordered original texts as the offline audio builder; no publisher media. */
export function starterDemonstrationTexts(lesson: StarterLesson): string[] {
  return [...new Set([lesson.model.text, lesson.scaffold.answer, lesson.expression.reference, ...lesson.transfer.map(context => context.reference)])]
}
export function starterDemonstrationPath(lesson: StarterLesson, text: string): string | undefined {
  // Linked publisher references do not imply an owned/cached sound file.
  if (!lesson.sound.audioPath) return undefined
  const index = starterDemonstrationTexts(lesson).indexOf(text)
  return index < 0 ? undefined : `audio/starter/${lesson.id}${index ? `-${index}` : ''}.wav`
}
export type StarterAttempt = {
  id: string; sessionId: string; lessonId: string; lessonVersion: number;
  stage: Exclude<StarterStage, 'teach' | 'done'>; contextId: string;
  response: string; prompted: boolean; mode: 'choice' | 'text' | 'audio-transcript';
  timestamp: number; audioId?: string
}

export function normalizeStarterAnswer(answer: string, language: LearningLanguage): string {
  const text = answer.normalize('NFKC').replace(/[‘’]/gu, "'").trim().replace(/[.!?。！？]+$/gu, '')
  return language === 'ja' ? text.replace(/\s+/gu, '') : text.toLocaleLowerCase('en-US').replace(/\s+/gu, ' ')
}

export function localStarterFeedback(lesson: StarterLesson, attempt: StarterAttempt): StarterFeedback {
  const evidence = attempt.response.trim()
  if (!evidence || attempt.lessonId !== lesson.id || attempt.lessonVersion !== lesson.version) throw new Error('这次回答与课程不对应。')
  const feedback = (verdict: StarterFeedback['verdict'], feedbackZh: string, correction: string | null, nextAction: StarterFeedback['nextAction']): StarterFeedback =>
    ({ verdict, feedbackZh, correction, nextAction, evidence, source: 'course-rule' })
  if (attempt.stage === 'recognize') {
    if (!lesson.recognition.choices.some(choice => choice.id === evidence)) throw new Error('请选择本题的一项。')
    return evidence === lesson.recognition.answerId
      ? feedback('valid', lesson.recognition.explanationZh, null, 'continue')
      : feedback('invalid', lesson.recognition.explanationZh, null, 'simplify')
  }
  const normalized = normalizeStarterAnswer(evidence, lesson.language)
  const context = lesson.transfer.find(item => item.id === attempt.contextId)
  const accepted = attempt.stage === 'assemble' ? [lesson.scaffold.answer]
    : attempt.stage === 'transfer' ? context?.accepted ?? [] : lesson.expression.accepted
  if (accepted.some(answer => normalizeStarterAnswer(answer, lesson.language) === normalized))
    return feedback('valid', attempt.stage === 'assemble' ? lesson.scaffold.explanationZh
      : attempt.prompted ? `借助帮助，你已经表达出“${context?.meaningZh ?? lesson.model.meaningZh}”。下次试着少看一点提示。`
        : `你这次表达出“${context?.meaningZh ?? lesson.model.meaningZh}”。这符合当前情境；隔天换个场景再用，才能判断是否保留住了。`, null, 'continue')
  if (attempt.contextId === 'ja-starter-3-reply' && lesson.expression.accepted.some(answer => normalizeStarterAnswer(answer, lesson.language) === normalized))
    return feedback('invalid', '这次是对方在感谢你，你可以回应“不用谢”，不用再向对方说谢谢。只换这一句话再试。', context!.reference, 'retry')
  // A reply-to-thanks task is a different communicative role from giving thanks.
  // Never reuse a correction that would reverse that role.
  const error = lesson.expression.errors.find(item => normalizeStarterAnswer(item.input, lesson.language) === normalized
    && (attempt.stage !== 'transfer' || !!context?.accepted.some(answer => normalizeStarterAnswer(answer, lesson.language)
      === normalizeStarterAnswer(item.corrected, lesson.language))))
  if (error) return feedback('invalid', error.feedbackZh, error.corrected, 'retry')
  if (attempt.stage === 'assemble') return feedback('partial', lesson.scaffold.explanationZh, lesson.scaffold.answer, 'simplify')
  return feedback('uncertain', '这可能是另一种合理说法，本地规则暂时不能判断。可以请 AI 核对，或先对照例句继续教学；原回答会保留，不记成错误或已经掌握。', null, 'clarify')
}

/** Format validity is insufficient: feedback must refer to the submitted answer
 * and its suggested replacement must stay within this small taught repertoire. */
export function validateStarterFeedback(value: unknown, lesson: StarterLesson, attempt: StarterAttempt): StarterFeedback {
  const parsed = starterFeedbackSchema.parse(value)
  if (!attempt.response.includes(parsed.evidence)) throw new Error('反馈没有对应原回答，已保留本课备用解释。')
  const allowedActions = { valid: ['continue', 'clarify'], partial: ['retry', 'simplify'], invalid: ['retry', 'simplify'], uncertain: ['clarify'] }
  if (!allowedActions[parsed.verdict].includes(parsed.nextAction)) throw new Error('反馈判断与下一步矛盾，未采用。')
  if (parsed.verdict === 'valid' && parsed.correction !== null) throw new Error('成立的回答不应同时被要求改写，已保留本课反馈。')
  if (attempt.stage === 'recognize' && parsed.verdict === 'valid' && attempt.response !== lesson.recognition.answerId)
    throw new Error('AI 判断与这道确定性选择题矛盾，未采用。')
  const context = lesson.transfer.find(item => item.id === attempt.contextId)
  const repertoire = attempt.stage === 'recognize' ? [] : attempt.stage === 'assemble' ? [lesson.scaffold.answer]
    : attempt.stage === 'transfer' ? context ? [context.reference, ...context.accepted] : []
      : [...lesson.expression.accepted, lesson.expression.reference, ...lesson.expression.errors.map(error => error.corrected)]
  if (parsed.correction && !repertoire.some(text => normalizeStarterAnswer(text, lesson.language) === normalizeStarterAnswer(parsed.correction!, lesson.language)))
    throw new Error('建议超出了本课已教内容，未改变学习状态。')
  if (/https?:|<[^>]+>|(?:发音|语调|音高|流利度).{0,8}(?:得分|分数|准确|正确|错误)|(?:pronunciation|prosody).{0,12}(?:score|correct|incorrect)/iu.test(parsed.feedbackZh))
    throw new Error('反馈含有本课不能验证的判断，已使用备用解释。')
  return { ...parsed, source: 'ai' }
}

export function starterAttemptFromEvent(event: StudyEvent | undefined): StarterAttempt | null {
  if (!event) return null
  const data = event.data
  if (event.type !== 'STARTER_ATTEMPT' || !event.sessionId || !data || typeof data.lessonId !== 'string'
    || typeof data.lessonVersion !== 'number' || typeof data.response !== 'string' || typeof data.contextId !== 'string'
    || !['recognize', 'assemble', 'express', 'transfer'].includes(String(data.stage))
    || !['choice', 'text', 'audio-transcript'].includes(String(data.mode))) return null
  return { id: event.id, sessionId: event.sessionId, lessonId: data.lessonId, lessonVersion: data.lessonVersion,
    stage: data.stage as StarterAttempt['stage'], response: data.response, contextId: data.contextId,
    prompted: event.prompted !== false, mode: data.mode as StarterAttempt['mode'], timestamp: event.timestamp,
    ...(typeof data.audioId === 'string' && data.audioAvailable !== false ? { audioId: data.audioId } : {}) }
}

export function effectiveStarterFeedback(attemptId: string, events: StudyEvent[], now = Date.now()): StarterFeedback | null {
  const results = events.filter(event => event.type === 'STARTER_FEEDBACK' && event.data?.attemptId === attemptId
    && event.timestamp <= now && ['objective', 'ai'].includes(event.source)).sort((a, b) => b.timestamp - a.timestamp
      || Number(b.data?.feedbackRevision ?? 0) - Number(a.data?.feedbackRevision ?? 0) || a.id.localeCompare(b.id))
  const last = results[0]
  if (!last?.data) return null
  const parsed = starterFeedbackSchema.safeParse({ verdict: last.data.verdict, feedbackZh: last.data.feedbackZh,
    correction: last.data.correction || null, nextAction: last.data.nextAction, evidence: last.data.evidence })
  if (!parsed.success) return null
  const disputed = events.some(event => event.type === 'STARTER_FEEDBACK_DISPUTED' && event.data?.attemptId === attemptId && event.timestamp <= now)
  const reviewed = last.source === 'ai' && last.data.feedbackRevision === 2 && typeof last.data.model === 'string'
    && results.some(event => event.source === 'ai' && event.data?.feedbackRevision === 1 && typeof event.data.model === 'string' && event.data.model !== last.data!.model)
  const opposing = results.some(event => (last.data!.verdict === 'valid') !== (event.data?.verdict === 'valid')
    && event.data?.verdict !== 'uncertain' && last.data!.verdict !== 'uncertain')
  return { ...parsed.data, ...(disputed && !reviewed || opposing ? { verdict: 'uncertain', nextAction: 'clarify', correction: null,
    feedbackZh: disputed && !reviewed ? '你的异议已保留，这次回答暂停用于掌握判断。可以明确保留争议继续教学，再用新题验证。'
      : '这次出现了不一致的判断，暂不决定对错。两份反馈都保留，可以先继续教学，之后换题核对。' } : {}),
    source: last.source === 'ai' ? 'ai' : 'course-rule', ...(typeof last.data.model === 'string' ? { model: last.data.model } : {}) }
}

export function starterGoalEvidence(lesson: StarterLesson, events: StudyEvent[], now = Date.now()) {
  const attempts = events.map(starterAttemptFromEvent).filter((attempt): attempt is StarterAttempt => !!attempt
    && attempt.lessonId === lesson.id && attempt.lessonVersion === lesson.version && attempt.timestamp <= now)
  const successful = attempts.filter(attempt => effectiveStarterFeedback(attempt.id, events, now)?.verdict === 'valid')
  const independent = successful.filter(attempt => !attempt.prompted && attempt.mode !== 'choice' && ['express', 'transfer'].includes(attempt.stage))
  const retained = independent.some(a => independent.some(b => b.sessionId !== a.sessionId
    && b.contextId !== a.contextId && b.timestamp - a.timestamp >= starterDelay))
    && (lesson.id !== 'ja-starter-3' || independent.some(attempt => attempt.contextId === 'ja-starter-3-reply'))
  return { attempts: attempts.length, understanding: successful.some(attempt => attempt.stage === 'recognize'),
    supportedUse: successful.some(attempt => attempt.prompted && ['assemble', 'express', 'transfer'].includes(attempt.stage)),
    independentUse: independent.length > 0, retainedUse: retained,
    // A text or confirmed transcript only demonstrates linguistic use, not acoustics.
    speakingVerified: false, lastAttemptAt: Math.max(0, ...attempts.map(attempt => attempt.timestamp)) }
}

function starterReviewDue(lesson: StarterLesson, events: StudyEvent[], now: number) {
  const attempts = events.filter(event => (event.source === 'text' || event.source === 'objective' && event.data?.mode === 'choice')
    && Number.isSafeInteger(event.timestamp)
    && event.timestamp >= 0 && event.timestamp <= now).map(starterAttemptFromEvent)
    .filter((attempt): attempt is StarterAttempt => !!attempt && attempt.lessonId === lesson.id
      && attempt.lessonVersion === lesson.version && !!attempt.response.trim() && attempt.response.length <= 500
      && (attempt.stage === 'express' ? attempt.contextId === `${lesson.id}:introduced`
        : attempt.stage === 'transfer' && lesson.transfer.some(context => context.id === attempt.contextId)))
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  // At most the first independent production per session. Supported preparation
  // may precede it, but a failed/uncertain first answer cannot be upgraded by retry.
  const firstBySession = new Map<string, StarterAttempt>()
  for (const attempt of attempts) {
    const first = firstBySession.get(attempt.sessionId)
    if (!first || (first.prompted || first.mode === 'choice') && !attempt.prompted && attempt.mode !== 'choice')
      firstBySession.set(attempt.sessionId, attempt)
  }
  const observations = [...firstBySession.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  if (!observations.length) return 0
  // Classroom repair is intra-session; instantiate only for delayed retrieval.
  const starterScheduler = fsrs({ enable_fuzz: false, enable_short_term: false })
  let card = createEmptyCard(new Date(observations[0]!.timestamp)), lastRated: StarterAttempt | undefined, due = 0
  for (const attempt of observations) {
    const matching = events.filter(event => event.sessionId === attempt.sessionId && event.timestamp >= attempt.timestamp
      && event.data?.attemptId === attempt.id && event.data.lessonId === lesson.id
      && (event.type !== 'STARTER_FEEDBACK' || event.data.lessonVersion === lesson.version))
    const effective = effectiveStarterFeedback(attempt.id, matching, now)
    let feedback: StarterFeedback | null = null
    if (effective) {
      try { feedback = validateStarterFeedback({ verdict: effective.verdict, feedbackZh: effective.feedbackZh,
        correction: effective.correction, nextAction: effective.nextAction, evidence: effective.evidence }, lesson, attempt) }
      catch { /* Malformed/mismatched feedback cannot establish recall. */ }
    }
    if (attempt.prompted || attempt.mode === 'choice' || !feedback || feedback.verdict === 'uncertain'
      || feedback.verdict === 'valid' && lastRated && (attempt.timestamp - lastRated.timestamp < starterDelay
        || attempt.contextId === lastRated.contextId)) {
      due = attempt.timestamp + starterDelay
      continue
    }
    card = starterScheduler.next(card, new Date(attempt.timestamp), feedback.verdict === 'valid' ? Rating.Good : Rating.Again).card
    lastRated = attempt
    due = Math.max(card.due.getTime(), attempt.timestamp + starterDelay)
  }
  return due
}

export function nextStarterLesson(language: LearningLanguage, sessions: StudySession[], events: StudyEvent[], now = Date.now(), availableMinutes?: number) {
  const courses = starterLessons.filter(lesson => lesson.language === language).sort((a, b) => a.position - b.position)
  const drafts = sessions.filter(session => session.kind === 'starter-classroom' && !session.id.startsWith('reading-conflict:') && !session.completedAt
    && courses.some(lesson => lesson.id === session.materialId)).sort((a, b) => a.startedAt - b.startedAt)
  if (drafts[0]) return { lesson: starterLesson(drafts[0].materialId!)!, session: drafts[0], review: drafts[0].draft.purpose === 'review' }
  const reviews = courses.flatMap(lesson => {
    const completed = sessions.filter(session => session.kind === 'starter-classroom' && session.materialId === lesson.id && !!session.completedAt)
    const last = completed.sort((a, b) => b.completedAt! - a.completedAt!)[0]
    if (!last) return []
    const due = Math.max(last.completedAt! + starterDelay,
      starterGoalEvidence(lesson, events, now).retainedUse ? starterReviewDue(lesson, events, now) : 0)
    return due <= now ? [{ lesson, review: true, due }] : []
  }).sort((a, b) => a.due - b.due || a.lesson.position - b.lesson.position)
  const next = courses.find(lesson => !sessions.some(session => session.kind === 'starter-classroom'
    && session.materialId === lesson.id && session.draft.purpose !== 'review' && !!session.completedAt))
  const day = new Date(now).toLocaleDateString('en-CA')
  const reviewedToday = sessions.some(session => session.kind === 'starter-classroom' && session.draft.purpose === 'review'
    && !!session.completedAt && session.completedAt <= now && courses.some(lesson => lesson.id === session.materialId)
    && new Date(session.completedAt).toLocaleDateString('en-CA') === day)
  // One short retrieval warm-up, then new teaching. Supported learners must not
  // spend every short day clearing the same backlog and never reach new content.
  const roomForBoth = availableMinutes === undefined || availableMinutes >= 3 + (next?.minutes.quick ?? 0)
  if (reviews[0] && (!next || !reviewedToday && roomForBoth)) return { lesson: reviews[0].lesson, review: true }
  return next ? { lesson: next, review: false } : null
}
