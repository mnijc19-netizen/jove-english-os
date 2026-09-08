import type { JoveDatabase } from '../db/db'
import Dexie from 'dexie'
import { audioMetadataSchema } from '../db/schema'
import { updateAudioMetadata } from '../db/audio'
import { canonical, changedFields, compare, entitySchemas, entityTypes, eventOccurrenceKey, isPrivateAudio, parseOperation, projectOperations, stripReceipt, validateReceipt, withoutCacheAudioReferences, type EntityType, type RecordValue, type StoredOperation, type SyncOperation } from './protocol'
import { canonicalReviewCard, hasReviewAttemptIdentity, restoreReviewAttempt, type ReviewAttempt } from './review'

const keyFor = (type: EntityType, id: string) => JSON.stringify([type, id])
const localTable = (type: EntityType) => type === 'audioMetadata' ? 'audio' : type

/** Call inside repository transactions that include syncMeta. Legacy IDs remain
 * valid inputs; operation history and original evidence IDs are never rewritten. */
export async function resolveCardAlias(database: JoveDatabase, id: string): Promise<string> {
  const aliases = ((await database.syncMeta.get('cardAliases'))?.value ?? {}) as Record<string, string>
  const seen = new Set<string>()
  while (aliases[id] && aliases[id] !== id) {
    if (seen.has(id)) throw new Error('Invalid card alias cycle')
    seen.add(id); id = aliases[id]!
  }
  return id
}

/** A legacy counter can name several immutable occurrences. Callers must still
 * verify the actual event type/card/payload; an alias alone is not evidence. */
export async function resolveEventAliases(database: JoveDatabase, id: string): Promise<string[]> {
  const aliases = ((await database.syncMeta.get('eventAliases'))?.value ?? {}) as Record<string, string[]>
  return [...new Set([id, ...(aliases[id] ?? [])])]
}

/** Recover pre-upgrade blocks from their immutable items-field source, before
 * its original card IDs were normalized. Never pick an arbitrary alias draft. */
export async function resolveReviewAttempts(database: JoveDatabase, blockId: string, values: unknown[], aliases: Record<string, string>): Promise<ReviewAttempt[]> {
  let source = values
  if (values.some(value => !hasReviewAttemptIdentity(value))) {
    const excluded = new Set((await database.syncMeta.get('quarantinedOperations'))?.value as string[] | undefined)
    const operations = await database.syncOperations.where('entityType').equals('sessions').filter(op => op.entityId === blockId && !excluded.has(op.id)).toArray()
    const candidates = operations.filter(op => op.kind === 'put' && op.payload.changed?.includes('["draft","items"]')).sort(compare)
    const draft = candidates.at(-1)?.payload.record?.draft as Record<string, unknown> | undefined
    const oldItems = Array.isArray(draft?.items) ? draft.items : []
    if (oldItems.length === values.length && oldItems.length && oldItems.every((value, index) => {
      const old = restoreReviewAttempt(value), current = restoreReviewAttempt(values[index])
      return old && current && old.reps === current.reps && canonicalReviewCard(old.cardId, aliases) === canonicalReviewCard(current.cardId, aliases)
    })) source = oldItems
  }
  const result: ReviewAttempt[] = []
  for (const value of source) {
    const item = restoreReviewAttempt(value, aliases)
    if (!item) continue
    if (!hasReviewAttemptIdentity(value) && item.cardId === canonicalReviewCard(item.cardId, aliases) && (item.legacyCardIds?.length ?? 0) > 1) {
      // Even one remaining draft can belong to a different original selection.
      // Availability is not proof of ownership of this counter-shaped attempt.
      throw new Error('Legacy review selection has ambiguous original attempts. All drafts and recordings are retained; restore the original block history before continuing.')
    }
    result.push(item)
  }
  return result
}

/** Journal lives in the same database as learning data. No secret table is read. */
export class SyncJournal {
  constructor(readonly database: JoveDatabase) {}
  private tables() {
    return [...new Set([...entityTypes.map(localTable), 'skills', 'syncOperations', 'syncMeta', 'syncSnapshots'])].map(name => this.database.table(name))
  }
  async bindOwner(userId: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(userId)) throw new Error('Invalid account identity')
    await this.database.transaction('rw', this.tables(), async () => {
      const bound = await this.database.syncMeta.get('owner')
      if (bound && bound.value !== userId) throw new Error('This browser belongs to another learning account. Its data has been kept separate.')
      await this.database.syncMeta.put({ id: 'owner', value: userId })
      await this.initializeInTransaction()
    })
  }
  private async initializeInTransaction(): Promise<void> {
    if (!await this.database.syncMeta.get('deviceId')) await this.database.syncMeta.put({ id: 'deviceId', value: crypto.randomUUID() })
    if (!await this.database.syncMeta.get('initialized')) {
      const profile = await this.database.profiles.get('main')
      const hasLearning = profile?.onboarded || (await this.database.events.count()) > 0 || (await this.database.sessions.count()) > 0
      await this.captureInTransaction(!hasLearning)
      await this.database.syncMeta.put({ id: 'initialized', value: true })
    }
  }
  /** Preserve offline history before a local restore, without inventing an owner.
   * Upload still requires verified membership and bindOwner. */
  prepareLocal(): Promise<void> { return this.database.transaction('rw', this.tables(), () => this.initializeInTransaction()) }
  async owner(): Promise<string> {
    const value = (await this.database.syncMeta.get('owner'))?.value
    if (typeof value !== 'string') throw new Error('Sign in before synchronizing')
    return value
  }
  private async activeOperations(): Promise<StoredOperation[]> {
    const excluded = new Set((await this.database.syncMeta.get('quarantinedOperations'))?.value as string[] | undefined)
    return this.database.syncOperations.filter(op => !excluded.has(op.id)).toArray()
  }
  /** A damaged local counter is not authority. Preserve and reissue impossible pending
   * operations under new identities; acknowledged history can never be renumbered. */
  private async recoverClock(): Promise<number> {
    const operations = await this.activeOperations()
    let clock = 0
    for (const op of operations.filter(op => op.cursor !== undefined)) {
      validateReceipt(op)
      clock = Math.max(clock, op.logicalClock)
    }
    const quarantine = (await this.database.syncMeta.get('quarantinedOperations'))?.value as string[] | undefined ?? []
    for (const op of operations.filter(op => op.cursor === undefined).sort((a, b) => a.logicalClock - b.logicalClock || a.id.localeCompare(b.id, 'en'))) {
      if (op.logicalClock > clock + 1) {
        quarantine.push(op.id)
        await this.database.syncOperations.add(parseOperation({ ...stripReceipt(op), id: crypto.randomUUID(), logicalClock: ++clock }))
      } else clock = Math.max(clock, op.logicalClock)
    }
    await this.database.syncMeta.put({ id: 'quarantinedOperations', value: quarantine })
    return clock
  }
  private async records(type: EntityType): Promise<RecordValue[]> {
    const rows: RecordValue[] = await this.database.table(localTable(type)).toArray()
    const cacheIds = new Set((await this.database.audio.toArray()).filter(row => !isPrivateAudio(row.kind)).map(row => row.id))
    return rows.filter(row => type !== 'audioMetadata' || isPrivateAudio(row.kind)).map(source => {
      const row = withoutCacheAudioReferences(source, cacheIds)
      return type === 'settings'
      ? { ...row, value: Object.fromEntries(Object.entries(row.value as Record<string, unknown>).filter(([key]) => key !== 'recordingRetention')) }
      : type === 'audioMetadata'
      ? audioMetadataSchema.parse({ id: row.id, mimeType: row.mimeType, createdAt: row.createdAt, duration: row.duration, kind: row.kind, processed: row.processed, label: row.label })
      : entitySchemas[type].parse(row) as RecordValue
    })
  }
  private async captureInTransaction(skipNewDefaults = false, preserveMissing = false): Promise<number> {
    const deviceId = (await this.database.syncMeta.get('deviceId'))?.value
    if (typeof deviceId !== 'string') throw new Error('Sign in before synchronizing')
    let clock = await this.recoverClock(), count = 0
    const published = new Set((await this.activeOperations()).filter(op => op.kind === 'put').map(op => keyFor(op.entityType, op.entityId)))
    const eventKeys = ((await this.database.syncMeta.get('eventKeys'))?.value ?? {}) as Record<string, string>
    const snapshots = await this.database.syncSnapshots.toArray()
    const old = new Map(snapshots.map(row => [row.id, row]))
    const events = await this.database.events.toArray()
    for (const type of entityTypes) {
      const present = new Set<string>()
      for (const record of await this.records(type)) {
        const id = keyFor(type, record.id), previous = old.get(id)
        present.add(id)
        let changed = changedFields(previous?.record, record)
        if (!changed.length) continue
        if (!(skipNewDefaults && ['settings', 'profiles'].includes(type))) {
          if (!published.has(id)) changed = changedFields(undefined, record)
          const baseEventKeys = type === 'cards' && !previous
            ? await Dexie.waitFor(Promise.all(events.filter(event => event.type === 'review' && event.data?.cardId === record.id)
              .map(event => eventKeys[event.id] ?? eventOccurrenceKey(event as unknown as RecordValue)))) : undefined
          const op: SyncOperation = parseOperation({ id: crypto.randomUUID(), deviceId, logicalClock: ++clock, entityType: type,
            entityId: record.id, kind: 'put', schemaVersion: 1,
            payload: { record, changed, ...(baseEventKeys ? { baseEventKeys: [...new Set(baseEventKeys)] } : {}) } })
          await this.database.syncOperations.add(op)
          count++
        }
        await this.database.syncSnapshots.put({ id, entityType: type, entityId: record.id, record })
      }
      for (const previous of snapshots.filter(row => row.entityType === type && !present.has(row.id))) {
        // Events survive an old backup restore/reset locally; erasure is a separate account operation.
        if (type !== 'events' && !preserveMissing) {
          await this.database.syncOperations.add(parseOperation({ id: crypto.randomUUID(), deviceId, logicalClock: ++clock,
            entityType: type, entityId: previous.entityId, kind: 'delete', schemaVersion: 1, payload: {} }))
          count++
        }
        await this.database.syncSnapshots.delete(previous.id)
      }
    }
    await this.database.syncMeta.put({ id: 'clock', value: clock })
    return count
  }
  capture(): Promise<number> { return this.database.transaction('rw', this.tables(), () => this.captureInTransaction()) }
  /** A backup/local replacement is not an account deletion command. Preserve
   * absent source operations and rematerialize their union with imported edits. */
  async reconcileLocalReplacement(): Promise<void> {
    await this.database.transaction('rw', this.tables(), async () => {
      await this.captureInTransaction(false, true)
      await this.merge([], await this.cursor())
    })
  }
  async pending(limit = 100): Promise<SyncOperation[]> {
    return (await this.activeOperations()).filter(op => op.cursor === undefined)
      .sort((a, b) => a.logicalClock - b.logicalClock || a.id.localeCompare(b.id, 'en')).slice(0, limit).map(stripReceipt)
  }
  async pendingCount(): Promise<number> { return (await this.activeOperations()).filter(op => op.cursor === undefined).length }
  async cursor(): Promise<number> { return Number((await this.database.syncMeta.get('cursor'))?.value ?? 0) }
  async acknowledge(receipts: { id: string; cursor: number; receivedAt: number }[]): Promise<void> {
    await this.database.transaction('rw', this.database.syncOperations, async () => {
      for (const receipt of receipts) {
        if (!Number.isSafeInteger(receipt.cursor) || receipt.cursor < 1 || !Number.isFinite(receipt.receivedAt)) throw new Error('Invalid server receipt')
        const existing = await this.database.syncOperations.get(receipt.id)
        if (!existing) throw new Error('Unknown upload receipt')
        validateReceipt({ ...existing, ...receipt })
        if (existing.cursor !== undefined && (existing.cursor !== receipt.cursor || existing.receivedAt !== receipt.receivedAt)) throw new Error('Receipt identity collision')
        await this.database.syncOperations.put({ ...existing, ...receipt })
      }
    })
    // Upload acknowledgement never advances the download cursor: other devices may precede it.
  }
  async merge(download: StoredOperation[], nextCursor: number): Promise<void> {
    const parsed = download.map(raw => ({ ...parseOperation(stripReceipt(raw)), cursor: raw.cursor, receivedAt: raw.receivedAt }))
    parsed.forEach(validateReceipt)
    if (!Number.isSafeInteger(nextCursor) || nextCursor < 0 || parsed.some(op => !Number.isSafeInteger(op.cursor) || op.cursor! <= 0 || op.cursor! > nextCursor || !Number.isFinite(op.receivedAt))) throw new Error('Invalid download page')
    await this.database.transaction('rw', this.tables(), async () => {
      if (nextCursor < await this.cursor()) throw new Error('Stale download cursor')
      if (nextCursor !== parsed.reduce((max, op) => Math.max(max, op.cursor!), await this.cursor())) throw new Error('Download cursor exceeds received operations')
      // Capture writes made while the request was in flight, before applying any remote state.
      await this.captureInTransaction()
      for (const op of parsed) {
        const old = await this.database.syncOperations.get(op.id)
        if (old && canonical(stripReceipt(old)) !== canonical(stripReceipt(op))) throw new Error('Operation identity collision')
        if (old?.cursor !== undefined && (old.cursor !== op.cursor || old.receivedAt !== op.receivedAt)) throw new Error('Receipt identity collision')
        await this.database.syncOperations.put(op)
      }
      const operations = await this.activeOperations()
      const projection = await Dexie.waitFor(projectOperations(operations))
      // These rows are materialized aliases, not the immutable source operations.
      // Include old-client aliases when upgrading a journal without this metadata.
      const managedEvents = new Set([
        ...((await this.database.syncMeta.get('projectedEventIds'))?.value as string[] | undefined ?? []),
        ...(await this.database.syncSnapshots.where('entityType').equals('events').toArray()).map(row => row.entityId),
      ])
      for (const event of projection.records.events) managedEvents.delete(event.id)
      if (managedEvents.size) await this.database.events.bulkDelete([...managedEvents])
      const oldCardIds = Object.entries(projection.cardAliases).filter(([source, target]) => source !== target).map(([source]) => source)
      if (oldCardIds.length) await this.database.cards.bulkDelete(oldCardIds)
      for (const type of entityTypes) {
        const rows = projection.records[type]
        if (type !== 'audioMetadata') {
          for (const row of rows) {
            if (type === 'settings') {
              const mirror = (await this.database.settings.get('main'))?.value.recordingRetention
              const value = { ...(row.value as Record<string, unknown>) }
              delete value.recordingRetention
              if (mirror !== undefined) value.recordingRetention = mirror
              await this.database.table(type).put({ ...row, value })
            } else await this.database.table(type).put(row)
          }
          const removed = new Set(projection.tombstones.filter(op => op.entityType === type && !op.retained).map(op => op.entityId))
          for (const row of rows) removed.delete(row.id)
          if (removed.size) await this.database.table(type).bulkDelete([...removed])
        }
        // Cloud audio metadata is durable independently of downloading its private blob.
        if (type === 'audioMetadata') {
          await this.database.syncMeta.put({ id: 'remoteAudio', value: rows })
          for (const row of rows) {
            await updateAudioMetadata(this.database, row.id, audioMetadataSchema.parse(row))
          }
        }
      }
      await this.database.skills.bulkPut(projection.skills)
      // Derived changes are baselines, not fresh user edits to upload again.
      await this.database.syncSnapshots.clear()
      for (const type of entityTypes) {
        for (const row of await this.records(type)) await this.database.syncSnapshots.put({ id: keyFor(type, row.id), entityType: type, entityId: row.id, record: row })
      }
      await this.database.syncMeta.bulkPut([
        { id: 'cursor', value: nextCursor }, { id: 'conflicts', value: projection.conflicts },
        { id: 'eventKeys', value: projection.eventKeys }, { id: 'projectedEventIds', value: projection.records.events.map(event => event.id) },
        { id: 'eventAliases', value: projection.eventAliases },
        { id: 'cardAliases', value: projection.cardAliases },
        { id: 'tombstones', value: projection.tombstones }, { id: 'deferred', value: projection.deferred },
        { id: 'clock', value: operations.reduce((clock, op) => Math.max(clock, op.logicalClock), 0) },
      ])
    })
  }
}
