import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyCard, fsrs, type Card } from 'ts-fsrs'
import Dexie from 'dexie'
import { createClient } from '@supabase/supabase-js'
import { db as repositoryDatabase, JoveDatabase, version1Stores } from '../src/db/db'
import { defaultProfile, defaultSettings, type Chunk, type StudyEvent } from '../src/domain/types'
import { canonical, changedFields, eventOccurrenceKey, isPrivateAudio, parseOperation, projectOperations, withoutCacheAudioReferences, type RecordValue, type StoredOperation, type SyncOperation } from '../src/sync/protocol'
import { SyncJournal, resolveEventAliases } from '../src/sync/journal'
import { restoreReviewAttempt, reviewAttempt, reviewAttemptCompleted, selectedReviewCard } from '../src/sync/review'
import { jsonbBytes, MAX_UPLOAD_BYTES, SupabaseSyncRemote, synchronize, uploadBatch, type SyncRemote } from '../src/sync/remote'
import { bindSyncAccess } from '../src/sync/access'
import { audioHash, downloadRecording, readRecordingRetention, referencedAudio, retentionDecision, synchronizeAudio, uploadRecording, type AudioManifest } from '../src/sync/audio'
import { createCloudState } from '../src/stores/cloud'
import { protectedLocalChange, resetDeviceCacheAndKey } from '../src/sync/local-change'
import { exportBackup, restoreBackup } from '../src/db/repository'

describe('atomic Settings local changes with actual Dexie transactions', () => {
  it('rejects contradictory download receipts for an already acknowledged operation and rolls back the entire page', async () => {
    const { db, journal } = await local()
    const original = (await journal.pending())[0]!
    await journal.acknowledge([{ id: original.id, cursor: 100, receivedAt: now }])
    const before = await db.syncOperations.toArray(), snapshots = await db.syncSnapshots.toArray(), cursor = await journal.cursor()
    for (const conflicting of [{ cursor: 101, receivedAt: now }, { cursor: 100, receivedAt: now + 1 }]) {
      await expect(journal.merge([{ ...original, ...conflicting }], conflicting.cursor)).rejects.toThrow('Receipt identity collision')
      expect(await db.syncOperations.toArray()).toEqual(before)
      expect(await db.syncSnapshots.toArray()).toEqual(snapshots)
      expect(await journal.cursor()).toBe(cursor)
    }
    await journal.merge([{ ...original, cursor: 100, receivedAt: now }], 100)
    expect((await db.syncOperations.get(original.id))?.receivedAt).toBe(now)
  })
  it('rolls back the old Settings clear-every-table reset including owner, journal and private originals', async () => {
    const { db, journal } = await local(), asset = recording()
    await db.audio.put(asset)
    await db.sessions.put({ id: 'draft-before-reset', kind: 'listen', stage: 'draft', startedAt: now, draft: { answer: 'kept', audioId: asset.id } })
    await db.secrets.put({ id: 'openrouter', value: 'fixture-only-local-marker' })
    await journal.capture()
    const operations = await db.syncOperations.toArray(), meta = await db.syncMeta.toArray()
    const cloud = createCloudState(db, null)
    await expect(cloud.withLocalDataChange(async () => {
      for (const table of db.tables) await table.clear()
    })).rejects.toThrow('account or its sync history')
    expect(await db.syncOperations.toArray()).toEqual(operations)
    expect(await db.syncMeta.toArray()).toEqual(meta)
    expect((await db.sessions.get('draft-before-reset'))?.draft.answer).toBe('kept')
    expect(await audioHash((await db.audio.get(asset.id))!.blob)).toBe(await audioHash(asset.blob))
    expect(!!await db.secrets.get('openrouter')).toBe(true)
    expect(cloud.paused.value).toBe(false)
  })
  it('rejects owner changes, same-size original replacement and private-audio removal atomically', async () => {
    const { db } = await local(), asset = recording()
    await db.audio.put(asset)
    const cloud = createCloudState(db, null)
    const actions = [
      async () => { await db.syncMeta.put({ id: 'owner', value: deviceB }) },
      async () => { await db.audio.put({ ...asset, blob: new Blob([new Uint8Array([9,9,9,9,9,9,9,9])]) }) },
      async () => { await db.audio.delete(asset.id) },
    ]
    for (const action of actions) {
      await expect(cloud.withLocalDataChange(action)).rejects.toThrow()
      expect((await db.syncMeta.get('owner'))?.value).toBe(owner)
      expect(await audioHash((await db.audio.get(asset.id))!.blob)).toBe(await audioHash(asset.blob))
      expect(cloud.paused.value).toBe(false)
    }
  })
  it('resets only key/cache and creates no metadata deletes, while failed changes remain retryable', async () => {
    const { db, journal } = await local(), asset = recording()
    await db.audio.bulkPut([asset, { ...recording('cache'), kind: 'content-cache' }, { ...recording('tts'), kind: 'generated' }])
    await db.secrets.put({ id: 'openrouter', value: 'fixture-only-local-marker' })
    await db.sessions.put({ id: 'ongoing', kind: 'listen', stage: 'draft', startedAt: now, draft: { answer: 'retained' } })
    await journal.capture()
    const cloud = createCloudState(db, null), old = await db.syncOperations.toArray()
    await expect(cloud.withLocalDataChange(async () => { await resetDeviceCacheAndKey(db); throw new Error('Injected local failure') })).rejects.toThrow('Injected')
    expect(await db.audio.count()).toBe(3); expect(await db.secrets.count()).toBe(1)
    await cloud.withLocalDataChange(() => resetDeviceCacheAndKey(db))
    expect((await db.audio.toArray()).map(row => row.id)).toEqual([asset.id])
    expect(await db.secrets.count()).toBe(0)
    expect((await db.sessions.get('ongoing'))?.draft.answer).toBe('retained')
    expect(await db.syncOperations.toArray()).toEqual(old)
    expect((await journal.pending()).some(row => row.kind === 'delete')).toBe(false)
    expect((await db.syncMeta.get('owner'))?.value).toBe(owner)
  })
  it('merges a real older repository backup without erasing new drafts, evidence, recordings or original operations', async () => {
    const db = repositoryDatabase; databases.push(db)
    await db.open()
    await db.profiles.put({ ...defaultProfile(), onboarded: true })
    await db.settings.put({ id: 'main', value: { ...defaultSettings } })
    await db.events.put(event('in-backup'))
    const backup = await exportBackup()
    const journal = new SyncJournal(db)
    await journal.bindOwner(owner)
    const asset = recording()
    await db.audio.put(asset)
    await db.events.put(event('after-backup', 0.9))
    await db.sessions.put({ id: 'after-backup-draft', kind: 'listen', stage: 'draft', startedAt: now, draft: { answer: 'newer original', audioId: asset.id } })
    await journal.capture()
    const oldOperations = await db.syncOperations.toArray(), cloud = createCloudState(db, null)
    await cloud.withLocalDataChange(() => restoreBackup(backup))
    expect((await db.events.toArray()).map(row => row.id).sort()).toEqual(['after-backup', 'in-backup'])
    expect((await db.sessions.get('after-backup-draft'))?.draft.answer).toBe('newer original')
    expect(await audioHash((await db.audio.get(asset.id))!.blob)).toBe(await audioHash(asset.blob))
    for (const operation of oldOperations) expect(await db.syncOperations.get(operation.id)).toEqual(operation)
    expect((await journal.pending()).some(row => row.kind === 'delete')).toBe(false)
    await expect(cloud.withLocalDataChange(() => restoreBackup('{broken'))).rejects.toThrow('JSON')
    expect(cloud.paused.value).toBe(false)
    expect((await db.sessions.get('after-backup-draft'))?.draft.answer).toBe('newer original')
    await cloud.withLocalDataChange(() => restoreBackup(backup))
    expect((await journal.pending()).some(row => row.kind === 'delete')).toBe(false)
  })
  it('preserves offline-only history through local replacement without inventing a cloud owner', async () => {
    const db = new JoveDatabase('unowned-restore-' + crypto.randomUUID()); databases.push(db)
    await db.events.put(event('offline-original'))
    const cloud = createCloudState(db, null)
    await cloud.withLocalDataChange(async () => { await db.events.clear(); await db.events.put(event('imported')) })
    expect((await db.events.toArray()).map(row => row.id).sort()).toEqual(['imported', 'offline-original'])
    expect(await db.syncMeta.get('owner')).toBeUndefined()
    expect((await db.syncOperations.toArray()).map(row => row.entityId).sort()).toEqual(['imported', 'offline-original'])
  })
  it('does not resume a manually paused store or accept overlapping local callbacks', async () => {
    const { db } = await local(), cloud = createCloudState(db, null)
    await cloud.pause()
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    const changing = cloud.withLocalDataChange(async () => { entered(); await Dexie.waitFor(waiting) })
    await ready
    await expect(cloud.resume()).rejects.toThrow('still in progress')
    await expect(cloud.withLocalDataChange(async () => {})).rejects.toThrow('still in progress')
    release(); await changing
    expect(cloud.paused.value).toBe(true)
    await cloud.resume()
    expect(cloud.paused.value).toBe(false)
  })
  it('honors a new manual pause during a local change and preserves the authoritative retention mirror offline', async () => {
    const { db } = await local(), cloud = createCloudState(db, null)
    await db.settings.put({ id: 'main', value: { ...defaultSettings, recordingRetention: 'more-history' } })
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    const changing = cloud.withLocalDataChange(async () => {
      await db.settings.put({ id: 'main', value: { ...defaultSettings, recordingRetention: 'assessment-only' } })
      entered(); await Dexie.waitFor(waiting)
    })
    await ready; await cloud.pause(); release(); await changing
    expect(cloud.paused.value).toBe(true)
    expect((await db.settings.get('main'))?.value.recordingRetention).toBe('more-history')
    await cloud.resume()
  })
  it('serializes another database connection behind a replacement and never exposes an empty owner or deleted draft', async () => {
    const { db, journal } = await local()
    await db.sessions.put({ id: 'two-tab-draft', kind: 'listen', stage: 'draft', startedAt: now, draft: { answer: 'kept' } })
    await journal.capture()
    const other = new JoveDatabase(db.name)
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    const replacing = protectedLocalChange(db, async () => { await db.sessions.clear(); entered(); await Dexie.waitFor(waiting) })
    try {
      await ready
      const observer = other.transaction('r', other.sessions, other.syncMeta, async () => ({
        owner: (await other.syncMeta.get('owner'))?.value, draft: await other.sessions.get('two-tab-draft'),
      }))
      release(); await replacing
      expect(await observer).toMatchObject({ owner, draft: { draft: { answer: 'kept' } } })
    } finally { release?.(); other.close() }
  })
})


function sdkAudioFixture() {
  const config = { url: 'https://jove-sync-test.invalid', publishableKey: 'sb_publishable_test_only' }
  const manifests = new Map<string, AudioManifest>(), objects = new Map<string, Blob>(), server = new Server()
  let principal = owner, token = 'test-token-a', member = true, policy = 'minimal', hook: ((path: string) => Promise<void>) | undefined
  const requests: { path: string; authorization: string | null }[] = []
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'
    requests.push({ path: url.pathname, authorization: new Headers(init?.headers).get('Authorization') })
    await hook?.(url.pathname)
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.pathname.endsWith('/app_members')) return json(member ? [{ user_id: owner }] : [])
    if (url.pathname.endsWith('/service_preferences')) return json([{ recording_retention: policy }])
    if (url.pathname.endsWith('/append_sync_operations')) {
      const rows = await server.upload(JSON.parse(String(init?.body)).operations)
      return json(rows.map(row => ({ ...row, received_at: new Date(row.receivedAt).toISOString() })))
    }
    if (url.pathname.endsWith('/sync_operations')) return json((await server.download(Number(url.searchParams.get('cursor')?.slice(3) ?? 0))).map(row => ({
      id: row.id, device_id: row.deviceId, logical_clock: row.logicalClock, entity_type: row.entityType, entity_id: row.entityId,
      kind: row.kind, schema_version: row.schemaVersion, payload: row.payload, cursor: row.cursor, received_at: new Date(row.receivedAt!).toISOString(),
    })))
    if (url.pathname.includes('/storage/v1/object/')) {
      const path = decodeURIComponent(url.pathname.split('/jove-recordings/')[1]!)
      if (method === 'POST') {
        if (objects.has(path)) return new Response('{"message":"exists"}', { status: 409 })
        const body = init?.body as FormData
        objects.set(path, body.get('') as Blob)
        return json({ Key: path })
      }
      const blob = objects.get(path)
      return blob ? new Response(blob) : new Response('missing', { status: 404 })
    }
    if (url.pathname.endsWith('/recording_manifest')) {
      if (method === 'POST') {
        const row = JSON.parse(String(init?.body)) as AudioManifest
        if (!manifests.has(row.audio_id)) manifests.set(row.audio_id, row)
        return json(null)
      }
      const filter = url.searchParams.get('audio_id') ?? ''
      const rows = [...manifests.values()].filter(row => filter.startsWith('eq.') ? row.audio_id === filter.slice(3) : row.audio_id > filter.slice(3))
        .sort((a, b) => a.audio_id < b.audio_id ? -1 : 1).slice(0, Number(url.searchParams.get('limit') ?? 500))
      return json(rows)
    }
    if (url.pathname.endsWith('/reconcile_recording_retention')) {
      const args = JSON.parse(String(init?.body)), row = manifests.get(args.recording_id)
      if (args.expected_policy !== policy || !row) return json(false)
      row.purpose = args.retention_purpose; row.expires_at = args.retention_expires_at
      return json(true)
    }
    throw new Error('Unexpected fixture request')
  }
  const client = createClient(config.url, config.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } })
  vi.spyOn(client.auth, 'getSession').mockImplementation(async () => ({ data: { session: { access_token: token, user: { id: principal, email: 'fixture@example.invalid' } } }, error: null }) as never)
  vi.spyOn(client.auth, 'getUser').mockImplementation(async () => ({ data: { user: { id: principal } }, error: null }) as never)
  vi.spyOn(client.auth, 'onAuthStateChange').mockReturnValue({ data: { subscription: { unsubscribe() {} } } } as never)
  return { config, client, manifests, objects, transport, requests, server,
    access: () => bindSyncAccess(client, owner, config, async () => {}, transport),
    switchUser() { principal = deviceB; token = 'test-token-b' }, setMember(value: boolean) { member = value },
    setPolicy(value: string) { policy = value }, setHook(value?: typeof hook) { hook = value },
  }
}
function recording(id = 'audio-fixture', processed = false) {
  return { id, blob: new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: 'audio/wav' }),
    mimeType: 'audio/wav', createdAt: Date.now(), duration: 1, kind: 'recording' as const, processed, label: 'Fixture' }
}
describe('private audio uses the real SDK builders with fixed-principal access', () => {
  it('never journals or uploads generated/content caches and preserves authentic playback metadata', async () => {
    const { db, journal } = await local(), fixture = sdkAudioFixture(), access = await fixture.access()
    for (const kind of ['generated', 'content-cache']) {
      const cache = { ...recording(kind), kind: kind as ReturnType<typeof recording>['kind'] }
      expect(isPrivateAudio(kind)).toBe(false)
      expect(retentionDecision(cache, 'more-history', { active: true, assessment: true, pronunciation: true }, Date.now())).toBeNull()
      await db.audio.put(cache)
      await expect(uploadRecording(access, cache, { purpose: 'draft', expiresAt: null })).rejects.toThrow('Only private recordings')
    }
    await db.sessions.put({ id: 'cache-session', kind: 'listen', startedAt: now, stage: 'draft', draft: { audioIds: ['content-cache'], answer: 'original answer' } })
    await journal.capture()
    expect((await journal.pending()).filter(row => row.entityType === 'audioMetadata')).toEqual([])
    expect((await journal.pending()).find(row => row.entityId === 'cache-session')?.payload.record?.draft).toEqual({ audioIds: [], answer: 'original answer' })
    expect(fixture.requests).toHaveLength(0)
    const metadata = { sha256: 'a'.repeat(64), segment: 'clip', range: [1, 2], sentence: 'Source sentence' }
    expect(withoutCacheAudioReferences({ id: 'material', audioId: 'content-cache', authenticPlayback: metadata }, new Set(['content-cache']))).toEqual({ id: 'material', authenticPlayback: metadata })
    expect(await db.audio.count()).toBe(2)
  })
  it('uploads immutable originals idempotently, verifies downloads and preserves hash collisions', async () => {
    const fixture = sdkAudioFixture(), access = await fixture.access(), asset = recording()
    const first = await uploadRecording(access, asset, { purpose: 'draft', expiresAt: null })
    expect(await uploadRecording(access, asset, { purpose: 'draft', expiresAt: null })).toEqual(first)
    expect(fixture.requests.filter(row => row.path.includes('/storage/') && row.path.includes('/object/'))).toHaveLength(1)
    const { blob, ...metadata } = asset
    expect(await audioHash((await downloadRecording(access, first, metadata)).blob)).toBe(await audioHash(blob))
    await expect(uploadRecording(access, { ...asset, blob: new Blob(['different']) }, { purpose: 'draft', expiresAt: null })).rejects.toThrow('Neither copy')
    expect(fixture.requests.every(row => row.authorization === 'Bearer test-token-a')).toBe(true)
    expect(fixture.manifests.get(asset.id)?.sha256).toBe(await audioHash(blob))
  })
  it('does not confirm or download A under B when session switches inside a Storage request', async () => {
    const fixture = sdkAudioFixture(), access = await fixture.access(), asset = recording()
    fixture.setHook(async path => { if (path.includes('/storage/')) fixture.switchUser() })
    await expect(uploadRecording(access, asset, { purpose: 'draft', expiresAt: null })).rejects.toThrow()
    expect(fixture.manifests.size).toBe(0)
    expect(fixture.requests.every(row => row.authorization === 'Bearer test-token-a')).toBe(true)
    expect(asset.blob.size).toBe(8)
  })
  it('recovers an object uploaded before a crash without overwriting it', async () => {
    const fixture = sdkAudioFixture(), access = await fixture.access(), asset = recording()
    const path = owner + '/' + asset.id + '-' + await audioHash(asset.blob)
    fixture.objects.set(path, asset.blob)
    expect((await uploadRecording(access, asset, { purpose: 'draft', expiresAt: null })).object_path).toBe(path)
    expect(fixture.objects.size).toBe(1)
  })
  it('recognizes array and nested conversation/repair audio references', () => {
    expect([...referencedAudio({ audioIds: ['a', 'b'], messages: [{ audioId: 'c' }], repairAudio: { attempt: 'd' } })].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
  it('uses complete paginated manifests, retains conversation drafts and applies policy changes without sliding TTL', async () => {
    const { db, journal } = await local(), fixture = sdkAudioFixture(), access = await fixture.access(), asset = recording('active', true)
    await db.audio.add(asset)
    await db.conversations.put({ id: 'conversation', mode: 'free', scenario: '', startedAt: now, messages: [{ id: 'message', role: 'user', text: '', timestamp: now, audioId: asset.id }] })
    await synchronize(journal, fixture.server)
    await synchronizeAudio(db, access, 'minimal')
    expect(fixture.manifests.get(asset.id)?.expires_at).toBeNull()
    await db.conversations.update('conversation', { completedAt: Date.now() })
    await synchronize(journal, fixture.server)
    fixture.setPolicy('more-history')
    await synchronizeAudio(db, access, await readRecordingRetention(access))
    const deadline = new Date(asset.createdAt + 30 * 86400000).toISOString()
    expect(fixture.manifests.get(asset.id)?.expires_at).toBe(deadline)
    await synchronizeAudio(db, access, 'more-history')
    expect(fixture.manifests.get(asset.id)?.expires_at).toBe(deadline)
    fixture.setPolicy('assessment-only')
    await synchronizeAudio(db, access, await readRecordingRetention(access))
    expect(fixture.manifests.get(asset.id)?.expires_at).toBe(new Date(asset.createdAt + 7 * 86400000).toISOString())
    for (let i = 0; i < 501; i++) fixture.manifests.set('page-' + String(i).padStart(3, '0'), { ...fixture.manifests.get(asset.id)!, audio_id: 'page-' + String(i).padStart(3, '0') })
    const result = await synchronizeAudio(db, access, 'assessment-only')
    expect(result.hasMore).toBe(false); expect(result.blocked).toBe(501)
    expect((await db.audio.get(asset.id))?.blob.size).toBe(8)
  })
  it('does not replace a recording saved in another tab while its download was in flight', async () => {
    const { db, journal } = await local(), fixture = sdkAudioFixture(), access = await fixture.access(), asset = recording()
    await uploadRecording(access, asset, { purpose: 'draft', expiresAt: null })
    const { blob, ...metadata } = asset
    await db.syncMeta.put({ id: 'remoteAudio', value: [metadata] })
    await synchronize(journal, fixture.server)
    await db.syncMeta.put({ id: 'remoteAudio', value: [metadata] })
    let injected = false
    fixture.setHook(async path => {
      if (path.includes('/storage/') && !injected) { injected = true; await db.audio.add({ ...asset, blob: new Blob(['concurrent-original']) }) }
    })
    const result = await synchronizeAudio(db, access, 'minimal')
    expect(result.blocked).toBe(1)
    expect(await (await db.audio.get(asset.id))?.blob.text()).toBe('concurrent-original')
    expect(blob.size).toBe(8)
  })
})
describe('cloud store reset fences and completion state', () => {
  it('invalidates an in-flight request before reset and retries its durable identity after resume', async () => {
    const { db, journal } = await local(), fixture = sdkAudioFixture(); vi.stubGlobal('fetch', fixture.transport)
    const cloud = createCloudState(db, fixture.client, fixture.config)
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve }), dispatched = new Promise<void>(resolve => { entered = resolve })
    try {
      await cloud.start(async () => {})
      await db.sessions.add({ id: 'during-reset', kind: 'listen', stage: 'draft', startedAt: now, draft: { answer: 'safe' } })
      fixture.setHook(async path => { if (path.endsWith('/append_sync_operations')) { entered(); await waiting } })
      const running = cloud.syncNow()
      await dispatched
      const paused = cloud.beforeLocalReset()
      release(); await running; await paused
      const ids = (await journal.pending()).map(row => row.id)
      expect(ids.length).toBeGreaterThan(0)
      expect(cloud.lastSynced.value).toBe(0)
      fixture.setHook()
      await cloud.resume()
      expect(await journal.pendingCount()).toBe(0)
      expect(fixture.server.rows.filter(row => ids.includes(row.id))).toHaveLength(ids.length)
      expect((await db.sessions.get('during-reset'))?.draft.answer).toBe('safe')
    } finally { release?.(); await cloud.stop() }
  })
  it('does not bind a legacy local database to an authenticated nonmember', async () => {
    const db = new JoveDatabase('nonmember-' + crypto.randomUUID()); databases.push(db)
    const fixture = sdkAudioFixture(); fixture.setMember(false); vi.stubGlobal('fetch', fixture.transport)
    const cloud = createCloudState(db, fixture.client, fixture.config)
    try {
      await cloud.start(async () => {})
      expect(await db.syncMeta.get('owner')).toBeUndefined()
      expect(cloud.userId.value).toBe('')
      expect(cloud.problem.value).not.toBe('')
    } finally { await cloud.stop() }
  })
  it('pauses network sync around reset, journals unsent drafts and resumes using server retention', async () => {
    const { db, journal } = await local(), fixture = sdkAudioFixture()
    fixture.setPolicy('more-history'); vi.stubGlobal('fetch', fixture.transport)
    const cloud = createCloudState(db, fixture.client, fixture.config)
    try {
      await cloud.start(async () => {})
      expect(cloud.status.value).toBe('Synced')
      await db.sessions.add({ id: 'unsent', kind: 'listen', stage: 'draft', startedAt: now, draft: { answer: 'not lost' } })
      await cloud.beforeLocalReset()
      const count = fixture.requests.length
      await cloud.syncNow()
      expect(fixture.requests.length).toBe(count)
      expect((await journal.pending()).some(row => row.entityId === 'unsent')).toBe(true)
      expect(cloud.status.value).toBe('Sync paused')
      await cloud.resume()
      expect((await db.settings.get('main'))?.value.recordingRetention).toBe('more-history')
      expect((await journal.pendingCount())).toBe(0)
      expect(cloud.status.value).toBe('Synced')
    } finally { await cloud.stop() }
  })
  it('never reports synced when a valid operation has a missing dependency', async () => {
    const { db } = await local(), fixture = sdkAudioFixture(); vi.stubGlobal('fetch', fixture.transport)
    await fixture.server.upload([op('sessions', { id: 'needs-material', kind: 'listen', materialId: 'not-downloaded', startedAt: now, stage: 'draft', draft: {} })])
    const cloud = createCloudState(db, fixture.client, fixture.config)
    try {
      await cloud.start(async () => {})
      expect(cloud.deferred.value).toBeGreaterThan(0)
      expect(cloud.lastSynced.value).toBe(0)
      expect(cloud.status.value).not.toBe('Synced')
    } finally { await cloud.stop() }
  })
})


const deviceA = '00000000-0000-4000-8000-000000000001', deviceB = '00000000-0000-4000-8000-000000000002'
const owner = '00000000-0000-4000-8000-000000000010'
const now = 1788815000000
const chunk = (): Chunk => ({ id: 'chunk', text: 'a phrase', meaningEn: 'meaning', meaningZh: '', sourceSentence: 'A phrase.', examples: [], register: 'neutral', sourceIds: [], readingStrength: 0, listeningStrength: 0, recallStrength: 0, productionStrength: 0, spontaneousUses: 0, createdAt: now })
function op(type: SyncOperation['entityType'], record: RecordValue, logicalClock = 1, deviceId = deviceA, previous?: RecordValue): SyncOperation {
  return parseOperation({ id: crypto.randomUUID(), deviceId, logicalClock, entityType: type, entityId: record.id, kind: 'put', schemaVersion: 1,
    payload: { record, changed: changedFields(previous, record) } })
}
const event = (id: string, score = 0.7): StudyEvent => ({ id, type: 'COMPREHENSION_RESPONSE', timestamp: now, score, source: 'objective', skill: 'naturalListening' })
const databases: JoveDatabase[] = []
async function local() {
  const db = new JoveDatabase(`sync-test-${crypto.randomUUID()}`); databases.push(db)
  await db.profiles.put({ ...defaultProfile(), onboarded: true })
  await db.settings.put({ id: 'main', value: { ...defaultSettings } })
  const journal = new SyncJournal(db)
  await journal.bindOwner(owner)
  return { db, journal }
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const db of databases.splice(0)) await db.delete() })
class Server implements SyncRemote {
  rows: StoredOperation[] = []
  fail = false
  uploads: SyncOperation[][] = []
  async upload(operations: SyncOperation[], principal = owner) {
    if (principal !== owner) throw new Error('Wrong owner')
    if (this.fail) throw new Error('Offline')
    if (jsonbBytes(operations) > 4_194_304) throw new Error('Invalid sync batch')
    this.uploads.push(operations)
    let known = this.rows.reduce((max, row) => Math.max(max, row.logicalClock), 0)
    return operations.map(value => {
      let row = this.rows.find(row => row.id === value.id)
      if (!row) {
        if (value.logicalClock > known + 1) throw new Error('Logical clock jump')
        known = Math.max(known, value.logicalClock)
        row = { ...value, cursor: this.rows.length + 1, receivedAt: now }; this.rows.push(row)
      }
      return { id: row.id, cursor: row.cursor!, receivedAt: row.receivedAt! }
    })
  }
  async download(cursor: number, principal = owner) { if (principal !== owner) throw new Error('Wrong owner'); if (this.fail) throw new Error('Offline'); return this.rows.filter(row => row.cursor! > cursor).slice(0, 500) }
}

describe('event union and deterministic projections', () => {
  it('preserves independent offline evidence, deduplicates retries and converges regardless of arrival order', async () => {
    const a = op('events', event('heard') as unknown as RecordValue), b = op('events', event('spoke', 0.4) as unknown as RecordValue, 1, deviceB)
    const left = await projectOperations([a, b, a]), right = await projectOperations([b, a])
    expect(canonical(left)).toBe(canonical(right))
    expect(left.records.events).toHaveLength(2)
    expect(left.skills.find(row => row.id === 'naturalListening')!.evidenceCount).toBe(2)
  })
  it('retains both legacy events whose old counter-based IDs collide', async () => {
    const a = op('events', event('review:old:1') as unknown as RecordValue)
    const b = op('events', event('review:old:1', 0.2) as unknown as RecordValue, 1, deviceB)
    const result = await projectOperations([b, a])
    expect(result.records.events).toHaveLength(2)
    expect(new Set(result.records.events.map(row => row.id)).size).toBe(2)
    expect(result.conflicts).toHaveLength(1)
    expect(canonical(result)).toBe(canonical(await projectOperations([a, b])))
  })
  it('merges different setting fields without a whole-snapshot overwrite', async () => {
    const original = { id: 'main', value: { ...defaultSettings } }, baseline = op('settings', original)
    const light = op('settings', { ...original, value: { ...original.value, theme: 'light' } }, 2, deviceA, original)
    const quiet = op('settings', { ...original, value: { ...original.value, chineseHelp: false } }, 2, deviceB, original)
    expect((await projectOperations([quiet, light, baseline])).records.settings[0]!.value).toMatchObject({ theme: 'light', chineseHelp: false })
  })
  it('unions concurrent conversation messages and independent draft fields', async () => {
    const base = { id: 'talk', mode: 'free', scenario: 'Daily life', messages: [], startedAt: now }
    const a = { ...base, messages: [{ id: 'a', role: 'user', text: 'Hello', timestamp: now }] }
    const b = { ...base, messages: [{ id: 'b', role: 'assistant', text: 'Welcome', timestamp: now + 1 }] }
    expect((await projectOperations([op('conversations', base), op('conversations', a, 2, deviceA, base), op('conversations', b, 2, deviceB, base)])).records.conversations[0]!.messages).toHaveLength(2)
    const draft = { id: 'lesson', kind: 'listen', startedAt: now, stage: 'listen', draft: { answer: '', notes: '' } }
    const result = await projectOperations([op('sessions', draft), op('sessions', { ...draft, draft: { answer: 'My answer', notes: '' } }, 2, deviceA, draft),
      op('sessions', { ...draft, draft: { answer: '', notes: 'Useful phrase' } }, 2, deviceB, draft)])
    expect(result.records.sessions[0]!.draft).toEqual({ answer: 'My answer', notes: 'Useful phrase' })
  })
  it('uses logical ordering rather than the device wall clock and clamps future learning timestamps after receipt', async () => {
    const badClock = op('events', { ...event('future'), timestamp: now + 86400000 } as unknown as RecordValue)
    const row = (await projectOperations([{ ...badClock, receivedAt: now, cursor: 1 }])).records.events[0]!
    expect(row.timestamp).toBe(now)
    expect(row.data).toMatchObject({ clientTimestamp: now + 86400000 })
  })
  it('rebuilds FSRS from a baseline plus both new offline review events exactly once', async () => {
    const card = { id: 'chunk:recall', chunkId: 'chunk', modality: 'recall', card: createEmptyCard(new Date(now)), contextIds: [] }
    const seed = op('cards', card as unknown as RecordValue)
    seed.payload.baseEventIds = []
    const review = (id: string, timestamp: number) => ({ ...event(id), type: 'review', timestamp, chunkId: 'chunk', modality: 'recall', data: { cardId: card.id, scheduledRating: 3 } })
    const a = op('events', review('a', now) as RecordValue, 2), b = op('events', review('b', now + 1000) as RecordValue, 2, deviceB)
    const result = await projectOperations([op('chunks', chunk() as unknown as RecordValue), b, seed, a, a])
    expect((result.records.cards[0]!.card as { reps: number }).reps).toBe(2)
  })
  it('rejects unknown schema, keys, prototype patches and evidence erasure', () => {
    const valid = op('events', event('safe') as unknown as RecordValue)
    expect(() => parseOperation({ ...valid, schemaVersion: 99 })).toThrow()
    expect(() => parseOperation({ ...valid, payload: { ...valid.payload, record: { ...event('safe'), apiKey: 'must-not-upload' } } })).toThrow()
    expect(() => parseOperation({ ...valid, payload: { ...valid.payload, changed: ['["__proto__","polluted"]'] } })).toThrow()
    expect(() => parseOperation({ ...valid, kind: 'delete', payload: {} })).toThrow()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('durable local-first sync journal', () => {
  it('migrates V1 data without deleting local evidence and excludes secrets/blobs', async () => {
    const { db, journal } = await local()
    await db.secrets.put({ id: 'openrouter', value: 'private-fixture-never-export' })
    await db.events.add(event('existing'))
    await journal.capture()
    expect(await db.events.get('existing')).toBeTruthy()
    const wire = JSON.stringify(await journal.pending())
    expect(wire).not.toContain('private-fixture')
    expect(wire).not.toContain('secrets')
  })
  it('keeps the offline queue through failure/reload and automatically unions two devices after reconnect', async () => {
    const a = await local(), b = await local(), server = new Server()
    await synchronize(a.journal, server); await synchronize(b.journal, server)
    await a.db.events.add(event('a-offline')); await b.db.events.add(event('b-online'))
    server.fail = true
    await expect(synchronize(a.journal, server)).rejects.toThrow('Offline')
    expect((await a.journal.pending()).length).toBeGreaterThan(0)
    a.db.close(); await a.db.open()
    server.fail = false
    await synchronize(b.journal, server); await synchronize(a.journal, server); await synchronize(b.journal, server)
    expect((await a.db.events.toArray()).map(e => e.id).sort()).toEqual(['a-offline', 'b-online'])
    expect(canonical(await a.db.events.toArray())).toBe(canonical(await b.db.events.toArray()))
    expect(await a.journal.pending()).toHaveLength(0)
  })
  it('never advances the download cursor from an upload acknowledgement', async () => {
    const { journal } = await local(), server = new Server()
    await journal.acknowledge(await server.upload(await journal.pending()))
    expect(await journal.cursor()).toBe(0)
  })
  it('captures edits committed during a download and rejects a different account without data loss', async () => {
    const { db, journal } = await local(), server = new Server()
    await synchronize(journal, server)
    await db.events.add(event('in-flight'))
    await journal.merge([], await journal.cursor())
    expect(await db.events.get('in-flight')).toBeTruthy()
    expect((await journal.pending()).some(op => op.entityId === 'in-flight')).toBe(true)
    await expect(journal.bindOwner(deviceB)).rejects.toThrow('another learning account')
    expect(await db.events.get('in-flight')).toBeTruthy()
  })
  it('rolls back a corrupt remote page and leaves cursor and local work unchanged', async () => {
    const { db, journal } = await local()
    await db.events.add(event('safe'))
    const invalid = { ...op('events', event('bad') as unknown as RecordValue), cursor: 1, receivedAt: now, schemaVersion: 22 } as unknown as StoredOperation
    await expect(journal.merge([invalid], 1)).rejects.toThrow()
    expect(await journal.cursor()).toBe(0)
    expect(await db.events.get('safe')).toBeTruthy()
    expect(await db.events.get('bad')).toBeUndefined()
  })
})

const draft = (id = 'lesson'): RecordValue => ({ id, kind: 'listen', startedAt: now, stage: 'listen', draft: {} })
const receipt = (value: SyncOperation, cursor = value.logicalClock): StoredOperation => ({ ...value, cursor, receivedAt: now })
const tombstone = (type: SyncOperation['entityType'], id: string, clock: number): SyncOperation => parseOperation({
  id: crypto.randomUUID(), deviceId: deviceB, logicalClock: clock, entityType: type, entityId: id, kind: 'delete', schemaVersion: 1, payload: {},
})

describe('review regressions: fields, deletions and dependency closure', () => {
  it('adds the first draft/score field and also repairs old empty-object marker patches', async () => {
    const base = draft(), next = { ...base, draft: { answer: 'first answer' } }
    const patch = op('sessions', next, 2, deviceA, base)
    expect(patch.payload.changed).toEqual(['["draft","answer"]'])
    patch.payload.changed!.push('["draft"]') // Executable old-client history.
    expect((await projectOperations([patch, op('sessions', base)])).records.sessions).toEqual([next])
    const assessment = { id: 'assessment', timestamp: now, variant: 0, stage: 'listen', scores: {}, responses: {} }
    const answered = { ...assessment, scores: { listening: 0.5 }, responses: { listening: 'An answer' } }
    expect((await projectOperations([op('assessments', assessment), op('assessments', answered, 2, deviceA, assessment)])).records.assessments).toEqual([answered])
  })
  it('preserves scalar/object transitions and actual nested deletions', async () => {
    const first = { ...draft(), draft: { nested: { answer: 'old', keep: true } } }
    const second = { ...first, draft: { nested: { keep: true } } }
    const third = { ...first, draft: { nested: 'done' } }
    const fourth = { ...first, draft: { nested: {} } }
    expect((await projectOperations([op('sessions', first), op('sessions', second, 2, deviceA, first), op('sessions', third, 3, deviceA, second), op('sessions', fourth, 4, deviceA, third)])).records.sessions).toEqual([fourth])
  })
  it('keeps a tombstone over sparse offline edits and requires a complete recreation', async () => {
    const base = draft(), deletion = tombstone('sessions', base.id, 2)
    const edit = op('sessions', { ...base, draft: { answer: 'offline' } }, 3, deviceB, base)
    const dead = await projectOperations([op('sessions', base), deletion, edit])
    expect(dead.records.sessions).toEqual([])
    expect(dead.conflicts).toContainEqual({ entityType: 'sessions', entityId: base.id, operationIds: [edit.id] })
    const recreated = { ...base, draft: { answer: 'explicit recreation' } }
    expect((await projectOperations([deletion, edit, op('sessions', base), op('sessions', recreated, 4)])).records.sessions).toEqual([recreated])
  })
  it('is page-independent across remote deletion, unrelated high clock and recreation without echo deletes', async () => {
    const left = await local(), right = await local(), base = draft()
    for (const value of [left, right]) { await value.db.sessions.put(base as never); await value.journal.capture() }
    const rows = [receipt(tombstone('sessions', base.id, 10), 100), receipt(op('events', event('unrelated') as unknown as RecordValue, 100), 101), receipt(op('sessions', { ...base, draft: { answer: 'recreated' } }, 11), 102)]
    await left.journal.merge(rows.slice(0, 2), 101)
    expect(await left.db.syncSnapshots.get(JSON.stringify(['sessions', base.id]))).toBeUndefined()
    left.db.close(); await left.db.open()
    await left.journal.merge(rows.slice(2), 102)
    await right.journal.merge(rows, 102)
    expect(await left.db.sessions.toArray()).toEqual(await right.db.sessions.toArray())
    expect((await left.db.sessions.get(base.id))!.draft.answer).toBe('recreated')
    expect((await left.journal.pending()).filter(row => row.kind === 'delete')).toEqual([])
  })
  it('retains tombstoned dependencies for immutable evidence and stages missing references until a later page', async () => {
    const session = draft(), evidence = { ...event('linked'), sessionId: session.id }
    const result = await projectOperations([op('sessions', session), op('events', evidence as unknown as RecordValue, 2), tombstone('sessions', session.id, 3)])
    expect(result.records.events).toHaveLength(1)
    expect(result.records.sessions).toEqual([session])
    expect(result.tombstones).toEqual([{ entityType: 'sessions', entityId: session.id, retained: true }])
    const { db, journal } = await local()
    const early = receipt(op('events', evidence as unknown as RecordValue, 1), 10)
    await journal.merge([early], 10)
    expect(await db.events.get(evidence.id)).toBeUndefined()
    expect(await db.syncOperations.get(early.id)).toBeTruthy()
    await journal.merge([receipt(op('sessions', session, 2), 11)], 11)
    expect(await db.events.get(evidence.id)).toMatchObject(evidence)
    expect((await db.syncMeta.get('deferred'))!.value).toEqual([])
  })
  it('publishes complete first-account defaults on their first actual edit', async () => {
    const db = new JoveDatabase(`sync-test-${crypto.randomUUID()}`); databases.push(db)
    await db.profiles.put(defaultProfile()); await db.settings.put({ id: 'main', value: defaultSettings })
    const journal = new SyncJournal(db); await journal.bindOwner(owner)
    expect(await journal.pending()).toEqual([])
    await db.profiles.update('main', { onboarded: true })
    await db.settings.put({ id: 'main', value: { ...defaultSettings, theme: 'dark' } })
    await synchronize(journal, new Server())
    expect((await db.profiles.get('main'))!.onboarded).toBe(true)
    expect((await db.settings.get('main'))!.value.theme).toBe('dark')
    expect(await journal.pending()).toEqual([])
  })
  it('recomputes coupled plan minutes after concurrent valid task changes', async () => {
    const base = { id: 'plan', date: '2026-09-08', minutes: 90, focus: 'naturalListening', tasks: [{ id: 't', kind: 'listen', title: 'Listen', minutes: 90, reason: 'practice', done: false }], evidenceFingerprint: 'a', createdAt: now }
    const short = { ...base, minutes: 45, tasks: [{ ...base.tasks[0], minutes: 45, done: true }] }
    const renamed = { ...base, tasks: [{ ...base.tasks[0], title: 'New lesson' }] }
    const result = await projectOperations([op('plans', base), op('plans', short, 2, deviceB, base), op('plans', renamed, 3, deviceA, base)])
    expect(result.records.plans[0]).toMatchObject({ minutes: 90, tasks: [{ title: 'New lesson', minutes: 90, done: true }] })
  })
  it('converges for every pagination partition of a six-operation edit/delete/recreation history', async () => {
    const base = draft(), answer = { ...base, draft: { answer: 'one' } }, recreated = { ...base, draft: { answer: 'two' } }
    const final = { ...recreated, draft: { answer: 'two', notes: 'saved' } }
    const rows = [op('sessions', base), op('sessions', answer, 2, deviceB, base), tombstone('sessions', base.id, 3), op('sessions', recreated, 4), op('sessions', final, 5, deviceA, recreated), op('events', event('independent') as unknown as RecordValue, 6)]
      .map((value, index) => receipt(value, index + 10))
    const expected = await projectOperations(rows)
    expect(canonical(await projectOperations([...rows].reverse()))).toBe(canonical(expected))
    for (let mask = 0; mask < 32; mask++) {
      const { db, journal } = await local()
      let start = 0
      for (let end = 0; end < rows.length; end++) if (end === rows.length - 1 || mask & (1 << end)) {
        await journal.merge(rows.slice(start, end + 1), rows[end]!.cursor!); start = end + 1
      }
      expect(await db.sessions.toArray()).toEqual(expected.records.sessions)
      expect(await db.events.toArray()).toEqual(expected.records.events)
      expect((await journal.pending()).filter(row => row.entityType === 'sessions' || row.entityType === 'events')).toEqual([])
    }
  })
})

describe('review regressions: canonical occurrences and FSRS history', () => {
  const scheduler = fsrs({ enable_fuzz: false })
  const card = (state = createEmptyCard(new Date(now))) => ({ id: 'chunk:recall', chunkId: 'chunk', modality: 'recall', card: state, contextIds: [] })
  const review = (id: string, rating: number, timestamp: number): RecordValue => ({ id, type: 'review', timestamp, source: 'objective', score: rating / 4, chunkId: 'chunk', modality: 'recall', data: { cardId: 'chunk:recall', scheduledRating: rating } })
  const chunkOp = () => op('chunks', chunk() as unknown as RecordValue)
  it('does not manufacture attempt IDs from already-canonical ambiguous raw legacy blocks', async () => {
    const block = { id: 'old-block', kind: 'review-block', startedAt: now, stage: 'selection', draft: { items: [{ cardId: 'chunk:recall', reps: 0 }] } }
    const rows = [chunkOp(), op('cards', { ...card(), id: 'old-a' }), op('cards', { ...card(), id: 'old-b' }), op('sessions', block)]
    const projection = await projectOperations(rows)
    expect(projection.records.sessions[0]!.draft).toEqual(block.draft)
    const { db, journal } = await local()
    await journal.merge(rows.map((row, index) => receipt(row, index + 10)), 13)
    const aliases = (await db.syncMeta.get('cardAliases'))!.value as Record<string, string>
    const { resolveReviewAttempts } = await import('../src/sync/journal')
    await expect(resolveReviewAttempts(db, block.id, block.draft.items, aliases)).rejects.toThrow('ambiguous original attempts')
  })
  it('keeps a new durable attempt/draft across card aliases and rebased reps; unrelated reviews are never completion', async () => {
    const selected = reviewAttempt('old-card', 0), aliases = { 'old-card': 'chunk:recall' }
    const state = scheduler.next(createEmptyCard(new Date(now)), new Date(now), 3).card
    const current = card(state) as never
    expect(selectedReviewCard(selected, [current], aliases)).toEqual(current)
    expect(restoreReviewAttempt({ ...selected, cardId: 'chunk:recall' }, aliases)?.draftId).toBe(selected.draftId)
    expect(restoreReviewAttempt(selected)?.attemptId).toBe(selected.attemptId)
    expect(reviewAttempt('old-card', 0).attemptId).not.toBe(selected.attemptId)
    const unrelated = review('review:old-card:1', 3, now) as unknown as StudyEvent
    expect(reviewAttemptCompleted(selected, [unrelated], aliases, {})).toBe(false)
    expect(reviewAttemptCompleted(selected, [], aliases, {})).toBe(false)
    const evidence = { ...unrelated, id: selected.attemptId + '~sha', data: { ...unrelated.data, attemptId: selected.attemptId } }
    expect(reviewAttemptCompleted(selected, [evidence], aliases, {})).toBe(true)
    expect(reviewAttemptCompleted(selected, [{ ...evidence, type: 'REVIEW_RESPONSE' }], aliases, {})).toBe(false)
  })
  it('restores counter-shaped legacy blocks after remapped cardId, collision aliases and separately downloaded pages', async () => {
    const { db, journal } = await local()
    const original = 'review:old-card:1', eventA = { ...review(original, 1, now), data: { cardId: 'old-card', scheduledRating: 1 } }
    const eventB = { ...review(original, 4, now + 1000), data: { cardId: 'old-card', scheduledRating: 4 } }
    const rows = [chunkOp(), op('cards', { ...card(), id: 'old-card' }), op('events', eventA, 2), op('events', eventB, 2, deviceB)]
      .map((row, index) => receipt(row, 10 + index))
    // A review alone may be aliased but is not yet eligible evidence without its card/chunk.
    await journal.merge([rows[2]!], 12)
    const legacy = restoreReviewAttempt({ cardId: 'old-card', reps: 0 }, { 'old-card': 'chunk:recall' })!
    expect(reviewAttemptCompleted(legacy, await db.events.toArray(), { 'old-card': 'chunk:recall' }, {})).toBe(false)
    // Projection convergence is independent of dependency/page order. The actual
    // HTTP cursor only advances; test the complete source union after that page.
    await journal.merge(rows, 13)
    const aliases = (await db.syncMeta.get('eventAliases'))!.value as Record<string, string[]>
    expect((await resolveEventAliases(db, original))).toHaveLength(3)
    expect(aliases[original]).toHaveLength(2)
    expect(await db.events.get(original)).toBeUndefined()
    expect(reviewAttemptCompleted(legacy, await db.events.toArray(), { 'old-card': 'chunk:recall' }, aliases)).toBe(true)
    expect((await projectOperations([...rows].reverse())).eventAliases).toEqual(aliases)
    expect((await db.syncOperations.get(rows[2]!.id))!.payload.record!.id).toBe(original)
  })
  it('uses SHA-256 occurrence identities, independent of receipt and duplicate operation selection', async () => {
    const record = event('same') as unknown as RecordValue
    expect(await eventOccurrenceKey(record)).toMatch(/^[a-f0-9]{64}$/)
    expect(await eventOccurrenceKey({ ...record, data: { audioAvailable: false } })).toBe(await eventOccurrenceKey({ ...record, data: { audioAvailable: true } }))
    expect(await eventOccurrenceKey({ ...record, data: { audioAvailable: false } })).toBe(await eventOccurrenceKey(record))
    const future = op('events', { ...record, timestamp: now + 86_400_000 })
    expect(canonical(await projectOperations([future, receipt(future)]))).toBe(canonical(await projectOperations([receipt(future), future])))
  })
  it('removes old materialized collision aliases without deleting any source operations', async () => {
    const { db, journal } = await local()
    const a = receipt(op('events', event('legacy', 0.2) as unknown as RecordValue, 5), 10)
    const b = receipt(op('events', event('legacy', 0.8) as unknown as RecordValue, 10, deviceB), 11)
    await journal.merge([a, b], 11)
    const before = await db.events.toArray()
    const duplicate = receipt(op('events', event('legacy', 0.8) as unknown as RecordValue, 7, deviceB), 12)
    await journal.merge([duplicate], 12)
    expect(await db.events.toArray()).toEqual(before)
    const projected = await projectOperations(await db.syncOperations.toArray())
    expect(await db.events.count()).toBe(2)
    expect(await db.events.toArray()).toEqual(projected.records.events)
    for (const source of [a, b, duplicate]) expect(await db.syncOperations.get(source.id)).toEqual(source)
    // Simulate the obsolete alias created by the initial client, with its snapshot.
    const obsolete = { ...event('legacy', 0.8), id: `legacy~${b.id}` }
    await db.events.put(obsolete)
    await db.syncSnapshots.put({ id: JSON.stringify(['events', obsolete.id]), entityType: 'events', entityId: obsolete.id, record: obsolete as unknown as RecordValue })
    await journal.merge([], 12)
    expect(await db.events.count()).toBe(2)
  })
  it('maps colliding legacy baseline IDs to their originating device and replays chronological history', async () => {
    const empty = createEmptyCard(new Date(now))
    const stateA = scheduler.next(empty, new Date(now), 1).card, stateB = scheduler.next(empty, new Date(now + 1000), 4).card
    const seedB = op('cards', card(stateB) as unknown as RecordValue, 2, deviceB), seedA = op('cards', card(stateA) as unknown as RecordValue, 3, deviceA)
    seedB.payload.baseEventIds = ['legacy:1']; seedA.payload.baseEventIds = ['legacy:1']
    const a = op('events', review('legacy:1', 1, now), 1, deviceA), b = op('events', review('legacy:1', 4, now + 1000), 1, deviceB)
    const operations = [chunkOp(), seedB, seedA, a, b]
    const expected = scheduler.next(stateA, new Date(now + 1000), 4).card
    for (const values of [operations, [...operations].reverse(), [b, seedA, operations[0]!, a, seedB, b]]) {
      expect((await projectOperations(values)).records.cards[0]!.card).toEqual(expected)
    }
    expect(expected.stability).toBeCloseTo(0.42437996)
  })
  it('uses canonical baseline keys across aliases and waits for absent baseline events', async () => {
    const first = review('one', 3, now), state = scheduler.next(createEmptyCard(new Date(now)), new Date(now), 3).card
    const seed = op('cards', card(state) as unknown as RecordValue, 2)
    seed.payload.baseEventKeys = [await eventOccurrenceKey(first)]
    const partial = await projectOperations([chunkOp(), seed])
    expect(partial.records.cards[0]!.card).toEqual(state)
    expect(partial.deferred).toContainEqual({ entityType: 'cards', entityId: 'chunk:recall', reason: 'Waiting for baseline occurrences' })
    const second = review('two', 4, now + 1000)
    const complete = await projectOperations([chunkOp(), seed, op('events', first), op('events', second, 3)])
    expect(complete.records.cards[0]!.card).toEqual(scheduler.next(state, new Date(now + 1000), 4).card)
  })
  it('normalizes both replayed and opaque legacy future-card timelines while retaining original source state', async () => {
    const future = now + 86_400_000, state = scheduler.next(createEmptyCard(new Date(now)), new Date(future), 3).card
    const seed = op('cards', card(state) as unknown as RecordValue, 2)
    seed.payload.baseEventIds = ['future']
    const source = canonical(seed)
    const result = await projectOperations([chunkOp(), receipt(seed, 3), receipt(op('events', review('future', 3, future)), 2)])
    expect((result.records.cards[0]!.card as typeof state).last_review!.getTime()).toBe(now)
    expect(result.records.events[0]!.timestamp).toBe(now)
    expect(canonical(seed)).toBe(source)
    const opaque = op('cards', card(state) as unknown as RecordValue, 2)
    const migrated = (await projectOperations([chunkOp(), receipt(opaque, 3)])).records.cards[0]!.card as typeof state
    expect(migrated.last_review!.getTime()).toBe(now)
    expect(migrated.due.getTime() - now).toBe(state.due.getTime() - future)
    expect(migrated.reps).toBe(state.reps)
  })
  it('retains deleted card dependencies without replaying already included reviews twice', async () => {
    const first = review('one', 3, now), state = scheduler.next(createEmptyCard(new Date(now)), new Date(now), 3).card
    const seed = op('cards', card(state) as unknown as RecordValue, 2)
    seed.payload.baseEventKeys = [await eventOccurrenceKey(first)]
    const result = await projectOperations([chunkOp(), op('events', first), seed, tombstone('cards', 'chunk:recall', 3)])
    expect(result.records.cards[0]!.card).toEqual(state)
    expect(result.tombstones).toContainEqual({ entityType: 'cards', entityId: 'chunk:recall', retained: true })
  })
  it('normalizes empty future cards and small positive clock skew that would otherwise block the next review', async () => {
    const empty = op('cards', card(createEmptyCard(new Date(now + 60_000))) as unknown as RecordValue, 2)
    expect(((await projectOperations([chunkOp(), receipt(empty, 3)])).records.cards[0]!.card as Card).due.getTime()).toBe(now)
    const result = await projectOperations([chunkOp(), empty, receipt(op('events', review('small-skew', 3, now + 1000)), 3)])
    expect((result.records.cards[0]!.card as Card).last_review!.getTime()).toBe(now)
  })
  it('preserves opaque legacy history and flags incomparable earlier reviews instead of inventing a replay order', async () => {
    const state = scheduler.next(createEmptyCard(new Date(now)), new Date(now + 1000), 3).card
    const seed = op('cards', card(state) as unknown as RecordValue, 2)
    const result = await projectOperations([chunkOp(), seed, op('events', review('unrepresented-earlier', 1, now))])
    expect(result.records.cards[0]!.card).toEqual(state)
    expect(result.deferred).toContainEqual({ entityType: 'cards', entityId: 'chunk:recall', reason: 'Legacy baseline needs recovery: earlier occurrence outside its known history' })
  })
  it('unifies legacy card IDs before the unique DB index and remaps evidence/draft references without rewriting sources', async () => {
    const { db, journal } = await local()
    await db.chunks.put(chunk())
    const first = { ...review('legacy-id-review', 3, now), data: { cardId: 'old-card-id', scheduledRating: 3 } }
    const state = scheduler.next(createEmptyCard(new Date(now)), new Date(now), 3).card
    await db.cards.put({ ...card(state), id: 'old-card-id' } as never)
    await db.events.put(first as never)
    await db.sessions.put({ ...draft(), draft: { cardId: 'old-card-id' } } as never)
    await journal.capture()
    const original = (await db.syncOperations.toArray()).find(row => row.entityType === 'cards')!
    const other = op('cards', card(state) as unknown as RecordValue, 1, deviceB)
    other.payload.baseEventKeys = [await eventOccurrenceKey(first)]
    await journal.merge([receipt(other, 20)], 20)
    expect(await db.cards.count()).toBe(1)
    expect((await db.cards.get('chunk:recall'))!.card).toEqual(state)
    expect((await db.events.get(first.id))!.data!.cardId).toBe('chunk:recall')
    expect((await db.sessions.get('lesson'))!.draft.cardId).toBe('chunk:recall')
    expect((await db.syncOperations.get(original.id))!.payload.record!.id).toBe('old-card-id')
    expect((await db.syncMeta.get('deferred'))!.value).toEqual([])
    expect((await journal.pending()).filter(row => row.kind === 'delete')).toEqual([])
  })
})

describe('review regressions: transport, clocks, migration and recovery', () => {
  it('reports saved continuation checkpoints and unresolved references instead of false completion', async () => {
    const { journal } = await local(), server = new Server()
    server.rows = Array.from({ length: 21 }, (_, index) => receipt(op('events', event(`page-${index}`) as unknown as RecordValue), index + 1))
    const read = server.download.bind(server)
    server.download = async (cursor, principal) => (await read(cursor, principal)).slice(0, 1)
    expect((await synchronize(journal, server)).hasMore).toBe(true)
    expect((await synchronize(journal, server)).hasMore).toBe(false)
    const missing = op('events', { ...event('missing-reference'), sessionId: 'not-downloaded' } as unknown as RecordValue, 1)
    server.rows.push(receipt(missing, server.rows.length + 1))
    const result = await synchronize(journal, server)
    expect(result).toMatchObject({ pending: 0, hasMore: false, deferred: 1 })
  })
  it('uploads large valid histories in byte-bounded batches with JSONB headroom', async () => {
    const { db, journal } = await local(), server = new Server()
    for (let i = 0; i < 9; i++) await db.sessions.put({ ...draft(`large-${i}`), draft: { answer: 'a'.repeat(480_000) } } as never)
    await synchronize(journal, server)
    expect(server.uploads.length).toBeGreaterThan(1)
    expect(server.uploads.every(batch => jsonbBytes(batch) <= MAX_UPLOAD_BYTES)).toBe(true)
    expect(await journal.pending()).toEqual([])
    expect(await db.sessions.count()).toBe(9)
    expect(jsonbBytes(1e300)).toBeGreaterThanOrEqual(301)
    expect(uploadBatch([])).toEqual([])
  })
  it('rejects impossible remote clocks atomically and recovers a poisoned local counter without discarding history', async () => {
    const { db, journal } = await local()
    const huge = op('events', event('huge') as unknown as RecordValue, Number.MAX_SAFE_INTEGER - 1)
    await expect(journal.merge([receipt(huge, 10)], 10)).rejects.toThrow('logical clock')
    expect(await journal.cursor()).toBe(0)
    expect(await db.syncOperations.get(huge.id)).toBeUndefined()
    await db.syncMeta.put({ id: 'clock', value: Number.MAX_SAFE_INTEGER - 1 })
    await db.syncOperations.add(huge)
    await journal.capture()
    expect(await db.syncOperations.get(huge.id)).toEqual(huge)
    expect((await db.syncMeta.get('quarantinedOperations'))!.value).toContain(huge.id)
    const recovered = (await journal.pending()).find(row => row.entityId === huge.entityId)!
    expect(recovered.id).not.toBe(huge.id)
    expect(recovered.payload).toEqual(huge.payload)
    expect(recovered.logicalClock).toBeLessThan(10)
    await synchronize(journal, new Server())
    expect(await db.events.get('huge')).toMatchObject(event('huge'))
  })
  it('keeps a committed upload retryable after a lost response and rejects conflicting receipts', async () => {
    const { db, journal } = await local(), server = new Server()
    await db.events.put(event('saved'))
    await journal.capture()
    const pending = await journal.pending(), receipts = await server.upload(pending)
    db.close(); await db.open() // Crash after server commit, before acknowledgement.
    expect(await journal.pending()).toEqual(pending)
    await synchronize(journal, server)
    expect(server.rows).toHaveLength(pending.length)
    expect(await journal.pending()).toEqual([])
    await expect(journal.acknowledge([{ ...receipts[0]!, cursor: receipts[0]!.cursor + 100 }])).rejects.toThrow('Receipt identity collision')
  })
  it('rolls back in-transaction identity collisions after capture and refuses unsupported cursor advancement', async () => {
    const { db, journal } = await local(), original = op('events', event('original') as unknown as RecordValue, 3)
    await db.syncOperations.add(original)
    await db.events.put(event('not-yet-captured'))
    const before = await db.syncOperations.toArray(), snapshots = await db.syncSnapshots.toArray()
    await expect(journal.merge([receipt({ ...original, payload: { ...original.payload, record: event('changed') as unknown as RecordValue }, entityId: 'changed' }, 10)], 10)).rejects.toThrow('identity collision')
    expect(await db.syncOperations.toArray()).toEqual(before)
    expect(await db.syncSnapshots.toArray()).toEqual(snapshots)
    expect(await db.events.get('not-yet-captured')).toBeTruthy()
    await expect(journal.merge([], 50)).rejects.toThrow('exceeds received')
    expect(await journal.cursor()).toBe(0)
  })
  it('executes V2 to V3 upgrade, preserving original events, FSRS dates and recording bytes through journal/reopen', async () => {
    const name = `sync-test-${crypto.randomUUID()}`, legacy = new Dexie(name)
    legacy.version(1).stores(version1Stores)
    legacy.version(2).stores({ ...version1Stores, cards: 'id,chunkId,modality,&[chunkId+modality],card.due,errorId', events: 'id,timestamp,skill,chunkId,sessionId,type,[chunkId+modality]', chunks: 'id,text,*sourceIds', sessions: 'id,kind,startedAt,materialId' })
    await legacy.table('profiles').put({ ...defaultProfile(), onboarded: true })
    await legacy.table('settings').put({ id: 'main', value: defaultSettings })
    await legacy.table('events').put(event('legacy-kept'))
    await legacy.table('chunks').put(chunk())
    const state = fsrs({ enable_fuzz: false }).next(createEmptyCard(new Date(now)), new Date(now), 3).card
    await legacy.table('cards').put({ id: 'chunk:recall', chunkId: 'chunk', modality: 'recall', contextIds: [], card: state })
    await legacy.table('audio').put({ id: 'recorded', blob: new Blob([new Uint8Array([1, 2, 3, 4])]), kind: 'recording', mimeType: 'audio/wav', duration: 1, createdAt: now, processed: false, label: 'fixture' })
    legacy.close()
    const db = new JoveDatabase(name); databases.push(db)
    await db.open()
    expect(db.verno).toBe(3)
    expect((await db.cards.get('chunk:recall'))!.card).toEqual(state)
    const journal = new SyncJournal(db); await journal.bindOwner(owner)
    const pending = await journal.pending(); db.close(); await db.open()
    expect(await journal.pending()).toEqual(pending)
    expect(await db.events.get('legacy-kept')).toEqual(event('legacy-kept'))
    expect([...new Uint8Array(await (await db.audio.get('recorded'))!.blob.arrayBuffer())]).toEqual([1, 2, 3, 4])
    expect(JSON.stringify(pending)).not.toContain('"blob"')
  })
})

describe('authenticated SDK requests are bound to a validated principal token', () => {
  function clientFixture() {
    const request = vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = createClient('https://jove-sync-test.invalid', 'sb_publishable_test_only', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: request } })
    let token = 'owner-a-test-token', principal = owner
    vi.spyOn(client.auth, 'getSession').mockImplementation(async () => ({ data: { session: { access_token: token, user: { id: principal } } }, error: null }) as never)
    const user = vi.spyOn(client.auth, 'getUser').mockImplementation(async () => ({ data: { user: { id: principal } }, error: null }) as never)
    return { client, request, user, switchUser() { token = 'owner-b-test-token'; principal = deviceB }, refreshToken() { token = 'owner-a-refreshed-test-token' } }
  }
  it('blocks another member before any learning request', async () => {
    const fixture = clientFixture(); fixture.switchUser()
    await expect(new SupabaseSyncRemote(fixture.client).upload([], owner)).rejects.toThrow('does not match')
    expect(fixture.request).not.toHaveBeenCalled()
  })
  it('passes the verified token to getUser and both actual SDK request builders', async () => {
    const fixture = clientFixture(), remote = new SupabaseSyncRemote(fixture.client)
    await remote.upload([], owner); await remote.download(0, owner)
    expect(fixture.user).toHaveBeenCalledWith('owner-a-test-token')
    for (const call of fixture.request.mock.calls as unknown as [string, RequestInit][]) expect(new Headers(call[1].headers).get('Authorization')).toBe('Bearer owner-a-test-token')
  })
  it('pins Authorization to A even if the SDK session switches during dispatch, then rejects the response', async () => {
    const fixture = clientFixture()
    fixture.request.mockImplementationOnce(async (...args: unknown[]) => {
      fixture.switchUser()
      expect(new Headers((args[1] as RequestInit).headers).get('Authorization')).toBe('Bearer owner-a-test-token')
      return new Response('[]', { status: 200 })
    })
    await expect(new SupabaseSyncRemote(fixture.client).upload([], owner)).rejects.toThrow('Account changed')
  })
  it('rejects a download or refreshed-session response before journal application', async () => {
    const fixture = clientFixture()
    fixture.request.mockImplementationOnce(async () => { fixture.refreshToken(); return new Response('[]', { status: 200 }) })
    await expect(new SupabaseSyncRemote(fixture.client).download(0, owner)).rejects.toThrow('Account changed')
  })
  it('detects a session switch during principal verification, before dispatch', async () => {
    const fixture = clientFixture()
    fixture.user.mockImplementationOnce(async () => { fixture.switchUser(); return { data: { user: { id: owner } }, error: null } as never })
    await expect(new SupabaseSyncRemote(fixture.client).upload([], owner)).rejects.toThrow('Account changed')
    expect(fixture.request).not.toHaveBeenCalled()
  })
})
