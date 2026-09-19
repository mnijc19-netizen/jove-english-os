import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { JoveDatabase, version1Stores, DB_NAME, createLanguageDatabase } from '../src/db/db'
import { defaultProfile, type AudioAsset, type StudyEvent } from '../src/domain/types'
import { type LearningLanguage } from '../src/domain/language'
import { exportBackup, restoreBackup } from '../src/db/repository'
import { parseBackup } from '../src/db/schema'
import { SyncJournal } from '../src/sync/journal'
import { SupabaseSyncRemote, synchronize, type SyncRemote } from '../src/sync/remote'
import { type StoredOperation, type SyncOperation } from '../src/sync/protocol'
import { uploadRecording, downloadRecording, synchronizeAudio, type AudioManifest } from '../src/sync/audio'

const owner = '00000000-0000-4000-8000-000000000091'
const databases: JoveDatabase[] = []
const event = (score: number): StudyEvent => ({ id: 'same-event', type: 'fixture-language-evidence', timestamp: 1789819200000,
  source: 'text', skill: 'reading', score })
function database(language: LearningLanguage, name = `language-test-${crypto.randomUUID()}`) {
  const db = new JoveDatabase(name, language); databases.push(db); return db
}
afterEach(async () => { for (const db of databases.splice(0)) await db.delete() })

class MemoryRemote implements SyncRemote {
  rows: StoredOperation[] = []
  constructor(readonly language: LearningLanguage) {}
  async upload(operations: SyncOperation[]) {
    return operations.map(op => {
      let saved = this.rows.find(row => row.id === op.id)
      if (!saved) { saved = { ...structuredClone(op), cursor: this.rows.length + 1, receivedAt: Date.now() }; this.rows.push(saved) }
      return { id: saved.id, cursor: saved.cursor!, receivedAt: saved.receivedAt! }
    })
  }
  async download(cursor: number) { return structuredClone(this.rows.filter(row => row.cursor! > cursor)) }
}

describe('immutable local learning-language partitions', () => {
  it('keeps canonical English identity and reserves a different Japanese name', () => {
    expect(DB_NAME).toBe('jove-english-os')
    const en = createLanguageDatabase('en'), ja = createLanguageDatabase('ja')
    expect(en.name).toBe(DB_NAME); expect(ja.name).toBe('jove-english-os-ja')
    en.close(); ja.close() // Do not open/delete the canonical user databases.
    expect(() => new JoveDatabase(DB_NAME, 'ja')).toThrow('another learning language')
    expect(() => new JoveDatabase('jove-english-os-ja', 'en')).toThrow('another learning language')
  })
  it('opens a legacy English database without renaming its IDs or losing evidence', async () => {
    const name = `language-test-${crypto.randomUUID()}`, legacy = new Dexie(name)
    legacy.version(1).stores(version1Stores)
    await legacy.table('profiles').put({ ...defaultProfile(), onboarded: true })
    await legacy.table('events').put(event(0.7)); legacy.close()
    const en = database('en', name)
    expect((await en.profiles.get('main'))?.onboarded).toBe(true)
    expect((await en.events.get('same-event'))?.score).toBe(0.7)
    expect((await en.syncMeta.get('learningLanguage'))?.value).toBe('en')
  })
  it('rejects relabelling on reopen and leaves the original records intact', async () => {
    const en = database('en')
    await en.events.put(event(0.8)); en.close()
    const wrong = database('ja', en.name)
    await expect(wrong.open()).rejects.toThrow('binding mismatch')
    wrong.close()
    await en.open()
    expect(await en.events.get('same-event')).toEqual(event(0.8))
  })
  it('rejects an unlabelled old database instead of adopting its English data as Japanese', async () => {
    const name = `language-test-${crypto.randomUUID()}`, legacy = new Dexie(name)
    legacy.version(1).stores(version1Stores)
    await legacy.table('profiles').put(defaultProfile()); legacy.close()
    const wrong = database('ja', name)
    await expect(wrong.open()).rejects.toThrow('Unlabelled existing data')
  })
  it('merges a Japanese offline device while equal English IDs and scores remain independent', async () => {
    const en = database('en'), ja = database('ja'), other = database('ja')
    for (const db of [en, ja, other]) await db.profiles.put({ ...defaultProfile(), onboarded: true })
    await en.events.put(event(0.9)); await ja.events.put(event(0.2))
    const english = new MemoryRemote('en'), japanese = new MemoryRemote('ja')
    for (const [db, remote] of [[en, english], [ja, japanese], [other, japanese]] as const) {
      const journal = new SyncJournal(db); await journal.bindOwner(owner); await synchronize(journal, remote)
    }
    expect((await en.events.get('same-event'))?.score).toBe(0.9)
    expect((await other.events.get('same-event'))?.score).toBe(0.2)
    expect(await other.skills.toArray()).toEqual(await ja.skills.toArray())
    expect(await other.skills.toArray()).not.toEqual(await en.skills.toArray())
    await expect(new SyncJournal(other).bindOwner('00000000-0000-4000-8000-000000000092')).rejects.toThrow('another learning account')
  })
  it('rejects a wrong-language remote before capturing or transmitting local work', async () => {
    const ja = database('ja'), journal = new SyncJournal(ja), remote = new MemoryRemote('en')
    const capture = vi.spyOn(journal, 'capture'), upload = vi.spyOn(remote, 'upload')
    await expect(synchronize(journal, remote)).rejects.toThrow('Sync language')
    expect(capture).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled()
  })
  it('exports explicit Japanese backups and rejects both cross-language restore directions atomically', async () => {
    const en = database('en'), ja = database('ja'), restored = database('ja')
    await en.profiles.put({ ...defaultProfile(), goal: 'English only' })
    await ja.profiles.put({ ...defaultProfile(), goal: 'Japanese only' }); await ja.events.put(event(0.4))
    const english = await exportBackup(en), japanese = await exportBackup(ja)
    expect(parseBackup(JSON.parse(english)).schemaVersion).toBe(2)
    expect(JSON.parse(english)).not.toHaveProperty('learningLanguage')
    expect(parseBackup(JSON.parse(japanese))).toMatchObject({ schemaVersion: 3, learningLanguage: 'ja' })
    await expect(restoreBackup(japanese, en)).rejects.toThrow('another learning language')
    await expect(restoreBackup(english, ja)).rejects.toThrow('another learning language')
    expect((await en.profiles.get('main'))?.goal).toBe('English only')
    expect((await ja.profiles.get('main'))?.goal).toBe('Japanese only')
    await restoreBackup(japanese, restored)
    expect(await restored.events.get('same-event')).toEqual(event(0.4))
    expect((await restored.profiles.get('main'))?.goal).toBe('Japanese only')
  })
})

function recordingTransport() {
  const manifests = new Map<string, AudioManifest>(), objects = new Map<string, Blob>(), requests: string[] = []
  const client = createClient('https://project.example', 'public-fixture', { auth: { persistSession: false }, global: {
    fetch: async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? 'GET'
      requests.push(url.pathname)
      const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
      if (url.pathname.includes('/storage/v1/object/')) {
        const path = decodeURIComponent(url.pathname.split('/jove-recordings/')[1]!)
        if (method === 'POST') { objects.set(path, (init!.body as FormData).get('') as Blob); return json({ Key: path }) }
        return objects.has(path) ? new Response(objects.get(path)) : new Response('missing', { status: 404 })
      }
      const table = url.pathname.split('/').at(-1)!
      if (table === 'recording_manifest' || table === 'language_recording_manifest') {
        if (method === 'POST') {
          const row = JSON.parse(String(init?.body)) as AudioManifest
          manifests.set(`${table}:${row.audio_id}`, row); return json(null)
        }
        const filter = url.searchParams.get('audio_id') ?? ''
        return json([...manifests.entries()].filter(([key, row]) => key.startsWith(table + ':')
          && (filter.startsWith('eq.') ? row.audio_id === filter.slice(3) : row.audio_id > filter.slice(3))).map(([, row]) => row))
      }
      if (table === 'reconcile_language_recording_retention') return json(true)
      throw new Error('Unexpected recording transport route')
    },
  } })
  return { access: { ownerId: owner, client, assertCurrent: async () => {} }, manifests, objects, requests }
}
const original = (text: string): AudioAsset => ({ id: 'same-audio', blob: new Blob([text], { type: 'audio/wav' }),
  mimeType: 'audio/wav', duration: 1, createdAt: 1789819200000, kind: 'recording', processed: false, label: 'Original fixture' })

describe('separate private recording originals with shared account access', () => {
  it('retains different English/Japanese bytes with equal IDs and rejects wrong-language downloads', async () => {
    const fixture = recordingTransport(), en = original('English original'), ja = original('Japanese original')
    const decision = { purpose: 'draft' as const, expiresAt: null }
    const english = await uploadRecording(fixture.access, en, decision)
    const japanese = await uploadRecording(fixture.access, ja, decision, 'ja')
    expect(english.object_path).not.toBe(japanese.object_path)
    expect(japanese.object_path).toContain(owner + '/ja/')
    expect(fixture.manifests.size).toBe(2); expect(fixture.objects.size).toBe(2)
    const { blob, ...metadata } = ja
    expect(await (await downloadRecording(fixture.access, japanese, metadata, 'ja')).blob.text()).toBe(await blob.text())
    const before = fixture.requests.length
    await expect(downloadRecording(fixture.access, japanese, metadata)).rejects.toThrow('another learning language')
    await expect(downloadRecording(fixture.access, english, metadata, 'ja')).rejects.toThrow('another learning language')
    for (const path of ['%2e%2e/english-original', '%252e%252e%252fenglish-original', '..\\english-original']) {
      await expect(downloadRecording(fixture.access, { ...japanese, object_path: `${owner}/ja/${path}` }, metadata, 'ja')).rejects.toThrow()
    }
    await expect(uploadRecording(fixture.access, { ...ja, id: '../other-language' }, decision, 'ja')).rejects.toThrow('Unsafe recording')
    expect(fixture.requests.length).toBe(before)
  })
  it('synchronizes Japanese recording bytes without touching English manifest or retention routes', async () => {
    const fixture = recordingTransport(), ja = database('ja'), asset = original('Japanese retained recording')
    const journal = new SyncJournal(ja)
    await journal.bindOwner(owner); await ja.audio.put(asset)
    await synchronize(journal, new MemoryRemote('ja'))
    const result = await synchronizeAudio(ja, fixture.access, 'minimal')
    expect(result).toMatchObject({ uploaded: 1, blocked: 0, hasMore: false })
    expect(fixture.manifests.get('language_recording_manifest:same-audio')?.expires_at).toBeNull()
    expect(fixture.requests.some(path => path.endsWith('/recording_manifest') || path.endsWith('/reconcile_recording_retention'))).toBe(false)
    expect(await (await ja.audio.get(asset.id))!.blob.text()).toBe('Japanese retained recording')
  })
})

describe('language-bound actual Supabase SDK requests', () => {
  it.each(['en', 'ja'] as const)('sends %s only to its compatible stream contract', async language => {
    const requests: { url: URL; body: unknown }[] = []
    const client = createClient('https://project.example', 'public-fixture', { auth: { persistSession: false }, global: {
      fetch: async (input, init) => {
        requests.push({ url: new URL(String(input)), body: init?.body ? JSON.parse(String(init.body)) : undefined })
        return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
      },
    } })
    const remote = new SupabaseSyncRemote(client, { ownerId: owner, client, assertCurrent: async () => {} }, language)
    await remote.upload([], owner); await remote.download(0, owner)
    expect(requests[0]?.url.pathname).toBe(`/rest/v1/rpc/${language === 'en' ? 'append_sync_operations' : 'append_language_sync_operations'}`)
    expect(requests[0]?.body).toEqual(language === 'en' ? { operations: [] } : { operations: [], learning_language: 'ja' })
    expect(requests[1]?.url.pathname).toBe(`/rest/v1/${language === 'en' ? 'sync_operations' : 'language_sync_operations'}`)
    expect(requests[1]?.url.searchParams.get('learning_language')).toBe(language === 'ja' ? 'eq.ja' : null)
  })
  it('rejects a mislabeled download before merge', async () => {
    const client = createClient('https://project.example', 'public-fixture', { auth: { persistSession: false }, global: {
      fetch: async () => new Response(JSON.stringify([{ learning_language: 'en' }]), { headers: { 'Content-Type': 'application/json' } }),
    } })
    const remote = new SupabaseSyncRemote(client, { ownerId: owner, client, assertCurrent: async () => {} }, 'ja')
    await expect(remote.download(0, owner)).rejects.toThrow('another language')
  })
})
