import Dexie from 'dexie'
import type { JoveDatabase } from './db'
import { audioMetadataSchema } from './schema'
import type { AudioAsset } from '../domain/types'

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
