import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { JoveDatabase } from '../src/db/db'
import { createLearningRepository } from '../src/db/repository'
import { demoMaterials } from '../src/content/materials'
import { createCloudState } from '../src/stores/cloud'
import { createJapaneseSpace } from '../src/stores/japanese-space'
import { createClient } from '@supabase/supabase-js'
import type { StoredOperation, SyncOperation } from '../src/sync/protocol'
import { japaneseMaterials } from '../src/content/japanese'
import { japaneseWrittenExercises } from '../src/content/japanese-reading'

const databases: JoveDatabase[] = [], states: ReturnType<typeof createJapaneseSpace>[] = []
const clouds: ReturnType<typeof createCloudState>[] = []
afterEach(async () => {
  for (const state of states.splice(0)) await state.stop()
  for (const cloud of clouds.splice(0)) await cloud.stop()
  for (const database of databases.splice(0)) await database.delete()
  vi.unstubAllGlobals()
})
async function setup() {
  const en = new JoveDatabase(`ja-space-en-${crypto.randomUUID()}`, 'en'), ja = new JoveDatabase(`ja-space-ja-${crypto.randomUUID()}`, 'ja')
  databases.push(en, ja); await createLearningRepository(en).initialize(demoMaterials)
  const account = { settle: vi.fn(async () => {}), signOut: vi.fn(async () => {}), ownerId: vi.fn(() => '') }, cloud = createCloudState(ja, null)
  const start = vi.spyOn(cloud, 'start'), pause = vi.spyOn(cloud, 'pause'), resume = vi.spyOn(cloud, 'resume')
  const state = createJapaneseSpace(en, account, ja, () => cloud)
  states.push(state)
  return { en, ja, account, cloud, start, pause, resume, state }
}

describe('shared-account Japanese lifecycle', () => {
  it('does not create Japanese merely from opening English', async () => {
    const { ja, state, start } = await setup(), refresh = vi.fn(async () => {})
    expect((await Dexie.getDatabaseNames()).includes(ja.name)).toBe(false)
    await state.startIfPresent(refresh)
    expect((await Dexie.getDatabaseNames()).includes(ja.name)).toBe(false); expect(start).not.toHaveBeenCalled()
    expect(state.status.value).toBe('Japanese not opened')
  })
  it('coalesces admission behind the existing account work without a second login', async () => {
    const { ja, state, account, start } = await setup()
    let release!: () => void
    account.settle.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const first = state.ensure(), second = state.ensure()
    await vi.waitFor(() => expect(account.settle).toHaveBeenCalledOnce())
    expect(start).not.toHaveBeenCalled()
    release(); await Promise.all([first, second])
    expect(start).toHaveBeenCalledOnce()
    expect((await ja.materials.toArray()).map(m => m.id).sort()).toEqual([...japaneseMaterials(), ...japaneseWrittenExercises].map(m => m.id).sort())
    expect(state.ready.value).toBe(true)
    expect(state.status.value).toBe('Saved on this device')
  })
  it('starts existing Japanese in the background and notifies recommendations after downloads', async () => {
    const { state, ja, start } = await setup(), refresh = vi.fn(async () => {})
    let afterDownload!: () => Promise<void>
    start.mockImplementation(async callback => { afterDownload = callback })
    await ja.open(); await state.startIfPresent(refresh)
    const revision = state.revision.value, calls = refresh.mock.calls.length
    await afterDownload()
    expect(state.revision.value).toBe(revision + 1); expect(refresh.mock.calls.length).toBe(calls + 1)
    // Page handle teardown does not close the background connection.
    const page = new JoveDatabase(ja.name, 'ja'); await page.open(); page.close()
    expect(ja.isOpen()).toBe(true)
  })
  it('rejects foreign-owner admission and rechecks an already opened space', async () => {
    const { en, ja, state } = await setup()
    await state.ensure()
    await en.syncMeta.put({ id: 'owner', value: 'different-account' })
    await expect(state.ensure()).rejects.toThrow('同一学习账号')
    expect(state.ready.value).toBe(false); expect(state.problem.value).toContain('同一学习账号')
    expect((await ja.syncMeta.get('owner'))?.value).toBeUndefined()
    expect(await ja.events.count()).toBe(0)
  })
  it('fences Japanese before shared sign-out, and resumes signed-out local status', async () => {
    const { state, account, pause, resume } = await setup(), order: string[] = []
    await state.ensure()
    pause.mockImplementation(async () => { order.push('pause-ja') })
    account.signOut.mockImplementation(async () => { order.push('shared-sign-out') })
    resume.mockImplementation(async () => { order.push('resume-ja') })
    await state.signOut()
    expect(order).toEqual(['pause-ja', 'shared-sign-out', 'resume-ja'])
  })
  it('cancels an initializer waiting on English before shared sign-out can start Japanese', async () => {
    const { state, account, start, pause } = await setup()
    let release!: () => void
    account.settle.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const opening = state.ensure(), failure = expect(opening).rejects.toThrow('初始化已取消')
    await vi.waitFor(() => expect(account.settle).toHaveBeenCalledOnce())
    const signingOut = state.signOut()
    expect(state.signingOut.value).toBe(true)
    await expect(state.ensure()).rejects.toThrow('正在登出')
    release(); await failure; await signingOut
    expect(pause).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled()
    expect(account.signOut).toHaveBeenCalledOnce(); expect(state.ready.value).toBe(false)
  })
  it('does not borrow English success for Japanese pending audio or errors', async () => {
    const { en, ja, account, cloud } = await setup()
    cloud.audioPending.value = true
    const separate = { ...cloud, configured: true, status: computed(() => cloud.problem.value ? 'Sync problem' : cloud.audioPending.value ? 'Syncing' : 'Synced') }
    const state = createJapaneseSpace(en, account, ja, () => separate); states.push(state)
    await state.ensure()
    expect(state.status.value).toBe('Syncing'); expect(state.audioPending.value).toBe(true)
    cloud.problem.value = 'Japanese recording transfer failed'
    expect(state.status.value).toBe('Sync problem'); expect(state.problem.value).toContain('Japanese recording')
  })
  it('uses the same authenticated SDK client but distinct English/Japanese RPC and journal streams', async () => {
    const { en, ja } = await setup(), owner = '00000000-0000-4000-8000-000000000051'
    let principal = owner
    const config = { url: 'https://jove-language-test.invalid', publishableKey: 'sb_publishable_fixture_only' }
    const streams = { en: new Map<string, StoredOperation>(), ja: new Map<string, StoredOperation>() }, paths: string[] = []
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input)), path = url.pathname
      paths.push(path)
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-only-owner-token')
      const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
      if (path.endsWith('/app_members')) return json([{ user_id: principal }])
      if (path.endsWith('/service_preferences')) return json([{ recording_retention: 'minimal' }])
      if (path.endsWith('/recording_manifest') || path.endsWith('/language_recording_manifest')) return json([])
      const language = path.includes('language_sync_operations') ? 'ja' : 'en', stream = streams[language]
      if (path.includes('/rpc/append_')) {
        const body = JSON.parse(String(init?.body)) as { learning_language?: string; operations: SyncOperation[] }
        if (language === 'ja') expect(body.learning_language).toBe('ja')
        return json(body.operations.map(op => {
          const row = stream.get(op.id) ?? { ...op, cursor: stream.size + 1, receivedAt: Date.now() }
          stream.set(op.id, row)
          return { id: row.id, cursor: row.cursor, received_at: new Date(row.receivedAt!).toISOString() }
        }))
      }
      if (path.endsWith('/sync_operations') || path.endsWith('/language_sync_operations')) {
        if (language === 'ja') expect(url.searchParams.get('learning_language')).toBe('eq.ja')
        return json([...stream.values()].filter(row => row.cursor! > Number(url.searchParams.get('cursor')?.slice(3) ?? 0)).map(row => ({
          id: row.id, device_id: row.deviceId, logical_clock: row.logicalClock, entity_type: row.entityType, entity_id: row.entityId,
          kind: row.kind, schema_version: row.schemaVersion, payload: row.payload, cursor: row.cursor, received_at: new Date(row.receivedAt!).toISOString(),
          ...(language === 'ja' ? { learning_language: 'ja' } : {}),
        })))
      }
      throw new Error(`Unexpected isolated fixture request: ${path}`)
    }
    vi.stubGlobal('fetch', transport)
    const client = createClient(config.url, config.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } })
    vi.spyOn(client.auth, 'getSession').mockImplementation(async () => ({ data: { session: { access_token: 'fixture-only-owner-token', user: { id: principal } } }, error: null }) as never)
    vi.spyOn(client.auth, 'getUser').mockImplementation(async () => ({ data: { user: { id: principal } }, error: null }) as never)
    vi.spyOn(client.auth, 'onAuthStateChange').mockReturnValue({ data: { subscription: { unsubscribe() {} } } } as never)
    const login = vi.spyOn(client.auth, 'signInWithOtp')
    const english = createCloudState(en, client, config); clouds.push(english)
    await english.start(async () => {})
    const japanese = createJapaneseSpace(en, { settle: english.settle, signOut: english.signOut, ownerId: () => english.userId.value }, ja,
      (database, guard) => createCloudState(database, client, config, guard)); states.push(japanese)
    await japanese.ensure()
    expect((await en.syncMeta.get('owner'))?.value).toBe(owner); expect((await ja.syncMeta.get('owner'))?.value).toBe(owner)
    expect(english.problem.value).toBe(''); expect(japanese.problem.value).toBe('')
    await ja.profiles.update('main', { goal: '独立日语目标' }); await japanese.syncNow()
    expect(paths).toContain('/rest/v1/rpc/append_language_sync_operations')
    expect(paths).toContain('/rest/v1/rpc/append_sync_operations')
    expect([...streams.ja.values()].some(row => row.entityType === 'profiles' && row.payload.record?.goal === '独立日语目标')).toBe(true)
    expect([...streams.en.values()].some(row => row.payload.record?.goal === '独立日语目标')).toBe(false)
    expect(login).not.toHaveBeenCalled()
    // SDK session changes before English has accepted it. The new user is also
    // a fixture member, so membership alone cannot protect the old workspace.
    principal = '00000000-0000-4000-8000-000000000052'
    const otherJa = new JoveDatabase(`ja-space-unbound-${crypto.randomUUID()}`, 'ja'); databases.push(otherJa)
    const rejected = createJapaneseSpace(en, { settle: english.settle, signOut: english.signOut, ownerId: () => english.userId.value }, otherJa,
      (database, guard) => createCloudState(database, client, config, guard)); states.push(rejected)
    const before = paths.filter(path => path.includes('append_language_sync_operations')).length
    await expect(rejected.ensure()).rejects.toThrow('同一学习账号')
    expect((await otherJa.syncMeta.get('owner'))?.value).toBeUndefined()
    expect(paths.filter(path => path.includes('append_language_sync_operations'))).toHaveLength(before)
  })
})
