import type { JoveDatabase } from '../db/db'
import { audioMetadataSchema } from '../db/schema'
import type { AudioAsset } from '../domain/types'
import { accountRequest, type SyncAccess } from './access'
import { SyncJournal } from './journal'
import { isPrivateAudio } from './protocol'

export type RecordingRetention = 'minimal' | 'assessment-only' | 'more-history'
export interface AudioManifest {
  user_id: string; audio_id: string; object_path: string; sha256: string; bytes: number; mime_type: string;
  purpose: 'assessment' | 'pronunciation' | 'draft' | 'history' | 'import'; created_at: string; expires_at: string | null;
}
export interface AudioSyncResult { uploaded: number; downloaded: number; hasMore: boolean; blocked: number; retentionPending: boolean }
const bucket = 'jove-recordings', maxBytes = 25 * 1024 * 1024, day = 86400000
export async function audioHash(blob: Blob): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('')
}
export function referencedAudio(value: unknown, result = new Set<string>(), depth = 0): Set<string> {
  if (!value || typeof value !== 'object' || depth > 20) return result
  for (const [key, item] of Object.entries(value)) {
    if (/audio(?:ids?)?$/i.test(key)) {
      if (typeof item === 'string' && item) result.add(item)
      if (item && typeof item === 'object') for (const id of Object.values(item)) if (typeof id === 'string' && id) result.add(id)
    }
    if (typeof item === 'object') referencedAudio(item, result, depth + 1)
  }
  return result
}
export function retentionDecision(asset: Pick<AudioAsset, 'kind' | 'processed' | 'createdAt'>, policy: RecordingRetention,
  references: { active: boolean; assessment: boolean; pronunciation: boolean }, now: number): { purpose: AudioManifest['purpose']; expiresAt: number | null } | null {
  if (!isPrivateAudio(asset.kind)) return null
  if (!asset.processed || references.active) return { purpose: asset.kind === 'import' ? 'import' : 'draft', expiresAt: null }
  if (references.assessment) return { purpose: 'assessment', expiresAt: null }
  if (asset.kind === 'import') return { purpose: 'import', expiresAt: null }
  if (policy !== 'assessment-only' && references.pronunciation) return { purpose: 'pronunciation', expiresAt: asset.createdAt + 14 * day }
  if (policy === 'more-history' && asset.createdAt + 30 * day > now) return { purpose: 'history', expiresAt: asset.createdAt + 30 * day }
  return null
}
export async function readRecordingRetention(access: SyncAccess): Promise<RecordingRetention> {
  const { data, error } = await accountRequest(access, () => access.client.from('service_preferences')
    .select('recording_retention').eq('user_id', access.ownerId).maybeSingle())
  if (error) throw new Error('Could not read account recording preferences')
  const policy = data?.recording_retention ?? 'minimal'
  if (!['minimal', 'assessment-only', 'more-history'].includes(policy)) throw new Error('Invalid account recording preferences')
  return policy
}
function validateManifest(row: AudioManifest, owner: string): void {
  if (row.user_id !== owner || typeof row.audio_id !== 'string' || !row.audio_id || row.audio_id.length > 1000
    || typeof row.object_path !== 'string' || !row.object_path.startsWith(owner + '/') || row.object_path.split('/').some(part => part === '..' || part === '.')
    || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > maxBytes
    || typeof row.mime_type !== 'string' || !/^(audio|video)\//.test(row.mime_type)
    || !['assessment', 'pronunciation', 'draft', 'history', 'import'].includes(row.purpose)
    || !Number.isFinite(Date.parse(row.created_at)) || (row.expires_at !== null && !Number.isFinite(Date.parse(row.expires_at))))
    throw new Error('Invalid private recording metadata')
}
/** Requires a JWT-pinned access, never the mutable application SDK client. */
export async function uploadRecording(access: SyncAccess, asset: AudioAsset,
  decision: NonNullable<ReturnType<typeof retentionDecision>>): Promise<AudioManifest> {
  await access.assertCurrent()
  if (!isPrivateAudio(asset.kind)) throw new Error('Only private recordings and imports belong in recording sync')
  const { blob, ...metadata } = asset
  audioMetadataSchema.parse(metadata)
  if (!blob.size || blob.size > maxBytes) throw new Error('This recording exceeds the cloud audio limit. Your original stays on this device.')
  const sha256 = await audioHash(blob), owner = access.ownerId
  const path = owner + '/' + encodeURIComponent(asset.id) + '-' + sha256
  const lookup = () => access.client.from('recording_manifest').select('*').eq('user_id', owner).eq('audio_id', asset.id).maybeSingle()
  const { data: existing, error: lookupError } = await accountRequest(access, lookup)
  if (lookupError) throw new Error('Could not check recording sync status')
  if (existing) {
    validateManifest(existing as AudioManifest, owner)
    if (existing.sha256 !== sha256 || existing.bytes !== blob.size) throw new Error('A different original uses this recording ID. Neither copy was overwritten.')
    return existing as AudioManifest
  }
  const { error } = await accountRequest(access, () => access.client.storage.from(bucket).upload(path, blob, { upsert: false, contentType: asset.mimeType.split(';')[0] }))
  if (error) {
    const prior = await accountRequest(access, () => access.client.storage.from(bucket).download(path))
    if (prior.error || !prior.data || await audioHash(prior.data) !== sha256) throw new Error('Recording upload did not finish. The local original is safe.')
  }
  // New originals are protected until a complete metadata view reconciles retention.
  const manifest: AudioManifest = { user_id: owner, audio_id: asset.id, object_path: path, sha256, bytes: blob.size,
    mime_type: asset.mimeType, purpose: decision.purpose, created_at: new Date(asset.createdAt).toISOString(), expires_at: null }
  const saved = await accountRequest(access, () => access.client.from('recording_manifest').upsert(manifest, { onConflict: 'user_id,audio_id', ignoreDuplicates: true }))
  if (saved.error) throw new Error('Recording is uploaded but confirmation needs retry. The local original is safe.')
  const verified = await accountRequest(access, lookup)
  if (verified.error || !verified.data) throw new Error('Recording confirmation needs retry; original retained')
  validateManifest(verified.data as AudioManifest, owner)
  if (verified.data.sha256 !== sha256 || verified.data.bytes !== blob.size || verified.data.object_path !== path)
    throw new Error('Recording confirmation mismatch; original retained')
  return verified.data as AudioManifest
}
export async function downloadRecording(access: SyncAccess, manifest: AudioManifest,
  metadata: Omit<AudioAsset, 'blob'>): Promise<AudioAsset> {
  validateManifest(manifest, access.ownerId)
  if (!isPrivateAudio(metadata.kind)) throw new Error('Public audio caches do not belong in recording sync')
  if (metadata.id !== manifest.audio_id) throw new Error('Recording identity mismatch')
  const { data, error } = await accountRequest(access, () => access.client.storage.from(bucket).download(manifest.object_path))
  if (error || !data) throw new Error('This recording could not download yet. Retry when connected.')
  if (data.size !== manifest.bytes || await audioHash(data) !== manifest.sha256) throw new Error('Recording verification failed. No local recording was replaced.')
  await access.assertCurrent()
  return { ...audioMetadataSchema.parse(metadata), blob: data }
}

export async function synchronizeAudio(database: JoveDatabase, access: SyncAccess, policy: RecordingRetention): Promise<AudioSyncResult> {
  const result: AudioSyncResult = { uploaded: 0, downloaded: 0, hasMore: true, blocked: 0, retentionPending: false }
  const journal = new SyncJournal(database), owner = access.ownerId, journalCursor = await journal.cursor()
  if (await journal.owner() !== owner) throw new Error('Sync owner changed')
  await access.assertCurrent()
  const [assets, events, sessions, assessments, conversations] = await Promise.all([database.audio.toArray(), database.events.toArray(), database.sessions.toArray(), database.assessments.toArray(), database.conversations.toArray()])
  const active = referencedAudio([...sessions.filter(row => !row.completedAt), ...conversations.filter(row => !row.completedAt)])
  const assessmentIds = new Set(assessments.map(item => item.id)), assessmentAudio = referencedAudio(assessments), pronunciationAudio = new Set<string>()
  for (const event of events) {
    if (event.sessionId && assessmentIds.has(event.sessionId)) referencedAudio(event.data, assessmentAudio)
    if (event.source === 'acoustic') referencedAudio(event.data, pronunciationAudio)
  }
  const now = Date.now(), remoteMetadata = ((await database.syncMeta.get('remoteAudio'))?.value ?? []) as Omit<AudioAsset, 'blob'>[]
  // Projected metadata wins over a downloaded blob's stale processed flag.
  const metadata = new Map([...assets, ...remoteMetadata].map(asset => [asset.id, asset]))
  const decisionFor = (asset: Omit<AudioAsset, 'blob'>) => retentionDecision(asset, policy, {
    active: active.has(asset.id), assessment: assessmentAudio.has(asset.id), pronunciation: pronunciationAudio.has(asset.id),
  }, now)
  for (const asset of assets) {
    const decision = decisionFor(metadata.get(asset.id) ?? asset)
    if (decision && (decision.expiresAt === null || decision.expiresAt > now)) { await uploadRecording(access, asset, decision); result.uploaded++ }
  }
  const manifests: AudioManifest[] = []
  let after = ''
  for (;;) {
    const response = await accountRequest(access, () => access.client.from('recording_manifest').select('*').eq('user_id', owner)
      .gt('audio_id', after).order('audio_id', { ascending: true }).limit(500))
    if (response.error || !Array.isArray(response.data)) throw new Error('Could not synchronize recording history')
    if (!response.data.length) { result.hasMore = false; break }
    for (const row of response.data as AudioManifest[]) { validateManifest(row, owner); if (row.audio_id <= after) throw new Error('Invalid recording page order'); after = row.audio_id; manifests.push(row) }
  }
  for (const row of manifests) {
    const meta = metadata.get(row.audio_id)
    if (!meta) { result.blocked++; continue }
    if (!isPrivateAudio(meta.kind)) continue
    const local = await database.audio.get(row.audio_id)
    if (local) {
      if (local.blob.size !== row.bytes || await audioHash(local.blob) !== row.sha256) { result.blocked++; continue }
    } else if (!row.expires_at || Date.parse(row.expires_at) > now) {
      const asset = await downloadRecording(access, row, meta)
      await access.assertCurrent()
      const added = await database.transaction('rw', database.audio, database.settings, database.syncMeta, async () => {
        if ((await database.syncMeta.get('owner'))?.value !== owner) throw new Error('Sync owner changed')
        if (await database.audio.get(asset.id)) return false
        const bytes = (await database.audio.toArray()).reduce((sum, item) => sum + item.blob.size, 0)
        const limit = ((await database.settings.get('main'))?.value.audioLimitMB ?? 200) * 1024 * 1024
        if (bytes + asset.blob.size > limit) return false
        await database.audio.add(asset)
        return true
      })
      if (added) result.downloaded++
      else { result.blocked++; continue }
    }
    if (result.hasMore) { result.retentionPending = true; continue }
    await journal.capture()
    if ((await journal.pending()).length) { result.retentionPending = true; continue }
    const decision = decisionFor(meta), purpose = decision?.purpose ?? 'history'
    // Fixed grace anchored to original creation, never renewed on every sync.
    const expiry = decision ? decision.expiresAt : Date.parse(row.created_at) + 7 * day
    const expiresAt = expiry === null ? null : new Date(expiry).toISOString()
    if (row.purpose === purpose && (row.expires_at === null ? expiresAt === null : expiresAt !== null && Date.parse(row.expires_at) === expiry)) continue
    const updated = await accountRequest(access, () => access.client.rpc('reconcile_recording_retention', {
      recording_id: row.audio_id, expected_cursor: journalCursor, retention_purpose: purpose, retention_expires_at: expiresAt,
      expected_policy: policy,
    }))
    if (updated.error) throw new Error('Could not update recording retention. Originals remain safe.')
    if (updated.data !== true) result.retentionPending = true
  }
  await access.assertCurrent()
  return result
}
