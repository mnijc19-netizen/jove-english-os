import 'fake-indexeddb/auto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JoveDatabase } from '../src/db/db'
import { defaultProfile, defaultSettings } from '../src/domain/types'
import { SyncJournal } from '../src/sync/journal'
import { SupabaseSyncRemote, synchronize } from '../src/sync/remote'
import { audioHash, downloadRecording, readRecordingRetention, synchronizeAudio, uploadRecording } from '../src/sync/audio'
import { bindSyncAccess } from '../src/sync/access'
import { changedFields, type RecordValue, type SyncOperation } from '../src/sync/protocol'
import type { LearningLanguage } from '../src/domain/language'

// Opt-in LOCAL integration only. CLI output is consumed in memory and never logged.
const enabled = process.env.JOVE_LOCAL_CLOUD_TEST === '1'
describe.skipIf(!enabled)('real local Auth/PostgREST/Storage synchronization', () => {
  let admin: SupabaseClient, a: SupabaseClient, b: SupabaseClient, stranger: SupabaseClient
  let owner = '', second = '', fixtureEmail = '', dbA: JoveDatabase, dbB: JoveDatabase
  let publicConfig: { url: string; publishableKey: string }
  const localFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== 'http://127.0.0.1:55321') throw new Error('Refusing a non-Jove-local request')
    return fetch(input, init)
  }
  const access = (client: SupabaseClient, database?: JoveDatabase) => bindSyncAccess(client, owner, publicConfig, async () => {
    if (database && (await database.syncMeta.get('owner'))?.value !== owner) throw new Error('Wrong fixture database owner')
  }, localFetch)
  const objectPaths: string[] = []
  const maintenanceDatabases: JoveDatabase[] = []
  beforeAll(async () => {
    let config: { API_URL: string; SERVICE_ROLE_KEY: string; ANON_KEY: string }
    try {
      const raw = process.platform === 'win32'
        ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx supabase status --output json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        : execFileSync('npx', ['supabase', 'status', '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      config = JSON.parse(raw)
    } catch { throw new Error('Could not read dedicated local test configuration') }
    const url = new URL(config.API_URL)
    if (url.origin !== 'http://127.0.0.1:55321' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Refusing integration test against a non-Jove-local backend')
    try {
      const labels = JSON.parse(execFileSync('docker', ['inspect','--format','{{json .Config.Labels}}','supabase_db_jove-english-os'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'] }))
      if (labels['com.supabase.cli.project'] !== 'jove-english-os' || realpathSync(labels['com.supabase.cli.workdir']) !== realpathSync(process.cwd())) throw new Error()
    } catch { throw new Error('Refusing SQL fixtures outside this dedicated local Jove workspace') }
    publicConfig = { url: config.API_URL, publishableKey: config.ANON_KEY }
    const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: localFetch } }
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, options)
    a = createClient(config.API_URL, config.ANON_KEY, options)
    b = createClient(config.API_URL, config.ANON_KEY, options)
    stranger = createClient(config.API_URL, config.ANON_KEY, options)
    const address = `jove-test-${crypto.randomUUID()}@example.invalid`, password = crypto.randomUUID() + crypto.randomUUID()
    fixtureEmail = address
    const created = await admin.auth.admin.createUser({ email: address, password, email_confirm: true })
    if (!created.data.user || created.error) throw new Error('Local test account provisioning failed')
    owner = created.data.user.id
    const member = await admin.from('app_members').insert({ user_id: owner })
    if (member.error) throw new Error('Local membership provisioning failed')
    for (const client of [a, b]) {
      const signed = await client.auth.signInWithPassword({ email: address, password })
      if (signed.error) throw new Error('Local sign-in failed')
    }
    const otherAddress = `jove-other-${crypto.randomUUID()}@example.invalid`
    const other = await admin.auth.admin.createUser({ email: otherAddress, password, email_confirm: true })
    if (!other.data.user || other.error) throw new Error('Local isolation fixture provisioning failed')
    second = other.data.user.id
    if ((await stranger.auth.signInWithPassword({ email: otherAddress, password })).error) throw new Error('Local second sign-in failed')
    dbA = new JoveDatabase(`cloud-live-a-${crypto.randomUUID()}`)
    dbB = new JoveDatabase(`cloud-live-b-${crypto.randomUUID()}`)
    for (const database of [dbA, dbB]) {
      await database.profiles.put({ ...defaultProfile(), onboarded: true })
      await database.settings.put({ id: 'main', value: { ...defaultSettings } })
    }
  }, 60000)
  afterAll(async () => {
    if (objectPaths.length) await admin?.storage.from('jove-recordings').remove(objectPaths)
    if (owner) await admin.auth.admin.deleteUser(owner)
    if (second) await admin.auth.admin.deleteUser(second)
    if (dbA) await dbA.delete()
    if (dbB) await dbB.delete()
    for (const database of maintenanceDatabases) await database.delete()
    for (const client of [a, b, stranger]) await client?.auth.signOut({ scope: 'local' })
  })
  it('syncs independent device evidence and a half-finished lesson through real authenticated HTTP', async () => {
    const ja = new SyncJournal(dbA), jb = new SyncJournal(dbB)
    await ja.bindOwner(owner); await jb.bindOwner(owner)
    const ra = new SupabaseSyncRemote(a), rb = new SupabaseSyncRemote(b)
    await synchronize(ja, ra); await synchronize(jb, rb)
    await dbA.events.add({ id: 'heard-on-computer', type: 'LISTEN_ATTEMPT', timestamp: Date.now(), source: 'objective', skill: 'naturalListening', score: 0.65 })
    await dbB.events.add({ id: 'spoke-on-phone', type: 'SPEAK_ATTEMPT', timestamp: Date.now(), source: 'text', skill: 'grammarProduction', score: 0.55 })
    await dbA.sessions.put({ id: 'ongoing-lesson', kind: 'listen', startedAt: Date.now(), stage: '1', draft: { answer: 'Saved halfway through', audioId: '' } })
    await synchronize(jb, rb); await synchronize(ja, ra); await synchronize(jb, rb)
    expect((await dbA.events.toArray()).map(e => e.id).sort()).toEqual(['heard-on-computer', 'spoke-on-phone'])
    expect((await dbB.events.toArray()).map(e => e.id).sort()).toEqual(['heard-on-computer', 'spoke-on-phone'])
    expect((await dbB.sessions.get('ongoing-lesson'))?.draft.answer).toBe('Saved halfway through')
    const before = await ja.cursor()
    await synchronize(ja, ra)
    expect(await ja.cursor()).toBe(before)
    expect(await ja.pending()).toHaveLength(0)
  }, 30000)
  it('rejects a signed-in nonmember and keeps account data invisible', async () => {
    const rows = await stranger.from('sync_operations').select('id')
    expect(rows.data).toEqual([])
    const result = await stranger.rpc('append_sync_operations', { operations: [] })
    expect(result.error?.code).toBe('42501')
    const enrollment = await stranger.from('app_members').insert({ user_id: second })
    expect(enrollment.error).toBeTruthy()
  })
  it('verifies a real Auth code through 55321 only (not an email delivery/browser claim)', async () => {
    const issued = await admin.auth.admin.generateLink({ type: 'magiclink', email: fixtureEmail })
    let code = issued.data.properties?.email_otp ?? ''
    if (issued.error || !code) throw new Error('Local verification fixture could not be issued')
    const verified = await b.auth.verifyOtp({ email: fixtureEmail, token: code, type: 'email' })
    code = ''
    if (verified.error) throw new Error('Local email code verification failed')
    expect(verified.data.user?.id).toBe(owner)
    expect(!!verified.data.session).toBe(true)
    // This is an HTTP OTP contract check; actual hash-route preservation remains a browser gate.
  }, 15000)

  function evidence(id: string, logicalClock: number, score = 0.5): SyncOperation {
    const record: RecordValue = { id, type: 'LISTEN_ATTEMPT', timestamp: Date.now(), source: 'objective', skill: 'naturalListening', score }
    return { id: crypto.randomUUID(), deviceId: '00000000-0000-4000-8000-000000000099', logicalClock,
      entityType: 'events', entityId: id, kind: 'put', schemaVersion: 1, payload: { record, changed: changedFields(undefined, record) } }
  }
  it('rejects huge/skipped clocks atomically, preserves retry identity and accepts a subsequent legal chain', async () => {
    const maximum = await a.from('sync_operations').select('logical_clock').order('logical_clock', { ascending: false }).limit(1)
    if (maximum.error) throw new Error('Could not inspect local clock fixture')
    const known = Number(maximum.data?.[0]?.logical_clock ?? 0)
    const huge = await a.rpc('append_sync_operations', { operations: [evidence('poison-denied', 9007199254740990)] })
    expect(huge.error?.code).toBe('22023')
    const skipped = [evidence('atomic-rollback', known + 1), evidence('gap-denied', known + 3)]
    expect((await a.rpc('append_sync_operations', { operations: skipped })).error?.code).toBe('22023')
    expect((await a.from('sync_operations').select('id').eq('entity_id', 'atomic-rollback')).data).toEqual([])
    const legal = [evidence('legal-after-denial', known + 1), evidence('legal-next', known + 2), evidence('older-offline-clock', 1)]
    const accepted = await a.rpc('append_sync_operations', { operations: legal })
    expect(accepted.error).toBeNull()
    expect(accepted.data?.length).toBe(3)
    expect(accepted.data?.every((receipt: { cursor: number }, index: number) => receipt.cursor >= legal[index]!.logicalClock)).toBe(true)
    const retry = await a.rpc('append_sync_operations', { operations: [legal[0]] })
    expect(retry.data?.[0]?.cursor).toBe(accepted.data?.[0]?.cursor)
    expect((await a.rpc('append_sync_operations', { operations: [{ ...legal[0], deviceId: null }] })).error?.code).toBe('23505')
  })
  it('retries a real committed upload after a lost response without duplicating the journal', async () => {
    const journal = new SyncJournal(dbA)
    await synchronize(journal, new SupabaseSyncRemote(a))
    await dbA.sessions.put({ id: 'lost-receipt-draft', kind: 'listen', stage: 'draft', startedAt: Date.now(), draft: { answer: 'original survives retry' } })
    await journal.capture()
    const ids = (await journal.pending()).map(row => row.id)
    let dropped = false
    const fixed = await bindSyncAccess(a, owner, publicConfig, async () => {
      if (await journal.owner() !== owner) throw new Error('Wrong local owner')
    }, async (input, init) => {
      const response = await localFetch(input, init)
      if (!dropped && String(input).includes('/append_sync_operations')) { dropped = true; throw new Error('Injected response loss after server commit') }
      return response
    })
    await expect(synchronize(journal, new SupabaseSyncRemote(fixed.client, fixed))).rejects.toThrow()
    expect((await journal.pending()).map(row => row.id)).toEqual(ids)
    await synchronize(journal, new SupabaseSyncRemote(a))
    const stored = await a.from('sync_operations').select('id').in('id', ids)
    expect(stored.data?.length).toBe(ids.length)
    expect(await journal.pendingCount()).toBe(0)
    expect((await dbA.sessions.get('lost-receipt-draft'))?.draft.answer).toBe('original survives retry')
  }, 30000)
  it('pins actual HTTP to A while the mutable SDK signs into another member during dispatch', async () => {
    const original = (await a.auth.getSession()).data.session, other = (await stranger.auth.getSession()).data.session
    if (!original || !other) throw new Error('Missing local account fixture')
    if ((await admin.from('app_members').insert({ user_id: second })).error) throw new Error('Could not enable isolated member fixture')
    let switched = false, pinned = false
    try {
      const fixed = await bindSyncAccess(a, owner, publicConfig, async () => {}, async (input, init) => {
        if (!switched && String(input).includes('/append_sync_operations')) {
          switched = true
          const signed = await a.auth.setSession({ access_token: other.access_token, refresh_token: other.refresh_token })
          if (signed.error) throw new Error('Could not switch local fixture account')
          pinned = new Headers(init?.headers).get('Authorization') === 'Bearer ' + original.access_token
        }
        return localFetch(input, init)
      })
      await expect(new SupabaseSyncRemote(fixed.client, fixed).upload([evidence('a-during-switch', 1)], owner)).rejects.toThrow()
      expect(pinned).toBe(true)
      const underA = await admin.from('sync_operations').select('id').eq('user_id', owner).eq('entity_id', 'a-during-switch')
      const underB = await admin.from('sync_operations').select('id').eq('user_id', second).eq('entity_id', 'a-during-switch')
      expect(underA.data?.length).toBe(1); expect(underB.data).toEqual([])
    } finally {
      await a.auth.setSession({ access_token: original.access_token, refresh_token: original.refresh_token })
      await admin.from('app_members').delete().eq('user_id', second)
    }
  }, 30000)
  it('converges real multi-page histories and byte-bounded batches including legacy event collisions and empty draft edits', async () => {
    const ja = new SyncJournal(dbA), jb = new SyncJournal(dbB), ra = new SupabaseSyncRemote(a), rb = new SupabaseSyncRemote(b)
    await synchronize(ja, ra); await synchronize(jb, rb)
    const timestamp = Date.now()
    const base = { id: 'empty-live-draft', kind: 'listen', startedAt: timestamp, stage: 'draft', draft: {} }
    await dbA.sessions.put(base)
    await synchronize(ja, ra); await synchronize(jb, rb)
    // The draft references a real saved original; without its metadata the
    // projector correctly stages the draft as an unresolved dependency.
    const draftAudio = { id: 'unfinished-recording-reference', blob: new Blob([new Uint8Array([82,73,70,70,1,2,3,4])], { type: 'audio/wav' }),
      mimeType: 'audio/wav', createdAt: timestamp, duration: 1, kind: 'recording' as const, processed: false, label: 'Draft fixture' }
    await dbA.audio.put(draftAudio)
    objectPaths.push(owner + '/' + draftAudio.id + '-' + await audioHash(draftAudio.blob))
    await dbA.sessions.update(base.id, { draft: { answer: 'A kept', audioIds: ['unfinished-recording-reference'] } })
    await dbA.events.bulkPut(Array.from({ length: 505 }, (_, index) => ({
      id: 'page-event-' + index, type: 'LISTEN_ATTEMPT', timestamp, source: 'objective' as const, skill: 'naturalListening' as const, score: 0.5,
    })))
    for (let index = 0; index < 9; index++) await dbA.sessions.put({
      id: 'byte-batch-' + index, kind: 'listen', startedAt: timestamp, stage: 'draft', draft: { answer: 'a'.repeat(480_000) },
    })
    await dbA.events.put({ id: 'legacy-live-collision', type: 'LISTEN_ATTEMPT', timestamp, source: 'objective', score: 0.2 })
    await dbB.events.put({ id: 'legacy-live-collision', type: 'LISTEN_ATTEMPT', timestamp, source: 'objective', score: 0.8 })
    await synchronize(jb, rb)
    const sent = await synchronize(ja, ra), received = await synchronize(jb, rb)
    expect(sent.pending).toBe(0); expect(received.hasMore).toBe(false)
    expect(received.downloaded).toBeGreaterThan(500)
    expect(await dbB.events.filter(row => row.id.startsWith('page-event-')).count()).toBe(505)
    expect((await dbB.events.filter(row => row.id.startsWith('legacy-live-collision~')).toArray()).map(row => row.score).sort()).toEqual([0.2, 0.8])
    expect((await dbB.sessions.get('byte-batch-8'))?.draft.answer).toHaveLength(480_000)
    expect((await dbB.sessions.get(base.id))?.draft).toEqual({ answer: 'A kept', audioIds: ['unfinished-recording-reference'] })
    await synchronize(ja, ra)
    expect((await dbA.events.toArray()).map(row => row.id).sort()).toEqual((await dbB.events.toArray()).map(row => row.id).sort())
  }, 60000)
  it('uses server preferences and metadata frontier to change retention without deleting draft originals', async () => {
    const ja = new SyncJournal(dbA), jb = new SyncJournal(dbB), ra = new SupabaseSyncRemote(a), rb = new SupabaseSyncRemote(b)
    const asset = { id: crypto.randomUUID(), blob: new Blob([new Uint8Array([82,73,70,70,8,7,6,5])], { type: 'audio/wav' }),
      mimeType: 'audio/wav', createdAt: Date.now(), duration: 1, kind: 'recording' as const, processed: true, label: 'Retention fixture' }
    objectPaths.push(owner + '/' + asset.id + '-' + await audioHash(asset.blob))
    await dbA.audio.add(asset)
    await dbA.conversations.put({ id: 'retention-talk', mode: 'free', scenario: '', startedAt: Date.now(),
      messages: [{ id: 'retention-message', role: 'user', text: 'unfinished', timestamp: Date.now(), audioId: asset.id }] })
    await synchronize(ja, ra); await synchronize(jb, rb)
    const aa = await access(a, dbA), ab = await access(b, dbB)
    await synchronizeAudio(dbA, aa, await readRecordingRetention(aa))
    let row = await a.from('recording_manifest').select('*').eq('audio_id', asset.id).single()
    expect(row.data?.expires_at).toBeNull()
    const stale = await a.rpc('reconcile_recording_retention', { recording_id: asset.id, expected_cursor: 0,
      retention_purpose: 'history', retention_expires_at: new Date().toISOString(), expected_policy: 'minimal' })
    expect(stale.data).toBe(false)
    expect((await a.from('recording_manifest').update({ expires_at: new Date().toISOString() }).eq('audio_id', asset.id)).error).toBeTruthy()
    await dbA.conversations.update('retention-talk', { completedAt: Date.now() })
    await synchronize(ja, ra); await synchronize(jb, rb)
    if ((await a.from('service_preferences').upsert({ user_id: owner, recording_retention: 'more-history' })).error) throw new Error('Local preference change failed')
    await synchronizeAudio(dbA, aa, await readRecordingRetention(aa))
    row = await a.from('recording_manifest').select('*').eq('audio_id', asset.id).single()
    expect(Date.parse(row.data?.expires_at)).toBe(asset.createdAt + 30 * 86400000)
    await synchronizeAudio(dbB, ab, await readRecordingRetention(ab))
    expect(await audioHash((await dbB.audio.get(asset.id))!.blob)).toBe(await audioHash(asset.blob))
    if ((await a.from('service_preferences').update({ recording_retention: 'assessment-only' }).eq('user_id', owner)).error) throw new Error('Local preference change failed')
    await synchronizeAudio(dbA, aa, await readRecordingRetention(aa))
    row = await a.from('recording_manifest').select('*').eq('audio_id', asset.id).single()
    expect(Date.parse(row.data?.expires_at)).toBe(asset.createdAt + 7 * 86400000)
    expect(await audioHash((await dbA.audio.get(asset.id))!.blob)).toBe(await audioHash(asset.blob))
  }, 60000)

  describe('isolated recording maintenance', () => {
  let a: SupabaseClient, owner = ''
  beforeAll(async () => {
    const email = `jove-maintenance-${crypto.randomUUID()}@example.invalid`, password = crypto.randomUUID()+crypto.randomUUID()
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error || !created.data.user) throw new Error('Local maintenance account provisioning failed')
    owner = created.data.user.id
    if ((await admin.from('app_members').insert({ user_id: owner })).error) throw new Error('Local maintenance membership failed')
    a = createClient(publicConfig.url, publicConfig.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: localFetch } })
    if ((await a.auth.signInWithPassword({ email, password })).error) throw new Error('Local maintenance sign-in failed')
  })
  afterAll(async () => {
    if (owner) {
      const paths = objectPaths.filter(path => path.startsWith(owner+'/'))
      if (paths.length) expect((await admin.storage.from('jove-recordings').remove(paths)).error).toBeNull()
      expect((await admin.auth.admin.deleteUser(owner)).error).toBeNull()
    }
    await a?.auth.signOut({ scope: 'local' })
  })
  function localSql(input: string): string {
    try {
      return execFileSync('docker', ['exec','-i','supabase_db_jove-english-os','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'], {
        input, encoding: 'utf8', windowsHide: true, stdio: ['pipe','pipe','pipe'],
      })
    } catch { throw new Error('Dedicated local recording fixture SQL failed; raw output withheld') }
  }
  async function prepareExpiredRecording(language: LearningLanguage, bytes = 8) {
    const buffer = new Uint8Array(bytes); buffer.set([82,73,70,70,1,2,3,4])
    const blob = new Blob([buffer], { type: 'audio/wav' })
    const asset = { id: crypto.randomUUID(), blob, mimeType: 'audio/wav', createdAt: Date.now()-10*86400000,
      duration: 1, kind: 'recording' as const, processed: true, label: 'Local maintenance fixture' }
    const database = new JoveDatabase(`maintenance-live-${crypto.randomUUID()}`, language)
    maintenanceDatabases.push(database)
    await new SyncJournal(database).bindOwner(owner)
    await database.audio.add(asset)
    const aa = await bindSyncAccess(a, owner, publicConfig, async () => {
      if ((await database.syncMeta.get('owner'))?.value !== owner) throw new Error('Maintenance fixture owner changed')
    }, localFetch)
    const manifest = await uploadRecording(aa, asset, { purpose: 'draft', expiresAt: null }, language)
    objectPaths.push(manifest.object_path)
    const table = language === 'en' ? 'sync_operations' : 'language_sync_operations'
    const frontier = await a.from(table).select('cursor').order('cursor', { ascending: false }).limit(1)
    expect(frontier.error).toBeNull()
    const cursor = frontier.data?.[0]?.cursor ?? 0, policy = await readRecordingRetention(aa)
    expect((await a.rpc(language === 'en' ? 'reconcile_recording_retention' : 'reconcile_language_recording_retention', {
      ...(language === 'ja' ? { learning_language: 'ja' } : {}), recording_id: asset.id, expected_cursor: cursor,
      retention_purpose: 'history', retention_expires_at: new Date(asset.createdAt+7*86400000).toISOString(), expected_policy: policy,
    })).data).toBe(true)
    const planned = await a.rpc('recording_maintenance', { action: 'prepare-cleanup', learning_language: language, request: { cursor, policy } })
    expect(planned.error).toBeNull()
    const candidate = (planned.data?.candidates as { audioId: string; path: string; version: string }[])?.find(row => row.audioId === asset.id)
    if (!candidate || candidate.path !== manifest.object_path || !/^[a-zA-Z0-9/-]+$/.test(candidate.path) || !/^[a-zA-Z0-9-]+$/.test(candidate.version)) throw new Error('Invalid local cleanup fixture identity')
    return { asset, aa, manifest, candidate, database, cursor, policy }
  }
  it.each(['en','ja'] as const)('removes only the expired %s cloud version and leaves its local original', async language => {
    const f = await prepareExpiredRecording(language)
    const removed = await a.storage.from('jove-recordings').remove([{ path: f.candidate.path, versionId: f.candidate.version }])
    expect(removed.error).toBeNull()
    expect(removed.data?.some(row => row.name === f.candidate.path)).toBe(true)
    const final = await a.rpc('recording_maintenance', { action: 'finish-cleanup', learning_language: language,
      request: { audioId: f.asset.id, version: f.candidate.version } })
    expect(final.data?.state).toBe('removed')
    expect((await a.storage.from('jove-recordings').download(f.candidate.path)).error).toBeTruthy()
    expect((await a.from(language === 'en' ? 'recording_manifest' : 'language_recording_manifest').select('*').eq('audio_id', f.asset.id)).data).toEqual([])
    expect(await audioHash((await f.database.audio.get(f.asset.id))!.blob)).toBe(await audioHash(f.asset.blob))
  }, 30000)
  it.each(['en','ja'] as const)('recovers %s after physical deletion but metadata rollback, and ignores a late old-version delete', async language => {
    const f = await prepareExpiredRecording(language)
    expect((await a.storage.from('jove-recordings').remove([{ path: f.candidate.path, versionId: f.candidate.version }])).error).toBeNull()
    // Recreate exactly the post-rollback failure state: the actual file was
    // deleted through Storage, while its old DB metadata still exists. This is
    // a LOCAL fixture only, not the production recovery implementation.
    localSql(`insert into storage.objects(bucket_id,name,owner_id,version,metadata) values ('jove-recordings','${f.candidate.path}','${owner}','${f.candidate.version}','{"size":8,"mimetype":"audio/wav"}');`)
    expect((await a.storage.from('jove-recordings').info(f.candidate.path)).error).toBeNull()
    expect((await a.storage.from('jove-recordings').download(f.candidate.path)).error).toBeTruthy()
    if (language === 'en') {
      const request = { audioId: f.asset.id, version: f.candidate.version, sha256: f.manifest.sha256, bytes: 8 }
      expect((await a.rpc('recording_maintenance', { action: 'prepare-recovery', learning_language: language, request })).data?.state).toBe('remove-old')
      expect((await a.storage.from('jove-recordings').remove([{ path: f.candidate.path, versionId: f.candidate.version }])).error).toBeNull()
      expect((await a.rpc('reserve_recording_upload', { object_path: f.candidate.path, recording_bytes: 8 })).data).toBe(true)
      expect((await admin.from('recording_upload_reservations').select('bytes,held_bytes,expires_at').eq('object_path', f.candidate.path).single()).data)
        .toMatchObject({ bytes: 8, held_bytes: 25*1024*1024, expires_at: 'infinity' })
    }
    const recovered = await uploadRecording(f.aa, f.asset, { purpose: 'draft', expiresAt: null }, language)
    expect(recovered.cleanup_version).toBeNull()
    expect(recovered.recovery_pending).toBe(false)
    expect(await audioHash((await a.storage.from('jove-recordings').download(f.candidate.path)).data!)).toBe(await audioHash(f.asset.blob))
    expect((await admin.from('recording_upload_reservations').select('object_path').eq('object_path', f.candidate.path)).data).toEqual([])
    const late = await a.storage.from('jove-recordings').remove([{ path: f.candidate.path, versionId: f.candidate.version }])
    expect(late.error).toBeNull()
    expect(late.data).toEqual([])
    const final = await a.rpc('recording_maintenance', { action: 'finish-cleanup', learning_language: language,
      request: { audioId: f.asset.id, version: f.candidate.version } })
    expect(final.data?.state).toBe('unchanged')
    expect(await audioHash((await a.storage.from('jove-recordings').download(f.candidate.path)).data!)).toBe(await audioHash(f.asset.blob))
    expect((await f.database.audio.get(f.asset.id))?.blob.size).toBe(8)
  }, 30000)
  it('confirms an already uploaded replacement after a lost recovery response without deleting it again', async () => {
    const f = await prepareExpiredRecording('en')
    const request = { audioId: f.asset.id, version: f.candidate.version, sha256: f.manifest.sha256, bytes: f.asset.blob.size }
    expect((await a.rpc('recording_maintenance', { action: 'prepare-recovery', learning_language: 'en', request })).data?.state).toBe('remove-old')
    expect((await a.storage.from('jove-recordings').remove([{ path: f.candidate.path, versionId: f.candidate.version }])).error).toBeNull()
    expect((await a.storage.from('jove-recordings').upload(f.candidate.path, f.asset.blob, { upsert: false })).error).toBeNull()
    const readVersion = () => localSql(`select version from storage.objects where bucket_id='jove-recordings' and name='${f.candidate.path}';`).trim()
    const before = readVersion()
    const requests: { method: string; version: string | null; nonce: string | null }[] = []
    const freshAccess = await bindSyncAccess(a, owner, publicConfig, async () => {}, async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname.includes('/storage/v1/object/')) requests.push({ method: init?.method ?? 'GET', version: url.searchParams.get('versionId'), nonce: url.searchParams.get('cacheNonce') })
      return localFetch(input, init)
    })
    const recovered = await uploadRecording(freshAccess, f.asset, { purpose: 'draft', expiresAt: null })
    const after = readVersion()
    expect(recovered.cleanup_version).toBeNull()
    expect(before).toMatch(/^[a-zA-Z0-9-]{1,100}$/)
    expect(after).toBe(before)
    expect(requests).toEqual([{ method: 'GET', version: before, nonce: expect.any(String) }])
    expect((await admin.from('recording_upload_reservations').select('object_path').eq('object_path', f.candidate.path)).data).toEqual([])
  }, 30000)
  it.each(['en','ja'] as const)('keeps a physically missing new %s version pending instead of confirming a cached copy', async language => {
    const f = await prepareExpiredRecording(language)
    const request = { audioId: f.asset.id, version: f.candidate.version, sha256: f.manifest.sha256, bytes: 8 }
    expect((await a.rpc('recording_maintenance', { action: 'prepare-recovery', learning_language: language, request })).data?.state).toBe('remove-old')
    expect((await a.storage.from('jove-recordings').remove([{ path: f.candidate.path, versionId: f.candidate.version }])).error).toBeNull()
    const replacementVersion = crypto.randomUUID()
    // LOCAL-only rollback fixture: V2 metadata exists, physical V2 does not.
    localSql(`insert into storage.objects(bucket_id,name,owner_id,version,metadata) values ('jove-recordings','${f.candidate.path}','${owner}','${replacementVersion}','{"size":8,"mimetype":"audio/wav"}');`)
    const missing = await a.storage.from('jove-recordings').download(f.candidate.path, { versionId: replacementVersion, cacheNonce: crypto.randomUUID() })
    expect(missing.error && { code: 'code' in missing.error ? missing.error.code : undefined, status: missing.error.status, statusCode: missing.error.statusCode })
      .toMatchObject({ code: 'InternalError' })
    await expect(uploadRecording(f.aa, f.asset, { purpose: 'draft', expiresAt: null }, language)).rejects.toThrow('could not be verified')
    expect((await a.from(language === 'en' ? 'recording_manifest' : 'language_recording_manifest').select('cleanup_version,recovery_pending').eq('audio_id', f.asset.id).single()).data)
      .toMatchObject({ cleanup_version: f.candidate.version, recovery_pending: true })
    expect(localSql(`select version from storage.objects where bucket_id='jove-recordings' and name='${f.candidate.path}';`).trim()).toBe(replacementVersion)
    expect(await audioHash((await f.database.audio.get(f.asset.id))!.blob)).toBe(await audioHash(f.asset.blob))
  }, 30000)
  it('does not rebase or delete a new version on a denied physical verification', async () => {
    const f = await prepareExpiredRecording('en')
    const request = { audioId: f.asset.id, version: f.candidate.version, sha256: f.manifest.sha256, bytes: 8 }
    await a.rpc('recording_maintenance', { action: 'prepare-recovery', learning_language: 'en', request })
    await a.storage.from('jove-recordings').remove([{ path: f.candidate.path, versionId: f.candidate.version }])
    expect((await a.storage.from('jove-recordings').upload(f.candidate.path, f.asset.blob)).error).toBeNull()
    const writes: string[] = []
    const deniedAccess = await bindSyncAccess(a, owner, publicConfig, async () => {}, async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname.includes('/storage/v1/object/')) {
        if (init?.method && init.method !== 'GET') writes.push(init.method)
        return new Response(JSON.stringify({ code: 'AccessDenied', message: 'Local fixture' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
      }
      return localFetch(input, init)
    })
    await expect(uploadRecording(deniedAccess, f.asset, { purpose: 'draft', expiresAt: null })).rejects.toThrow('could not be verified')
    expect(writes).toEqual([])
    expect((await a.from('recording_manifest').select('cleanup_version').eq('audio_id', f.asset.id).single()).data?.cleanup_version).toBe(f.candidate.version)
    await uploadRecording(f.aa, f.asset, { purpose: 'draft', expiresAt: null })
  }, 30000)
  it('treats an empty successful deletion as denied when a newer assessment protects the object', async () => {
    const f = await prepareExpiredRecording('en')
    expect((await a.rpc('reconcile_recording_retention', { recording_id: f.asset.id, expected_cursor: f.cursor,
      retention_purpose: 'assessment', retention_expires_at: null, expected_policy: f.policy })).data).toBe(true)
    const denied = await a.storage.from('jove-recordings').remove([{ path: f.candidate.path, versionId: f.candidate.version }])
    expect(denied.error).toBeNull()
    expect(denied.data).toEqual([])
    const final = await a.rpc('recording_maintenance', { action: 'finish-cleanup', learning_language: 'en', request: { audioId: f.asset.id, version: f.candidate.version } })
    expect(final.data?.state).toBe('pending')
    expect(await audioHash((await a.storage.from('jove-recordings').download(f.candidate.path)).data!)).toBe(await audioHash(f.asset.blob))
  }, 30000)
  it.each(['en','ja'] as const)('automatically cleans %s before a full-bucket upload instead of starving maintenance', async language => {
    const f = await prepareExpiredRecording(language, 20*1024*1024)
    const fresh = { ...f.asset, id: crypto.randomUUID(), createdAt: Date.now(), processed: false }
    const path = `${owner}/${language === 'ja' ? 'ja/' : ''}${fresh.id}-${await audioHash(fresh.blob)}`
    objectPaths.push(path)
    await f.database.audio.add(fresh)
    const journal = new SyncJournal(f.database)
    await synchronize(journal, new SupabaseSyncRemote(f.aa.client, f.aa, language))
    const setting = await admin.from('recording_storage_limits').select('limit_bytes').single()
    if (!setting.data || setting.error) throw new Error('Missing local cloud limit')
    const used = Number(localSql("select public.recording_capacity_used('');").trim())
    if (!Number.isSafeInteger(used) || used < 20*1024*1024) throw new Error('Invalid local storage fixture accounting')
    try {
      expect((await admin.from('recording_storage_limits').update({ limit_bytes: used+12*1024*1024 }).eq('singleton', true)).error).toBeNull()
      expect((await a.rpc('reserve_recording_upload', { object_path: path, recording_bytes: fresh.blob.size })).data).toBe(false)
      const result = await synchronizeAudio(f.database, f.aa, await readRecordingRetention(f.aa))
      expect(result.uploaded).toBeGreaterThan(0)
      expect((await a.storage.from('jove-recordings').download(f.manifest.object_path)).error).toBeTruthy()
      const table = language === 'en' ? 'recording_manifest' : 'language_recording_manifest'
      expect((await a.from(table).select('audio_id').eq('audio_id', f.asset.id)).data).toEqual([])
      expect((await a.from(table).select('bytes').eq('audio_id', fresh.id).single()).data?.bytes).toBe(fresh.blob.size)
      expect((await f.database.audio.get(f.asset.id))?.blob.size).toBe(20*1024*1024)
      expect((await f.database.audio.get(fresh.id))?.blob.size).toBe(20*1024*1024)
    } finally {
      expect((await admin.from('recording_storage_limits').update({ limit_bytes: setting.data.limit_bytes }).eq('singleton', true)).error).toBeNull()
      expect((await admin.storage.from('jove-recordings').remove([path, f.manifest.object_path])).error).toBeNull()
      expect((await admin.from(language === 'en' ? 'recording_manifest' : 'language_recording_manifest').delete().eq('user_id', owner).eq('audio_id', fresh.id)).error).toBeNull()
      expect((await admin.from('recording_upload_reservations').delete().in('object_path', [path, f.manifest.object_path])).error).toBeNull()
    }
  }, 60000)
  it.each(['en','ja'] as const)('finishes a pending %s recovery even when the current policy would skip that recording', async language => {
    const f = await prepareExpiredRecording(language)
    const request = { audioId: f.asset.id, version: f.candidate.version, sha256: f.manifest.sha256, bytes: 8 }
    expect((await a.rpc('recording_maintenance', { action: 'prepare-recovery', learning_language: language, request })).data?.state).toBe('remove-old')
    expect((await a.storage.from('jove-recordings').remove([{ path: f.candidate.path, versionId: f.candidate.version }])).error).toBeNull()
    const journal = new SyncJournal(f.database)
    await synchronize(journal, new SupabaseSyncRemote(f.aa.client, f.aa, language))
    const result = await synchronizeAudio(f.database, f.aa, await readRecordingRetention(f.aa))
    expect(result.uploaded).toBeGreaterThan(0)
    expect(result.retentionPending).toBe(true)
    expect((await admin.from('recording_upload_reservations').select('object_path').eq('object_path', f.candidate.path)).data).toEqual([])
    expect(await audioHash((await a.storage.from('jove-recordings').download(f.candidate.path)).data!)).toBe(await audioHash(f.asset.blob))
    // After recovery has released its hold, ordinary policy cleanup may run.
    await synchronizeAudio(f.database, f.aa, await readRecordingRetention(f.aa))
    expect((await a.storage.from('jove-recordings').download(f.candidate.path)).error).toBeTruthy()
    expect((await f.database.audio.get(f.asset.id))?.blob.size).toBe(8)
  }, 60000)
  it.each(['en','ja'] as const)('keeps a missing %s recovery blocked while another device synchronizes unrelated originals', async language => {
    const f = await prepareExpiredRecording(language), sourceJournal = new SyncJournal(f.database)
    await synchronize(sourceJournal, new SupabaseSyncRemote(f.aa.client, f.aa, language))
    const request = { audioId: f.asset.id, version: f.candidate.version, sha256: f.manifest.sha256, bytes: 8 }
    expect((await a.rpc('recording_maintenance', { action: 'prepare-recovery', learning_language: language, request })).data?.state).toBe('remove-old')
    expect((await a.storage.from('jove-recordings').remove([{ path: f.candidate.path, versionId: f.candidate.version }])).error).toBeNull()
    const other = new JoveDatabase(`maintenance-other-${crypto.randomUUID()}`, language)
    maintenanceDatabases.push(other)
    const otherJournal = new SyncJournal(other)
    await otherJournal.bindOwner(owner)
    const otherAccess = await bindSyncAccess(a, owner, publicConfig, async () => {
      if ((await other.syncMeta.get('owner'))?.value !== owner) throw new Error('Other fixture owner changed')
    }, localFetch)
    const fresh = { ...f.asset, id: crypto.randomUUID(), createdAt: Date.now(), processed: false }
    await other.audio.add(fresh)
    const path = `${owner}/${language === 'ja' ? 'ja/' : ''}${fresh.id}-${await audioHash(fresh.blob)}`
    objectPaths.push(path)
    await synchronize(otherJournal, new SupabaseSyncRemote(otherAccess.client, otherAccess, language))
    expect(await other.audio.get(f.asset.id)).toBeUndefined()
    const result = await synchronizeAudio(other, otherAccess, await readRecordingRetention(otherAccess))
    expect(result.blocked).toBeGreaterThan(0)
    expect(result.retentionPending).toBe(true)
    expect(result.uploaded).toBeGreaterThan(0)
    expect((await a.storage.from('jove-recordings').download(path)).error).toBeNull()
    expect(await other.audio.get(f.asset.id)).toBeUndefined()
    // The original device can finish the outstanding recovery later.
    await synchronize(sourceJournal, new SupabaseSyncRemote(f.aa.client, f.aa, language))
    await synchronizeAudio(f.database, f.aa, await readRecordingRetention(f.aa))
    expect(await audioHash((await a.storage.from('jove-recordings').download(f.candidate.path)).data!)).toBe(await audioHash(f.asset.blob))
    expect((await admin.from('recording_upload_reservations').select('object_path').eq('object_path', f.candidate.path)).data).toEqual([])
  }, 60000)
  })
  it('fences real Storage inserts and concurrent English/Japanese reservations with one allowance', async () => {
    const current = await admin.from('recording_storage_limits').select('limit_bytes').single()
    if (current.error || !current.data) throw new Error('Missing local cloud allowance')
    const originalLimit = current.data.limit_bytes
    const paths = [`${owner}/quota-${crypto.randomUUID()}`, `${owner}/ja/quota-${crypto.randomUUID()}`]
    const undersized = `${owner}/quota-small-${crypto.randomUUID()}`, legacy = `${owner}/quota-legacy-${crypto.randomUUID()}`
    objectPaths.push(...paths, undersized, legacy)
    const reserve = (client: SupabaseClient, path: string, bytes: number) => client.rpc('reserve_recording_upload', { object_path: path, recording_bytes: bytes })
    const blob = new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: 'audio/wav' })
    try {
      // Actual Storage final metadata, not just a SQL/mocked policy call.
      expect((await reserve(a, undersized, 1)).data).toBe(true)
      expect((await a.storage.from('jove-recordings').upload(undersized, blob)).error).toBeTruthy()
      expect((await a.storage.from('jove-recordings').download(undersized)).error).toBeTruthy()
      // Installed older English clients still get admission, without an RPC.
      expect((await a.storage.from('jove-recordings').upload(legacy, blob)).error).toBeNull()
      expect((await a.storage.from('jove-recordings').upload(legacy, blob, { upsert: true })).error).toBeTruthy()
      expect((await admin.from('recording_storage_limits').update({ limit_bytes: 32 * 1024 * 1024 }).eq('singleton', true)).error).toBeNull()
      const bytes = 20 * 1024 * 1024
      const reservations = await Promise.all([reserve(a, paths[0]!, bytes), reserve(b, paths[1]!, bytes)])
      expect(reservations.map(row => row.error)).toEqual([null, null])
      expect(reservations.filter(row => row.data === true)).toHaveLength(1)
      const winner = reservations.findIndex(row => row.data === true), loser = 1 - winner
      const large = new Blob([new Uint8Array(bytes)], { type: 'audio/wav' })
      expect((await [a,b][winner]!.storage.from('jove-recordings').upload(paths[winner]!, large)).error).toBeNull()
      // No reservation/direct SDK upload cannot bypass the final shared gate.
      expect((await [a,b][loser]!.storage.from('jove-recordings').upload(paths[loser]!, large)).error).toBeTruthy()
      // Confirmation recovery costs no extra bytes, even after a lower cap.
      expect((await admin.from('recording_storage_limits').update({ limit_bytes: 1 }).eq('singleton', true)).error).toBeNull()
      expect((await reserve(b, paths[winner]!, bytes)).data).toBe(true)
      expect((await reserve(b, paths[loser]!, bytes)).data).toBe(false)
      const listed = await admin.storage.from('jove-recordings').list(paths[winner]!.slice(0, paths[winner]!.lastIndexOf('/')))
      expect(listed.data?.find(row => row.name === paths[winner]!.split('/').at(-1))?.metadata?.size).toBe(bytes)
      expect((await a.from('recording_storage_limits').update({ limit_bytes: originalLimit }).eq('singleton', true)).error).toBeTruthy()
      expect((await stranger.rpc('reserve_recording_upload', { object_path: `${second}/not-member`, recording_bytes: 1 })).error?.code).toBe('42501')
      // Both legacy preflights may see room. Only one final privileged commit fits.
      expect((await admin.storage.from('jove-recordings').remove(paths)).error).toBeNull()
      expect((await admin.from('recording_upload_reservations').delete().eq('user_id', owner)).error).toBeNull()
      expect((await admin.from('recording_storage_limits').update({ limit_bytes: 32 * 1024 * 1024 }).eq('singleton', true)).error).toBeNull()
      const racing = await Promise.all([a.storage.from('jove-recordings').upload(paths[0]!, large), b.storage.from('jove-recordings').upload(paths[1]!, large)])
      expect(racing.filter(row => row.error === null)).toHaveLength(1)
    } finally {
      const restored = await admin.from('recording_storage_limits').update({ limit_bytes: originalLimit }).eq('singleton', true)
      const removed = await admin.storage.from('jove-recordings').remove([...paths, undersized, legacy])
      expect(restored.error).toBeNull()
      expect(removed.error).toBeNull()
    }
  }, 60000)
  it('uploads once, verifies the original on another device, and rejects cross-owner recording reads', async () => {
    const blob = new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: 'audio/wav' })
    const recording = { id: crypto.randomUUID(), blob, mimeType: 'audio/wav', createdAt: Date.now(), duration: 1, kind: 'recording' as const, processed: false, label: 'Local storage integration fixture' }
    await dbA.audio.add(recording)
    const decision = { purpose: 'draft' as const, expiresAt: null }
    const aa = await access(a), ab = await access(b)
    objectPaths.push(owner + '/' + recording.id + '-' + await audioHash(blob))
    const manifest = await uploadRecording(aa, recording, decision)
    expect((await uploadRecording(aa, recording, decision)).sha256).toBe(manifest.sha256)
    const { blob: original, ...metadata } = recording
    const fetched = await downloadRecording(ab, manifest, metadata)
    expect(await audioHash(fetched.blob)).toBe(await audioHash(original))
    const denied = await stranger.storage.from('jove-recordings').download(manifest.object_path)
    expect(denied.error).toBeTruthy()
    expect((await dbA.audio.get(recording.id))?.blob.size).toBe(blob.size)
  }, 30000)
})
