import { expect, type Page } from '@playwright/test'

/** Actual browser IndexedDB and multipart encoding; never a fake IDB/Blob.
 * Every database contains synthetic transport bytes only, and is deleted. */
export async function verifyNativeAudioJournal(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const nativeImport = new Function('path', 'return import(path)')
    const { JoveDatabase } = await nativeImport('/jove-english-os/src/db/db.ts')
    const { SyncJournal } = await nativeImport('/jove-english-os/src/sync/journal.ts')
    const { updateAudioMetadata } = await nativeImport('/jove-english-os/src/db/audio.ts')
    const hash = async (blob: Blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',')
    const results: { bytes: number; cycles: number; preserved: boolean }[] = []
    for (const [size, cycles] of [[8, 12], [65536, 6], [25 * 1024 * 1024, 2]]) {
      const database = new JoveDatabase('native-audio-regression-' + crypto.randomUUID())
      try {
        const journal = new SyncJournal(database), otherDevice = crypto.randomUUID()
        await journal.bindOwner(crypto.randomUUID())
        const bytes = new Uint8Array(size!), timestamp = Date.now()
        bytes[0] = 82; bytes[1] = 73; bytes[2] = 70; bytes[3] = 70; bytes[bytes.length - 1] = 4
        const original = new Blob([bytes], { type: 'audio/wav' }), expectedHash = await hash(original)
        await database.audio.add({ id: 'native-original', blob: original, mimeType: 'audio/wav', createdAt: timestamp,
          duration: 1, kind: 'recording', processed: false, label: 'Original fixture' })
        let cursor = 0
        const settle = async () => {
          await journal.capture()
          const pending = await journal.pending()
          const receipts = pending.map((op: Record<string, unknown>) => ({ ...op, cursor: ++cursor, receivedAt: Date.now() }))
          await journal.acknowledge(receipts.map(({ id, cursor, receivedAt }: { id: string; cursor: number; receivedAt: number }) => ({ id, cursor, receivedAt })))
          await journal.merge(receipts, cursor)
        }
        const verify = async () => {
          const asset = await database.audio.get('native-original')
          if (!(asset?.blob instanceof Blob) || asset.blob.size !== size || asset.blob.type !== original.type || await hash(asset.blob) !== expectedHash)
            throw new Error('Native recording bytes changed or became unreadable')
          const form = new FormData(); form.append('cacheControl', '3600'); form.append('', asset.blob)
          const decoded = await new Request('https://example.invalid/', { method: 'POST', body: form }).formData()
          const file = decoded.get('')
          if (!(file instanceof Blob) || await hash(file) !== expectedHash) throw new Error('Native multipart lost original recording bytes')
        }
        await settle(); await verify()
        for (let index = 0; index < cycles!; index++) {
          // Both local STT/cache metadata and real remote metadata changes must
          // persist; simply skipping all writes cannot make this test pass.
          await updateAudioMetadata(database, 'native-original', { processed: true, duration: index + 2 })
          await settle(); await verify()
          const { blob: ignored, ...metadata } = await database.audio.get('native-original')
          void ignored
          const logicalClock = Number((await database.syncMeta.get('clock'))?.value ?? 0) + 1
          await journal.merge([{ id: crypto.randomUUID(), deviceId: otherDevice, logicalClock, entityType: 'audioMetadata',
            entityId: 'native-original', kind: 'put', schemaVersion: 1,
            payload: { record: { ...metadata, label: 'Remote label ' + index }, changed: ['["label"]'] },
            cursor: ++cursor, receivedAt: Date.now() }], cursor)
          await verify()
          await journal.merge([], cursor); await verify()
          const actual = await database.audio.get('native-original')
          if (actual.label !== 'Remote label ' + index || actual.duration !== index + 2 || actual.processed !== true)
            throw new Error('Native recording metadata did not converge')
        }
        database.close(); await database.open(); await verify()
        results.push({ bytes: size!, cycles: cycles!, preserved: true })
      } finally { await database.delete() }
    }
    return results
  })
  expect(result).toEqual([{ bytes: 8, cycles: 12, preserved: true }, { bytes: 65536, cycles: 6, preserved: true }, { bytes: 26214400, cycles: 2, preserved: true }])
}
