import Dexie from 'dexie'
import { createLanguageDatabase, type JoveDatabase } from './db'
import { audioMetadataSchema } from './schema'
import type { AudioAsset } from '../domain/types'
import { languageDatabases } from '../domain/language'

export class AudioCapacityError extends Error {
  constructor() { super('The combined audio storage limit would be exceeded. Clear reusable caches or increase the audio limit in Settings; original recordings are kept.') }
}
export class AudioBudgetUnavailableError extends Error {}
export interface AudioBudget {
  assets: AudioAsset[]; peerBytes: number; usedBytes: number; limitBytes: number
  assertFits(incomingBytes: number, replacingId?: string): void
}

/** All new audio bytes enter through this gate. The origin lock covers BOTH
 * workspaces and tabs; the target transaction still guards owner/row updates.
 * Never hold an IndexedDB transaction open while acquiring a Web Lock or
 * reading another database. Network/recording work happens before this gate. */
export async function withAudioBudget<T>(database: JoveDatabase, write: (budget: AudioBudget) => Promise<T>, fallbackLimitMB = 200,
  assertCurrent?: () => Promise<void>): Promise<T> {
  if (Dexie.currentTransaction) throw new Error('Audio admission must start outside an existing transaction')
  const shared = database.name === languageDatabases.en || database.name === languageDatabases.ja
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  const admit = async () => {
    // Recheck a caller's auth/owner context AFTER waiting for another tab.
    // Its target-DB owner comparison must also live in the write transaction.
    await assertCurrent?.()
    let peerBytes = 0, sharedLimit: number | undefined
    if (shared) {
      const peerLanguage = database.language === 'en' ? 'ja' : 'en'
      const names = await Dexie.getDatabaseNames()
      if (names.includes(languageDatabases[peerLanguage])) {
        // No unsafe per-tab fallback for two-language writes on old browsers.
        if (!locks) throw new AudioBudgetUnavailableError('This browser cannot coordinate the shared audio budget. Update the browser; existing recordings remain available.')
        const peer = createLanguageDatabase(peerLanguage)
        try {
          await peer.transaction('r', [peer.audio, peer.settings], async () => {
            peerBytes = (await peer.audio.toArray()).reduce((sum, item) => sum + item.blob.size, 0)
            if (peerLanguage === 'en') sharedLimit = (await peer.settings.get('main'))?.value.audioLimitMB ?? fallbackLimitMB
          })
        } finally { peer.close() }
      } else if (database.language === 'ja') throw new AudioBudgetUnavailableError('Open the English workspace settings before saving Japanese audio; your captured recording is retained.')
    }
    return database.transaction('rw', [database.audio, database.settings, database.syncMeta], async () => {
      const assets = await database.audio.toArray(), usedBytes = peerBytes + assets.reduce((sum, item) => sum + item.blob.size, 0)
      const limitBytes = (sharedLimit ?? (await database.settings.get('main'))?.value.audioLimitMB ?? fallbackLimitMB) * 1024 * 1024
      if (!Number.isFinite(limitBytes) || limitBytes <= 0) throw new AudioCapacityError()
      return write({ assets, peerBytes, usedBytes, limitBytes, assertFits(incomingBytes, replacingId) {
        const replaced = assets.find(item => item.id === replacingId)?.blob.size ?? 0
        if (!Number.isFinite(incomingBytes) || incomingBytes < 0 || usedBytes - replaced + incomingBytes > limitBytes) throw new AudioCapacityError()
      } })
    })
  }
  return shared && locks ? locks.request('jove-language-os:audio-budget', { mode: 'exclusive' }, admit) : admit()
}

/** Preserve original bytes when changing a stored recording/cache's metadata.
 * WebKit can invalidate a file-backed Blob re-put over its own IndexedDB key.
 * Never rewrite unchanged audio; changed metadata gets independent bytes in
 * the same transaction. A failed or incomplete read rolls everything back. */
export function updateAudioMetadata(database: JoveDatabase, id: string, changes: Partial<Omit<AudioAsset, 'id' | 'blob'>>): Promise<number> {
  return database.transaction('rw', database.audio, async () => {
    const original = await database.audio.get(id)
    if (!original) return 0
    const { blob, ...metadata } = original
    const next = audioMetadataSchema.parse({ ...metadata, ...changes, id })
    if (Object.entries(next).every(([key, value]) => metadata[key as keyof typeof metadata] === value)) return 1
    const bytes = await Dexie.waitFor(blob.arrayBuffer(), 30_000)
    if (bytes.byteLength !== blob.size) throw new Error('Original recording bytes are incomplete. Local work has been retained.')
    await database.audio.put({ ...next, blob: new Blob([bytes], { type: blob.type }) })
    return 1
  })
}
