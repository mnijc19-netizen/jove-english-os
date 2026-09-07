import { evidenceWeight, orderedEvents } from '../domain/engine'
import type { Chunk, ErrorPattern, ReviewCard, StudyEvent } from '../domain/types'

export function projectChunks(chunks: Chunk[], events: StudyEvent[]): Chunk[] {
  const projected = new Map(chunks.map(chunk => [chunk.id, { ...chunk, readingStrength: 0, listeningStrength: 0, recallStrength: 0, productionStrength: 0, spontaneousUses: 0 }]))
  const seen = new Set<string>()
  for (const event of orderedEvents(events)) {
    const chunk = event.chunkId ? projected.get(event.chunkId) : undefined
    if (!chunk || !event.modality) continue
    const dimension = ({ recognition: 'readingStrength', listening: 'listeningStrength', recall: 'recallStrength', cloze: 'recallStrength', speaking: 'productionStrength', transfer: 'productionStrength' } as const)[event.modality]
    const skill = ({ recognition: 'chunkRecognition', listening: 'listeningWords', recall: 'vocabularyRecall', cloze: 'grammarProduction', speaking: 'chunkProduction', transfer: 'realWorld' } as const)[event.modality]
    const weight = evidenceWeight(event, skill)
    if (!weight) continue
    const key = `${chunk.id}:${dimension}`
    const alpha = seen.has(key) ? 0.25 * weight : 1
    chunk[dimension] = Math.round((chunk[dimension] + alpha * ((event.prompted ? Math.min(event.score!, 0.6) : event.score!) - chunk[dimension])) * 10_000) / 10_000
    seen.add(key)
    if (dimension === 'productionStrength' && !event.prompted && event.score! >= 0.6) chunk.spontaneousUses++
  }
  return [...projected.values()]
}

export function projectErrors(errors: ErrorPattern[], events: StudyEvent[], cards?: ReviewCard[]): ErrorPattern[] {
  const projected = new Map(errors.map(error => [error.id, { ...error, attempts: 0, failures: 0, spontaneousSuccesses: 0 }]))
  for (const event of orderedEvents(events)) {
    const errorId = event.data?.errorId
    const error = typeof errorId === 'string' ? projected.get(errorId) : undefined
    if (!error || event.source === 'self-report') continue
    if (event.type !== 'error-detected' && !Number.isFinite(event.score)) continue
    error.attempts++
    if (event.type === 'error-detected' || event.score! < 0.6) error.failures++
    else if (!event.prompted && event.contextId && event.data?.novelContext === true
      && (event.modality === 'speaking' || event.modality === 'transfer') && evidenceWeight(event)) error.spontaneousSuccesses++
    const nextDue = event.data?.nextDue
    error.nextReview = typeof nextDue === 'number' && Number.isFinite(nextDue) && nextDue >= event.timestamp
      ? nextDue
      : event.timestamp + (event.type === 'error-detected' || event.score! < 0.6 ? 600_000 : event.prompted ? 86_400_000 : 259_200_000)
  }
  // Error reminders follow the actual linked queues, including FSRS updates to just one modality.
  if (cards) for (const error of projected.values()) {
    const linked = cards.filter(card => card.errorId === error.id)
    if (linked.length) error.nextReview = Math.min(...linked.map(card => new Date(card.card.due).getTime()))
  }
  return [...projected.values()]
}
