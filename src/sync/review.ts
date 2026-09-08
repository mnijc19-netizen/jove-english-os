import type { ReviewCard, StudyEvent } from '../domain/types'

/** Selection counters describe history; they are never an attempt's identity. */
export interface ReviewAttempt {
  cardId: string
  reps: number
  attemptId: string
  responseEventId: string
  draftId: string
  legacy?: boolean
  legacyCardIds?: string[]
}
export function hasReviewAttemptIdentity(value: unknown): boolean {
  return !!value && typeof value === 'object' && ['attemptId', 'responseEventId', 'draftId'].every(key => {
    const id = (value as Record<string, unknown>)[key]
    return typeof id === 'string' && id.length > 0 && id.length <= 1000
  })
}
export function reviewAttempt(cardId: string, reps: number): ReviewAttempt {
  const id = crypto.randomUUID()
  return { cardId, reps, attemptId: `review:${id}`, responseEventId: `review-response:${id}`, draftId: `review-draft:${id}` }
}
export function restoreReviewAttempt(value: unknown, aliases: Record<string, string> = {}): ReviewAttempt | undefined {
  if (!value || typeof value !== 'object') return
  const item = value as Record<string, unknown>
  if (typeof item.cardId !== 'string' || !Number.isSafeInteger(item.reps) || Number(item.reps) < 0) return
  const cardId = item.cardId, reps = Number(item.reps)
  const legacyCardIds = [...new Set([cardId, ...Object.keys(aliases).filter(id => canonicalReviewCard(id, aliases) === canonicalReviewCard(cardId, aliases)),
    ...(Array.isArray(item.legacyCardIds) ? item.legacyCardIds.filter((id): id is string => typeof id === 'string') : [])])]
  if (hasReviewAttemptIdentity(item)) {
    return { cardId, reps, attemptId: item.attemptId as string, responseEventId: item.responseEventId as string,
      draftId: item.draftId as string, ...(item.legacy === true ? { legacy: true, legacyCardIds } : {}) }
  }
  // Never replace an old durable counter ID with a new attempt before checking
  // its real evidence. This also reopens the original half-finished draft/audio.
  return { cardId, reps, attemptId: `review:${cardId}:${reps + 1}`, responseEventId: `review-response:${cardId}:${reps}`,
    draftId: `review-draft:${cardId}:${reps}`, legacy: true, legacyCardIds }
}
export function canonicalReviewCard(id: string, aliases: Record<string, string>): string {
  const seen = new Set<string>()
  while (aliases[id] && aliases[id] !== id && !seen.has(id)) { seen.add(id); id = aliases[id]! }
  return id
}
export function selectedReviewCard(item: ReviewAttempt, cards: ReviewCard[], aliases: Record<string, string>): ReviewCard | undefined {
  const id = canonicalReviewCard(item.cardId, aliases)
  return cards.find(card => canonicalReviewCard(card.id, aliases) === id)
}
export function reviewAttemptCompleted(item: ReviewAttempt, events: StudyEvent[], cardAliases: Record<string, string>, eventAliases: Record<string, string[]>): boolean {
  // Other old card IDs with the same chunk/modality can have independent attempts
  // at this counter. Their evidence must never finish this selected occurrence.
  const ids = new Set([item.attemptId, ...(eventAliases[item.attemptId] ?? [])])
  return events.some(event => event.type === 'review' && typeof event.data?.cardId === 'string'
    && canonicalReviewCard(event.data.cardId, cardAliases) === canonicalReviewCard(item.cardId, cardAliases)
    && (event.data.attemptId === item.attemptId || ids.has(event.id)))
}
