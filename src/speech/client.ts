import { cloudClient } from '../cloud/client'
import { referenceVoiceEligible } from './feedback'
import type { ReferenceVoiceReview } from './feedback'
import { normalizeAzureAssessment } from './normalize'
import { assertSafeSpeechObject, validateAcousticRequest } from './schemas'
import { inspectAssessmentWav } from './wav'
import { SPEECH_LIMITS, SpeechError } from './types'
import type { AcousticAssessment, AssessmentContext, SpeechErrorCode, SpeechUsage } from './types'
import { MAX_REFERENCE_AUDIO_BYTES, parseReviewedReference, referenceAudioHash, referenceAudioMime, type ReviewedReference } from './references'
import { createSpeechSession, SpeechSignInRequired, withSpeechSession, type SpeechAuth } from './session'

export interface PronunciationReference {
  id: string
  text: string
  /** Review metadata only: never used as a browser or server download target. */
  audioUrl: string
  audioSha256: string
  revokedAt?: string | null
  voiceReview: ReferenceVoiceReview | null
}
export interface PronunciationAttempt { attemptId: string; recordingId: string; referenceId: string }
export interface SpeechClientRequest extends PronunciationAttempt {
  /** Used for response correlation only. Never uploaded to the function. */
  referenceText: string
  audioWav: Uint8Array
}
export type SpeechClientErrorCode = SpeechErrorCode | 'NOT_CONFIGURED' | 'SIGN_IN_REQUIRED' | 'BUDGET' | 'REQUEST_PENDING' | 'REQUEST_CONFLICT' | 'REFERENCE'
export type BrowserAssessmentResult = { ok: true; assessmentId: string; assessedAt?: number; assessment: AcousticAssessment; usage: SpeechUsage[] } | {
  ok: false; error: { code: SpeechClientErrorCode; message: string; recoverable: true; retryable: boolean }; usage: SpeechUsage[]; retryAsNewAttempt?: boolean
}
export type EvaluatedPronunciation = Extract<BrowserAssessmentResult, { ok: true }>
export interface SpeechCloudConnection {
  auth: SpeechAuth
  functions: { invoke: (name: string, options: { method: 'POST'; body: FormData | { action: 'references' } | { action: 'reference-audio'; referenceId: string } | ({ action: 'recover' } & PronunciationAttempt); headers: Record<string, string>; signal: AbortSignal }) => Promise<{ data: unknown; error: unknown; response?: Response }> }
}
export const SPEECH_CLIENT_TIMEOUT_MS = 75000
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
const serverCodes: SpeechErrorCode[] = ['INVALID_REQUEST', 'INVALID_AUDIO', 'UNSUPPORTED', 'SERVER_ONLY', 'CONFIGURATION', 'CANCELLED', 'TIMEOUT', 'NETWORK', 'AUTH', 'RATE_LIMIT', 'UNAVAILABLE', 'PROVIDER_ERROR', 'MALFORMED_RESPONSE', 'NO_SPEECH', 'LOW_CONFIDENCE', 'NO_EVIDENCE']
function failure(code: SpeechClientErrorCode, usage: SpeechUsage[] = []): Extract<BrowserAssessmentResult, { ok: false }> {
  const message = code === 'NOT_CONFIGURED' ? 'Pronunciation service is not connected yet. Your recording stays saved.'
    : code === 'SIGN_IN_REQUIRED' ? 'Sign in to your learning account in Settings, then retry your saved recording.'
      : code === 'BUDGET' ? 'The speech allowance is currently unavailable. Your recording stays saved; retry when the allowance is available.'
        : code === 'REQUEST_PENDING' ? 'This attempt is already recorded. Check again to recover its result; a separate service attempt may be billed again.'
          : code === 'REQUEST_CONFLICT' ? 'The saved attempt belongs to different input. Start a distinct attempt.'
            : code === 'REFERENCE' ? 'This reference is not currently approved. Your original recording remains saved.'
              : new SpeechError(code).message
  return { ok: false, error: { code, message, recoverable: true, retryable: serverCodes.includes(code as SpeechErrorCode) && new SpeechError(code as SpeechErrorCode).retryable }, usage }
}
export function pronunciationReferenceReady(reference: PronunciationReference | null | undefined): boolean {
  if (!reference || reference.revokedAt || !/^[a-f0-9]{64}$/.test(reference.audioSha256) || !safeId(reference.id) || typeof reference.text !== 'string' || !reference.text.trim() || new TextEncoder().encode(reference.text).length > SPEECH_LIMITS.maxReferenceBytes || [...reference.text].some(c => c.charCodeAt(0) < 32 || c === '<' || c === '>') || !reference.voiceReview || !referenceVoiceEligible(reference.voiceReview)) return false
  try {
    const audio = new URL(reference.audioUrl, typeof location === 'undefined' ? 'https://local.invalid/' : location.href)
    return Boolean(reference.audioUrl.trim()) && ['http:', 'https:', 'blob:'].includes(audio.protocol) && !audio.username && !audio.password
  } catch { return false }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpeechError('MALFORMED_RESPONSE')
  return value as Record<string, unknown>
}
function parseUsage(value: unknown): SpeechUsage[] {
  if (!Array.isArray(value) || value.length > 2) throw new SpeechError('MALFORMED_RESPONSE')
  const seen = new Set<string>()
  return value.map(item => {
    const entry = object(item)
    if (!['azure.speech.pronunciation', 'azure.speech.prosody'].includes(String(entry.service)) || seen.has(String(entry.service)) || !Number.isInteger(entry.requests) || Number(entry.requests) < 0 || Number(entry.requests) > 2 || typeof entry.submittedAudioSeconds !== 'number' || !Number.isFinite(entry.submittedAudioSeconds) || entry.submittedAudioSeconds < 0 || entry.submittedAudioSeconds > 60 || !Number.isInteger(entry.estimatedBillableSeconds) || Number(entry.estimatedBillableSeconds) < 0 || Number(entry.estimatedBillableSeconds) > 60 || entry.actualCostUsd !== null || !['not-submitted', 'unknown'].includes(String(entry.billingStatus))) throw new SpeechError('MALFORMED_RESPONSE')
    seen.add(String(entry.service))
    return { service: entry.service as SpeechUsage['service'], requests: entry.requests as number, submittedAudioSeconds: entry.submittedAudioSeconds, estimatedBillableSeconds: entry.estimatedBillableSeconds as number, actualCostUsd: null, billingStatus: entry.billingStatus as SpeechUsage['billingStatus'] }
  })
}
async function referenceHash(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.trim()))), n => n.toString(16).padStart(2, '0')).join('')
}
/** Accept only evidence correlated to the authenticated request; regenerate cues from retained raw fields. */
async function parseResponse(value: unknown, request: SpeechClientRequest, audioSeconds: number): Promise<BrowserAssessmentResult> {
  assertSafeSpeechObject(value)
  const result = object(value)
  const usage = parseUsage(result.usage)
  if (result.ok === false) {
    const code = object(result.error).code
    if (code === 'BUDGET' || code === 'BUDGET_EXCEEDED') return failure('BUDGET', usage)
    if (code === 'SIGN_IN') return failure('SIGN_IN_REQUIRED', usage)
    if (code === 'REQUEST_PENDING' || code === 'REQUEST_CONFLICT' || code === 'REFERENCE') return { ...failure(code, usage), retryAsNewAttempt: result.retryAsNewAttempt === true }
    if (code === 'RESULT_PENDING' || code === 'USAGE_PENDING') return failure('UNAVAILABLE', usage)
    if (!serverCodes.includes(code as SpeechErrorCode)) throw new SpeechError('MALFORMED_RESPONSE')
    return { ...failure(code as SpeechErrorCode, usage), ...(result.retryAsNewAttempt === true ? { retryAsNewAttempt: true } : {}) }
  }
  if (result.ok !== true || !safeId(result.assessmentId)) throw new SpeechError('MALFORMED_RESPONSE')
  const returned = object(result.assessment)
  if (returned.schemaVersion !== 1 || returned.provider !== 'azure-speech' || returned.locale !== 'en-US' || returned.method !== 'scripted-pronunciation-assessment' || returned.attemptId !== request.attemptId || returned.recordingId !== request.recordingId || returned.referenceId !== request.referenceId || returned.referenceSha256 !== await referenceHash(request.referenceText) || typeof returned.audioSeconds !== 'number' || Math.abs(returned.audioSeconds - audioSeconds) > 1 / 16000 || typeof returned.prosodyRequested !== 'boolean') throw new SpeechError('MALFORMED_RESPONSE')
  const context: AssessmentContext = { attemptId: request.attemptId, recordingId: request.recordingId, referenceId: request.referenceId, referenceSha256: returned.referenceSha256 as string, audioSeconds, prosodyRequested: returned.prosodyRequested }
  const assessment = normalizeAzureAssessment(returned.raw, context)
  if (result.assessedAt !== undefined && (typeof result.assessedAt !== 'number' || !Number.isSafeInteger(result.assessedAt) || result.assessedAt < 0)) throw new SpeechError('MALFORMED_RESPONSE')
  return { ok: true, assessmentId: result.assessmentId, assessment, usage, ...(typeof result.assessedAt === 'number' ? { assessedAt: result.assessedAt } : {}) }
}

export function createSpeechBrowserClient(connection: SpeechCloudConnection | null = cloudClient) {
  return {
    configured: connection !== null,
    session: (signal?: AbortSignal) => createSpeechSession(connection?.auth, signal),
    async recover(attempt: PronunciationAttempt & { referenceText: string }, external?: AbortSignal): Promise<EvaluatedPronunciation | null> {
      if (!connection) return null
      if (![attempt.attemptId, attempt.recordingId, attempt.referenceId].every(safeId) || typeof attempt.referenceText !== 'string' || new TextEncoder().encode(attempt.referenceText).length > SPEECH_LIMITS.maxReferenceBytes) throw new SpeechError('INVALID_REQUEST')
      const input = { ...attempt }
      return withSpeechSession(connection.auth, external, 15000, async (signal, session) => {
        const response = await connection.functions.invoke('speech-assess', { method: 'POST',
          body: { action: 'recover', attemptId: input.attemptId, recordingId: input.recordingId, referenceId: input.referenceId },
          headers: { Authorization: 'Bearer ' + session.access_token }, signal })
        if (response.response?.status === 404) return null
        if (response.error) throw new SpeechError('UNAVAILABLE')
        assertSafeSpeechObject(response.data)
        const seconds = object(object(response.data).assessment).audioSeconds
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < SPEECH_LIMITS.minSeconds || seconds > SPEECH_LIMITS.maxSeconds) throw new SpeechError('MALFORMED_RESPONSE')
        const result = await parseResponse(response.data, { ...input, audioWav: new Uint8Array() }, seconds)
        if (!result.ok) throw new SpeechError('MALFORMED_RESPONSE')
        return result
      })
    },
    async references(external?: AbortSignal): Promise<ReviewedReference[]> {
      if (!connection) return []
      return withSpeechSession(connection.auth, external, 15000, async (signal, session) => {
        const response = await connection.functions.invoke('speech-assess', { method: 'POST', body: { action: 'references' },
          headers: { Authorization: 'Bearer ' + session.access_token }, signal })
        if (response.error) throw new SpeechError('UNAVAILABLE')
        assertSafeSpeechObject(response.data)
        const rows = object(response.data).references
        if (!Array.isArray(rows) || rows.length > 100) throw new SpeechError('MALFORMED_RESPONSE')
        return rows.map(value => {
          const row = object(value)
          const ref = parseReviewedReference({ id: row.id, material_id: row.materialId, reference_text: row.text, audio_url: row.audioUrl,
            audio_sha256: row.audioSha256, source_url: row.sourceUrl, rights_evidence: row.rightsEvidence, reviewed_at: row.reviewedAt,
            voice_review: row.voiceReview, revoked_at: row.revokedAt })
          if (ref.revokedAt) throw new SpeechError('MALFORMED_RESPONSE')
          return ref
        })
      })
    },
    async referenceAudio(reference: PronunciationReference, external?: AbortSignal): Promise<Blob> {
      if (!connection) throw new SpeechError('CONFIGURATION')
      const snapshot = { ...reference, voiceReview: reference.voiceReview ? { ...reference.voiceReview } : null }
      if (!pronunciationReferenceReady(snapshot)) throw new SpeechError('INVALID_REQUEST')
      return withSpeechSession(connection.auth, external, 20000, async (signal, session) => {
        const response = await connection.functions.invoke('speech-assess', { method: 'POST',
          body: { action: 'reference-audio', referenceId: snapshot.id }, headers: { Authorization: 'Bearer ' + session.access_token }, signal })
        // This endpoint's 422 means the reviewed object is no longer usable.
        // Never display backend error text or signed URL details.
        if (response.error) throw new SpeechError(response.response?.status === 422 ? 'REFERENCE'
          : [401, 403].includes(response.response?.status ?? 0) ? 'AUTH' : 'UNAVAILABLE')
        assertSafeSpeechObject(response.data)
        const row = object(response.data)
        if (Object.keys(row).sort().join(',') !== 'audioBase64,audioSha256,byteLength,mimeType,referenceId' ||
          row.referenceId !== snapshot.id || row.audioSha256 !== snapshot.audioSha256 ||
          !Number.isInteger(row.byteLength) || Number(row.byteLength) < 12 || Number(row.byteLength) > MAX_REFERENCE_AUDIO_BYTES ||
          !['audio/wav', 'audio/mpeg'].includes(String(row.mimeType)) || typeof row.audioBase64 !== 'string' ||
          row.audioBase64.length > Math.ceil(MAX_REFERENCE_AUDIO_BYTES / 3) * 4 || row.audioBase64.length % 4 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(row.audioBase64)) throw new SpeechError('MALFORMED_RESPONSE')
        const bytes = Uint8Array.from(atob(row.audioBase64), char => char.charCodeAt(0))
        if (bytes.length !== row.byteLength || await referenceAudioHash(bytes) !== snapshot.audioSha256 ||
          referenceAudioMime(bytes) !== row.mimeType) throw new SpeechError('MALFORMED_RESPONSE')
        return new Blob([bytes], { type: row.mimeType as string })
      })
    },
    async assess(input: SpeechClientRequest, external?: AbortSignal): Promise<BrowserAssessmentResult> {
      if (external?.aborted) return failure('CANCELLED')
      if (!connection) return failure('NOT_CONFIGURED')
      try {
        // Snapshot before awaits; text only correlates the result, never supplies server policy.
        const request = validateAcousticRequest({ attemptId: input.attemptId, recordingId: input.recordingId,
          referenceId: input.referenceId, referenceText: input.referenceText, locale: 'en-US', audioWav: input.audioWav })
        const { durationSeconds } = inspectAssessmentWav(request.audioWav)
        return await withSpeechSession(connection.auth, external, SPEECH_CLIENT_TIMEOUT_MS, async (signal, session) => {
          const token = session.access_token
          if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(token)) throw new SpeechSignInRequired()
          const body = new FormData()
          body.set('attemptId', request.attemptId); body.set('recordingId', request.recordingId); body.set('referenceId', request.referenceId)
          body.set('audioWav', new Blob([new Uint8Array(request.audioWav)], { type: 'audio/wav' }), 'recording.wav')
          const response = await connection.functions.invoke('speech-assess', { method: 'POST', body, headers: { Authorization: 'Bearer ' + token }, signal })
          if (response.error) {
            if (response.response?.status === 401) return failure('SIGN_IN_REQUIRED')
            if (response.response?.headers.get('content-type')?.includes('application/json')) {
              try { const parsed = await parseResponse(await response.response.json(), request, durationSeconds); if (!parsed.ok) return parsed }
              catch { /* Only sanitized status-derived messages below. */ }
            }
            return failure(response.response?.status === 402 ? 'BUDGET' : response.response?.status === 403 ? 'AUTH' : response.response?.status === 429 ? 'RATE_LIMIT' : response.response ? 'UNAVAILABLE' : 'NETWORK')
          }
          return parseResponse(response.data, request, durationSeconds)
        })
      } catch (cause) {
        return failure(cause instanceof SpeechSignInRequired ? 'SIGN_IN_REQUIRED' : cause instanceof SpeechError ? cause.code : 'NETWORK')
      }
    },
  }
}
export const speechBrowserClient = createSpeechBrowserClient()
