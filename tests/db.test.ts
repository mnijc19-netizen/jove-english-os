import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs'
import { db, JoveDatabase, version1Stores } from '../src/db/db'
import { addChunk, exportBackup, initialize, rebuildSkills, recordEvent, recordRepairAttempt, restoreBackup, reviewCard, saveError, REPAIR_RETEST_DELAY, REPAIR_TRANSFER_DELAY } from '../src/db/repository'
import { aggregateSkills } from '../src/domain/engine'
import { demoMaterials } from '../src/content/materials'
import { modalities } from '../src/db/schema'
import { defaultProfile, type AudioAsset, type Chunk, type StudyEvent } from '../src/domain/types'

const now = Date.UTC(2026, 8, 7, 4)
const seed = demoMaterials[0]
const phrase = seed.chunks[0]
const errorInput = { category: 'tense', original: 'I go yesterday.', corrected: 'I went yesterday.', hint: 'Past time.', explanation: 'Use the past tense.' }
const evidence = (id: string, extra: Partial<StudyEvent> = {}): StudyEvent => ({ id, type: 'test', timestamp: now, source: 'objective', skill: 'reading', score: 0.8, ...extra })
const readJson = (text: string) => JSON.parse(text)
const recording = (id = 'audio-1'): AudioAsset => ({ id, blob: new Blob(['recorded bytes'], { type: 'audio/webm' }), mimeType: 'audio/webm', createdAt: now, duration: 2, kind: 'recording', processed: false, label: 'Saved response' })

beforeEach(async () => {
  await db.delete()
  await db.open()
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await db.delete()
})

async function seedChunk(): Promise<Chunk> {
  await initialize([seed])
  return addChunk(phrase, seed.id)
}

describe('transactional persistence and FSRS', () => {
  it('initializes idempotently without overwriting learner settings, profile or content', async () => {
    await initialize(demoMaterials)
    await db.profiles.update('main', { name: 'Owner', fatigue: 0.8 })
    await db.settings.update('main', { 'value.theme': 'dark' })
    await db.materials.update(seed.id, { title: 'Personal title' })
    await initialize(demoMaterials)
    expect(await db.materials.count()).toBe(demoMaterials.length)
    expect(await db.profiles.get('main')).toMatchObject({ name: 'Owner', fatigue: 0.8 })
    expect((await db.settings.get('main'))!.value.theme).toBe('dark')
    expect((await db.materials.get(seed.id))!.title).toBe('Personal title')
    expect((await db.skills.toArray()).every(s => s.evidenceCount === 0)).toBe(true)
  })
  it('rolls back initialization when seed audio references are missing', async () => {
    await expect(initialize([{ ...seed, audioId: 'missing' }])).rejects.toThrow('audio')
    expect(await db.settings.count()).toBe(0)
    expect(await db.profiles.count()).toBe(0)
    expect(await db.materials.count()).toBe(0)
  })
  it('deduplicates concurrent phrase additions and creates exactly six independent cards', async () => {
    await initialize([seed, demoMaterials[1]])
    const [a, b] = await Promise.all([addChunk(phrase, seed.id), addChunk({ ...phrase, text: `  ${phrase.text.toUpperCase()}  ` }, demoMaterials[1].id)])
    expect(a.id).toBe(b.id)
    expect(await db.chunks.count()).toBe(1)
    expect((await db.chunks.get(a.id))!.sourceIds.sort()).toEqual([seed.id, demoMaterials[1].id].sort())
    const cards = await db.cards.toArray()
    expect(cards).toHaveLength(6)
    expect(new Set(cards.map(c => c.modality))).toEqual(new Set(modalities))
    expect(cards.every(c => c.card.due instanceof Date && c.card.reps === 0)).toBe(true)
    await expect(addChunk(phrase, 'missing-material')).rejects.toThrow('material')
    expect(await db.cards.count()).toBe(6)
  })
  it('replays identical events exactly once and rejects conflicting ID reuse', async () => {
    await initialize([])
    const e = evidence('stable', { data: { a: 1, b: 2 } })
    await Promise.all([recordEvent(e), recordEvent({ ...e, data: { b: 2, a: 1 } })])
    expect(await db.events.count()).toBe(1)
    expect((await db.skills.get('reading'))!.evidenceCount).toBe(1)
    const before = await exportBackup()
    await expect(recordEvent({ ...e, score: 0.1 })).rejects.toThrow('different evidence')
    expect(await exportBackup()).toBe(before)
  })
  it('rejects orphan events and rolls back an event when projection persistence fails', async () => {
    await initialize([])
    await expect(recordEvent(evidence('orphan', { chunkId: 'absent' }))).rejects.toThrow('chunk')
    const fail = vi.spyOn(db.skills, 'bulkPut').mockRejectedValueOnce(new Error('Simulated storage failure'))
    await expect(recordEvent(evidence('atomic'))).rejects.toThrow('storage failure')
    fail.mockRestore()
    expect(await db.events.count()).toBe(0)
    expect((await db.skills.get('reading'))!.evidenceCount).toBe(0)
  })
  it('rebuilds all projections deterministically across out-of-order arrivals and reloads', async () => {
    const chunk = await seedChunk()
    const first = evidence('first', { timestamp: now - 100, chunkId: chunk.id, modality: 'recognition', skill: 'chunkRecognition', score: 1 })
    const second = evidence('second', { chunkId: chunk.id, modality: 'recognition', skill: 'chunkRecognition', score: 0 })
    await recordEvent(second)
    await recordEvent(first)
    expect((await db.chunks.get(chunk.id))!.readingStrength).toBe(0.75)
    await db.skills.put({ id: 'chunkRecognition', score: 1, confidence: 1, evidenceCount: 9999, updatedAt: now })
    await db.chunks.update(chunk.id, { productionStrength: 1, spontaneousUses: 99 })
    await rebuildSkills()
    expect((await db.skills.toArray()).sort((a, b) => a.id.localeCompare(b.id))).toEqual(aggregateSkills([first, second]).sort((a, b) => a.id.localeCompare(b.id)))
    expect(await db.chunks.get(chunk.id)).toMatchObject({ productionStrength: 0, spontaneousUses: 0 })
    db.close()
    await db.open()
    expect(await db.events.count()).toBe(2)
    expect((await db.chunks.get(chunk.id))!.readingStrength).toBe(0.75)
  })
  it('uses the mature scheduler and changes only the reviewed modality', async () => {
    const chunk = await seedChunk()
    const before = (await db.cards.toArray()).find(c => c.modality === 'recognition')!
    const expected = fsrs({ enable_fuzz: false }).next(before.card, new Date(now), Rating.Good).card
    await reviewCard(before.id, 3, { source: 'objective', score: 1 })
    expect((await db.cards.get(before.id))!.card).toEqual(expected)
    expect((await db.cards.toArray()).filter(c => c.modality !== 'recognition').every(c => c.card.reps === 0)).toBe(true)
    expect(await db.chunks.get(chunk.id)).toMatchObject({ readingStrength: 1, productionStrength: 0, spontaneousUses: 0 })
    expect((await db.events.toArray())[0]).toMatchObject({ source: 'objective', modality: 'recognition', prompted: false, data: { rating: 3, scheduledRating: 3 } })
  })
  it('distinguishes prompted, self-report, text, acoustic and genuinely novel transfer evidence', async () => {
    const chunk = await seedChunk()
    const speaking = `${chunk.id}:speaking`, transfer = `${chunk.id}:transfer`
    const original = (await db.cards.get(speaking))!.card
    await reviewCard(speaking, 4, { source: 'acoustic', prompted: true, score: 1 })
    expect((await db.cards.get(speaking))!.card).toEqual(fsrs({ enable_fuzz: false }).next(original, now, Rating.Again).card)
    await reviewCard(speaking, 4) // No explicit provenance means self-report, never objective.
    await reviewCard(speaking, 4, { source: 'text', score: 1 })
    expect(await db.chunks.get(chunk.id)).toMatchObject({ productionStrength: 0, spontaneousUses: 0 })
    await reviewCard(speaking, 3, { source: 'acoustic', score: 0.8 })
    await reviewCard(transfer, 3, { source: 'objective', score: 1, contextId: 'airport' })
    await reviewCard(transfer, 3, { source: 'objective', score: 1, contextId: 'airport' })
    expect((await db.chunks.get(chunk.id))!.spontaneousUses).toBe(2)
    expect((await db.skills.get('realWorld'))!.evidenceCount).toBe(1)
    expect((await db.cards.get(transfer))!.contextIds).toEqual(['airport'])
    expect((await db.events.toArray()).filter(e => e.source === 'self-report')).toHaveLength(1)
  })
  it('rolls back scheduling if event projection fails and rejects backwards review clocks', async () => {
    const chunk = await seedChunk()
    const id = `${chunk.id}:recall`, before = await db.cards.get(id)
    const fail = vi.spyOn(db.skills, 'bulkPut').mockRejectedValueOnce(new Error('disk full'))
    await expect(reviewCard(id, 3)).rejects.toThrow('disk full')
    fail.mockRestore()
    expect(await db.cards.get(id)).toEqual(before)
    expect(await db.events.count()).toBe(0)
    await reviewCard(id, 3)
    vi.mocked(Date.now).mockReturnValue(now - 1)
    await expect(reviewCard(id, 3)).rejects.toThrow('clock')
    expect((await db.cards.get(id))!.card.reps).toBe(1)
  })
  it('accepts assessment IDs as evidence sessions and round-trips their foreign keys', async () => {
    await initialize([])
    await db.assessments.put({ id: 'assessment-session', timestamp: now, variant: 1, stage: 'retell', responses: {}, scores: {} })
    await recordEvent(evidence('assessed', { sessionId: 'assessment-session' }))
    const b = await exportBackup()
    await restoreBackup(b)
    expect((await db.events.get('assessed'))!.sessionId).toBe('assessment-session')
    const orphan = readJson(b)
    orphan.tables.assessments = []
    await expect(restoreBackup(JSON.stringify(orphan))).rejects.toThrow('session')
    expect(await exportBackup()).toBe(b)
  })
  it('persists AI audio/transcript flags while keeping text and acoustic provenance separate', async () => {
    const chunk = await seedChunk(), id = `${chunk.id}:speaking`
    await reviewCard(id, 3, { source: 'ai', score: 1, audioObserved: true })
    expect((await db.chunks.get(chunk.id))!.spontaneousUses).toBe(0)
    await reviewCard(id, 3, { source: 'ai', score: 0.8, audioObserved: true, transcriptVerified: true })
    expect((await db.chunks.get(chunk.id))!.spontaneousUses).toBe(1)
    await reviewCard(id, 3, { source: 'text', score: 1, audioObserved: true, transcriptVerified: true })
    expect((await db.chunks.get(chunk.id))!.spontaneousUses).toBe(1)
    expect((await db.events.where('type').equals('review').filter(e => e.data?.cardId === id && e.data?.previousReps === 1).first())!.data)
      .toMatchObject({ audioObserved: true, transcriptVerified: true })
    for (const skill of ['pronunciation', 'prosody', 'speakingFluency'] as const) expect((await db.skills.get(skill))!.evidenceCount).toBe(0)
  })
  it('records error recurrence and prompted repairs from idempotent events', async () => {
    await initialize([])
    const first = await saveError(errorInput), repeat = await saveError(errorInput)
    expect(repeat.id).toBe(first.id)
    expect(repeat).toMatchObject({ attempts: 2, failures: 2, spontaneousSuccesses: 0 })
    const retry = evidence('retry', { source: 'text', prompted: true, skill: 'grammarProduction', chunkId: first.chunkId, modality: 'cloze', score: 1, data: { errorId: first.id } })
    await recordEvent(retry)
    await recordEvent(retry)
    expect(await db.errors.get(first.id)).toMatchObject({ attempts: 3, failures: 2, spontaneousSuccesses: 0 })
    await reviewCard(`${first.chunkId}:transfer`, 3, { source: 'objective', contextId: 'new-scenario', score: 1 })
    expect(await db.errors.get(first.id)).toMatchObject({ attempts: 4, failures: 2, spontaneousSuccesses: 1 })
    await rebuildSkills()
    expect((await db.errors.get(first.id))!.attempts).toBe(4)
  })
  it('keeps historical error evidence exportable when a correction is revised', async () => {
    await initialize([])
    const first = await saveError(errorInput)
    const revised = await saveError({ ...errorInput, corrected: 'Yesterday, I went there.' })
    expect(revised.id).toBe(first.id)
    expect(revised.chunkId).not.toBe(first.chunkId)
    expect((await db.cards.where('chunkId').equals(first.chunkId!).toArray()).every(card => !card.errorId)).toBe(true)
    const backup = await exportBackup()
    await restoreBackup(backup)
    expect((await db.errors.get(first.id))!.attempts).toBe(2)
    expect(await db.chunks.count()).toBe(2)
  })
})

describe('repair retests and review submission concurrency', () => {
  it('schedules prompted full sentences at ten minutes/two days without changing FSRS or unrelated cards', async () => {
    const unrelated = await seedChunk()
    await reviewCard(`${unrelated.id}:recognition`, 4)
    const error = await saveError(errorInput)
    const before = await db.cards.toArray()
    const attempt = await recordRepairAttempt(error.id, { eventId: 'repair-1', response: error.corrected, contextId: 'original-context' })
    expect(attempt).toMatchObject({ id: 'repair-1', source: 'text', score: 1, prompted: true })
    for (const old of before) {
      const current = (await db.cards.get(old.id))!
      if (old.errorId !== error.id) expect(current).toEqual(old)
      else {
        const delay = old.modality === 'transfer' ? REPAIR_TRANSFER_DELAY : REPAIR_RETEST_DELAY
        expect(current.card).toEqual({ ...old.card, due: new Date(now + delay) })
        expect(current.contextIds).toContain('original-context')
      }
    }
    expect(await db.errors.get(error.id)).toMatchObject({ attempts: 2, failures: 1, spontaneousSuccesses: 0, nextReview: now + REPAIR_RETEST_DELAY })
    expect(await db.chunks.get(error.chunkId!)).toMatchObject({ productionStrength: 0, spontaneousUses: 0 })
    expect(await db.events.get('repair-1')).toMatchObject({ source: 'text', prompted: true, score: 1, data: { response: error.corrected, fullSentence: true } })
  })
  it('does not defer cards for incomplete, incorrect or self-reported repairs', async () => {
    await initialize([])
    const error = await saveError(errorInput), before = await db.cards.toArray()
    const partial = await recordRepairAttempt(error.id, { eventId: 'partial', response: 'went' })
    expect(partial.score).toBe(0)
    await recordRepairAttempt(error.id, { eventId: 'wrong', response: 'I went tomorrow.' })
    await recordEvent(evidence('self', { type: 'SPEAK_RETRY', source: 'self-report', prompted: true, score: 1, chunkId: error.chunkId,
      modality: 'cloze', data: { errorId: error.id, fullSentence: true } }))
    expect(await db.cards.toArray()).toEqual(before)
    expect((await db.events.get('partial'))!.score).toBe(0)
    expect((await db.errors.get(error.id))!.failures).toBe(3)
  })
  it('preserves a linked card\'s mature FSRS memory state when a full-sentence retry defers its retest', async () => {
    await initialize([])
    const error = await saveError(errorInput), id = `${error.chunkId}:speaking`
    await reviewCard(id, 4, { source: 'objective', score: 1, contextId: 'earlier-speaking' })
    const before = (await db.cards.get(id))!
    const strength = (await db.chunks.get(error.chunkId!))!.productionStrength
    expect(before.card.reps).toBe(1)
    await recordEvent({ id: 'legacy-full-retry', type: 'SPEAK_RETRY', source: 'text', timestamp: now, prompted: true,
      skill: 'grammarProduction', modality: 'cloze', chunkId: error.chunkId, score: 1, data: { errorId: error.id, fullSentence: true } })
    expect((await db.cards.get(id))!.card).toEqual({ ...before.card, due: new Date(now + REPAIR_RETEST_DELAY) })
    expect((await db.chunks.get(error.chunkId!))!.productionStrength).toBe(strength)
  })
  it('preserves meaningful signs when checking an exact full sentence', async () => {
    await initialize([])
    const error = await saveError({ ...errorInput, corrected: 'The temperature is -5 degrees.' })
    await recordRepairAttempt(error.id, { eventId: 'wrong-sign', response: 'The temperature is 5 degrees.' })
    expect((await db.events.get('wrong-sign'))!.score).toBe(0)
  })
  it('is idempotent under concurrent retries and rejects conflicting repair IDs', async () => {
    await initialize([])
    const error = await saveError(errorInput), input = { eventId: 'once', response: error.corrected }
    await Promise.all([recordRepairAttempt(error.id, input), recordRepairAttempt(error.id, input)])
    const before = await exportBackup()
    vi.mocked(Date.now).mockReturnValue(now + 1000)
    await recordRepairAttempt(error.id, input)
    expect((await db.errors.get(error.id))!.attempts).toBe(2)
    expect((await db.cards.get(`${error.chunkId}:cloze`))!.card.due.getTime()).toBe(now + REPAIR_RETEST_DELAY)
    await expect(recordRepairAttempt(error.id, { ...input, response: 'different sentence' })).rejects.toThrow('already used')
    vi.mocked(Date.now).mockReturnValue(now)
    expect(await exportBackup()).toBe(before)
  })
  it('rolls back the attempt and all due dates if projection persistence fails', async () => {
    await initialize([])
    const error = await saveError(errorInput), before = await exportBackup()
    const fail = vi.spyOn(db.skills, 'bulkPut').mockRejectedValueOnce(new Error('Storage rejected write'))
    await expect(recordRepairAttempt(error.id, { eventId: 'atomic-repair', response: error.corrected })).rejects.toThrow('Storage')
    fail.mockRestore()
    expect(await exportBackup()).toBe(before)
  })
  it('retains future retests through rebuild, reload and a backup restore', async () => {
    await initialize([])
    const error = await saveError(errorInput)
    await recordRepairAttempt(error.id, { eventId: 'delayed', response: error.corrected })
    const before = await db.cards.toArray(), backup = await exportBackup()
    await rebuildSkills()
    db.close(); await db.open()
    await restoreBackup(backup)
    expect(await db.cards.toArray()).toEqual(before)
    expect((await db.errors.get(error.id))!.nextReview).toBe(now + REPAIR_RETEST_DELAY)
  })
  it('does not let an older repair overwrite a newer independent FSRS result', async () => {
    await initialize([])
    const error = await saveError(errorInput), id = `${error.chunkId}:transfer`
    await recordRepairAttempt(error.id, { eventId: 'repair', response: error.corrected, contextId: 'repair-context' })
    vi.mocked(Date.now).mockReturnValue(now + REPAIR_TRANSFER_DELAY)
    const current = (await db.cards.get(id))!
    const expected = fsrs({ enable_fuzz: false }).next(current.card, now + REPAIR_TRANSFER_DELAY, Rating.Good).card
    await reviewCard(id, 3, { source: 'objective', score: 1, contextId: 'novel-context', expectedReps: 0 })
    expect((await db.cards.get(id))!.card).toEqual(expected)
    await recordRepairAttempt(error.id, { eventId: 'late-historical-repair', response: error.corrected, timestamp: now + 1 })
    expect((await db.cards.get(id))!.card).toEqual(expected)
    expect((await db.errors.get(error.id))!.spontaneousSuccesses).toBe(1)
  })
  it.each([
    { source: 'self-report' as const, contextId: 'fresh-context' },
    { source: 'text' as const, contextId: 'fresh-context', audioObserved: true, transcriptVerified: true },
    { source: 'ai' as const, contextId: 'fresh-context', audioObserved: true },
    { source: 'objective' as const },
    { source: 'objective' as const, contextId: 'original-context' },
    { source: 'objective' as const, contextId: '  ORIGINAL-CONTEXT  ' },
  ])('does not graduate a linked transfer with insufficient provenance/context: %j', async options => {
    await initialize([])
    const error = await saveError(errorInput), id = `${error.chunkId}:transfer`
    await recordRepairAttempt(error.id, { eventId: 'repair', response: error.corrected, contextId: 'original-context' })
    vi.mocked(Date.now).mockReturnValue(now + REPAIR_TRANSFER_DELAY)
    const card = (await db.cards.get(id))!.card
    await reviewCard(id, 4, { ...options, score: 1 })
    expect((await db.cards.get(id))!.card).toEqual(fsrs({ enable_fuzz: false }).next(card, now + REPAIR_TRANSFER_DELAY, Rating.Again).card)
    expect((await db.errors.get(error.id))!.spontaneousSuccesses).toBe(0)
  })
  it('ignores only the current immutable response when checking context novelty across modalities', async () => {
    const chunk = await seedChunk(), id = `${chunk.id}:transfer`
    await recordEvent({ id: `review-response:${id}:0`, type: 'REVIEW_RESPONSE', timestamp: now, source: 'text',
      chunkId: chunk.id, modality: 'transfer', contextId: 'new-context', data: { response: 'My complete answer.' } })
    await reviewCard(id, 3, { expectedReps: 0, source: 'objective', score: 1, contextId: 'new-context' })
    expect((await db.events.where('type').equals('review').filter(e => e.data?.cardId === id && e.data?.previousReps === 0).first())!.data?.novelContext).toBe(true)
    await recordEvent(evidence('old-exposure', { chunkId: chunk.id, modality: 'speaking', source: 'self-report', contextId: 'known-elsewhere' }))
    await reviewCard(id, 3, { expectedReps: 1, source: 'objective', score: 1, contextId: 'known-elsewhere' })
    expect((await db.events.where('type').equals('review').filter(e => e.data?.cardId === id && e.data?.previousReps === 1).first())!.data?.novelContext).toBe(false)
    expect((await db.skills.get('realWorld'))!.evidenceCount).toBe(1)
  })
  it('schedules exactly once for expectedReps, keeps the response, and rejects a future expected counter', async () => {
    const chunk = await seedChunk(), id = `${chunk.id}:recall`
    const responseId = `review-response:${id}:0`
    await recordEvent({ id: responseId, type: 'REVIEW_RESPONSE', timestamp: now, source: 'text', chunkId: chunk.id,
      modality: 'recall', data: { response: phrase.text } })
    const options = { eventId: 'stable-review-attempt', expectedReps: 0, source: 'text' as const, score: 1 }
    await Promise.all([reviewCard(id, 3, options), reviewCard(id, 3, options)])
    expect((await db.cards.get(id))!.card.reps).toBe(1)
    expect(await db.events.get(responseId)).toBeDefined()
    expect(await db.events.where('type').equals('review').count()).toBe(1)
    const before = await exportBackup()
    await reviewCard(id, 3, options)
    await expect(reviewCard(id, 3, { expectedReps: 2 })).rejects.toThrow('below the expected')
    expect(await exportBackup()).toBe(before)
  })
  it('does not let an advanced repetition counter substitute for this attempt’s evidence', async () => {
    const chunk = await seedChunk(), id = `${chunk.id}:recall`
    await reviewCard(id, 3)
    const event = (await db.events.where('type').equals('review').first())!
    expect(event.id).toMatch(/^review:[a-f0-9-]{36}$/)
    expect(event.data).toMatchObject({ attemptId: event.id, previousReps: 0 })
    await expect(reviewCard(id, 3, { expectedReps: 0, eventId: 'another-attempt' })).rejects.toThrow('another device')
    expect(await db.events.where('type').equals('review').count()).toBe(1)
  })
  it('recovers an actual matching aliased attempt before comparing rebased repetitions', async () => {
    const chunk = await seedChunk(), id = `${chunk.id}:recall`
    await reviewCard(id, 3, { eventId: 'projected-review', expectedReps: 0 })
    await db.syncMeta.bulkPut([{ id: 'cardAliases', value: { 'old-card': id } },
      { id: 'eventAliases', value: { 'original-review': ['projected-review'] } }])
    await reviewCard('old-card', 3, { eventId: 'original-review', expectedReps: 0 })
    expect(await db.events.where('type').equals('review').count()).toBe(1)
    await expect(reviewCard('old-card', 4, { eventId: 'original-review', expectedReps: 0 })).rejects.toThrow('already used')
  })
  it('keeps expectedReps retryable when scheduling fails after the answer was saved', async () => {
    const chunk = await seedChunk(), id = `${chunk.id}:recall`
    const responseId = `review-response:${id}:0`
    await recordEvent({ id: responseId, type: 'REVIEW_RESPONSE', timestamp: now, source: 'text', chunkId: chunk.id, modality: 'recall', data: { response: 'Saved answer' } })
    const fail = vi.spyOn(db.skills, 'bulkPut').mockRejectedValueOnce(new Error('disk full'))
    await expect(reviewCard(id, 3, { expectedReps: 0 })).rejects.toThrow('disk full')
    fail.mockRestore()
    expect((await db.cards.get(id))!.card.reps).toBe(0)
    expect(await db.events.get(responseId)).toBeDefined()
    await reviewCard(id, 3, { expectedReps: 0 })
    expect((await db.cards.get(id))!.card.reps).toBe(1)
  })
  it('validates review options without coercing flags, accepting injected context claims, or missing audio', async () => {
    const chunk = await seedChunk(), id = `${chunk.id}:speaking`
    const invalid = [{ expectedReps: -1 }, { expectedReps: 0.5 }, { source: 'invented' }, { contextId: ' ' },
      { audioObserved: 'true' }, { transcriptVerified: 1 }, { novelContext: true }, { score: 1.1 }]
    for (const options of invalid) await expect(reviewCard(id, 3, options as Parameters<typeof reviewCard>[2])).rejects.toThrow()
    await expect(reviewCard(id, 3, { audioId: 'missing', source: 'ai', audioObserved: true, transcriptVerified: true })).rejects.toThrow('saved recording')
    await db.audio.put(recording())
    await reviewCard(id, 3, { eventId: 'review-operation', source: 'ai', audioId: 'audio-1', audioObserved: true, transcriptVerified: true })
    await reviewCard(id, 3, { eventId: 'review-operation', source: 'ai', audioId: 'audio-1', audioObserved: true, transcriptVerified: true })
    expect((await db.cards.get(id))!.card.reps).toBe(1)
    expect((await db.events.get('review-operation'))!.data?.audioId).toBe('audio-1')
    await expect(reviewCard(id, 4, { eventId: 'review-operation' })).rejects.toThrow('already used')
  })
})

describe('allowlisted, atomic backup/restore', () => {
  it('round-trips legacy and new optional rubric scores while rejecting unknown rubric fields', async () => {
    await initialize([])
    const evaluation = { summary: 'Language feedback', strengths: [], errors: [], comprehension: null, accuracy: 0.8, fluency: null, successfulChunks: [], nextPrompt: 'Try a new situation.' }
    await db.conversations.put({ id: 'legacy', mode: 'free', scenario: 'Travel', messages: [], startedAt: now, evaluation })
    await db.conversations.put({ id: 'rubric', mode: 'free', scenario: 'Travel', messages: [], startedAt: now,
      evaluation: { ...evaluation, rubricScores: { vocabulary: 0.8, interaction: null, taskCompletion: 1 } } })
    const before = await exportBackup()
    await restoreBackup(before)
    expect((await db.conversations.get('legacy'))!.evaluation).not.toHaveProperty('rubricScores')
    expect((await db.conversations.get('rubric'))!.evaluation).toHaveProperty('rubricScores', { vocabulary: 0.8, interaction: null, taskCompletion: 1 })
    for (const invalid of [{ vocabulary: 0.8 }, { vocabulary: 2, interaction: null, taskCompletion: 1 }, { vocabulary: 0.8, interaction: null, taskCompletion: 1, pronunciation: 1 }]) {
      const backup = readJson(before)
      backup.tables.conversations.find((c: { id: string }) => c.id === 'rubric').evaluation.rubricScores = invalid
      await expect(restoreBackup(JSON.stringify(backup))).rejects.toThrow()
      expect(await exportBackup()).toBe(before)
    }
  })
  it('round-trips persisted entities, FSRS Dates and references while excluding credentials and blobs', async () => {
    const chunk = await seedChunk()
    await db.secrets.put({ id: 'openrouter', value: 'test-only-credential-marker' })
    await db.audio.put(recording())
    await db.materials.update(seed.id, { audioId: 'audio-1' })
    await db.sessions.put({ id: 'session', kind: 'listen', materialId: seed.id, startedAt: now, stage: 'draft', draft: { answer: 'Saved answer', audioId: 'audio-1' } })
    await db.conversations.put({ id: 'conversation', mode: 'free', scenario: 'Travel', startedAt: now, messages: [{ id: 'message', role: 'user', text: 'Saved sentence', timestamp: now, audioId: 'audio-1' }] })
    await db.assessments.put({ id: 'assessment', timestamp: now, variant: 0, stage: 'listen', responses: { meaning: 'Help' }, scores: { meaning: 0.8 } })
    await db.usage.put({ id: 'usage', timestamp: now, model: 'test', purpose: 'evaluate', cost: null, tokens: 12 })
    await reviewCard(`${chunk.id}:recognition`, 3, { source: 'objective' })
    await recordEvent(evidence('recorded', { sessionId: 'session', data: { audioId: 'audio-1' } }))
    const backup = await exportBackup(), parsed = readJson(backup)
    expect(backup).not.toContain('test-only-credential-marker')
    expect(backup).not.toContain('"secrets"')
    expect(backup).not.toContain('"blob"')
    expect(parsed.audioPolicy).toBe('blobs-omitted')
    expect(typeof parsed.tables.cards.find((c: { modality: string }) => c.modality === 'recognition').card.due).toBe('string')
    await db.profiles.update('main', { name: 'temporary' })
    await restoreBackup(backup)
    expect((await db.profiles.get('main'))!.name).toBe('Jove')
    expect((await db.cards.get(`${chunk.id}:recognition`))!.card.last_review).toBeInstanceOf(Date)
    expect((await db.cards.get(`${chunk.id}:recognition`))!.card.due).toBeInstanceOf(Date)
    expect((await db.audio.get('audio-1'))!.blob.size).toBe(recording().blob.size)
    expect((await db.secrets.get('openrouter'))!.value).toBe('test-only-credential-marker')
    expect((await db.sessions.get('session'))!.draft.answer).toBe('Saved answer')
    expect((await db.conversations.get('conversation'))!.messages[0].audioId).toBe('audio-1')
    expect(await db.usage.count()).toBe(1)
    await reviewCard(`${chunk.id}:recognition`, 3)
    expect((await db.cards.get(`${chunk.id}:recognition`))!.card.reps).toBe(2)
  })
  it('accepts epoch FSRS dates and normalizes them back into Date instances', async () => {
    const chunk = await seedChunk()
    await reviewCard(`${chunk.id}:listening`, 3)
    const b = readJson(await exportBackup())
    for (const row of b.tables.cards) { row.card.due = Date.parse(row.card.due); if (row.card.last_review) row.card.last_review = Date.parse(row.card.last_review) }
    await restoreBackup(JSON.stringify(b))
    expect((await db.cards.toArray()).every(c => c.card.due instanceof Date)).toBe(true)
    expect((await db.cards.get(`${chunk.id}:listening`))!.card.last_review!.getTime()).toBe(now)
  })
  it('round-trips minimum and maximum supported ISO dates without numeric coercion', async () => {
    await seedChunk()
    const b = readJson(await exportBackup())
    b.tables.cards[0].card.due = 0
    b.tables.cards[1].card.due = 253_402_300_799_999
    await restoreBackup(JSON.stringify(b))
    const exported = await exportBackup()
    await restoreBackup(exported)
    expect((await db.cards.get(b.tables.cards[0].id))!.card.due.getTime()).toBe(0)
    expect((await db.cards.get(b.tables.cards[1].id))!.card.due.getTime()).toBe(253_402_300_799_999)
  })
  it('rebuilds derived scores instead of trusting fabricated imported mastery', async () => {
    const chunk = await seedChunk()
    const b = readJson(await exportBackup())
    b.tables.skills.forEach((s: { score: number; confidence: number; evidenceCount: number }) => { s.score = 1; s.confidence = 1; s.evidenceCount = 999 })
    b.tables.chunks[0].productionStrength = 1
    b.tables.chunks[0].spontaneousUses = 999
    await restoreBackup(JSON.stringify(b))
    expect((await db.skills.toArray()).every(s => s.evidenceCount === 0)).toBe(true)
    expect(await db.chunks.get(chunk.id)).toMatchObject({ productionStrength: 0, spontaneousUses: 0 })
  })
  it('preserves local recordings and detaches unavailable imported audio without losing draft text', async () => {
    await seedChunk()
    await db.audio.put(recording())
    await db.materials.update(seed.id, { audioId: 'audio-1' })
    await db.sessions.put({ id: 'draft', kind: 'listen', startedAt: now, stage: 'retry', draft: { answer: 'Keep this answer', audioId: 'audio-1', nested: { audioIds: ['audio-1'] } } })
    await db.conversations.put({ id: 'c', mode: 'free', scenario: 'travel', startedAt: now, messages: [{ id: 'm', role: 'user', text: 'Keep this message', timestamp: now, audioId: 'audio-1' }] })
    await recordEvent(evidence('audio-evidence', { source: 'acoustic', data: { audioId: 'audio-1' } }))
    const backup = await exportBackup()
    await db.audio.clear()
    await db.audio.put(recording('local-unprocessed'))
    await restoreBackup(backup)
    expect(await db.audio.get('audio-1')).toBeUndefined()
    expect((await db.audio.get('local-unprocessed'))!.processed).toBe(false)
    expect((await db.materials.get(seed.id))!.audioId).toBeUndefined()
    expect((await db.sessions.get('draft'))!.draft).toMatchObject({ answer: 'Keep this answer', audioUnavailable: true, missingAudioIds: ['audio-1'] })
    expect((await db.conversations.get('c'))!.messages[0]).toMatchObject({ text: 'Keep this message' })
    expect((await db.conversations.get('c'))!.messages[0].audioId).toBeUndefined()
    expect((await db.events.get('audio-evidence'))!.data).toMatchObject({ audioId: 'audio-1', audioAvailable: false })
    await recordEvent(evidence('audio-evidence', { source: 'acoustic', data: { audioId: 'audio-1' } }))
    expect(await db.events.count()).toBe(1)
    await expect(exportBackup()).resolves.toContain('blobs-omitted')
  })
  const attacks: [string, (b: ReturnType<typeof readJson>) => void][] = [
    ['unknown root', b => { b.unknown = true }],
    ['secret table', b => { b.tables.secrets = [{ id: 'openrouter', value: 'injected-placeholder' }] }],
    ['unknown settings field', b => { b.tables.settings[0].value.apiKey = 'injected-placeholder' }],
    ['unknown card field', b => { b.tables.cards[0].card.extra = 1 }],
    ['nested secret injection', b => { b.tables.sessions = [{ id: 's', kind: 'draft', startedAt: now, stage: 'new', draft: { nested: { authorization: 'injected-placeholder' } } }] }],
    ['prototype pollution', b => { b.tables.sessions = [{ id: 's', kind: 'draft', startedAt: now, stage: 'new', draft: JSON.parse('{"__proto__":{"polluted":true}}') }] }],
    ['unknown schema version', b => { b.schemaVersion = 999 }],
    ['unknown backup version', b => { b.version = 999 }],
    ['invalid date string', b => { b.tables.cards[0].card.due = 'not-a-date' }],
    ['null date', b => { b.tables.cards[0].card.due = null }],
    ['overflow date', b => { b.tables.cards[0].card.due = 8_640_000_000_000_001 }],
    ['impossible calendar date', b => { b.tables.cards[0].card.due = '2026-02-30T00:00:00.000Z' }],
    ['negative score', b => { b.tables.skills[0].score = -0.1 }],
    ['difficulty over boundary', b => { b.tables.materials[0].difficulty = 1.01 }],
    ['unsafe source URL', b => { b.tables.materials[0].sourceUrl = 'javascript:alert(1)' }],
    ['unsafe audio path', b => { b.tables.materials[0].audioPath = 'data:audio/wav;base64,AAAA' }],
    ['orphan card chunk', b => { b.tables.cards[0].chunkId = 'missing' }],
    ['orphan chunk source', b => { b.tables.chunks[0].sourceIds = ['missing'] }],
    ['orphan material audio', b => { b.tables.materials[0].audioId = 'missing' }],
    ['orphan event session', b => { b.tables.events = [evidence('orphan', { sessionId: 'missing' })] }],
    ['orphan event material', b => { b.tables.events = [evidence('orphan', { data: { materialId: 'missing' } })] }],
    ['orphan draft conversation', b => { b.tables.sessions = [{ id: 's', kind: 'draft', startedAt: now, stage: 'new', draft: { conversationId: 'missing' } }] }],
    ['orphan draft audio', b => { b.tables.sessions = [{ id: 's', kind: 'draft', startedAt: now, stage: 'new', draft: { nested: { audioIds: ['missing'] } } }] }],
    ['event/card mismatch', b => { b.tables.events = [evidence('wrong-card', { chunkId: b.tables.cards[0].chunkId, modality: 'transfer', data: { cardId: b.tables.cards.find((c: { modality: string }) => c.modality === 'recognition').id } })] }],
    ['duplicate IDs', b => { b.tables.chunks.push(b.tables.chunks[0]) }],
    ['duplicate modality', b => { b.tables.cards.push({ ...b.tables.cards[0], id: 'different-id' }) }],
    ['invalid FSRS counters', b => { b.tables.cards[0].card.lapses = 1 }],
    ['wrong typed date', b => { b.tables.events = [{ ...evidence('bad'), timestamp: String(now) }] }],
  ]
  it.each(attacks)('rejects %s without changing current data', async (_name, mutate) => {
    await seedChunk()
    await db.secrets.put({ id: 'openrouter', value: 'preserved-test-placeholder' })
    const before = await exportBackup(), b = readJson(before)
    mutate(b)
    await expect(restoreBackup(JSON.stringify(b))).rejects.toThrow()
    expect(await exportBackup()).toBe(before)
    expect((await db.secrets.get('openrouter'))!.value).toBe('preserved-test-placeholder')
  })
  it('rejects truncated JSON, excessive nesting and non-finite/out-of-range event numbers', async () => {
    await seedChunk()
    const before = await exportBackup()
    await expect(restoreBackup(before.slice(0, -1))).rejects.toThrow('JSON')
    const b = readJson(before)
    let nested: Record<string, unknown> = {}
    for (let i = 0; i < 45; i++) nested = { nested }
    b.tables.sessions = [{ id: 's', kind: 'draft', startedAt: now, stage: 'new', draft: nested }]
    await expect(restoreBackup(JSON.stringify(b))).rejects.toThrow('structural')
    for (const score of [NaN, Infinity, -0.01, 1.01]) await expect(recordEvent(evidence('bad', { score }))).rejects.toThrow()
    expect(await exportBackup()).toBe(before)
  })
  it('aborts the entire replacement on a write error after tables have been cleared', async () => {
    await seedChunk()
    await db.profiles.put({ ...defaultProfile(), name: 'Current owner' })
    const before = await exportBackup(), incoming = readJson(before)
    incoming.tables.profiles[0].name = 'Imported owner'
    const fail = vi.spyOn(db.skills, 'bulkPut').mockRejectedValueOnce(new Error('Quota exhausted'))
    await expect(restoreBackup(JSON.stringify(incoming))).rejects.toThrow('Quota')
    fail.mockRestore()
    expect(await exportBackup()).toBe(before)
  })
})

describe('versioned migration', () => {
  it('upgrades a real V1 database, normalizes dates and conservatively migrates provenance', async () => {
    const name = `jove-migration-${crypto.randomUUID()}`
    const legacy = new Dexie(name)
    legacy.version(1).stores(version1Stores)
    await legacy.open()
    const chunk: Chunk = { id: 'chunk', text: phrase.text, meaningEn: phrase.meaningEn, meaningZh: phrase.meaningZh, sourceSentence: phrase.example, examples: [phrase.example], register: 'neutral', sourceIds: [seed.id], readingStrength: 1, listeningStrength: 1, recallStrength: 1, productionStrength: 1, spontaneousUses: 5, createdAt: now }
    await legacy.table('materials').put(seed)
    await legacy.table('chunks').put(chunk)
    const scheduled = fsrs({ enable_fuzz: false }).next(createEmptyCard(now), now, Rating.Good).card
    const serialized = readJson(JSON.stringify(scheduled)); delete serialized.learning_steps
    await legacy.table('cards').put({ id: 'original-card', chunkId: chunk.id, modality: 'recognition', card: serialized })
    const oldEvent = readJson(JSON.stringify(evidence('legacy', { skill: 'chunkProduction', chunkId: chunk.id, modality: 'speaking' }))); delete oldEvent.source; delete oldEvent.prompted
    await legacy.table('events').put(oldEvent)
    legacy.close()
    const upgraded = new JoveDatabase(name)
    try {
      await upgraded.open()
      expect(upgraded.verno).toBe(3)
      expect(await upgraded.syncOperations.count()).toBe(0)
      expect(await upgraded.syncSnapshots.count()).toBe(0)
      expect(await upgraded.cards.count()).toBe(6)
      expect((await upgraded.cards.get('original-card'))!.card).toMatchObject({ due: scheduled.due, last_review: scheduled.last_review, reps: 1, learning_steps: 0 })
      expect((await upgraded.cards.toArray()).filter(c => c.id !== 'original-card').every(c => c.card.reps === 0)).toBe(true)
      expect(await upgraded.events.get('legacy')).toMatchObject({ source: 'self-report', prompted: true })
      expect(await upgraded.chunks.get('chunk')).toMatchObject({ productionStrength: 0, spontaneousUses: 0 })
      expect((await upgraded.skills.get('chunkProduction'))!.evidenceCount).toBe(0)
    } finally { await upgraded.delete() }
  })
  it('aborts a corrupt migration and leaves the previous schema and records recoverable', async () => {
    const name = `jove-corrupt-migration-${crypto.randomUUID()}`
    const legacy = new Dexie(name)
    legacy.version(1).stores(version1Stores)
    await legacy.open()
    await legacy.table('cards').put({ id: 'bad', chunkId: 'c', modality: 'recognition', contextIds: [], card: { ...createEmptyCard(now), due: 'corrupt' } })
    await legacy.table('profiles').put({ ...defaultProfile(), name: 'Recoverable owner' })
    legacy.close()
    const upgraded = new JoveDatabase(name)
    await expect(upgraded.open()).rejects.toThrow()
    upgraded.close()
    const check = new Dexie(name)
    try {
      await check.open()
      expect(check.verno).toBe(1)
      expect((await check.table('profiles').get('main')).name).toBe('Recoverable owner')
      expect((await check.table('cards').get('bad')).card.due).toBe('corrupt')
    } finally { await check.delete() }
  })
})
