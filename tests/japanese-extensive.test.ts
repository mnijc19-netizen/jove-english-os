import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JoveDatabase } from '../src/db/db'
import { createLearningRepository, exportBackup, restoreBackup } from '../src/db/repository'
import { createJapaneseWorkspace } from '../src/db/japanese'
import { demoMaterials } from '../src/content/materials'
import { materialFromTadokuBook } from '../src/content/tadoku-catalog'
import { extensiveDraftSchema, nextJapaneseBook } from '../src/domain/japanese-extensive'
import type { StudyEvent, StudySession } from '../src/domain/types'
import { canonical, changedFields, projectOperations, type RecordValue, type StoredOperation, type EntityType } from '../src/sync/protocol'
import { allocateLanguageDay } from '../src/domain/language'
import { japanesePlacementItems } from '../src/domain/japanese'

const now = Date.UTC(2026, 8, 20, 4), day = 86400000
const books = ['Start', 'Start', 'Start', '0', '0', '0', '1'].map((level, i) => materialFromTadokuBook({ id: String(i + 101),
  url: `https://tadoku.org/japanese/book/${i + 101}/`, title: `Fixture book ${i}`, level: level as 'Start' | '0' | '1' }, now))
const task = { id: 'book-task', kind: 'learn' as const, minutes: 5, title: 'Read', reason: 'Fixture', materialId: books[0]!.id, done: false }
const databases: JoveDatabase[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const db of databases.splice(0)) await db.delete() })
async function setup() {
  const en = new JoveDatabase(`er-en-${crypto.randomUUID()}`, 'en'), ja = new JoveDatabase(`er-ja-${crypto.randomUUID()}`, 'ja')
  databases.push(en, ja); await createLearningRepository(en).initialize(demoMaterials)
  const learning = createJapaneseWorkspace(ja, en); await learning.open(); await ja.materials.bulkPut(books)
  return { en, ja, learning, reading: learning.books }
}
function observation(index: number, timestamp: number, outcome = 'finished', effort = 'easy'): StudyEvent {
  return { id: `er-${index}-${timestamp}`, sessionId: 'fixture', type: 'JAPANESE_EXTENSIVE_READING', source: 'self-report', timestamp,
    data: { materialId: books[index]!.id, level: books[index]!.externalReading!.level, outcome, effort, minutesRead: 3,
      bookmark: '第2页', note: '', playbackObserved: false, comprehensionVerified: false } }
}
describe('Japanese original-book recommendations and honest self-reported reading', () => {
  it('starts very easy, continues a bookmark, tries one level after separated easy books and backs off', () => {
    expect(nextJapaneseBook(books, [], now)?.book.id).toBe(books[0]!.id)
    expect(nextJapaneseBook(books, [observation(1, now, 'continue')], now)).toMatchObject({ book: { id: books[1]!.id }, continuing: true, bookmark: '第2页' })
    const easy = [observation(0, now), observation(1, now + 1), observation(2, now + day)]
    expect(nextJapaneseBook(books, easy.slice(0, 2), now + day)?.book.externalReading?.level).toBe('Start')
    expect(nextJapaneseBook(books, easy, now + day)).toMatchObject({ book: { externalReading: { level: '0' } }, trial: true })
    expect(nextJapaneseBook(books, [...easy, observation(3, now + day + 1, 'continue', 'hard')], now + day + 2)?.book.externalReading?.level).toBe('Start')
    // Rereading the same book is not three distinct comfortable books.
    expect(nextJapaneseBook(books, [observation(0, now), observation(0, now + day), observation(0, now + 2 * day)], now + 2 * day)?.trial).toBe(false)
    expect(nextJapaneseBook(books, [], now + 91 * day)).toBeUndefined()
    expect(nextJapaneseBook(books.map(m => ({ ...m, language: 'en' as const })), [], now)).toBeUndefined()
  })
  it('does not count a started/opened link; saves optional notes without tests, audio, cards or ability credit', async () => {
    const { reading, ja, en } = await setup(), first = await reading.start(task, now)
    expect(await reading.start(task, now + 1)).toEqual(first)
    await expect(reading.finish(first.id, extensiveDraftSchema.parse(first.draft), now + 2)).rejects.toThrow('只打开链接')
    expect((await ja.events.toArray()).map(e => e.type)).toEqual(['TASK_STARTED'])
    const saved = await reading.save(first.id, { ...extensiveDraftSchema.parse(first.draft), minutesRead: 3, bookmark: '第4页', outcome: 'continue' })
    const finished = await reading.finish(first.id, extensiveDraftSchema.parse(saved.draft), now + 180000)
    expect(await reading.finish(first.id, extensiveDraftSchema.parse(first.draft), now + 190000)).toEqual(finished)
    const events = await ja.events.toArray(), record = events.find(e => e.type === 'JAPANESE_EXTENSIVE_READING')!
    expect(record).toMatchObject({ source: 'self-report', data: { minutesRead: 3, bookmark: '第4页', playbackObserved: false, comprehensionVerified: false } })
    expect(events.filter(e => e.type === 'TASK_COMPLETED')).toHaveLength(1)
    expect(events.find(e => e.type === 'TASK_COMPLETED')?.data?.minutes).toBe(3)
    expect(events.some(e => e.score || e.skill || e.modality)).toBe(false)
    expect(await ja.cards.count()).toBe(0); expect(await ja.audio.count()).toBe(0); expect(await en.sessions.count()).toBe(0)
    const next = await reading.start({ ...task, id: 'next-day' }, now + day)
    expect(next.draft.bookmark).toBe('第4页')
    const backup = await exportBackup(ja)
    const restored = new JoveDatabase(`er-restore-${crypto.randomUUID()}`, 'ja'); databases.push(restored)
    await restoreBackup(backup, restored)
    expect(await restored.sessions.get(finished.id)).toEqual(finished)
  })
  it('automatically switches without losing old notes, exceeding time or accepting caller-injected identity', async () => {
    const { reading, ja } = await setup(), first = await reading.start(task, now)
    await expect(reading.save(first.id, { ...extensiveDraftSchema.parse(first.draft), book: { materialId: books[6]!.id } })).rejects.toThrow('其他页面')
    let saved = await reading.save(first.id, { ...extensiveDraftSchema.parse(first.draft), minutesRead: 2, bookmark: '第2页', note: '我不喜欢这个主题。', savedAt: 1 })
    expect(saved.draft.book).toEqual({ materialId: books[0]!.id }); expect(saved.draft.savedAt).toBeUndefined()
    saved = await reading.switchBook(first.id, extensiveDraftSchema.parse(saved.draft), 'not-interesting', now + 120000)
    expect(saved.draft.book).toEqual({ materialId: books[1]!.id }); expect(saved.draft.spentMinutes).toBe(2)
    expect((await ja.events.toArray()).find(e => e.type === 'JAPANESE_EXTENSIVE_READING')?.data).toMatchObject({ note: '我不喜欢这个主题。', bookmark: '第2页', outcome: 'not-interesting' })
    await expect(reading.save(first.id, { ...extensiveDraftSchema.parse(saved.draft), spentMinutes: 0, minutesRead: 4 })).rejects.toThrow()
    saved = await reading.save(first.id, { ...extensiveDraftSchema.parse(saved.draft), minutesRead: 3 })
    await expect(reading.switchBook(first.id, extensiveDraftSchema.parse(saved.draft), 'too-hard', now + 300000)).rejects.toThrow('时间已用完')
    await reading.finish(first.id, extensiveDraftSchema.parse(saved.draft), now + 300000)
    expect((await ja.events.toArray()).find(e => e.type === 'TASK_COMPLETED')?.data?.minutes).toBe(5)
  })
  it('rolls back on storage failure or exhausted alternatives and fences stale tabs and switched owners', async () => {
    const { reading, ja, en } = await setup(), first = await reading.start(task, now), draft = extensiveDraftSchema.parse(first.draft)
    const fail = vi.spyOn(ja.sessions, 'put').mockRejectedValueOnce(new Error('disk-full'))
    await expect(reading.switchBook(first.id, draft, 'too-hard', now + 1)).rejects.toThrow('disk-full')
    fail.mockRestore(); expect((await reading.read(first.id)).draft.book).toEqual(draft.book)
    expect((await ja.events.toArray()).some(e => e.type === 'JAPANESE_EXTENSIVE_READING')).toBe(false)
    const saved = await reading.save(first.id, { ...draft, bookmark: '最新书签' })
    await expect(reading.save(first.id, draft)).rejects.toThrow('其他页面')
    await en.syncMeta.put({ id: 'owner', value: 'changed-owner' })
    await expect(reading.save(first.id, extensiveDraftSchema.parse(saved.draft))).rejects.toThrow('账号已改变')
    expect((await ja.sessions.get(first.id))?.draft.bookmark).toBe('最新书签')
  })
  it('counts an old draft completed today against shared time while keeping minutes explicitly self-reported', async () => {
    const { reading, ja } = await setup(), first = await reading.start(task, now - day)
    const saved = await reading.save(first.id, { ...extensiveDraftSchema.parse(first.draft), minutesRead: 3 })
    await reading.finish(first.id, extensiveDraftSchema.parse(saved.draft), now)
    const events = await ja.events.toArray()
    expect(events.find(e => e.type === 'TASK_COMPLETED')).toMatchObject({ source: 'objective', data: { minutes: 3, carriedOver: true, timeSource: 'self-report' } })
    const allowance = allocateLanguageDay(45, { en: { enabled: true, events: [], dueCards: 0 }, ja: { enabled: true, events, dueCards: 0 } }, now)
    expect(allowance.credited).toBe(3); expect(allowance.remaining).toBe(42)
  })
  it.each([45, 90])('rotates original books independently of a later completed dialogue (shared budget %s)', async minutes => {
    const { learning, ja, en } = await setup()
    await en.profiles.update('main', { dailyMinutes: minutes })
    await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map(item => [item.id, '跳过'])), true, now - day)
    for (const i of [1, 2]) await ja.events.add({ id: `practice-${i}`, type: 'EXTERNAL_LISTEN_REFLECTION', source: 'self-report', sessionId: `prior-${i}`, timestamp: now - day + i,
      data: { materialId: `ja-irodori-starter-${i}`, response: '过去练习', expression: 'お願いします', example: 'お願いします。', audioId: 'fixture', listened: true, playbackObserved: false, comprehensionVerified: false } })
    await ja.sessions.bulkPut([{ id: 'prior-short', kind: 'japanese-reading', materialId: 'ja-reading-0-1', startedAt: now - day, completedAt: now - day + 1000, stage: 'completed', draft: {} },
      { id: 'prior-dialogue', kind: 'japanese-dialogue', startedAt: now - day, completedAt: now - day + 2000, stage: 'completed', draft: {} }])
    const plan = (await learning.today(now))!
    expect(plan.tasks.some(t => t.materialId?.startsWith('ja-tadoku-'))).toBe(true)
    expect(plan.minutes).toBeLessThanOrEqual(Math.ceil(minutes / 2))
  })
})

describe('extensive reading sync is an atomic self-report, with concurrent bookmarks retained', () => {
  function op(type: EntityType, record: RecordValue, clock = 1, device = 1, prior?: RecordValue): StoredOperation {
    return { id: crypto.randomUUID(), deviceId: `00000000-0000-4000-8000-00000000000${device}`, logicalClock: clock,
      entityType: type, entityId: record.id, kind: 'put', schemaVersion: 1, payload: { record, changed: changedFields(prior, record) } }
  }
  it('never splices another device bookmark/minutes into a completed book or drops its conflicting draft', async () => {
    const { reading, ja } = await setup(), first = await reading.start(task, now)
    const saved = await reading.save(first.id, { ...extensiveDraftSchema.parse(first.draft), bookmark: 'A第4页', minutesRead: 3 })
    const complete = await reading.finish(first.id, extensiveDraftSchema.parse(saved.draft), now + 180000)
    const concurrent: StudySession = { ...first, draft: { ...first.draft, bookmark: 'B第7页', note: '自己的笔记', minutesRead: 4, revision: 1 } }
    const operations = [...books.map(b => op('materials', b as unknown as RecordValue)), op('sessions', first as unknown as RecordValue),
      op('sessions', complete as unknown as RecordValue, 2, 1, first as unknown as RecordValue),
      op('sessions', concurrent as unknown as RecordValue, 3, 2, first as unknown as RecordValue),
      ...(await ja.events.toArray()).map(e => op('events', e as unknown as RecordValue, 4))]
    const projection = await projectOperations(operations)
    expect(projection.records.sessions.find(s => s.id === first.id)).toMatchObject({ stage: 'completed', draft: { bookmark: 'A第4页', minutesRead: 3 } })
    expect(projection.records.sessions.find(s => s.kind === 'japanese-extensive-conflict')).toMatchObject({ draft: { bookmark: 'B第7页', note: '自己的笔记', minutesRead: 4 } })
    expect(canonical(await projectOperations([...operations].reverse()))).toBe(canonical(projection))
    expect(projection.skills.every(s => s.evidenceCount === 0)).toBe(true)
  })
  it('rejects equal-revision stale writes, switches and completion after another device changes books', async () => {
    const { reading, ja } = await setup(), first = await reading.start(task, now)
    const onA = await reading.save(first.id, { ...extensiveDraftSchema.parse(first.draft), bookmark: 'A旧书第4页', minutesRead: 2 })
    const onB = { ...first, draft: { ...first.draft, revision: 1, stamp: crypto.randomUUID(), book: { materialId: books[1]!.id }, switched: [books[0]!.id] } }
    const projection = await projectOperations([...books.map(b => op('materials', b as unknown as RecordValue)), op('sessions', first as unknown as RecordValue),
      op('sessions', onA as unknown as RecordValue, 2, 1, first as unknown as RecordValue), op('sessions', onB as unknown as RecordValue, 3, 2, first as unknown as RecordValue)])
    const merged = projection.records.sessions.find(s => s.id === first.id)!
    await ja.sessions.put(merged as unknown as StudySession)
    const stale = extensiveDraftSchema.parse(onA.draft)
    expect(merged.draft).toMatchObject({ revision: stale.revision, book: { materialId: books[1]!.id } })
    await expect(reading.save(first.id, stale)).rejects.toThrow('其他页面')
    await expect(reading.switchBook(first.id, stale, 'too-hard', now + 100)).rejects.toThrow('其他页面')
    await expect(reading.finish(first.id, stale, now + 100)).rejects.toThrow('其他页面')
    expect((await ja.sessions.get(first.id))?.draft.bookmark).toBe('')
  })
})
