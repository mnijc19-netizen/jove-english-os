import { assertSafeSpeechObject, parseAzureAssessment } from './schemas'
import { selectPriorityIssues } from './feedback'
import { SPEECH_LOCALE, SpeechError } from './types'
import type { AcousticAssessment, AcousticUnit, AssessmentContext, RawUnit } from './types'

/** Only call with a direct provider response in trusted server code, never posted client JSON. */
export function normalizeAzureAssessment(value: unknown, context: AssessmentContext): AcousticAssessment {
  assertSafeSpeechObject(context)
  const contextKeys = ['attemptId', 'recordingId', 'referenceId', 'referenceSha256', 'audioSeconds', 'prosodyRequested']
  if (!context || typeof context !== 'object' || Object.keys(context).some(key => !contextKeys.includes(key)) || typeof context.prosodyRequested !== 'boolean') throw new SpeechError('INVALID_REQUEST')
  for (const key of ['attemptId', 'recordingId', 'referenceId'] as const) {
    if (typeof context[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(context[key])) throw new SpeechError('INVALID_REQUEST')
  }
  const raw = parseAzureAssessment(value)
  const best = raw.NBest[0]
  const score = (key: 'AccuracyScore' | 'FluencyScore' | 'ProsodyScore' | 'CompletenessScore' | 'PronScore') => best.PronunciationAssessment?.[key] ?? best[key] ?? null
  if (!Number.isFinite(context.audioSeconds) || context.audioSeconds < 0.25 || context.audioSeconds > 30 || typeof context.referenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(context.referenceSha256)) throw new SpeechError('INVALID_REQUEST')
  // Azure offsets/durations use 100 ns ticks. Tolerate only 20 ms frame rounding.
  const end = (raw.Offset + raw.Duration) / 10000
  if (end > context.audioSeconds * 1000 + 20) throw new SpeechError('MALFORMED_RESPONSE')
  const makeUnit = (unit: RawUnit, label: string, path: string, omitted = false): AcousticUnit => {
    const limitTicks = (context.audioSeconds * 1000 + 20) * 10000
    // Validate each available bound independently; partial timestamps must not evade checks.
    if ((unit.Offset !== undefined && unit.Offset > limitTicks) || (unit.Duration !== undefined && unit.Duration > limitTicks) || (unit.Offset !== undefined && unit.Duration !== undefined && unit.Offset + unit.Duration > limitTicks)) throw new SpeechError('MALFORMED_RESPONSE')
    if (unit.Duration === 0 && !omitted) throw new SpeechError('NO_EVIDENCE')
    const nested = unit.PronunciationAssessment?.AccuracyScore !== undefined
    return { label, accuracy: unit.PronunciationAssessment?.AccuracyScore ?? unit.AccuracyScore ?? null, offsetMs: unit.Offset === undefined ? null : unit.Offset / 10000, durationMs: unit.Duration === undefined ? null : unit.Duration / 10000, path: `${path}.${nested ? 'PronunciationAssessment.' : ''}AccuracyScore` }
  }
  const words = best.Words.map((word, i) => {
    const path = `NBest[0].Words[${i}]`
    const errorType = word.PronunciationAssessment?.ErrorType ?? word.ErrorType ?? null
    const isOmitted = errorType === 'Omission'
    return { ...makeUnit(word, word.Word, path, isOmitted), ...(isOmitted ? { accuracy: null, offsetMs: null, durationMs: null } : {}), errorType,
      phonemes: isOmitted ? [] : (word.Phonemes ?? []).map((p, j) => makeUnit(p, p.Phoneme, `${path}.Phonemes[${j}]`)),
      syllables: isOmitted ? [] : (word.Syllables ?? []).map((s, j) => makeUnit(s, s.Syllable, `${path}.Syllables[${j}]`)),
    }
  })
  const scores = { accuracy: score('AccuracyScore'), fluency: score('FluencyScore'), completeness: score('CompletenessScore'), prosody: context.prosodyRequested ? score('ProsodyScore') : null, pronunciation: score('PronScore') }
  const hasUnits = words.some(w => w.errorType !== 'Omission' && (w.accuracy !== null || w.phonemes.some(p => p.accuracy !== null) || w.syllables.some(s => s.accuracy !== null)))
  if (!hasUnits && scores.accuracy === null && scores.fluency === null && scores.prosody === null) throw new SpeechError('NO_EVIDENCE')
  if (words.length && words.every(w => w.errorType === 'Omission' || w.durationMs === 0)) throw new SpeechError('NO_EVIDENCE')
  const assessment: AcousticAssessment = { ...context, schemaVersion: 1, provider: 'azure-speech', locale: SPEECH_LOCALE, method: 'scripted-pronunciation-assessment', recognitionConfidence: best.Confidence, scores, words, raw, issues: [], limitations: [
    'Provider estimates on a 0–100 scale, not calibrated intelligibility, proficiency, accent certification or a guaranteed learning outcome.',
    'Recognition confidence is not acoustic confidence. The 0.5 rejection gate and feedback cutoffs are conservative product choices.',
    'Missing fields stay unknown. Phoneme labels retain the provider alphabet; no IPA conversion is inferred.',
    'This is scripted prompted practice. Assess spontaneous transfer separately with unfamiliar content.',
  ] }
  if (scores.prosody === null) assessment.limitations.push(context.prosodyRequested ? 'Prosody was requested but not returned; availability is unknown for this response.' : 'Prosody was not requested.')
  if (!words.some(w => w.syllables.length)) assessment.limitations.push('Syllable evidence was not returned.')
  assessment.issues = selectPriorityIssues(assessment)
  return assessment
}
