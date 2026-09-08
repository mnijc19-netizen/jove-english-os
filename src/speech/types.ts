export const SPEECH_LOCALE = 'en-US' as const
export const SPEECH_LIMITS = Object.freeze({ minSeconds: 0.25, maxSeconds: 30, sampleRate: 16000, maxWavBytes: 960044, maxReferenceBytes: 2048, maxResponseBytes: 1048576 })

export type SpeechErrorCode = 'INVALID_REQUEST' | 'INVALID_AUDIO' | 'UNSUPPORTED' | 'SERVER_ONLY' | 'CONFIGURATION' | 'CANCELLED' | 'TIMEOUT' | 'NETWORK' | 'AUTH' | 'RATE_LIMIT' | 'UNAVAILABLE' | 'PROVIDER_ERROR' | 'MALFORMED_RESPONSE' | 'NO_SPEECH' | 'LOW_CONFIDENCE' | 'NO_EVIDENCE' | 'REFERENCE'
const messages: Record<SpeechErrorCode, string> = {
  REFERENCE: 'This reference is not currently approved. Your original recording remains saved.',
  INVALID_REQUEST: 'Check the reference and recording identifiers.', INVALID_AUDIO: 'Use a complete 0.25–30 second mono 16 kHz PCM16 WAV recording.',
  UNSUPPORTED: 'This assessment supports scripted en-US speech only.', SERVER_ONLY: 'Speech credentials can only be used on the server.', CONFIGURATION: 'The server speech service needs configuration.',
  CANCELLED: 'Assessment cancelled. The saved recording can be retried.', TIMEOUT: 'Assessment timed out. The saved recording can be retried.', NETWORK: 'Speech service could not be reached. Retry the saved recording.',
  AUTH: 'The server speech credentials were rejected.', RATE_LIMIT: 'Speech service is busy. Retry later.', UNAVAILABLE: 'Speech service is temporarily unavailable.', PROVIDER_ERROR: 'Speech service could not assess this recording.',
  MALFORMED_RESPONSE: 'Speech service returned an unusable response.', NO_SPEECH: 'No usable speech was detected. Listen to the recording and try again.', LOW_CONFIDENCE: 'Recognition evidence is uncertain. Check the recording and reference before retrying.', NO_EVIDENCE: 'No supported acoustic evidence was returned.',
}
export class SpeechError extends Error {
  readonly recoverable = true
  readonly retryable: boolean
  constructor(readonly code: SpeechErrorCode) {
    super(messages[code]); this.name = 'SpeechError'
    this.retryable = ['TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'UNAVAILABLE', 'PROVIDER_ERROR'].includes(code)
  }
}

export interface AcousticRequest {
  attemptId: string
  recordingId: string
  referenceId: string
  referenceText: string
  locale: typeof SPEECH_LOCALE
  audioWav: Uint8Array
  enableProsody?: boolean
}
export interface AssessmentContext {
  attemptId: string
  recordingId: string
  referenceId: string
  referenceSha256: string
  audioSeconds: number
  prosodyRequested: boolean
}
export interface AcousticScores {
  accuracy: number | null
  fluency: number | null
  completeness: number | null
  prosody: number | null
  pronunciation: number | null
}
export interface RawScores {
  AccuracyScore?: number
  FluencyScore?: number
  CompletenessScore?: number
  ProsodyScore?: number
  PronScore?: number
}
export interface RawUnit {
  Offset?: number
  Duration?: number
  AccuracyScore?: number
  PronunciationAssessment?: { AccuracyScore?: number }
}
export interface RawWord extends RawUnit {
  Word: string
  ErrorType?: 'None' | 'Omission' | 'Insertion' | 'Mispronunciation' | 'UnexpectedBreak' | 'MissingBreak' | 'Monotone'
  PronunciationAssessment?: NonNullable<RawUnit['PronunciationAssessment']> & { ErrorType?: RawWord['ErrorType'] }
  Phonemes?: (RawUnit & { Phoneme: string })[]
  Syllables?: (RawUnit & { Syllable: string })[]
}
export interface RawAssessment {
  RecognitionStatus: 'Success' | 0
  Offset: number
  Duration: number
  NBest: [{ Confidence: number; Display?: string; Lexical?: string; Words: RawWord[]; PronunciationAssessment?: RawScores } & RawScores]
}
export interface AcousticUnit {
  label: string
  accuracy: number | null
  offsetMs: number | null
  durationMs: number | null
  path: string
}
export interface AcousticWord extends AcousticUnit {
  errorType: RawWord['ErrorType'] | null
  phonemes: AcousticUnit[]
  syllables: AcousticUnit[]
}
export interface PriorityIssue {
  kind: 'word' | 'phoneme' | 'syllable' | 'fluency' | 'prosody'
  cue: string
  wordIndex: number | null
  provenance: { provider: 'azure-speech'; path: string; value: number | string }
}
export interface AcousticAssessment extends AssessmentContext {
  schemaVersion: 1
  provider: 'azure-speech'
  locale: typeof SPEECH_LOCALE
  method: 'scripted-pronunciation-assessment'
  /** Recognition confidence is a gate, never phoneme confidence or intelligibility. */
  recognitionConfidence: number
  scores: AcousticScores
  words: AcousticWord[]
  raw: RawAssessment
  issues: PriorityIssue[]
  limitations: string[]
}
export interface SpeechUsage {
  service: 'azure.speech.pronunciation' | 'azure.speech.prosody'
  requests: number
  submittedAudioSeconds: number
  estimatedBillableSeconds: number
  actualCostUsd: null
  billingStatus: 'not-submitted' | 'unknown'
}
export type AssessmentResult = { ok: true; assessment: AcousticAssessment; usage: SpeechUsage[] } | { ok: false; error: { code: SpeechErrorCode; message: string; recoverable: true; retryable: boolean }; usage: SpeechUsage[] }
