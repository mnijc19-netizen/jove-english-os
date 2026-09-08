import { referenceVoiceEligible, type ReferenceVoiceReview } from './feedback'
import { assertSafeSpeechObject } from './schemas'
import { SPEECH_LIMITS, SpeechError } from './types'
import type { PronunciationReference } from './client'

export const speechId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
export const MAX_REFERENCE_AUDIO_BYTES = 2_000_000
export async function referenceAudioHash(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), n => n.toString(16).padStart(2, '0')).join('')
}
/** Container hint only. The audited hash is the trust check; native media must still decode. */
export function referenceAudioMime(bytes: Uint8Array): 'audio/wav' | 'audio/mpeg' {
  if (bytes.length < 12 || bytes.length > MAX_REFERENCE_AUDIO_BYTES) throw new SpeechError('INVALID_AUDIO')
  const tag = (offset: number, count: number) => String.fromCharCode(...bytes.subarray(offset, offset + count))
  if (tag(0, 4) === 'RIFF' && tag(8, 4) === 'WAVE' && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 === bytes.length) return 'audio/wav'
  if (tag(0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return 'audio/mpeg'
  throw new SpeechError('INVALID_AUDIO')
}
/** Immutable service-authored review record. No demo defaults or inferred voice quality. */
export interface ReviewedReference extends PronunciationReference {
  materialId: string | null
  audioSha256: string
  reviewedAt: string
  sourceUrl: string
  rightsEvidence: string
  revokedAt: string | null
}
function httpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password }
  catch { return false }
}
export function parseReviewedReference(value: unknown): ReviewedReference {
  assertSafeSpeechObject(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpeechError('INVALID_REQUEST')
  const r = value as Record<string, unknown>
  if (!speechId(r.id) || (r.material_id !== null && !speechId(r.material_id)) || typeof r.reference_text !== 'string' ||
    !r.reference_text.trim() || r.reference_text !== r.reference_text.trim() || new TextEncoder().encode(r.reference_text).length > SPEECH_LIMITS.maxReferenceBytes ||
    [...r.reference_text].some(c => c.charCodeAt(0) < 32 || c === '<' || c === '>') ||
    !httpsUrl(r.audio_url) || !httpsUrl(r.source_url) || typeof r.audio_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.audio_sha256) ||
    typeof r.rights_evidence !== 'string' || !r.rights_evidence.trim() || r.rights_evidence.length > 2000 ||
    typeof r.reviewed_at !== 'string' || !Number.isFinite(Date.parse(r.reviewed_at)) ||
    (r.revoked_at !== null && (typeof r.revoked_at !== 'string' || !Number.isFinite(Date.parse(r.revoked_at)))) ||
    !r.voice_review || !referenceVoiceEligible(r.voice_review as ReferenceVoiceReview)) throw new SpeechError('INVALID_REQUEST')
  const review = r.voice_review as ReferenceVoiceReview
  return { id: r.id, materialId: r.material_id as string | null, text: r.reference_text, audioUrl: r.audio_url,
    audioSha256: r.audio_sha256, sourceUrl: r.source_url, rightsEvidence: r.rights_evidence, reviewedAt: r.reviewed_at,
    revokedAt: r.revoked_at as string | null, voiceReview: { locale: review.locale, kind: review.kind, rightsApproved: true,
      transcriptChecked: true, clearSingleSpeaker: true, naturalStressAndRhythm: true, generalAmericanReviewed: true,
      clippingOrIntrusiveNoise: false, reviewId: review.reviewId } }
}
