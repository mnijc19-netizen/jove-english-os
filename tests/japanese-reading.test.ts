import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JoveDatabase } from '../src/db/db'
import { createLearningRepository, exportBackup, restoreBackup } from '../src/db/repository'
import { createJapaneseWorkspace } from '../src/db/japanese'
import { japaneseReadings, japaneseReadingMaterials } from '../src/content/japanese-reading'
import { japaneseReadingDraft, japaneseReadingHistory, japaneseReadingResult, nextJapaneseReading, japaneseReadingDelay, type JapaneseReadingDraft } from '../src/domain/japanese-reading'
import { japanesePlacementItems } from '../src/domain/japanese'
import { materialSchema } from '../src/db/schema'
import { demoMaterials } from '../src/content/materials'
import type { StudySession } from '../src/domain/types'
import { canonical, changedFields, projectOperations, type RecordValue, type StoredOperation, type EntityType } from '../src/sync/protocol'
import { SyncJournal } from '../src/sync/journal'

const databases: JoveDatabase[] = [], now = Date.UTC(2026, 8, 20, 4), day = 86400000
afterEach(async () => { vi.restoreAllMocks(); for (const db of databases.splice(0)) await db.delete() })
async function setup() {
  const en = new JoveDatabase(`read-en-${crypto.randomUUID()}`, 'en'), ja = new JoveDatabase(`read-ja-${crypto.randomUUID()}`, 'ja')
  databases.push(en, ja); await createLearningRepository(en).initialize(demoMaterials)
  const learning = createJapaneseWorkspace(ja, en); await learning.open()
  return { en, ja, learning, reading: learning.reading }
}
const task = { id: 'fixture-reading', kind: 'learn' as const, minutes: 5, title: 'Reading', reason: 'Test', materialId: 'ja-reading-0-1', done: false }
function correct(index = 0): JapaneseReadingDraft {
  const reading = japaneseReadings[index]!
  return { version: 1, revision: 0, taskId: task.id, minutes: 5, meaning: reading.questions.map(q => q.answer) as [string, string],
    kana: reading.words.map(w => w.reading) as [string, string], helped: false, seen: false, note: '按意思理解，再确认读法。', effort: 'okay' }
}
function finished(index: number, timestamp: number, patch: Partial<JapaneseReadingDraft> = {}): StudySession {
  return { id: `reading-fixture-${index}-${timestamp}`, kind: 'japanese-reading', materialId: japaneseReadings[index]!.id,
    startedAt: timestamp - 1000, completedAt: timestamp, stage: 'completed', draft: { ...correct(index), lockedAt: timestamp, dueAt: timestamp + 3 * day, ...patch } }
}

describe('Japanese original reading and independently recorded word reading', () => {
  it('provides 18 original graded non-audio passages with aligned questions and contextual word readings', () => {
    const materials = japaneseReadingMaterials()
    expect(materials).toHaveLength(18); expect(new Set(materials.map(m => m.id)).size).toBe(18)
    for (const [index, reading] of japaneseReadings.entries()) {
      expect(materialSchema.safeParse(materials[index]).success).toBe(true)
      expect(materials[index]).not.toHaveProperty('audioPath')
      expect(materials[index]).not.toHaveProperty('externalStudy')
      for (const word of reading.words) { expect(reading.passage).toContain(word.text); expect(word.reading).toMatch(/^[ぁ-ゖー]+$/u) }
      for (const q of reading.questions) { expect(q.choices).toHaveLength(3); expect(q.choices).toContain(q.answer) }
      expect(japaneseReadingResult(reading, correct(index))).toEqual({ meaning: [true, true], kana: [true, true] })
    }
    expect(japaneseReadingResult(japaneseReadings[1]!, { ...correct(1), kana: ['アス', 'ミナミグチ'] }).kana).toEqual([true, true])
    expect(japaneseReadingResult(japaneseReadings[0]!, { ...correct(), kana: ['牛乳', '七時'] }).kana).toEqual([false, false])
  })
  it('locks first responses, separates help, keeps repair and completes once without oral/skill credit', async () => {
    const { reading, ja, en } = await setup(), session = await reading.start(task, now)
    const initial = japaneseReadingDraft.parse(session.draft)
    await expect(reading.finish(session.id, initial.revision, now + 10)).rejects.toThrow('首答')
    let saved: StudySession = await reading.save(session.id, { ...initial, ...correct(), kana: ['', ''] }, 'help', now + 10)
    expect(saved.draft.helped).toBe(true)
    // Caller-supplied help/seen/lock/due values cannot remove stored support.
    saved = await reading.save(session.id, { ...japaneseReadingDraft.parse(saved.draft), helped: false, lockedAt: 1, dueAt: 2 }, 'lock', now + 20)
    expect(saved.draft.helped).toBe(true); expect(saved.draft.lockedAt).toBe(now + 20); expect(saved.draft.dueAt).toBeUndefined()
    await expect(reading.save(session.id, { ...japaneseReadingDraft.parse(saved.draft), kana: ['ぎゅうにゅう', 'しちじ'] })).rejects.toThrow('首答已锁定')
    saved = await reading.finish(session.id, Number(saved.draft.revision), now + 30)
    expect(saved.draft.dueAt).toBe(now + 30 + day)
    expect(await reading.finish(session.id, 0, now + 100)).toEqual(saved)
    const evidence = await ja.events.toArray()
    expect(evidence.filter(e => e.type === 'TASK_COMPLETED')).toHaveLength(1)
    expect(evidence.find(e => e.type === 'JAPANESE_READING_CHECK')).toMatchObject({ prompted: true, data: { meaningMatches: 2, kanaMatches: 0, acousticAssessed: false, listeningAssessed: false } })
    expect(evidence.some(e => e.skill || e.modality)).toBe(false)
    expect(await en.sessions.count()).toBe(0); expect(await ja.cards.count()).toBe(0)
  })
  it('preserves independent answers across failures, stale tabs, wrong choices and owner changes', async () => {
    const { reading, ja, en } = await setup(), session = await reading.start(task, now), draft = japaneseReadingDraft.parse(session.draft)
    const saved = await reading.save(session.id, { ...draft, kana: ['ぎゅうにゅう', ''] })
    await expect(reading.save(session.id, { ...draft, note: 'stale' })).rejects.toThrow('其他页面')
    await expect(reading.save(session.id, { ...japaneseReadingDraft.parse(saved.draft), meaning: ['not a choice', ''] })).rejects.toThrow('选项')
    const failure = vi.spyOn(ja.sessions, 'put').mockRejectedValueOnce(new Error('disk-full'))
    await expect(reading.save(session.id, japaneseReadingDraft.parse(saved.draft), 'lock', now + 10)).rejects.toThrow('disk-full')
    failure.mockRestore(); expect((await reading.read(session.id)).draft.lockedAt).toBeUndefined()
    await en.syncMeta.put({ id: 'owner', value: 'different-owner' })
    await expect(reading.save(session.id, japaneseReadingDraft.parse(saved.draft), 'lock', now + 20)).rejects.toThrow('账号')
    expect((await ja.sessions.get(session.id))?.draft.kana).toEqual(['ぎゅうにゅう', ''])
  })
  it('round-trips Japanese reading drafts in backup and rejects English restore', async () => {
    const { ja, en, reading } = await setup(), session = await reading.start(task, now)
    const saved = await reading.save(session.id, { ...japaneseReadingDraft.parse(session.draft), ...correct() }, 'lock', now + 10)
    const raw = await exportBackup(ja), restored = new JoveDatabase(`restored-read-${crypto.randomUUID()}`, 'ja')
    databases.push(restored); await restoreBackup(raw, restored)
    expect(await restored.sessions.get(session.id)).toEqual(saved)
    await expect(restoreBackup(raw, en)).rejects.toThrow()
  })
  it('requires distinct unseen unsupported readings on different days before cautiously changing editorial band', () => {
    const sessions = [finished(0, now - 2 * day), finished(1, now - day), finished(2, now)]
    expect(nextJapaneseReading(sessions, now)?.band).toBe(1)
    expect(nextJapaneseReading(sessions.map(s => ({ ...s, draft: { ...s.draft, helped: true } })), now)?.band).toBe(0)
    expect(nextJapaneseReading(sessions.map(s => ({ ...s, draft: { ...s.draft, seen: true } })), now)?.band).toBe(0)
    expect(nextJapaneseReading([finished(0, now), finished(1, now), finished(2, now)], now)?.band).toBe(0)
    expect(nextJapaneseReading([sessions[0]!, sessions[0]!, sessions[0]!], now)?.band).toBe(0)
    expect(japaneseReadingHistory([{ ...sessions[0]!, kind: 'english-reading' }, { ...sessions[1]!, completedAt: now + 1 }], now)).toHaveLength(0)
  })
  it('separates word-reading misses from comprehension, schedules bounded review and does not starve fresh input', () => {
    expect(japaneseReadingDelay(japaneseReadings[0]!, { ...correct(), kana: ['', ''] }, [], now)).toBe(day)
    expect(japaneseReadingDelay(japaneseReadings[0]!, correct(), [], now)).toBe(3 * day)
    const prior = finished(0, now - 4 * day)
    expect(japaneseReadingDelay(japaneseReadings[0]!, correct(), [prior], now)).toBe(7 * day)
    expect(nextJapaneseReading([prior], now)?.id).toBe(prior.materialId)
    expect(nextJapaneseReading([finished(0, now - 5 * day, { seen: true }), finished(1, now - 4 * day, { seen: true })], now)?.id).toBe(japaneseReadings[2]!.id)
  })
  it('marks subsequent sessions as revisits and retains first-answer timestamp across late completion', async () => {
    const { reading } = await setup(), session = await reading.start(task, now)
    await reading.save(session.id, { ...japaneseReadingDraft.parse(session.draft), ...correct() }, 'lock', now + 10)
    const next = await reading.start({ ...task, id: 'next-day' }, now + day)
    expect(next.draft.seen).toBe(true)
    expect((await reading.read(session.id)).draft.lockedAt).toBe(now + 10)
  })
  it('remembers help-only exposure and rechecks a parallel or late-synced exposure when locking', async () => {
    const { reading } = await setup(), early = await reading.start(task, now)
    const parallel = await reading.start({ ...task, id: 'parallel-before-help' }, now + 1)
    expect(parallel.draft.seen).toBe(false)
    await reading.save(early.id, japaneseReadingDraft.parse(early.draft), 'help', now + 2)
    const next = await reading.start({ ...task, id: 'next-after-help' }, now + day)
    expect(next.draft.seen).toBe(true)
    const locked = await reading.save(parallel.id, japaneseReadingDraft.parse(parallel.draft), 'lock', now + day + 1)
    expect(locked.draft.seen).toBe(true)
  })
  it('offers an unseen harder trial after supported-first learners later read comfortably, without calling repetition mastery', () => {
    const supported = Array.from({ length: 6 }, (_, i) => finished(i, now - (10 - i) * day, { helped: true }))
    const comfortable = [finished(0, now - 3 * day, { seen: true }), finished(1, now - 2 * day, { seen: true })]
    expect(nextJapaneseReading([...supported, ...comfortable], now)?.id).toBe('ja-reading-1-1')
    const hardTrial = finished(6, now - day, { effort: 'hard', meaning: ['', ''] })
    expect(nextJapaneseReading([...supported, ...comfortable, hardTrial], now)?.band).toBe(0)
    // Later genuinely unseen independent trials can escape the supported-first
    // ceiling; an early assisted attempt doesn't ban learning forever.
    const trials = [finished(6, now - 2 * day), finished(7, now - day), finished(8, now)]
    const notDue = supported.map(s => ({ ...s, draft: { ...s.draft, dueAt: now + day } }))
    expect(nextJapaneseReading([...notDue, ...trials], now)?.band).toBe(2)
  })
  it('keeps higher explored bands revisitable and eventually offers the third band even when first encounters in both lower bands needed help', () => {
    const supported = Array.from({ length: 12 }, (_, i) => finished(i, now - (18 - i) * day, { helped: true }))
    const revisits = [finished(0, now - 5 * day, { seen: true }), finished(1, now - 4 * day, { seen: true }),
      finished(6, now - 3 * day, { seen: true }), finished(7, now - 2 * day, { seen: true })]
    expect(nextJapaneseReading([...supported, ...revisits], now)).toMatchObject({ id: 'ja-reading-2-1', trial: true })
  })
  it('does not classify a late-synced earlier locked answer as a fresh calibration result', () => {
    const exposed = [0, 1, 2].map(i => ({ ...finished(i, now - (12 - i) * day, { meaning: ['', ''] }), id: `older-exposure-${i}` }))
    const later = [finished(0, now - 2 * day), finished(1, now - day), finished(2, now)]
    const supportedRemainder = [3, 4, 5].map(i => finished(i, now - 8 * day, { helped: true }))
    const notDue = [...exposed, ...later, ...supportedRemainder].map(s => ({ ...s, draft: { ...s.draft, dueAt: now + day } }))
    // Comfortable rereads may justify a trial, never an unseen-success claim.
    expect(nextJapaneseReading(notDue, now)).toMatchObject({ band: 1, trial: true })
  })
  it('automatically includes reading within shared time and alternates with dialogue when only one short slot fits', async () => {
    const { learning, ja, en } = await setup()
    await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map(item => [item.id, '跳过'])), true, now)
    for (const i of [1]) await ja.events.add({ id: `reflection-${i}`, type: 'EXTERNAL_LISTEN_REFLECTION', source: 'self-report', sessionId: `old-${i}`, timestamp: now - day + i,
      data: { materialId: `ja-irodori-starter-${i}`, response: '过去练习', expression: 'お願いします', example: 'お願いします。', audioId: 'fixture', listened: true, playbackObserved: false, comprehensionVerified: false } })
    const plan = (await learning.today(now))!, assigned = plan.tasks.find(t => t.materialId?.startsWith('ja-reading-'))!
    expect(assigned.minutes).toBe(5); expect(plan.minutes).toBeLessThanOrEqual(23)
    const session = await learning.start(assigned.id, now)
    expect(session.kind).toBe('japanese-reading')
    expect((await learning.today(now))!.tasks.filter(t => t.materialId?.startsWith('ja-reading-'))).toHaveLength(1)
    const firstReflection = (await ja.events.get('reflection-1'))!
    await ja.events.add({ ...firstReflection, id: 'reflection-2', sessionId: 'old-2', timestamp: now - day + 2,
      data: { ...firstReflection.data, materialId: 'ja-irodori-starter-2' } })
    // Completing 30 English minutes leaves only 15 of the shared 45.
    // Planner-only fixture: this does not establish any dialogue proficiency.
    await ja.sessions.put({ id: 'finished-talk', kind: 'japanese-dialogue', startedAt: now, completedAt: now + 10, stage: 'completed', draft: {} })
    // Pick two consecutive short non-foundation days (Sep22/23); Sep21 has
    // the separate three-minute foundation rotation covered in kana tests.
    await en.events.add({ id: 'english-next-day', type: 'TASK_COMPLETED', source: 'objective', timestamp: now + 2 * day, data: { taskId: 'english-next', minutes: 30 } })
    const next = (await learning.today(now + 2 * day))!
    expect(next.minutes).toBe(15); expect(next.tasks.some(t => t.kind === 'learn')).toBe(true); expect(next.tasks.some(t => t.kind === 'speak')).toBe(false)
    await ja.sessions.put(finished(0, now + 2 * day + 10))
    await en.events.add({ id: 'english-third-day', type: 'TASK_COMPLETED', source: 'objective', timestamp: now + 3 * day, data: { taskId: 'english-third', minutes: 30 } })
    const third = (await learning.today(now + 3 * day))!
    expect(third.minutes).toBe(15); expect(third.tasks.some(t => t.materialId?.startsWith('ja-tadoku-'))).toBe(true)
    expect(third.tasks.some(t => t.kind === 'speak')).toBe(false)
    const bookTask = third.tasks.find(t => t.materialId?.startsWith('ja-tadoku-'))!
    const bookSession = await learning.start(bookTask.id, now + 3 * day)
    expect(bookSession.kind).toBe('japanese-extensive')
    // A completed original-book slot rotates back to conversation; neither
    // the book assignment nor completion is a claim of comprehension.
    await ja.sessions.put({ ...bookSession, completedAt: now + 3 * day + 10, stage: 'completed' })
    const fourth = (await learning.today(now + 4 * day))!
    expect(fourth.tasks.some(t => t.kind === 'speak')).toBe(true)
  })
})

describe('Japanese reading sync preserves whole submissions and conflicting text', () => {
  const deviceA = '00000000-0000-4000-8000-000000000001', deviceB = '00000000-0000-4000-8000-000000000002'
  function op(type: EntityType, record: RecordValue, clock = 1, deviceId = deviceA, prior?: RecordValue): StoredOperation {
    return { id: crypto.randomUUID(), deviceId, logicalClock: clock, entityType: type, entityId: record.id, kind: 'put', schemaVersion: 1,
      payload: { record, changed: changedFields(prior, record) } }
  }
  const material = japaneseReadingMaterials()[0]! as unknown as RecordValue
  const base = { id: 'ja-reading:sync', kind: 'japanese-reading', materialId: material.id, startedAt: now, stage: 'read', draft: { ...correct(), meaning: ['', ''], kana: ['', ''], note: '' } }
  const locked = { ...base, stage: 'compare', draft: { ...base.draft, revision: 1, lockedAt: now + 10 } }
  const complete = { ...locked, stage: 'completed', completedAt: now + 20, draft: { ...locked.draft, revision: 2, note: '先分清句意。', dueAt: now + 20 + day } }
  const receipt = { id: `${base.id}:locked`, type: 'JAPANESE_READING_LOCK', source: 'objective', timestamp: now + 10, sessionId: base.id,
    data: { materialId: material.id, meaning: ['', ''], kana: ['', ''], helped: false, seen: false } }
  it.each([false, true])('does not splice a concurrent correct draft into a locked or completed attempt (completed=%s)', async completed => {
    const submission = completed ? complete : locked
    const competing = { ...base, draft: { ...base.draft, ...correct(), revision: 1 } }
    const operations = [op('materials', material), op('sessions', base), op('sessions', locked, 2, deviceA, base),
      ...(completed ? [op('sessions', complete, 3, deviceA, locked)] : []), op('events', receipt, 4), op('sessions', competing, 5, deviceB, base)]
    const projection = await projectOperations(operations), primary = projection.records.sessions.find(row => row.id === base.id)!
    expect(primary).toMatchObject(submission)
    expect(japaneseReadingResult(japaneseReadings[0]!, japaneseReadingDraft.parse(primary.draft)).meaning).toEqual([false, false])
    const copy = projection.records.sessions.find(row => row.kind === 'japanese-reading-conflict')!
    expect(copy.draft).toMatchObject({ meaning: correct().meaning, kana: correct().kana, note: correct().note })
    expect((primary.draft as JapaneseReadingDraft).syncReadingConflicts).toContain(copy.id)
    expect(canonical(await projectOperations([...operations].reverse()))).toBe(canonical(projection))
    if (completed) {
      const ja = new JoveDatabase(`reading-incremental-${crypto.randomUUID()}`, 'ja'); databases.push(ja)
      const journal = new SyncJournal(ja); await journal.bindOwner('00000000-0000-4000-8000-000000000091')
      for (const [i, operation] of [...operations].reverse().entries()) await journal.merge([{ ...operation, cursor: 100 + i, receivedAt: now + 100 }], 100 + i)
      expect(await ja.sessions.get(base.id)).toMatchObject(submission)
      expect((await ja.sessions.where('kind').equals('japanese-reading-conflict').toArray())[0]!.draft).toMatchObject({ meaning: correct().meaning })
    }
  })
  it('allows causal continuation of the same locked answer without adding an invented conflict', async () => {
    const continued = { ...locked, draft: { ...locked.draft, note: '另一设备接着写的笔记。', revision: 2 } }
    const projected = await projectOperations([op('materials', material), op('sessions', base), op('sessions', locked, 2, deviceA, base),
      op('events', receipt, 3), op('sessions', continued, 4, deviceB, locked)])
    expect(projected.records.sessions).toHaveLength(1)
    expect(projected.records.sessions[0]).toMatchObject(continued)
  })
})
