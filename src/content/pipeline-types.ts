import type { MaterialChunk } from '../domain/types'

/** Seconds are media offsets; dates in this module are epoch milliseconds. */
export type TranscriptFormat = 'json' | 'vtt' | 'srt'
export type ResourceRole = 'feed' | 'page' | 'audio' | 'transcript'
export interface UrlRule { origin: string; pathPrefix: string; query?: 'hpr-file' | 'voa-zone'; pathShape?: 'art19-signed-audio' | 'open-yap-preview' | 'open-yap-cdn' }
export interface ContentSource {
  id: string
  name: string
  enabled: boolean
  disabledReason?: string
  feedUrl: string
  /** Exact publisher manifest adapter, never a generic site crawler or an invented RSS feed. */
  feedFormat?: 'rss' | 'open-yap-preview-jsonl'
  homepage: string
  publisher: string
  topics: readonly string[]
  /** Publisher metadata, NEVER acoustic evidence about an individual speaker. */
  declaredLanguage: string | null
  cadenceHours: number
  supply?: 'continuing-feed' | 'archive-supplement'
  verifiedAt: number
  rights: {
    status: 'verified' | 'uncertain'
    license: 'CC-BY-SA-4.0' | 'CC-BY-4.0' | 'CC0-1.0' | 'VOA-public-domain' | 'unknown'
    evidenceUrls: readonly string[]
    attribution: string
    scope: string
    stream: boolean
    excerpt: boolean
    transcribe: boolean
    storeAudio: boolean
    redistribute: boolean
    shareAlike: boolean
    recheckAfterDays: number
  }
  urls: Record<ResourceRole, readonly UrlRule[]>
  /** Only a publisher-specific, verified URL rule; never crawl linked pages. */
  transcriptDiscovery: 'podcasting2' | 'hpr-srt' | 'none-stt'
  examples: readonly { episodeUrl: string; transcriptUrl: string; format: TranscriptFormat }[]
  notes: readonly string[]
}
export interface TranscriptReference {
  url: string; format: TranscriptFormat; language: string | null
  origin: 'publisher-feed' | 'publisher-template' | 'authorized-stt'
  derivation?: { audioSha256: string; audioDurationSeconds?: number; provider: string; processedAt: number; evidenceId: string }
}
export interface FeedEpisode {
  sourceId: string; guid: string; title: string; pageUrl: string; feedUrl: string
  audioUrl: string; audioMime: string; audioBytes: number | null
  publishedAt: number | null; durationSeconds: number | null
  declaredLanguage: string | null; explicit: boolean | null
  /** Publisher statements do not supersede the source's checked rights policy. */
  licenseNotice: string | null; licenseDeclared?: boolean; attribution: string
  transcripts: TranscriptReference[]
}
export interface FeedBatch {
  episodes: FeedEpisode[]
  quarantined: { itemIndex: number; code: string }[]
  totalItems: number
  deferredItems: number
}
export interface TranscriptCue {
  startSeconds: number; endSeconds: number; text: string; speaker: string | null
}
/** Exact publisher-page contracts, not automatically allowlisted sources or timed captions. */
export interface VoaLessonContract {
  id: string; pageUrl: string; mediaId: string; audioUrl: string; title: string
  potentialTasks: readonly string[]; limitations: readonly string[]
}
export interface VoaLessonCandidate {
  id: string; pageUrl: string; mediaId: string; audioUrl: string; title: string
  publisher: 'Voice of America'; attribution: string
  publisherTranscript: { text: string; timing: 'unknown'; binding: 'same-page-conversation-player'; alignment: 'unverified' }
  thirdPartyNotices: string[]; thirdPartyAudio: 'unknown'; humanAudio: 'unknown'
  potentialTasks: readonly string[]; limitations: readonly string[]
  status: 'candidate'; eligible: false; supply: 'archive-supplement'
}
export interface TimedTranscript {
  format: TranscriptFormat; reference: TranscriptReference; cues: TranscriptCue[]
  /** Publisher timestamps have not yet been checked against the audio. */
  alignment: 'unverified'
}
export interface TimedSentence extends TranscriptCue {
  cueIndices: number[]
  /** A cue may contain several sentences. Never interpolate internal timestamps. */
  timing: 'cue-boundaries'
  internalSentenceTiming: 'unknown' | 'not-needed'
}
export interface ContentSegment {
  id: string
  episodeFingerprint: string
  contentFingerprint: string
  timingFingerprint: string
  sourceId: string
  episode: FeedEpisode
  transcriptReference: TranscriptReference
  startSeconds: number
  endSeconds: number
  durationSeconds: number
  transcript: string
  sentences: TimedSentence[]
  provenance: {
    publisher: string; license: string; licenseEvidenceUrls: readonly string[]
    attribution: string; changes: string; retrievedAt: number
  }
}
export interface SliceOptions {
  targetSeconds?: number; minSeconds?: number; maxSeconds?: number; maxGapSeconds?: number
  maxSegments?: number; retrievedAt: number
  /** Trusted measured byte-zero artifact coverage, not publisher/model duration.
   * Filters whole cues before grouping; does not approve their audio or rights. */
  audioCoverage?: { startSeconds: 0; endSeconds: number }
  /** Trusted backend configuration for its OWN transcript store; not supplied by a feed/model. */
  derivedTranscriptRules?: readonly UrlRule[]
  /** Exact trusted database item digest for a non-network STT transcript URN. */
  storedTranscriptId?: string
}
export interface SliceBatch {
  segments: ContentSegment[]
  quarantined: { startSeconds: number; endSeconds: number; code: string }[]
}
export type UnknownFact = { status: 'unknown'; reason: string }
export interface ObservationEvidence {
  id: string
  method: 'human-audio-review' | 'machine-audio-analysis' | 'machine-text-analysis'
  analyzer: string
  version: string
  assessedAt: number
  confidence: number
}
export type Fact<T> = UnknownFact | { status: 'observed'; value: T; evidence: ObservationEvidence }
export interface InspectionValues {
  humanSpeech: boolean
  englishSpeech: boolean
  accent: 'general-american' | 'other-english' | 'mixed'
  clarity: number
  noiseFraction: number
  musicFraction: number
  speakerCount: number
  transcriptAlignment: number
  coherent: boolean
  safe: boolean
  thirdPartyClear: boolean
  learningValue: boolean
}
export type Inspection = { [K in keyof InspectionValues]: Fact<InspectionValues[K]> }
export interface AudioArtifact {
  /** Digest of the ACTUAL analyzed audio bytes, after any dynamic ad insertion. */
  sha256: string; url: string; durationSeconds: number
}
export interface AnalysisRequest {
  segmentId: string; timingFingerprint: string; contentFingerprint: string
  /** Opaque canonical input binding; retain in the trusted adapter, do not ask a model to author it. */
  segmentSnapshot: string
  audioSha256: string; startSeconds: number; endSeconds: number
  transcript: string
  requiredFacts: readonly (keyof InspectionValues)[]
}
export interface AnalysisResult {
  segmentId: string; timingFingerprint: string; contentFingerprint: string
  segmentSnapshot: string
  audioSha256: string; startSeconds: number; endSeconds: number
  facts: Partial<Inspection>
}
/** Backend implements this with authenticated, budget-limited providers. */
export type ContentAnalysisHook = (request: Readonly<AnalysisRequest>) => Promise<AnalysisResult>
export interface BoundInspection {
  segmentId: string; timingFingerprint: string; contentFingerprint: string; audioSha256: string
  segmentSnapshot: string
  facts: Inspection
}
export interface TextMetrics {
  wordCount: number; sentenceCount: number; meanSentenceWords: number
  longWordFraction: number; contractionFraction: number
  /** Counts transcript words over the slice interval, NOT measured articulation rate. */
  transcriptWordsPerMinute: number
  lexicalCoverage: number | null
  difficulty: number
  difficultyBasis: 'uncalibrated-text-timing-heuristic-v1'
  topics: string[]
}
export interface LearnerContentProfile {
  targetDifficulty: number; fatigue: number; interests: readonly string[]
  knownWords?: readonly string[]
  requireGeneralAmerican?: boolean
  recentContentFingerprints?: readonly string[]
  recentSourceIds?: readonly string[]
}
export interface RightsUse {
  mode: 'stream' | 'private-excerpt' | 'redistribute-excerpt'
  attributionProvided: boolean
  changesIndicated: boolean
  shareAlikeAccepted: boolean
}
export interface QualityReport {
  status: 'quarantined' | 'eligible-machine-screened' | 'eligible-human-reviewed'
  reasons: string[]
  unknownFacts: (keyof InspectionValues)[]
  metrics: TextMetrics
  /** Null until the required observations pass. Not a calibrated audio score. */
  quality: number | null
  fit: number | null
  inspection: Inspection
}
export interface LessonEnrichment {
  question: string; answer: string; keywords: string[]; chunks: MaterialChunk[]
  /** Kept separate from acoustic review; supplied by a checked lesson-generation step. */
  evidenceId: string
}
