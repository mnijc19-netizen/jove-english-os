import type { AcousticAssessment, AcousticScores, PriorityIssue } from './types'

/** Thresholds select practice cues only; they are not validated ability cutoffs. */
export function selectPriorityIssues(assessment: Omit<AcousticAssessment, 'issues'>): PriorityIssue[] {
  const candidates: { rank: number; issue: PriorityIssue }[] = []
  const add = (rank: number, kind: PriorityIssue['kind'], cue: string, wordIndex: number | null, path: string, value: number | string) => {
    candidates.push({ rank, issue: { kind, cue, wordIndex, provenance: { provider: 'azure-speech', path, value } } })
  }
  assessment.words.forEach((word, i) => {
    const raw = assessment.raw.NBest[0].Words[i]
    const path = `NBest[0].Words[${i}]`
    const nestedError = raw.PronunciationAssessment?.ErrorType !== undefined
    if (word.errorType && word.errorType !== 'None') {
      const cue = word.errorType === 'Omission' ? 'Listen to the reference, check the skipped word, then repeat the whole sentence.'
        : word.errorType === 'Insertion' ? 'Compare the extra word with the reference, then repeat the whole sentence.'
          : ['UnexpectedBreak', 'MissingBreak', 'Monotone'].includes(word.errorType) ? 'Compare the reference rhythm and phrasing, then repeat the whole sentence.'
            : 'Replay this word in context, then repeat the whole sentence comfortably.'
      add(0, 'word', cue, i, `${path}.${nestedError ? 'PronunciationAssessment.' : ''}ErrorType`, word.errorType)
    }
    word.phonemes.forEach(p => { if (p.accuracy !== null && p.accuracy < 70) add(p.accuracy, 'phoneme', 'Listen to this sound in its word; retry the whole sentence. The provider flag is a practice cue.', i, p.path, p.accuracy) })
    word.syllables.forEach(s => { if (s.accuracy !== null && s.accuracy < 70) add(s.accuracy + 1, 'syllable', 'Replay this syllable in context, then retry the whole sentence.', i, s.path, s.accuracy) })
    if (word.accuracy !== null && word.accuracy < 70) add(word.accuracy + 2, 'word', 'Compare this word with the reference and retry the complete sentence.', i, word.path, word.accuracy)
  })
  for (const [dimension, key] of [['fluency', 'FluencyScore'], ['prosody', 'ProsodyScore']] as const) {
    const score = assessment.scores[dimension]
    if (score !== null && score < 70) {
      const nested = assessment.raw.NBest[0].PronunciationAssessment?.[key] !== undefined
      add(score + 3, dimension, dimension === 'fluency' ? 'Listen to the phrase groups and pauses, then repeat the whole sentence at a comfortable pace.' : 'Compare reference stress and intonation, then repeat the whole sentence without forcing an accent.', null, `NBest[0].${nested ? 'PronunciationAssessment.' : ''}${key}`, score)
    }
  }
  candidates.sort((a, b) => a.rank - b.rank)
  const selected: PriorityIssue[] = []
  for (const { issue } of candidates) {
    if (issue.wordIndex !== null && selected.some(s => s.wordIndex === issue.wordIndex)) continue
    selected.push(issue)
    if (selected.length === 3) break
  }
  // No supported problem => no invented correction, even though the normal repair flow is 1–3.
  return selected
}

export function compareAcousticAttempts(before: AcousticAssessment, after: AcousticAssessment): { comparable: boolean; reason: string; deltas: AcousticScores | null } {
  if (before.provider !== after.provider || before.locale !== after.locale || before.method !== after.method || before.referenceId !== after.referenceId || before.referenceSha256 !== after.referenceSha256 || before.prosodyRequested !== after.prosodyRequested || before.attemptId === after.attemptId || before.recordingId === after.recordingId) {
    return { comparable: false, reason: 'Use two different recordings of the same reference with the same assessment settings.', deltas: null }
  }
  const deltas = {} as AcousticScores
  for (const key of Object.keys(before.scores) as (keyof AcousticScores)[]) {
    const a = before.scores[key], b = after.scores[key]
    deltas[key] = a === null || b === null ? null : Math.round((b - a) * 100) / 100
  }
  return { comparable: true, reason: 'Provider score differences only. Listen A/B; microphone, noise and provider changes can affect results. This is prompted practice, not proof of spontaneous transfer.', deltas }
}

export interface ReferenceVoiceReview {
  locale: string
  kind: 'human' | 'synthetic'
  rightsApproved: boolean | null
  transcriptChecked: boolean | null
  clearSingleSpeaker: boolean | null
  naturalStressAndRhythm: boolean | null
  generalAmericanReviewed: boolean | null
  clippingOrIntrusiveNoise: boolean | null
  reviewId: string
}
/** These are external review facts, never inferred from a voice name or locale tag. */
export function referenceVoiceEligible(review: ReferenceVoiceReview): boolean {
  return review.locale === 'en-US' && ['human', 'synthetic'].includes(review.kind) && typeof review.reviewId === 'string' && /^[\w-]{1,100}$/.test(review.reviewId) && review.rightsApproved === true && review.transcriptChecked === true && review.clearSingleSpeaker === true && review.naturalStressAndRhythm === true && review.generalAmericanReviewed === true && review.clippingOrIntrusiveNoise === false
}
