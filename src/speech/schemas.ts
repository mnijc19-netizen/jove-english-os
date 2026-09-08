import { SPEECH_LIMITS, SPEECH_LOCALE, SpeechError } from './types'
import type { AcousticRequest, RawAssessment, RawScores, RawUnit, RawWord } from './types'

const forbidden = /^(?:__proto__|prototype|constructor|.*(?:api.?key|subscription.?key|authorization|access.?token|refresh.?token|password|secret|credentials?)|key|token)$/i
/** Reject dangerous keys before parsing, including in fields that would otherwise be stripped. */
export function assertSafeSpeechObject(value: unknown): void {
  let nodes = 0
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 20000 || depth > 16) throw new SpeechError('MALFORMED_RESPONSE')
    if (v === null || typeof v !== 'object') return
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new SpeechError('MALFORMED_RESPONSE')
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (forbidden.test(key) || descriptor.get || descriptor.set) throw new SpeechError('MALFORMED_RESPONSE')
      visit(descriptor.value, depth + 1)
    }
  }
  visit(value, 0)
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpeechError('MALFORMED_RESPONSE')
  return value as Record<string, unknown>
}
function number(value: unknown, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) throw new SpeechError('MALFORMED_RESPONSE')
  return value
}
function label(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || [...value].some(c => c.charCodeAt(0) < 32)) throw new SpeechError('MALFORMED_RESPONSE')
  return value
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new SpeechError('MALFORMED_RESPONSE')
  return value
}
function scores(input: Record<string, unknown>): RawScores {
  const result: RawScores = {}
  for (const key of ['AccuracyScore', 'FluencyScore', 'CompletenessScore', 'ProsodyScore', 'PronScore'] as const) {
    if (input[key] !== undefined) result[key] = number(input[key], 100)
  }
  return result
}
function unit(input: Record<string, unknown>): RawUnit {
  const result: RawUnit = {}
  for (const key of ['Offset', 'Duration'] as const) if (input[key] !== undefined) result[key] = number(input[key], 300000000, true)
  if (input.AccuracyScore !== undefined) result.AccuracyScore = number(input.AccuracyScore, 100)
  if (input.PronunciationAssessment !== undefined) {
    const nested = record(input.PronunciationAssessment)
    result.PronunciationAssessment = nested.AccuracyScore === undefined ? {} : { AccuracyScore: number(nested.AccuracyScore, 100) }
    if (result.AccuracyScore !== undefined && result.PronunciationAssessment.AccuracyScore !== undefined && result.AccuracyScore !== result.PronunciationAssessment.AccuracyScore) throw new SpeechError('MALFORMED_RESPONSE')
  }
  return result
}
const errorTypes = ['None', 'Omission', 'Insertion', 'Mispronunciation', 'UnexpectedBreak', 'MissingBreak', 'Monotone']
function errorType(value: unknown): RawWord['ErrorType'] {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !errorTypes.includes(value)) throw new SpeechError('MALFORMED_RESPONSE')
  return value as RawWord['ErrorType']
}
function word(value: unknown): RawWord {
  const input = record(value)
  const result: RawWord = { ...unit(input), Word: label(input.Word) }
  if (input.ErrorType !== undefined) result.ErrorType = errorType(input.ErrorType)
  if (input.PronunciationAssessment !== undefined) {
    const nested = record(input.PronunciationAssessment)
    result.PronunciationAssessment = { ...result.PronunciationAssessment, ...(nested.ErrorType === undefined ? {} : { ErrorType: errorType(nested.ErrorType) }) }
    if (result.ErrorType !== undefined && result.PronunciationAssessment.ErrorType !== undefined && result.ErrorType !== result.PronunciationAssessment.ErrorType) throw new SpeechError('MALFORMED_RESPONSE')
  }
  if (input.Phonemes !== undefined) result.Phonemes = list(input.Phonemes, 100).map(value => { const p = record(value); return { ...unit(p), Phoneme: label(p.Phoneme, 80) } })
  if (input.Syllables !== undefined) result.Syllables = list(input.Syllables, 100).map(value => { const s = record(value); return { ...unit(s), Syllable: label(s.Syllable, 80) } })
  return result
}

/** Allowlist of actual Azure REST flattened / SDK nested JSON, not an LLM or STT schema. */
export function parseAzureAssessment(value: unknown): RawAssessment {
  assertSafeSpeechObject(value)
  const input = record(value)
  if (['NoMatch', 'InitialSilenceTimeout', 'BabbleTimeout', 'EndOfDictation'].includes(String(input.RecognitionStatus))) throw new SpeechError('NO_SPEECH')
  if (input.RecognitionStatus === 'Error') throw new SpeechError('PROVIDER_ERROR')
  if (input.RecognitionStatus !== 'Success' && input.RecognitionStatus !== 0) throw new SpeechError('MALFORMED_RESPONSE')
  const duration = number(input.Duration, 300000000, true)
  if (!duration) throw new SpeechError('NO_SPEECH')
  const bests = list(input.NBest, 10)
  if (!bests.length) throw new SpeechError('NO_EVIDENCE')
  // Preserve Azure's first hypothesis; don't cherry-pick the largest score/confidence.
  const best = record(bests[0])
  if (best.Confidence === undefined) throw new SpeechError('LOW_CONFIDENCE')
  const confidence = number(best.Confidence, 1)
  if (confidence < 0.5) throw new SpeechError('LOW_CONFIDENCE')
  const flat = scores(best)
  const nested = best.PronunciationAssessment === undefined ? undefined : scores(record(best.PronunciationAssessment))
  if (nested) for (const key of Object.keys(flat) as (keyof RawScores)[]) if (nested[key] !== undefined && nested[key] !== flat[key]) throw new SpeechError('MALFORMED_RESPONSE')
  const words = best.Words === undefined ? [] : list(best.Words, 300).map(word)
  return {
    RecognitionStatus: input.RecognitionStatus, Offset: number(input.Offset, 300000000, true), Duration: duration,
    NBest: [{ Confidence: confidence, ...flat, ...(nested ? { PronunciationAssessment: nested } : {}), Words: words,
      ...(best.Display === undefined ? {} : { Display: label(best.Display, 4000) }), ...(best.Lexical === undefined ? {} : { Lexical: label(best.Lexical, 4000) }) }],
  }
}

export function validateAcousticRequest(input: AcousticRequest): AcousticRequest {
  try {
    const raw = record(input)
    // audio is a byte array, not JSON; inspect the remaining request without reading accessors.
    const descriptors = Object.getOwnPropertyDescriptors(raw)
    if (Object.values(descriptors).some(d => d.get || d.set)) throw new SpeechError('INVALID_REQUEST')
    const allowed = ['attemptId', 'recordingId', 'referenceId', 'referenceText', 'locale', 'audioWav', 'enableProsody']
    if (Object.keys(raw).some(key => !allowed.includes(key)) || Object.getPrototypeOf(raw) !== Object.prototype) throw new SpeechError('INVALID_REQUEST')
    if (raw.locale !== SPEECH_LOCALE) throw new SpeechError('UNSUPPORTED')
    for (const key of ['attemptId', 'recordingId', 'referenceId'] as const) if (typeof raw[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(raw[key])) throw new SpeechError('INVALID_REQUEST')
    if (typeof raw.referenceText !== 'string' || !raw.referenceText.trim() || new TextEncoder().encode(raw.referenceText).length > SPEECH_LIMITS.maxReferenceBytes || [...raw.referenceText].some(c => c.charCodeAt(0) < 32 || c === '<' || c === '>')) throw new SpeechError('INVALID_REQUEST')
    if (!(raw.audioWav instanceof Uint8Array) || raw.audioWav.byteLength > SPEECH_LIMITS.maxWavBytes) throw new SpeechError('INVALID_AUDIO')
    if (raw.enableProsody !== undefined && typeof raw.enableProsody !== 'boolean') throw new SpeechError('INVALID_REQUEST')
    return { ...input, referenceText: input.referenceText.trim(), audioWav: new Uint8Array(input.audioWav) }
  } catch (error) { throw error instanceof SpeechError && error.code !== 'MALFORMED_RESPONSE' ? error : new SpeechError('INVALID_REQUEST') }
}
