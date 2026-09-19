import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { japaneseSource, japaneseStarterLessons, japaneseStarterMaterials, japaneseLessons, japaneseMaterials } from '../src/content/japanese'
import { kanaMorae, japanesePlacement, japanesePlacementItems, japaneseTextUnits, japaneseReadingSupport, nextJapaneseLesson } from '../src/domain/japanese'
import { materialSchema } from '../src/db/schema'
import { initializeJapanese } from '../src/db/japanese'
import { createLearningRepository, exportBackup, restoreBackup } from '../src/db/repository'
import { demoMaterials } from '../src/content/materials'
import { JoveDatabase } from '../src/db/db'
import { SyncJournal } from '../src/sync/journal'
import { changedFields, type RecordValue } from '../src/sync/protocol'
import type { StudyEvent } from '../src/domain/types'

const now = Date.UTC(2026, 8, 20), databases: JoveDatabase[] = []
afterEach(async () => { for (const db of databases.splice(0)) await db.delete() })
function database(language: 'en' | 'ja') { const db = new JoveDatabase(`japanese-test-${crypto.randomUUID()}`, language); databases.push(db); return db }
const reflection = (id: string, timestamp = now): StudyEvent => ({ id: `reflection:${id}`, sessionId: `session:${id}`, timestamp,
  type: 'EXTERNAL_LISTEN_REFLECTION', source: 'self-report', data: { materialId: id, listened: true, playbackObserved: false,
    comprehensionVerified: false, response: 'Meaning in my own words', expression: 'お願いします', example: 'もう一度お願いします。', audioId: 'retained-recording' } })
function readingAttempt(id: string, timestamp: number, response = 'ガッコウ', prompted = false, scheduledRating = 3): StudyEvent[] {
  return [{ id: `${id}:response`, type: 'REVIEW_RESPONSE', source: 'self-report', timestamp: timestamp - 1, sessionId: id, chunkId: 'word', modality: 'recall', prompted, data: { response } },
    { id: `${id}:rating`, type: 'review', source: 'self-report', timestamp, sessionId: id, chunkId: 'word', modality: 'recall', prompted, data: { responseEventId: `${id}:response`, scheduledRating } }]
}

describe('Japanese-specific source and practice support', () => {
  it('extends the preserved starter course through two ordered graded books with original support', () => {
    const materials = japaneseMaterials()
    expect(materials).toHaveLength(54)
    expect(materials.slice(0, 18)).toEqual(japaneseStarterMaterials())
    expect(new Set(materials.map(material => material.sourceUrl)).size).toBe(54)
    for (const [index, material] of materials.entries()) {
      expect(materialSchema.parse(material)).toEqual(material)
      expect(kanaMorae(japaneseLessons[index]!.reading).length).toBeGreaterThan(0)
    }
    const starterHistory = materials.slice(0, 18).map((material, index) => reflection(material.id, now - 1000 + index))
    expect(nextJapaneseLesson(materials, starterHistory, 0.525, now)?.id).toBe('ja-irodori-elementary01-1')
    const elementaryHistory = materials.slice(0, 36).map((material, index) => reflection(material.id, now - 1000 + index))
    expect(nextJapaneseLesson(materials, elementaryHistory, 0.7, now)?.id).toBe('ja-irodori-elementary02-1')
    expect(materialSchema.safeParse({ ...materials[18], sourceUrl: 'https://www.irodori.jpf.go.jp/en/elementary03/audio/lesson01.html' }).success).toBe(false)
  })
  it('consolidates a difficult topic, steps back after repeated difficulty and respects unavailable links', () => {
    const materials = japaneseMaterials(), target = materials[3]!
    const hard = { ...reflection(target.id, now - 1), data: { ...reflection(target.id).data, effort: 'hard' } }
    expect(nextJapaneseLesson(materials, [hard], 0.2, now)?.id).toBe(target.id)
    expect(nextJapaneseLesson(materials, [{ ...hard, id: 'duplicate' }, hard], 0.2, now)?.id).toBe(target.id)
    expect(nextJapaneseLesson(materials, [{ ...hard, id: 'earlier', sessionId: 'earlier-practice', timestamp: now - 86400000 }, hard], 0.2, now)?.id).toBe(materials[2]!.id)
    const blocked: StudyEvent = { id: 'blocked', type: 'EXTERNAL_LINK_UNAVAILABLE', source: 'self-report', sessionId: 'practice', timestamp: now,
      data: { materialId: target.id, issue: 'cannot-open', playbackObserved: false } }
    expect(nextJapaneseLesson(materials, [hard, blocked], 0.2, now)?.id).not.toBe(target.id)
    expect(nextJapaneseLesson(materials, [{ ...hard, timestamp: now + 1 }], 0.1, now)?.id).toBe(materials[0]!.id)
  })
  it('provides 18 original guided tasks linked to the credited official publisher, without copied media', () => {
    const materials = japaneseStarterMaterials()
    expect(materials).toHaveLength(18)
    expect(new Set(materials.map(material => material.sourceUrl)).size).toBe(18)
    for (const [index, material] of materials.entries()) {
      expect(materialSchema.parse(material)).toEqual(material)
      expect(material).toMatchObject({ language: 'ja', transcript: '', sentences: [], synthetic: false, duration: 0 })
      expect(material.audioId).toBeUndefined(); expect(material.audioPath).toBeUndefined()
      expect(material.sourceUrl).toContain(`lesson${String(index + 1).padStart(2, '0')}.html`)
      expect(japaneseStarterLessons[index]?.grammarZh).toBeTruthy()
      expect(japaneseStarterLessons[index]?.transferZh).toBeTruthy()
    }
    expect(japaneseSource.credits).toBe('https://www.irodori.jpf.go.jp/en/about.html')
    expect(materialSchema.safeParse({ ...materials[0], language: 'en' }).success).toBe(false)
    expect(materialSchema.safeParse({ ...materials[0], sourceUrl: 'https://www.irodori.jpf.go.jp/en/starter/audio/lesson99.html' }).success).toBe(false)
  })
  it.each([['きゃく', 2], ['がっこう', 4], ['しんぶん', 4], ['コーヒー', 4], ['ティー', 2], ['ﾊﾟﾝ', 2], ['ちゅうごく', 4]])('counts %s timing units without inventing acoustic feedback', (reading, expected) => {
    expect(kanaMorae(reading)).toHaveLength(expected)
  })
  it('does not guess kanji readings or split Japanese only at spaces', () => {
    expect(() => kanaMorae('学校')).toThrow('kana reading')
    expect(() => kanaMorae('きゃゃ')).toThrow('Invalid')
    const words = japaneseTextUnits('明日は駅に行きます。')
    expect(words.unit).toBe('word'); expect(words.units.length).toBeGreaterThan(1)
  })
  it('fades one expression only after two separated saved independent kana recalls, never kanji recognition', () => {
    const first = readingAttempt('first', now - 2 * 86400000), second = readingAttempt('second', now - 86400000, 'がっこう。')
    expect(japaneseReadingSupport('がっこう', ['word'], first, true, now).automatic).toBe(true)
    expect(japaneseReadingSupport('がっこう', ['word'], [...first, ...second], true, now)).toMatchObject({ automatic: false, successfulDays: 2 })
    for (const response of ['学校', 'gakkou', '读懂了', '学会了']) {
      expect(japaneseReadingSupport('がっこう', ['word'], [...first, ...readingAttempt('second', now - 86400000, response)], true, now).automatic).toBe(true)
    }
    expect(japaneseReadingSupport('でんしゃ', ['other-word'], [...first, ...second], true, now).automatic).toBe(true)
    expect(japaneseReadingSupport('がっこう', ['word'], [...first, ...second].map(event => ({ ...event, modality: 'recognition' })), true, now).automatic).toBe(true)
  })
  it('restores help after difficulty, rejects same-day priming, duplicates, future and incomplete receipts', () => {
    const first = readingAttempt('first', now - 2 * 86400000), second = readingAttempt('second', now - 86400000)
    const success = [...first, ...second]
    expect(japaneseReadingSupport('がっこう', ['word'], [...success, ...readingAttempt('latest', now - 1, '', true, 1)], false, now).automatic).toBe(true)
    expect(japaneseReadingSupport('がっこう', ['word'], [...first, ...readingAttempt('second', now - 2 * 86400000 + 1000)], true, now).automatic).toBe(true)
    expect(japaneseReadingSupport('がっこう', ['word'], [...first, ...first], true, now).successfulDays).toBe(1)
    expect(japaneseReadingSupport('がっこう', ['word'], [...first, ...readingAttempt('future', now + 1)], true, now).automatic).toBe(true)
    expect(japaneseReadingSupport('がっこう', ['word'], success.filter(event => event.type === 'review'), true, now).automatic).toBe(true)
    expect(japaneseReadingSupport('がっこう', ['word'], success, true, now + 91 * 86400000).automatic).toBe(true)
  })
  it('uses locked first-answer time, never delayed rating time, for spacing, expiry and ordering', () => {
    const first = readingAttempt('first', now - 2 * 86400000)
    const delayed = readingAttempt('second', now - 2 * 86400000 + 60000)
    delayed[1]!.timestamp = now - 86400000
    expect(japaneseReadingSupport('がっこう', ['word'], [...first, ...delayed], true, now).successfulDays).toBe(1)
    const expired = readingAttempt('expired', now - 95 * 86400000)
    expired[1]!.timestamp = now - 86400000
    expect(japaneseReadingSupport('がっこう', ['word'], [...expired, ...first], true, now).successfulDays).toBe(1)
    const oldDifficulty = readingAttempt('old-difficulty', now - 3 * 86400000, '', true, 1)
    oldDifficulty[1]!.timestamp = now - 10
    expect(japaneseReadingSupport('がっこう', ['word'], [...oldDifficulty, ...first, ...readingAttempt('second', now - 86400000)], true, now).automatic).toBe(false)
  })
  it('uses text diagnosis to vary support while listening and speaking stay unknown', () => {
    const answers = Object.fromEntries(japanesePlacementItems.map(item => [item.id, item.answer]))
    expect(japanesePlacement(answers)).toMatchObject({ kanaSupport: false, conversationProbe: 9, listening: 'unknown', speaking: 'unknown', proficiency: 'unverified' })
    expect(japanesePlacement(Object.fromEntries(japanesePlacementItems.map(item => [item.id, '跳过'])))).toMatchObject({ kanaSupport: true, conversationProbe: 1 })
    expect(() => japanesePlacement({})).toThrow('Incomplete')
  })
  it('moves through suitable practice only after a saved reflection, not a link click or typed claim alone', () => {
    const materials = japaneseStarterMaterials(), first = materials[0]!, second = materials[1]!
    const click: StudyEvent = { id: 'click', type: 'EXTERNAL_LINK_OPENED', source: 'self-report', timestamp: now, data: { materialId: first.id } }
    expect(nextJapaneseLesson(materials, [click], 0.1, now)?.id).toBe(first.id)
    expect(nextJapaneseLesson(materials, [reflection(first.id)], 0.1, now)?.id).toBe(second.id)
    expect(nextJapaneseLesson(materials, [{ ...reflection(first.id), data: { materialId: first.id, listened: true } }], 0.1, now)?.id).toBe(first.id)
    expect(nextJapaneseLesson(materials, [], 0.1, now + 91 * 86400000)?.id).toBe(first.id)
    expect(nextJapaneseLesson([{ ...first, language: 'en' }], [], 0.1, now)).toBeNull()
    const history = materials.map((material, index) => reflection(material.id, now - 1000 + index))
    expect(nextJapaneseLesson(materials, history, 1, now)?.id).toBe(first.id)
    expect(history.every(event => event.score === undefined)).toBe(true)
  })
  it('bootstraps and exports only Japanese data without onboarding the learner or overwriting work', async () => {
    const ja = database('ja'), en = database('en')
    await expect(initializeJapanese(en)).rejects.toThrow('own workspace')
    await initializeJapanese(ja)
    expect(await ja.materials.count()).toBe(72); expect((await ja.profiles.get('main'))?.onboarded).toBe(false)
    expect(await ja.events.count()).toBe(0)
    await ja.profiles.update('main', { goal: 'Preserve my own goal' }); await initializeJapanese(ja)
    expect((await ja.profiles.get('main'))?.goal).toBe('Preserve my own goal')
    const backup = await exportBackup(ja)
    expect(JSON.parse(backup).tables.materials.every((row: { language: string }) => row.language === 'ja')).toBe(true)
    await expect(restoreBackup(backup, en)).rejects.toThrow('another learning language')
  })
  it('refuses material leakage before journaling or export', async () => {
    const en = database('en')
    await en.materials.put(japaneseStarterMaterials()[0]!)
    await expect(new SyncJournal(en).bindOwner('00000000-0000-4000-8000-000000000091')).rejects.toThrow('another learning language')
    expect(await en.syncOperations.count()).toBe(0)
    await expect(exportBackup(en)).rejects.toThrow('another learning language')
  })
  it('reuses modality-specific FSRS without moving another language’s equal-ID card or ability', async () => {
    const en = database('en'), ja = database('ja'), english = createLearningRepository(en), japanese = createLearningRepository(ja)
    await english.initialize(demoMaterials); await initializeJapanese(ja)
    const material = japaneseStarterMaterials()[1]!, chunk = await japanese.addChunk(material.chunks[0]!, material.id)
    const cards = await ja.cards.toArray(), target = cards.find(card => card.modality === 'recognition')!
    expect(cards).toHaveLength(6)
    // Deliberately equal local IDs: database binding, not chance UUID uniqueness,
    // must protect the English scheduler and projections.
    await en.chunks.put({ ...chunk, sourceIds: [demoMaterials[0]!.id] }); await en.cards.bulkPut(cards)
    const before = await en.skills.toArray()
    await japanese.reviewCard(target.id, 3, { source: 'text', score: 1, eventId: 'ja-recognition-attempt' })
    expect((await ja.cards.get(target.id))?.card.reps).toBe(1)
    expect((await en.cards.get(target.id))?.card.reps).toBe(0)
    expect((await ja.cards.toArray()).filter(card => card.modality !== 'recognition').every(card => card.card.reps === 0)).toBe(true)
    expect(await en.skills.toArray()).toEqual(before); expect(await en.events.count()).toBe(0)
    expect((await ja.skills.toArray()).filter(skill => ['speakingFluency', 'pronunciation', 'prosody'].includes(skill.id)).every(skill => skill.evidenceCount === 0)).toBe(true)
  })
  it('rolls back wrong-language downloaded materials before advancing the Japanese cursor', async () => {
    const ja = database('ja'), journal = new SyncJournal(ja)
    await journal.bindOwner('00000000-0000-4000-8000-000000000091')
    const material = demoMaterials[0]!
    const record = material as unknown as RecordValue
    await expect(journal.merge([{ id: crypto.randomUUID(), deviceId: crypto.randomUUID(), logicalClock: 1, entityType: 'materials', entityId: material.id,
      kind: 'put', schemaVersion: 1, payload: { record, changed: changedFields(undefined, record) }, cursor: 1, receivedAt: now }], 1)).rejects.toThrow('another learning language')
    expect(await journal.cursor()).toBe(0); expect(await ja.materials.count()).toBe(0)
  })
})
