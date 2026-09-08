import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyCard, fsrs, type Card } from 'ts-fsrs'
import Dexie from 'dexie'
import { createClient } from '@supabase/supabase-js'
import { db as repositoryDatabase, JoveDatabase, version1Stores } from '../src/db/db'
import { defaultProfile, defaultSettings, type Chunk, type StudyEvent, type Material, type DailyPlan } from '../src/domain/types'
import { makePlan } from '../src/domain/engine'
import { planSchema } from '../src/db/schema'
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

describe('journal preserves readable recording bytes during metadata replay', () => {
  it('does not rewrite or materialize a recording for an unchanged projection', async () => {
    const { db, journal } = await local(), server = new Server(), asset = recording()
    await db.audio.add(asset)
    await synchronize(journal, server)
    const put = vi.spyOn(db.audio, 'put'), read = vi.spyOn(Blob.prototype, 'arrayBuffer')
    await journal.merge([], await journal.cursor())
    await journal.merge([], await journal.cursor())
    expect(put).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect((await db.audio.get(asset.id))?.blob.size).toBe(asset.blob.size)
  })
  it('materializes independent original bytes only when remote recording metadata changes', async () => {
    const { db, journal } = await local(), server = new Server(), asset = recording()
    await db.audio.add(asset)
    await synchronize(journal, server)
    const { blob, ...metadata } = asset, cursor = await journal.cursor()
    const changed = op('audioMetadata', { ...metadata, label: 'Updated label', processed: true }, cursor + 1, deviceB, metadata)
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer')
    await journal.merge([{ ...changed, cursor: cursor + 1, receivedAt: now }], cursor + 1)
    expect(read).toHaveBeenCalledTimes(1)
    const saved = (await db.audio.get(asset.id))!
    expect(saved).toMatchObject({ label: 'Updated label', processed: true, mimeType: metadata.mimeType })
    expect(saved.blob.type).toBe(blob.type)
    expect(await saved.blob.arrayBuffer()).toEqual(await blob.arrayBuffer())
    read.mockClear()
    await journal.merge([], cursor + 1)
    expect(read).not.toHaveBeenCalled()
  })
  it.each(['unavailable', 'incomplete'])('rolls back the whole merge if original bytes are %s during a metadata change', async failure => {
    const { db, journal } = await local(), server = new Server(), asset = recording()
    await db.audio.add(asset)
    await synchronize(journal, server)
    const { blob, ...metadata } = asset, cursor = await journal.cursor()
    const before = { operations: await db.syncOperations.toArray(), snapshots: await db.syncSnapshots.toArray(), meta: await db.syncMeta.toArray() }
    const changed = op('audioMetadata', { ...metadata, label: 'Must not replace original' }, cursor + 1, deviceB, metadata)
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer')
    if (failure === 'unavailable') read.mockRejectedValueOnce(new DOMException('Fixture original unavailable', 'NotFoundError'))
    else read.mockResolvedValueOnce(new ArrayBuffer(1))
    await expect(journal.merge([{ ...changed, cursor: cursor + 1, receivedAt: now }], cursor + 1)).rejects.toThrow(failure === 'unavailable' ? 'Fixture original unavailable' : 'Original recording bytes are incomplete')
    expect(await journal.cursor()).toBe(cursor)
    expect(await db.syncOperations.toArray()).toEqual(before.operations)
    expect(await db.syncSnapshots.toArray()).toEqual(before.snapshots)
    expect(await db.syncMeta.toArray()).toEqual(before.meta)
    expect((await db.audio.get(asset.id))?.label).toBe(metadata.label)
    expect(await (await db.audio.get(asset.id))!.blob.arrayBuffer()).toEqual(await blob.arrayBuffer())
  })
})

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
    // A later recommendation cannot rewrite the duration or identity of completed work.
    expect(result.records.plans[0]).toMatchObject({ minutes: 45, tasks: [{ title: 'Listen', minutes: 45, done: true }] })
  })
  it.each(['completed', 'completion-event-only', 'started', 'draft-only', 'quota-completed', 'quota-events-only'] as const)('retains an actual offline %s reading assignment after another device replans', async state => {
    const completed = state === 'completed' || state === 'completion-event-only'
    const quotaComplete = state === 'quota-completed' || state === 'quota-events-only'
    const at = new Date(2026, 8, 8, 12).getTime()
    const materials: Material[] = ['reader-a', 'reader-b'].map(id => ({ id, title: id, topic: 'Everyday life', difficulty: 0.25,
      duration: 60, transcript: 'A friend asks a question about a story. They share a useful idea and listen carefully.',
      sentences: ['A friend asks a question about a story.', 'They share a useful idea and listen carefully.'],
      sourceKind: 'curated', sourceLabel: 'Synthetic regression fixture', synthetic: true, approved: true,
      question: 'What do they share?', answer: 'An idea', keywords: [],
      chunks: [{ text: 'a useful idea', meaningEn: 'a helpful thought', meaningZh: '', example: 'Please share a useful idea.' }], createdAt: at - 1000 }))
    const profile = { ...defaultProfile(), onboarded: true, dailyMinutes: 45 as const, fatigue: 0, createdAt: at - 1000 }
    const initial = makePlan(profile, [], [], [], materials, undefined, at)
    const reading = initial.tasks.find(task => task.id.endsWith(':reading'))!
    const changedProfile = { ...profile, interests: [reading.materialId!] }
    // saveProfile discards only this device's unstarted assignments, then uses the real planner.
    const other = makePlan(changedProfile, [], [], [], materials, { ...initial, tasks: [] }, at + 1)
    if (state === 'quota-completed') other.tasks = other.tasks.map(task => ({ ...task, done: true }))
    expect(other.tasks.find(task => task.id.endsWith(':reading'))!.id).not.toBe(reading.id)
    expect(reading.minutes).toBe(9)
    const own = { ...initial, tasks: initial.tasks.map(task => ({ ...task, done: state === 'completed' && task.id === reading.id })) }
    const draft = { id: `reading:${reading.id}`, kind: 'reading', materialId: reading.materialId, startedAt: at,
      stage: 'respond', draft: { response: 'An original unfinished response', retell: 'An original unfinished retell' } }
    const facts: StudyEvent[] = state === 'draft-only' ? [] : [{ id: `started:${reading.id}`, type: 'TASK_STARTED', source: 'objective', timestamp: at,
      data: { taskId: reading.id, kind: 'reading', materialId: reading.materialId! } }]
    if (completed) facts.push({ id: `completed:${reading.id}`, type: 'TASK_COMPLETED', source: 'objective', timestamp: at + 1,
      data: { taskId: reading.id, kind: 'reading', materialId: reading.materialId!, minutes: reading.minutes } })
    if (quotaComplete) facts.push(...other.tasks.map(task => ({ id: `completed:${task.id}`, type: 'TASK_COMPLETED', source: 'objective' as const, timestamp: at + 1,
      data: { taskId: task.id, kind: task.kind, minutes: task.minutes } })))
    const history = [...materials.map(row => op('materials', row as unknown as RecordValue)), op('plans', initial as unknown as RecordValue),
      ...(state === 'completed' ? [op('plans', own as unknown as RecordValue, 2, deviceA, initial as unknown as RecordValue)] : []),
      op('sessions', draft, 2), ...facts.map((row, i) => op('events', row as unknown as RecordValue, i + 3)),
      op('plans', other as unknown as RecordValue, 6, deviceB, initial as unknown as RecordValue)]
    const projection = await projectOperations(history)
    const merged = planSchema.parse(projection.records.plans[0])
    expect(merged.tasks.find(task => task.id === reading.id)).toMatchObject({ id: reading.id, materialId: reading.materialId, done: completed })
    expect(merged.minutes).toBeLessThanOrEqual(45)
    const next = makePlan(changedProfile, projection.skills, [], projection.records.events as unknown as StudyEvent[], materials, merged, at + 2)
    expect(next.tasks.find(task => task.id === reading.id)).toMatchObject({ materialId: reading.materialId, done: completed })
    expect(next.tasks.filter(task => !task.done && !task.optional).reduce((sum, task) => sum + task.minutes, 0)).toBeLessThanOrEqual(quotaComplete ? 0 : completed ? 36 : 45)
    if (quotaComplete) {
      expect(merged.minutes).toBe(45)
      expect(merged.tasks.find(task => task.id === reading.id)).toEqual({ ...reading, optional: true })
      expect(next.tasks.find(task => task.id === reading.id)).toEqual({ ...reading, optional: true })
      expect(next.tasks.filter(task => !task.optional).every(task => task.done)).toBe(true)
      expect(next.minutes).toBe(45)
    }
    expect(next.tasks.every(task => task.minutes > 0)).toBe(true)
    expect(projection.records.sessions).toEqual([draft])
    expect(projection.records.events).toHaveLength(facts.length)
    expect(projection.records.cards).toEqual([])
    expect(canonical(await projectOperations([...history].reverse()))).toBe(canonical(projection))
    // Actual journal pages: the replacement arrives before the delayed evidence/history.
    const { db, journal } = await local()
    const paged = [...history].reverse().map((row, i) => ({ ...row, cursor: i + 20, receivedAt: at + 10 }))
    for (const row of paged) await journal.merge([row], row.cursor)
    expect(await db.plans.get(initial.id)).toEqual(merged as DailyPlan)
    expect(await db.sessions.get(draft.id)).toEqual(draft)
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
  it.each(['plan-and-events', 'events-only'])('never relabels completed required 45 minutes as optional after a remote 15-minute replan (%s)', async completion => {
    const at = new Date(2026, 8, 8, 12).getTime()
    const materials: Material[] = ['reader-a', 'reader-b'].map(id => ({ id, title: id, topic: 'Everyday life', difficulty: 0.25,
      duration: 60, transcript: 'A friend asks a question about a story.', sentences: ['A friend asks a question about a story.'],
      sourceKind: 'curated', sourceLabel: 'Synthetic regression fixture', synthetic: true, approved: true,
      question: 'What do they share?', answer: 'An idea', keywords: [], chunks: [], createdAt: at - 1000 }))
    const profile = { ...defaultProfile(), onboarded: true, dailyMinutes: 45 as const, fatigue: 0, createdAt: at - 1000 }
    const initial = makePlan(profile, [], [], [], materials, undefined, at)
    const completed = { ...initial, tasks: initial.tasks.map(task => ({ ...task, done: true })) }
    const events: StudyEvent[] = initial.tasks.map((task, i) => ({ id: `completed:${task.id}`, type: 'TASK_COMPLETED', source: 'objective', timestamp: at + i,
      data: { taskId: task.id, kind: task.kind, minutes: task.minutes } }))
    const changed = { ...profile, dailyMinutes: 15, interests: [initial.tasks.find(task => task.id.endsWith(':reading'))!.materialId!] }
    const other = makePlan(changed, [], [], [], materials, { ...initial, tasks: [] }, at + 100)
    expect(initial.minutes).toBe(45); expect(other.minutes).toBe(15)
    const history = [...materials.map(row => op('materials', row as unknown as RecordValue)), op('plans', initial as unknown as RecordValue),
      ...(completion === 'plan-and-events' ? [op('plans', completed as unknown as RecordValue, 2, deviceA, initial as unknown as RecordValue)] : []),
      ...events.map((row, i) => op('events', row as unknown as RecordValue, i + 3)), op('plans', other as unknown as RecordValue, 20, deviceB, initial as unknown as RecordValue)]
    const projection = await projectOperations(history), merged = planSchema.parse(projection.records.plans[0])
    expect(merged.tasks.filter(task => task.done && !task.optional).reduce((sum, task) => sum + task.minutes, 0)).toBe(45)
    expect(merged.tasks.some(task => task.optional)).toBe(false)
    const next = makePlan(changed, projection.skills, [], projection.records.events as unknown as StudyEvent[], materials, merged, at + 200)
    expect(next.minutes).toBe(45)
    expect(next.tasks.every(task => task.done && !task.optional)).toBe(true)
    for (const task of completed.tasks) expect(next.tasks.find(row => row.id === task.id)).toEqual(task)
    expect(planSchema.safeParse(next).success).toBe(true)
    expect(canonical(await projectOperations([...history].reverse()))).toBe(canonical(projection))
    const { db, journal } = await local()
    for (const [i, row] of [...history].reverse().entries()) await journal.merge([{ ...row, cursor: i + 100, receivedAt: at + 200 }], i + 100)
    expect(await db.plans.get(initial.id)).toEqual(merged)
    expect((await db.events.toArray()).sort((a, b) => a.id.localeCompare(b.id))).toEqual([...events].sort((a, b) => a.id.localeCompare(b.id)))
  })
  it('projects a valid legacy plan with only an oversized optional original without inventing a zero-minute task', async () => {
    const task = { id: '2026-09-08:listen:original', kind: 'listen' as const, title: 'Original begun lesson', minutes: 45, done: false, reason: 'Original assignment' }
    const initial = { id: '2026-09-08', date: '2026-09-08', minutes: 45, focus: 'naturalListening', createdAt: now, tasks: [task], evidenceFingerprint: 'legacy' }
    const other = { ...initial, minutes: 15, tasks: [{ ...task, id: '2026-09-08:listen:other', minutes: 15 }] }
    const started: StudyEvent = { id: `started:${task.id}`, type: 'TASK_STARTED', source: 'objective', timestamp: now, data: { taskId: task.id, kind: task.kind } }
    const history = [op('plans', initial), op('events', started as unknown as RecordValue, 2), op('plans', other, 3, deviceB, initial)]
    const result = await projectOperations(history), plan = planSchema.parse(result.records.plans[0])
    expect(plan).toMatchObject({ minutes: 0, tasks: [{ ...task, optional: true }] })
    expect(result.records.events).toEqual([started])
    expect(canonical(await projectOperations([...history].reverse()))).toBe(canonical(result))
    const { db, journal } = await local()
    for (const [i, row] of [...history].reverse().entries()) await journal.merge([receipt(row, i + 10)], i + 10)
    expect(await db.plans.get(initial.id)).toEqual(plan)
    expect(await db.events.toArray()).toEqual([started])
  })
})

describe('reading submission and recoverable conflict frontiers', () => {
  const material = { id: 'conflict-reader', title: 'A short story', topic: 'Life', difficulty: 0.25, duration: 60,
    transcript: 'Friends tell a story.', sentences: ['Friends tell a story.'], sourceKind: 'curated', sourceLabel: 'Synthetic fixture',
    synthetic: true, approved: true, question: 'Who?', answer: 'Friends', keywords: [], chunks: [], createdAt: now }
  const base = { id: 'reading:assignment', kind: 'reading', materialId: material.id, startedAt: now, stage: 'respond',
    draft: { passage: material.transcript, response: '', retell: '', submittedResponse: '', activeMs: 4000 } }
  const saved = { ...base, completedAt: now + 1, stage: 'saved', draft: { ...base.draft,
    response: 'A genuine response.', submittedResponse: 'A genuine response.', retell: 'A genuine retell.', observationAt: now } }
  const evidence = ['response', 'retell'].map(kind => ({ id: `${base.id}:${kind}`, type: kind === 'response' ? 'READING_RESPONSE' : 'READING_RETELL',
    timestamp: now, source: 'text', sessionId: base.id, data: { materialId: material.id, response: kind === 'response' ? saved.draft.submittedResponse : saved.draft.retell } }))
  const sourceHistory = () => [op('materials', material), op('sessions', base), op('sessions', saved, 3, deviceA, base), ...evidence.map(row => op('events', row, 4))]
  it('does not attest an earlier torn saved snapshot with response and retell from different actual submission times', async () => {
    const a = { ...saved, draft: { ...saved.draft, observationAt: now + 10 } }
    const b = { ...saved, draft: { ...saved.draft, response: 'Actual response B.', submittedResponse: 'Actual response B.', retell: 'Actual retell B.', observationAt: now + 20 } }
    const torn = { ...a, draft: { ...a.draft, retell: b.draft.retell } }
    const proof = (row: typeof a, device: string) => ['response', 'retell'].map((kind, i) => op('events', {
      id: `${base.id}:${kind}`, type: kind === 'response' ? 'READING_RESPONSE' : 'READING_RETELL', source: 'text', sessionId: base.id,
      timestamp: row.draft.observationAt, data: { materialId: material.id, response: kind === 'response' ? row.draft.submittedResponse : row.draft.retell },
    }, 10 + i, device))
    const history = [op('materials', material), op('sessions', base), op('sessions', torn, 2, '00000000-0000-4000-8000-000000000003', base),
      op('sessions', a, 3, deviceA, base), op('sessions', b, 4, deviceB, base), ...proof(a, deviceA), ...proof(b, deviceB)]
    const result = await projectOperations(history)
    expect(result.records.sessions.find(row => row.id === base.id)?.draft).toMatchObject(a.draft)
    expect(result.records.events).toHaveLength(4)
    expect(canonical(await projectOperations([...history].reverse()))).toBe(canonical(result))
    const { db, journal } = await local()
    for (const [i, row] of [...history].reverse().entries()) await journal.merge([{ ...row, cursor: i + 100, receivedAt: now + 100 }], i + 100)
    expect((await db.sessions.get(base.id))?.draft).toMatchObject(a.draft)
  })
  it.each(['reading', 'reading-recovery'])('keeps response-only concurrent unsent edits in %s discoverable', async kind => {
    const seed = { ...base, kind, draft: { ...base.draft, ...(kind === 'reading-recovery' ? { syncRecovery: { rootSessionId: 'reading:original' } } : {}) } }
    const a = { ...seed, draft: { ...seed.draft, response: 'A independently typed response without a retell yet.' } }
    const b = { ...seed, draft: { ...seed.draft, response: 'B independently typed response without a retell yet.' } }
    const history = [op('materials', material), op('sessions', seed), op('sessions', a, 2, deviceA, seed), op('sessions', b, 3, deviceB, seed)]
    const final = await projectOperations(history)
    expect(final.records.sessions.find(row => row.id === seed.id)?.draft).toMatchObject({ response: b.draft.response })
    expect(final.records.sessions.find(row => row.kind === 'reading-conflict')?.draft).toMatchObject({ response: a.draft.response })
    expect(final.records.sessions).toHaveLength(2)
    expect(canonical(await projectOperations([...history].reverse()))).toBe(canonical(final))
  })
  it.each(['reading', 'reading-recovery'])('does not turn a causally inherited %s draft into an extra recovery obligation', async kind => {
    const seed = { ...base, kind }, a = { ...seed, draft: { ...seed.draft, response: 'A original unsent response.' } }
    const b = { ...a, draft: { ...a.draft, retell: 'B synced the response and added this retell.' } }
    const history = [op('materials', material), op('sessions', seed), op('sessions', a, 2, deviceA, seed), op('sessions', b, 3, deviceB, a)]
    expect(history.at(-1)!.payload.changed).toEqual(['["draft","retell"]'])
    const final = await projectOperations(history)
    expect(final.records.sessions).toEqual([b])
    expect(final.conflicts).toEqual([])
    const { db, journal } = await local()
    for (const [i, row] of [...history].reverse().entries()) await journal.merge([{ ...row, cursor: i + 10, receivedAt: now + 100 }], i + 10)
    expect(await db.sessions.toArray()).toEqual([b])
  })
  it.each(['listening', 'chunks', 'legacy-chunks'])('retains the old %s assignment linked to an unfinished source draft without fabricating completion', async mode => {
    const id = mode === 'listening' ? '2026-09-08:listen:conflict-reader' : `2026-09-08:learn:conflict-reader${mode === 'chunks' ? ':chunks' : ''}`
    const task = { id, kind: mode === 'listening' ? 'listen' : 'learn', title: 'Original assignment', minutes: 15, reason: 'Saved work', materialId: material.id, done: false }
    const original = { id: '2026-09-08', date: '2026-09-08', minutes: 15, focus: 'naturalListening', tasks: [task], evidenceFingerprint: 'first', createdAt: now }
    const replacement = { ...original, tasks: [{ ...task, id: `${id}:replacement`, title: 'Different recommendation' }] }
    const session = { id: mode === 'listening' ? 'listening-attempt-uuid' : `learn-draft-${mode === 'chunks' ? id : material.id}`,
      kind: mode === 'listening' ? 'listen' : 'learn', materialId: material.id, startedAt: now, stage: 'practice',
      draft: { response: 'Original unfinished work', ...(mode === 'listening' ? { taskId: id, sourceSessionId: 'original-attempt' } : {}) } }
    const final = await projectOperations([op('materials', material), op('plans', original), op('sessions', session, 2), op('plans', replacement, 3, deviceB, original)])
    expect(final.records.plans[0]?.tasks).toEqual([task])
    expect(final.records.sessions).toEqual([session])
    expect(final.records.events).toEqual([])
  })
  it('keeps one latest frontier per device through six autosaves, arbitrary pages and canonical mount normalization', async () => {
    const history = sourceHistory(), { db, journal } = await local()
    let previous = base
    for (let i = 0; i < 6; i++) {
      const typed = { ...base, draft: { ...base.draft, response: `B response version ${i}`, retell: `B retell version ${i}` } }
      history.push(op('sessions', typed, 5 + i, deviceB, previous)); previous = typed
    }
    let copyId = ''
    for (let i = 0; i < history.length; i++) {
      await journal.merge([{ ...history[i]!, cursor: i + 20, receivedAt: now + 100 }], i + 20)
      const copies = await db.sessions.where('kind').equals('reading-conflict').toArray()
      expect(copies.length).toBeLessThanOrEqual(1)
      if (copies.length) { copyId ||= copies[0]!.id; expect(copies[0]!.id).toBe(copyId) }
    }
    const expected = await projectOperations(history), canonicalRow = expected.records.sessions.find(row => row.id === base.id)!
    const normalized = { ...canonicalRow, draft: { ...canonicalRow.draft as object, audioId: '', readSections: [], sectionMs: [], priorExposure: true } }
    history.push(op('sessions', normalized, 20, deviceB, canonicalRow))
    const final = await projectOperations(history), frontier = final.records.sessions.find(row => row.kind === 'reading-conflict')!
    expect(final.records.sessions).toHaveLength(2)
    expect(frontier.id).toBe(copyId)
    expect(frontier.draft).toMatchObject({ response: 'B response version 5', retell: 'B retell version 5', syncRecovery: { sourceDeviceId: deviceB } })
    expect(final.records.sessions.find(row => row.id === base.id)?.draft).toMatchObject({ retell: saved.draft.retell, submittedResponse: saved.draft.submittedResponse })
    expect(canonical(await projectOperations([...history].reverse()))).toBe(canonical(final))
    expect(canonical(await projectOperations([...history, ...history]))).toBe(canonical(final))
    const second = await local()
    for (const [i, row] of [...history].reverse().entries()) await second.journal.merge([{ ...row, cursor: i + 50, receivedAt: now + 100 }], i + 50)
    expect((await second.db.sessions.toArray()).sort((a, b) => a.id.localeCompare(b.id))).toEqual([...final.records.sessions].sort((a, b) => a.id.localeCompare(b.id)))
    expect(await db.syncOperations.count()).toBe(history.length - 1 + 2) // local profile/settings plus every original source operation
  })
  it('preserves an explicitly continued recovery across reconnect and later edits to its source frontier', async () => {
    const typed = { ...base, draft: { ...base.draft, response: 'B original response', retell: 'B original retell' } }
    const history = [...sourceHistory(), op('sessions', typed, 5, deviceB, base)]
    const initial = await projectOperations(history), frontier = initial.records.sessions.find(row => row.kind === 'reading-conflict')!
    const origin = (frontier.draft as Record<string, unknown>).syncRecovery as Record<string, string>
    const recovery = { id: `reading-recovery:${frontier.id.slice('reading-conflict:'.length)}:${origin.sourceVersion}`, kind: 'reading-recovery', materialId: material.id,
      startedAt: now + 2, stage: 'respond', draft: { passage: material.transcript, response: 'Recovered and edited independently', retell: 'A separate recoverable retell',
        activeMs: 0, priorExposure: true, syncRecovery: { ...origin, frontierId: frontier.id } } }
    history.push(op('sessions', recovery, 6))
    for (let i = 0; i < 5; i++) history.push(op('sessions', { ...typed, draft: { ...typed.draft, response: `Source device still editing ${i}` } }, 7 + i, deviceB, typed))
    const final = await projectOperations(history)
    expect(final.records.sessions).toHaveLength(3)
    expect(final.records.sessions.find(row => row.id === recovery.id)).toEqual(recovery)
    expect(final.records.sessions.find(row => row.id === frontier.id)?.draft).toMatchObject({ response: 'Source device still editing 4' })
    expect(final.records.events).toHaveLength(evidence.length)
    expect(final.records.events.every(row => row.sessionId === base.id)).toBe(true)
    const { db, journal } = await local()
    for (const [i, row] of history.entries()) await journal.merge([{ ...row, cursor: i + 20, receivedAt: now + 100 }], i + 20)
    expect(await db.sessions.get(recovery.id)).toEqual(recovery)
    await journal.capture()
    expect((await journal.pending()).filter(row => row.entityType === 'sessions')).toEqual([])
  })
  it('never combines saved contenders from different devices or discards their original evidence', async () => {
    const other = { ...saved, draft: { ...saved.draft, response: 'B submitted response', submittedResponse: 'B submitted response', retell: 'B submitted retell' } }
    const history = [...sourceHistory(), op('sessions', other, 5, deviceB, base), ...evidence.map(row => op('events', { ...row,
      data: { ...row.data, response: row.type === 'READING_RESPONSE' ? other.draft.response : other.draft.retell } }, 6, deviceB))]
    const final = await projectOperations(history)
    expect(final.records.sessions.find(row => row.id === base.id)?.draft).toMatchObject({ submittedResponse: saved.draft.response, retell: saved.draft.retell })
    expect(final.records.sessions.find(row => row.kind === 'reading-conflict')?.draft).toMatchObject({ submittedResponse: other.draft.response, retell: other.draft.retell })
    expect(final.records.events).toHaveLength(4)
    expect(final.records.cards).toEqual([])
    expect(final.conflicts.some(row => row.entityType === 'sessions' && row.entityId === base.id)).toBe(true)
  })
  it('keeps each saved retell attached to its own private audio and stages a missing audio dependency', async () => {
    const a = { ...saved, draft: { ...saved.draft, audioId: 'audio-a', audioSeconds: 3 } }
    const b = { ...base, draft: { ...base.draft, response: 'B unsent response', retell: 'B unsent retell', audioId: 'audio-b', audioSeconds: 4 } }
    const meta = (id: string) => ({ id, mimeType: 'audio/wav', createdAt: now, duration: 3, kind: 'recording', processed: false, label: 'Original retell' })
    const history = [op('materials', material), op('sessions', base), op('sessions', a, 3, deviceA, base), op('sessions', b, 5, deviceB, base),
      op('audioMetadata', meta('audio-a'), 2), ...evidence.map(row => op('events', { ...row, data: { ...row.data, ...(row.type === 'READING_RETELL' ? { audioId: 'audio-a' } : {}) } }, 4))]
    const partial = await projectOperations(history)
    expect(partial.records.sessions.find(row => row.id === base.id)?.draft).toMatchObject({ retell: saved.draft.retell, audioId: 'audio-a' })
    expect(partial.records.sessions.filter(row => row.kind === 'reading-conflict')).toEqual([])
    expect(partial.deferred.some(row => row.entityId.startsWith('reading-conflict:'))).toBe(true)
    const final = await projectOperations([...history, op('audioMetadata', meta('audio-b'), 6)])
    expect(final.records.sessions.find(row => row.kind === 'reading-conflict')?.draft).toMatchObject({ retell: b.draft.retell, audioId: 'audio-b' })
    expect(final.records.events.find(row => row.type === 'READING_RETELL')?.data).toMatchObject({ response: saved.draft.retell, audioId: 'audio-a' })
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
