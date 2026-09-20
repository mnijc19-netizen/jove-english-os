import type { JoveDatabase } from '../db/db'
import { audioMetadataSchema } from '../db/schema'
import { withAudioBudget } from '../db/audio'
import type { AudioAsset } from '../domain/types'
import { accountRequest, type SyncAccess } from './access'
import { SyncJournal } from './journal'
import { isPrivateAudio } from './protocol'
import { assertLearningLanguage, type LearningLanguage } from '../domain/language'

export type RecordingRetention = 'minimal' | 'assessment-only' | 'more-history'
export interface AudioManifest {
  learning_language?: 'ja'
  retention_cursor?: number | null; retention_policy?: RecordingRetention | null;
  cleanup_version?: string | null; recovery_pending?: boolean;
  user_id: string; audio_id: string; object_path: string; sha256: string; bytes: number; mime_type: string;
  purpose: 'assessment' | 'pronunciation' | 'draft' | 'history' | 'import'; created_at: string; expires_at: string | null;
}
export interface AudioSyncResult { uploaded: number; downloaded: number; hasMore: boolean; blocked: number; retentionPending: boolean }
export class CloudRecordingCapacityError extends Error {
  constructor() {
    super('Shared cloud recording storage is full. Your original stays on this device; free cloud space before retrying.')
    this.name = 'CloudRecordingCapacityError'
  }
}
export class CloudRecordingMissingError extends Error {
  constructor() {
    super('This cloud recording is missing. Sync the device with its original to recover it; other work can still synchronize.')
    this.name = 'CloudRecordingMissingError'
  }
}
const bucket = 'jove-recordings', maxBytes = 25 * 1024 * 1024, day = 86400000
function isMissingObject(error: unknown): boolean {
  return !!error && typeof error === 'object' && (('code' in error && error.code === 'NoSuchKey')
    || ('statusCode' in error && error.statusCode === 'NoSuchKey'))
}
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
const manifestTable = (language: LearningLanguage) => language === 'en' ? 'recording_manifest' : 'language_recording_manifest'
function recordingPath(owner: string, id: string, hash: string, language: LearningLanguage): string {
  if (language === 'ja' && (/[%/\\]/u.test(id) || [...id].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)))
    throw new Error('Unsafe recording identity; local original retained')
  return owner + (language === 'ja' ? '/ja/' : '/') + encodeURIComponent(id) + '-' + hash
}
function validateManifest(row: AudioManifest, owner: string, language: LearningLanguage = 'en'): void {
  assertLearningLanguage(language)
  if (language === 'ja' ? row.learning_language !== 'ja' || row.object_path !== recordingPath(owner, row.audio_id, row.sha256, language)
    : row.learning_language !== undefined || row.object_path?.startsWith(owner + '/ja/')) throw new Error('Recording belongs to another learning language')
  if (row.user_id !== owner || typeof row.audio_id !== 'string' || !row.audio_id || row.audio_id.length > 1000
    || typeof row.object_path !== 'string' || !row.object_path.startsWith(owner + '/') || row.object_path.split('/').some(part => part === '..' || part === '.')
    || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > maxBytes
    || typeof row.mime_type !== 'string' || !/^(audio|video)\//.test(row.mime_type)
    || !['assessment', 'pronunciation', 'draft', 'history', 'import'].includes(row.purpose)
    || !Number.isFinite(Date.parse(row.created_at)) || (row.expires_at !== null && !Number.isFinite(Date.parse(row.expires_at))))
    throw new Error('Invalid private recording metadata')
  if ((row.retention_cursor != null && (!Number.isSafeInteger(row.retention_cursor) || row.retention_cursor < 0))
    || (row.retention_policy != null && !['minimal', 'assessment-only', 'more-history'].includes(row.retention_policy))
    || (row.cleanup_version != null && !/^[a-zA-Z0-9-]{1,100}$/.test(row.cleanup_version))
    || (row.recovery_pending !== undefined && typeof row.recovery_pending !== 'boolean')
    || (row.recovery_pending && !row.cleanup_version)) throw new Error('Invalid recording maintenance metadata')
}
async function recordingMaintenance(access: SyncAccess, language: LearningLanguage, action: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await accountRequest(access, () => access.client.rpc('recording_maintenance', { action, learning_language: language, request }))
  if (response.error || !response.data || typeof response.data !== 'object' || Array.isArray(response.data))
    throw new Error('Cloud recording maintenance needs retry. Your local originals are unchanged.')
  return response.data as Record<string, unknown>
}
/** Requires a JWT-pinned access, never the mutable application SDK client. */
export async function uploadRecording(access: SyncAccess, asset: AudioAsset,
  decision: NonNullable<ReturnType<typeof retentionDecision>>, language: LearningLanguage = 'en'): Promise<AudioManifest> {
  assertLearningLanguage(language)
  await access.assertCurrent()
  if (!isPrivateAudio(asset.kind)) throw new Error('Only private recordings and imports belong in recording sync')
  const { blob, ...metadata } = asset
  audioMetadataSchema.parse(metadata)
  if (!blob.size || blob.size > maxBytes) throw new Error('This recording exceeds the cloud audio limit. Your original stays on this device.')
  const sha256 = await audioHash(blob), owner = access.ownerId
  const path = recordingPath(owner, asset.id, sha256, language)
  const lookup = () => access.client.from(manifestTable(language)).select('*').eq('user_id', owner).eq('audio_id', asset.id).maybeSingle()
  const { data: existing, error: lookupError } = await accountRequest(access, lookup)
  if (lookupError) throw new Error('Could not check recording sync status')
  let recoveryVersion: string | null = null
  let replacementVerified = false
  if (existing) {
    validateManifest(existing as AudioManifest, owner, language)
    if (existing.sha256 !== sha256 || existing.bytes !== blob.size) throw new Error('A different original uses this recording ID. Neither copy was overwritten.')
    if (!existing.cleanup_version) return existing as AudioManifest
    const request = { audioId: asset.id, version: existing.cleanup_version, sha256, bytes: blob.size }
    let recovery = await recordingMaintenance(access, language, 'prepare-recovery', request)
    if (recovery.state === 'remove-old') {
      if (recovery.path !== path || recovery.version !== request.version) throw new Error('Recording recovery identity changed')
      const removed = await accountRequest(access, () => access.client.storage.from(bucket).remove([{ path, versionId: request.version }]))
      if (removed.error || !Array.isArray(removed.data) || removed.data.some(row => row.name !== path))
        throw new Error('Cloud copy recovery needs retry. Your local original is safe.')
      // An empty success can be RLS denial. Re-read before uploading.
      recovery = await recordingMaintenance(access, language, 'prepare-recovery', request)
    }
    if (recovery.state === 'verify-new') {
      const version = recovery.currentVersion
      if (recovery.path !== path || recovery.version !== request.version || typeof version !== 'string'
        || !/^[a-zA-Z0-9-]{1,100}$/.test(version) || version === request.version)
        throw new Error('Recording replacement identity changed')
      const prior = await accountRequest(access, () => access.client.storage.from(bucket).download(path, { versionId: version, cacheNonce: crypto.randomUUID() }))
      // Provider errors are not permission to delete a newer replacement.
      if (prior.error || !prior.data || prior.data.size !== blob.size || await audioHash(prior.data) !== sha256)
        throw new Error('Recording replacement could not be verified; original retained')
      replacementVerified = true
    }
    if (recovery.state === 'upload' || (recovery.state === 'verify-new' && replacementVerified)) {
      if (recovery.path !== path || recovery.version !== request.version) throw new Error('Recording recovery identity changed')
      recoveryVersion = request.version
    } else if (recovery.state === 'capacity') throw new CloudRecordingCapacityError()
    else if (recovery.state !== 'absent' && recovery.state !== 'unchanged')
      throw new Error('Cloud copy recovery is pending. Your local original is safe.')
  }
  if (!recoveryVersion) {
    const reservation = await accountRequest(access, () => access.client.rpc('reserve_recording_upload', { object_path: path, recording_bytes: blob.size }))
    if (reservation.error || typeof reservation.data !== 'boolean') throw new Error('Could not check shared cloud recording capacity. Retry later; your original stays on this device.')
    if (!reservation.data) throw new CloudRecordingCapacityError()
  }
  if (!replacementVerified) {
    const { error } = await accountRequest(access, () => access.client.storage.from(bucket).upload(path, blob, { upsert: false, contentType: asset.mimeType.split(';')[0] }))
    if (error) {
      const prior = await accountRequest(access, () => access.client.storage.from(bucket).download(path, { cacheNonce: crypto.randomUUID() }))
      if (prior.error || !prior.data || prior.data.size !== blob.size || await audioHash(prior.data) !== sha256)
        throw new Error('Recording upload did not finish. The local original is safe.')
    }
  }
  // New originals are protected until a complete metadata view reconciles retention.
  const manifest: AudioManifest = { user_id: owner, audio_id: asset.id, object_path: path, sha256, bytes: blob.size,
    ...(language === 'ja' ? { learning_language: 'ja' } : {}),
    mime_type: asset.mimeType, purpose: decision.purpose, created_at: new Date(asset.createdAt).toISOString(), expires_at: null }
  const saved = await accountRequest(access, () => access.client.from(manifestTable(language)).upsert(manifest, { onConflict: 'user_id,audio_id', ignoreDuplicates: true }))
  if (saved.error) throw new Error('Recording is uploaded but confirmation needs retry. The local original is safe.')
  if (recoveryVersion) {
    const confirmed = await recordingMaintenance(access, language, 'finish-recovery', { audioId: asset.id, version: recoveryVersion, sha256, bytes: blob.size })
    if (confirmed.state !== 'recovered' && confirmed.state !== 'unchanged') throw new Error('Cloud copy recovery confirmation is pending. Your original is safe.')
  }
  const verified = await accountRequest(access, lookup)
  if (verified.error || !verified.data) throw new Error('Recording confirmation needs retry; original retained')
  validateManifest(verified.data as AudioManifest, owner, language)
  if (verified.data.sha256 !== sha256 || verified.data.bytes !== blob.size || verified.data.object_path !== path || verified.data.cleanup_version || verified.data.recovery_pending)
    throw new Error('Recording confirmation mismatch; original retained')
  return verified.data as AudioManifest
}
export async function downloadRecording(access: SyncAccess, manifest: AudioManifest,
  metadata: Omit<AudioAsset, 'blob'>, language: LearningLanguage = 'en'): Promise<AudioAsset> {
  validateManifest(manifest, access.ownerId, language)
  if (!isPrivateAudio(metadata.kind)) throw new Error('Public audio caches do not belong in recording sync')
  if (metadata.id !== manifest.audio_id) throw new Error('Recording identity mismatch')
  const { data, error } = await accountRequest(access, () => access.client.storage.from(bucket).download(manifest.object_path))
  if (isMissingObject(error)) throw new CloudRecordingMissingError()
  if (error || !data) throw new Error('This recording could not download yet. Retry when connected.')
  if (data.size !== manifest.bytes || await audioHash(data) !== manifest.sha256) throw new Error('Recording verification failed. No local recording was replaced.')
  await access.assertCurrent()
  return { ...audioMetadataSchema.parse(metadata), blob: data }
}

export async function synchronizeAudio(database: JoveDatabase, access: SyncAccess, policy: RecordingRetention): Promise<AudioSyncResult> {
  const language = database.language
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
  const manifests: AudioManifest[] = []
  let after = ''
  for (;;) {
    const response = await accountRequest(access, () => access.client.from(manifestTable(language)).select('*').eq('user_id', owner)
      .gt('audio_id', after).order('audio_id', { ascending: true }).limit(500))
    if (response.error || !Array.isArray(response.data)) throw new Error('Could not synchronize recording history')
    if (!response.data.length) { result.hasMore = false; break }
    for (const row of response.data as AudioManifest[]) { validateManifest(row, owner, language); if (row.audio_id <= after) throw new Error('Invalid recording page order'); after = row.audio_id; manifests.push(row) }
  }
  async function alignRetention(row: AudioManifest, meta: Omit<AudioAsset, 'blob'>) {
    const decision = decisionFor(meta), purpose = decision?.purpose ?? 'history'
    const expiry = decision ? decision.expiresAt : Date.parse(row.created_at) + 7 * day
    const expiresAt = expiry === null ? null : new Date(expiry).toISOString()
    if (row.purpose === purpose && (row.expires_at === null ? expiresAt === null : expiresAt !== null && Date.parse(row.expires_at) === expiry)
      && row.retention_cursor === journalCursor && row.retention_policy === policy) return
    await journal.capture()
    if ((await journal.pending()).length) { result.retentionPending = true; return }
    const updated = await accountRequest(access, () => access.client.rpc(language === 'en' ? 'reconcile_recording_retention' : 'reconcile_language_recording_retention', {
      ...(language === 'ja' ? { learning_language: 'ja' } : {}),
      recording_id: row.audio_id, expected_cursor: journalCursor, retention_purpose: purpose, retention_expires_at: expiresAt,
      expected_policy: policy,
    }))
    if (updated.error) throw new Error('Could not update recording retention. Originals remain safe.')
    if (updated.data !== true) result.retentionPending = true
  }
  for (const row of manifests) {
    const meta = metadata.get(row.audio_id)
    if (!meta) { result.blocked++; continue }
    if (!isPrivateAudio(meta.kind)) continue
    const local = await database.audio.get(row.audio_id)
    if (local) {
      if (local.blob.size !== row.bytes || await audioHash(local.blob) !== row.sha256) { result.blocked++; continue }
    } else if (!row.expires_at || Date.parse(row.expires_at) > now) {
      let asset: AudioAsset
      try { asset = await downloadRecording(access, row, meta, language) }
      catch (error) {
        if (!(error instanceof CloudRecordingMissingError)) throw error
        result.blocked++
        result.retentionPending ||= Boolean(row.cleanup_version)
        continue
      }
      await access.assertCurrent()
      const added = await withAudioBudget(database, async budget => {
        if ((await database.syncMeta.get('owner'))?.value !== owner) throw new Error('Sync owner changed')
        if (await database.audio.get(asset.id)) return false
        if (budget.usedBytes + asset.blob.size > budget.limitBytes) return false
        await database.audio.add(asset)
        return true
      })
      if (added) { result.downloaded++; assets.push(asset) }
      else { result.blocked++; continue }
    }
    if (result.hasMore) { result.retentionPending = true; continue }
    await alignRetention(row, meta)
  }
  await journal.capture()
  if (manifests.length && !result.hasMore && !(await journal.pending()).length) {
    const cleanup = await recordingMaintenance(access, language, 'prepare-cleanup', { cursor: journalCursor, policy })
    if (!Array.isArray(cleanup.candidates) || cleanup.candidates.length > 20 || typeof cleanup.pending !== 'boolean')
      throw new Error('Invalid recording cleanup response; local originals retained')
    result.retentionPending ||= cleanup.pending || cleanup.candidates.length === 20
    for (const candidate of cleanup.candidates) {
      const row = manifests.find(item => item.audio_id === candidate?.audioId)
      const meta = row && metadata.get(row.audio_id)
      if (!row || !meta || candidate.path !== row.object_path || typeof candidate.version !== 'string'
        || !/^[a-zA-Z0-9-]{1,100}$/.test(candidate.version)) { result.retentionPending = true; continue }
      const decision = decisionFor(meta)
      if (decision && (decision.expiresAt === null || decision.expiresAt > now)) { result.retentionPending = true; continue }
      await journal.capture()
      if ((await journal.pending()).length) { result.retentionPending = true; break }
      const removed = await accountRequest(access, () => access.client.storage.from(bucket).remove([{ path: candidate.path, versionId: candidate.version }]))
      if (removed.error || !Array.isArray(removed.data) || removed.data.some(item => item.name !== candidate.path)) { result.retentionPending = true; continue }
      const final = await recordingMaintenance(access, language, 'finish-cleanup', { audioId: candidate.audioId, version: candidate.version })
      if (final.state !== 'removed' && final.state !== 'absent') result.retentionPending = true
    }
  } else if (result.hasMore || (await journal.pending()).length) result.retentionPending = true
  // Cleanup comes first even if upload fails in Storage's conservative preflight.
  for (const asset of assets) {
    const meta = metadata.get(asset.id) ?? asset, decision = decisionFor(meta)
    const recovering = manifests.some(row => row.audio_id === asset.id && row.recovery_pending)
    if (recovering || (decision && (decision.expiresAt === null || decision.expiresAt > now))) {
      try {
        const row = await uploadRecording(access, asset, decision ?? { purpose: 'draft', expiresAt: null }, language)
        result.uploaded++
        await alignRetention(row, meta)
        if (recovering && (!decision || (decision.expiresAt !== null && decision.expiresAt <= now))) result.retentionPending = true
      } catch (error) {
        if (!(error instanceof CloudRecordingCapacityError)) throw error
        result.blocked++
      }
    }
  }
  await access.assertCurrent()
  return result
}
