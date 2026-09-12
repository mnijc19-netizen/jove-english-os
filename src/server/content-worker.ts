import {
  assessSegment, bindAnalysis, canonicalContentJson, createAnalysisRequest, contentTranscriptUrn, ContentPipelineError, parseRssFeed, parseOpenYapPreviewManifest,
  parseTimedTranscript, PIPELINE_LIMITS, resolveEpisodeAudioUrl, rightsReasons, sliceTranscript, textMetrics, toMaterial, validateSourceUrl,
} from '../content/pipeline'
import { ALLOWLISTED_CONTENT_SOURCES, CONTENT_LIFE_TASKS, VOA_LESSON_CANDIDATES, type ContentLifeTask } from '../content/sources'
import type { ContentSource, FeedEpisode, LearnerContentProfile, TimedTranscript, TranscriptReference } from '../content/pipeline-types'
import { ContentNetworkError, fetchContentResource, type ContentFetchResult } from './content-network'
import { CONTENT_POLICY_EVIDENCE, revalidateContentRights } from './content-rights'
import { contentAudioDuration, contentAudioHttpDiagnostic, contentStoredAudioWindow, prepareContentMp3Prefix, ContentAudioResponseError } from './content-audio'
import { auditVoaLessonCandidates, type VoaCandidateAudit } from './content-voa'
import { GatewayError } from './gateway'
import type {
  ContentAdminClient, ContentAudioInput, ContentAudioResult, ContentAudioStore, ContentRefreshOptions, ContentRefreshSummary,
  ContentRightsRecord, ContentUsage, EligibleContentLesson, PersistedContentSegment, SelectContentOptions,
} from './content-contracts'

export type * from './content-contracts'

/** Trusted system reviewer output, separate from acoustic facts and candidate intent labels.
 * A classifier must assess the interaction, not merely find a task word. The binding and
 * exact aligned quotations are checked here; they do not make an untrusted caller a reviewer. */
export interface ContentLifeTaskReview {
  evidenceId: string; reviewer: string; version: string; reviewedAt: number
  segmentId: string; contentFingerprint: string; timingFingerprint: string
  audioSha256: string; sourcePolicyHash: string
  assessments: { task: ContentLifeTask; outcome: 'supported' | 'not-supported' | 'unknown'; reason: string
    quotes: { sentenceIndex: number; text: string }[] }[]
}
export interface ContentTaskRefreshOptions extends ContentRefreshOptions {
  /** Bounded archive audit under the existing VOA source; never a fresh-publication claim. */
  voaPilot?: 'metadata' | 'probe-audio' | 'disabled'
  /** Diagnostic metadata persistence only: no provider, retention, RSS, recommendation or Storage writes. */
  voaPilotOnly?: boolean
  analyzeAudio?: (input: ContentAudioInput) => Promise<ContentAudioResult & { lifeTaskReview?: ContentLifeTaskReview }>
  inventoryLowWater?: number
}
type TaskContentRecord = PersistedContentSegment & { lifeTaskReview?: ContentLifeTaskReview }
interface CandidateWindow {
  candidates: { id: string; record: TaskContentRecord; config: ContentSource }[]
  recent: { id: string; request_id: string; segment_id: string; lesson: EligibleContentLesson }[]
}
export interface OwnerContentTaskInventory {
  version: 'life-tasks-v1'; ownerId: string; observedAt: number
  scope: 'owner-selectable-unseen-window'; windowLimit: 100; windowComplete: boolean
  candidateAuditStatus: 'observed' | 'unknown'; eligibleTaskUnknown: number
  lowWater: number; lowWaterBasis: 'provisional-distinct-clip-count'
  tasks: { task: ContentLifeTask; configuredCandidateIds: string[]; auditedCandidateCount: number | null
    reviewedUsableCount: number; countBasis: 'exact' | 'lower-bound'
    state: 'gap' | 'low' | 'sufficient' | 'unknown'; needsAttention: boolean }[]
  notices: string[]
  /** Neither archive length nor poll cadence establishes future publication or depletion. */
  nextExpectedSupplyAt: null; estimatedDaysRemaining: null
}
export interface ContentRefreshSelection {
  sourceIds: string[]; basis: 'life-task-deficit-and-source-rotation-v1' | 'least-recent-audio-work-with-inventory-ties-v1'; notices: string[]
}
export interface ContentTaskRefreshSummary extends ContentRefreshSummary {
  inventory: OwnerContentTaskInventory | null
  refreshSelection: ContentRefreshSelection
  voaPilot: { id: string; checkedAt: number; transcriptSha256: string; audioProbed: boolean; eligible: false }[]
}
export { createContentFetcher, fetchContentResource, isPublicContentAddress } from './content-network'
export class ContentWorkerError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ContentWorkerError' }
}
function fail(code: string): never { throw new ContentWorkerError(code) }
const encoder = new TextEncoder()
const digest = async (input: string | Uint8Array): Promise<string> => {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
const use = { mode: 'private-excerpt', attributionProvided: true, changesIndicated: true, shareAlikeAccepted: true } as const
const screeningProfile: LearnerContentProfile = { targetDifficulty: 0.45, fatigue: 0, interests: ['Everyday life', 'Living abroad'], requireGeneralAmerican: false }
const defaultOwnerProfile: LearnerContentProfile = { ...screeningProfile, requireGeneralAmerican: true }
const contentBucket = 'jove-content-audio'
// Only our enumerated service codes may enter persisted diagnostics. Never copy
// an exception message, arbitrary provider code, response body or request data.
const serviceErrorCodes = new Set([
  'CONTENT_AUDIO_CONTAINER', 'CONTENT_AUDIO_FORMAT_REQUIRES_DECODER', 'CONTENT_AUDIO_INTERVAL',
  'CONTENT_AUDIO_PREFIX_COVERAGE', 'CONTENT_AUDIO_PREFIX_RESERVOIR',
  'CONTENT_OGG_CLIP_DECODER_REQUIRED', 'CONTENT_CLIP_DECODER_REQUIRED', 'CONTENT_AUDIO_MODEL',
  'CONTENT_PROVIDER_URL', 'CONTENT_AUDIO_CREDENTIAL_REQUIRED', 'CONTENT_AUDIO_RATE_LIMIT',
  'CONTENT_AUDIO_PROVIDER_FAILURE', 'CONTENT_AUDIO_RESPONSE', 'CONTENT_AUDIO_HASH',
  'CONTENT_AUDIO_UPLOAD', 'CONTENT_AUDIO_UPLOAD_HASH', 'CONTENT_AUDIO_INPUT_BOUNDARY',
  'CONTENT_AUDIO_CATALOG', 'CONTENT_AUDIO_MODEL_CAPABILITY', 'CONTENT_AUDIO_INCOMPLETE',
  'CONTENT_AUDIO_SCHEMA', 'CONTENT_AUDIO_USAGE_UNKNOWN', 'CONTENT_AUDIO_COVERAGE',
  'CONTENT_AUDIO_TRANSCRIPT_TIMING', 'CONTENT_STT_TIMING', 'CONTENT_OWNER', 'CONTENT_BUDGET',
  'CONTENT_DISPATCH', 'BUDGET', 'RESERVATION', 'USAGE_PENDING', 'UPLOAD_INTERRUPTED', 'UPLOAD_TIMEOUT', 'TOO_LARGE',
])
const codeOf = (error: unknown): string => error instanceof ContentWorkerError || error instanceof ContentNetworkError ||
  error instanceof ContentPipelineError || error instanceof GatewayError && serviceErrorCodes.has(error.code)
  ? error.code : 'content-operation-failed'
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

async function rpc<T>(client: ContentAdminClient, action: string, args: Record<string, unknown>, name = 'content_worker'): Promise<T> {
  const response = await client.rpc(name, { action, args })
  if (response.error) fail(response.error.code === '40001' ? 'content-lease-or-revision-lost' : response.error.code === '53000' ? 'content-storage-capacity-required' : 'content-persistence-failed')
  return response.data as T
}

const normalizeQuote = (text: string) => text.normalize('NFKC').replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').trim().toLowerCase()
function pilotRightsGate(episode: FeedEpisode): string | null {
  if (!episode.guid.startsWith('voa-pilot:')) return null
  const audit = (episode as FeedEpisode & { candidateAudit?: { candidate?: { thirdPartyNotices?: unknown } } }).candidateAudit
  if (!Array.isArray(audit?.candidate?.thirdPartyNotices)) return 'voa-pilot-audit-required'
  return audit.candidate.thirdPartyNotices.length ? 'publisher-third-party-rights-review-required' : null
}
function validTaskReview(record: TaskContentRecord, now: number): ContentLifeTaskReview | null {
  const review = record.lifeTaskReview
  if (!review || !record.artifact || !record.rightsRecord || review.segmentId !== record.segment.id ||
      review.contentFingerprint !== record.segment.contentFingerprint || review.timingFingerprint !== record.segment.timingFingerprint ||
      review.audioSha256 !== record.artifact.sha256 || review.sourcePolicyHash !== record.rightsRecord.sourcePolicyHash ||
      !finite(review.reviewedAt) || review.reviewedAt <= 0 || review.reviewedAt > now ||
      [review.evidenceId, review.reviewer, review.version].some(value => typeof value !== 'string' || !value.trim() || value.length > 200) ||
      !Array.isArray(review.assessments) || review.assessments.length > CONTENT_LIFE_TASKS.length) return null
  const seen = new Set<string>()
  for (const assessment of review.assessments) {
    if (!assessment || !CONTENT_LIFE_TASKS.includes(assessment.task) || seen.has(assessment.task) ||
        !['supported', 'not-supported', 'unknown'].includes(assessment.outcome) || typeof assessment.reason !== 'string' ||
        assessment.reason.trim().length < 20 || assessment.reason.length > 1000 || !Array.isArray(assessment.quotes) || assessment.quotes.length > 8) return null
    seen.add(assessment.task)
    const indices = new Set<number>()
    for (const quote of assessment.quotes) {
      const sentence = record.segment.sentences[quote?.sentenceIndex]
      if (!quote || !Number.isInteger(quote.sentenceIndex) || !sentence || indices.has(quote.sentenceIndex) ||
          typeof quote.text !== 'string' || normalizeQuote(quote.text).length < 12 || quote.text.length > 1000 ||
          !normalizeQuote(sentence.text).includes(normalizeQuote(quote.text))) return null
      if (assessment.outcome === 'supported' && !record.audioEvidence?.heard?.some(cue =>
        finite(cue.startTime) && finite(cue.endTime) && cue.endTime > cue.startTime &&
        cue.startTime >= record.segment.startSeconds && cue.endTime <= record.segment.endSeconds &&
        // Same aligned sentence, not merely the same words heard elsewhere in a long clip.
        cue.startTime >= sentence.startSeconds - 1.5 && cue.endTime <= sentence.endSeconds + 1.5 &&
        cue.startTime < sentence.endSeconds && cue.endTime > sentence.startSeconds &&
        typeof cue.body === 'string' && normalizeQuote(cue.body).includes(normalizeQuote(quote.text)))) return null
      indices.add(quote.sentenceIndex)
    }
    // One isolated keyword or one sentence is not evidence of an interaction.
    if (assessment.outcome === 'supported' && indices.size < 2) return null
  }
  return review
}

/** Narrow automatic semantic review for the fixed publisher scenes. No new audio claim:
 * the same immutable clip must ALREADY pass all gates, and the independent audio analyzer
 * must have heard both acts inside it. Other tasks and unmatched clips remain unknown. */
export function reviewVoaLifeTaskDialogue(record: PersistedContentSegment, source: ContentSource, now: number): ContentLifeTaskReview | null {
  const checked = eligibleRecord({ id: record.segment.id, record, config: source }, [source], screeningProfile, now)
  const contract = VOA_LESSON_CANDIDATES.find(candidate => record.segment.episode.guid === pilotGuid(candidate.id) &&
    record.segment.episode.pageUrl === candidate.pageUrl && record.segment.episode.audioUrl === candidate.audioUrl)
  const audit = (record.segment.episode as FeedEpisode & { candidateAudit?: { transcriptSha256?: string } }).candidateAudit
  if (!checked || !contract?.dialogueRules || record.segment.sourceId !== 'voa-everyday-grammar' ||
      !contract.dialogueScriptSha256 || audit?.transcriptSha256 !== contract.dialogueScriptSha256 ||
      !record.artifact || !record.rightsRecord || !record.audioEvidence?.heard?.length ||
      record.audioEvidence.originalAudioSha256 !== record.artifact.sha256 || record.audioEvidence.submittedAudioSha256 !== record.clip?.audioSha256 ||
      record.audioEvidence.inspectedStartSeconds !== record.segment.startSeconds || record.audioEvidence.inspectedEndSeconds !== record.segment.endSeconds) return null
  const assessments: ContentLifeTaskReview['assessments'] = []
  for (const rule of contract.dialogueRules) {
    const quotes = rule.turns.map(text => ({ text,
      sentenceIndex: record.segment.sentences.findIndex(sentence => normalizeQuote(sentence.text).includes(normalizeQuote(text))) }))
    if (quotes.some(quote => quote.sentenceIndex < 0 || !record.audioEvidence!.heard.some(cue =>
      finite(cue.startTime) && finite(cue.endTime) && cue.startTime >= record.segment.startSeconds && cue.endTime <= record.segment.endSeconds &&
      cue.endTime > cue.startTime && normalizeQuote(cue.body).includes(normalizeQuote(quote.text)))) ||
      quotes[0]!.sentenceIndex >= quotes[1]!.sentenceIndex) continue
    for (const task of rule.tasks) assessments.push({ task, outcome: 'supported', reason: rule.rationale, quotes })
  }
  if (!assessments.length) return null
  const review: ContentLifeTaskReview = { evidenceId: `voa-dialogue-rule:${contract.mediaId}`, reviewer: 'jove-audio-aligned-publisher-dialogue-rules',
    version: '1', reviewedAt: now, segmentId: record.segment.id, contentFingerprint: record.segment.contentFingerprint,
    timingFingerprint: record.segment.timingFingerprint, audioSha256: record.artifact.sha256, sourcePolicyHash: record.rightsRecord.sourcePolicyHash, assessments }
  return validTaskReview({ ...record, lifeTaskReview: review }, now)
}
function eligibleRecord(row: CandidateWindow['candidates'][number], sources: readonly ContentSource[], profile: LearnerContentProfile, now: number) {
  const record = row.record, configured = sources.find(source => source.id === record.segment.sourceId)
  const source = configured && { ...configured, verifiedAt: row.config.verifiedAt }
  if (!source || row.id !== record.segment.id || record.status !== 'eligible' || !record.inspection || !record.artifact || !record.lesson || !record.clip ||
      pilotRightsGate(record.segment.episode) ||
      !record.rightsRecord || record.rightsRecord.thirdParty === 'uncertain' ||
      record.rightsRecord.sourceId !== source.id || record.rightsRecord.method !== 'trusted-source-policy-and-audio-screen' ||
      !Array.isArray(record.rightsRecord.evidenceUrls) ||
      !source.rights.evidenceUrls.every(url => record.rightsRecord!.evidenceUrls.includes(url)) ||
      profile.recentContentFingerprints?.includes(record.segment.contentFingerprint)) return null
  const clip = record.clip, audio = record.audioEvidence
  if (clip.bucket !== contentBucket || !/^[a-f0-9]{64}$/u.test(clip.audioSha256) ||
      clip.objectPath !== `clips/${record.segment.id.slice('authentic-'.length)}/${clip.audioSha256}` ||
      clip.sourceAudioSha256 !== record.artifact.sha256 || clip.sourceStartSeconds !== record.segment.startSeconds ||
      clip.sourceEndSeconds !== record.segment.endSeconds || clip.startSeconds !== record.segment.startSeconds - clip.clipOriginSeconds ||
      clip.endSeconds !== record.segment.endSeconds - clip.clipOriginSeconds ||
      !finite(clip.durationSeconds) || clip.durationSeconds < clip.endSeconds || clip.durationSeconds > record.segment.durationSeconds + 3 ||
      !Number.isInteger(clip.byteLength) || clip.byteLength < 1 || clip.byteLength > 10 * 1024 * 1024 ||
      !audio || audio.originalAudioSha256 !== record.artifact.sha256 || audio.submittedAudioSha256 !== clip.audioSha256 ||
      audio.inspectedStartSeconds !== record.segment.startSeconds || audio.inspectedEndSeconds !== record.segment.endSeconds ||
      audio.submittedStartSeconds !== clip.clipOriginSeconds || !finite(audio.submittedEndSeconds) ||
      Math.abs(audio.submittedEndSeconds - (clip.clipOriginSeconds + clip.durationSeconds)) > 1e-6 ||
      audio.timingBasis !== clip.timingBasis) return null
  const context = { source, now, use, artifact: record.artifact, inspection: record.inspection, profile }
  const quality = assessSegment(record.segment, context)
  if (quality.status === 'quarantined' || quality.fit === null) return null
  // Enrichment and exact segment binding must also remain usable after JSONB read-back.
  try { toMaterial(record.segment, context, record.lesson, now) } catch { return null }
  return { context, quality, review: validTaskReview(record, now) }
}

/** Pure projection of a service-verified, current owner candidate window, NOT browser input. */
export function buildContentTaskInventory(options: {
  ownerId: string; rows: CandidateWindow; sources?: readonly ContentSource[]; profile: LearnerContentProfile; now: number
  auditedCandidateIds?: readonly string[]; lowWater?: number
}): OwnerContentTaskInventory {
  const lowWater = options.lowWater ?? 2
  if (!Number.isInteger(lowWater) || lowWater < 1 || lowWater > 10 || !finite(options.now) || options.now <= 0 || !options.ownerId ||
      !Array.isArray(options.rows.candidates) || options.rows.candidates.length > 100 || !Array.isArray(options.rows.recent)) fail('invalid-content-inventory')
  const counts = new Map<ContentLifeTask, number>(CONTENT_LIFE_TASKS.map(task => [task, 0]))
  const unknown = new Map<ContentLifeTask, number>(CONTENT_LIFE_TASKS.map(task => [task, 0]))
  const fingerprints = new Set<string>()
  let eligibleTaskUnknown = 0
  for (const row of options.rows.candidates) {
    const checked = eligibleRecord(row, options.sources ?? ALLOWLISTED_CONTENT_SOURCES, options.profile, options.now)
    if (!checked || fingerprints.has(row.record.segment.contentFingerprint)) continue
    fingerprints.add(row.record.segment.contentFingerprint)
    if (!checked.review || CONTENT_LIFE_TASKS.some(task => !checked.review!.assessments.some(value => value.task === task && value.outcome !== 'unknown'))) eligibleTaskUnknown++
    for (const task of CONTENT_LIFE_TASKS) {
      const assessment = checked.review?.assessments.find(value => value.task === task)
      if (assessment?.outcome === 'supported') counts.set(task, counts.get(task)! + 1)
      else if (!assessment || assessment.outcome === 'unknown') unknown.set(task, unknown.get(task)! + 1)
    }
  }
  const complete = options.rows.candidates.length < 100
  const tasks = CONTENT_LIFE_TASKS.map(task => {
    const configuredCandidateIds = VOA_LESSON_CANDIDATES.filter(row => row.taskIntents.includes(task)).map(row => row.id)
    const count = counts.get(task)!
    return { task, configuredCandidateIds,
      auditedCandidateCount: options.auditedCandidateIds ? configuredCandidateIds.filter(id => options.auditedCandidateIds!.includes(id)).length : null,
      reviewedUsableCount: count, countBasis: complete && !unknown.get(task) ? 'exact' as const : 'lower-bound' as const,
      state: count >= lowWater ? 'sufficient' as const : !complete || unknown.get(task) ? 'unknown' as const : count ? 'low' as const : 'gap' as const,
      needsAttention: count < lowWater }
  })
  return { version: 'life-tasks-v1', ownerId: options.ownerId, observedAt: options.now, scope: 'owner-selectable-unseen-window',
    windowLimit: 100, windowComplete: complete, candidateAuditStatus: options.auditedCandidateIds ? 'observed' : 'unknown', eligibleTaskUnknown,
    lowWater, lowWaterBasis: 'provisional-distinct-clip-count', tasks,
    notices: [...(tasks.some(task => task.state === 'gap') ? ['life-task-reviewed-inventory-gap'] : []),
      ...(tasks.some(task => task.state === 'low') ? ['life-task-inventory-low'] : []),
      ...(tasks.some(task => task.state === 'unknown') ? ['life-task-inventory-unknown'] : []),
      ...(!complete ? ['content-inventory-window-limited'] : []),
      ...(options.auditedCandidateIds ? [] : ['candidate-audit-readback-unavailable'])],
    nextExpectedSupplyAt: null, estimatedDaysRemaining: null }
}

interface PilotReadQuery extends PromiseLike<{ data: unknown; error: unknown }> {
  eq(column: string, value: string): PilotReadQuery
  in(column: string, values: readonly string[]): PilotReadQuery
  limit(count: number): PilotReadQuery
}
const pilotGuid = (id: string) => `voa-pilot:${id}`
async function readPilotIds(client: ContentAdminClient): Promise<string[] | undefined> {
  const reader = client as ContentAdminClient & { from?: (table: string) => { select(columns: string): PilotReadQuery } }
  if (!reader.from) return undefined // RPC-only diagnostic adapters must report unknown, never an invented zero.
  const result = await reader.from('content_items').select('guid,episode').eq('source_id', 'voa-everyday-grammar')
    .in('guid', VOA_LESSON_CANDIDATES.map(row => pilotGuid(row.id))).limit(6)
  if (result.error || !Array.isArray(result.data)) return undefined
  return result.data.flatMap((row: { guid?: string; episode?: { pageUrl?: string; audioUrl?: string; candidateAudit?: { candidate?: { id?: string }; transcriptSha256?: string } } }) => {
    const contract = VOA_LESSON_CANDIDATES.find(candidate => pilotGuid(candidate.id) === row.guid)
    return contract && row.episode?.pageUrl === contract.pageUrl && row.episode.audioUrl === contract.audioUrl &&
      row.episode.candidateAudit?.candidate?.id === contract.id && /^[a-f0-9]{64}$/u.test(row.episode.candidateAudit.transcriptSha256 ?? '') ? [contract.id] : []
  })
}
/** Server-only single-owner read. No profile/owner ID from source data; no DB or provider writes. */
export async function readOwnerContentTaskInventory(options: {
  adminClient: ContentAdminClient; ownerId: string; profile?: LearnerContentProfile; sources?: readonly ContentSource[]
  lowWater?: number; now?: () => number
}): Promise<OwnerContentTaskInventory> {
  const owner = await rpc<{ ownerId: string | null }>(options.adminClient, 'owner', {})
  if (!owner.ownerId || owner.ownerId !== options.ownerId) fail('content-single-owner-required')
  // NULL cannot match a recommendation request ID, so the read never bypasses its cooldown.
  const rows = await rpc<CandidateWindow>(options.adminClient, 'candidates', { ownerId: owner.ownerId, requestId: null })
  return buildContentTaskInventory({ ownerId: owner.ownerId, rows, sources: options.sources, profile: options.profile ?? defaultOwnerProfile,
    now: (options.now ?? Date.now)(), lowWater: options.lowWater, auditedCandidateIds: await readPilotIds(options.adminClient) })
}

/** Supply intent is only a dispatch heuristic. Neither archive polling nor topic tags certify future stock. */
export function planContentSourceRefresh(options: { sources: readonly ContentSource[]; inventory?: OwnerContentTaskInventory | null; limit: number; now: number }): ContentRefreshSelection {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10 || !finite(options.now) || options.now <= 0) fail('invalid-content-refresh-selection')
  const eligible = options.sources.filter(source => source.enabled && source.rights.status === 'verified')
  const everyday = eligible.filter(source => ['voa-everyday-grammar', 'open-yap-sample'].includes(source.id))
  const mixed = eligible.filter(source => source.id === 'hacker-public-radio' || source.id === 'jb-the-launch')
  const others = eligible.filter(source => !everyday.includes(source) && !mixed.includes(source))
  const rotate = (rows: ContentSource[]) => rows.length ? [...rows.slice(Math.floor(options.now / 86_400_000) % rows.length), ...rows.slice(0, Math.floor(options.now / 86_400_000) % rows.length)] : []
  const deficits = !options.inventory || options.inventory.tasks.some(task => task.needsAttention)
  const ordered = deficits ? [...rotate(everyday), ...rotate(mixed), ...rotate(others)] : [...rotate(mixed), ...rotate(everyday), ...rotate(others)]
  return { sourceIds: ordered.slice(0, options.limit).map(source => source.id), basis: 'life-task-deficit-and-source-rotation-v1',
    notices: [...(!everyday.length ? ['everyday-source-dispatch-unavailable'] : []),
      ...(deficits ? ['core-inventory-replenishment-required'] : []), 'nontechnical-continuing-supply-not-established'] }
}
interface StorageBucket {
  upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }): Promise<{ error: { statusCode?: string } | null }>
  download(path: string): Promise<{ data: Blob | null; error: unknown }>
  remove(paths: string[]): Promise<{ error: unknown }>
}
/** Uses only the provided admin client's own private bucket, never a configured global backend. */
export function createSupabaseContentAudioStore(adminClient: ContentAdminClient): ContentAudioStore | null {
  const storage = (adminClient as ContentAdminClient & { storage?: { from(name: string): StorageBucket } }).storage
  if (!storage) return null
  const bucket = storage.from(contentBucket)
  const get = async (path: string) => {
    const result = await bucket.download(path)
    if (result.error || !result.data || result.data.size > 64 * 1024 * 1024) return fail('saved-audio-unavailable')
    return new Uint8Array(await result.data.arrayBuffer())
  }
  return {
    get,
    async put(path, bytes, mimeType) {
      const result = await bucket.upload(path, bytes, { contentType: mimeType, upsert: false })
      if (result.error && (result.error.statusCode !== '409' || await digest(await get(path)) !== await digest(bytes))) fail('audio-save-failed')
    },
    async remove(paths) {
      if (paths.some(path => !/^(?:episodes|prefixes|clips)\/[a-f0-9]{64}\/[a-f0-9]{64}$/u.test(path))) fail('invalid-content-object-path')
      if ((await bucket.remove(paths)).error) fail('audio-remove-failed')
    },
  }
}
interface PendingItem {
  id: string; revision: string; episode: FeedEpisode; attempts: number
  transcript: TimedTranscript | null; saved_segments: PersistedContentSegment[]
  object_path: string | null; audio_sha256: string | null; audio_mime: string | null
  audio_acquisition_version?: 'complete-v1' | 'mpeg-prefix-v1' | null
  audio_coverage?: ContentAudioInput['audio']['coverage'] | null
}
interface Claim {
  acquired: boolean; reason?: string; feedDue?: boolean; etag?: string | null; last_modified?: string | null; failures?: number
  rightsDue?: boolean; rights_status?: string; rights_checked_at?: string | null
}
interface JobContext {
  options: ContentTaskRefreshOptions; source: ContentSource; sourcePolicyHash: string; ownerId: string | null
  summary: ContentRefreshSummary; now: () => number; controller: AbortController
  audioStore: ContentAudioStore | null; maxAudio: number; maxSegments: number; processVersion: string
  beginAudioWork: (item: PendingItem) => Promise<void>
  call: <T>(action: string, args?: Record<string, unknown>) => Promise<T>
  fetch: (url: string, role: 'feed' | 'audio' | 'transcript', maxBytes: number, etag?: string | null, modified?: string | null, audioPrefixBytes?: number) => Promise<ContentFetchResult>
}
function decodeResource(response: ContentFetchResult, role: 'feed' | 'transcript' | 'publisher-manifest'): string {
  if (response.status !== 200) fail(response.status === 429 ? 'publisher-rate-limited' : `publisher-http-${response.status}`)
  const types = role === 'publisher-manifest' ? ['text/plain', 'application/jsonl', 'application/x-ndjson'] : role === 'feed' ? ['application/rss+xml', 'application/xml', 'text/xml'] :
    ['text/vtt', 'application/x-subrip', 'application/srt', 'text/srt', 'application/json', 'text/plain', 'application/octet-stream']
  if (!types.includes(response.contentType)) fail('unexpected-publisher-content-type')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(response.body) } catch { return fail('invalid-publisher-encoding') }
}
function validateUsage(usage: ContentUsage): ContentUsage {
  if (!usage || usage.costUsd !== null && (!finite(usage.costUsd) || usage.costUsd < 0) || !finite(usage.units) || usage.units < 0 ||
      ![usage.provider, usage.model, usage.unitName].every(value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\r\n<>]/u.test(value))) fail('invalid-content-usage')
  return usage
}
function budgetReady(context: JobContext, purpose: 'content-analysis' | 'content-stt'): string | null {
  if (!context.ownerId) return 'content-owner-unconfigured'
  if (!context.options.budget) return 'content-budget-unconfigured'
  if (!context.audioStore) return 'content-audio-storage-unconfigured'
  const ceiling = purpose === 'content-analysis' ? context.options.costCeilings?.analysisUsd : context.options.costCeilings?.transcriptionUsd
  const version = purpose === 'content-analysis' ? context.options.analyzerVersion : context.options.transcriberVersion
  if (!version?.trim() || version.length > 80) return 'content-provider-version-required'
  if (!finite(ceiling) || ceiling <= 0 || ceiling > 20) return 'content-cost-ceiling-required'
  return null
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new ContentWorkerError('content-run-timeout-or-cancelled'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { signal.removeEventListener('abort', abort) }
}
async function providerCall<T extends { usage: ContentUsage }>(context: JobContext, item: PendingItem, purpose: 'content-analysis' | 'content-stt',
  requestId: string, fingerprint: string, scope: string, audioSha256: string, invoke: () => Promise<T>): Promise<T> {
  const notReady = budgetReady(context, purpose)
  if (notReady) return fail(notReady)
  await context.call('heartbeat')
  const intent = await abortable(Promise.resolve(context.options.adminClient.rpc('content_request_intent', { args: {
    sourceId: context.source.id, runId: context.summary.runId, itemId: item.id, revision: item.revision,
    purpose, scope, requestId, fingerprint, audioSha256,
  } })), context.controller.signal)
  if (intent.error?.code === '40001') return fail('content-lease-or-revision-lost')
  if (intent.error || !intent.data || (intent.data as { allowed?: unknown }).allowed !== true)
    return fail('content-provider-reconciliation-required')
  if (context.controller.signal.aborted) return fail('content-run-timeout-or-cancelled')
  const reserved = await context.options.budget!.reserve({ ownerId: context.ownerId!, requestId, fingerprint, purpose,
    maxCostUsd: purpose === 'content-analysis' ? context.options.costCeilings!.analysisUsd : context.options.costCeilings!.transcriptionUsd })
  if (!reserved.allowed) return fail('content-budget-denied')
  if (!reserved.reservationId || !reserved.acquired || reserved.replay) return fail('content-provider-reconciliation-required')
  let observedUsage: ContentUsage | null = null
  try {
    const result = await abortable(invoke(), context.controller.signal)
    observedUsage = validateUsage(result.usage)
    await context.options.budget!.settle({ reservationId: reserved.reservationId, status: 'completed', usage: result.usage })
    await context.call('usage', { itemId: item.id, revision: item.revision, ownerId: context.ownerId, requestId, purpose, status: 'completed', usage: result.usage })
    return result
  } catch (error) {
    // Unknown outcome keeps its reservation chargeable. No automatic replay after a possible paid dispatch.
    // A provider-attested invoice is independent of lesson validity. Retain it
    // even if schema/timing/coverage validation fails; null still keeps the hold.
    let usage: ContentUsage | null = observedUsage, providerRequestId: string | null = null
    if (error instanceof ContentAudioResponseError) {
      try { usage = validateUsage(error.receipt.usage); providerRequestId = error.receipt.id } catch { /* Invalid receipt is not billing evidence. */ }
    }
    const httpDiagnostic = await contentAudioHttpDiagnostic(error)
    try { await context.options.budget!.settle({ reservationId: reserved.reservationId, status: 'uncertain', usage }) } catch { /* Primary outcome stays uncertain. */ }
    try { await context.call('usage', { itemId: item.id, revision: item.revision, ownerId: context.ownerId, requestId, purpose, status: 'uncertain',
      usage: { ...(usage ?? { costUsd: null }), ...(providerRequestId ? { providerRequestId } : {}),
        ...(httpDiagnostic ? { httpDiagnostic } : {}), errorCode: codeOf(error) } }) } catch { /* Lease loss must not permit stale writes. */ }
    throw error
  }
}
async function getAudio(context: JobContext, item: PendingItem, purpose: 'content-analysis' | 'content-stt'): Promise<ContentAudioInput['audio']> {
  if (!context.audioStore) return fail('content-audio-storage-unconfigured')
  // Metadata/transcripts can refresh while spending is paused. Do not download
  // an episode or pull its private cached bytes just to discover a known denial.
  // This read is advisory: a competing request can still consume the budget,
  // so providerCall must retain its independent atomic dispatch reservation.
  const budget = context.options.budget
  if (budget?.checkAvailable && !await abortable(budget.checkAvailable({ ownerId: context.ownerId!,
    maxCostUsd: purpose === 'content-analysis' ? context.options.costCeilings!.analysisUsd : context.options.costCeilings!.transcriptionUsd,
    signal: context.controller.signal }), context.controller.signal)) fail('content-budget-denied-before-audio')
  await context.beginAudioWork(item)
  await context.call('heartbeat')
  if (item.object_path && item.audio_sha256 && item.audio_mime) {
    const bytes = await context.audioStore.get(item.object_path)
    if (bytes.byteLength > context.maxAudio || await digest(bytes) !== item.audio_sha256) fail('saved-audio-hash-mismatch')
    const audio = { bytes, sha256: item.audio_sha256, mimeType: item.audio_mime, objectPath: item.object_path,
      ...(item.audio_coverage ? { coverage: item.audio_coverage } : {}) }
    if ((item.audio_acquisition_version ?? 'complete-v1') === 'mpeg-prefix-v1') {
      if (!audio.coverage || item.object_path !== `prefixes/${item.id}/${audio.sha256}`) fail('saved-audio-coverage-mismatch')
      contentStoredAudioWindow(audio, 0, audio.coverage.endSeconds)
    } else if (audio.coverage || item.object_path !== `episodes/${item.id}/${audio.sha256}`) fail('saved-audio-coverage-mismatch')
    return audio
  }
  const prefixBytes = context.options.audioAcquisition === 'mpeg-prefix-v1' ? Math.min(context.maxAudio, 8 * 1024 * 1024) : undefined
  const response = await context.fetch(resolveEpisodeAudioUrl(item.episode, context.source), 'audio', prefixBytes ?? context.maxAudio, undefined, undefined, prefixBytes)
  // VOA serves genuine MPEG frames as audio/mp3. Canonicalize only this verified
  // alias; neither an extension nor an MP3 header alone admits arbitrary bytes.
  const mimeType = response.contentType === 'audio/mp3' ? 'audio/mpeg' : response.contentType
  if (prefixBytes && mimeType === 'audio/mpeg') {
    if (![200, 206].includes(response.status)) fail('invalid-audio-response')
    const prefix = prepareContentMp3Prefix(response.body, response.contentType, response.byteCoverage)
    const sha256 = await digest(prefix.bytes), objectPath = `prefixes/${item.id}/${sha256}`
    await context.call('asset', { itemId: item.id, revision: item.revision, acquisitionVersion: 'mpeg-prefix-v1',
      sha256, objectPath, bytes: prefix.bytes.length, mimeType: prefix.mimeType, coverage: prefix.coverage })
    await context.audioStore.put(objectPath, prefix.bytes, prefix.mimeType)
    await context.call('asset-ready', { itemId: item.id, revision: item.revision, acquisitionVersion: 'mpeg-prefix-v1', sha256 })
    return { ...prefix, sha256, objectPath }
  }
  if (response.status !== 200 || !['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/aac'].includes(mimeType) || !response.body.length) fail('invalid-audio-response')
  if (response.contentType === 'audio/mp3') {
    try { contentAudioDuration(response.body, mimeType) } catch { fail('invalid-audio-response') }
  }
  const sha256 = await digest(response.body)
  const objectPath = `episodes/${item.id}/${sha256}`
  await context.call('asset', { itemId: item.id, revision: item.revision, sha256, objectPath, bytes: response.body.length, mimeType })
  await context.audioStore.put(objectPath, response.body, mimeType)
  await context.call('asset-ready', { itemId: item.id, revision: item.revision, sha256 })
  return { bytes: response.body, sha256, objectPath, mimeType }
}
function validateRightsRecord(result: ContentAudioResult, context: JobContext): ContentRightsRecord {
  const rights = result.rightsRecord
  if (!rights || rights.sourceId !== context.source.id || rights.sourcePolicyHash !== context.sourcePolicyHash ||
      rights.method !== 'trusted-source-policy-and-audio-screen' || !rights.evidenceId?.trim() ||
      !finite(rights.checkedAt) || rights.checkedAt <= 0 || rights.checkedAt > context.now() ||
      !Array.isArray(rights.evidenceUrls) || !rights.evidenceUrls.length ||
      !['none-detected', 'separately-cleared', 'uncertain'].includes(rights.thirdParty)) fail('content-rights-record-required')
  for (const url of rights.evidenceUrls) validateSourceUrl(url)
  if (!context.source.rights.evidenceUrls.every(url => rights.evidenceUrls.includes(url))) fail('content-rights-evidence-mismatch')
  return structuredClone(rights)
}
async function publisherTranscript(context: JobContext, item: PendingItem): Promise<TimedTranscript | null> {
  if (item.transcript) return structuredClone(item.transcript)
  for (const reference of item.episode.transcripts.slice(0, 3)) {
    try {
      const response = await context.fetch(reference.url, 'transcript', PIPELINE_LIMITS.transcriptBytes)
      return parseTimedTranscript(decodeResource(response, 'transcript'), reference)
    } catch (error) {
      if (!(error instanceof ContentPipelineError) && !(error instanceof ContentWorkerError && /^publisher-http-(?:404|410)$/u.test(error.code))) throw error
    }
  }
  return null
}
async function processItem(context: JobContext, item: PendingItem): Promise<void> {
  const publisherGate = pilotRightsGate(item.episode)
  const reasons = [...rightsReasons(context.source, item.episode, use, context.now()), ...(publisherGate ? [publisherGate] : [])]
  if (reasons.length) {
    context.summary.nextGates.push(...reasons)
    await context.call('finish-item', { itemId: item.id, revision: item.revision, status: 'quarantined', reasons, processVersion: context.processVersion })
    return
  }
  let transcript = await publisherTranscript(context, item)
  let audio: ContentAudioInput['audio'] | null = null
  if (!transcript) {
    if (!context.options.transcribe) fail('publisher-transcript-unusable-stt-required')
    if (!context.source.rights.transcribe) fail('transcription-rights-missing')
    const gate = budgetReady(context, 'content-stt')
    if (gate) fail(gate)
    audio = await getAudio(context, item, 'content-stt')
    // A locally known decoder failure is not an uncertain paid provider result.
    // Keep the saved source for recovery, but do not acquire a spending hold.
    try {
      contentAudioDuration(audio.bytes, audio.mimeType)
      context.options.prepareTranscription?.(audio)
    } catch { return fail('content-transcription-decoder-required') }
    const requestFingerprint = await digest(JSON.stringify([item.revision, audio.sha256, context.options.transcriberVersion, context.sourcePolicyHash,
      ...(audio.coverage ? ['mpeg-prefix-v1/xing-v1'] : [])]))
    const requestId = `content-stt-${requestFingerprint}`
    const prepared = audio
    const result = await providerCall(context, item, 'content-stt', requestId, requestFingerprint, '', audio.sha256, () => context.options.transcribe!({
      requestId, requestFingerprint, episode: structuredClone(item.episode), audio: prepared,
      sourcePolicy: structuredClone(context.source.rights), sourcePolicyHash: context.sourcePolicyHash, signal: context.controller.signal,
    }))
    if (result.audioSha256 !== audio.sha256 || result.requestFingerprint !== requestFingerprint || !finite(result.audioDurationSeconds) ||
        result.audioDurationSeconds <= 0 || result.audioDurationSeconds > PIPELINE_LIMITS.mediaSeconds ||
        audio.coverage && Math.abs(result.audioDurationSeconds - audio.coverage.endSeconds) > 0.00000001) fail('stt-response-binding-mismatch')
    // Database identity, not a nonexistent public endpoint. Local HTTP never enters source URL allowlists.
    const reference: TranscriptReference = {
      url: contentTranscriptUrn(item.id), format: 'json', language: null, origin: 'authorized-stt',
      derivation: { audioSha256: audio.sha256, audioDurationSeconds: result.audioDurationSeconds,
        ...(audio.coverage ? { audioCoverage: audio.coverage } : {}), provider: result.provider, processedAt: context.now(), evidenceId: result.evidenceId },
    }
    transcript = parseTimedTranscript(result.transcriptJson, reference, result.audioDurationSeconds)
    item.episode = { ...item.episode, durationSeconds: audio.coverage ? item.episode.durationSeconds : result.audioDurationSeconds, transcripts: [...item.episode.transcripts, reference] }
  }
  const stored = transcript.reference.origin === 'authorized-stt' && transcript.reference.url === contentTranscriptUrn(item.id)
  if (transcript.reference.origin === 'authorized-stt') {
    if (!stored && (!context.options.transcriptOrigin || new URL(transcript.reference.url).origin !== new URL(context.options.transcriptOrigin).origin)) fail('content-transcript-origin-required')
    item.episode = { ...item.episode, durationSeconds: transcript.reference.derivation?.audioCoverage ? item.episode.durationSeconds : transcript.reference.derivation?.audioDurationSeconds ?? item.episode.durationSeconds,
      transcripts: item.episode.transcripts.some(ref => ref.url === transcript.reference.url) ? item.episode.transcripts : [...item.episode.transcripts, transcript.reference] }
  }
  await context.call('checkpoint', { itemId: item.id, revision: item.revision, transcript, fingerprint: await digest(JSON.stringify(transcript)) })
  // Covered whole cues must be selected BEFORE grouping/ranking/the item limit.
  // A publisher transcript remains cached in full even when spending is paused.
  if (context.options.audioAcquisition === 'mpeg-prefix-v1' && context.options.analyzeAudio && !budgetReady(context, 'content-analysis'))
    audio ??= await getAudio(context, item, 'content-analysis')
  const derived = transcript.reference.origin === 'authorized-stt' && !stored ? [{ origin: new URL(transcript.reference.url).origin, pathPrefix: '/content-transcripts/' }] : undefined
  // Publisher duration may omit inserted introductions. Actual decoded duration is mandatory at analysis binding.
  const slicingEpisode = { ...item.episode, durationSeconds: transcript.reference.origin === 'authorized-stt' ? item.episode.durationSeconds : null }
  const sliced = await sliceTranscript(slicingEpisode, transcript, context.source, { retrievedAt: context.now(), derivedTranscriptRules: derived,
    storedTranscriptId: stored ? item.id : undefined, audioCoverage: audio?.coverage ?? transcript.reference.derivation?.audioCoverage })
  const rankedCandidates = sliced.segments.map(segment => ({ segment, metrics: textMetrics(segment) }))
    .sort((a, b) => Number(b.metrics.topics.includes('Everyday life')) - Number(a.metrics.topics.includes('Everyday life')) ||
      Math.abs(a.metrics.difficulty - 0.4) - Math.abs(b.metrics.difficulty - 0.4) || a.segment.startSeconds - b.segment.startSeconds)
    .map(candidate => candidate.segment)
  if (!rankedCandidates.length) fail('no-coherent-content-segments')
  const inspected = new Set(item.saved_segments.filter(saved => saved.analysis && saved.rightsRecord?.sourcePolicyHash === context.sourcePolicyHash).map(saved => saved.segment.id))
  const remaining = rankedCandidates.filter(candidate => !inspected.has(candidate.id))
  const candidates = remaining.slice(0, context.maxSegments)
  let eligible = item.saved_segments.filter(saved => saved.status === 'eligible' && inspected.has(saved.segment.id)).length
  const itemGates = new Set<string>()
  if (remaining.length > candidates.length) itemGates.add('additional-segments-awaiting-analysis')
  for (const candidate of candidates) {
    if (context.controller.signal.aborted) fail('content-run-timeout-or-cancelled')
    const cached = item.saved_segments.find(saved => saved.segment.id === candidate.id && saved.status === 'eligible')
    if (cached && cached.artifact && cached.inspection && cached.lesson && cached.clip) { eligible++; continue }
    let record: TaskContentRecord = {
      segment: candidate, status: 'quarantined', inspection: null, artifact: null, objectPath: null, analysis: null,
      lesson: null, material: null, rightsRecord: null,
      quality: assessSegment(candidate, { source: context.source, now: context.now(), profile: screeningProfile, use }),
    }
    // Persist work before storage/provider failures. No analyzed bytes, no eligible record.
    await context.call('save-segment', { itemId: item.id, revision: item.revision, record })
    context.summary.segmentsSaved++
    const gate = !context.options.analyzeAudio ? 'audio-analyzer-unconfigured' : budgetReady(context, 'content-analysis')
    if (gate) { itemGates.add(gate); continue }
    audio ??= await getAudio(context, item, 'content-analysis')
    if (transcript.reference.origin === 'authorized-stt' && (transcript.reference.derivation?.audioSha256 !== audio.sha256 ||
        canonicalContentJson(transcript.reference.derivation?.audioCoverage ?? null) !== canonicalContentJson(audio.coverage ?? null)))
      fail('content-transcript-artifact-recovery-required')
    let window: ReturnType<typeof contentStoredAudioWindow>
    try { window = contentStoredAudioWindow(audio, candidate.startSeconds, candidate.endSeconds) }
    catch { return fail('content-clip-decoder-required') }
    if (window.bytes.length > 10 * 1024 * 1024 || window.endSeconds - window.originSeconds > candidate.durationSeconds + 3)
      fail('content-clip-decoder-required')
    const requestFingerprint = await digest(JSON.stringify([candidate.id, audio.sha256, context.options.analyzerVersion, context.sourcePolicyHash,
      ...(audio.coverage ? ['mpeg-prefix-v1/xing-v1'] : [])]))
    const requestId = `content-a-${requestFingerprint}`
    const prepared = audio
    const result = await providerCall(context, item, 'content-analysis', requestId, requestFingerprint, candidate.id, audio.sha256, () => context.options.analyzeAudio!({
      requestId, requestFingerprint, segment: structuredClone(candidate), audio: prepared,
      interval: { startSeconds: candidate.startSeconds, endSeconds: candidate.endSeconds },
      sourcePolicy: structuredClone(context.source.rights), sourcePolicyHash: context.sourcePolicyHash, signal: context.controller.signal,
    }))
    if (result.requestFingerprint !== requestFingerprint || result.audioSha256 !== audio.sha256 || result.inspectedStartSeconds !== candidate.startSeconds ||
        result.inspectedEndSeconds !== candidate.endSeconds || !finite(result.audioDurationSeconds) || result.audioDurationSeconds < candidate.endSeconds) fail('audio-analysis-binding-mismatch')
    const rightsRecord = validateRightsRecord(result, context)
    const facts = structuredClone(result.facts)
    if (rightsRecord.thirdParty === 'uncertain') facts.thirdPartyClear = { status: 'unknown', reason: 'Audio/source review did not clear third-party material.' }
    const artifact = { sha256: audio.sha256, url: candidate.episode.audioUrl, durationSeconds: result.audioDurationSeconds,
      ...(audio.coverage ? { coverage: audio.coverage } : {}) }
    const analysis = { ...createAnalysisRequest(candidate, artifact), facts }
    const inspection = bindAnalysis(candidate, artifact, analysis, context.now())
    const assessmentContext = { source: context.source, now: context.now(), profile: screeningProfile, use, artifact, inspection }
    const quality = assessSegment(candidate, assessmentContext)
    record = { ...record, analysis, inspection, artifact, objectPath: audio.objectPath, lesson: result.lesson ?? null, rightsRecord, quality, audioEvidence: result.audioEvidence }
    if (quality.status !== 'quarantined' && result.lesson) {
      const converted = toMaterial(candidate, assessmentContext, result.lesson, context.now())
      if (Math.abs(window.originalDurationSeconds - result.audioDurationSeconds) > 0.05) fail('audio-container-duration-mismatch')
      const clipSha256 = await digest(window.bytes)
      const evidence = result.audioEvidence
      if (!evidence || evidence.originalAudioSha256 !== audio.sha256 || evidence.submittedAudioSha256 !== clipSha256 ||
          evidence.submittedStartSeconds !== window.originSeconds || evidence.submittedEndSeconds !== window.endSeconds ||
          evidence.inspectedStartSeconds !== candidate.startSeconds || evidence.inspectedEndSeconds !== candidate.endSeconds ||
          evidence.timingBasis !== window.timingBasis) fail('content-clip-analysis-binding-mismatch')
      record.clip = { bucket: contentBucket, objectPath: `clips/${candidate.id.slice('authentic-'.length)}/${clipSha256}`,
        audioSha256: clipSha256, sourceAudioSha256: audio.sha256, sourceStartSeconds: candidate.startSeconds, sourceEndSeconds: candidate.endSeconds,
        startSeconds: candidate.startSeconds - window.originSeconds, endSeconds: candidate.endSeconds - window.originSeconds,
        clipOriginSeconds: window.originSeconds, timingBasis: window.timingBasis, mimeType: window.mimeType,
        byteLength: window.bytes.length, durationSeconds: window.endSeconds - window.originSeconds }
      await context.call('clip', { itemId: item.id, revision: item.revision, segmentId: candidate.id, clip: record.clip,
        acquisitionVersion: audio.coverage?.version ?? 'complete-v1' })
      await context.audioStore!.put(record.clip.objectPath, window.bytes, window.mimeType)
      await context.call('clip-ready', { itemId: item.id, revision: item.revision, segmentId: candidate.id, sha256: clipSha256 })
      record.material = converted.material
      // This path means a clip everywhere outside the private episode-analysis cache.
      record.objectPath = record.clip.objectPath
      record.status = 'eligible'
      if (result.lifeTaskReview) {
        record.lifeTaskReview = structuredClone(result.lifeTaskReview)
        if (!validTaskReview(record, context.now())) {
          delete record.lifeTaskReview
          context.summary.nextGates.push('life-task-review-invalid')
        }
      }
      if (!record.lifeTaskReview) record.lifeTaskReview = reviewVoaLifeTaskDialogue(record, context.source, context.now()) ?? undefined
      if (!record.lifeTaskReview) context.summary.nextGates.push('life-task-review-required')
      eligible++; context.summary.eligibleSegments++
    } else if (quality.status !== 'quarantined') itemGates.add('lesson-enrichment-required')
    await context.call('save-segment', { itemId: item.id, revision: item.revision, record })
  }
  context.summary.itemsProcessed++
  context.summary.nextGates.push(...itemGates)
  await context.call('finish-item', { itemId: item.id, revision: item.revision, status: itemGates.size ? 'awaiting-analysis' : eligible ? 'eligible' : 'quarantined',
    reasons: [...itemGates], processVersion: context.processVersion })
}

/** Entry for a server-authenticated scheduler. Never expose the supplied admin client or provider callbacks to browsers. */
export async function runContentRefresh(options: ContentTaskRefreshOptions): Promise<ContentTaskRefreshSummary> {
  const now = options.now ?? Date.now
  if (!finite(now()) || now() <= 0) fail('invalid-content-clock')
  const bound = (value: number | undefined, fallback: number, max: number) => {
    const selected = value ?? fallback
    if (!Number.isInteger(selected) || selected < 1 || selected > max) fail('invalid-worker-limit')
    return selected
  }
  const maxSources = bound(options.limits?.sources, Math.min(10, ALLOWLISTED_CONTENT_SOURCES.length), 10)
  const maxEpisodes = bound(options.limits?.episodesPerSource, 2, 10)
  const maxSegments = bound(options.limits?.segmentsPerEpisode, 6, 20)
  const maxItems = bound(options.limits?.feedItems, 25, 100)
  const maxAudio = bound(options.limits?.audioBytes, 64 * 1024 * 1024, 64 * 1024 * 1024)
  if (options.audioAcquisition !== undefined && !['complete-v1', 'mpeg-prefix-v1'].includes(options.audioAcquisition)) fail('invalid-audio-acquisition')
  const maxAudioItems = options.audioAcquisition === 'mpeg-prefix-v1' || options.limits?.audioItemsPerRun !== undefined
    ? bound(options.limits?.audioItemsPerRun, 1, 10) : Infinity
  const audioWorkItems = new Set<string>()
  const runMs = bound(options.limits?.runMs, 90_000, 120_000)
  if (options.voaPilot && !['metadata', 'probe-audio', 'disabled'].includes(options.voaPilot)) fail('invalid-voa-pilot-mode')
  const summary: ContentTaskRefreshSummary = { runId: crypto.randomUUID(), sourcesClaimed: 0, sourcesSkipped: 0, feedsFetched: 0,
    feedsUnchanged: 0, itemsDiscovered: 0, itemsProcessed: 0, segmentsSaved: 0, eligibleSegments: 0,
    nextGates: [], recommendations: [], errors: [], networkConstraints: [], inventory: null, voaPilot: [],
    refreshSelection: { sourceIds: [], basis: 'life-task-deficit-and-source-rotation-v1', notices: [] } }
  const owner = await rpc<{ ownerId: string | null }>(options.adminClient, 'owner', { ownerId: options.ownerId })
  const audioStore = options.audioStore ?? createSupabaseContentAudioStore(options.adminClient)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timer = setTimeout(cancel, runMs)
  const processVersion = `${options.analyzerVersion ?? 'no-analyzer'}/${options.transcriberVersion ?? 'no-stt'}${options.audioAcquisition === 'mpeg-prefix-v1' ? '/mpeg-prefix-v1' : ''}`
  const suppliedSources = (options.sources ?? ALLOWLISTED_CONTENT_SOURCES).filter(source =>
    (!options.sourceIds || options.sourceIds.includes(source.id)) && (!options.voaPilotOnly || source.id === 'voa-everyday-grammar'))
  const updateInventory = async () => {
    if (!owner.ownerId) { summary.nextGates.push('content-single-owner-required'); return }
    try {
      summary.inventory = await readOwnerContentTaskInventory({ adminClient: options.adminClient, ownerId: owner.ownerId,
        profile: options.profile, sources: options.sources, now, lowWater: options.inventoryLowWater })
    } catch (error) { summary.inventory = null; summary.nextGates.push(codeOf(error)) }
  }
  try {
    await updateInventory()
    summary.refreshSelection = planContentSourceRefresh({ sources: suppliedSources, inventory: summary.inventory, limit: maxSources, now: now() })
    if (Number.isFinite(maxAudioItems)) {
      const requested = summary.refreshSelection.sourceIds
      const ordered = await abortable(rpc<string[]>(options.adminClient, 'order', { sourceIds: requested }, 'content_audio_work'), controller.signal)
      if (!Array.isArray(ordered) || ordered.length !== requested.length || new Set(ordered).size !== ordered.length ||
        ordered.some(id => !requested.includes(id))) fail('invalid-content-work-order')
      summary.refreshSelection = { ...summary.refreshSelection, sourceIds: ordered, basis: 'least-recent-audio-work-with-inventory-ties-v1' }
    }
    const sources = summary.refreshSelection.sourceIds.map(id => suppliedSources.find(source => source.id === id)!)
    for (const configuredSource of sources) {
      if (audioWorkItems.size >= maxAudioItems) { summary.nextGates.push('content-audio-batch-deferred'); break }
      const source = structuredClone(configuredSource)
      if (controller.signal.aborted) { summary.nextGates.push('content-run-timeout-or-cancelled'); break }
      const policyHash = await digest(JSON.stringify(source.rights))
      if (!source.enabled || source.rights.status !== 'verified') {
        summary.nextGates.push('source-rights-recheck-required'); summary.sourcesSkipped++; continue
      }
      const call = <T>(action: string, args: Record<string, unknown> = {}) => rpc<T>(options.adminClient, action, { ...args, sourceId: source.id, runId: summary.runId })
      const context: JobContext = { options, source, sourcePolicyHash: policyHash, ownerId: owner.ownerId, summary, now, controller, audioStore,
        maxAudio, maxSegments, processVersion, call,
        async beginAudioWork(item) {
          if (!Number.isFinite(maxAudioItems) || audioWorkItems.has(item.id)) return
          if (audioWorkItems.size >= maxAudioItems) fail('content-audio-batch-deferred')
          await abortable(rpc(options.adminClient, 'begin', { sourceId: source.id, runId: summary.runId,
            itemId: item.id, revision: item.revision }, 'content_audio_work'), controller.signal)
          // Count attempted work even if parsing/storage/provider later fails.
          // DB time orders the next run; a failed source cannot monopolize it.
          audioWorkItems.add(item.id)
        },
        async fetch(url, role, maxBytes, etag, modified, audioPrefixBytes) {
          const response = await (options.fetcher ?? fetchContentResource)({ url, source, role, maxBytes, etag, lastModified: modified, audioPrefixBytes, signal: controller.signal })
          // Injection is a trusted transport seam, but cannot bypass the caller's URL/size boundary accidentally.
          validateSourceUrl(response.finalUrl, source.urls[role])
          if (response.body.byteLength > maxBytes) fail('response-too-large')
          if (response.dnsPinning === 'deno-preflight-only') summary.networkConstraints.push('Deno fetch validates DNS before connecting but cannot pin that answer; deploy with controlled public-only egress or the Node pinned transport.')
          return response
        } }
      const canAnalyze = !options.voaPilotOnly && !!options.analyzeAudio && !budgetReady(context, 'content-analysis')
      let claimed = false
      let failed = false
      let retrySeconds = 3_600
      try {
        const configuration: unknown[] = [configuredSource, options.rightsPolicies ?? CONTENT_POLICY_EVIDENCE]
        if (source.id === 'voa-everyday-grammar') configuration.push(VOA_LESSON_CANDIDATES)
        const claim = await call<Claim>('claim', { source, configHash: await digest(JSON.stringify(configuration)), forcePoll: !!options.forcePoll, canAnalyze, processVersion })
        if (!claim.acquired) { summary.sourcesSkipped++; continue }
        claimed = true; summary.sourcesClaimed++
        if (audioStore && !options.voaPilotOnly) {
          const expired = await call<string[]>('retention')
          if (expired.length) { await audioStore.remove(expired); await call('retention-finish', { paths: expired }) }
        }
        let rightsStatus = claim.rights_status
        let rightsCheckedAt = claim.rights_checked_at ? Date.parse(claim.rights_checked_at) : 0
        // An explicit retry may recover a previously unavailable policy before its scheduled
        // backoff ends, but still performs the same full, baseline-bound verification.
        if (claim.rightsDue || options.forcePoll && rightsStatus !== 'verified') {
          const check = await revalidateContentRights({ source, fetcher: options.fetcher, evidence: options.rightsPolicies, now, signal: controller.signal })
          summary.networkConstraints.push(...check.networkConstraints)
          await call('rights-check', { check })
          if (check.status === 'verified') { rightsStatus = 'verified'; rightsCheckedAt = check.checkedAt }
          else if (check.status === 'changed') rightsStatus = 'changed'
          if (check.reason) summary.nextGates.push(check.reason)
        }
        if (rightsStatus !== 'verified' || !finite(rightsCheckedAt) || now() - rightsCheckedAt > source.rights.recheckAfterDays * 86_400_000) {
          summary.nextGates.push('source-rights-recheck-required'); continue
        }
        source.verifiedAt = rightsCheckedAt
        if (source.id === 'voa-everyday-grammar' && options.voaPilot !== 'disabled' && claim.feedDue) {
          const audits = await auditVoaLessonCandidates({ fetcher: options.fetcher, now, signal: controller.signal,
            rightsPolicies: options.rightsPolicies, probeAudio: options.voaPilot === 'probe-audio' })
          const items = await Promise.all(audits.map(async audit => {
            const episode = voaPilotEpisode(audit, source)
            return { id: await digest(JSON.stringify([source.id, episode.guid])),
              // Ignore retrieval time, optional probe mode and volatile page chrome. A changed script/audio URL/policy invalidates old segments.
              revision: await digest(JSON.stringify([episode.guid, episode.audioUrl, audit.transcriptSha256,
                [...new Set(audit.candidate.thirdPartyNotices.map(normalizeQuote))].sort(),
                audit.rights.evidence.map(evidence => evidence.observedHash)])), episode }
          }))
          summary.itemsDiscovered += (await call<{ changed: number }>('ingest', { items })).changed
          summary.voaPilot = audits.map(audit => ({ id: audit.candidate.id, checkedAt: audit.checkedAt,
            transcriptSha256: audit.transcriptSha256, audioProbed: !!audit.audioProbe, eligible: false }))
          summary.nextGates.push('voa-pilot-candidates-not-approved', ...audits.flatMap(audit => audit.nextGates))
        }
        if (options.voaPilotOnly) continue
        if (claim.feedDue) {
          const response = await context.fetch(source.feedUrl, 'feed', source.feedFormat === 'open-yap-preview-jsonl' ? 131_072 : PIPELINE_LIMITS.feedBytes, claim.etag, claim.last_modified)
          if (response.status === 429 || response.status === 503) {
            const after = response.retryAfter && /^\d+$/u.test(response.retryAfter) ? Number(response.retryAfter) :
              response.retryAfter ? (Date.parse(response.retryAfter) - now()) / 1000 : 3_600
            retrySeconds = finite(after) ? Math.min(604_800, Math.max(60, Math.ceil(after))) : 3_600
            fail('publisher-rate-limited')
          }
          if (response.status === 304) {
            if (!claim.etag && !claim.last_modified) fail('unexpected-feed-304')
            summary.feedsUnchanged++
            await call('poll', { status: 304, etag: response.etag ?? claim.etag, lastModified: response.lastModified ?? claim.last_modified, pollSeconds: source.cadenceHours * 3_600 })
          } else {
            const manifest = source.feedFormat === 'open-yap-preview-jsonl'
            const batch = (manifest ? parseOpenYapPreviewManifest : parseRssFeed)(decodeResource(response, manifest ? 'publisher-manifest' : 'feed'), source, { now: now(), maxItems })
            const items = await Promise.all(batch.episodes.map(async episode => ({ id: await digest(JSON.stringify([source.id, episode.guid])), revision: await digest(JSON.stringify(episode)), episode })))
            const saved = await call<{ changed: number }>('ingest', { items })
            summary.itemsDiscovered += saved.changed; summary.feedsFetched++
            await call('poll', { status: 200, etag: response.etag, lastModified: response.lastModified, feedHash: await digest(response.body),
              pollSeconds: source.cadenceHours * 3_600, heldItems: batch.quarantined.map(item => item.code) })
          }
        }
        const pendingWindow = await call<PendingItem[]>('pending', { canAnalyze, processVersion, limit: 10, acquisitionVersion: options.audioAcquisition ?? 'complete-v1' })
        const pending = pendingWindow.sort((a, b) => Number(b.episode.guid.startsWith('voa-pilot:')) - Number(a.episode.guid.startsWith('voa-pilot:')))
          .slice(0, maxEpisodes)
        for (const item of pending) {
          if (audioWorkItems.size >= maxAudioItems) { summary.nextGates.push('content-audio-batch-deferred'); break }
          try { await processItem(context, item) }
          catch (error) {
            const code = codeOf(error)
            if (code === 'content-lease-or-revision-lost') throw error
            summary.errors.push({ sourceId: source.id, code }); summary.nextGates.push(code)
            const awaiting = /unconfigured|required|budget-denied|cost-ceiling/u.test(code)
            await call('finish-item', { itemId: item.id, revision: item.revision, status: awaiting ? 'awaiting-analysis' : item.attempts >= 5 ? 'quarantined' : 'retry',
              reasons: [code], retrySeconds: Math.min(604_800, 60 * 2 ** Math.min(10, item.attempts)), processVersion })
          }
        }
      } catch (error) {
        failed = true
        const code = codeOf(error)
        summary.errors.push({ sourceId: source.id, code })
        summary.nextGates.push(code)
      } finally {
        if (claimed) {
          try { await call('release', { failed, retrySeconds }) } catch { summary.errors.push({ sourceId: source.id, code: 'content-lease-release-failed' }) }
        }
      }
    }
    if (owner.ownerId && !controller.signal.aborted && !options.voaPilotOnly) {
      summary.recommendations = await selectAndPersistContentLessons({ adminClient: options.adminClient, ownerId: owner.ownerId,
        profile: options.profile ?? defaultOwnerProfile, now, sources: options.sources, requestId: `refresh-${summary.runId}`, limit: 3 })
    }
    if (!controller.signal.aborted) await updateInventory()
    if (summary.inventory) summary.nextGates.push(...summary.inventory.notices)
    summary.nextGates.push(...summary.refreshSelection.notices)
    summary.nextGates = [...new Set(summary.nextGates)]
    summary.networkConstraints = [...new Set(summary.networkConstraints)]
    return summary
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel) }
}

function voaPilotEpisode(audit: VoaCandidateAudit, source: ContentSource): FeedEpisode & { candidateAudit: Omit<VoaCandidateAudit, 'rights'> } {
  const candidate = audit.candidate
  return { sourceId: source.id, guid: pilotGuid(candidate.id), title: candidate.title, pageUrl: candidate.pageUrl,
    // Registry identity is retained; candidateAudit explicitly identifies exact-page discovery, NOT an RSS item.
    feedUrl: source.feedUrl, audioUrl: candidate.audioUrl, audioMime: 'audio/mpeg',
    audioBytes: audit.audioProbe?.sourceBytes ?? null, durationSeconds: audit.audioProbe?.originalDurationSeconds ?? null,
    publishedAt: null, declaredLanguage: source.declaredLanguage, explicit: null,
    licenseNotice: candidate.thirdPartyNotices.length ? candidate.thirdPartyNotices.join('\n') : null,
    licenseDeclared: candidate.thirdPartyNotices.length > 0,
    attribution: candidate.attribution, transcripts: [],
    candidateAudit: { candidate, taskIntents: audit.taskIntents, taskCoverage: 'unknown', checkedAt: audit.checkedAt,
      pageSha256: audit.pageSha256, transcriptSha256: audit.transcriptSha256, audioProbe: audit.audioProbe,
      nextGates: audit.nextGates, networkConstraint: audit.networkConstraint } }
}

/** Executable no-paid pilot. It persists only the six exact metadata/script/probe snapshots,
 * revalidates policy, and releases its lease. Provider callbacks are not accepted or forwarded. */
export async function runVoaCandidatePilot(options: Pick<ContentTaskRefreshOptions, 'adminClient' | 'ownerId' | 'fetcher' | 'rightsPolicies' | 'now' | 'signal'> & { probeAudio?: boolean }): Promise<ContentTaskRefreshSummary> {
  const owner = await rpc<{ ownerId: string | null }>(options.adminClient, 'owner', {})
  if (!owner.ownerId || options.ownerId && options.ownerId !== owner.ownerId) fail('content-single-owner-required')
  return runContentRefresh({ adminClient: options.adminClient, ownerId: owner.ownerId, fetcher: options.fetcher,
    rightsPolicies: options.rightsPolicies, now: options.now, signal: options.signal, sourceIds: ['voa-everyday-grammar'],
    voaPilotOnly: true, voaPilot: options.probeAudio ? 'probe-audio' : 'metadata', forcePoll: true,
    limits: { sources: 1, runMs: 120_000 } })
}

export async function selectAndPersistContentLessons(options: SelectContentOptions): Promise<EligibleContentLesson[]> {
  const now = options.now ?? Date.now
  const count = options.limit ?? 3
  if (!Number.isInteger(count) || count < 1 || count > 10 || !options.requestId || options.requestId.length > 100) fail('invalid-recommendation-request')
  const rows = await rpc<CandidateWindow>(options.adminClient, 'candidates', { ownerId: options.ownerId, requestId: options.requestId })
  const previous = rows.recent.filter(row => row.request_id === options.requestId)
  if (previous.length) return previous.map(row => ({ ...row.lesson, recommendationId: row.id }))
  const sources = options.sources ?? ALLOWLISTED_CONTENT_SOURCES
  const ranked: EligibleContentLesson[] = []
  const priorities = new Map<string, number>()
  const nontechnical = new Set<string>()
  const inventory = buildContentTaskInventory({ ownerId: options.ownerId, rows, sources, profile: options.profile, now: now() })
  const fingerprints = new Set(options.profile.recentContentFingerprints ?? [])
  const recentSources = rows.recent.map(row => rows.candidates.find(candidate => candidate.id === row.segment_id)?.record.segment.sourceId).filter((id): id is string => !!id)
  for (const row of rows.candidates) {
    const record = row.record
    if (fingerprints.has(record.segment.contentFingerprint)) continue
    const checked = eligibleRecord(row, sources, { ...options.profile,
      recentSourceIds: [...(options.profile.recentSourceIds ?? []), ...recentSources] }, now())
    if (!checked) continue
    const { quality, context, review } = checked
    const tasks = review?.assessments.filter(assessment => assessment.outcome === 'supported').map(assessment => assessment.task) ?? []
    priorities.set(row.id, tasks.filter(task => inventory.tasks.find(stock => stock.task === task)?.needsAttention).length)
    // Topic heuristics guide variety only. They never enter the reviewed task counters.
    if (tasks.length || !quality.metrics.topics.includes('Technology') &&
      quality.metrics.topics.some(topic => topic !== 'Work')) nontechnical.add(row.id)
    const converted = toMaterial(record.segment, context, record.lesson!, now())
    ranked.push({ recommendationId: '', segmentId: row.id, material: converted.material, fit: quality.fit!,
      playback: record.clip!, timedSentences: converted.timedSentences,
      reason: `Observed human audio; ${tasks.length ? `reviewed task exchanges: ${tasks.join(', ')}` : 'life-task coverage unknown'}; ${quality.metrics.topics.join(', ') || 'topic unknown'}; difficulty/interest/fatigue and recent exposure considered.` })
    fingerprints.add(record.segment.contentFingerprint)
  }
  ranked.sort((a, b) => priorities.get(b.segmentId)! - priorities.get(a.segmentId)! ||
    Number(nontechnical.has(b.segmentId)) - Number(nontechnical.has(a.segmentId)) || b.fit - a.fit || a.segmentId.localeCompare(b.segmentId))
  const selected: EligibleContentLesson[] = []
  const usedSources = new Set<string>()
  const technicalLimit = Math.max(1, Math.floor(count / 2))
  let technicalCount = 0
  const add = (lesson: EligibleContentLesson) => {
    if (!nontechnical.has(lesson.segmentId)) {
      if (technicalCount >= technicalLimit) return false
      technicalCount++
    }
    selected.push(lesson)
    return true
  }
  for (const lesson of ranked) {
    const id = rows.candidates.find(row => row.id === lesson.segmentId)!.record.segment.sourceId
    if (!usedSources.has(id) && add(lesson)) usedSources.add(id)
    if (selected.length === count) break
  }
  for (const lesson of ranked) if (selected.length < count && !selected.includes(lesson)) add(lesson)
  if (!selected.length) return []
  const persisted = await rpc<{ id: string; lesson: EligibleContentLesson }[]>(options.adminClient, 'recommend', {
    ownerId: options.ownerId, requestId: options.requestId, lessons: selected,
  })
  return persisted.map(row => ({ ...row.lesson, recommendationId: row.id }))
}

/** Gateway supplies ownerId from its verified session. This records exposure, never a fabricated ability gain. */
export async function recordContentLearningUse(options: { adminClient: ContentAdminClient; ownerId: string; segmentId: string; eventId: string; event: 'started' | 'completed' | 'skipped' }): Promise<void> {
  if (!options.eventId || options.eventId.length > 100) fail('invalid-content-event-id')
  await rpc(options.adminClient, 'learning-use', { ownerId: options.ownerId, segmentId: options.segmentId, eventId: options.eventId, event: options.event })
}
