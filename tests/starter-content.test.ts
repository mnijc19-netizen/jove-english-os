import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs'
import type { StarterFeedback } from '../src/ai/starter-schema'
import manifest from '../public/audio/starter/manifest.json'
import {
  nextStarterLesson, starterDelay, starterDemonstrationPath, starterDemonstrationTexts,
  starterGoalEvidence, type StarterAttempt,
} from '../src/domain/starter'
import type { StudyEvent, StudySession } from '../src/domain/types'
import {
  starterContentPolicy,
  starterFeedbackFixtures,
  starterLesson,
  starterLessons,
  type StarterLesson,
} from '../src/content/starter-courses'

const languageIds = (language: 'en' | 'ja') => [1, 2, 3].map(position => `${language}-starter-${position}`)
const hasChinese = (value: string) => /\p{Script=Han}/u.test(value)

const reviewEpoch = Date.UTC(2026, 9, 3, 12)
function probeEvents(lesson: StarterLesson, attempt: StarterAttempt, verdict: StarterFeedback['verdict'] = 'valid'): StudyEvent[] {
  return [
    { id: attempt.id, type: 'STARTER_ATTEMPT', timestamp: attempt.timestamp, sessionId: attempt.sessionId,
      source: attempt.mode === 'choice' ? 'objective' : 'text', prompted: attempt.prompted, contextId: attempt.contextId,
      data: { lessonId: attempt.lessonId, lessonVersion: attempt.lessonVersion, stage: attempt.stage,
        contextId: attempt.contextId, response: attempt.response, mode: attempt.mode, ...(attempt.audioId ? { audioId: attempt.audioId } : {}) } },
    { id: `${attempt.id}:feedback`, type: 'STARTER_FEEDBACK', timestamp: attempt.timestamp, sessionId: attempt.sessionId,
      source: 'objective', data: { attemptId: attempt.id, lessonId: lesson.id, lessonVersion: lesson.version,
        verdict, feedbackZh: '核对当前情境。', correction: '',
        nextAction: verdict === 'valid' ? 'continue' : verdict === 'uncertain' ? 'clarify' : 'retry', evidence: attempt.response } },
  ]
}
function retainedHistory(lesson: StarterLesson) {
  const context = lesson.transfer.find(item => item.id === 'ja-starter-3-reply') ?? lesson.transfer[0]!
  const attempts: StarterAttempt[] = [
    { id: `${lesson.id}:first`, sessionId: `${lesson.id}:lesson`, lessonId: lesson.id, lessonVersion: lesson.version,
      stage: 'express', contextId: `${lesson.id}:introduced`, response: lesson.expression.reference,
      prompted: false, mode: 'text', timestamp: reviewEpoch },
    { id: `${lesson.id}:later`, sessionId: `${lesson.id}:review`, lessonId: lesson.id, lessonVersion: lesson.version,
      stage: 'transfer', contextId: context.id, response: context.reference,
      prompted: false, mode: 'text', timestamp: reviewEpoch + starterDelay + 100 },
  ]
  const sessions: StudySession[] = attempts.map((attempt, index) => ({ id: attempt.sessionId, kind: 'starter-classroom',
    materialId: lesson.id, startedAt: attempt.timestamp, completedAt: attempt.timestamp + 1, stage: 'done',
    draft: { lessonVersion: lesson.version, purpose: index ? 'review' : 'lesson' } }))
  const events = attempts.flatMap(attempt => probeEvents(lesson, attempt))
  return { attempts, sessions, events }
}
function appendProbe(history: ReturnType<typeof retainedHistory>, lesson: StarterLesson, at: number,
  patch: Partial<StarterAttempt> = {}, verdict: StarterFeedback['verdict'] = 'valid') {
  const attempt: StarterAttempt = { id: `${lesson.id}:probe:${history.attempts.length}`, sessionId: `${lesson.id}:session:${history.attempts.length}`,
    lessonId: lesson.id, lessonVersion: lesson.version, timestamp: at, stage: 'transfer',
    contextId: lesson.transfer[1]!.id, response: lesson.transfer[1]!.reference, mode: 'text', prompted: false, ...patch }
  history.attempts.push(attempt)
  history.events.push(...probeEvents(lesson, attempt, verdict))
  const existing = history.sessions.find(session => session.id === attempt.sessionId)
  if (existing) existing.completedAt = Math.max(existing.completedAt!, at + 1)
  else history.sessions.push({ id: attempt.sessionId, kind: 'starter-classroom', materialId: lesson.id,
    startedAt: at, completedAt: at + 1, stage: 'done', draft: { lessonVersion: lesson.version, purpose: 'review' } })
  return attempt
}
const reviewScheduler = fsrs({ enable_fuzz: false, enable_short_term: false })
function replayCard(history: ReturnType<typeof retainedHistory>, ratings = history.attempts.map(() => Rating.Good)) {
  let card = createEmptyCard(new Date(history.attempts[0]!.timestamp))
  history.attempts.forEach((attempt, index) => { card = reviewScheduler.next(card, new Date(attempt.timestamp), ratings[index]! as Rating.Again | Rating.Good).card })
  return card
}
function expectReviewBoundary(lesson: StarterLesson, history: ReturnType<typeof retainedHistory>, due: number) {
  expect(nextStarterLesson(lesson.language, history.sessions, history.events, due - 1)?.review).not.toBe(true)
  expect(nextStarterLesson(lesson.language, history.sessions, history.events, due)).toMatchObject({ lesson: { id: lesson.id }, review: true })
}

describe('starter long-term retrieval scheduling', () => {
  it.each(['en', 'ja'] as const)('%s keeps all three historically retained goals in later review', language => {
    const histories = starterLessons.filter(lesson => lesson.language === language).map(retainedHistory)
    const sessions = histories.flatMap(history => history.sessions), events = histories.flatMap(history => history.events)
    const ninetyDaysLater = reviewEpoch + 90 * starterDelay
    for (const lesson of starterLessons.filter(lesson => lesson.language === language))
      expect(starterGoalEvidence(lesson, events, ninetyDaysLater).retainedUse).toBe(true)
    expect(nextStarterLesson(language, sessions, events, ninetyDaysLater)).toMatchObject({ review: true })
  })

  it.each(starterLessons.map(lesson => [lesson.id, lesson] as const))('%s uses deterministic FSRS due dates and extends after spaced independent success', (_id, lesson) => {
    const history = retainedHistory(lesson), initial = replayCard(history)
    expectReviewBoundary(lesson, history, initial.due.getTime())
    appendProbe(history, lesson, initial.due.getTime())
    const repeated = replayCard(history)
    expect(repeated.due.getTime() - history.attempts[2]!.timestamp).toBeGreaterThan(initial.due.getTime() - history.attempts[1]!.timestamp)
    expectReviewBoundary(lesson, history, repeated.due.getTime())
    const serialized = JSON.stringify({ sessions: history.sessions, events: history.events })
    expect(nextStarterLesson(lesson.language, history.sessions, history.events, repeated.due.getTime()))
      .toEqual(nextStarterLesson(lesson.language, [...history.sessions].reverse(), [...history.events].reverse(), repeated.due.getTime()))
    expect(JSON.stringify({ sessions: history.sessions, events: history.events })).toBe(serialized)
  })

  it.each(['invalid', 'partial'] as const)('shrinks review after an independent %s result without deleting historical retention', verdict => {
    const lesson = starterLesson('en-starter-1')!, history = retainedHistory(lesson), original = replayCard(history)
    const latest = appendProbe(history, lesson, original.due.getTime(), { response: 'Not the requested introduction.' }, verdict)
    const failed = replayCard(history, [Rating.Good, Rating.Good, Rating.Again])
    expect(failed.due.getTime() - latest.timestamp).toBeLessThan(original.due.getTime() - history.attempts[1]!.timestamp)
    expect(starterGoalEvidence(lesson, history.events, latest.timestamp + starterDelay).retainedUse).toBe(true)
    expectReviewBoundary(lesson, history, Math.max(failed.due.getTime(), latest.timestamp + 1 + starterDelay))
  })

  it.each(['prompted', 'choice', 'uncertain', 'disputed', 'opposing'] as const)('keeps a short verification interval for %s rather than scheduling it as independent success', kind => {
    const lesson = starterLesson('en-starter-1')!, history = retainedHistory(lesson)
    const at = history.attempts[1]!.timestamp + starterDelay + 100
    const latest = appendProbe(history, lesson, at, { prompted: kind === 'prompted', mode: kind === 'choice' ? 'choice' : 'text' }, kind === 'uncertain' ? 'uncertain' : 'valid')
    if (kind === 'disputed') history.events.push({ id: `${latest.id}:disputed`, type: 'STARTER_FEEDBACK_DISPUTED',
      source: 'self-report', sessionId: latest.sessionId, timestamp: at, data: { attemptId: latest.id, lessonId: lesson.id } })
    if (kind === 'opposing') history.events.push({ ...probeEvents(lesson, latest, 'invalid')[1]!, id: `${latest.id}:feedback:ai`, source: 'ai', timestamp: at + 1 })
    expect(starterGoalEvidence(lesson, history.events, at + starterDelay).retainedUse).toBe(true)
    expectReviewBoundary(lesson, history, at + 1 + starterDelay)
  })

  it('counts at most the first independent result in a session, never a corrected retry', () => {
    const lesson = starterLesson('en-starter-1')!, history = retainedHistory(lesson), oldDue = replayCard(history).due.getTime()
    const failed = appendProbe(history, lesson, oldDue, { response: 'Not an introduction.' }, 'invalid')
    const failedDue = replayCard(history, [Rating.Good, Rating.Good, Rating.Again]).due.getTime()
    appendProbe(history, lesson, oldDue + 100, { sessionId: failed.sessionId })
    expectReviewBoundary(lesson, history, Math.max(failedDue, oldDue + 101 + starterDelay))
  })

  it('does not count same-session successes twice or a same-context/under-24h probe as delayed transfer', () => {
    const lesson = starterLesson('en-starter-1')!, history = retainedHistory(lesson), oldDue = replayCard(history).due.getTime()
    const first = appendProbe(history, lesson, oldDue)
    const onceDue = replayCard(history).due.getTime()
    appendProbe(history, lesson, oldDue + 100, { sessionId: first.sessionId, contextId: lesson.transfer[2]!.id, response: lesson.transfer[2]!.reference })
    expectReviewBoundary(lesson, history, onceDue)
    appendProbe(history, lesson, oldDue + starterDelay + 100, { contextId: first.contextId })
    expectReviewBoundary(lesson, history, oldDue + 2 * starterDelay + 101)
    const tooSoon = retainedHistory(lesson)
    appendProbe(tooSoon, lesson, tooSoon.attempts[1]!.timestamp + starterDelay - 1)
    expectReviewBoundary(lesson, tooSoon, tooSoon.attempts[2]!.timestamp + 1 + starterDelay)
  })

  it.each(['prompted', 'choice', 'uncertain'] as const)('does not permanently drop an unverified goal completed through %s', kind => {
    const lesson = starterLesson('ja-starter-1')!, history = retainedHistory(lesson)
    history.attempts.forEach(attempt => { attempt.prompted = true; if (kind === 'choice') attempt.mode = 'choice' })
    history.events = history.attempts.flatMap(attempt => probeEvents(lesson, attempt, kind === 'uncertain' ? 'uncertain' : 'valid'))
    expect(starterGoalEvidence(lesson, history.events, reviewEpoch + 3 * starterDelay).retainedUse).toBe(false)
    expectReviewBoundary(lesson, history, history.sessions[1]!.completedAt! + starterDelay)
  })

  it.each(['version', 'context', 'source', 'feedback-evidence', 'feedback-session'] as const)('never credits an untrusted %s probe', kind => {
    const lesson = starterLesson('en-starter-1')!, history = retainedHistory(lesson), oldDue = replayCard(history).due.getTime()
    const latest = appendProbe(history, lesson, oldDue)
    const attempt = history.events.find(event => event.id === latest.id)!, feedback = history.events.find(event => event.id === `${latest.id}:feedback`)!
    if (kind === 'version') attempt.data!.lessonVersion = lesson.version + 1
    if (kind === 'context') attempt.data!.contextId = 'not-in-this-course'
    if (kind === 'source') attempt.source = 'self-report'
    if (kind === 'feedback-evidence') feedback.data!.evidence = 'not part of the answer'
    if (kind === 'feedback-session') feedback.sessionId = 'another-session'
    expectReviewBoundary(lesson, history, latest.timestamp + 1 + starterDelay)
  })

  it('preserves open-draft precedence and language isolation even when retained goals are due', () => {
    const lesson = starterLesson('en-starter-1')!, history = retainedHistory(lesson), now = reviewEpoch + 90 * starterDelay
    const draft: StudySession = { id: 'active-draft', kind: 'starter-classroom', materialId: lesson.id, startedAt: now - 100,
      stage: 'transfer', draft: { purpose: 'review', lessonVersion: lesson.version } }
    history.sessions.push(draft)
    expect(nextStarterLesson('en', history.sessions, history.events, now)).toMatchObject({ session: { id: draft.id }, review: true })
    expect(nextStarterLesson('ja', history.sessions, history.events, now)).toMatchObject({ lesson: { id: 'ja-starter-1' }, review: false })
  })
})

describe('original Chinese-native absolute-beginner starter content', () => {
  it('exports the exact six stable version-one lesson contracts and safe ID lookup', () => {
    const contract: readonly StarterLesson[] = starterLessons
    expect(contract).toHaveLength(6)
    expect(contract.map(lesson => lesson.id)).toEqual([...languageIds('en'), ...languageIds('ja')])
    expect(new Set(contract.map(lesson => lesson.id)).size).toBe(6)
    for (const lesson of contract) {
      expect(lesson.version).toBe(1)
      expect(starterLesson(lesson.id)).toBe(lesson)
      expect(Object.keys(lesson).sort()).toEqual([
        'id', 'language', 'version', 'position', 'titleZh', 'goalZh', 'prerequisites',
        'minutes', 'model', 'recognition', 'scaffold', 'expression', 'transfer', 'sound',
      ].sort())
      expect(lesson.minutes.quick).toBeGreaterThanOrEqual(3)
      expect(lesson.minutes.quick).toBeLessThanOrEqual(lesson.minutes.standard)
      expect(lesson.minutes.standard).toBeLessThanOrEqual(15)
      for (const value of [lesson.titleZh, lesson.goalZh, lesson.model.meaningZh, lesson.model.explanationZh]) {
        expect(value.length).toBeGreaterThan(0)
        expect(hasChinese(value)).toBe(true)
      }
    }
    expect(starterLesson('unknown')).toBeUndefined()
    expect(starterLesson('EN-starter-1')).toBeUndefined()
    expect(starterLesson('en-starter-4')).toBeUndefined()
    expect(starterLesson('ja-starter-4')).toBeUndefined()
  })

  it('keeps prerequisites taught earlier in the same language, with no script entry gate', () => {
    for (const language of ['en', 'ja'] as const) {
      const lessons = starterLessons.filter(lesson => lesson.language === language)
      expect(lessons.map(lesson => lesson.position)).toEqual([1, 2, 3])
      expect(lessons[0]!.prerequisites).toEqual([])
      expect(lessons[1]!.prerequisites).toEqual([lessons[0]!.id])
      expect(lessons[2]!.prerequisites).toEqual([lessons[1]!.id])
      for (const lesson of lessons) for (const prerequisiteId of lesson.prerequisites) {
        const prerequisite = starterLesson(prerequisiteId)
        expect(prerequisite).toBeDefined()
        expect(prerequisite!.language).toBe(language)
        expect(prerequisite!.position).toBeLessThan(lesson.position)
      }
    }
  })

  it.each(starterLessons.map(lesson => [lesson.id, lesson] as const))('%s teaches its small target before recognition and supported expression', (_id, lesson) => {
    expect(lesson.model.text.length).toBeLessThanOrEqual(40)
    expect(lesson.scaffold.answer).toBe(lesson.model.text)
    expect(lesson.expression.reference).toBe(lesson.model.text)
    expect(lesson.scaffold.pieces.join('').replace(/ /g, '')).toBe(lesson.model.text.replace(/ /g, ''))
    expect(lesson.scaffold.pieces.length).toBeGreaterThanOrEqual(2)
    expect(lesson.scaffold.pieces.length).toBeLessThanOrEqual(4)
    expect(lesson.recognition.choices.length).toBeGreaterThanOrEqual(2)
    expect(lesson.recognition.choices.length).toBeLessThanOrEqual(3)
    expect(new Set(lesson.recognition.choices.map(choice => choice.id)).size).toBe(lesson.recognition.choices.length)
    expect(lesson.recognition.choices.filter(choice => choice.id === lesson.recognition.answerId)).toHaveLength(1)
    for (const value of [
      lesson.recognition.promptZh, ...lesson.recognition.choices.map(choice => choice.textZh), lesson.recognition.explanationZh,
      lesson.scaffold.promptZh, lesson.scaffold.explanationZh, lesson.expression.promptZh,
    ]) expect(hasChinese(value)).toBe(true)
    expect(lesson.expression.accepted).toContain(lesson.expression.reference)
    expect(new Set(lesson.expression.accepted).size).toBe(lesson.expression.accepted.length)
    expect(lesson.expression.errors.length).toBeGreaterThanOrEqual(2)
    for (const error of lesson.expression.errors) {
      expect(error.input).not.toBe(error.corrected)
      expect(error.corrected).toBe(lesson.model.text)
      expect(hasChinese(error.feedbackZh)).toBe(true)
    }
  })

  it('provides three distinct contexts per lesson rather than one mandatory repeated script', () => {
    const ids: string[] = []
    for (const lesson of starterLessons) {
      expect(lesson.transfer.length).toBeGreaterThanOrEqual(3)
      expect(new Set(lesson.transfer.map(variant => variant.promptZh)).size).toBe(lesson.transfer.length)
      for (const variant of lesson.transfer) {
        ids.push(variant.id)
        expect(variant.id.startsWith(`${lesson.id}-`)).toBe(true)
        expect(hasChinese(variant.promptZh)).toBe(true)
        expect(hasChinese(variant.meaningZh)).toBe(true)
        expect(hasChinese(variant.explanationZh)).toBe(true)
        expect(Object.keys(variant).sort()).toEqual([
          'id', 'promptZh', 'reference', 'accepted', 'meaningZh', 'explanationZh',
          ...(lesson.language === 'ja' ? ['romaji'] : []),
        ].sort())
        if (lesson.language === 'ja') {
          expect(variant.romaji).toBeDefined()
          expect(variant.romaji).toMatch(/\p{Script=Latin}/u)
          expect(variant.romaji).not.toMatch(/[ぁ-んァ-ヶ]/u)
        } else expect(variant.romaji).toBeUndefined()
        expect(variant.accepted).toContain(variant.reference)
        expect(new Set(variant.accepted).size).toBe(variant.accepted.length)
      }
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives each English reference an accurate context-specific Chinese meaning', () => {
    const meanings: Record<string, string> = {
      'en-starter-1-group': '你好，我是 Jove。',
      'en-starter-1-online': '你好，我是 Jove。',
      'en-starter-1-partner': '我是 Jove。',
      'en-starter-2-station': '你是 Jove 吗？',
      'en-starter-2-team': '你是 Jove 吗？',
      'en-starter-2-call': '你好，你是 Jove 吗？',
      'en-starter-3-meal': '水，麻烦你。',
      'en-starter-3-work': '我需要水，麻烦你。',
      'en-starter-3-home': '我需要一点水，麻烦你。',
    }
    const contexts = starterLessons.filter(lesson => lesson.language === 'en').flatMap(lesson => lesson.transfer)
    expect(contexts).toHaveLength(Object.keys(meanings).length)
    for (const context of contexts) expect(context.meaningZh).toBe(meanings[context.id])
    const partner = starterLesson('en-starter-1')!.transfer.find(context => context.id.endsWith('-partner'))!
    expect(partner.meaningZh).not.toBe(starterLesson('en-starter-1')!.model.meaningZh)
    expect(partner.explanationZh).toContain('已经问好')
    const meal = starterLesson('en-starter-3')!.transfer.find(context => context.id.endsWith('-meal'))!
    expect(meal.explanationZh).toContain('不必补成完整句')
  })

  it('keeps Japanese temporary romanization and register aligned with the actual context reference', () => {
    const expected: Record<string, [string, string]> = {
      'ja-starter-1-desk': ['早上好。（礼貌）', 'ohayō gozaimasu'],
      'ja-starter-1-colleague': ['早上好。（礼貌）', 'ohayō gozaimasu'],
      'ja-starter-1-friend': ['早上好。（熟人之间的轻松说法）', 'ohayō'],
      'ja-starter-2-group': ['我是乔布。（礼貌的姓名介绍）', 'Jōbu desu'],
      'ja-starter-2-desk': ['我是乔布。（礼貌的姓名介绍）', 'Jōbu desu'],
      'ja-starter-2-call': ['我是乔布。（礼貌的姓名介绍）', 'Jōbu desu'],
      'ja-starter-3-shop': ['谢谢你。（礼貌）', 'arigatō gozaimasu'],
      'ja-starter-3-friend': ['谢谢。（熟人之间的轻松说法）', 'arigatō'],
      'ja-starter-3-reply': ['不用谢。', 'dō itashimashite'],
    }
    const contexts = starterLessons.filter(lesson => lesson.language === 'ja').flatMap(lesson => lesson.transfer)
    expect(contexts).toHaveLength(Object.keys(expected).length)
    for (const context of contexts) expect([context.meaningZh, context.romaji]).toEqual(expected[context.id])
    for (const id of ['ja-starter-1-friend', 'ja-starter-3-friend']) {
      const context = contexts.find(context => context.id === id)!
      expect(context.romaji).not.toContain('gozaimasu')
      expect(context.explanationZh).toContain('熟朋友')
    }
  })

  it('explains JA3 reply as answering another person’s thanks, never as the thank-you model', () => {
    const lesson = starterLesson('ja-starter-3')!
    const reply = lesson.transfer.find(context => context.id === 'ja-starter-3-reply')!
    expect(reply.reference).toBe('どういたしまして。')
    expect(reply.meaningZh).toBe('不用谢。')
    expect(reply.meaningZh).not.toBe(lesson.model.meaningZh)
    expect(reply.explanationZh).toContain('回答别人的道谢')
    expect(reply.explanationZh).toContain('不是向对方说谢谢')
    expect(reply.explanationZh).toContain('いえいえ')
    expect(reply.romaji).toBe('dō itashimashite')
    expect(reply.romaji).not.toBe(lesson.model.romaji)
  })

  it('accepts common English contractions and meaning-preserving alternatives', () => {
    expect(starterLesson('en-starter-1')!.expression.accepted).toEqual(expect.arrayContaining([
      "Hi, I'm Jove.", 'Hi, I am Jove.', 'Hi, my name is Jove.',
    ]))
    expect(starterLesson('en-starter-2')!.expression.accepted).toEqual(expect.arrayContaining([
      'Are you Jove?', "You're Jove, right?", 'Is your name Jove?',
    ]))
    expect(starterLesson('en-starter-3')!.expression.accepted).toEqual(expect.arrayContaining([
      "I'd like some water, please.", 'I would like some water, please.', 'Water, please.', 'A water, please.',
    ]))
  })

  it('teaches Japanese omissions, register and temporary romanization without requiring an input method', () => {
    for (const lesson of starterLessons.filter(value => value.language === 'ja')) {
      expect(lesson.model.reading).toBeDefined()
      expect(lesson.model.romaji).toBeDefined()
      expect(lesson.model.explanationZh).toMatch(/罗马字/)
      expect(lesson.scaffold.promptZh).toMatch(/点/)
      expect(lesson.model.explanationZh).toMatch(/不要求|不用/)
      expect(lesson.sound.notesZh).toMatch(/临时提示/)
    }
    const introduce = starterLesson('ja-starter-2')!
    expect(introduce.expression.accepted).toEqual(expect.arrayContaining(['ジョーブです。', '私はジョーブです。', 'わたしはジョーブです。']))
    expect(introduce.model.explanationZh).toMatch(/不必每次/)
    const morning = starterLesson('ja-starter-1')!
    expect(morning.model.explanationZh).toMatch(/熟朋友/)
    expect(morning.transfer.find(variant => variant.id.endsWith('-friend'))!.accepted).toContain('おはよう。')
    const thanks = starterLesson('ja-starter-3')!
    expect(thanks.model.explanationZh).toMatch(/どういたしまして/)
    expect(thanks.transfer.find(variant => variant.id.endsWith('-reply'))!.accepted).toContain('いえいえ。')
  })

  it('references only original supplemental synthetic assets, never copied or falsely approved audio', () => {
    for (const lesson of starterLessons) {
      expect(lesson.sound.status).toBe('pending-review')
      expect(lesson.sound.sourceLabel).toMatch(/原创合成语音：Windows System\.Speech/)
      expect(lesson.sound.sourceLabel).toContain(lesson.language === 'en' ? 'Microsoft Zira Desktop (en-US)' : 'Microsoft Haruka Desktop (ja-JP)')
      expect(lesson.sound.audioPath).toBe(`audio/starter/${lesson.id}.wav`)
      expect(lesson.sound.audioPath).not.toMatch(/^https?:|\.\.|[?#]/)
      expect(lesson.sound.sourceUrl).toBeUndefined()
      expect(lesson.sound.notesZh).toMatch(/不是真人|不是来自真人/)
      expect(lesson.sound.notesZh).toMatch(/试听核对/)
      expect(lesson.sound.notesZh).toMatch(/不能因文件存在/)
    }
    expect(starterContentPolicy.authorship).toBe('original')
    expect(starterContentPolicy.languageReview).toBe('pending-independent-review')
    expect(starterContentPolicy.providerAccuracy).toBe('not-measured')
  })

  it('matches fourteen ordered synthetic demonstration assets and their file/text hashes without claiming listening quality', () => {
    const expected = starterLessons.flatMap(lesson => {
      const texts = starterDemonstrationTexts(lesson)
      expect(texts).toEqual([...new Set([lesson.model.text, lesson.scaffold.answer, lesson.expression.reference, ...lesson.transfer.map(context => context.reference)])])
      return texts.map((text, index) => {
        const path = `audio/starter/${lesson.id}${index ? `-${index}` : ''}.wav`
        expect(starterDemonstrationPath(lesson, text)).toBe(path)
        if (index === 0) expect(lesson.sound.audioPath).toBe(path)
        return { lessonId: lesson.id, lessonVersion: lesson.version, language: lesson.language, text, path,
          voice: lesson.language === 'en' ? 'Microsoft Zira Desktop' : 'Microsoft Haruka Desktop' }
      })
    })
    expect(expected).toHaveLength(14)
    expect(manifest.assets).toHaveLength(14)
    expect(manifest.assets.map(({ lessonId, lessonVersion, language, text, path, voice }) => ({ lessonId, lessonVersion, language, text, path, voice }))).toEqual(expected)
    expect(new Set(manifest.assets.map(asset => asset.path)).size).toBe(14)
    expect(manifest).toMatchObject({ version: 1, generator: 'Windows System.Speech',
      rights: 'Original course examples; no copied publisher media',
      qualityClaim: 'Supplemental localized synthetic demonstration, not human speech or calibrated acoustic assessment' })
    const audioRoot = new URL('../public/audio/starter/', import.meta.url)
    expect(readdirSync(audioRoot).filter(name => name.endsWith('.wav')).sort()).toEqual(expected.map(asset => asset.path.replace('audio/starter/', '')).sort())
    for (const asset of manifest.assets) {
      expect(asset.path).toMatch(/^audio\/starter\/(en|ja)-starter-[1-3](?:-[1-2])?\.wav$/)
      expect(asset).toMatchObject({ synthetic: true, rate: 0, sampleRate: 22050, channels: 1, bitsPerSample: 16 })
      expect(starterLesson(asset.lessonId)!.sound.status).toBe('pending-review')
      const bytes = readFileSync(new URL(asset.path.replace('audio/starter/', ''), audioRoot))
      expect(bytes.byteLength).toBe(asset.byteLength)
      expect(bytes.byteLength).toBeGreaterThan(44)
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
      expect(bytes.toString('ascii', 8, 12)).toBe('WAVE')
      expect(bytes.readUInt32LE(4) + 8).toBe(bytes.byteLength)
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256)
      expect(asset.textSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(createHash('sha256').update(asset.text, 'utf8').digest('hex')).toBe(asset.textSha256)
    }
    // Hash/header integrity is not decoding, audible-text verification or a quality score.
  })

  it('provides exactly 100 deterministic, context-unique editorial evaluation fixtures, 50 per language', () => {
    expect(starterFeedbackFixtures).toHaveLength(100)
    expect(new Set(starterFeedbackFixtures.map(fixture => fixture.id)).size).toBe(100)
    expect(new Set(starterFeedbackFixtures.map(fixture => JSON.stringify([fixture.language, fixture.lessonId, fixture.promptZh, fixture.input]))).size).toBe(100)
    for (const language of ['en', 'ja'] as const) {
      const fixtures = starterFeedbackFixtures.filter(fixture => fixture.language === language)
      expect(fixtures).toHaveLength(50)
      expect(new Set(fixtures.map(fixture => fixture.lessonId)).size).toBe(3)
      for (const verdict of ['accept', 'repair', 'clarify']) expect(fixtures.some(fixture => fixture.expected === verdict)).toBe(true)
    }
    for (const fixture of starterFeedbackFixtures) {
      expect(starterLesson(fixture.lessonId)!.language).toBe(fixture.language)
      expect(hasChinese(fixture.promptZh)).toBe(true)
      expect(hasChinese(fixture.feedbackZh)).toBe(true)
      expect(fixture.input.trim().length).toBeGreaterThan(0)
      expect(fixture.id.startsWith(`${fixture.lessonId}-feedback-`)).toBe(true)
      if (fixture.expected === 'repair') {
        expect(fixture.corrected).toBeDefined()
        expect(fixture.corrected).not.toBe(fixture.input)
      } else expect(fixture.corrected).toBeUndefined()
    }
    // This checks the corpus, not an AI evaluator: no success-rate assertion here.
  })

  it('does not accept a negated keyword, a swapped person, or another task merely for containing the target', () => {
    for (const input of ["I don't need water.", 'Hi, you are Jove.', 'ジョーブではありません。', 'あなたはジョーブです。']) {
      expect(starterFeedbackFixtures.find(fixture => fixture.input === input)!.expected).toBe('clarify')
    }
    expect(starterFeedbackFixtures.find(fixture => fixture.input === "What's your name?")!.feedbackZh).toContain('语法没有错')
  })

  it('changes thank-you/reply judgments with context instead of treating Japanese phrases as universal keys', () => {
    for (const input of ['どういたしまして。', 'いえいえ。']) {
      const cases = starterFeedbackFixtures.filter(fixture => fixture.lessonId === 'ja-starter-3' && fixture.input === input)
      expect(cases).toHaveLength(2)
      expect(new Set(cases.map(fixture => fixture.promptZh)).size).toBe(2)
      expect(cases.map(fixture => fixture.expected).sort()).toEqual(['accept', 'clarify'])
    }
    expect(starterFeedbackFixtures.find(fixture => fixture.input === 'A water, please.')!.expected).toBe('accept')
  })

  it('keeps lesson packages and fixture expectations immutable at runtime', () => {
    expect(Object.isFrozen(starterLessons)).toBe(true)
    expect(Object.isFrozen(starterFeedbackFixtures)).toBe(true)
    for (const lesson of starterLessons) {
      expect(Object.isFrozen(lesson)).toBe(true)
      expect(Object.isFrozen(lesson.model)).toBe(true)
      expect(Object.isFrozen(lesson.expression.accepted)).toBe(true)
      expect(Object.isFrozen(lesson.transfer)).toBe(true)
      for (const context of lesson.transfer) expect(Object.isFrozen(context)).toBe(true)
      expect(Object.isFrozen(lesson.sound)).toBe(true)
    }
    for (const fixture of starterFeedbackFixtures) expect(Object.isFrozen(fixture)).toBe(true)
  })
})
