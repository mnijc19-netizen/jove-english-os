import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { JoveDatabase } from '../src/db/db'
import { createLearningRepository } from '../src/db/repository'
import { SyncJournal } from '../src/sync/journal'
import { createEnglishReading } from '../src/db/english-reading'
import { materialFromEnglishReader, englishReadingLevels } from '../src/content/english-reading-catalog'
import { dueEnglishReading, englishReadingDraftSchema, nextEnglishReading } from '../src/domain/english-reading'
import { makePlan, taskActivity } from '../src/domain/engine'
import { defaultProfile, type StudyEvent, type StudySession } from '../src/domain/types'
import { demoMaterials } from '../src/content/materials'
import { allocateLanguageDay } from '../src/domain/language'
import { canonical, changedFields, eventOccurrenceKey, projectOperations } from '../src/sync/protocol'
import type { EntityType, RecordValue, StoredOperation } from '../src/sync/protocol'

const now = Date.UTC(2026, 8, 20, 4), day = 86400000, date = new Date(now).toLocaleDateString('en-CA')
const readers = englishReadingLevels.flatMap(level => [1, 2, 3].map(index => materialFromEnglishReader({ id: `sample-${index}`, level, title: `Sample ${level} ${index}`,
  url: `https://learnenglish.britishcouncil.org/free-resources/reading/${level.toLowerCase()}/sample-${index}` }, now)))
const task = { id: `${date}:learn:${readers[0]!.id}:original:reading`, kind: 'learn' as const, title: '原版阅读', reason: '合适难度',
  minutes: 5, done: false, materialId: readers[0]!.id }
const databases: JoveDatabase[] = []
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.delete())) })
async function setup() {
  const db = new JoveDatabase(`en-reading-${crypto.randomUUID()}`, 'en'); databases.push(db)
  await createLearningRepository(db).initialize([...demoMaterials, ...readers])
  await db.plans.put({ id: date, date, minutes: 5, tasks: [task], focus: 'reading', createdAt: now, evidenceFingerprint: 'test' })
  let owner = 'a'; await db.syncMeta.put({ id: 'owner', value: owner })
  const reading = createEnglishReading(db, async () => { if ((await db.syncMeta.get('owner'))?.value !== owner) throw new Error('owner changed') })
  return { db, reading, changeOwner: () => { owner = 'b' } }
}
function report(index: number, timestamp: number, outcome = 'finished', effort = 'easy'): StudyEvent {
  return { id: `report-${index}-${timestamp}`, type: 'ENGLISH_READING_REPORT', source: 'self-report', timestamp, sessionId: `prior-${index}`,
    data: { materialId: readers[index]!.id, level: readers[index]!.externalReading!.level, minutesRead: 2, response: '这篇说明了安排', application: 'I can use this idea.',
      outcome, effort, readingObserved: false, comprehensionVerified: false } }
}
describe('automatic English original reading with honest delayed recall', () => {
  it('keeps graded originals out of listening/chunks/fluency, while giving them a real reading task', () => {
    const profile = { ...defaultProfile(), onboarded: true }
    const plan = makePlan(profile, [], [], [], [...demoMaterials, ...readers], undefined, now)
    const reading = plan.tasks.find(t => taskActivity(t) === 'reading')
    expect(reading?.materialId).toMatch(/^en-bc-/u)
    expect(plan.tasks.filter(t => taskActivity(t) !== 'reading').every(t => !t.materialId?.startsWith('en-bc-'))).toBe(true)
    const onlyReaders = makePlan(profile, [], [], [], readers, undefined, now)
    expect(onlyReaders.tasks.filter(t => taskActivity(t) !== 'reading').every(t => !t.materialId)).toBe(true)
    const history = [report(0, now - 100), report(1, now - 50)]
    expect(makePlan(profile, [], [], history, [...demoMaterials, ...readers], undefined, now).tasks.find(t => taskActivity(t) === 'reading')?.materialId).not.toMatch(/^en-bc-/u)
    const old = structuredClone(plan); old.tasks.find(t => t.kind === 'listen')!.materialId = readers[0]!.id
    // Old assigned routes remain identity-preserving; Listen itself redirects the bad deep link.
    expect(makePlan(profile, [], [], [], [...demoMaterials, ...readers], old, now).tasks.find(t => taskActivity(t) === 'reading')?.id).toBe(reading?.id)
  })
  it('selects easy originals, does not advance on opening, backs off hard input and bounds inaccessible sources', () => {
    expect(nextEnglishReading(readers, [], now)?.material.externalReading.level).toBe('A1')
    expect(nextEnglishReading(readers, [{ id: 'opened', type: 'TASK_STARTED', source: 'objective', timestamp: now, data: { materialId: readers[0]!.id } }], now)?.material.id).toBe(readers[0]!.id)
    expect(nextEnglishReading(readers, [report(3, now, 'too-hard', 'hard')], now)?.material.externalReading.level).toBe('A1')
    expect(nextEnglishReading(readers, [report(0, now, 'unavailable'), report(1, now + 1, 'unavailable')], now + 2)).toBeUndefined()
    expect(nextEnglishReading(readers, [], now + 91 * day)).toBeUndefined()
  })
  it('persists a real learner response, credits only reported time and schedules a separate recall', async () => {
    const { db, reading } = await setup(), first = await reading.start(task, now)
    await expect(reading.finish(first.id, englishReadingDraftSchema.parse(first.draft), 'finished', now + 1)).rejects.toThrow('仅打开链接')
    expect((await db.events.toArray()).map(e => e.type)).toEqual(['TASK_STARTED'])
    const saved = await reading.save(first.id, { ...englishReadingDraftSchema.parse(first.draft), minutesRead: 2, response: '这篇说了如何安排一天。', application: 'I can plan my day.' })
    const completed = await reading.finish(first.id, englishReadingDraftSchema.parse(saved.draft), 'finished', now + 2)
    expect(await reading.finish(first.id, englishReadingDraftSchema.parse(first.draft), 'finished', now + 3)).toEqual(completed)
    const events = await db.events.toArray()
    expect(events.find(e => e.type === 'ENGLISH_READING_REPORT')).toMatchObject({ source: 'self-report', data: { readingObserved: false, comprehensionVerified: false } })
    expect(events.every(e => e.score === undefined && !e.skill)).toBe(true)
    expect(await db.cards.count()).toBe(0); expect(await db.audio.count()).toBe(0)
    const space = { enabled: true, events, plan: await db.plans.get(date), dueCards: 0 }
    expect(allocateLanguageDay(45, { en: space, ja: { enabled: false, events: [], dueCards: 0 } }, now + 3).credited).toBe(2)
    expect(dueEnglishReading(events, now + day)).toBeUndefined()
    const due = dueEnglishReading(events, now + day + 3)!
    expect(due.data.response).toBe('这篇说了如何安排一天。')
    const date2 = new Date(now + day + 3).toLocaleDateString('en-CA'), recallTask = { ...task, id: `${date2}:learn:${task.materialId}:recall:reading` }
    await db.plans.put({ id: date2, date: date2, minutes: 5, tasks: [recallTask], focus: 'reading', createdAt: now + day, evidenceFingerprint: 'recall' })
    const recall = await reading.start(recallTask, now + day + 3)
    await expect(reading.reveal(recall.id, englishReadingDraftSchema.parse(recall.draft), now + day + 4)).rejects.toThrow('先写下')
    const attempted = await reading.save(recall.id, { ...englishReadingDraftSchema.parse(recall.draft), response: '我记得要先安排时间', minutesRead: 1 })
    const revealed = await reading.reveal(recall.id, englishReadingDraftSchema.parse(attempted.draft), now + day + 5)
    const rated = await reading.save(recall.id, { ...englishReadingDraftSchema.parse(revealed.draft), response: '不能偷偷替换最初回答', rating: 'partial' })
    expect(rated.draft.response).toBe('我记得要先安排时间')
    await reading.finish(recall.id, englishReadingDraftSchema.parse(rated.draft), 'finished', now + day + 6)
    expect(dueEnglishReading(await db.events.toArray(), now + 2 * day)).toBeUndefined()
    expect(dueEnglishReading(await db.events.toArray(), now + 4 * day + 7)).toBeDefined()
  })
  it('preserves interrupted work without completing it; rejects owner and same-revision stale saves', async () => {
    const { db, reading, changeOwner } = await setup(), first = await reading.start(task, now)
    const saved = await reading.save(first.id, { ...englishReadingDraftSchema.parse(first.draft), response: '读到一半的笔记', minutesRead: 1 })
    await db.sessions.put({ ...saved, draft: { ...saved.draft, stamp: crypto.randomUUID(), response: '另一端的记录' } })
    await expect(reading.save(first.id, englishReadingDraftSchema.parse(saved.draft))).rejects.toThrow('另一页面')
    const current = await reading.read(first.id), stopped = await reading.finish(first.id, current.draft, 'unavailable', now + 2)
    expect(stopped.stage).toBe('stopped'); expect(stopped.draft.response).toBe('另一端的记录')
    expect((await db.events.toArray()).some(e => e.type === 'TASK_COMPLETED')).toBe(false)
    expect((await db.plans.get(date))?.tasks[0]).toMatchObject({ done: false, optional: true })
    changeOwner(); await expect(reading.read(first.id)).rejects.toThrow('owner changed')
  })
})

function op(type: EntityType, record: RecordValue, clock = 1, device = 1, prior?: RecordValue): StoredOperation {
  return { id: crypto.randomUUID(), deviceId: `00000000-0000-4000-8000-00000000000${device}`, logicalClock: clock,
    entityType: type, entityId: record.id, kind: 'put', schemaVersion: 1, payload: { record, changed: changedFields(prior, record) } }
}
it.each(['finished', 'unavailable'] as const)('keeps the English %s attempt whole and another device note separately', async outcome => {
  const { db, reading } = await setup(), first = await reading.start(task, now)
  const saved = await reading.save(first.id, { ...englishReadingDraftSchema.parse(first.draft), response: 'A 的原始回答', minutesRead: 2 })
  const terminal = await reading.finish(first.id, englishReadingDraftSchema.parse(saved.draft), outcome, now + 2)
  const other: StudySession = { ...first, draft: { ...first.draft, response: 'B 的未提交回答', application: 'My own idea.', minutesRead: 4, revision: 1, stamp: crypto.randomUUID() } }
  const operations = [op('materials', readers[0]! as unknown as RecordValue), op('sessions', first as unknown as RecordValue),
    op('sessions', terminal as unknown as RecordValue, 2, 1, first as unknown as RecordValue), op('sessions', other as unknown as RecordValue, 3, 2, first as unknown as RecordValue),
    ...(await db.events.toArray()).map(e => op('events', e as unknown as RecordValue, 4))]
  const projection = await projectOperations(operations)
  expect(projection.records.sessions.find(s => s.id === first.id)).toMatchObject({ stage: terminal.stage, draft: { response: 'A 的原始回答', minutesRead: 2 } })
  expect(projection.records.sessions.find(s => s.kind === 'english-reading-conflict')).toMatchObject({ draft: { response: 'B 的未提交回答', application: 'My own idea.', minutesRead: 4 } })
  expect(canonical(await projectOperations(operations.toReversed()))).toBe(canonical(projection))
  expect(projection.skills.every(s => s.evidenceCount === 0)).toBe(true)
})

it('keeps the frozen recall source through a late same-ID event collision, not an arbitrary alias', async () => {
  const { db, reading } = await setup(), first = await reading.start(task, now)
  const saved = await reading.save(first.id, { ...englishReadingDraftSchema.parse(first.draft), response: '我要回想的 A 版本', minutesRead: 2 })
  const completed = await reading.finish(first.id, englishReadingDraftSchema.parse(saved.draft), 'finished', now + 2)
  const original = (await db.events.toArray()).find(e => e.type === 'ENGLISH_READING_REPORT')!
  const key = await eventOccurrenceKey(original as unknown as RecordValue), date2 = new Date(now + 2 * day).toLocaleDateString('en-CA')
  const recallTask = { ...task, id: `${date2}:learn:${task.materialId}:recall:reading` }
  await db.plans.put({ id: date2, date: date2, minutes: 5, tasks: [recallTask], focus: 'reading', createdAt: now + 2 * day, evidenceFingerprint: 'recall' })
  const recall = await reading.start(recallTask, now + 2 * day)
  expect(recall.draft.source).toMatchObject({ readingEventKey: key, readingEventId: original.id })
  const alternate = { ...original, data: { ...original.data, response: '并不是我要回想的 B 版本' } }
  const operations = [op('materials', readers[0]! as unknown as RecordValue), op('sessions', completed as unknown as RecordValue),
    op('sessions', recall as unknown as RecordValue), ...(await db.events.toArray()).map(e => op('events', e as unknown as RecordValue)),
    op('events', alternate as unknown as RecordValue, 2, 2)]
  const projection = await projectOperations(operations)
  const projected = projection.records.sessions.find(s => s.id === recall.id)!
  expect(projected.draft).toMatchObject({ source: { readingEventId: `${original.id}~${key}`, readingEventKey: key, response: '我要回想的 A 版本' } })
  expect(projection.deferred.some(d => d.entityId === recall.id)).toBe(false)
  await db.events.clear(); await db.events.bulkPut(projection.records.events as unknown as StudyEvent[])
  await db.sessions.put(projected as unknown as StudySession)
  expect((await reading.read(recall.id)).draft.source?.response).toBe('我要回想的 A 版本')
  const withMissing = { ...recall, draft: { ...recall.draft, source: { ...(recall.draft.source as object), readingEventKey: 'f'.repeat(64) } } }
  const unresolved = await projectOperations([...operations.filter(o => o.entityId !== recall.id), op('sessions', withMissing as unknown as RecordValue)])
  expect(unresolved.records.sessions.some(s => s.id === recall.id)).toBe(false)
  expect(unresolved.deferred.some(d => d.entityId === recall.id)).toBe(true)
  expect(canonical(await projectOperations(operations.toReversed()))).toBe(canonical(projection))
})

it('restores a clock-corrected report from JSON, continues its recall and keeps its identity in a fresh journal', async () => {
  const { db, reading } = await setup(), first = await reading.start(task, now)
  const saved = await reading.save(first.id, { ...englishReadingDraftSchema.parse(first.draft), response: '被校正时间的原始回答', minutesRead: 2 })
  const completed = await reading.finish(first.id, englishReadingDraftSchema.parse(saved.draft), 'finished', now + 1000)
  const events = await db.events.toArray(), original = events.find(e => e.type === 'ENGLISH_READING_REPORT')!
  const key = await eventOccurrenceKey(original as unknown as RecordValue)
  const operations = [op('materials', readers[0]! as unknown as RecordValue), op('sessions', completed as unknown as RecordValue),
    ...events.map((e, i) => ({ ...op('events', e as unknown as RecordValue), cursor: i + 10, receivedAt: now + 500 }))]
  const projection = await projectOperations(operations)
  const corrected = projection.records.events.find(e => e.id === original.id)!
  expect(corrected).toMatchObject({ timestamp: now + 500, data: { clientTimestamp: now + 1000 } })
  expect(await eventOccurrenceKey(corrected)).toBe(key)
  await db.events.clear(); await db.events.bulkPut(projection.records.events as unknown as StudyEvent[])
  const date2 = new Date(now + 2 * day).toLocaleDateString('en-CA'), recallTask = { ...task, id: `${date2}:learn:${task.materialId}:recall:reading` }
  await db.plans.put({ id: date2, date: date2, minutes: 5, tasks: [recallTask], focus: 'reading', createdAt: now + 2 * day, evidenceFingerprint: 'recall' })
  const recall = await reading.start(recallTask, now + 2 * day)
  const restored = new JoveDatabase(`restored-en-reading-${crypto.randomUUID()}`, 'en'); databases.push(restored)
  await createLearningRepository(restored).restoreBackup(await createLearningRepository(db).exportBackup(db), restored)
  expect(await restored.syncMeta.get('eventKeys')).toBeUndefined()
  const recovered = createEnglishReading(restored, async () => {})
  expect((await recovered.read(recall.id)).draft.source?.readingEventKey).toBe(key)
  const response = await recovered.save(recall.id, { ...(await recovered.read(recall.id)).draft, response: '恢复后继续回想', minutesRead: 1 })
  const revealed = await recovered.reveal(recall.id, englishReadingDraftSchema.parse(response.draft), now + 2 * day + 1)
  const rated = await recovered.save(recall.id, { ...englishReadingDraftSchema.parse(revealed.draft), rating: 'clear' })
  await recovered.finish(recall.id, englishReadingDraftSchema.parse(rated.draft), 'finished', now + 2 * day + 2)
  const journal = new SyncJournal(restored); await journal.prepareLocal()
  const replay = await projectOperations(await restored.syncOperations.toArray())
  expect(replay.deferred.some(d => d.entityId === recall.id)).toBe(false)
  expect(replay.records.sessions.find(s => s.id === recall.id)).toMatchObject({ stage: 'saved', draft: { response: '恢复后继续回想' } })
  expect(replay.eventKeys[original.id]).toBe(key)
})
