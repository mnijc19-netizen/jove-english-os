import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { JoveDatabase } from '../src/db/db'
import { defaultProfile, defaultSettings } from '../src/domain/types'
import { SyncJournal } from '../src/sync/journal'
import { canonical, changedFields, parseOperation, projectOperations, type EntityType, type RecordValue, type StoredOperation } from '../src/sync/protocol'

const deviceA = '00000000-0000-4000-8000-000000000001'
const deviceB = '00000000-0000-4000-8000-000000000002'
const deviceC = '00000000-0000-4000-8000-000000000003'
const owner = '00000000-0000-4000-8000-000000000010'
const now = Date.UTC(2026, 9, 3)
type Classroom = RecordValue & { draft: Record<string, unknown>; stage: string; materialId: string; startedAt: number; completedAt?: number }
function classroom(language = 'en'): Classroom {
  return { id: `starter-${language}-source`, kind: 'starter-classroom', materialId: `starter-${language}-material`, startedAt: now, stage: 'transfer',
    draft: { version: 1, lessonVersion: 1, revision: 0, purpose: 'lesson', pace: 'standard', minutes: 10, contextId: `${language}-context`,
      response: '', mode: 'text', helped: false, helpCount: 0, romaji: false, audioId: '', audioIds: [], lastAttemptId: '', activeMs: 0 } }
}
function edited(base: Classroom, response: string, patch: Record<string, unknown> = {}): Classroom {
  return { ...base, draft: { ...base.draft, response, revision: Number(base.draft.revision) + 1, ...patch } }
}
function op(type: EntityType, record: RecordValue, clock = 1, device = deviceA, previous?: RecordValue): StoredOperation {
  return parseOperation({ id: crypto.randomUUID(), deviceId: device, logicalClock: clock, entityType: type, entityId: record.id,
    kind: 'put', schemaVersion: 1, payload: { record, changed: changedFields(previous, record) } })
}
function seed(base: Classroom): StoredOperation[] {
  return [op('materials', { id: base.materialId, language: base.materialId.startsWith('starter-ja-') ? 'ja' : 'en', title: 'Original starter fixture', topic: 'Greeting', difficulty: 0.05, duration: 60,
    transcript: 'Original fixture.', sentences: ['Original fixture.'], sourceKind: 'curated', sourceLabel: 'Synthetic test fixture',
    synthetic: true, approved: true, question: 'Meaning?', answer: 'Greeting', keywords: [], chunks: [], createdAt: now }), op('sessions', base, 2)]
}
function recording(id: string) {
  return op('audioMetadata', { id, mimeType: 'audio/wav', createdAt: now, duration: 1, kind: 'recording', processed: false, label: 'Original recording' })
}
function parent(result: Awaited<ReturnType<typeof projectOperations>>, id: string): Classroom {
  return result.records.sessions.find(row => row.id === id)! as Classroom
}
function branches(result: Awaited<ReturnType<typeof projectOperations>>): Classroom[] {
  return result.records.sessions.filter(row => row.id.startsWith('reading-conflict:')) as Classroom[]
}
const databases: JoveDatabase[] = []
afterEach(async () => { for (const database of databases.splice(0)) await database.delete() })

describe('coherent starter-classroom conflict recovery', () => {
  it.each(['en', 'ja'])('keeps both %s unsent answers and complete conditions, without field mixing', async language => {
    const base = classroom(language), a = edited(base, 'A original answer', { helped: true, helpCount: 2, romaji: language === 'ja', audioId: 'original-a', audioIds: ['original-a'] })
    const b = edited(base, 'B original answer', { mode: 'audio-transcript', audioId: 'original-b', audioIds: ['original-b'], activeMs: 7000 })
    const history = [...seed(base), recording('original-a'), recording('original-b'), op('sessions', a, 3, deviceA, base), op('sessions', b, 3, deviceB, base)]
    const originals = canonical(history)
    const result = await projectOperations(history), copy = branches(result)[0]!
    expect(parent(result, base.id).draft).toEqual({ ...b.draft, syncReadingConflicts: [copy.id] })
    expect(copy.kind).toBe('starter-classroom')
    expect(copy.draft).toEqual({ ...a.draft, syncRecovery: expect.objectContaining({ sourceSessionId: base.id, rootSessionId: base.id, sourceDeviceId: deviceA, sourceVersion: expect.stringMatching(/^[a-f0-9]{64}$/) }) })
    expect(result.conflicts).toHaveLength(1)
    expect(result.records.audioMetadata.map(row => row.id).sort()).toEqual(['original-a', 'original-b'])
    expect(canonical(await projectOperations([...history].reverse()))).toBe(canonical(result))
    expect(canonical(await projectOperations([...history, ...history]))).toBe(canonical(result))
    expect(canonical(history)).toBe(originals)
  })

  it('does not treat an autosave counter or missing-device audio marker as another answer', async () => {
    const base = classroom(), a = edited(base, 'Same saved answer'), b = edited(a, a.draft.response as string, { activeMs: 7000, audioUnavailable: true, missingAudioIds: [] })
    const result = await projectOperations([...seed(base), op('sessions', a, 3, deviceA, base), op('sessions', b, 4, deviceB, a)])
    expect(result.records.sessions).toEqual([b])
    expect(result.conflicts).toEqual([])
  })

  it('retains the originating-device frontier after another device saves the projected winner', async () => {
    const base = classroom(), a = edited(base, 'A original'), b = edited(base, 'B original')
    const history = [...seed(base), op('sessions', a, 3, deviceA, base), op('sessions', b, 4, deviceB, base)]
    const first = await projectOperations(history), firstCopy = branches(first)[0]!
    const normalized = { ...parent(first, base.id), draft: { ...parent(first, base.id).draft, revision: 8, activeMs: 9000 } }
    history.push(op('sessions', normalized, 5, deviceA, a))
    const result = await projectOperations(history)
    expect(branches(result)).toHaveLength(1)
    expect(branches(result)[0]!.id).toBe(firstCopy.id)
    expect(branches(result)[0]!.draft.response).toBe('A original')
    expect(parent(result, base.id).draft.response).toBe('B original')
  })

  it('preserves both active devices when a completed snapshot is the parent, and never moves their events', async () => {
    const base = classroom(), done: Classroom = { ...base, stage: 'done', completedAt: now + 20, draft: { ...base.draft, revision: 8, response: '', lastAttemptId: '' } }
    const a = edited(base, 'A delayed answer', { lastAttemptId: 'attempt-a' }), b = edited(base, 'B delayed answer', { helped: true, lastAttemptId: 'attempt-b' })
    const attempts = [a, b].map((row, i) => ({ id: `attempt-${i ? 'b' : 'a'}`, type: 'STARTER_ATTEMPT', sessionId: base.id, timestamp: now + i,
      source: 'text', prompted: row.draft.helped, data: { lessonId: base.materialId, lessonVersion: 1, response: row.draft.response, contextId: row.draft.contextId, stage: row.stage, mode: row.draft.mode } }))
    const complete = { id: 'completion', type: 'TASK_COMPLETED', sessionId: base.id, timestamp: done.completedAt, source: 'objective',
      data: { taskId: base.id, kind: 'starter-classroom', lessonId: base.materialId, lessonVersion: 1 } }
    const history = [...seed(base), op('sessions', done, 3, deviceC, base), op('sessions', a, 4, deviceA, base), op('sessions', b, 5, deviceB, base),
      ...attempts.map((row, i) => op('events', row, 6, i ? deviceB : deviceA)), op('events', complete, 6, deviceC)]
    const result = await projectOperations(history)
    expect(parent(result, base.id)).toMatchObject(done)
    expect(branches(result).map(row => row.draft.response).sort()).toEqual(['A delayed answer', 'B delayed answer'])
    expect((parent(result, base.id).draft.syncReadingConflicts as string[])).toHaveLength(2)
    expect(result.conflicts[0]!.operationIds).toHaveLength(2)
    expect(result.records.events).toEqual(expect.arrayContaining(attempts))
    expect(result.records.events.every(row => row.sessionId === base.id)).toBe(true)
  })

  it('does not fork propagated recovery copies, or overwrite an old copy when its source advances', async () => {
    const base = classroom(), a = edited(base, 'A original'), b = edited(base, 'B original')
    const history = [...seed(base), op('sessions', a, 3, deviceA, base), op('sessions', b, 4, deviceB, base)]
    const first = await projectOperations(history), oldCopy = branches(first)[0]!
    history.push(op('sessions', oldCopy, 5, deviceB), op('sessions', parent(first, base.id), 5, deviceB, b))
    const propagated = await projectOperations(history)
    expect(branches(propagated)).toEqual([oldCopy])
    const nextA = edited(a, 'A newer unsent answer'), nextB = edited(b, 'B newer unsent answer')
    history.push(op('sessions', nextA, 6, deviceA, a), op('sessions', nextB, 7, deviceB, b))
    const result = await projectOperations(history)
    expect(branches(result).map(row => row.draft.response).sort()).toEqual(['A newer unsent answer', 'A original'])
    expect(branches(result).find(row => row.id === oldCopy.id)).toEqual(oldCopy)
    expect(parent(result, base.id).draft.response).toBe('B newer unsent answer')
    expect((parent(result, base.id).draft.syncReadingConflicts as string[]).sort()).toEqual(branches(result).map(row => row.id).sort())
    expect(new Set(result.records.sessions.map(row => row.id)).size).toBe(result.records.sessions.length)
  })

  it('keeps both device frontiers when both devices normalize a completed parent', async () => {
    const base = classroom(), done = { ...base, stage: 'done', completedAt: now + 10 }
    const a = edited(base, 'A original'), b = edited(base, 'B original')
    const history = [...seed(base), op('sessions', done, 3, deviceC, base), op('sessions', a, 4, deviceA, base), op('sessions', b, 5, deviceB, base)]
    const first = await projectOperations(history), firstParent = parent(first, base.id)
    history.push(op('sessions', { ...firstParent, draft: { ...firstParent.draft, revision: 20 } }, 6, deviceA, a),
      op('sessions', { ...firstParent, draft: { ...firstParent.draft, activeMs: 5000 } }, 7, deviceB, b))
    const result = await projectOperations(history)
    expect(branches(result).map(row => row.id).sort()).toEqual(branches(first).map(row => row.id).sort())
    expect(branches(result).map(row => row.draft.response).sort()).toEqual(['A original', 'B original'])
  })

  it('removes only superseded generated seeds during later paged merges', async () => {
    const base = classroom(), a = edited(base, 'A original'), b = edited(base, 'B original')
    const history = [...seed(base), op('sessions', a, 3, deviceA, base), op('sessions', b, 4, deviceB, base)]
    const database = new JoveDatabase(`starter-sync-${crypto.randomUUID()}`); databases.push(database)
    await database.profiles.put({ ...defaultProfile(), onboarded: true })
    await database.settings.put({ id: 'main', value: { ...defaultSettings } })
    const journal = new SyncJournal(database); await journal.bindOwner(owner)
    await journal.merge(history.map((row, i) => ({ ...row, cursor: i + 100, receivedAt: now + 100 })), 103)
    const first = await projectOperations(history), oldCopy = branches(first)[0]!
    const advertised = op('sessions', parent(first, base.id), 5, deviceB, b)
    const newA = op('sessions', edited(a, 'A newer original'), 6, deviceA, a)
    const newB = op('sessions', edited(b, 'B newer original'), 7, deviceB, b)
    for (const [i, row] of [advertised, newA, newB].entries()) {
      history.push(row); await journal.merge([{ ...row, cursor: 104 + i, receivedAt: now + 100 }], 104 + i)
    }
    const expected = await projectOperations(history)
    expect(await database.sessions.get(oldCopy.id)).toBeUndefined()
    expect((await database.sessions.toArray()).sort((x, y) => x.id.localeCompare(y.id))).toEqual([...expected.records.sessions].sort((x, y) => x.id.localeCompare(y.id)))
    expect(branches(expected).map(row => row.draft.response)).toEqual(['A newer original'])
  })

  it('keeps an explicitly chosen new recovery session separate from its immutable source copy', async () => {
    const base = classroom(), a = edited(base, 'A original'), b = edited(base, 'B original')
    const history = [...seed(base), op('sessions', a, 3, deviceA, base), op('sessions', b, 4, deviceB, base)]
    const first = await projectOperations(history), copy = branches(first)[0]!
    const recovery = { ...copy, id: 'starter-en-explicit-recovery', startedAt: now + 1, draft: { ...copy.draft,
      response: 'A deliberately continued response', revision: 0, workloadTaskId: base.id,
      syncRecovery: { ...copy.draft.syncRecovery as object, sourceSessionId: copy.id } } }
    history.push(op('sessions', copy, 5, deviceB), op('sessions', recovery, 6, deviceA))
    const result = await projectOperations(history)
    expect(result.records.sessions.find(row => row.id === recovery.id)).toEqual(recovery)
    expect(result.records.sessions.find(row => row.id === copy.id)).toEqual(copy)
    expect(branches(result)).toHaveLength(1)
  })

  it('attests a new completed recovery by its own session and time, with the shared root workload task', async () => {
    const root = classroom(), rootDone = { ...root, stage: 'done', completedAt: now + 20 }
    const recovery: Classroom = { ...root, id: 'starter-en-recovered', startedAt: now + 30, draft: { ...root.draft,
      workloadTaskId: root.id, syncRecovery: { sourceSessionId: 'reading-conflict:original', rootSessionId: root.id, sourceDeviceId: deviceA, sourceVersion: 'a'.repeat(64) } } }
    const torn = { ...recovery, stage: 'done', completedAt: now + 40, draft: { ...recovery.draft, response: 'Unattested torn snapshot' } }
    const completed = { ...recovery, stage: 'done', completedAt: now + 50, draft: { ...recovery.draft, response: '', revision: 3 } }
    const completion = (row: Classroom) => ({ id: `${row.id}:completed`, type: 'TASK_COMPLETED', sessionId: row.id,
      timestamp: row.completedAt, source: 'objective', data: { taskId: root.id, kind: 'starter-classroom', lessonId: root.materialId, lessonVersion: 1 } })
    const rootReceipt = completion(rootDone), recoveryReceipt = completion(completed)
    const result = await projectOperations([...seed(root), op('sessions', rootDone, 3, deviceA, root), op('events', rootReceipt, 4),
      op('sessions', recovery, 5), op('sessions', torn, 6, deviceA, recovery), op('sessions', completed, 7, deviceB, recovery), op('events', recoveryReceipt, 8, deviceB)])
    expect(parent(result, root.id).completedAt).toBe(rootDone.completedAt)
    expect(parent(result, recovery.id).completedAt).toBe(completed.completedAt)
    expect(parent(result, recovery.id).draft.response).toBe('')
    expect(result.records.events).toEqual(expect.arrayContaining([rootReceipt, recoveryReceipt]))
    expect(result.records.events).toHaveLength(2)
    expect(result.records.events.every(row => (row.data as Record<string, unknown>).taskId === root.id)).toBe(true)
  })

  it('retains the root and immediate source through nested recovery conflicts using only the four agreed fields', async () => {
    const root = classroom(), recovered: Classroom = { ...root, id: 'starter-en-recovery-one', startedAt: now + 10, draft: { ...root.draft,
      workloadTaskId: root.id, syncRecovery: { sourceSessionId: 'reading-conflict:first', rootSessionId: root.id, sourceDeviceId: deviceA, sourceVersion: 'b'.repeat(64) } } }
    const a = edited(recovered, 'A nested original', { lastAttemptId: 'original-recovery-attempt' }), b = edited(recovered, 'B nested original')
    const attempt = { id: 'original-recovery-attempt', type: 'STARTER_ATTEMPT', sessionId: recovered.id, timestamp: now + 11, source: 'text',
      prompted: false, data: { lessonId: root.materialId, lessonVersion: 1, stage: 'transfer', contextId: root.draft.contextId, response: a.draft.response, mode: 'text' } }
    const result = await projectOperations([...seed(root), op('sessions', recovered, 3), op('sessions', a, 4, deviceA, recovered),
      op('sessions', b, 5, deviceB, recovered), op('events', attempt, 6)])
    const copy = branches(result)[0]!
    expect(copy.draft.workloadTaskId).toBe(root.id)
    expect(copy.draft.lastAttemptId).toBe(attempt.id)
    expect(copy.draft.syncRecovery).toEqual({ sourceSessionId: recovered.id, rootSessionId: root.id, sourceDeviceId: deviceA, sourceVersion: expect.any(String) })
    expect(result.records.events).toEqual([attempt])
  })

  it('does not regenerate an explicitly deleted recovery copy from old source history', async () => {
    const base = classroom(), a = edited(base, 'A original'), b = edited(base, 'B original')
    const history = [...seed(base), op('sessions', a, 3, deviceA, base), op('sessions', b, 4, deviceB, base)]
    const copy = branches(await projectOperations(history))[0]!
    history.push(parseOperation({ id: crypto.randomUUID(), deviceId: deviceA, logicalClock: 5, entityType: 'sessions', entityId: copy.id, kind: 'delete', schemaVersion: 1, payload: {} }))
    const result = await projectOperations(history)
    expect(branches(result)).toEqual([])
    expect(parent(result, base.id).draft.syncReadingConflicts).toBeUndefined()
  })

  it('does not create a conflict for an untouched teach-only placeholder', async () => {
    const base = { ...classroom(), stage: 'teach' }, a = { ...base, draft: { ...base.draft, activeMs: 3000 } }
    const b = { ...base, stage: 'recognize', draft: { ...base.draft, revision: 1 } }
    const result = await projectOperations([...seed(base), op('sessions', a, 3, deviceA, base), op('sessions', b, 4, deviceB, base)])
    expect(result.records.sessions).toEqual([b])
  })

  it('does not fork a merely opened, unanswered review into another recovery obligation', async () => {
    const base = classroom(), review = { ...base, draft: { ...base.draft, purpose: 'review' } }
    const answer = edited(review, 'A fresh independent review answer')
    const result = await projectOperations([...seed(review), op('sessions', answer, 3, deviceB, review)])
    expect(result.records.sessions).toEqual([answer])
    expect(result.conflicts).toEqual([])
  })

  it('does not truncate private recording references or cap distinct active-device branches', async () => {
    const base = classroom(), history = seed(base), audioIds = Array.from({ length: 40 }, (_, i) => `original-${i}`)
    history.push(...audioIds.map(recording))
    for (let i = 0; i < 14; i++) {
      const device = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
      history.push(op('sessions', edited(base, `Device ${i} original`, { audioIds }), i + 3, device, base))
    }
    const result = await projectOperations(history)
    expect(branches(result)).toHaveLength(13)
    expect(parent(result, base.id).draft.syncReadingConflicts).toHaveLength(13)
    for (const row of result.records.sessions) expect((row.draft as Record<string, unknown>).audioIds).toEqual(audioIds)
  })

  it.each(['en', 'ja'])('converges after paged %s journal downloads without capturing generated forks as local work', async language => {
    const base = classroom(language), a = edited(base, 'A original'), b = edited(base, 'B original')
    const history = [...seed(base), op('sessions', a, 3, deviceA, base), op('sessions', b, 4, deviceB, base)]
    const database = new JoveDatabase(`starter-sync-${crypto.randomUUID()}`, language as 'en' | 'ja'); databases.push(database)
    await database.profiles.put({ ...defaultProfile(), onboarded: true })
    await database.settings.put({ id: 'main', value: { ...defaultSettings } })
    const journal = new SyncJournal(database); await journal.bindOwner(owner)
    for (const [i, row] of [...history].reverse().entries()) await journal.merge([{ ...row, cursor: i + 100, receivedAt: now + 100 }], i + 100)
    const expected = await projectOperations(history)
    expect((await database.sessions.toArray()).sort((x, y) => x.id.localeCompare(y.id))).toEqual([...expected.records.sessions].sort((x, y) => x.id.localeCompare(y.id)))
    await journal.capture()
    expect((await journal.pending()).filter(row => row.entityType === 'sessions')).toEqual([])
  })
})
