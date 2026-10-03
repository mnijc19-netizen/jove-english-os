import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JoveDatabase } from '../src/db/db'
import { createLearningRepository } from '../src/db/repository'
import { createJapaneseWorkspace, japanesePracticeDraft } from '../src/db/japanese'
import { createStarterClassroom, starterDraftSchema, starterMaterials, type StarterState } from '../src/db/starter'
import { readLanguageDay } from '../src/db/language-day'
import { languageDatabases } from '../src/domain/language'
import { starterLesson } from '../src/content/starter-courses'
import { demoMaterials } from '../src/content/materials'
import { japaneseKana } from '../src/content/japanese-kana'
import {
  localStarterFeedback, nextStarterLesson, normalizeStarterAnswer, starterAttemptFromEvent,
  starterDelay, starterGoalEvidence, validateStarterFeedback, type StarterAttempt,
} from '../src/domain/starter'
import type { StarterFeedbackOutput } from '../src/ai/starter-schema'
import type { AudioAsset, DailyPlan, StudyEvent, StudySession } from '../src/domain/types'

const now = Date.UTC(2026, 9, 3, 4)
const owner = '00000000-0000-4000-8000-000000000001'
const otherOwner = '00000000-0000-4000-8000-000000000002'
const databases: JoveDatabase[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const database of databases.splice(0)) await database.delete() })

async function setup(language: 'en' | 'ja' = 'en', active: () => boolean = () => true, japaneseName = `starter-test-ja-${crypto.randomUUID()}`) {
  const english = new JoveDatabase(`starter-test-en-${crypto.randomUUID()}`, 'en')
  const japanese = new JoveDatabase(japaneseName, 'ja')
  databases.push(english, japanese)
  await createLearningRepository(english).initialize(demoMaterials)
  await createLearningRepository(japanese).initialize([])
  for (const database of [english, japanese]) await database.syncMeta.put({ id: 'owner', value: owner })
  await english.profiles.update('main', { dailyMinutes: 150 })
  if (language === 'ja') await japanese.profiles.update('main', { onboarded: true })
  const database = language === 'en' ? english : japanese
  const classroom = createStarterClassroom(database, english, active)
  await classroom.open()
  return { classroom, database, english, japanese }
}
type Classroom = ReturnType<typeof createStarterClassroom>

async function answer(classroom: Classroom, state: StarterState, response: string, mode = state.draft.mode, timestamp = now + 10) {
  const saved = await classroom.save(state.session.id, state.draft.revision, {
    response, mode, audioId: state.draft.audioId, romaji: state.draft.romaji, activeMs: state.draft.activeMs + 1000,
  })
  return classroom.submit(saved.session.id, saved.draft.revision, timestamp)
}

async function expression(classroom: Classroom, state: StarterState) {
  let current = await classroom.advance(state.session.id, state.draft.revision, now + 1)
  current = await answer(classroom, current, current.lesson.recognition.answerId, 'choice', now + 2)
  current = await classroom.advance(current.session.id, current.draft.revision, now + 3)
  current = await answer(classroom, current, current.lesson.scaffold.answer, 'choice', now + 4)
  return classroom.advance(current.session.id, current.draft.revision, now + 5)
}

async function finishQuick(classroom: Classroom, state: StarterState) {
  let current = await expression(classroom, state)
  current = await answer(classroom, current, current.lesson.expression.reference, 'text', now + 6)
  return classroom.advance(current.session.id, current.draft.revision, now + 7)
}

async function transfer(classroom: Classroom, state: StarterState) {
  let current = await expression(classroom, state)
  current = await answer(classroom, current, current.lesson.expression.reference, 'text', now + 6)
  return classroom.advance(current.session.id, current.draft.revision, now + 7)
}

function attempt(patch: Partial<StarterAttempt> = {}): StarterAttempt {
  return { id: 'attempt-one', sessionId: 'session-one', lessonId: 'en-starter-1', lessonVersion: 1,
    stage: 'express', contextId: 'en-starter-1:introduced', response: "Hi, I'm Jove.",
    prompted: false, mode: 'text', timestamp: now, ...patch }
}

function attemptEvent(value: StarterAttempt): StudyEvent {
  return { id: value.id, type: 'STARTER_ATTEMPT', timestamp: value.timestamp, sessionId: value.sessionId,
    source: value.mode === 'choice' ? 'objective' : 'text', prompted: value.prompted, contextId: value.contextId,
    data: { lessonId: value.lessonId, lessonVersion: value.lessonVersion, stage: value.stage, contextId: value.contextId,
      response: value.response, mode: value.mode, ...(value.audioId ? { audioId: value.audioId } : {}), acousticAssessed: false } }
}

function success(value: StarterAttempt): StudyEvent[] {
  return [attemptEvent(value), { id: `${value.id}:feedback`, type: 'STARTER_FEEDBACK', timestamp: value.timestamp,
    sessionId: value.sessionId, source: 'objective', prompted: value.prompted,
    data: { attemptId: value.id, lessonId: value.lessonId, lessonVersion: value.lessonVersion, verdict: 'valid',
      feedbackZh: '这个回答符合当前情境。', correction: '', nextAction: 'continue', evidence: value.response, acousticAssessed: false } }]
}

function aiOutput(response: string, patch: Partial<StarterFeedbackOutput> = {}): StarterFeedbackOutput {
  return { verdict: 'valid', feedbackZh: '这句话符合本课目标。', correction: null, nextAction: 'continue', evidence: response, ...patch }
}

function rawRecording(id: string, label: string): AudioAsset {
  return { id, blob: new Blob([label], { type: 'audio/wav' }), mimeType: 'audio/wav', createdAt: now,
    duration: 1, kind: 'recording', processed: false, label }
}

function conflictCopy(state: StarterState, response: string, id = `reading-conflict:${'a'.repeat(64)}`): StudySession {
  return {
    ...state.session, id, startedAt: now - 1000,
    draft: { ...state.draft, response, revision: 3, syncReadingConflicts: [id],
      syncRecovery: { sourceSessionId: state.session.id, rootSessionId: state.draft.syncRecovery?.rootSessionId ?? state.session.id,
        sourceDeviceId: 'fixture-device-b', sourceVersion: 'b'.repeat(64) } },
  }
}

describe('starter classroom deterministic evidence boundaries', () => {
  it('normalizes punctuation and apostrophes without treating unrelated keywords as the reference', () => {
    expect(normalizeStarterAnswer('  Hi, I’m Jove！ ', 'en')).toBe("hi, i'm jove")
    expect(normalizeStarterAnswer('おはよう　ございます。', 'ja')).toBe('おはようございます')
    const lesson = starterLesson('en-starter-3')!
    expect(localStarterFeedback(lesson, attempt({ lessonId: lesson.id, response: "I don't need water." })).verdict).toBe('uncertain')
    expect(localStarterFeedback(lesson, attempt({ lessonId: lesson.id, response: 'A water, please.' })).verdict).toBe('valid')
  })

  it.each([
    { mode: 'choice' as const, prompted: false, stage: 'express' as const },
    { mode: 'text' as const, prompted: true, stage: 'express' as const },
    { mode: 'text' as const, prompted: false, stage: 'recognize' as const },
    { mode: 'text' as const, prompted: false, stage: 'assemble' as const },
  ])('never promotes $stage / $mode / prompted=$prompted to independent use', patch => {
    const lesson = starterLesson('en-starter-1')!
    const first = attempt(patch), later = attempt({ ...patch, id: 'later', sessionId: 'session-two', contextId: lesson.transfer[0]!.id, timestamp: now + starterDelay })
    const result = starterGoalEvidence(lesson, [...success(first), ...success(later)], now + starterDelay)
    expect(result.independentUse).toBe(false)
    expect(result.retainedUse).toBe(false)
    expect(result.speakingVerified).toBe(false)
  })

  it('requires another session, a different context and at least a full 24 hours for retention', () => {
    const lesson = starterLesson('en-starter-1')!, first = attempt()
    const later = attempt({ id: 'later', sessionId: 'session-two', stage: 'transfer', contextId: lesson.transfer[0]!.id, timestamp: now + starterDelay })
    const evidence = (value: StarterAttempt, time = now + starterDelay) => starterGoalEvidence(lesson, [...success(first), ...success(value)], time)
    expect(starterDelay).toBe(86_400_000)
    expect(evidence({ ...later, timestamp: now + starterDelay - 1 }).retainedUse).toBe(false)
    expect(evidence({ ...later, contextId: first.contextId }).retainedUse).toBe(false)
    expect(evidence({ ...later, sessionId: first.sessionId }).retainedUse).toBe(false)
    expect(evidence({ ...later, prompted: true }).retainedUse).toBe(false)
    expect(evidence({ ...later, mode: 'choice' }).retainedUse).toBe(false)
    expect(evidence(later, now + starterDelay - 1).retainedUse).toBe(false)
    expect(evidence(later).retainedUse).toBe(true)
    expect(evidence(later).speakingVerified).toBe(false)
  })

  it('excludes other-language, other-version and disputed attempts, without dropping their originals', () => {
    const lesson = starterLesson('en-starter-1')!, first = attempt()
    const data = [
      ...success(first), ...success(attempt({ id: 'ja', lessonId: 'ja-starter-1', response: 'おはようございます。' })),
      ...success(attempt({ id: 'new-version', lessonVersion: 2 })),
      { id: 'dispute', type: 'STARTER_FEEDBACK_DISPUTED', source: 'self-report' as const, timestamp: now, data: { attemptId: first.id } },
    ]
    expect(starterGoalEvidence(lesson, data, now)).toMatchObject({ attempts: 1, independentUse: false, retainedUse: false })
    expect(starterAttemptFromEvent(data[0])!.response).toBe(first.response)
    expect(starterAttemptFromEvent({ ...data[0]!, type: 'STARTER_TRANSCRIPTION' })).toBeNull()
    const missing = { ...data[0]!, data: { ...data[0]!.data, audioId: 'preserved-reference', audioAvailable: false } }
    expect(starterAttemptFromEvent(missing)!.audioId).toBeUndefined()
    expect(missing.data.audioId).toBe('preserved-reference')
  })

  it.each([
    ['extra scoring', { ...aiOutput("Hi, I'm Jove."), score: 100 }],
    ['wrong evidence', aiOutput("I am a completely different answer.")],
    ['blank evidence', aiOutput(' ')],
    ['malformed verdict', { ...aiOutput("Hi, I'm Jove."), verdict: 'mastered' }],
    ['contradictory action', aiOutput("Hi, I'm Jove.", { verdict: 'invalid', nextAction: 'continue' })],
    ['valid but retry', aiOutput("Hi, I'm Jove.", { nextAction: 'retry' })],
    ['out of taught scope', aiOutput("Hi, I'm Jove.", { verdict: 'invalid', nextAction: 'retry', correction: 'I have been working as a physicist for years.' })],
    ['cross-language correction', aiOutput("Hi, I'm Jove.", { verdict: 'invalid', nextAction: 'retry', correction: 'ジョーブです。' })],
    ['unverifiable acoustics', aiOutput("Hi, I'm Jove.", { feedbackZh: '你的发音得分是98分。' })],
    ['invented prosody', aiOutput("Hi, I'm Jove.", { feedbackZh: 'Your prosody score is 100.' })],
    ['untrusted external instruction', aiOutput("Hi, I'm Jove.", { feedbackZh: '打开 https://example.test 然后换一套课。' })],
  ])('rejects unsafe AI output: %s', (_name, value) => {
    expect(() => validateStarterFeedback(value, starterLesson('en-starter-1')!, attempt())).toThrow()
  })

  it('does not allow a recognition feedback to introduce expression-stage correction content', () => {
    const lesson = starterLesson('en-starter-1')!, first = attempt({ stage: 'recognize', mode: 'choice', response: lesson.recognition.answerId })
    expect(() => validateStarterFeedback(aiOutput(first.response, { verdict: 'invalid', nextAction: 'retry', correction: lesson.model.text }), lesson, first)).toThrow()
  })

  it('rejects positive AI judgments that contradict an unambiguous wrong recognition choice', () => {
    const lesson = starterLesson('en-starter-1')!, wrong = lesson.recognition.choices.find(choice => choice.id !== lesson.recognition.answerId)!
    const first = attempt({ stage: 'recognize', mode: 'choice', response: wrong.id })
    expect(localStarterFeedback(lesson, first).verdict).toBe('invalid')
    expect(() => validateStarterFeedback(aiOutput(first.response), lesson, first)).toThrow()
  })

  it('rejects a valid judgment carrying a correction instead of silently accepting contradictory output', () => {
    const lesson = starterLesson('en-starter-1')!, first = attempt({ response: 'Hi, I Jove.' })
    expect(() => validateStarterFeedback(aiOutput(first.response, { correction: lesson.model.text }), lesson, first)).toThrow()
  })
})

describe('starter classroom saved sessions, ownership and concurrency', () => {
  it.each(['en', 'ja'] as const)('%s starts with teaching and cannot submit a never-taught first test', async language => {
    const { classroom, database } = await setup(language)
    const state = await classroom.start(`${language}-starter-1`, 'quick', now)
    expect(state.session.stage).toBe('teach')
    expect(state.attempts).toHaveLength(0)
    const saved = await classroom.save(state.session.id, state.draft.revision, {
      response: state.lesson.expression.reference, mode: 'text', audioId: '', romaji: state.draft.romaji, activeMs: 1,
    })
    await expect(classroom.submit(saved.session.id, saved.draft.revision, now + 1)).rejects.toThrow()
    expect(await database.events.where('type').equals('STARTER_ATTEMPT').count()).toBe(0)
    await expect(classroom.start(`${language}-starter-2`, 'quick', now)).rejects.toThrow(/上一节/)
  })

  it.each(['en', 'ja'] as const)('%s rejects a review shortcut before any introduction has been completed', async language => {
    const { classroom, database } = await setup(language)
    await expect(classroom.start(`${language}-starter-1`, 'quick', now, true)).rejects.toThrow()
    expect(await database.sessions.where('kind').equals('starter-classroom').count()).toBe(0)
  })

  it('continues a Japanese first-course entry with foundational teaching without a quiz or invented ability evidence', async () => {
    const { classroom, database, english } = await setup('ja')
    await database.profiles.update('main', { onboarded: false })
    const workspace = createJapaneseWorkspace(database, english)
    await workspace.open()
    const beforeSkills = await database.skills.toArray()
    const beforeEnglish = { skills: await english.skills.toArray(), assessments: await english.assessments.toArray(), events: await english.events.toArray() }
    expect(await database.assessments.count()).toBe(0)
    expect(await workspace.startingPoint(now)).toBeUndefined()
    expect(await workspace.today(now)).toBeNull()

    const state = await classroom.start('ja-starter-1', 'quick', now)
    expect(state.session.stage).toBe('teach')
    expect(state.attempts).toHaveLength(0)
    expect(await workspace.startingPoint(now + 1)).toEqual({
      basis: 'course-entry', confirmedAt: now, scriptCorrect: null, meaningCorrect: null,
      kanaSupport: true, furigana: 'full', conversationProbe: 1,
      listening: 'unknown', speaking: 'unknown', proficiency: 'unverified',
    })
    const entryEvents = await database.events.toArray()
    const plan = await workspace.today(now + 1)
    expect(plan?.tasks).toHaveLength(1)
    expect(plan?.tasks[0]).toMatchObject({ kind: 'learn', materialId: 'ja-kana-hiragana-1', minutes: 5, done: false })
    expect(plan?.tasks[0]?.reason).toContain('先教')
    expect(plan?.tasks[0]?.reason).toContain('不需要日语输入法')

    expect(await database.assessments.toArray()).toEqual([])
    expect(await database.skills.toArray()).toEqual(beforeSkills)
    expect(await database.events.toArray()).toEqual(entryEvents)
    expect(starterGoalEvidence(state.lesson, entryEvents, now + 1)).toMatchObject({ independentUse: false, retainedUse: false, speakingVerified: false })
    expect({ skills: await english.skills.toArray(), assessments: await english.assessments.toArray(), events: await english.events.toArray() }).toEqual(beforeEnglish)
  })

  it('preserves course-entry beginner scaffolding when assigning a Japanese application course', async () => {
    const { classroom, database, english } = await setup('ja')
    const workspace = createJapaneseWorkspace(database, english)
    await workspace.open()
    await classroom.start('ja-starter-1', 'quick', now)
    const unit = japaneseKana[0]!
    // Only the first kana group has been introduced, not all ten basic groups.
    await database.sessions.add({ id: 'course-entry-first-kana', kind: 'japanese-reading', materialId: unit.id,
      startedAt: now - 1000, completedAt: now, stage: 'completed',
      draft: { version: 1, revision: 0, taskId: 'course-entry-first-kana', minutes: 3, helped: true, seen: true,
        sourcePractice: 'heard', meaning: unit.questions.map(item => item.answer), kana: unit.words.map(item => item.reading),
        note: '只练过第一组。', effort: 'okay', lockedAt: now - 10, dueAt: now + starterDelay } })
    await database.events.add({ id: 'course-entry-earlier-input', type: 'EXTERNAL_LISTEN_REFLECTION', source: 'self-report',
      sessionId: 'course-entry-earlier-course', timestamp: now - starterDelay,
      data: { materialId: 'ja-irodori-starter-1', response: '还需要示范', expression: 'おはようございます。',
        example: 'おはようございます。', audioId: 'historical-input-recording', coursePhase: 'input', effort: 'hard',
        listened: true, playbackObserved: false, comprehensionVerified: false } })
    const beforeSkills = await database.skills.toArray()
    expect(await workspace.startingPoint(now + 1)).toMatchObject({ basis: 'course-entry', scriptCorrect: null, meaningCorrect: null })
    const plan = (await workspace.today(now + 1))!
    const task = plan.tasks.find(item => item.kind === 'listen' && item.materialId === 'ja-irodori-starter-1')!
    expect(task).toBeDefined()
    let session = await workspace.start(task.id, now + 2)
    const assignment = await database.events.get(`${session.id}:course-assignment`)
    expect(assignment?.data).toMatchObject({ coursePhase: 'application', beginnerScaffold: true })
    expect(await workspace.practiceGuide(session.id)).toMatchObject({ phase: 'application', independentFirst: false, firstAttemptSaved: false })
    await expect(workspace.lockIndependentAttempt(session.id, now + 3)).rejects.toThrow(/应用或延迟/)
    session = await workspace.save(session.id, { ...japanesePracticeDraft.parse(session.draft), response: '先借助示范练问候', listened: true }, 'notice')
    expect(session.stage).toBe('notice')
    expect(await database.events.get(`${session.id}:independent-attempt`)).toMatchObject({ prompted: true,
      data: { beginnerScaffold: true, masteryAssessed: false, acousticAssessed: false } })
    expect(await database.assessments.count()).toBe(0)
    expect(await database.skills.toArray()).toEqual(beforeSkills)
    expect(await database.events.get(assignment!.id)).toEqual(assignment)
  })

  it('keeps Japanese records and secret-free teaching content out of the English workspace', async () => {
    const { classroom, database, english } = await setup('ja')
    const fixtureSecret = 'fixture-private-value-not-an-api-key'
    await english.secrets.put({ id: 'fixture-only', value: fixtureSecret })
    const before = { sessions: await english.sessions.toArray(), events: await english.events.toArray(), materials: await english.materials.toArray() }
    const state = await classroom.start('ja-starter-1', 'quick', now)
    await expect(classroom.start('en-starter-1', 'quick', now)).rejects.toThrow(/当前语言/)
    expect(await english.sessions.toArray()).toEqual(before.sessions)
    expect(await english.events.toArray()).toEqual(before.events)
    expect(await english.materials.toArray()).toEqual(before.materials)
    expect((await database.materials.toArray()).map(material => material.language)).toEqual(['ja', 'ja', 'ja'])
    expect(starterMaterials('en').map(material => material.language)).toEqual(['en', 'en', 'en'])
    expect(JSON.stringify([state, await database.events.toArray(), await database.materials.toArray()])).not.toContain(fixtureSecret)
    expect(await database.secrets.count()).toBe(0)
  })

  it('does not advance from an earlier valid answer after an unsubmitted edit', async () => {
    const { classroom, database } = await setup()
    let state = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    state = await answer(classroom, state, state.lesson.expression.reference, 'text', now + 10)
    const first = await database.events.get(state.draft.lastAttemptId)
    state = await classroom.save(state.session.id, state.draft.revision, {
      response: 'Hi, I Jove.', mode: 'text', audioId: '', romaji: false, activeMs: 2000,
    })
    await expect(classroom.advance(state.session.id, state.draft.revision, now + 11)).rejects.toThrow(/已经改过/)
    expect((await database.sessions.get(state.session.id))?.draft.response).toBe('Hi, I Jove.')
    expect(await database.events.get(first!.id)).toEqual(first)
    expect(await database.events.where('type').equals('TASK_COMPLETED').count()).toBe(0)
    state = await classroom.submit(state.session.id, state.draft.revision, now + 12)
    expect(state.feedback?.verdict).toBe('invalid')
    await expect(classroom.advance(state.session.id, state.draft.revision, now + 13)).rejects.toThrow(/修正/)
    state = await answer(classroom, state, state.lesson.expression.reference, 'text', now + 14)
    state = await classroom.advance(state.session.id, state.draft.revision, now + 15)
    expect(state.session.stage).toBe('done')
    expect(await database.events.where('type').equals('TASK_COMPLETED').count()).toBe(1)
    expect(await database.events.get(first!.id)).toEqual(first)
  })

  it('requires a new submission when the practice mode or recording changes after a valid answer', async () => {
    const { classroom, database } = await setup()
    let state = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    state = await answer(classroom, state, state.lesson.expression.reference, 'text', now + 10)
    const recording = rawRecording('new-unsubmitted-recording', 'new original')
    await database.audio.add(recording)
    state = await classroom.save(state.session.id, state.draft.revision, {
      response: state.lesson.expression.reference, mode: 'audio-transcript', audioId: recording.id, romaji: false, activeMs: 2000,
    })
    await expect(classroom.advance(state.session.id, state.draft.revision, now + 11)).rejects.toThrow(/已经改过/)
    expect((await database.sessions.get(state.session.id))?.draft.audioId).toBe(recording.id)
    expect(await database.events.where('type').equals('TASK_COMPLETED').count()).toBe(0)
    state = await classroom.submit(state.session.id, state.draft.revision, now + 12)
    expect(state.attempts.find(attempt => attempt.id === state.draft.lastAttemptId)?.audioId).toBe(recording.id)
    expect((await classroom.advance(state.session.id, state.draft.revision, now + 13)).session.stage).toBe('done')
    expect((await database.audio.get(recording.id))?.blob.size).toBe(recording.blob.size)
  })

  it('preserves an original first attempt and a separate corrected retry across edits and reload', async () => {
    const { classroom, database, english } = await setup()
    let state = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    state = await answer(classroom, state, 'Hi, I Jove.', 'text')
    const original = await database.events.get(state.draft.lastAttemptId)
    expect(state.feedback).toMatchObject({ verdict: 'invalid', correction: "Hi, I'm Jove.", nextAction: 'retry' })
    state = await answer(classroom, state, "Hi, I'm Jove.", 'text', now + 11)
    expect(await database.events.get(original!.id)).toEqual(original)
    const responses = state.attempts.filter(item => item.stage === 'express').sort((a, b) => a.timestamp - b.timestamp).map(item => item.response)
    expect(responses).toEqual(['Hi, I Jove.', "Hi, I'm Jove."])
    const savedSession = await database.sessions.get(state.session.id)
    database.close()
    await database.open()
    const reopened = createStarterClassroom(database, english)
    await reopened.open()
    const resumed = await reopened.load(state.session.id)
    expect(resumed.session).toEqual(savedSession)
    expect(resumed.attempts).toEqual(state.attempts)
    expect(resumed.feedback!.verdict).toBe('valid')
  })

  it('keeps unknown natural alternatives pending and permits only explicit unverified continuation', async () => {
    const { classroom, database } = await setup()
    let state = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    const beforeSkills = await database.skills.toArray()
    state = await answer(classroom, state, 'Hello there! My name is Jove.', 'text')
    expect(state.feedback).toMatchObject({ verdict: 'uncertain', correction: null, nextAction: 'clarify' })
    const originalId = state.draft.lastAttemptId
    await expect(classroom.advance(state.session.id, state.draft.revision, now + 20)).rejects.toThrow(/待核对/)
    state = await classroom.advance(state.session.id, state.draft.revision, now + 21, true)
    expect(state.session.stage).toBe('done')
    expect((await database.events.get(originalId))!.data!.response).toBe('Hello there! My name is Jove.')
    expect(await database.events.where('type').equals('STARTER_UNVERIFIED_CONTINUED').count()).toBe(1)
    expect(starterGoalEvidence(state.lesson, await database.events.toArray(), now + 21).independentUse).toBe(false)
    expect(await database.skills.toArray()).toEqual(beforeSkills)
    expect(await database.cards.count()).toBe(0)
  })

  it('preserves two failed responses then supports the easier helped choice branch, with no independent gain', async () => {
    const { classroom, database } = await setup()
    let state = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    state = await answer(classroom, state, 'Hi, I Jove.', 'text')
    expect(state.draft.mode).toBe('text')
    expect(state.draft.response).toBe('Hi, I Jove.')
    await expect(classroom.advance(state.session.id, state.draft.revision, now + 12)).rejects.toThrow(/修正/)
    state = await answer(classroom, state, 'Hi, I is Jove.', 'text', now + 13)
    const failures = (await database.events.toArray()).filter(event => event.type === 'STARTER_FEEDBACK' && event.data!.verdict === 'invalid')
    expect(failures).toHaveLength(2)
    expect(state.session.stage).toBe('express')
    expect(state.draft).toMatchObject({ mode: 'choice', response: '', helped: true })
    expect(state.draft.helpCount).toBeGreaterThanOrEqual(2)
    expect(state.feedback!.verdict).toBe('invalid')
    const beforeAttempts = await database.events.where('type').equals('STARTER_ATTEMPT').count()
    await expect(classroom.submit(state.session.id, state.draft.revision, now + 13)).rejects.toThrow()
    expect(await database.events.where('type').equals('STARTER_ATTEMPT').count()).toBe(beforeAttempts)
    expect(await database.events.where('type').equals('TASK_COMPLETED').count()).toBe(0)
    const firstResponses = state.attempts.filter(item => item.stage === 'express').sort((a, b) => a.timestamp - b.timestamp).map(item => item.response)
    state = await classroom.help(state.session.id, state.draft.revision)
    state = await answer(classroom, state, state.lesson.expression.reference, 'choice', now + 14)
    expect(state.feedback!.verdict).toBe('valid')
    expect(state.attempts.find(item => item.id === state.draft.lastAttemptId)).toMatchObject({ prompted: true, mode: 'choice' })
    expect(state.attempts.filter(item => item.stage === 'express').sort((a, b) => a.timestamp - b.timestamp).slice(0, 2).map(item => item.response)).toEqual(firstResponses)
    expect(starterGoalEvidence(state.lesson, await database.events.toArray(), now + 14).independentUse).toBe(false)
  })

  it('automatically clears the second failed transfer into a helped choice without inventing a successful answer', async () => {
    const { classroom, database } = await setup()
    let state = await transfer(classroom, await classroom.start('en-starter-1', 'standard', now))
    state = await answer(classroom, state, 'Hi, I Jove.', 'text', now + 20)
    const first = state.attempts.find(item => item.id === state.draft.lastAttemptId)!
    expect(first.prompted).toBe(false)
    expect(state.feedback!.verdict).toBe('invalid')
    state = await answer(classroom, state, 'Hi, I is Jove.', 'text', now + 21)
    expect(state.draft).toMatchObject({ response: '', mode: 'choice', helped: true })
    expect(state.draft.helpCount).toBeGreaterThanOrEqual(2)
    const transferIds = state.attempts.filter(item => item.stage === 'transfer').map(item => item.id)
    expect(transferIds).toHaveLength(2)
    const feedbacks = (await database.events.toArray()).filter(event => event.type === 'STARTER_FEEDBACK'
      && transferIds.includes(String(event.data?.attemptId)))
    expect(feedbacks.map(event => event.data!.verdict)).toEqual(['invalid', 'invalid'])
    await expect(classroom.advance(state.session.id, state.draft.revision, now + 22)).rejects.toThrow()
    expect(await database.events.where('type').equals('TASK_COMPLETED').count()).toBe(0)
    expect(starterGoalEvidence(state.lesson, await database.events.toArray(), now + 22)).toMatchObject({ independentUse: false, retainedUse: false })
  })

  it.each(['en', 'ja'] as const)('%s reloads the raw ASR candidate without replacing an unsubmitted answer or creating evidence', async language => {
    const { classroom, database, english } = await setup(language)
    let state = await expression(classroom, await classroom.start(`${language}-starter-1`, 'quick', now))
    const audio = rawRecording(`raw-${language}`, 'unconfirmed original recording')
    await database.audio.add(audio)
    const typed = '用户尚未提交的文字，不允许识别结果自动替换'
    const raw = language === 'en' ? 'Hi, I Jove' : 'おはよございます'
    state = await classroom.save(state.session.id, state.draft.revision, {
      response: typed, mode: 'text', audioId: audio.id, romaji: state.draft.romaji, activeMs: 1000,
    })
    const attemptsBefore = await database.events.where('type').equals('STARTER_ATTEMPT').count()
    const eventId = await classroom.recordTranscription(state.session.id, audio.id, raw, now + 10)
    database.close(); await database.open()
    const reopened = createStarterClassroom(database, english)
    await reopened.open()
    let loaded = await reopened.load(state.session.id)
    expect(loaded.pendingTranscription).toBe(raw)
    expect(loaded.draft.response).toBe(typed)
    expect(loaded.draft.mode).toBe('text')
    expect((await database.events.get(eventId))!.data).toMatchObject({ rawText: raw, audioId: audio.id, acousticAssessed: false })
    expect(await database.events.where('type').equals('STARTER_ATTEMPT').count()).toBe(attemptsBefore)
    loaded = await reopened.save(loaded.session.id, loaded.draft.revision, {
      response: loaded.lesson.expression.reference, mode: 'audio-transcript', audioId: audio.id,
      romaji: loaded.draft.romaji, activeMs: 2000,
    })
    expect(loaded.pendingTranscription).toBeUndefined()
    expect((await database.events.get(eventId))!.data!.rawText).toBe(raw)
    expect(loaded.draft.response).toBe(loaded.lesson.expression.reference)
    expect(await database.events.where('type').equals('STARTER_ATTEMPT').count()).toBe(attemptsBefore)
  })

  it.each(['help', 'romaji', 'choice'] as const)('does not turn %s during transfer into independent performance', async support => {
    const { classroom, database } = await setup('ja')
    let state = await transfer(classroom, await classroom.start('ja-starter-1', 'standard', now))
    expect(state.session.stage).toBe('transfer')
    expect(state.draft.helped).toBe(false)
    expect(state.draft.romaji).toBe(false)
    if (support === 'help') state = await classroom.help(state.session.id, state.draft.revision)
    state = await classroom.save(state.session.id, state.draft.revision, {
      response: state.lesson.transfer[0]!.reference, mode: support === 'choice' ? 'choice' : 'text',
      audioId: '', romaji: support === 'romaji', activeMs: 10000,
    })
    state = await classroom.submit(state.session.id, state.draft.revision, now + 20)
    expect(state.attempts.find(item => item.id === state.draft.lastAttemptId)!.prompted).toBe(true)
    expect(starterGoalEvidence(state.lesson, await database.events.toArray(), now + 20)).toMatchObject({ independentUse: false, retainedUse: false, speakingVerified: false })
  })

  it('retains romanization exposure after the learner hides it again before submitting', async () => {
    const { classroom, database } = await setup('ja')
    let state = await transfer(classroom, await classroom.start('ja-starter-1', 'standard', now))
    state = await classroom.save(state.session.id, state.draft.revision, {
      response: '', mode: 'text', audioId: '', romaji: true, activeMs: 1000,
    })
    state = await classroom.save(state.session.id, state.draft.revision, {
      response: state.lesson.transfer[0]!.reference, mode: 'text', audioId: '', romaji: false, activeMs: 2000,
    })
    state = await classroom.submit(state.session.id, state.draft.revision, now + 20)
    expect(state.attempts.find(item => item.id === state.draft.lastAttemptId)!.prompted).toBe(true)
    expect(starterGoalEvidence(state.lesson, await database.events.toArray(), now + 20).independentUse).toBe(false)
  })

  it('offers a due different-context review only after 24 hours, with no early-start bypass', async () => {
    const { classroom, database } = await setup()
    const completed = await finishQuick(classroom, await classroom.start('en-starter-1', 'quick', now))
    const completedAt = completed.session.completedAt!
    expect(await classroom.next(completedAt + starterDelay - 1)).toMatchObject({ lesson: { id: 'en-starter-2' }, review: false })
    await expect(classroom.start(completed.lesson.id, 'quick', completedAt + starterDelay - 1, true)).rejects.toThrow()
    expect(await classroom.next(completedAt + starterDelay)).toMatchObject({ lesson: { id: completed.lesson.id }, review: true })
    const reviewed = await classroom.start(completed.lesson.id, 'quick', completedAt + starterDelay, true)
    expect(reviewed.session.stage).toBe('transfer')
    expect(reviewed.draft.contextId).not.toBe(completed.draft.contextId)
    expect(reviewed.draft.helped).toBe(false)
    expect(reviewed.draft.romaji).toBe(false)
    expect(nextStarterLesson('ja', await database.sessions.toArray(), await database.events.toArray(), completedAt + starterDelay)!.lesson.language).toBe('ja')
  })

  it('does not let a disputed success advance the course before a new or explicit unverified resolution', async () => {
    const { classroom, database } = await setup()
    let state = await transfer(classroom, await classroom.start('en-starter-1', 'standard', now))
    state = await answer(classroom, state, state.lesson.transfer[0]!.reference, 'text', now + 20)
    expect(starterGoalEvidence(state.lesson, await database.events.toArray(), now + 20).independentUse).toBe(true)
    const original = await database.events.get(state.draft.lastAttemptId)
    await classroom.dispute(state.draft.lastAttemptId, now + 21)
    await classroom.dispute(state.draft.lastAttemptId, now + 22)
    expect(await database.events.where('type').equals('STARTER_FEEDBACK_DISPUTED').count()).toBe(1)
    expect(starterGoalEvidence(state.lesson, await database.events.toArray(), now + 22).independentUse).toBe(false)
    await expect(classroom.advance(state.session.id, state.draft.revision, now + 23)).rejects.toThrow()
    expect((await classroom.load(state.session.id)).session.completedAt).toBeUndefined()
    expect(await database.events.get(original!.id)).toEqual(original)
  })

  it('saves valid AI feedback once, rejects invalid output atomically and keeps late feedback on its original stage', async () => {
    const { classroom, database } = await setup()
    let state = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    state = await answer(classroom, state, state.lesson.expression.reference, 'text')
    const attemptId = state.draft.lastAttemptId, original = await database.events.get(attemptId)
    const before = await database.events.count()
    await expect(classroom.saveAIFeedback(attemptId, aiOutput('not this answer'), 'fixture/editor', now + 20)).rejects.toThrow()
    expect(await database.events.count()).toBe(before)
    state = await classroom.saveAIFeedback(attemptId, aiOutput(state.lesson.expression.reference), 'fixture/editor', now + 21)
    await classroom.saveAIFeedback(attemptId, aiOutput(state.lesson.expression.reference), 'fixture/editor', now + 22)
    expect((await database.events.toArray()).filter(event => event.type === 'STARTER_FEEDBACK' && event.source === 'ai')).toHaveLength(1)
    expect(await database.events.get(attemptId)).toEqual(original)
    const done = await classroom.advance(state.session.id, state.draft.revision, now + 23)
    expect(done.session.completedAt).toBe(now + 23)
    const reloaded = await classroom.load(done.session.id)
    expect(reloaded.session.stage).toBe('done')
    expect(reloaded.draft.response).toBe('')
    expect(reloaded.attempts.find(item => item.id === attemptId)!.stage).toBe('express')
  })

  it('requires a first AI result, a saved dispute and a different known model before saving ai-v2', async () => {
    const { classroom, database } = await setup()
    let state = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    state = await answer(classroom, state, 'Hello there! My name is Jove.', 'text', now + 20)
    const id = state.draft.lastAttemptId, output = aiOutput(state.draft.response)
    let before = await database.events.count()
    await expect(classroom.saveAIFeedback(id, output, 'fixture/second', now + 21, true)).rejects.toThrow(/独立核对/)
    expect(await database.events.count()).toBe(before)
    await classroom.saveAIFeedback(id, output, 'fixture/first', now + 22)
    before = await database.events.count()
    await expect(classroom.saveAIFeedback(id, output, 'fixture/second', now + 23, true)).rejects.toThrow(/独立核对/)
    expect(await database.events.count()).toBe(before)
    await classroom.dispute(id, now + 24)
    before = await database.events.count()
    await expect(classroom.saveAIFeedback(id, output, undefined, now + 25, true)).rejects.toThrow(/独立核对/)
    await expect(classroom.saveAIFeedback(id, output, 'fixture/first', now + 25, true)).rejects.toThrow(/独立核对/)
    expect(await database.events.count()).toBe(before)
    expect(await database.events.get(`${id}:feedback:ai-v2`)).toBeUndefined()
    expect((await database.events.get(`${id}:feedback:ai-v1`))!.data).toMatchObject({ feedbackRevision: 1, model: 'fixture/first' })
  })

  it('an agreeing second-model review resolves a dispute without replacing the first result or counting duplicate reviews', async () => {
    const { classroom, database } = await setup()
    let state = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    state = await answer(classroom, state, 'Hello there! My name is Jove.', 'text', now + 20)
    const id = state.draft.lastAttemptId, original = await database.events.get(id), output = aiOutput(state.draft.response)
    state = await classroom.saveAIFeedback(id, output, 'fixture/first', now + 21)
    const first = await database.events.get(`${id}:feedback:ai-v1`)
    expect(state.feedback!.verdict).toBe('valid')
    state = await classroom.dispute(id, now + 22)
    expect(state.feedback!.verdict).toBe('uncertain')
    state = await classroom.saveAIFeedback(id, output, 'fixture/second', now + 23, true)
    expect(state.feedback).toMatchObject({ verdict: 'valid', source: 'ai', model: 'fixture/second' })
    const second = await database.events.get(`${id}:feedback:ai-v2`)
    expect(second!.data).toMatchObject({ feedbackRevision: 2, model: 'fixture/second', verdict: 'valid' })
    await classroom.saveAIFeedback(id, output, 'fixture/second', now + 24, true)
    expect(await database.events.get(`${id}:feedback:ai-v2`)).toEqual(second)
    expect(await database.events.get(`${id}:feedback:ai-v1`)).toEqual(first)
    expect(await database.events.get(id)).toEqual(original)
    expect(await database.events.get(`${id}:disputed`)).toBeDefined()
    expect((await database.events.toArray()).filter(event => event.type === 'STARTER_FEEDBACK'
      && event.source === 'ai' && event.data?.attemptId === id)).toHaveLength(2)
    state = await classroom.advance(state.session.id, state.draft.revision, now + 25)
    expect(state.session.stage).toBe('done')
    expect((await database.events.get(`${state.session.id}:completed`))!.data!.masteryAssessed).toBe(false)
  })

  it('an explicitly conflicting second-model review remains unknown and cannot earn independent progress', async () => {
    const { classroom, database } = await setup()
    let state = await transfer(classroom, await classroom.start('en-starter-1', 'standard', now))
    state = await answer(classroom, state, 'Hi there, my name is Jove.', 'text', now + 20)
    const id = state.draft.lastAttemptId, original = await database.events.get(id)
    expect(state.feedback!.verdict).toBe('uncertain')
    state = await classroom.saveAIFeedback(id, aiOutput(state.draft.response), 'fixture/first', now + 21)
    expect(starterGoalEvidence(state.lesson, await database.events.toArray(), now + 21).independentUse).toBe(true)
    await classroom.dispute(id, now + 22)
    state = await classroom.saveAIFeedback(id, aiOutput(state.draft.response, {
      verdict: 'invalid', nextAction: 'retry', correction: state.lesson.expression.reference, feedbackZh: '请重新核对这个表达。',
    }), 'fixture/second', now + 23, true)
    expect(state.feedback).toMatchObject({ verdict: 'uncertain', nextAction: 'clarify', correction: null })
    expect(starterGoalEvidence(state.lesson, await database.events.toArray(), now + 23)).toMatchObject({ independentUse: false, retainedUse: false })
    await expect(classroom.advance(state.session.id, state.draft.revision, now + 24)).rejects.toThrow(/待核对/)
    expect((await database.events.get(`${id}:feedback:ai-v1`))!.data!.verdict).toBe('valid')
    expect((await database.events.get(`${id}:feedback:ai-v2`))!.data!.verdict).toBe('invalid')
    expect(await database.events.get(id)).toEqual(original)
    expect(await database.events.where('type').equals('TASK_COMPLETED').count()).toBe(0)
  })

  it('rejects stale saves and uses compare-and-swap for concurrent writes without losing the winning text', async () => {
    const { classroom } = await setup()
    const state = await classroom.start('en-starter-1', 'quick', now)
    const patch = { mode: 'text' as const, audioId: '', romaji: false, activeMs: 1000 }
    const result = await Promise.allSettled([
      classroom.save(state.session.id, state.draft.revision, { ...patch, response: 'first device' }),
      classroom.save(state.session.id, state.draft.revision, { ...patch, response: 'second device' }),
    ])
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter(value => value.status === 'rejected')).toHaveLength(1)
    const winner = result.find(value => value.status === 'fulfilled')!
    if (winner.status !== 'fulfilled') throw new Error('Missing winning save')
    const restored = await classroom.load(state.session.id)
    expect(restored.draft.response).toBe(winner.value.draft.response)
    expect(restored.draft.revision).toBe(state.draft.revision + 1)
    await expect(classroom.save(state.session.id, state.draft.revision, { ...patch, response: 'stale overwrite' })).rejects.toThrow(/重新载入/)
    expect((await classroom.load(state.session.id)).draft.response).toBe(restored.draft.response)
  })

  it('makes sequential duplicate submission idempotent and concurrent duplicate submission commit at most once', async () => {
    const { classroom, database } = await setup()
    let state = await classroom.start('en-starter-1', 'quick', now)
    state = await classroom.advance(state.session.id, state.draft.revision, now + 1)
    state = await classroom.save(state.session.id, state.draft.revision, {
      response: state.lesson.recognition.answerId, mode: 'choice', audioId: '', romaji: false, activeMs: 1000,
    })
    const revision = state.draft.revision
    const concurrent = await Promise.allSettled([
      classroom.submit(state.session.id, revision, now + 2), classroom.submit(state.session.id, revision, now + 2),
    ])
    expect(concurrent.some(value => value.status === 'fulfilled')).toBe(true)
    expect(await database.events.where('type').equals('STARTER_ATTEMPT').count()).toBe(1)
    const original = await database.events.where('type').equals('STARTER_ATTEMPT').first()
    await classroom.submit(state.session.id, revision, now + 3)
    expect(await database.events.where('type').equals('STARTER_ATTEMPT').count()).toBe(1)
    expect(await database.events.get(original!.id)).toEqual(original)
  })

  it('starts only one session and one workload reservation for concurrent duplicate starts', async () => {
    const { classroom, database } = await setup()
    const states = await Promise.all([classroom.start('en-starter-1', 'quick', now), classroom.start('en-starter-1', 'quick', now)])
    expect(states[0]!.session.id).toBe(states[1]!.session.id)
    expect(await database.sessions.where('kind').equals('starter-classroom').count()).toBe(1)
    expect(await database.events.where('type').equals('TASK_STARTED').count()).toBe(1)
  })

  it('admits an explicit Japanese first lesson after English starts, without changing the English draft or shared total', async () => {
    const { classroom, english, japanese } = await setup()
    await english.profiles.update('main', { dailyMinutes: 45 })
    const en = await classroom.start('en-starter-1', 'quick', now)
    await classroom.save(en.session.id, en.draft.revision, {
      response: '尚未提交的英语回答', mode: 'text', audioId: '', romaji: false, activeMs: 1234,
    })
    const ja = createStarterClassroom(japanese, english)
    await ja.open()
    const before = { profile: await english.profiles.get('main'), sessions: await english.sessions.toArray(), events: await english.events.toArray() }
    expect((await japanese.profiles.get('main'))?.onboarded).toBe(false)
    expect(await ja.allowance(now)).toBe(0)

    const state = await ja.start('ja-starter-1', 'quick', now)
    expect(state.session.stage).toBe('teach')
    expect((await japanese.profiles.get('main'))?.onboarded).toBe(true)
    const day = await readLanguageDay(english, now, japanese)
    expect(day).toMatchObject({ totalMinutes: 45, credited: 0, allowances: { en: { reserved: 5 }, ja: { reserved: 5 } } })
    expect(day!.credited + day!.allowances.en.remaining + day!.allowances.ja.remaining).toBe(45)
    expect({ profile: await english.profiles.get('main'), sessions: await english.sessions.toArray(), events: await english.events.toArray() }).toEqual(before)
  })

  it('does not enable Japanese or reserve work when the shared budget is exhausted', async () => {
    const { classroom, english, japanese } = await setup()
    await english.profiles.update('main', { dailyMinutes: 15 })
    await classroom.start('en-starter-1', 'quick', now)
    await english.events.add({ id: 'earlier-en-completed', type: 'TASK_COMPLETED', source: 'objective', timestamp: now,
      data: { taskId: 'earlier-en-task', minutes: 10 } })
    const ja = createStarterClassroom(japanese, english)
    await ja.open()
    const before = { profile: await japanese.profiles.get('main'), sessions: await japanese.sessions.toArray(), events: await japanese.events.toArray() }
    await expect(ja.start('ja-starter-1', 'quick', now)).rejects.toThrow(/剩余安排不足/)
    expect({ profile: await japanese.profiles.get('main'), sessions: await japanese.sessions.toArray(), events: await japanese.events.toArray() }).toEqual(before)
    expect(await english.events.count()).toBe(2)
  })

  it.each([false, true])('does not let the old unstarted English plan swallow Japanese admission, with legacy started=%s', async started => {
    const { classroom, english, japanese } = await setup()
    await english.profiles.update('main', { dailyMinutes: 45 })
    const en = await classroom.start('en-starter-1', 'quick', now)
    const date = new Date(now).toLocaleDateString('en-CA')
    const plan: DailyPlan = { id: date, date, minutes: 40, focus: 'naturalListening', evidenceFingerprint: 'before-ja-entry', createdAt: now,
      tasks: [
        { id: 'legacy-input', kind: 'listen', title: '旧听力', reason: '原安排', minutes: 10, done: false },
        { id: 'legacy-later', kind: 'speak', title: '尚未开始', reason: '原安排', minutes: 30, done: false },
      ] }
    await english.plans.put(plan)
    if (started) await english.events.add({ id: 'legacy-input-start', type: 'TASK_STARTED', source: 'objective', timestamp: now,
      data: { taskId: 'legacy-input', kind: 'listen' } })
    const ja = createStarterClassroom(japanese, english)
    await ja.open()
    const original = { session: await english.sessions.get(en.session.id), events: await english.events.toArray() }
    const preview = await readLanguageDay(english, now, japanese, { admitJapanese: true })
    expect(preview?.allowances.en.reserved).toBe(started ? 15 : 5)
    expect(preview!.allowances.ja.remaining).toBeGreaterThanOrEqual(5)
    expect((await japanese.profiles.get('main'))?.onboarded).toBe(false)
    expect((await ja.start('ja-starter-1', 'quick', now)).session.stage).toBe('teach')
    const admitted = await readLanguageDay(english, now, japanese)
    expect(admitted?.allowances.en.reserved).toBe(started ? 15 : 5)
    expect(admitted?.allowances.ja.reserved).toBe(5)
    expect(admitted!.credited + admitted!.allowances.en.remaining + admitted!.allowances.ja.remaining).toBe(45)
    expect(await english.plans.get(date)).toEqual(plan)
    expect({ session: await english.sessions.get(en.session.id), events: await english.events.toArray() }).toEqual(original)
  })

  it('does not persist Japanese activation after a prerequisite or transaction failure', async () => {
    const { classroom, english, japanese } = await setup()
    await english.profiles.update('main', { dailyMinutes: 45 })
    await classroom.start('en-starter-1', 'quick', now)
    const ja = createStarterClassroom(japanese, english)
    await ja.open()
    const before = { profile: await japanese.profiles.get('main'), sessions: await japanese.sessions.toArray(), events: await japanese.events.toArray() }
    await expect(ja.start('ja-starter-2', 'quick', now)).rejects.toThrow(/上一节/)
    expect({ profile: await japanese.profiles.get('main'), sessions: await japanese.sessions.toArray(), events: await japanese.events.toArray() }).toEqual(before)
    vi.spyOn(japanese.events, 'add').mockRejectedValueOnce(new Error('simulated reservation write failure'))
    await expect(ja.start('ja-starter-1', 'quick', now)).rejects.toThrow('simulated reservation write failure')
    expect({ profile: await japanese.profiles.get('main'), sessions: await japanese.sessions.toArray(), events: await japanese.events.toArray() }).toEqual(before)
    const update = japanese.profiles.update.bind(japanese.profiles)
    vi.spyOn(japanese.profiles, 'update').mockImplementationOnce((key, changes) => update(key, changes).then(() => {
      throw new Error('simulated failure after activation write')
    }))
    await expect(ja.start('ja-starter-1', 'quick', now)).rejects.toThrow('simulated failure after activation write')
    expect({ profile: await japanese.profiles.get('main'), sessions: await japanese.sessions.toArray(), events: await japanese.events.toArray() }).toEqual(before)
    const recovered = await ja.start('ja-starter-1', 'quick', now)
    expect(recovered.session.stage).toBe('teach')
    expect(await japanese.events.where('type').equals('TASK_STARTED').count()).toBe(1)
  })

  it('deduplicates concurrent Japanese first admissions at the last five minutes without charging or enabling twice', async () => {
    const { classroom, english, japanese } = await setup()
    await english.profiles.update('main', { dailyMinutes: 10 })
    await classroom.start('en-starter-1', 'quick', now)
    const first = createStarterClassroom(japanese, english), second = createStarterClassroom(japanese, english)
    await first.open(); await second.open()
    const states = await Promise.all([first.start('ja-starter-1', 'quick', now), second.start('ja-starter-1', 'quick', now)])
    expect(states[0]!.session.id).toBe(states[1]!.session.id)
    expect(await japanese.sessions.where('kind').equals('starter-classroom').count()).toBe(1)
    expect(await japanese.events.where('type').equals('TASK_STARTED').count()).toBe(1)
    expect((await japanese.profiles.get('main'))?.onboarded).toBe(true)
    expect(await first.allowance(now)).toBe(0)
    expect((await first.start('ja-starter-1', 'quick', now)).session.id).toBe(states[0]!.session.id)
  })

  it.each(['en', 'ja'] as const)('keeps concurrent %s-first English/Japanese admissions within the shared budget', async firstLanguage => {
    // Use the real peer name so English discovers Japanese exactly as in production.
    const { classroom, english, japanese } = await setup('en', () => true, languageDatabases.ja)
    await english.profiles.update('main', { dailyMinutes: 15 })
    await finishQuick(classroom, await classroom.start('en-starter-1', 'quick', now))
    const original = { sessions: await english.sessions.toArray(), events: await english.events.toArray() }
    const ja = createStarterClassroom(japanese, english)
    await ja.open()
    const enStart = () => classroom.start('en-starter-2', 'standard', now + 100)
    const jaStart = () => ja.start('ja-starter-1', 'quick', now + 100)
    const results = await Promise.allSettled(firstLanguage === 'en' ? [enStart(), jaStart()] : [jaStart(), enStart()])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    // Inspect actual receipts, not the allocator's clipped over-budget reservations.
    const booked = (await Promise.all([english.events.toArray(), japanese.events.toArray()])).reduce((sum, events) => {
      const tasks = new Map(events.filter(event => ['TASK_STARTED', 'TASK_COMPLETED'].includes(event.type))
        .map(event => [String(event.data?.taskId), Number(event.data?.minutes)]))
      expect([...tasks.values()].every(Number.isFinite)).toBe(true)
      return sum + [...tasks.values()].reduce((total, minutes) => total + minutes, 0)
    }, 0)
    expect(booked).toBeLessThanOrEqual(15)
    for (const session of original.sessions) expect(await english.sessions.get(session.id)).toEqual(session)
    for (const event of original.events) expect(await english.events.get(event.id)).toEqual(event)
    expect((await japanese.profiles.get('main'))?.onboarded).toBe(results[firstLanguage === 'ja' ? 0 : 1]?.status === 'fulfilled')
  })

  it.each(['local-owner', 'shared-owner', 'active-context'] as const)('does not activate Japanese after the admission %s changes', async boundary => {
    const { classroom, english, japanese } = await setup()
    await classroom.start('en-starter-1', 'quick', now)
    let active = true
    const ja = createStarterClassroom(japanese, english, () => active)
    await ja.open()
    const before = { profile: await japanese.profiles.get('main'), sessions: await japanese.sessions.toArray(), events: await japanese.events.toArray() }
    let release!: () => void, acquired!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const requested = new Promise<void>(resolve => { acquired = resolve })
    const request = vi.fn(async (_name: string, _options: { mode: string }, admit: () => Promise<unknown>) => {
      acquired(); await held; return admit()
    })
    vi.stubGlobal('navigator', { locks: { request } })
    const pending = ja.start('ja-starter-1', 'quick', now)
    await requested
    expect((await japanese.profiles.get('main'))?.onboarded).toBe(false)
    if (boundary === 'active-context') active = false
    else await (boundary === 'local-owner' ? japanese : english).syncMeta.put({ id: 'owner', value: otherOwner })
    const rejected = expect(pending).rejects.toThrow(/账号|记录/)
    release()
    await rejected
    expect(request).toHaveBeenCalledWith(`jove-language-os:starter-budget:${english.name}`, { mode: 'exclusive' }, expect.any(Function))
    expect({ profile: await japanese.profiles.get('main'), sessions: await japanese.sessions.toArray(), events: await japanese.events.toArray() }).toEqual(before)
  })

  it('rejects Japanese admission previews without a matching explicit workspace, without activating either profile', async () => {
    const { english, japanese } = await setup()
    const before = { en: await english.profiles.get('main'), ja: await japanese.profiles.get('main') }
    await expect(readLanguageDay(english, now, undefined, { admitJapanese: true })).rejects.toThrow(/requires its own workspace/)
    await japanese.syncMeta.put({ id: 'owner', value: otherOwner })
    await expect(readLanguageDay(english, now, japanese, { admitJapanese: true })).rejects.toThrow(/account changed/)
    expect({ en: await english.profiles.get('main'), ja: await japanese.profiles.get('main') }).toEqual(before)
  })

  it('fails closed for new shared-store admissions without origin locks but preserves saved-course resumption', async () => {
    const english = new JoveDatabase(languageDatabases.en, 'en'), japanese = new JoveDatabase(languageDatabases.ja, 'ja')
    databases.push(english, japanese)
    await createLearningRepository(english).initialize(demoMaterials)
    await createLearningRepository(japanese).initialize([])
    for (const database of [english, japanese]) await database.syncMeta.put({ id: 'owner', value: owner })
    const ja = createStarterClassroom(japanese, english)
    await ja.open()
    const before = { profile: await japanese.profiles.get('main'), sessions: await japanese.sessions.toArray(), events: await japanese.events.toArray() }
    vi.stubGlobal('navigator', {})
    await expect(ja.start('ja-starter-1', 'quick', now)).rejects.toThrow(/协调两种语言/)
    expect({ profile: await japanese.profiles.get('main'), sessions: await japanese.sessions.toArray(), events: await japanese.events.toArray() }).toEqual(before)
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, admit: () => Promise<unknown>) => admit() } })
    const state = await ja.start('ja-starter-1', 'quick', now)
    const saved = await ja.save(state.session.id, state.draft.revision, { response: 'まだ下書き', mode: 'text', audioId: '', romaji: true, activeMs: 123 })
    const events = await japanese.events.toArray()
    vi.stubGlobal('navigator', {})
    expect((await ja.start('ja-starter-1', 'quick', now)).session).toEqual(saved.session)
    expect(await japanese.events.toArray()).toEqual(events)
  })

  it('preserves both raw recordings, raw transcription and separate edited first/retry answers', async () => {
    const { classroom, database } = await setup()
    let state = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    const firstAudio = rawRecording('starter-first-audio', 'unprocessed original first recording')
    const retryAudio = rawRecording('starter-retry-audio', 'unprocessed original retry recording')
    await database.audio.bulkAdd([firstAudio, retryAudio])
    state = await classroom.save(state.session.id, state.draft.revision, {
      response: 'Hi, I Jove.', mode: 'audio-transcript', audioId: firstAudio.id, romaji: false, activeMs: 2000,
    })
    const transcriptionId = await classroom.recordTranscription(state.session.id, firstAudio.id, 'Hi, I Jove', now + 8)
    state = await classroom.submit(state.session.id, state.draft.revision, now + 9)
    const firstAttempt = await database.events.get(state.draft.lastAttemptId)
    state = await classroom.save(state.session.id, state.draft.revision, {
      response: "Hi, I'm Jove.", mode: 'audio-transcript', audioId: retryAudio.id, romaji: false, activeMs: 3000,
    })
    await classroom.recordTranscription(state.session.id, retryAudio.id, "Hi, I'm Jove", now + 10)
    state = await classroom.submit(state.session.id, state.draft.revision, now + 11)
    expect(await database.events.get(firstAttempt!.id)).toEqual(firstAttempt)
    expect(firstAttempt!.data!.audioId).toBe(firstAudio.id)
    expect(state.attempts.filter(item => item.stage === 'express').sort((a, b) => a.timestamp - b.timestamp).map(item => item.audioId)).toEqual([firstAudio.id, retryAudio.id])
    expect(state.draft.audioIds).toEqual([firstAudio.id, retryAudio.id])
    expect((await database.events.get(transcriptionId))!.data).toMatchObject({ audioId: firstAudio.id, rawText: 'Hi, I Jove', acousticAssessed: false })
    for (const recording of [firstAudio, retryAudio]) {
      const saved = await database.audio.get(recording.id)
      expect(saved!.processed).toBe(false)
      expect(saved!.kind).toBe('recording')
      expect(saved!.blob.size).toBe(recording.blob.size)
    }
    expect(starterGoalEvidence(state.lesson, await database.events.toArray(), now + 11).speakingVerified).toBe(false)
    expect(await database.cards.count()).toBe(0)
    await expect(classroom.recordTranscription(state.session.id, 'foreign-audio', 'irrelevant', now + 12)).rejects.toThrow(/原录音/)
  })

  it.each(['en', 'ja'] as const)('preserves %s classroom and legacy work through the unchanged backup/restore contract', async (language) => {
    const { classroom, database, english } = await setup(language)
    await database.materials.add({ ...demoMaterials[0]!, id: 'legacy-source', language })
    const legacy: StudySession = { id: `legacy-${language}`, kind: 'listen', materialId: 'legacy-source',
      startedAt: now - 1000, stage: 'meaning', draft: { meaning: '旧回答不应被改写' } }
    await database.sessions.add(legacy)
    let state = await expression(classroom, await classroom.start(`${language}-starter-1`, 'quick', now))
    const recording = rawRecording(`backup-${language}-original`, 'immutable original')
    await database.audio.add(recording)
    state = await classroom.save(state.session.id, state.draft.revision, {
      response: state.lesson.expression.reference, mode: 'audio-transcript', audioId: recording.id, romaji: false, activeMs: 2000,
    })
    state = await classroom.submit(state.session.id, state.draft.revision, now + 9)
    const originalEvents = await database.events.toArray()
    const backup = await createLearningRepository(database).exportBackup()
    const envelope = JSON.parse(backup)
    expect(envelope.audioPolicy).toBe('blobs-omitted')
    expect(envelope.schemaVersion).toBe(language === 'ja' ? 3 : 2)
    expect(backup).not.toContain('"blob"')
    const restored = new JoveDatabase(`starter-restored-${language}-${crypto.randomUUID()}`, language)
    databases.push(restored)
    await createLearningRepository(restored).initialize([])
    await restored.syncMeta.put({ id: 'owner', value: owner })
    await createLearningRepository(restored).restoreBackup(backup)
    expect(await restored.sessions.get(legacy.id)).toEqual(legacy)
    const restoredClassroom = createStarterClassroom(restored, language === 'en' ? restored : english, () => true)
    await restoredClassroom.open()
    const resumed = await restoredClassroom.load(state.session.id)
    expect(resumed.session.stage).toBe(state.session.stage)
    expect(resumed.draft.response).toBe(state.draft.response)
    expect(resumed.draft.audioUnavailable).toBe(true)
    expect(resumed.draft.missingAudioIds).toContain(recording.id)
    expect(resumed.draft.audioId).toBe('')
    expect(resumed.attempts.map(attempt => attempt.id)).toEqual(state.attempts.map(attempt => attempt.id))
    expect((await restored.events.get(state.draft.lastAttemptId))?.data).toMatchObject({ response: state.draft.response, audioAvailable: false })
    expect(starterGoalEvidence(state.lesson, await restored.events.toArray(), now + 9).speakingVerified).toBe(false)
    expect(await database.events.toArray()).toEqual(originalEvents)
    expect((await database.audio.get(recording.id))?.blob.size).toBe(recording.blob.size)
    expect(await database.sessions.get(legacy.id)).toEqual(legacy)
    await createLearningRepository(restored).restoreBackup(await createLearningRepository(restored).exportBackup())
    expect((await restored.sessions.get(state.session.id))?.id).toBe(state.session.id)
    expect(await restored.events.where('type').equals('STARTER_ATTEMPT').count()).toBe(state.attempts.length)
  })

  it('does not submit audio without a locally saved original, or borrow another language recording', async () => {
    const { classroom, database, japanese } = await setup()
    let state = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    const foreign = rawRecording('foreign-ja-original', 'Japanese recording kept in Japanese space')
    await japanese.audio.add(foreign)
    await expect(classroom.save(state.session.id, state.draft.revision, {
      response: state.lesson.expression.reference, mode: 'audio-transcript', audioId: foreign.id, romaji: false, activeMs: 1,
    })).rejects.toThrow(/录音还未保存/)
    state = await classroom.save(state.session.id, state.draft.revision, {
      response: state.lesson.expression.reference, mode: 'audio-transcript', audioId: '', romaji: false, activeMs: 1,
    })
    const before = await database.events.count()
    await expect(classroom.submit(state.session.id, state.draft.revision, now + 20)).rejects.toThrow(/原录音/)
    expect(await database.events.count()).toBe(before)
    expect((await japanese.audio.get(foreign.id))!.processed).toBe(false)
  })

  it.each(['local-owner', 'shared-owner', 'active-context'] as const)('blocks writes after the %s changes and preserves the old draft', async boundary => {
    let active = true
    const { classroom, database, english } = await setup('ja', () => active)
    const state = await classroom.start('ja-starter-1', 'quick', now)
    const original = await database.sessions.get(state.session.id), events = await database.events.toArray()
    if (boundary === 'active-context') active = false
    else await (boundary === 'local-owner' ? database : english).syncMeta.put({ id: 'owner', value: otherOwner })
    await expect(classroom.save(state.session.id, state.draft.revision, {
      response: 'do not overwrite', mode: 'text', audioId: '', romaji: false, activeMs: 1,
    })).rejects.toThrow(/账号|记录/)
    await expect(classroom.load(state.session.id)).rejects.toThrow(/账号|记录/)
    expect(await database.sessions.get(state.session.id)).toEqual(original)
    expect(await database.events.toArray()).toEqual(events)
  })

  it('rejects opening a Japanese classroom bound to a different account, without seeding that space', async () => {
    const { database, english } = await setup('ja')
    const before = await database.materials.toArray()
    await database.syncMeta.put({ id: 'owner', value: otherOwner })
    const mismatch = createStarterClassroom(database, english)
    await expect(mismatch.open()).rejects.toThrow(/同一学习账号/)
    expect(await database.materials.toArray()).toEqual(before)
    expect(() => createStarterClassroom(english, database)).toThrow(/account workspace/)
  })

  it('validates saved draft revisions and preserves legacy sessions rather than adopting them as starter courses', async () => {
    const { classroom, database } = await setup()
    const old: StudySession = { id: 'legacy-listening', kind: 'listen', materialId: demoMaterials[0]!.id,
      startedAt: now - starterDelay, stage: 'listening', draft: { response: 'preserve this older English draft' } }
    await database.sessions.add(old)
    await expect(classroom.load(old.id)).rejects.toThrow(/原入口/)
    expect(await database.sessions.get(old.id)).toEqual(old)
    const state = await classroom.start('en-starter-1', 'quick', now)
    expect(() => starterDraftSchema.parse({ ...state.draft, revision: -1 })).toThrow()
    expect(() => starterDraftSchema.parse({ ...state.draft, secret: 'untrusted extra field' })).toThrow()
    await database.sessions.update(state.session.id, { draft: { ...state.draft, lessonVersion: 2 } })
    await expect(classroom.load(state.session.id)).rejects.toThrow(/课程已更新/)
  })
})

describe('starter classroom explicit conflict-copy recovery', () => {
  it('scopes unverified continuation to the current recovered session and reuses an existing continuation receipt', async () => {
    const { classroom, database } = await setup()
    let root = await expression(classroom, await classroom.start('en-starter-1', 'standard', now))
    root = await answer(classroom, root, 'Hello there! My name is Jove.', 'text', now + 10)
    expect(root.feedback!.verdict).toBe('uncertain')
    const originalAttempt = await database.events.get(root.draft.lastAttemptId)
    const beforeSkills = await database.skills.toArray()
    const copy = conflictCopy(root, root.draft.response)
    await database.sessions.add(copy)
    root = await classroom.advance(root.session.id, root.draft.revision, now + 11, true)
    expect(root.session.stage).toBe('transfer')
    const rootReceiptId = `${originalAttempt!.id}:continued-unverified:${root.session.id}`
    const rootReceipt = (await database.events.get(rootReceiptId))!
    expect(rootReceipt).toMatchObject({ type: 'STARTER_UNVERIFIED_CONTINUED', sessionId: root.session.id,
      data: { attemptId: originalAttempt!.id } })

    const recovered = await classroom.recover(copy.id, now + 12)
    expect(recovered.draft.lastAttemptId).toBe(originalAttempt!.id)
    await expect(classroom.advance(recovered.session.id, recovered.draft.revision, now + 13)).rejects.toThrow(/待核对/)
    const recoveredReceiptId = `${originalAttempt!.id}:continued-unverified:${recovered.session.id}`
    // Simulate a synced receipt arriving before the corresponding draft advance.
    const receivedReceipt = { ...rootReceipt, id: recoveredReceiptId, sessionId: recovered.session.id, timestamp: now + 14 }
    await database.events.add(receivedReceipt)
    const eventsBefore = await database.events.toArray()
    const continued = await classroom.advance(recovered.session.id, recovered.draft.revision, now + 15, true)
    expect(continued.session.stage).toBe('transfer')
    expect(await database.events.toArray()).toEqual(eventsBefore)
    expect(await database.events.get(rootReceiptId)).toEqual(rootReceipt)
    expect(await database.events.get(recoveredReceiptId)).toEqual(receivedReceipt)
    expect(await database.events.get(`${originalAttempt!.id}:continued-unverified`)).toBeUndefined()
    await expect(classroom.advance(recovered.session.id, recovered.draft.revision, now + 16, true)).rejects.toThrow(/更新/)
    expect(await database.events.where('type').equals('STARTER_UNVERIFIED_CONTINUED').count()).toBe(2)
    expect(await database.events.get(originalAttempt!.id)).toEqual(originalAttempt)
    expect(await database.sessions.get(copy.id)).toEqual(copy)
    expect(await database.skills.toArray()).toEqual(beforeSkills)
    expect(starterGoalEvidence(continued.lesson, await database.events.toArray(), now + 16)).toMatchObject({ independentUse: false, retainedUse: false, speakingVerified: false })
  })

  it.each(['en', 'ja'] as const)('%s preserves the conflict copy and original events, never silently selecting or editing the copy', async language => {
    const { classroom, database } = await setup(language)
    let state = await expression(classroom, await classroom.start(`${language}-starter-1`, 'quick', now))
    state = await answer(classroom, state, state.lesson.expression.errors[0]!.input, 'text', now + 10)
    const original = await database.sessions.get(state.session.id)
    const copy = conflictCopy(state, state.lesson.expression.reference)
    await database.sessions.add(copy)
    const priorEvents = await database.events.toArray()
    const selected = await classroom.next(now + 11)
    expect(selected!.session!.id).toBe(state.session.id)
    expect(selected!.session!.id).not.toBe(copy.id)
    expect((await classroom.start(state.lesson.id, 'quick', now + 11)).session.id).toBe(state.session.id)
    await expect(classroom.save(copy.id, 3, {
      response: 'do not replace conflict copy', mode: 'text', audioId: '', romaji: false, activeMs: 0,
    })).rejects.toThrow(/原件|回看|新草稿/)
    const recovered = await classroom.recover(copy.id, now + 12)
    expect(recovered.session.id).not.toBe(copy.id)
    expect(recovered.session.id).not.toBe(state.session.id)
    expect(recovered.draft.response).toBe(copy.draft.response)
    expect(recovered.draft.revision).toBe(0)
    expect(recovered.draft.workloadTaskId).toBe(state.session.id)
    expect(recovered.draft.syncReadingConflicts).toBeUndefined()
    expect(recovered.draft.syncRecovery).toEqual({ sourceSessionId: copy.id, rootSessionId: state.session.id,
      sourceDeviceId: 'fixture-device-b', sourceVersion: 'b'.repeat(64) })
    expect(await database.sessions.get(copy.id)).toEqual(copy)
    expect(await database.sessions.get(state.session.id)).toEqual(original)
    for (const event of priorEvents) expect(await database.events.get(event.id)).toEqual(event)
    const recoveryEvents = await database.events.where('type').equals('STARTER_BRANCH_RECOVERED').toArray()
    expect(recoveryEvents).toHaveLength(1)
    expect(recoveryEvents[0]!.data).toMatchObject({ sourceSessionId: copy.id, rootSessionId: state.session.id })
    expect(recovered.attempts.some(value => value.id === state.draft.lastAttemptId)).toBe(true)
    expect(await database.events.count()).toBe(priorEvents.length + 1)
  })

  it('loads attempts, effective feedback and raw ASR from an intermediate ancestor across three recoveries', async () => {
    const { classroom, database } = await setup()
    let root = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    root = await answer(classroom, root, 'Hi, I Jove.', 'text', now + 10)
    const copyOne = conflictCopy(root, 'Hello, I am Jove.')
    await database.sessions.add(copyOne)
    let first = await classroom.recover(copyOne.id, now + 11)
    first = await answer(classroom, first, 'Hello, I am Jove.', 'text', now + 12)
    const intermediateAttemptId = first.draft.lastAttemptId
    const audio = rawRecording('multi-hop-original-audio', 'original spoken response from the intermediate branch')
    await database.audio.add(audio)
    first = await classroom.save(first.session.id, first.draft.revision, {
      response: first.draft.response, mode: 'text', audioId: audio.id, romaji: false, activeMs: 3000,
    })
    const rawId = await classroom.recordTranscription(first.session.id, audio.id, 'Hello I am Jove', now + 13)
    const copyTwo = conflictCopy(first, first.draft.response, `reading-conflict:${'c'.repeat(64)}`)
    await database.sessions.add(copyTwo)
    const second = await classroom.recover(copyTwo.id, now + 14)
    const copyThree = conflictCopy(second, second.draft.response, `reading-conflict:${'d'.repeat(64)}`)
    await database.sessions.add(copyThree)
    const originalSessions = await database.sessions.toArray(), originalEvents = await database.events.toArray()
    const third = await classroom.recover(copyThree.id, now + 15)
    expect(third.draft.syncRecovery!.sourceSessionId).toBe(copyThree.id)
    expect(third.draft.syncRecovery!.rootSessionId).toBe(root.session.id)
    expect(first.session.id).not.toBe(root.session.id)
    expect(first.session.id).not.toBe(third.draft.syncRecovery!.sourceSessionId)
    expect(third.attempts.map(item => item.id)).toEqual(expect.arrayContaining([root.draft.lastAttemptId, intermediateAttemptId]))
    expect(third.attempts.find(item => item.id === intermediateAttemptId)).toMatchObject({ sessionId: first.session.id, response: 'Hello, I am Jove.' })
    expect(third.feedback!.verdict).toBe('valid')
    expect(third.pendingTranscription).toBe('Hello I am Jove')
    expect((await database.events.get(rawId))!.sessionId).toBe(first.session.id)
    for (const session of originalSessions) expect(await database.sessions.get(session.id)).toEqual(session)
    for (const event of originalEvents) expect(await database.events.get(event.id)).toEqual(event)
    expect(await database.events.count()).toBe(originalEvents.length + 1)
    expect(starterGoalEvidence(third.lesson, await database.events.toArray(), now + 15).speakingVerified).toBe(false)
  })

  it('advances a multi-hop Japanese recovery using an intermediate submitted answer without fabricating another attempt', async () => {
    const { classroom, database } = await setup('ja')
    let root = await expression(classroom, await classroom.start('ja-starter-1', 'quick', now))
    root = await answer(classroom, root, root.lesson.expression.errors[0]!.input, 'text', now + 10)
    const copyOne = conflictCopy(root, root.lesson.expression.reference)
    await database.sessions.add(copyOne)
    let first = await classroom.recover(copyOne.id, now + 11)
    first = await answer(classroom, first, first.lesson.expression.reference, 'text', now + 12)
    const intermediate = await database.events.get(first.draft.lastAttemptId)
    const copyTwo = conflictCopy(first, first.draft.response, `reading-conflict:${'c'.repeat(64)}`)
    await database.sessions.add(copyTwo)
    let second = await classroom.recover(copyTwo.id, now + 13)
    expect(second.draft.lastAttemptId).toBe(intermediate!.id)
    expect(second.feedback!.verdict).toBe('valid')
    const sourceSessions = await database.sessions.toArray(), attemptsBefore = await database.events.where('type').equals('STARTER_ATTEMPT').count()
    second = await classroom.advance(second.session.id, second.draft.revision, now + 14)
    expect(second.session.stage).toBe('done')
    expect(second.session.completedAt).toBe(now + 14)
    expect(await database.events.where('type').equals('STARTER_ATTEMPT').count()).toBe(attemptsBefore)
    expect(await database.events.get(intermediate!.id)).toEqual(intermediate)
    const completions = await database.events.where('type').equals('TASK_COMPLETED').toArray()
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ sessionId: second.session.id,
      data: { taskId: root.session.id, masteryAssessed: false, acousticAssessed: false } })
    for (const session of sourceSessions.filter(session => session.id !== second.session.id)) {
      expect(await database.sessions.get(session.id)).toEqual(session)
    }
  })

  it('does not select an isolated conflict copy as the automatic next task after the root finishes', async () => {
    const { classroom, database } = await setup()
    let state = await expression(classroom, await classroom.start('en-starter-1', 'quick', now))
    state = await answer(classroom, state, state.lesson.expression.reference, 'text', now + 8)
    const copy = conflictCopy(state, 'A preserved divergent answer')
    await database.sessions.add(copy)
    await classroom.advance(state.session.id, state.draft.revision, now + 9)
    const next = await classroom.next(now + 10)
    expect(next).toMatchObject({ lesson: { id: 'en-starter-2' }, review: false })
    expect(next!.session).toBeUndefined()
    expect(await database.sessions.get(copy.id)).toEqual(copy)
    expect(await database.events.where('type').equals('STARTER_BRANCH_RECOVERED').count()).toBe(0)
  })

  it.each(['en', 'ja'] as const)('%s reuses the same unfinished recovery even concurrently and never resets newer recovered edits', async language => {
    const { classroom, database } = await setup(language)
    const state = await expression(classroom, await classroom.start(`${language}-starter-1`, 'quick', now))
    const copy = conflictCopy(state, 'Preserved source branch')
    await database.sessions.add(copy)
    const [first, second] = await Promise.all([classroom.recover(copy.id, now + 10), classroom.recover(copy.id, now + 10)])
    expect(second.session.id).toBe(first.session.id)
    const edited = await classroom.save(first.session.id, first.draft.revision, {
      response: 'New unsent edit after explicit recovery', mode: 'text', audioId: '', romaji: false, activeMs: 1000,
    })
    const repeated = await classroom.recover(copy.id, now + 11)
    expect(repeated.session.id).toBe(first.session.id)
    expect(repeated.draft.response).toBe(edited.draft.response)
    expect(repeated.draft.revision).toBe(edited.draft.revision)
    expect(await database.sessions.where('kind').equals('starter-classroom').count()).toBe(3)
    expect(await database.events.where('type').equals('STARTER_BRANCH_RECOVERED').count()).toBe(1)
    expect(await database.events.where('type').equals('TASK_STARTED').count()).toBe(1)
    expect(await database.sessions.get(copy.id)).toEqual(copy)
  })

  it.each(['en', 'ja'] as const)('%s credits recovered completion to the root task without another workload charge', async language => {
    const { classroom, database } = await setup(language)
    let state = await expression(classroom, await classroom.start(`${language}-starter-1`, 'quick', now))
    state = await answer(classroom, state, state.lesson.expression.reference, 'text', now + 8)
    const copy = conflictCopy(state, state.lesson.expression.reference)
    await database.sessions.add(copy)
    const completed = await classroom.advance(state.session.id, state.draft.revision, now + 9)
    const rootAfter = await database.sessions.get(state.session.id)
    const remaining = await classroom.allowance(now + 10)
    let recovered = await classroom.recover(copy.id, now + 11)
    expect(await classroom.allowance(now + 11)).toBe(remaining)
    recovered = await answer(classroom, recovered, recovered.lesson.expression.reference, 'text', now + 12)
    recovered = await classroom.advance(recovered.session.id, recovered.draft.revision, now + 13)
    const completions = await database.events.where('type').equals('TASK_COMPLETED').toArray()
    expect(completions).toHaveLength(2)
    expect(new Set(completions.map(event => event.data!.taskId))).toEqual(new Set([completed.session.id]))
    expect(completions.find(event => event.sessionId === recovered.session.id)!.data).toMatchObject({ taskId: completed.session.id,
      minutes: completed.draft.minutes, masteryAssessed: false, acousticAssessed: false })
    expect(await classroom.allowance(now + 14)).toBe(remaining)
    expect(await database.events.where('type').equals('TASK_STARTED').count()).toBe(1)
    await expect(classroom.advance(recovered.session.id, recovered.draft.revision, now + 15)).rejects.toThrow()
    expect(await database.events.where('type').equals('TASK_COMPLETED').count()).toBe(2)
    expect(await database.sessions.get(state.session.id)).toEqual(rootAfter)
    expect(await database.sessions.get(copy.id)).toEqual(copy)
  })

  it.each(['local-owner', 'shared-owner', 'active-context'] as const)('blocks recovery after the %s changes without losing copy or event history', async boundary => {
    let active = true
    const { classroom, database, english } = await setup('ja', () => active)
    const state = await expression(classroom, await classroom.start('ja-starter-1', 'quick', now))
    const copy = conflictCopy(state, 'Do not recover under another owner')
    await database.sessions.add(copy)
    const sessions = await database.sessions.toArray(), events = await database.events.toArray()
    if (boundary === 'active-context') active = false
    else await (boundary === 'local-owner' ? database : english).syncMeta.put({ id: 'owner', value: otherOwner })
    await expect(classroom.recover(copy.id, now + 10)).rejects.toThrow(/账号|记录/)
    expect(await database.sessions.toArray()).toEqual(sessions)
    expect(await database.events.toArray()).toEqual(events)
  })

  it('admits the four-field recovery schema but rejects missing or extra recovery metadata', async () => {
    const { classroom } = await setup()
    const state = await classroom.start('en-starter-1', 'quick', now)
    const copy = conflictCopy(state, 'Preserved copy')
    const draft = starterDraftSchema.parse({ ...copy.draft, workloadTaskId: state.session.id })
    expect(draft.syncReadingConflicts).toEqual([copy.id])
    expect(Object.keys(draft.syncRecovery!).sort()).toEqual(['sourceSessionId', 'rootSessionId', 'sourceDeviceId', 'sourceVersion'].sort())
    expect(draft.workloadTaskId).toBe(state.session.id)
    const { sourceVersion: omitted, ...missing } = draft.syncRecovery!
    expect(omitted).toBe('b'.repeat(64))
    expect(() => starterDraftSchema.parse({ ...draft, syncRecovery: missing })).toThrow()
    expect(() => starterDraftSchema.parse({ ...draft, syncRecovery: { ...draft.syncRecovery, injected: 'untrusted' } })).toThrow()
    expect(() => starterDraftSchema.parse({ ...draft, syncReadingConflicts: 'not-an-array' })).toThrow()
  })
})
