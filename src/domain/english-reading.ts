import { z } from 'zod'
import type { Material, StudyEvent } from './types'
import { englishReadingLevelSchema, englishReadingLevels } from '../content/english-reading-catalog'
import { EXTERNAL_CATALOG_MAX_AGE } from '../content/external'

const id = z.string().min(1).max(300), time = z.number().int().nonnegative(), text = z.string().max(2000)
export const englishReadingReportSchema = z.strictObject({
  materialId: id, level: englishReadingLevelSchema, minutesRead: z.number().int().min(0).max(150),
  effort: z.enum(['hard', 'okay', 'easy']), outcome: z.enum(['finished', 'too-hard', 'not-interesting', 'unavailable', 'later']),
  response: text, application: text, readingObserved: z.literal(false), comprehensionVerified: z.literal(false),
  clientTimestamp: time.optional(),
})
export const englishRecallReportSchema = z.strictObject({
  materialId: id, readingEventId: id, readingEventKey: z.string().regex(/^[a-f0-9]{64}$/u), response: text, rating: z.enum(['forgot', 'partial', 'clear']),
  readingObserved: z.literal(false), comprehensionVerified: z.literal(false),
  clientTimestamp: time.optional(),
})
export const englishReadingDraftSchema = z.strictObject({
  version: z.literal(1), revision: z.number().int().nonnegative(), stamp: z.string().uuid(), taskId: id,
  minutes: z.number().int().min(1).max(150), minutesRead: z.number().int().min(0).max(150),
  mode: z.enum(['read', 'recall']), response: text, application: text, effort: z.enum(['hard', 'okay', 'easy']),
  source: z.strictObject({ readingEventId: id, readingEventKey: z.string().regex(/^[a-f0-9]{64}$/u), response: text, application: text, timestamp: time }).optional(),
  revealedAt: time.optional(), rating: z.enum(['forgot', 'partial', 'clear']).optional(),
  savedAt: time.optional(), outcome: z.enum(['finished', 'too-hard', 'not-interesting', 'unavailable', 'later']).optional(),
  syncReadingConflicts: z.array(id).optional(),
  syncRecovery: z.strictObject({ sourceSessionId: id, rootSessionId: id, sourceDeviceId: id, sourceVersion: id }).optional(),
}).refine(d => d.minutesRead <= d.minutes && (d.mode === 'recall') === !!d.source)
export type EnglishReadingDraft = z.infer<typeof englishReadingDraftSchema>
export type EnglishReadingMaterial = Material & { externalReading: Extract<NonNullable<Material['externalReading']>, { publisher: 'British Council' }> }
export function isEnglishReader(m: Material): m is EnglishReadingMaterial {
  return m.language === 'en' && m.externalReading?.publisher === 'British Council'
}
const day = 86400000
export function englishReadingHistory(events: readonly StudyEvent[], now: number) {
  return events.flatMap(event => {
    const data = englishReadingReportSchema.safeParse(event.data)
    return event.type === 'ENGLISH_READING_REPORT' && event.source === 'self-report' && event.sessionId
      && event.timestamp > 0 && event.timestamp <= now && data.success ? [{ event, data: data.data }] : []
  }).sort((a, b) => a.event.timestamp - b.event.timestamp || a.event.id.localeCompare(b.event.id, 'en'))
}
/** A bounded reminder of the learner's own saved meaning, not a publisher
 * comprehension test or an FSRS/CEFR score. Intervals are product defaults. */
export function dueEnglishReading(events: readonly StudyEvent[], now: number, materialId?: string) {
  return englishReadingHistory(events, now).filter(h => h.data.outcome === 'finished' && h.data.minutesRead > 0
    && h.data.response.trim().length >= 2 && (!materialId || h.data.materialId === materialId)).flatMap(h => {
    const reviews = events.flatMap(event => {
      const data = englishRecallReportSchema.safeParse(event.data)
      return event.type === 'ENGLISH_READING_RECALL' && event.source === 'self-report' && event.sessionId && data.success
        && data.data.readingEventId === h.event.id && data.data.materialId === h.data.materialId
        && event.timestamp > h.event.timestamp && event.timestamp <= now ? [{ event, data: data.data }] : []
    }).sort((a, b) => a.event.timestamp - b.event.timestamp || a.event.id.localeCompare(b.event.id, 'en'))
    const distinct = [...new Map(reviews.map(r => [r.event.sessionId!, r])).values()], last = distinct.at(-1)
    if (distinct.length >= 3 || now - h.event.timestamp > 90 * day) return []
    const due = (last?.event.timestamp ?? h.event.timestamp) + (!last || last.data.rating === 'forgot' ? 1 : last.data.rating === 'partial' ? 3 : 7) * day
    return due <= now ? [{ ...h, due }] : []
  }).sort((a, b) => a.due - b.due || a.event.id.localeCompare(b.event.id, 'en'))[0]
}
/** Publisher levels guide a conservative initial trial, never certification.
 * Comfort across different texts can adjust the next recommendation one step. */
export function nextEnglishReading(materials: readonly Material[], events: readonly StudyEvent[], now: number, target = 0.15) {
  const readers = materials.filter(isEnglishReader).filter(m => m.approved && m.externalReading.checkedAt <= now + 300000
    && m.externalReading.checkedAt > now - EXTERNAL_CATALOG_MAX_AGE)
  const history = englishReadingHistory(events, now), latest = history.at(-1)
  const due = dueEnglishReading(events, now), reviewMaterial = due && readers.find(m => m.id === due.data.materialId)
  if (due && reviewMaterial) return { material: reviewMaterial, review: due }
  const lastGood = history.findLast(h => h.data.outcome === 'finished')?.event.timestamp ?? 0
  if (new Set(history.filter(h => h.data.outcome === 'unavailable' && h.event.timestamp > Math.max(now - day, lastGood)).map(h => h.data.materialId)).size >= 2) return undefined
  const blocked = new Set(history.filter(h => h.data.outcome !== 'finished' && h.event.timestamp > now - (h.data.outcome === 'later' ? 1 : 30) * day).map(h => h.data.materialId))
  let level = latest ? englishReadingLevels.indexOf(latest.data.level) : Math.max(0, [0.15, 0.3, 0.5, 0.7, 0.85].findLastIndex(d => d <= target))
  if (latest?.data.effort === 'hard' || latest?.data.outcome === 'too-hard') level = Math.max(0, level - 1)
  else if (latest) {
    const boundary = history.findLastIndex(h => h.data.level !== latest.data.level || h.data.outcome !== 'finished' || h.data.effort !== 'easy')
    const easy = history.slice(boundary + 1).filter(h => h.data.minutesRead > 0)
    if (new Set(easy.map(h => h.data.materialId)).size >= 3 && new Set(easy.map(h => Math.floor(h.event.timestamp / day))).size >= 2) level = Math.min(4, level + 1)
  }
  const last = new Map(history.filter(h => h.data.outcome === 'finished').map(h => [h.data.materialId, h.event.timestamp]))
  const pool = readers.filter(m => !blocked.has(m.id) && englishReadingLevels.indexOf(m.externalReading.level) <= level)
    .sort((a, b) => Number(last.has(a.id)) - Number(last.has(b.id))
      || englishReadingLevels.indexOf(b.externalReading.level) - englishReadingLevels.indexOf(a.externalReading.level)
      || (last.get(a.id) ?? 0) - (last.get(b.id) ?? 0) || a.id.localeCompare(b.id, 'en'))
  return pool[0] ? { material: pool[0], review: undefined } : undefined
}
