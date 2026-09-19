import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLanguageDatabase, type JoveDatabase } from '../src/db/db'
import { AudioCapacityError, withAudioBudget } from '../src/db/audio'
import { defaultSettings, type AudioAsset } from '../src/domain/types'
import { languageDatabases } from '../src/domain/language'

let en: JoveDatabase, ja: JoveDatabase
const mib = 1024 * 1024
const asset = (id: string, bytes: number, kind: AudioAsset['kind'] = 'recording'): AudioAsset => ({ id, blob: new Blob([new Uint8Array(bytes)]),
  createdAt: 1, duration: 1, kind, processed: false, mimeType: 'audio/wav', label: 'Fixture' })
beforeEach(() => {
  en = createLanguageDatabase('en'); ja = createLanguageDatabase('ja')
  let tail = Promise.resolve()
  vi.stubGlobal('navigator', { locks: { request: vi.fn((_name, _options, callback) => {
    const next = tail.then(callback); tail = next.then(() => {}, () => {}); return next
  }) } })
})
afterEach(async () => { await en.delete(); await ja.delete(); vi.unstubAllGlobals() })
async function configure(bytes = 10) {
  await en.settings.put({ id: 'main', value: { ...defaultSettings, audioLimitMB: bytes / mib } })
  await ja.settings.put({ id: 'main', value: { ...defaultSettings, audioLimitMB: 200 } })
}
async function save(database: typeof en, value: AudioAsset) {
  return withAudioBudget(database, async budget => { budget.assertFits(value.blob.size, value.id); await database.audio.put(value) })
}

describe('one audio allowance for two language databases', () => {
  it('counts both languages and all kinds against the persisted English setting without deducting an equal peer ID', async () => {
    await configure()
    await en.audio.bulkPut([asset('same-id', 4), asset('cache', 2, 'generated')])
    await ja.audio.put(asset('same-id', 2, 'import'))
    await save(ja, asset('same-id', 4, 'import'))
    await expect(save(ja, asset('same-id', 5, 'import'))).rejects.toBeInstanceOf(AudioCapacityError)
    expect((await ja.audio.get('same-id'))?.blob.size).toBe(4)
    expect((await en.audio.get('same-id'))?.blob.size).toBe(4)
    expect(await en.audio.count()).toBe(2)
  })
  it('serializes simultaneous cross-language saves so only one can spend the remaining space', async () => {
    await configure()
    await en.audio.put(asset('old', 4))
    const results = await Promise.allSettled([save(en, asset('new-en', 4)), save(ja, asset('new-ja', 4))])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((await en.audio.toArray()).concat(await ja.audio.toArray()).reduce((n, row) => n + row.blob.size, 0)).toBe(8)
    expect((await en.audio.get('old'))?.blob.size).toBe(4)
  })
  it('does not create the Japanese database just by using English or checking capacity', async () => {
    await en.settings.put({ id: 'main', value: { ...defaultSettings, audioLimitMB: 10 / mib } })
    await save(en, asset('english', 3))
    expect(await Dexie.getDatabaseNames()).not.toContain(languageDatabases.ja)
    expect(navigator.locks.request).toHaveBeenCalledWith('jove-language-os:audio-budget', { mode: 'exclusive' }, expect.any(Function))
  })
  it('fails closed for two-language writes without Web Locks, preserving originals', async () => {
    await configure(); await en.audio.put(asset('original', 4))
    vi.stubGlobal('navigator', {})
    await expect(save(ja, asset('new', 1))).rejects.toThrow('cannot coordinate')
    await expect(save(en, asset('new', 1))).rejects.toThrow('cannot coordinate')
    expect(await ja.audio.count()).toBe(0); expect(await en.audio.count()).toBe(1)
  })
  it('retains single-language transactional saves without Web Locks and refuses a missing English budget for Japanese', async () => {
    vi.stubGlobal('navigator', {})
    await save(en, asset('legacy', 3)); expect(await en.audio.count()).toBe(1)
    await en.delete()
    await expect(save(ja, asset('orphan', 1))).rejects.toThrow('Open the English workspace')
    expect(await Dexie.getDatabaseNames()).not.toContain(languageDatabases.en)
  })
  it('releases the origin gate and rolls back a failed target write, without losing capacity or an original', async () => {
    await configure(); await en.audio.put(asset('original', 4))
    await expect(withAudioBudget(ja, async budget => {
      budget.assertFits(3); await ja.audio.put(asset('failed', 3)); throw new Error('Owner changed')
    })).rejects.toThrow('Owner changed')
    await save(en, asset('after-failure', 6))
    expect(await ja.audio.count()).toBe(0)
    expect((await en.audio.get('original'))?.blob.size).toBe(4)
  })
  it('rechecks the context only after acquiring the queued native-lock boundary', async () => {
    await configure()
    let enter!: () => void, owner = 'owner-a'
    vi.stubGlobal('navigator', { locks: { request: vi.fn((_name, _options, callback) => new Promise(resolve => {
      enter = () => resolve(callback())
    })) } })
    const write = vi.fn(async () => {}), current = vi.fn(async () => { if (owner !== 'owner-a') throw new Error('Owner changed') })
    const pending = withAudioBudget(ja, write, 200, current)
    const rejection = expect(pending).rejects.toThrow('Owner changed')
    expect(current).not.toHaveBeenCalled()
    owner = 'owner-b'; enter()
    await rejection
    expect(current).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled()
  })
})
