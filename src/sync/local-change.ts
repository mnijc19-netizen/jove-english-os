import Dexie from 'dexie'
import type { JoveDatabase } from '../db/db'
import { SyncJournal } from './journal'
import { canonical, isPrivateAudio } from './protocol'

async function digest(blob: Blob): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',')
}

/** A Settings callback may touch local learner tables, never erase the account's
 * identity/history or private originals. All validation and changes share one
 * transaction, so an unsafe old reset implementation rolls back in its entirety.
 * The callback must contain database work only, not HTTP/UI refresh operations. */
export async function protectedLocalChange<T>(database: JoveDatabase, change: () => Promise<T>): Promise<T> {
  return database.transaction('rw', database.tables, async () => {
    const journal = new SyncJournal(database)
    await journal.prepareLocal()
    await journal.capture()
    const owner = (await database.syncMeta.get('owner'))?.value
    const mirroredPolicy = (await database.settings.get('main'))?.value.recordingRetention
    const [meta, operations, snapshots, audio] = await Promise.all([
      database.syncMeta.toArray(), database.syncOperations.toArray(), database.syncSnapshots.toArray(),
      database.audio.filter(asset => isPrivateAudio(asset.kind)).toArray(),
    ])
    const result = await change()
    const [nextMeta, nextOperations, nextSnapshots, nextAudio] = await Promise.all([
      database.syncMeta.toArray(), database.syncOperations.toArray(), database.syncSnapshots.toArray(),
      database.audio.bulkGet(audio.map(asset => asset.id)),
    ])
    if (canonical(meta) !== canonical(nextMeta) || canonical(operations) !== canonical(nextOperations)
      || canonical(snapshots) !== canonical(nextSnapshots))
      throw new Error('Local changes cannot erase or alter the learning account or its sync history. Nothing was changed.')
    if (owner) {
      // An offline backup cannot impersonate a successful server preference change.
      const setting = await database.settings.get('main')
      if (setting) {
        delete setting.value.recordingRetention
        if (mirroredPolicy !== undefined) setting.value.recordingRetention = mirroredPolicy
        await database.settings.put(setting)
      }
    }
    for (let index = 0; index < audio.length; index++) {
      const original = audio[index]!, next = nextAudio[index]
      if (!next || next.kind !== original.kind || next.mimeType !== original.mimeType || next.createdAt !== original.createdAt
        || next.blob.size !== original.blob.size
        || await Dexie.waitFor(digest(next.blob)) !== await Dexie.waitFor(digest(original.blob)))
        throw new Error('Local changes cannot erase or replace private recording originals. Nothing was changed.')
    }
    await journal.reconcileLocalReplacement()
    return result
  })
}

/** Explicit Settings reset allowlist. Learning, preferences, private recordings
 * and sync tables are intentionally outside this operation. */
export async function resetDeviceCacheAndKey(database: JoveDatabase): Promise<void> {
  await database.transaction('rw', database.secrets, database.audio, async () => {
    await database.secrets.clear()
    await database.audio.filter(asset => asset.kind === 'generated' || asset.kind === 'content-cache').delete()
  })
}
