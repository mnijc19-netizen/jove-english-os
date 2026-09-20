import { z } from 'zod'
import type { Material, StudyEvent } from './types'
import { EXTERNAL_CATALOG_MAX_AGE } from '../content/external'
import { tadokuLevelSchema, tadokuLevels } from '../content/tadoku-catalog'

const id = z.string().min(1).max(300)
export const extensiveDraftSchema = z.strictObject({
  version: z.literal(1), revision: z.number().int().nonnegative(), stamp: z.string().uuid(), taskId: id, minutes: z.number().int().min(1).max(150),
  // Nested materialId participates in existing sync/backup reference validation.
  book: z.strictObject({ materialId: z.string().regex(/^ja-tadoku-[1-9][0-9]{0,7}$/u) }),
  bookmark: z.string().max(500), note: z.string().max(2000), effort: z.enum(['hard', 'okay', 'easy']),
  minutesRead: z.number().int().min(0).max(150), spentMinutes: z.number().int().min(0).max(150),
  outcome: z.enum(['continue', 'finished']), switched: z.array(id).max(500), savedAt: z.number().int().nonnegative().optional(),
  syncReadingConflicts: z.array(id).optional(),
  syncRecovery: z.strictObject({ sourceSessionId: id, rootSessionId: id, sourceDeviceId: id, sourceVersion: id }).optional(),
}).refine(d => d.minutesRead + d.spentMinutes <= d.minutes)
export type ExtensiveDraft = z.infer<typeof extensiveDraftSchema>
export const extensiveObservationSchema = z.strictObject({
  materialId: id, level: tadokuLevelSchema, effort: z.enum(['hard', 'okay', 'easy']),
  outcome: z.enum(['continue', 'finished', 'too-hard', 'not-interesting', 'unavailable']),
  minutesRead: z.number().int().min(0).max(150), bookmark: z.string().max(500), note: z.string().max(2000),
  playbackObserved: z.literal(false), comprehensionVerified: z.literal(false),
})
const day = 86400000, levels = tadokuLevels
export function extensiveHistory(events: readonly StudyEvent[], now: number) {
  return events.flatMap(event => {
    const data = extensiveObservationSchema.safeParse(event.data)
    return event.type === 'JAPANESE_EXTENSIVE_READING' && event.source === 'self-report' && event.sessionId
      && event.timestamp <= now && event.timestamp > 0 && data.success ? [{ event, data: data.data }] : []
  }).sort((a, b) => a.event.timestamp - b.event.timestamp || a.event.id.localeCompare(b.event.id))
}
/** Comfort adapts recommendations only; it is never a skill/proficiency score.
 * Three distinct easy books across two days permit ONE harder-level trial.
 * This is a conservative product heuristic, not a universal research threshold. */
export function nextJapaneseBook(materials: readonly Material[], events: readonly StudyEvent[], now: number, exclude: readonly string[] = []) {
  const history = extensiveHistory(events, now), latest = history.at(-1)
  const lastRead = history.findLast(h => ['continue', 'finished'].includes(h.data.outcome) && h.data.minutesRead > 0)?.event.timestamp ?? 0
  if (new Set(history.filter(h => h.data.outcome === 'unavailable' && h.event.timestamp > Math.max(now - day, lastRead))
    .map(h => h.data.materialId)).size >= 2) return undefined
  const available = materials.filter((m): m is Material & { externalReading: Extract<NonNullable<Material['externalReading']>, { publisher: 'NPO 多言語多読' }> } => m.language === 'ja' && m.approved && m.externalReading?.publisher === 'NPO 多言語多読'
    && m.externalReading.checkedAt <= now + 300000 && m.externalReading.checkedAt > now - EXTERNAL_CATALOG_MAX_AGE && !exclude.includes(m.id))
  const cooldown = new Set(history.filter(h => ['too-hard', 'not-interesting', 'unavailable'].includes(h.data.outcome)
    && h.event.timestamp > now - 30 * day).map(h => h.data.materialId))
  const candidates = available.filter(m => !cooldown.has(m.id))
  if (latest?.data.outcome === 'continue' && latest.data.effort !== 'hard') {
    const book = candidates.find(m => m.id === latest.data.materialId)
    if (book) return { book, continuing: true, trial: false, bookmark: latest.data.bookmark }
  }
  let target = latest ? levels.indexOf(latest.data.level) : 0, trial = false
  if (latest?.data.effort === 'hard' || latest?.data.outcome === 'too-hard') target = Math.max(0, target - 1)
  else if (latest) {
    const since = history.findLastIndex(h => h.data.level !== latest.data.level || h.data.effort !== 'easy'
      || h.data.outcome !== 'finished' || h.data.minutesRead < 1)
    const easy = history.slice(since + 1)
    if (new Set(easy.map(h => h.data.materialId)).size >= 3 && new Set(easy.map(h => Math.floor(h.event.timestamp / day))).size >= 2) {
      target = Math.min(levels.length - 1, target + 1); trial = target > levels.indexOf(latest.data.level)
    }
  }
  const finished = new Set(history.filter(h => h.data.outcome === 'finished').map(h => h.data.materialId))
  const pool = candidates.filter(m => levels.indexOf(m.externalReading!.level) <= target)
  pool.sort((a, b) => Number(finished.has(a.id)) - Number(finished.has(b.id))
    || levels.indexOf(b.externalReading!.level) - levels.indexOf(a.externalReading!.level)
    || Number(a.id.slice(10)) - Number(b.id.slice(10)))
  const book = pool[0]
  return book ? { book, continuing: false, trial: trial && levels.indexOf(book.externalReading!.level) === target, bookmark: '' } : undefined
}
