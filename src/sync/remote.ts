import type { SupabaseClient } from '@supabase/supabase-js'
import { SyncJournal } from './journal'
import { parseOperation, type StoredOperation, type SyncOperation } from './protocol'
import { accountRequest, type SyncAccess } from './access'

export interface SyncRemote {
  upload(operations: SyncOperation[], owner: string): Promise<{ id: string; cursor: number; receivedAt: number }[]>
  download(cursor: number, owner: string): Promise<StoredOperation[]>
}
export class SupabaseSyncRemote implements SyncRemote {
  constructor(private client: SupabaseClient, private access?: SyncAccess) {
    // Even a caller accidentally passing the mutable SDK alongside an access
    // cannot bypass that access's fixed Authorization/transport guards.
    if (access) this.client = access.client
  }
  private async token(owner: string): Promise<string> {
    const { data, error } = await this.client.auth.getSession()
    const token = data.session?.access_token
    if (error || !token) throw new Error('Sign in to synchronize this account')
    await this.validatePrincipal(owner, token)
    return token
  }
  private async validatePrincipal(owner: string, token: string): Promise<void> {
    const user = await this.client.auth.getUser(token)
    if (user.error || user.data.user?.id !== owner) throw new Error('Sync account does not match this browser owner')
    await this.unchanged(token)
  }
  private async unchanged(token: string): Promise<void> {
    const { data, error } = await this.client.auth.getSession()
    if (error || data.session?.access_token !== token) throw new Error('Account changed during sync. Local work is safe; retry after signing in.')
  }
  async upload(operations: SyncOperation[], owner: string) {
    if (this.access && this.access.ownerId !== owner) throw new Error('Sync owner changed')
    const token = this.access ? undefined : await this.token(owner)
    // The SDK may switch/refresh its session between construction and fetch. Its
    // fetchWithAuth preserves an explicitly set header, binding this request to A.
    const query = () => this.client.rpc('append_sync_operations', { operations })
    const { data, error } = this.access ? await accountRequest(this.access, query) : await query().setHeader('Authorization', `Bearer ${token}`)
    if (token) { await this.unchanged(token); await this.validatePrincipal(owner, token) }
    if (error || !Array.isArray(data)) throw new Error('Could not upload learning records. Your local work is safe.')
    return data.map(row => ({ id: String(row.id), cursor: Number(row.cursor), receivedAt: Date.parse(row.received_at) }))
  }
  async download(cursor: number, owner: string): Promise<StoredOperation[]> {
    if (this.access && this.access.ownerId !== owner) throw new Error('Sync owner changed')
    const token = this.access ? undefined : await this.token(owner)
    const query = () => this.client.from('sync_operations')
      .select('id,device_id,logical_clock,entity_type,entity_id,kind,payload,schema_version,cursor,received_at')
      .gt('cursor', cursor).order('cursor', { ascending: true }).limit(500)
    const { data, error } = this.access ? await accountRequest(this.access, query) : await query().setHeader('Authorization', `Bearer ${token}`)
    if (token) { await this.unchanged(token); await this.validatePrincipal(owner, token) }
    if (error || !Array.isArray(data)) throw new Error('Could not download learning records. Your local work is safe.')
    return data.map(row => ({ ...parseOperation({ id: row.id, deviceId: row.device_id, logicalClock: Number(row.logical_clock),
      entityType: row.entity_type, entityId: row.entity_id, kind: row.kind, payload: row.payload, schemaVersion: row.schema_version }),
      cursor: Number(row.cursor), receivedAt: Date.parse(row.received_at) }))
  }
}

export const MAX_UPLOAD_BYTES = 3_500_000 // Below SQL's 4 MiB, including JSONB separators.
/** Conservative jsonb::text size, including exponent expansion and whitespace. */
export function jsonbBytes(value: unknown): number {
  if (typeof value === 'number') {
    const text = JSON.stringify(value), exponent = /e([+-]?\d+)$/i.exec(text)
    return exponent ? Math.max(text.length, text.split('e')[0]!.length + Math.abs(Number(exponent[1])) + 3) : text.length
  }
  if (Array.isArray(value)) return 2 + value.reduce((sum, item) => sum + jsonbBytes(item), 0) + Math.max(0, value.length - 1) * 2
  if (value && typeof value === 'object') {
    if (value instanceof Date) return jsonbBytes(value.toISOString())
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    return 2 + entries.reduce((sum, [key, item]) => sum + jsonbBytes(key) + 2 + jsonbBytes(item), 0) + Math.max(0, entries.length - 1) * 2
  }
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length
}
export function uploadBatch(pending: SyncOperation[]): SyncOperation[] {
  const result: SyncOperation[] = []
  let bytes = 2
  for (const op of pending.slice(0, 100)) {
    if (jsonbBytes(op.payload) > 1_048_576) throw new Error('A learning record exceeds the server limit. Its original is retained locally.')
    const size = jsonbBytes(op) + (result.length ? 2 : 0)
    if (bytes + size > MAX_UPLOAD_BYTES) break
    result.push(op); bytes += size
  }
  if (pending.length && !result.length) throw new Error('A learning record exceeds the upload limit. Its original is retained locally.')
  return result
}

/** Bounded batches are durable checkpoints; a failed request never discards pending work. */
export async function synchronize(journal: SyncJournal, remote: SyncRemote): Promise<{ pending: number; downloaded: number; hasMore: boolean; deferred: number; conflicts: number }> {
  await journal.capture()
  const owner = await journal.owner()
  let downloaded = 0
  let hasMore = true
  for (let batch = 0; batch < 20; batch++) {
    const pending = uploadBatch(await journal.pending())
    if (!pending.length) break
    if (await journal.owner() !== owner) throw new Error('Sync owner changed')
    const receipts = await remote.upload(pending, owner)
    if (await journal.owner() !== owner) throw new Error('Sync owner changed')
    if (receipts.length !== pending.length || new Set(receipts.map(row => row.id)).size !== pending.length
      || receipts.some(row => !pending.some(op => op.id === row.id))) throw new Error('Incomplete upload acknowledgement. Safe to retry.')
    await journal.acknowledge(receipts)
  }
  for (let page = 0; page < 20; page++) {
    if (await journal.owner() !== owner) throw new Error('Sync owner changed')
    const cursor = await journal.cursor(), rows = await remote.download(cursor, owner)
    if (await journal.owner() !== owner) throw new Error('Sync owner changed')
    if (!rows.length) { hasMore = false; break }
    if (rows.some((row, index) => !row.cursor || row.cursor <= (index ? rows[index - 1]!.cursor! : cursor))) throw new Error('Invalid sync cursor order')
    await journal.merge(rows, rows.at(-1)!.cursor!)
    downloaded += rows.length
  }
  await journal.capture()
  const deferred = ((await journal.database.syncMeta.get('deferred'))?.value ?? []) as unknown[]
  const conflicts = ((await journal.database.syncMeta.get('conflicts'))?.value ?? []) as unknown[]
  return { pending: await journal.pendingCount(), downloaded, hasMore, deferred: deferred.length, conflicts: conflicts.length }
}
