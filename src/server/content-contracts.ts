import type {
  AnalysisResult, BoundInspection, ContentSegment, ContentSource, FeedEpisode, Inspection, LearnerContentProfile,
  LessonEnrichment,
} from '../content/pipeline-types'
import type { Material } from '../domain/types'
import type { ContentFetcher } from './content-network'
import type { ContentPolicyEvidence } from './content-rights'

export interface ContentAdminClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
}
export interface ContentAudioStore {
  put(path: string, bytes: Uint8Array, mimeType: string): Promise<void>
  get(path: string): Promise<Uint8Array>
  remove(paths: string[]): Promise<void>
}
export interface ContentUsage { costUsd: number | null; units: number; unitName: string; provider: string; model: string }
export interface ContentBudget {
  reserve(input: { ownerId: string; requestId: string; fingerprint: string; purpose: 'content-analysis' | 'content-stt'; maxCostUsd: number }):
    Promise<{ reservationId: string; allowed: boolean; acquired: boolean; replay?: boolean }>
  settle(input: { reservationId: string; status: 'completed' | 'uncertain'; usage: ContentUsage | null }): Promise<void>
}
export interface ContentRightsRecord {
  sourcePolicyHash: string
  sourceId: string
  evidenceId: string
  checkedAt: number
  method: 'trusted-source-policy-and-audio-screen'
  thirdParty: 'none-detected' | 'separately-cleared' | 'uncertain'
  evidenceUrls: string[]
}
export interface ContentAudioInput {
  requestId: string
  requestFingerprint: string
  segment: ContentSegment
  /** Complete immutable stored episode. The adapter must decode and inspect the WHOLE requested interval. */
  audio: { bytes: Uint8Array; sha256: string; mimeType: string; objectPath: string }
  interval: { startSeconds: number; endSeconds: number }
  sourcePolicy: ContentSource['rights']
  sourcePolicyHash: string
  signal: AbortSignal
}
export interface ContentAudioResult {
  requestFingerprint: string
  audioSha256: string
  audioDurationSeconds: number
  inspectedStartSeconds: number
  inspectedEndSeconds: number
  facts: Partial<Inspection>
  rightsRecord: ContentRightsRecord
  lesson?: LessonEnrichment
  audioEvidence?: {
    providerRequestId: string; originalAudioSha256: string; submittedAudioSha256: string
    submittedStartSeconds: number; submittedEndSeconds: number; inspectedStartSeconds: number; inspectedEndSeconds: number
    timingBasis: string; heard: { startTime: number; endTime: number; body: string; speaker?: string }[]
  }
  usage: ContentUsage
}
export type ContentAudioAnalyzer = (input: ContentAudioInput) => Promise<ContentAudioResult>
export interface ContentSttInput {
  requestId: string; requestFingerprint: string; episode: FeedEpisode
  audio: ContentAudioInput['audio']; sourcePolicy: ContentSource['rights']; sourcePolicyHash: string; signal: AbortSignal
}
export interface ContentSttResult {
  audioSha256: string; requestFingerprint: string; audioDurationSeconds: number
  /** Official Podcasting 2.0 JSON format with numeric startTime AND endTime for every cue. */
  transcriptJson: string; provider: string; evidenceId: string; usage: ContentUsage
}
export type ContentTranscriber = (input: ContentSttInput) => Promise<ContentSttResult>
export interface ContentRefreshOptions {
  adminClient: ContentAdminClient
  fetcher?: ContentFetcher
  /** Trusted reviewed policy baselines only. Not a user/feed-supplied setting. */
  rightsPolicies?: readonly ContentPolicyEvidence[]
  audioStore?: ContentAudioStore
  analyzeAudio?: ContentAudioAnalyzer
  transcribe?: ContentTranscriber
  budget?: ContentBudget
  ownerId?: string
  profile?: LearnerContentProfile
  now?: () => number
  sources?: readonly ContentSource[]
  sourceIds?: readonly string[]
  analyzerVersion?: string
  transcriberVersion?: string
  costCeilings?: { analysisUsd: number; transcriptionUsd: number }
  /** Legacy HTTPS transcript reference origin only. New STT persists a non-fetchable database URN and needs no origin. */
  transcriptOrigin?: string
  limits?: { sources?: number; episodesPerSource?: number; segmentsPerEpisode?: number; feedItems?: number; audioBytes?: number; runMs?: number }
  forcePoll?: boolean
  signal?: AbortSignal
}
export interface ContentRefreshSummary {
  runId: string; sourcesClaimed: number; sourcesSkipped: number; feedsFetched: number; feedsUnchanged: number
  itemsDiscovered: number; itemsProcessed: number; segmentsSaved: number; eligibleSegments: number
  recommendations: EligibleContentLesson[]
  nextGates: string[]
  errors: { sourceId: string; code: string }[]
  networkConstraints: string[]
}
export interface PersistedContentSegment {
  segment: ContentSegment; inspection: BoundInspection | null; analysis: AnalysisResult | null
  artifact: { sha256: string; url: string; durationSeconds: number } | null
  objectPath: string | null; lesson: LessonEnrichment | null; material: Material | null
  quality: unknown; status: 'quarantined' | 'eligible'; rightsRecord: ContentRightsRecord | null
  audioEvidence?: ContentAudioResult['audioEvidence']
  /** Immutable analyzed clip; artifact above continues to identify the original episode. */
  clip?: ContentPlayback
}
export interface ContentPlayback {
  bucket: 'jove-content-audio'
  objectPath: string
  audioSha256: string
  startSeconds: number
  endSeconds: number
  sourceAudioSha256: string
  sourceStartSeconds: number
  sourceEndSeconds: number
  clipOriginSeconds: number
  timingBasis: 'complete-container' | 'mpeg-frame-count-with-preroll' | 'pcm-sample-count'
  mimeType: string
  byteLength: number
  durationSeconds: number
}
export interface EligibleContentLesson {
  recommendationId: string; segmentId: string; material: Material; fit: number
  playback: ContentPlayback
  timedSentences: ContentSegment['sentences']; reason: string
}
export interface SelectContentOptions {
  adminClient: ContentAdminClient; ownerId: string; profile: LearnerContentProfile; now?: () => number
  sources?: readonly ContentSource[]; limit?: number; requestId: string
}
