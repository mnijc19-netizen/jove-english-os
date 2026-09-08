import { describe, expect, it } from 'vitest'
import { createEmptyCard, State } from 'ts-fsrs'
import {
  analyzeLongitudinal, assessReadingFit, planLongitudinal, planRecovery, selectMeaningfulReviews,
  assessmentEvaluator, comparableObservation, hasTaskStarted, readingComparisonKey, readingRubric, selectReadingAssessment,
  type LongitudinalInput, type ReadingObservationData, type Strand,
} from '../src/domain/longitudinal'
import type { Material, Modality, Profile, ReviewCard, Skill, SkillName, StudyEvent } from '../src/domain/types'
import { aggregateSkills, evidenceWeight, makePlan } from '../src/domain/engine'
import { planSchema } from '../src/db/schema'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-08T12:00:00Z')
const profile: Profile = { id: 'main', name: 'Learner', goal: 'Real-world listening and speaking', interests: ['Technology'],
  dailyMinutes: 45, fatigue: 0, onboarded: true, createdAt: NOW - 100 * DAY }
const event = (id: string, timestamp = NOW, extra: Partial<StudyEvent> = {}): StudyEvent => ({
  id, timestamp, type: 'READING_EVALUATED', source: 'objective', skill: 'reading', score: 0.6, ...extra,
})
const practice = (id: string, timestamp: number, kind = 'listen'): StudyEvent => event(id, timestamp, {
  type: 'TASK_COMPLETED', skill: undefined, score: undefined, sessionId: id, data: { kind, taskId: id, minutes: 10 },
})
const card = (id: string, modality: Modality = 'recognition', extra: Partial<ReviewCard> = {}): ReviewCard => ({
  id, chunkId: id, modality, contextIds: [], card: createEmptyCard(NOW - 1), ...extra,
})
const studied = (id: string, stability = 3, elapsedDays = 10, modality: Modality = 'recognition'): ReviewCard => card(id, modality, {
  card: { ...createEmptyCard<ReviewCard['card']>(NOW - DAY), state: State.Review, reps: 3, stability, difficulty: 5, last_review: new Date(NOW - elapsedDays * DAY) },
})
const material = (id: string, difficulty = 0.35, topic = 'Technology', sentenceLength = 10): Material => {
  const sentence = Array.from({ length: sentenceLength }, (_, i) => i === 0 ? 'We' : 'read').join(' ') + '.'
  const sentences = Array.from({ length: 30 }, () => sentence)
  return { id, title: id, topic, difficulty, duration: 90, transcript: sentences.join(' '), sentences,
    sourceKind: 'curated', sourceLabel: 'Original test fixture', approved: true, synthetic: false,
    question: 'What was meaningful?', answer: 'Personal response', keywords: [], chunks: [], createdAt: NOW - 100 * DAY }
}
const skill = (id: SkillName, score = 0.6, extra: Partial<Skill> = {}): Skill => ({
  id, score, confidence: 0.6, evidenceCount: 10, updatedAt: NOW - DAY, ...extra,
})
const input = (extra: Partial<LongitudinalInput> = {}): LongitudinalInput => ({
  profile, skills: [], events: [], cards: [], materials: [material('easy')], now: NOW, ...extra,
})
/** Two distinct days in each trailing week, under one explicit comparison contract. */
function comparable(scores: readonly number[], target: SkillName = 'reading', extra: Partial<StudyEvent> = {}): StudyEvent[] {
  return scores.flatMap((score, week) => [1, 3].map(offset => {
    const id = `score-${target}-${week}-${offset}`
    return event(id, NOW - (28 - week * 7 - offset) * DAY, {
      sessionId: id, skill: target, score, prompted: false,
      data: { rubricVersion: 'stable-v1', comparisonKey: 'fresh-meaning-response', conditionsKey: 'no-help-quiet-untimed', difficulty: 0.35, firstPass: true, priorExposure: false },
      ...extra,
    })
  }))
}
const readingSample = (m: Material, index: number, data: Partial<ReadingObservationData> = {}): StudyEvent => ({
  id: `read-${m.id}-${index}`, type: 'READING_OBSERVATION', timestamp: NOW - (7 - index) * DAY,
  source: 'objective', sessionId: `session-${m.id}-${index}`, data: { materialId: m.id, firstPass: true, priorExposure: false,
    coverageMethod: 'checked-word-sample', sampledWordCount: 100, knownWordCount: 99, wordsRead: 200, activeSeconds: 100, lookupCount: 1, ...data },
})
const baselineMaterials = [material('r1'), material('r2'), material('r3')]
const baselineEvents = baselineMaterials.map((m, i) => readingSample(m, i))
const findTrend = (events: StudyEvent[], target: SkillName = 'reading', now = NOW) => analyzeLongitudinal(events, now).trends.find(t => t.skill === target)!
const dailyPractice = () => Array.from({ length: 29 }, (_, i) => practice(`daily-${i}`, NOW - i * DAY))
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeDeep(child)
  }
  return value
}

describe('interruption recovery with explicit deterministic time', () => {
  it('does not turn a new or idle profile into a fabricated interruption', () => {
    expect(planRecovery(profile, [], NOW)).toMatchObject({ mode: 'none', evidence: 'unknown', lastPracticeAt: null, interruptionDays: null, loadFactor: 1 })
    expect(planRecovery({ ...profile, createdAt: NOW + 100 * DAY }, [], NOW).mode).toBe('none')
  })
  it.each([
    [3 * DAY - 1, 'none', 1], [3 * DAY, 'restart-3', 0.8], [7 * DAY - 1, 'restart-3', 0.8],
    [7 * DAY, 'restart-7', 0.65], [14 * DAY - 1, 'restart-7', 0.65], [14 * DAY, 'restart-14', 0.5], [365 * DAY, 'restart-14', 0.5],
  ] as const)('handles an elapsed gap of %i ms', (gap, mode, loadFactor) => {
    expect(planRecovery(profile, [practice('last', NOW - gap)], NOW)).toMatchObject({ mode, loadFactor })
  })
  it('supports epoch zero as real evidence instead of treating it as absent', () => {
    expect(planRecovery(profile, [practice('epoch', 0)], 3 * DAY)).toMatchObject({ mode: 'restart-3', lastPracticeAt: 0 })
  })
  it('ignores navigation, disclosure, skipped and self-rated events as completed practice', () => {
    const old = practice('old', NOW - 14 * DAY)
    const nonPractice = ['TRANSCRIPT_REVEALED', 'TASK_OFFERED', 'TASK_SKIPPED', 'PAGE_OPENED'].map(type => event(type, NOW, { type, score: undefined }))
    expect(planRecovery(profile, [old, ...nonPractice, event('rating', NOW, { source: 'self-report' })], NOW).mode).toBe('restart-14')
  })
  it('a genuine failed response still counts as returning to practice, without granting skill', () => {
    expect(planRecovery(profile, [practice('old', NOW - 14 * DAY), event('failed', NOW, { score: 0 })], NOW)).toMatchObject({
      mode: 'restart-14', resumedAt: NOW, loadFactor: 0.5, restoredPracticeDays: 0,
    })
  })
  it.each([3, 7, 14])('restores a %i-day interruption over completed practice days, not one event burst', gap => {
    const old = practice('old', NOW - gap * DAY)
    const starting = planRecovery(profile, [old], NOW)
    const resumed = Array.from({ length: 20 }, (_, i) => practice(`burst-${i}`, NOW + i))
    expect(planRecovery(profile, [old, ...resumed], NOW + 21).loadFactor).toBe(starting.loadFactor)
    let previous = starting.loadFactor
    const active = [old, ...resumed]
    for (let d = 1; d <= starting.restorationDays; d++) {
      const next = planRecovery(profile, active, NOW + d * DAY)
      expect(next.loadFactor).toBeGreaterThan(previous)
      expect(next.minutes).toBeGreaterThanOrEqual(starting.minutes)
      previous = next.loadFactor
      active.push(practice(`return-${d}`, NOW + d * DAY))
    }
    expect(planRecovery(profile, active, NOW + starting.restorationDays * DAY).mode).toBe('none')
  })
  it('starts another recovery episode after a second interruption', () => {
    const resumed = practice('return', NOW)
    expect(planRecovery(profile, [practice('old', NOW - 14 * DAY), resumed], NOW + 7 * DAY)).toMatchObject({
      mode: 'restart-7', resumedAt: null, restoredPracticeDays: 0, loadFactor: 0.65,
    })
  })
  it.each(['2026-03-08T09:59:59Z', '2026-11-01T08:59:59Z', '2028-02-29T00:00:00Z', '2027-01-01T00:00:00+14:00'])('does not change elapsed thresholds at DST/year/leap boundaries: %s', iso => {
    const now = Date.parse(iso)
    expect(planRecovery(profile, [practice('last', now - 7 * DAY)], now).mode).toBe('restart-7')
    expect(planRecovery(profile, [practice('last', now - 7 * DAY + 1)], now).mode).toBe('restart-3')
  })
  it('uses UTC day boundaries for restoration independent of client locale', () => {
    const resume = Date.parse('2026-09-07T23:59:59Z')
    const events = [practice('old', resume - 14 * DAY), practice('return', resume)]
    expect(planRecovery(profile, events, resume).restoredPracticeDays).toBe(0)
    expect(planRecovery(profile, events, resume + 1000).restoredPracticeDays).toBe(1)
  })
  it('fatigue reduces recovery load and all requested budgets stay finite and bounded', () => {
    const events = [practice('old', NOW - 14 * DAY)]
    expect(planRecovery({ ...profile, fatigue: 1 }, events, NOW).minutes).toBeLessThan(planRecovery(profile, events, NOW).minutes)
    for (const dailyMinutes of [NaN, Infinity, -20, 0, 15, 45, 90, 150, 10000]) {
      const result = planRecovery({ ...profile, dailyMinutes }, events, NOW)
      expect(result.minutes).toBeGreaterThanOrEqual(10)
      expect(result.minutes).toBeLessThanOrEqual(180)
      expect(result.reviewBudgetSeconds).toBeLessThanOrEqual(result.minutes * 60 * 0.2)
    }
  })
})

describe('bounded meaningful review selection', () => {
  const options = { budgetSeconds: 180, maxCards: 6 }
  it('selects by decay, linked errors and productive importance with time/card caps', () => {
    const stale = studied('stale', 1, 40), stable = studied('stable', 100, 5)
    const productive = { ...studied('speech', 1, 40, 'speaking'), errorId: 'error' }
    const result = selectMeaningfulReviews([stable, stale, productive], [], NOW, options)
    expect(result.selectedIds[0]).toBe('speech')
    expect(result.selectedIds.indexOf('stale')).toBeLessThan(result.selectedIds.indexOf('stable'))
    expect(result.selected.find(c => c.cardId === 'stale')!.retrievability).toBeLessThan(result.selected.find(c => c.cardId === 'stable')!.retrievability!)
    expect(result.estimatedSeconds).toBeLessThanOrEqual(options.budgetSeconds)
    expect(result.selected.length).toBeLessThanOrEqual(options.maxCards)
  })
  it('only counts failures in the same chunk and modality, deduplicating a session burst', () => {
    const cards = [card('a'), card('b')]
    const failed = event('failure', NOW - DAY, { chunkId: 'b', modality: 'recognition', skill: 'chunkRecognition', score: 0.1, sessionId: 'attempt' })
    const result = selectMeaningfulReviews(cards, [failed], NOW, options)
    expect(result.selectedIds[0]).toBe('b')
    expect(selectMeaningfulReviews(cards, [failed, { ...failed, id: 'duplicate-score' }], NOW, options)).toEqual(result)
    expect(selectMeaningfulReviews(cards, [{ ...failed, modality: 'speaking', skill: 'chunkProduction' }], NOW, options).selectedIds).toEqual(['a', 'b'])
    expect(selectMeaningfulReviews(cards, [{ ...failed, source: 'self-report' }], NOW, options).selectedIds).toEqual(['a', 'b'])
  })
  it('does not treat an unreviewed card as measured memory decay or complete deferred cards', () => {
    const cards = Array.from({ length: 100 }, (_, i) => card(`c-${i}`))
    const snapshot = structuredClone(cards)
    const result = selectMeaningfulReviews(freezeDeep(cards), [], NOW, { budgetSeconds: 61, maxCards: 2 })
    expect(result.selected).toHaveLength(2)
    expect(result.deferredCount).toBe(98)
    expect(result.selected.every(c => c.retrievability === null)).toBe(true)
    expect(cards).toEqual(snapshot)
    expect(cards.every(c => c.card.reps === 0 && c.card.state === State.New)).toBe(true)
  })
  it('fits a cheaper item when a high-value spoken review cannot fit the remaining time', () => {
    const result = selectMeaningfulReviews([card('speech', 'speaking', { errorId: 'e' }), card('short')], [], NOW, { budgetSeconds: 25, maxCards: 3 })
    expect(result.selectedIds).toEqual(['short'])
    expect(result.estimatedSeconds).toBe(20)
    expect(result.deferredCount).toBe(1)
  })
  it('keeps at most two modalities per chunk and one per chunk/modality', () => {
    const cards = (['recognition', 'listening', 'recall', 'cloze', 'speaking', 'transfer'] as const).map((modality, i) => card(`c-${i}`, modality, { chunkId: 'same' }))
    cards.push(card('duplicate-modality', 'transfer', { chunkId: 'same' }))
    const result = selectMeaningfulReviews(cards, [], NOW, { budgetSeconds: 1800, maxCards: 50 })
    expect(result.selected).toHaveLength(2)
    expect(new Set(result.selected.map(c => c.modality)).size).toBe(2)
  })
  it('respects due timestamps at the exact millisecond', () => {
    const cards = [card('due', 'recognition', { card: createEmptyCard(NOW) }), card('future', 'recognition', { card: createEmptyCard(NOW + 1) })]
    expect(selectMeaningfulReviews(cards, [], NOW, options).selectedIds).toEqual(['due'])
  })
  it('accepts ISO FSRS dates after serialization and excludes malformed/skewed dates', () => {
    const good = studied('good')
    const serialized = JSON.parse(JSON.stringify(good)) as ReviewCard
    const invalid = { ...studied('invalid'), card: { ...good.card, due: new Date(NaN) } }
    const skewed = { ...studied('skewed'), card: { ...good.card, last_review: new Date(NOW + 1) } }
    expect(selectMeaningfulReviews([serialized, invalid, skewed], [], NOW, options)).toMatchObject({ selectedIds: ['good'], excludedCardIds: ['invalid', 'skewed'] })
    expect(selectMeaningfulReviews([serialized], [], NOW, options)).toEqual(selectMeaningfulReviews([good], [], NOW, options))
  })
  it('marks unsupported decay as unknown and never produces non-finite priorities', () => {
    const c = studied('broken-stability'); c.card.stability = NaN
    const result = selectMeaningfulReviews([c], [], NOW, options)
    expect(result.selected[0].retrievability).toBeNull()
    expect(Number.isFinite(result.selected[0].priority)).toBe(true)
  })
  it('excludes cards due before their own last review and invalid repetition counts', () => {
    const beforeLast = studied('before-last'); beforeLast.card.due = new Date(NOW - 20 * DAY)
    const fractional = studied('fractional'); fractional.card.reps = 1.5
    expect(selectMeaningfulReviews([beforeLast, fractional], [], NOW, options)).toMatchObject({ selectedIds: [], excludedCardIds: ['before-last', 'fractional'] })
  })
  it('deduplicates identical cards and excludes conflicting snapshots deterministically', () => {
    const a = card('same'), b = { ...a, modality: 'speaking' as const }
    expect(selectMeaningfulReviews([a, a], [], NOW, options).dueCount).toBe(1)
    const conflict = selectMeaningfulReviews([a, b], [], NOW, options)
    expect(conflict.excludedCardIds).toEqual(['same'])
    expect(conflict.dueCount).toBe(0)
    expect(selectMeaningfulReviews([b, a], [], NOW, options)).toEqual(conflict)
  })
  it.each([0, -1, NaN, Infinity])('returns no selection for invalid/zero time budget %s', budgetSeconds => {
    expect(selectMeaningfulReviews([card('a')], [], NOW, { budgetSeconds, maxCards: 5 }).selectedIds).toEqual([])
  })
  it('is deterministic under input reordering and ties', () => {
    const cards = [card('z'), card('a'), card('m')]
    expect(selectMeaningfulReviews(cards, [], NOW, options)).toEqual(selectMeaningfulReviews([...cards].reverse(), [], NOW, options))
  })
})

describe('four-week comparable performance', () => {
  it('keeps all skills unknown without evidence and never mistakes completion for mastery', () => {
    expect(analyzeLongitudinal([], NOW).trends.every(t => t.status === 'unknown')).toBe(true)
    const events = comparable([0.6, 0.6, 0.6, 0.6]).map(e => ({ ...e, type: 'TASK_COMPLETED', skill: undefined, score: undefined }))
    expect(findTrend(events).status).toBe('unknown')
  })
  it.each(['TASK_COMPLETED', 'TASK_OFFERED', 'TASK_SKIPPED', 'PRACTICE_LOGGED', 'READING_OBSERVATION', 'TRANSCRIPT_REVEALED'])('never treats %s telemetry as a skill score even with accidental score tags', type => {
    expect(findTrend(comparable([0.6, 0.6, 0.6, 0.6], 'reading', { type })).status).toBe('unknown')
  })
  it.each([
    [[0.6, 0.61, 0.6, 0.61], 'plateau'], [[0.8, 0.8, 0.65, 0.64], 'regression'],
    [[0.5, 0.5, 0.62, 0.63], 'improving'], [[0.95, 0.95, 0.95, 0.95], 'maintaining'],
    [[0.8, 0.7, 0.4, 0.8], 'variable'],
  ] as const)('classifies %j as %s only with comparable observations', (scores, status) => {
    const result = findTrend(comparable(scores))
    expect(result.status).toBe(status)
    expect(result.comparableDays).toBe(8)
    expect(result.weekly.map(w => w.days)).toEqual([2, 2, 2, 2])
  })
  it('requires all four weeks, two distinct days each and distinct sessions', () => {
    const full = comparable([0.6, 0.6, 0.6, 0.6])
    expect(findTrend(full.slice(1)).status).toBe('unknown')
    expect(findTrend(full.slice(2)).status).toBe('unknown')
    expect(findTrend(full.map(e => ({ ...e, sessionId: 'same-session' }))).status).toBe('unknown')
    expect(findTrend(full.map((e, i) => ({ ...e, timestamp: full[Math.floor(i / 2) * 2].timestamp }))).status).toBe('unknown')
  })
  it.each(['rubricVersion', 'comparisonKey', 'conditionsKey', 'difficulty', 'firstPass', 'priorExposure'])('does not invent missing %s conditions', key => {
    const events = comparable([0.6, 0.6, 0.6, 0.6]).map(e => {
      const data = { ...e.data }; delete data[key]; return { ...e, data }
    })
    expect(findTrend(events).status).toBe('unknown')
  })
  it.each(['rubricVersion', 'comparisonKey', 'conditionsKey', 'difficulty'])('does not pool changed %s across weeks', key => {
    const events = comparable([0.8, 0.8, 0.5, 0.5]).map((e, i) => i < 4 ? e : ({ ...e, data: { ...e.data, [key]: key === 'difficulty' ? 0.5 : 'changed' } }))
    expect(findTrend(events).status).toBe('unknown')
  })
  it('does not pool sources, modalities, hints or prior exposure', () => {
    const full = comparable([0.6, 0.6, 0.6, 0.6])
    for (const patch of [{ source: 'ai' as const }, { modality: 'recognition' as const }, { prompted: true }, { prompted: undefined }]) {
      expect(findTrend(full.map((e, i) => i < 4 ? e : { ...e, ...patch })).status).toBe('unknown')
    }
    expect(findTrend(full.map(e => ({ ...e, data: { ...e.data, priorExposure: true } }))).status).toBe('unknown')
  })
  it('keeps self-report, transcript-only speaking and AI acoustic claims unknown', () => {
    expect(findTrend(comparable([0.6, 0.6, 0.6, 0.6], 'reading', { source: 'self-report' })).status).toBe('unknown')
    for (const target of ['speakingFluency', 'pronunciation', 'prosody'] as const) {
      expect(findTrend(comparable([0.6, 0.6, 0.6, 0.6], target, { source: 'ai' }), target).status).toBe('unknown')
      expect(findTrend(comparable([0.6, 0.6, 0.6, 0.6], target, { source: 'acoustic' }), target).status).toBe('plateau')
    }
    expect(findTrend(comparable([0.6, 0.6, 0.6, 0.6], 'chunkProduction', { source: 'text' }), 'chunkProduction').status).toBe('unknown')
  })
  it('requires saved and verified speech for AI production evidence and novel contexts for transfer', () => {
    const base = comparable([0.7, 0.7, 0.7, 0.7], 'chunkProduction', { source: 'ai' })
    expect(findTrend(base, 'chunkProduction').status).toBe('unknown')
    const verified = base.map(e => ({ ...e, data: { ...e.data, audioObserved: true, transcriptVerified: true } }))
    expect(findTrend(verified, 'chunkProduction').status).toBe('plateau')
    const transfer = comparable([0.7, 0.7, 0.7, 0.7], 'realWorld')
    expect(findTrend(transfer, 'realWorld').status).toBe('unknown')
    expect(findTrend(transfer.map(e => ({ ...e, contextId: e.id, data: { ...e.data, novelContext: true } })), 'realWorld').status).toBe('plateau')
  })
  it('rejects invalid scores, noisy flat averages and one-off regression', () => {
    const base = comparable([0.6, 0.6, 0.6, 0.6])
    for (const score of [NaN, Infinity, -0.1, 1.1]) expect(findTrend(base.map(e => ({ ...e, score }))).status).toBe('unknown')
    expect(findTrend(base.map((e, i) => ({ ...e, score: i % 2 ? 0.8 : 0.4 }))).status).toBe('variable')
    expect(findTrend(comparable([0.8, 0.8, 0.8, 0.2])).status).toBe('variable')
  })
  it('uses rolling-window endpoints inclusively but never future data', () => {
    const events = comparable([0.6, 0.6, 0.6, 0.6])
    events[0] = { ...events[0], timestamp: NOW - 28 * DAY }
    events[7] = { ...events[7], timestamp: NOW }
    expect(findTrend(events).status).toBe('plateau')
    expect(findTrend([{ ...events[0], timestamp: NOW - 28 * DAY - 1 }, ...events.slice(1)]).status).toBe('unknown')
    expect(findTrend([...events.slice(0, 7), { ...events[7], timestamp: NOW + 1 }]).status).toBe('unknown')
  })
})

function offers(kind: 'speak' | 'listen' | 'reading', outcome: 'completed' | 'too-hard' | 'busy' | 'open'): StudyEvent[] {
  return comparable([0.6, 0.6, 0.6, 0.6]).flatMap((e, i) => {
    const base = event(`offer-${kind}-${i}`, e.timestamp, { type: 'TASK_OFFERED', score: undefined, skill: undefined, data: { kind, taskId: `task-${kind}-${i}` } })
    return outcome === 'open' ? [base] : [base, { ...base, id: `outcome-${kind}-${i}`, timestamp: base.timestamp + 1000,
      type: outcome === 'completed' ? 'TASK_COMPLETED' : 'TASK_SKIPPED', data: { ...base.data, reason: outcome } }]
  })
}
const logs = (strand: Strand, seconds = 600): StudyEvent[] => comparable([0.6, 0.6, 0.6, 0.6]).map(e => ({
  ...e, id: `${e.id}-${strand}`, type: 'PRACTICE_LOGGED', score: undefined, skill: undefined, data: { strand, activeSeconds: seconds },
}))
describe('observed avoidance and program balance', () => {
  it('absence, unanswered offers and excused skips remain unknown', () => {
    for (const events of [[], offers('speak', 'open'), offers('speak', 'busy')]) {
      expect(analyzeLongitudinal(events, NOW).avoidance.find(a => a.activity === 'speaking')!.status).toBe('unknown')
    }
  })
  it('requires four weeks of explicitly offered and resolved opportunities before flagging possible avoidance', () => {
    const events = offers('speak', 'too-hard')
    const result = analyzeLongitudinal(events, NOW).avoidance.find(a => a.activity === 'speaking')!
    expect(result).toMatchObject({ status: 'possible-avoidance', resolvedOffers: 8, avoidantSkips: 8 })
    expect(analyzeLongitudinal(events.slice(2), NOW).avoidance.find(a => a.activity === 'speaking')!.status).toBe('unknown')
    expect(analyzeLongitudinal(events.filter(e => e.type !== 'TASK_OFFERED'), NOW).avoidance.find(a => a.activity === 'speaking')!.status).toBe('unknown')
  })
  it('actual completion overrides an earlier skip, deduplicates offers and excludes misbound outcomes', () => {
    const base = offers('reading', 'too-hard')
    const completions = base.filter(e => e.type === 'TASK_SKIPPED').map(e => ({ ...e, id: `${e.id}-done`, type: 'TASK_COMPLETED', timestamp: e.timestamp + 1000 }))
    expect(analyzeLongitudinal([...base, ...base, ...completions], NOW).avoidance.find(a => a.activity === 'reading')).toMatchObject({ status: 'engaged', resolvedOffers: 8, avoidantSkips: 0 })
    const mismatched = base.map(e => e.type === 'TASK_SKIPPED' ? { ...e, data: { ...e.data, kind: 'speak' } } : e)
    expect(analyzeLongitudinal(mismatched, NOW).avoidance.find(a => a.activity === 'reading')!.status).toBe('unknown')
  })
  it('does not treat planned minutes or score counts as measured strand time', () => {
    const events = comparable([0.6, 0.6, 0.6, 0.6]).map(e => practice(e.id, e.timestamp))
    expect(analyzeLongitudinal(events, NOW).balance).toMatchObject({ status: 'unknown', shares: null, observedSeconds: 0 })
    expect(analyzeLongitudinal(logs('input').slice(1), NOW).balance.status).toBe('unknown')
  })
  it('detects sustained measured imbalance and respects cumulative session summaries', () => {
    const events = logs('input')
    expect(analyzeLongitudinal(events, NOW).balance).toMatchObject({ status: 'imbalanced', shares: { input: 1, output: 0, language: 0, fluency: 0 }, underrepresented: ['output', 'language', 'fluency'], observedSeconds: 4800 })
    const older = events.map(e => ({ ...e, id: `${e.id}-old`, timestamp: e.timestamp - 1000, data: { strand: 'input', activeSeconds: 300 } }))
    expect(analyzeLongitudinal([...events, ...older], NOW).balance.observedSeconds).toBe(4800)
  })
  it('recognizes balanced measured practice without inferring balanced ability', () => {
    const events = (['input', 'output', 'language', 'fluency'] as const).flatMap(s => logs(s))
    const signals = analyzeLongitudinal(events, NOW)
    expect(signals.balance).toMatchObject({ status: 'balanced', shares: { input: 0.25, output: 0.25, language: 0.25, fluency: 0.25 } })
    expect(signals.trends.every(t => t.status === 'unknown')).toBe(true)
  })
})

describe('graded reading from observed coverage, lookup, speed and complexity', () => {
  const candidate = material('candidate')
  const materials = [...baselineMaterials, candidate]
  const fit = (events = baselineEvents, target = candidate, library = materials) => assessReadingFit(target, profile, events, library, NOW)
  it('keeps zero evidence unknown and names every missing measurement', () => {
    const result = fit([])
    expect(result).toMatchObject({ fit: 'unknown', confidence: 'unknown', basis: 'none', metrics: { vocabularyCoverage: null, lookupsPer100Words: null, wordsPerMinute: null, speedRatio: null, sentenceLengthRatio: null } })
    expect(result.reasons).toContain('vocabulary-coverage-unknown')
  })
  it('estimates likely fit from several similar passages, exposing transfer uncertainty', () => {
    const result = fit()
    expect(result).toMatchObject({ fit: 'likely-fit', confidence: 'moderate', basis: 'similar-passages', metrics: { vocabularyCoverage: 0.99, lookupsPer100Words: 0.5, wordsPerMinute: 120, speedRatio: 1, sentenceLengthRatio: 1 } })
    expect(result.reasons).toContain('similar-passage-estimate-unseen-vocabulary-remains-unknown')
  })
  it('requires real independent readings, not repeats of a session or one day', () => {
    expect(fit(baselineEvents.slice(0, 2)).fit).toBe('unknown')
    expect(fit(baselineEvents.map(e => ({ ...e, sessionId: 'same' }))).fit).toBe('unknown')
    expect(fit(baselineEvents.map(e => ({ ...e, timestamp: NOW - DAY }))).fit).toBe('unknown')
    expect(fit([...baselineEvents, ...baselineEvents]).observationCount).toBe(3)
  })
  it.each([[94, 'too-hard'], [95, 'stretch'], [97, 'stretch'], [98, 'likely-fit']] as const)('uses sampled %i%% vocabulary as a policy band, not a comprehension score', (knownWordCount, expected) => {
    const events = baselineMaterials.map((m, i) => readingSample(m, i, { knownWordCount }))
    expect(fit(events).fit).toBe(expected)
  })
  it('does not convert missing lookup measurement into zero', () => {
    const events = baselineEvents.map(e => { const data = { ...e.data }; delete data.lookupCount; return { ...e, data } })
    expect(fit(events)).toMatchObject({ fit: 'unknown', metrics: { lookupsPer100Words: null } })
  })
  it('uses lookup burden even when vocabulary checks looked easy', () => {
    const events = baselineMaterials.map((m, i) => readingSample(m, i, { knownWordCount: 100, lookupCount: 14 }))
    expect(fit(events)).toMatchObject({ fit: 'too-hard', metrics: { vocabularyCoverage: 1, lookupsPer100Words: 7 } })
  })
  it('detects a slower observed candidate against the personal speed baseline', () => {
    const direct = readingSample(candidate, 4, { activeSeconds: 240 })
    expect(fit([...baselineEvents, direct])).toMatchObject({ fit: 'too-hard', basis: 'material-sample', confidence: 'limited', metrics: { wordsPerMinute: 50, speedRatio: 0.4167 } })
  })
  it('uses sentence length as an explicit complexity proxy without pretending vocabulary transfers', () => {
    const complex = material('complex', 0.35, 'Technology', 24)
    expect(fit(baselineEvents, complex, [...materials, complex])).toMatchObject({ fit: 'too-hard', metrics: { sentenceWords: 24, sentenceLengthRatio: 2.4, vocabularyCoverage: null } })
  })
  it('does not borrow reading metrics from a different editorial difficulty', () => {
    const advanced = material('advanced', 0.9)
    expect(fit(baselineEvents, advanced, [...materials, advanced])).toMatchObject({ fit: 'unknown', basis: 'none', metrics: { vocabularyCoverage: null, speedRatio: null } })
  })
  const malformedCoverage: Record<string, string | number>[] = [
    { sampledWordCount: 0 }, { sampledWordCount: 19 }, { knownWordCount: 101 }, { knownWordCount: -1 },
    { knownWordCount: NaN }, { sampledWordCount: Infinity }, { coverageMethod: 'unchecked' },
  ]
  it.each(malformedCoverage)('rejects malformed or unobserved coverage %j', patch => {
    const events = baselineEvents.map(e => ({ ...e, data: { ...e.data, ...patch } }))
    expect(fit(events).metrics.vocabularyCoverage).toBeNull()
    expect(fit(events).fit).toBe('unknown')
  })
  it.each([0, -1, NaN, Infinity, 1, 100000])('keeps invalid/implausible active timer %s unknown', activeSeconds => {
    const events = baselineEvents.map(e => ({ ...e, data: { ...e.data, activeSeconds } }))
    expect(fit(events).metrics.wordsPerMinute).toBeNull()
    expect(fit(events).fit).toBe('unknown')
  })
  it('excludes stale, future, self-reported, replayed and prompted readings', () => {
    for (const patch of [{ timestamp: NOW + 1 }, { timestamp: NOW - 28 * DAY - 1 }, { source: 'self-report' as const }, { prompted: true }]) {
      expect(fit(baselineEvents.map(e => ({ ...e, ...patch }))).observationCount).toBe(0)
    }
    expect(fit(baselineEvents.map(e => ({ ...e, data: { ...e.data, priorExposure: true } }))).observationCount).toBe(0)
  })
  it('does not recommend an unapproved, empty, future or malformed material', () => {
    for (const patch of [{ approved: false }, { transcript: '' }, { difficulty: NaN }, { createdAt: NOW + 1 }]) {
      expect(fit(baselineEvents, { ...candidate, ...patch }).eligible).toBe(false)
    }
  })
  it('rejects measurements for readings preceding material creation or using unapproved sources', () => {
    const futureLibrary = materials.map(m => ({ ...m, createdAt: NOW }))
    expect(fit(baselineEvents, candidate, futureLibrary).observationCount).toBe(0)
    const unapproved = materials.map(m => ({ ...m, approved: false }))
    expect(fit(baselineEvents, candidate, unapproved).observationCount).toBe(0)
  })
  it('rejects read/sample token counts larger than the actual passage', () => {
    const events = baselineEvents.map(e => ({ ...e, data: { ...e.data, wordsRead: 10000, sampledWordCount: 1000, knownWordCount: 999 } }))
    expect(fit(events)).toMatchObject({ fit: 'unknown', observationCount: 0, metrics: { vocabularyCoverage: null, wordsPerMinute: null } })
  })
  it('falls back to transcript sentences and ignores empty interest tokens', () => {
    const result = assessReadingFit({ ...candidate, sentences: [] }, { ...profile, interests: [' ', 'music'] }, [], materials, NOW)
    expect(result.metrics.sentenceWords).toBe(10)
    expect(result.interestMatch).toBe(false)
  })
})

describe('actual integratable task adjustments', () => {
  it('returns conserved budgets, a reading response, real card IDs and no completion mutation', () => {
    const data = input({ cards: [card('due')], events: [practice('last', NOW - 14 * DAY)], materials: [material('easy', 0.2)] })
    const snapshot = structuredClone(data)
    const plan = planLongitudinal(freezeDeep(data))
    expect(plan.reviews.selectedIds).toEqual(['due'])
    expect(plan.reading).toMatchObject({ materialId: 'easy', mode: 'probe', response: 'meaning-and-personal-response' })
    expect(plan.adjustments).toMatchObject({ minutes: 22, targetDifficulty: 0.2, readingTargetDifficulty: 0.2,
      difficultyDelta: -0.15, inputVolumeMultiplier: 0.5, newInputSeconds: 60, segmentSeconds: 20,
      inputMinutes: 6, readingMinutes: 5, speakingMinutes: 6, reviewMinutes: 1, languageMinutes: 2, fluencyMinutes: 2,
      speakingMode: 'guided-familiar', maxRepairTargets: 1 })
    expect(data).toEqual(snapshot)
  })
  it.each([15, 45, 90, 150])('conserves every minute at requested duration %i through fatigue and recovery', dailyMinutes => {
    for (const fatigue of [0, 0.5, 1]) for (const gap of [0, 3, 7, 14]) {
      const plan = planLongitudinal(input({ profile: { ...profile, dailyMinutes, fatigue }, events: [practice('last', NOW - gap * DAY)], cards: Array.from({ length: 100 }, (_, i) => card(`c${i}`)) }))
      const a = plan.adjustments
      expect(a.inputMinutes + a.readingMinutes + a.speakingMinutes + a.reviewMinutes + a.languageMinutes + a.fluencyMinutes).toBe(a.minutes)
      expect(a.speakingMinutes).toBeGreaterThanOrEqual(2)
      expect(a.readingMinutes).toBeGreaterThanOrEqual(2)
      expect(a.reviewMinutes * 60).toBeGreaterThanOrEqual(plan.reviews.estimatedSeconds)
      expect(plan.reviews.selected.length).toBeLessThanOrEqual(plan.recovery.maxReviewCards)
    }
  })
  it('turns sustained regression into easier difficulty, smaller new-input volume and shorter segments', () => {
    const plateau = planLongitudinal(input({ events: comparable([0.7, 0.7, 0.7, 0.7], 'naturalListening'), skills: [skill('naturalListening')] }))
    const regression = planLongitudinal(input({ events: comparable([0.8, 0.8, 0.6, 0.6], 'naturalListening'), skills: [skill('naturalListening')] }))
    expect(regression.adjustments.targetDifficulty).toBeLessThan(plateau.adjustments.targetDifficulty)
    expect(regression.adjustments.inputVolumeMultiplier).toBeLessThan(plateau.adjustments.inputVolumeMultiplier)
    expect(regression.adjustments.segmentSeconds).toBeLessThanOrEqual(plateau.adjustments.segmentSeconds)
    expect(regression.adjustments.speakingMode).toBe('guided-familiar')
  })
  it('changes a plateau to new-context output and allocates reading practice', () => {
    // Comparable assessments are samples within regular practice, not the whole activity history.
    const events = [...comparable([0.6, 0.6, 0.6, 0.6]), ...dailyPractice()]
    const plan = planLongitudinal(input({ events }))
    expect(plan.adjustments.speakingMode).toBe('new-context-transfer')
    expect(plan.adjustments.segmentSeconds).toBe(30)
    expect(plan.adjustments.readingMinutes).toBeGreaterThan(planLongitudinal(input()).adjustments.readingMinutes)
  })
  it('only advances listening difficulty with adequate comparable improving input', () => {
    const plan = planLongitudinal(input({ events: [...comparable([0.4, 0.4, 0.6, 0.6], 'naturalListening'), ...dailyPractice()], skills: [skill('naturalListening')] }))
    expect(plan.adjustments.difficultyDelta).toBe(0.05)
    const noHistory = planLongitudinal(input({ skills: [skill('naturalListening', 0.95)] }))
    expect(noHistory.adjustments.difficultyDelta).toBe(0)
    const readingOnly = planLongitudinal(input({ events: comparable([0.4, 0.4, 0.6, 0.6]), skills: [skill('reading', 0.9)] }))
    expect(readingOnly.adjustments.targetDifficulty).toBeLessThan(0.5)
  })
  it('defers an otherwise justified difficulty increase when fatigue is high', () => {
    const events = [...comparable([0.4, 0.4, 0.6, 0.6], 'naturalListening'), ...dailyPractice()]
    expect(planLongitudinal(input({ events, profile: { ...profile, fatigue: 0.8 } })).adjustments.difficultyDelta).toBe(0)
  })
  it('does not derive listening difficulty from stale, future or unobserved skill projections', () => {
    const reference = planLongitudinal(input()).adjustments.targetDifficulty
    for (const patch of [{ evidenceCount: 0 }, { confidence: 0 }, { updatedAt: NOW + 1 }, { updatedAt: NOW - 29 * DAY }, { score: NaN }]) {
      expect(planLongitudinal(input({ skills: [skill('naturalListening', 0.99, patch)] })).adjustments.targetDifficulty).toBe(reference)
    }
  })
  it('rebalances actual minutes rather than merely attaching an imbalance label', () => {
    const fresh = practice('today', NOW)
    const baseline = planLongitudinal(input({ events: [fresh] }))
    const rebalanced = planLongitudinal(input({ events: [...logs('input'), fresh] }))
    expect(rebalanced.adjustments.languageMinutes).toBeGreaterThan(baseline.adjustments.languageMinutes)
    expect(rebalanced.adjustments.fluencyMinutes).toBeGreaterThan(baseline.adjustments.fluencyMinutes)
    expect(rebalanced.adjustments.inputMinutes).toBeLessThan(baseline.adjustments.inputMinutes)
  })
  it('puts a measured language deficit into the distinct Today language task, not the reader', () => {
    const baseline = makePlan(profile, [], [], [practice('today', NOW)], baselineMaterials, undefined, NOW)
    const plan = makePlan(profile, [], [], [...logs('input'), practice('today', NOW)], baselineMaterials, undefined, NOW)
    expect(plan.tasks.find(t => t.id.endsWith(':chunks'))!.minutes).toBeGreaterThan(baseline.tasks.find(t => t.id.endsWith(':chunks'))!.minutes)
    expect(plan.tasks.find(t => t.id.endsWith(':reading'))!.minutes).toBeGreaterThan(0)
    expect(plan.minutes).toBeLessThanOrEqual(profile.dailyMinutes)
    expect(analyzeLongitudinal(logs('input'), NOW).balance.underrepresented).toContain('language')
  })
  it('responds to possible speaking avoidance with a smaller supported start while retaining speaking', () => {
    const baseline = planLongitudinal(input())
    const plan = planLongitudinal(input({ events: offers('speak', 'too-hard') }))
    expect(plan.adjustments.speakingMode).toBe('guided-familiar')
    expect(plan.adjustments.speakingMinutes).toBeLessThan(baseline.adjustments.speakingMinutes)
    expect(plan.adjustments.speakingMinutes).toBeGreaterThanOrEqual(2)
  })
  it('uses interests to choose within approachable reading options, never to override observed overload', () => {
    const plain = material('plain', 0.35, 'Culture'), interest = material('interest')
    const advanced = material('advanced', 0.9)
    const plan = planLongitudinal(input({ materials: [plain, advanced, interest] }))
    expect(plan.reading.materialId).toBe('interest')
    const overloaded = readingSample(interest, 4, { knownWordCount: 80 })
    const withEvidence = planLongitudinal(input({ materials: [plain, interest, ...baselineMaterials], events: [...baselineEvents, overloaded] }))
    expect(withEvidence.reading.materialId).not.toBe('interest')
  })
  it('reports bridge-needed or no-material rather than quietly assigning an unsuitable reader', () => {
    expect(planLongitudinal(input({ materials: [material('hard', 0.95)] })).reading).toMatchObject({ materialId: null, mode: 'bridge-needed' })
    expect(planLongitudinal(input({ materials: [] })).reading).toMatchObject({ materialId: null, mode: 'no-material' })
  })
  it('requires no ambient clock or randomness and is stable under event/card/material permutation', () => {
    const data = input({ events: [...baselineEvents, ...comparable([0.6, 0.6, 0.6, 0.6])], cards: [card('a'), card('b')], materials: [...baselineMaterials, material('candidate')] })
    const first = planLongitudinal(data)
    expect(planLongitudinal({ ...data, events: [...data.events].reverse(), cards: [...data.cards].reverse(), materials: [...data.materials].reverse() })).toEqual(first)
    expect(planLongitudinal(data)).toEqual(first)
  })
})

describe('invalid dates, clock skew and sync evidence integrity', () => {
  it.each([NaN, Infinity, -1, 8.64e15 + 1])('fails explicitly for invalid now %s', now => {
    expect(() => planLongitudinal(input({ now }))).toThrow(RangeError)
    expect(() => planRecovery(profile, [], now)).toThrow(RangeError)
    expect(() => analyzeLongitudinal([], now)).toThrow(RangeError)
    expect(() => selectMeaningfulReviews([], [], now, { budgetSeconds: 100, maxCards: 10 })).toThrow(RangeError)
    expect(() => assessReadingFit(material('a'), profile, [], [], now)).toThrow(RangeError)
  })
  it('does not allow future/skewed events to hide an interruption or supply observations', () => {
    const events = [practice('old', NOW - 14 * DAY), practice('skew', NOW + 1), event('invalid', NaN), event('negative', -1)]
    expect(planRecovery(profile, events, NOW).mode).toBe('restart-14')
    expect(analyzeLongitudinal(events, NOW).diagnostics).toMatchObject({ futureEvents: 1, invalidEvents: 2 })
  })
  it('is order-independent for conflicting event IDs and does not silently select one score', () => {
    const base = comparable([0.6, 0.6, 0.6, 0.6])
    const conflict = { ...base[0], score: 0.95 }
    const a = analyzeLongitudinal([...base, conflict], NOW), b = analyzeLongitudinal([conflict, ...base].reverse(), NOW)
    expect(a).toEqual(b)
    expect(a.diagnostics.conflictingIds).toBe(1)
    expect(a.trends.find(t => t.skill === 'reading')!.status).toBe('unknown')
  })
  it('deduplicates semantically identical records despite data property order', () => {
    const base = comparable([0.6, 0.6, 0.6, 0.6])
    const reordered = { ...base[0], data: Object.fromEntries(Object.entries(base[0].data!).reverse()) }
    expect(analyzeLongitudinal([...base, reordered], NOW).diagnostics).toMatchObject({ duplicateEvents: 1, conflictingIds: 0 })
    expect(findTrend([...base, reordered]).comparableDays).toBe(8)
  })
  it('does not let a future conflicting copy validate the present copy', () => {
    const old = practice('old', NOW - 14 * DAY), current = practice('same', NOW)
    expect(planRecovery(profile, [old, current, { ...current, timestamp: NOW + DAY }], NOW).mode).toBe('restart-14')
    expect(planRecovery(profile, [old, { ...current, timestamp: NOW + DAY }, current], NOW).mode).toBe('restart-14')
    expect(analyzeLongitudinal([old, current, { ...current, timestamp: NOW + DAY }], NOW)).toEqual(
      analyzeLongitudinal([old, { ...current, timestamp: NOW + DAY }, current], NOW))
  })
})

describe('daily-plan integration and supported acoustic practice', () => {
  it('routes an onboarded daily reader through an existing learn task identity', () => {
    const plan = makePlan(profile, [], [], [], [material('reader')], undefined, NOW)
    const reading = plan.tasks.find(t => t.kind === 'learn')!
    expect(reading.id).toMatch(/:reading$/)
    expect(reading.materialId).toBe('reader')
    expect(plan.minutes).toBe(45)
  })
  it('chooses a separate fresh reader when available and preserves it after it is begun', () => {
    const materials = [material('listen'), material('reader')]
    const first = makePlan(profile, [], [], [], materials, undefined, NOW)
    const reading = first.tasks.find(t => t.id.endsWith(':reading'))!
    expect(reading.materialId).not.toBe(first.tasks.find(t => t.kind === 'listen')!.materialId)
    const second = makePlan(profile, [], [], [event('exposed', NOW, { data: { materialId: reading.materialId! } })], materials, first, NOW + 1)
    expect(second.tasks.find(t => t.id === reading.id)?.materialId).toBe(reading.materialId)
    const unavailable = materials.map(m => m.id === reading.materialId ? { ...m, approved: false } : m)
    expect(makePlan(profile, [], [], [], unavailable, first, NOW + 1).tasks.find(t => t.id === reading.id)?.materialId).toBe(reading.materialId)
  })
  it('does not auto-fill the review backlog again after actual block completion', () => {
    const initial = makePlan(profile, [], [card('a')], [], [material('reader')], undefined, NOW)
    initial.tasks.find(t => t.kind === 'review')!.done = true
    const finished = event('block', NOW, { type: 'REVIEW_BLOCK_COMPLETED', source: 'objective', skill: undefined, score: undefined })
    const next = makePlan(profile, [], [card('b')], [finished], [material('reader')], initial, NOW + 1)
    expect(next.tasks.filter(t => t.kind === 'review')).toHaveLength(1)
    expect(next.tasks.find(t => t.kind === 'review')!.done).toBe(true)
  })
  it('uses the recovery budget and a bounded review queue in the actual daily plan', () => {
    const cards = Array.from({ length: 1000 }, (_, i) => card(`due-${i}`))
    const plan = makePlan(profile, [], cards, [practice('old', NOW - 14 * DAY)], [material('easy', 0.2)], undefined, NOW)
    expect(plan.minutes).toBe(22)
    expect(plan.tasks.find(t => t.kind === 'review')!.minutes).toBeLessThanOrEqual(4)
    expect(plan.tasks.find(t => t.kind === 'review')!.reason).not.toContain('1000')
    expect(plan.tasks.find(t => t.kind === 'speak')!.title).toBe('Start with a familiar situation')
    expect(cards.every(c => c.card.reps === 0)).toBe(true)
  })
  it('preserves a begun reading material and does not grow past budget for new due work', () => {
    const materials = [material('a'), material('b')]
    const plan = makePlan(profile, [], [], [], materials, undefined, NOW)
    const reading = plan.tasks.find(t => t.id.endsWith(':reading'))!
    const next = makePlan({ ...profile, interests: ['Different'] }, [], [], [practice('started', NOW)], [...materials].reverse(), plan, NOW + 1)
    expect(next.tasks.find(t => t.id === reading.id)?.materialId).toBe(reading.materialId)
    plan.tasks.forEach(t => { t.done = true })
    const extra = makePlan(profile, [], [card('late')], [], materials, plan, NOW + 1)
    expect(extra.minutes).toBe(45)
    expect(extra.tasks.filter(t => !t.done)).toHaveLength(0)
    expect(planSchema.safeParse(extra).success).toBe(true)
    expect(extra.tasks.filter(t => t.done)).toEqual(plan.tasks)
  })
  it.each(['pronunciation', 'prosody'] as const)('accepts attested scripted %s with reduced weight', target => {
    const supported = event('speech', NOW, { source: 'acoustic', skill: target, modality: 'speaking', score: 0.9,
      prompted: true, data: { scripted: true, provider: 'test-acoustic-provider', assessmentId: 'assessment-123' } })
    expect(evidenceWeight(supported)).toBe(0.25)
    const projected = aggregateSkills([supported])
    expect(projected.find(s => s.id === target)!.evidenceCount).toBe(1)
    for (const id of ['speakingFluency', 'interaction', 'realWorld'] as const) expect(projected.find(s => s.id === id)!.evidenceCount).toBe(0)
    expect(evidenceWeight({ ...supported, source: 'ai' })).toBe(0)
    expect(evidenceWeight({ ...supported, source: 'text' })).toBe(0)
    expect(evidenceWeight({ ...supported, data: { provider: 'test-acoustic-provider' } })).toBe(0)
    expect(evidenceWeight({ ...supported, data: { assessmentId: 'assessment-123' } })).toBe(0)
  })
  it.each(['speakingFluency', 'interaction', 'realWorld'] as const)('never grants scripted %s credit even with provider metadata and a novel-context tag', target => {
    for (const score of [0.3, 0.9]) expect(evidenceWeight(event('speech', NOW, { source: 'acoustic', skill: target,
      modality: 'transfer', score, prompted: false, contextId: 'new', data: { scripted: true, provider: 'provider', assessmentId: 'id', novelContext: true } }))).toBe(0)
  })
})
describe('prospective comparison contracts and real adjustment integration', () => {
  const facts = { rubricVersion: readingRubric.version, comparisonKey: 'family', difficulty: 0.35,
    evaluator: 'actual-provider/model', conditions: 'without-help', firstPass: true, priorExposure: false, prompted: false }
  it.each(['READING_OBSERVATION', 'READING_RESPONSE', 'READING_RETELL', 'TASK_COMPLETED', 'PRACTICE_LOGGED'])('never projects %s participation as ability even if an imported record contains a score', type => {
    const observation = event('activity', NOW, { type, source: 'objective', score: 1, skill: 'reading' })
    expect(evidenceWeight(observation)).toBe(0)
    expect(aggregateSkills([observation]).every(s => s.evidenceCount === 0)).toBe(true)
  })
  it.each(['evaluator', 'conditions', 'firstPass', 'priorExposure', 'prompted'] as const)('does not invent missing %s', key => {
    expect(comparableObservation({ ...facts, [key]: null })).toBeNull()
  })
  it('uses only provider-attested evaluator metadata', () => {
    for (const value of [null, {}, { model: 'selected' }, { provenance: { provider: '', model: 'actual' } }]) expect(assessmentEvaluator(value)).toBeNull()
    expect(assessmentEvaluator({ provenance: { provider: 'actual', model: 'executed' } })).toBe('["actual","executed"]')
  })
  it('preserves started tasks but does not turn offers or future/skewed events into task starts', () => {
    const data = { taskId: 'task' }
    expect(hasTaskStarted('task', [event('offer', NOW, { type: 'TASK_OFFERED', data })], NOW)).toBe(false)
    expect(hasTaskStarted('task', [event('start', NOW + 1, { type: 'TASK_STARTED', data })], NOW)).toBe(false)
    expect(hasTaskStarted('task', [event('start', NOW, { type: 'TASK_STARTED', data })], NOW)).toBe(true)
    expect(hasTaskStarted('other', [event('start', NOW, { type: 'TASK_STARTED', data })], NOW)).toBe(false)
  })
  it('selects only approved available reading and prefers an unseen matched passage', () => {
    const a = material('a'), b = material('b')
    expect(selectReadingAssessment(profile, [a, b], [event('read', NOW - DAY, { data: { materialId: 'a' } })], NOW)?.id).toBe('b')
    expect(selectReadingAssessment(profile, [{ ...a, approved: false }, { ...b, createdAt: NOW + 1 }], [], NOW)).toBeNull()
    expect(selectReadingAssessment(profile, [b, a], [], NOW)).toEqual(selectReadingAssessment(profile, [a, b], [], NOW))
    expect(readingComparisonKey({ ...a, transcript: 'Too short.' })).toBeNull()
    expect(readingComparisonKey(a)).not.toBe(readingComparisonKey(material('complex', 0.35, 'Technology', 18)))
  })
  it('does not diagnose plateau from only two fortnightly reading checks', () => {
    const data = comparableObservation(facts)!
    const checks = [NOW - 15 * DAY, NOW - DAY].map((timestamp, i) => event('check-' + i, timestamp,
      { source: 'ai', sessionId: 'check-' + i, prompted: false, data: { ...data } }))
    expect(findTrend(checks).status).toBe('unknown')
  })
  it('uses matched daily observations for descriptive plateau, with difficulty/model/help partitions', () => {
    const m = material('reader'), comparisonKey = readingComparisonKey(m)!
    const data = comparableObservation({ ...facts, comparisonKey })!
    const events = comparable([0.6, 0.6, 0.6, 0.6]).map((e, i) => ({ ...e, source: 'ai' as const, data: { ...data, materialId: 'fresh-' + i } }))
    expect(findTrend(events).status).toBe('plateau')
    expect(findTrend(events.map((e, i) => i > 3 ? { ...e, data: { ...e.data, difficulty: 0.5 } } : e)).status).toBe('unknown')
    expect(findTrend(events.map((e, i) => i > 3 ? { ...e, data: { ...e.data, conditionsKey: 'changed-provider' } } : e)).status).toBe('unknown')
    expect(findTrend(events.map(e => ({ ...e, prompted: true }))).status).toBe('unknown')
  })
  it('changes actual selected input, speaking mode and integer task minutes after a comparable regression', () => {
    const materials = [material('normal', 0.35), material('bridge', 0.2)]
    const baseline = makePlan(profile, [], [], [], materials, undefined, NOW)
    const events = comparable([0.8, 0.8, 0.5, 0.5])
    const adjusted = makePlan(profile, [], [], events, materials, undefined, NOW)
    expect(baseline.tasks.find(t => t.kind === 'listen')!.materialId).toBe('normal')
    expect(adjusted.tasks.find(t => t.kind === 'listen')!.materialId).toBe('bridge')
    expect(adjusted.tasks.find(t => t.kind === 'speak')!.title).toBe('Start with a familiar situation')
    expect(adjusted.tasks.map(t => t.minutes)).not.toEqual(baseline.tasks.map(t => t.minutes))
    expect(planSchema.safeParse(adjusted).success).toBe(true)
    expect(adjusted.minutes).toBeLessThanOrEqual(profile.dailyMinutes)
  })
})
