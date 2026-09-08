import type { StudyEvent } from '../domain/types'
import type { EvaluatedPronunciation } from './client'

/** Only supported acoustic dimensions. Scripted fluency is NEVER spontaneous fluency. */
export function acousticEvents(result: EvaluatedPronunciation, sessionId: string, timestamp: number): StudyEvent[] {
  const a = result.assessment
  if (!result.ok || !result.assessmentId || !sessionId || !Number.isSafeInteger(timestamp) || timestamp < 0) return []
  return ([['accuracy', 'pronunciation'], ['prosody', 'prosody']] as const).flatMap(([metric, skill]) => {
    const score = a.scores[metric]
    if (score === null || !Number.isFinite(score) || score < 0 || score > 100) return []
    const key = metric === 'accuracy' ? 'AccuracyScore' : 'ProsodyScore'
    const first = a.raw.NBest[0]
    const nested = first.PronunciationAssessment?.[key]
    const raw = nested ?? first[key]
    if (raw !== score) return []
    return [{ id: `${result.assessmentId}-${skill}`, timestamp, sessionId, type: 'PRONUNCIATION_EVALUATED', source: 'acoustic' as const,
      skill, score: score / 100, modality: 'speaking' as const, prompted: true,
      data: { assessmentId: result.assessmentId, provider: a.provider, method: a.method, audioId: a.recordingId,
        referenceId: a.referenceId, referenceSha256: a.referenceSha256, duration: a.audioSeconds,
        scripted: true, calibrated: false, firstPass: false, metric, rawValue: score,
        providerPath: `NBest[0].${nested === undefined ? '' : 'PronunciationAssessment.'}${key}` } }]
  })
}

/** Monotonic observed intervals only; no planned minutes, hidden time, or long unattended gaps. */
export class ObservedPracticeClock {
  private last: number | null = null
  private enabled = false
  private milliseconds = 0
  sample(now: number, enabled: boolean): void {
    if (!Number.isFinite(now) || now < 0) return
    const delta = this.last === null ? 0 : now - this.last
    if (this.enabled && enabled && delta > 0 && delta <= 15000) this.milliseconds += delta
    this.last = now; this.enabled = enabled
  }
  takeSeconds(): number {
    const seconds = Math.min(7200, Math.floor(this.milliseconds / 1000))
    this.milliseconds -= seconds * 1000
    return seconds
  }
}
