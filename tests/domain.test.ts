import { describe, expect, it } from 'vitest'
import { createEmptyCard } from 'ts-fsrs'
import { aggregateSkills, makePlan, nextAssignedTask, skillLabel, taskPath } from '../src/domain/engine'
import { defaultProfile, skillNames, type Material, type Profile, type ReviewCard, type SkillName, type StudyEvent } from '../src/domain/types'

const now = new Date(2026, 8, 7, 12).getTime()
const profile: Profile = { ...defaultProfile(), createdAt: now, interests: ['Technology'] }
const material = (id: string, topic = 'Technology', approved = true): Material => ({
  id, title: id, topic, difficulty: 0.35, duration: 30, transcript: 'Could you give me a hand?', sentences: ['Could you give me a hand?'],
  sourceKind: 'curated', sourceLabel: 'Original', synthetic: true, approved, question: 'What is requested?', answer: 'Help',
  keywords: [], chunks: [], createdAt: now,
})
const event = (id: string, skill: SkillName, score: number, extra: Partial<StudyEvent> = {}): StudyEvent => ({ id, type: 'test', timestamp: now, skill, score, source: 'objective', ...extra })
const card = (id: string): ReviewCard => ({ id, chunkId: id, modality: 'recognition', card: createEmptyCard(now - 1), contextIds: [] })
const find = (events: StudyEvent[], skill: SkillName) => aggregateSkills(events).find(s => s.id === skill)!

describe('distinct assigned reading and deliberate language', () => {
  const learner = { ...profile, onboarded: true }
  const readers = [material('a'), material('b')].map(m => ({ ...m, chunks: [
    { text: 'give me a hand', meaningEn: 'help me', meaningZh: '', example: 'Could you give me a hand?' },
  ] }))
  it('budgets both activities with empty review stock for sixty consecutive days', () => {
    const events: StudyEvent[] = []
    for (let day = 0; day < 60; day++) {
      const clock = now + day * 86_400_000
      const plan = makePlan(learner, [], [], events, readers, undefined, clock)
      expect(plan.tasks.filter(t => t.kind === 'learn' && t.id.endsWith(':reading'))).toHaveLength(1)
      expect(plan.tasks.filter(t => t.kind === 'learn' && t.id.endsWith(':chunks'))).toHaveLength(1)
      expect(plan.minutes).toBeLessThanOrEqual(45)
      expect(plan.tasks.every(t => t.minutes > 0)).toBe(true)
      events.push({ id: `reading-${day}`, type: 'PRACTICE_LOGGED', source: 'objective', timestamp: clock,
        sessionId: `reader-${day}`, data: { strand: 'input', activeSeconds: 600 } })
    }
  })
  it('preserves restored legacy and reading identities without one suppressing the other', () => {
    const original = makePlan(learner, [], [], [], readers, undefined, now)
    const reading = original.tasks.find(t => t.id.endsWith(':reading'))!
    const legacy = { id: `${original.date}:learn:a`, kind: 'learn' as const, materialId: 'a',
      title: 'Original language assignment', reason: 'Saved before the upgrade', minutes: 5, done: true }
    const restored = { ...original, tasks: [legacy, { ...reading, done: false }] }
    const next = makePlan(learner, [], [], [], readers, restored, now + 1)
    expect(next.tasks.find(t => t.id === legacy.id)).toEqual(legacy)
    expect(next.tasks.find(t => t.id === reading.id)).toMatchObject({ materialId: reading.materialId, done: false })
    expect(next.tasks.filter(t => t.kind === 'learn')).toHaveLength(2)
    expect(new Set(next.tasks.map(t => t.id)).size).toBe(next.tasks.length)
  })
  it.each([10, 15, 45])('keeps reading and chunks within a %i minute recovery budget', dailyMinutes => {
    const plan = makePlan({ ...learner, dailyMinutes, fatigue: 0.9 }, [], Array.from({ length: 100 }, (_, i) => card(`due-${i}`)), [], readers, undefined, now)
    expect(plan.minutes).toBeLessThanOrEqual(dailyMinutes)
    expect(plan.tasks.every(t => Number.isInteger(t.minutes) && t.minutes > 0)).toBe(true)
    expect(plan.tasks.filter(t => t.kind === 'learn')).toHaveLength(2)
  })
  it('routes distinct listening/reading/language materials and preserves restored active legacy work', () => {
    const plan = makePlan(learner, [], [], [], readers, undefined, now)
    const listening = plan.tasks.find(t => t.kind === 'listen')!, reading = plan.tasks.find(t => t.id.endsWith(':reading'))!
    expect(listening.materialId).not.toBe(reading.materialId)
    expect(taskPath(nextAssignedTask({ ...plan, tasks: plan.tasks.map(t => ({ ...t, done: t.id === listening.id })) }, listening.id)!))
      .toEqual({ path: '/learn', query: { task: reading.id, material: reading.materialId, mode: 'reading' } })
    const legacy = { ...plan.tasks.find(t => t.id.endsWith(':chunks'))!, id: `${plan.date}:learn:a` }
    const restored = { ...plan, tasks: plan.tasks.map(t => t.id.endsWith(':chunks') ? legacy : t) }
    const events: StudyEvent[] = [{ id: 'started-legacy', type: 'TASK_STARTED', source: 'objective', timestamp: now,
      data: { taskId: legacy.id, kind: 'learn' } }]
    const replan = makePlan({ ...learner, interests: ['Different'], fatigue: 0.5 }, [], [], events, [...readers].reverse(), restored, now)
    expect(replan.tasks.find(t => t.id === legacy.id)).toMatchObject({ materialId: legacy.materialId, done: false })
    expect(taskPath(legacy)).toEqual({ path: '/learn', query: { task: legacy.id, material: legacy.materialId, mode: 'chunks' } })
  })
  it('never auto-starts optional assignments before, between or after required tasks', () => {
    const plan = makePlan(learner, [], [], [], readers, undefined, now)
    const required = plan.tasks.slice(0, 2)
    const extra = { ...plan.tasks.find(task => task.id.endsWith(':reading'))!, id: 'saved-original:reading', minutes: 9, optional: true }
    for (const tasks of [[extra, ...required], [required[0], extra, required[1]], [...required, extra]]) {
      const mixed = { ...plan, tasks }
      expect(nextAssignedTask(mixed)?.id).toBe(required[0].id)
      expect(nextAssignedTask({ ...mixed, tasks: tasks.map(task => ({ ...task, done: task.id === required[0].id })) }, required[0].id)?.id).toBe(required[1].id)
      expect(nextAssignedTask({ ...mixed, tasks: tasks.map(task => ({ ...task, done: !task.optional })) })).toBeUndefined()
      expect(taskPath(extra)).toEqual({ path: '/learn', query: { task: extra.id, material: extra.materialId, mode: 'reading' } })
    }
  })
  it('uses the final available minute for already started language instead of a newly introduced reader', () => {
    const plan = makePlan(learner, [], [], [], readers, undefined, now)
    const language = { ...plan.tasks.find(t => t.id.endsWith(':chunks'))!, id: `${plan.date}:learn:a`, minutes: 1 }
    const done = { ...plan.tasks.find(t => t.kind === 'listen')!, done: true, minutes: 44 }
    const restored = { ...plan, tasks: [done, language] }
    const started: StudyEvent = { id: 'started', type: 'TASK_STARTED', source: 'objective', timestamp: now, data: { taskId: language.id, kind: 'learn' } }
    const next = makePlan(learner, [], [], [started], readers, restored, now)
    expect(next.tasks).toEqual([done, language])
    expect(next.minutes).toBe(45)
  })
})

describe('evidence projection', () => {
  it('keeps all unobserved skills unknown without a fabricated prior', () => {
    expect(aggregateSkills([])).toHaveLength(skillNames.length)
    expect(aggregateSkills([]).every(s => s.score === 0 && s.confidence === 0 && s.evidenceCount === 0 && s.updatedAt === 0)).toBe(true)
    expect(skillNames.every(name => !!skillLabel(name))).toBe(true)
  })
  it('is order independent, deduplicates IDs and responds to later failures', () => {
    const a = event('a', 'reading', 1), b = event('b', 'reading', 0, { timestamp: now + 10 })
    expect(aggregateSkills([b, a, a])).toEqual(aggregateSkills([a, b]))
    expect(find([a, b], 'reading')).toMatchObject({ score: 0.75, evidenceCount: 2, updatedAt: now + 10 })
    expect(find([a], 'reading').confidence).toBeLessThan(find([a, b], 'reading').confidence)
  })
  it.each(['self-report', 'text', 'ai'] as const)('%s cannot establish acoustic proficiency', source => {
    for (const skill of ['pronunciation', 'prosody', 'speakingFluency'] as const) {
      expect(find([event('x', skill, 1, { source })], skill).evidenceCount).toBe(0)
    }
  })
  it('separates hinted success, text production, independent speech and measured acoustics', () => {
    const input = [event('recognition', 'chunkRecognition', 1), event('text', 'chunkProduction', 1, { source: 'text' }),
      event('hinted', 'chunkProduction', 1, { prompted: true }), event('self', 'chunkProduction', 1, { source: 'self-report' })]
    expect(find(input, 'chunkProduction').evidenceCount).toBe(0)
    expect(find(input, 'chunkRecognition').score).toBe(1)
    expect(find([event('spoken', 'chunkProduction', 0.8, { source: 'acoustic' })], 'chunkProduction').score).toBe(0.8)
    expect(find([event('acoustic', 'prosody', 0.7, { source: 'acoustic' })], 'prosody').score).toBe(0.7)
    expect(find([event('text', 'grammarProduction', 1, { source: 'text', prompted: true })], 'grammarProduction').score).toBe(0.6)
  })
  it('requires novel context for transfer and rejects malformed numeric evidence', () => {
    expect(find([event('transfer', 'realWorld', 1, { contextId: 'c', data: { novelContext: false } })], 'realWorld').evidenceCount).toBe(0)
    expect(find([event('transfer', 'realWorld', 1, { contextId: 'c', data: { novelContext: true } })], 'realWorld').score).toBe(1)
    for (const score of [NaN, Infinity, -0.1, 1.1]) expect(find([event('bad', 'reading', score)], 'reading').evidenceCount).toBe(0)
    expect(find([event('bad-source', 'reading', 1, { source: 'unknown' as StudyEvent['source'] })], 'reading').evidenceCount).toBe(0)
    expect(find([event('blank-context', 'realWorld', 1, { contextId: ' ', data: { novelContext: true } })], 'realWorld').evidenceCount).toBe(0)
  })
  it('verified recorded transcripts support AI language evidence, never phoneme or acoustic scores', () => {
    const proof = { audioObserved: true, transcriptVerified: true }
    expect(find([event('missing-proof', 'speakingAccuracy', 1, { source: 'ai', data: { audioObserved: true } })], 'speakingAccuracy').evidenceCount).toBe(0)
    expect(find([event('verified', 'speakingAccuracy', 0.8, { source: 'ai', data: proof })], 'speakingAccuracy').score).toBe(0.8)
    expect(find([event('text', 'chunkProduction', 1, { source: 'text', modality: 'speaking', data: proof })], 'chunkProduction').evidenceCount).toBe(0)
    expect(find([event('recognition', 'chunkProduction', 1, { modality: 'recognition' })], 'chunkProduction').evidenceCount).toBe(0)
    for (const skill of ['pronunciation', 'prosody', 'speakingFluency'] as const) {
      expect(find([event('verified', skill, 1, { source: 'ai', data: proof })], skill).evidenceCount).toBe(0)
    }
  })
})

describe('adaptive daily plan', () => {
  it.each([45, 90, 150])('allocates the %i-minute budget and retains speaking at every fatigue level', dailyMinutes => {
    for (const fatigue of [0, 0.4, 0.8, 1]) {
      const p = makePlan({ ...profile, dailyMinutes, fatigue }, [], [], [], [], undefined, now)
      expect(p.minutes).toBe(Math.round(dailyMinutes * (1 - fatigue * 0.4)))
      expect(p.tasks.reduce((n, t) => n + t.minutes, 0)).toBe(p.minutes)
      expect(p.tasks.some(t => t.kind === 'speak' && t.minutes > 0)).toBe(true)
      expect(p.tasks.every(t => t.minutes >= 1 && !t.done)).toBe(true)
    }
  })
  it('is deterministic, ignores array order and does not mutate its inputs', () => {
    const mats = [material('b'), material('a')]
    const events = [event('b', 'reading', 1), event('a', 'writing', 0)]
    const before = JSON.stringify({ profile, mats, events })
    expect(makePlan(profile, aggregateSkills(events), [], events, mats, undefined, now)).toEqual(makePlan(profile, aggregateSkills(events), [], [...events].reverse(), [...mats].reverse(), undefined, now))
    expect(JSON.stringify({ profile, mats, events })).toBe(before)
  })
  it('adapts focus to weakness, repairs recent failures and scales due review time', () => {
    const events = [event('failure', 'listeningWords', 0)]
    const p = makePlan(profile, aggregateSkills(events), [card('a')], events, [], undefined, now)
    const many = makePlan(profile, aggregateSkills(events), Array.from({ length: 30 }, (_, i) => card(String(i))), events, [], undefined, now)
    expect(p.focus).toBe('listeningWords')
    expect(p.tasks.some(t => t.kind === 'repair')).toBe(true)
    expect(many.tasks.find(t => t.kind === 'review')!.minutes).toBeGreaterThan(p.tasks.find(t => t.kind === 'review')!.minutes)
  })
  it('selects approved interest-matched material and rebalances excessive input', () => {
    const mats = [material('tech'), material('travel', 'Travel'), material('unapproved', 'Technology', false)]
    const p = makePlan(profile, [], [], [], mats, undefined, now)
    const travel = makePlan({ ...profile, interests: ['Travel'] }, [], [], [], mats, undefined, now)
    expect(p.tasks.find(t => t.kind === 'listen')!.materialId).toBe('tech')
    expect(travel.tasks.find(t => t.kind === 'listen')!.materialId).toBe('travel')
    const events = Array.from({ length: 6 }, (_, i): StudyEvent => ({ id: String(i), timestamp: now, type: 'TASK_COMPLETED', source: 'objective', data: { kind: 'listen' } }))
    const balanced = makePlan(profile, [], [], events, mats, undefined, now)
    expect(balanced.tasks.find(t => t.kind === 'speak')!.minutes).toBeGreaterThan(p.tasks.find(t => t.kind === 'speak')!.minutes)
  })
  it('preserves same-day completed identity/duration without completing new work', () => {
    const original = makePlan(profile, [], [], [], [material('tech')], undefined, now)
    original.tasks[0].done = true
    const next = makePlan({ ...profile, fatigue: 0.8 }, [], [card('new')], [], [material('tech')], original, now + 1000)
    expect(next.tasks.find(t => t.id === original.tasks[0].id)).toEqual(original.tasks[0])
    expect(next.tasks.find(t => t.kind === 'review')!.done).toBe(false)
    expect(next.tasks.filter(t => t.done)).toHaveLength(1)
    expect(new Set(next.tasks.map(t => t.id)).size).toBe(next.tasks.length)
  })
  it('new due cards do not grow a completed day, remain due, and are assigned on the next day', () => {
    const original = makePlan(profile, [], [card('a')], [], [], undefined, now)
    original.tasks.forEach(t => { t.done = true })
    const unchanged = makePlan(profile, [], [card('a')], [], [], original, now + 1000)
    expect(unchanged.tasks.every(t => t.done)).toBe(true)
    const dueCard = card('b'), before = structuredClone(dueCard)
    const more = makePlan(profile, [], [dueCard], [], [], original, now + 1000)
    expect(more.tasks).toEqual(original.tasks)
    expect(dueCard).toEqual(before)
    const tomorrow = makePlan(profile, [], [dueCard], [], [], original, now + 86_400_000)
    expect(tomorrow.tasks.every(t => !t.done)).toBe(true)
    expect(tomorrow.tasks.some(t => t.kind === 'review')).toBe(true)
  })
  it('uses completed assessment evidence to schedule a comparable two-week followup', () => {
    const older = { ...profile, onboarded: true, createdAt: now - 15 * 86_400_000 }
    expect(makePlan(older, [], [], [], [], undefined, now).tasks.some(t => t.kind === 'assessment')).toBe(true)
    const completion: StudyEvent = { id: 'assessment', type: 'assessment-completed', timestamp: now - 1000, source: 'objective' }
    expect(makePlan(older, [], [], [completion], [], undefined, now).tasks.some(t => t.kind === 'assessment')).toBe(false)
  })
  it('uses the local calendar day at midnight and keeps labels in English', () => {
    const beforeMidnight = new Date(2026, 8, 7, 23, 59).getTime()
    const original = makePlan(profile, [], [], [], [], undefined, beforeMidnight)
    original.tasks.forEach(task => { task.done = true })
    const after = makePlan(profile, [], [], [], [], original, beforeMidnight + 120_000)
    expect(original.date).toBe('2026-09-07')
    expect(after.date).toBe('2026-09-08')
    expect(after.tasks.every(t => !t.done)).toBe(true)
    expect(/[\u3400-\u9fff]/.test(after.tasks.map(t => `${t.title} ${t.reason}`).join(' '))).toBe(false)
  })
  it('does not let interests bypass listening difficulty or an empty prior plan remove speaking', () => {
    const difficult = { ...material('advanced', 'Technology'), difficulty: 1 }
    const approachable = { ...material('accessible', 'Travel'), difficulty: 0.2 }
    const original = makePlan(profile, [], [], [], [difficult, approachable], undefined, now)
    expect(original.tasks.find(t => t.kind === 'listen')!.materialId).toBe('accessible')
    const regenerated = makePlan(profile, [], [], [], [difficult, approachable], { ...original, tasks: [] }, now)
    expect(regenerated.tasks.some(t => t.kind === 'speak')).toBe(true)
    expect(regenerated.tasks.some(t => !t.done)).toBe(true)
  })
  it('binds pending IDs and the material chain while exposure, focus and fatigue change', () => {
    const materials = [material('a'), material('b')]
    const original = makePlan(profile, [], [], [], materials, undefined, now)
    const exposures = [event('exposure', 'reading', 1, { data: { materialId: 'a' } }), event('weakness', 'grammarProduction', 0)]
    const revisedProfile = { ...profile, dailyMinutes: 90, fatigue: 0.8 }
    const next = makePlan(revisedProfile, aggregateSkills(exposures), [], exposures, materials, original, now + 1000)
    for (const assigned of original.tasks) {
      expect(next.tasks.find(task => task.id === assigned.id)).toMatchObject({ kind: assigned.kind, materialId: assigned.materialId, done: false })
    }
    expect(next.focus).toBe('grammarProduction')
    expect(next.minutes).toBe(Math.round(90 * (1 - 0.8 * 0.4)))
    expect(next.tasks.filter(task => task.materialId).every(task => task.materialId === 'a')).toBe(true)
    expect(next.tasks.some(task => task.kind === 'retell')).toBe(true)
    const invalidated = makePlan(revisedProfile, [], [], exposures.slice(0, 1), materials, undefined, now + 1000)
    expect(invalidated.tasks.find(task => task.kind === 'listen')!.materialId).toBe('b')
  })
  it('does not reopen completed core kinds when exposures or newly preferred materials change', () => {
    const materials = [material('a'), material('b')]
    let previous = makePlan(profile, [], [], [], materials, undefined, now)
    previous.tasks.forEach(task => { task.done = true })
    for (let i = 0; i < 4; i++) {
      const exposures = [event(String(i), 'reading', 1, { data: { materialId: 'a' } })]
      previous = makePlan({ ...profile, interests: ['Travel'] }, [], [], exposures, [...materials, material('travel', 'Travel')], previous, now + i)
      expect(previous.tasks).toHaveLength(4)
      expect(previous.tasks.every(task => task.done)).toBe(true)
      expect(previous.minutes).toBe(45)
    }
  })
  it('allows explicit pending-only invalidation while retaining completed tasks and their spent budget', () => {
    const materials = [material('a'), material('b', 'Travel')]
    const original = makePlan(profile, [], [], [], materials, undefined, now)
    const listened = original.tasks.find(task => task.kind === 'listen')!
    listened.done = true
    const changed = { ...profile, interests: ['Travel'] }
    const preserved = makePlan(changed, [], [], [], materials, original, now)
    expect(preserved.tasks.find(task => task.kind === 'learn')!.materialId).toBe('a')
    const invalidated = makePlan(changed, [], [], [], materials, { ...original, tasks: original.tasks.filter(task => task.done) }, now)
    expect(invalidated.tasks.find(task => task.kind === 'listen')).toEqual(listened)
    expect(invalidated.tasks.filter(task => task.kind === 'listen')).toHaveLength(1)
    expect(invalidated.tasks.find(task => task.kind === 'learn')!.materialId).toBe('b')
    expect(invalidated.minutes).toBe(45)
  })
  it('keeps pending queue IDs addressable while cards disappear, then creates one block for new due work', () => {
    const a = card('a'), b = card('b')
    const original = makePlan(profile, [], [a, b], [], [], undefined, now)
    const reviewId = original.tasks.find(task => task.kind === 'review')!.id
    const partial = makePlan(profile, [], [b], [], [], original, now + 1000)
    expect(partial.tasks.find(task => task.kind === 'review')!.id).toBe(reviewId)
    const empty = makePlan(profile, [], [], [], [], partial, now + 2000)
    expect(empty.tasks.find(task => task.id === reviewId)!.done).toBe(false)
    empty.tasks.find(task => task.id === reviewId)!.done = true
    const renewed = makePlan(profile, [], [card('new')], [], [], empty, now + 3000)
    expect(renewed.tasks.filter(task => task.kind === 'review')).toHaveLength(2)
    expect(renewed.tasks.find(task => task.id === reviewId)!.done).toBe(true)
    const repeated = makePlan(profile, [], [card('new')], [], [], renewed, now + 4000)
    expect(repeated.tasks.map(task => task.id)).toEqual(renewed.tasks.map(task => task.id))
  })
  it('offers repair at the actual retest due time and retains an active repair until explicit completion', () => {
    const failure: StudyEvent = { id: 'failure', timestamp: now, type: 'error-detected', source: 'ai', data: { errorId: 'error' } }
    const linked = { ...card('cloze'), modality: 'cloze' as const, errorId: 'error' }
    const original = makePlan(profile, [], [linked], [failure], [], undefined, now)
    const repairId = original.tasks.find(task => task.kind === 'repair')!.id
    linked.card.due = new Date(now + 600_000)
    const fresh = makePlan(profile, [], [linked], [failure], [], undefined, now + 1)
    expect(fresh.tasks.some(task => task.kind === 'repair')).toBe(false)
    const active = makePlan(profile, [], [linked], [failure], [], original, now + 1)
    expect(active.tasks.find(task => task.id === repairId)!.done).toBe(false)
    active.tasks.find(task => task.id === repairId)!.done = true
    const later = makePlan(profile, [], [linked], [failure], [], active, now + 600_001)
    expect(later.tasks.filter(task => task.kind === 'repair')).toHaveLength(2)
    expect(later.tasks.some(task => task.kind === 'repair' && !task.done)).toBe(true)
  })
})
