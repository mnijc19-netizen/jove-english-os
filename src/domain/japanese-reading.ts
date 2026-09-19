import { z } from 'zod'
import type { StudySession } from './types'
import { japaneseReadings, type JapaneseReading } from '../content/japanese-reading'
import { japaneseKana } from '../content/japanese-kana'

const pair = z.tuple([z.string().max(200), z.string().max(200)])
export const japaneseReadingDraft = z.strictObject({
  version: z.literal(1), revision: z.number().int().nonnegative(), taskId: z.string(), minutes: z.number().int().min(1).max(150),
  meaning: pair, kana: pair, helped: z.boolean(), seen: z.boolean(), lockedAt: z.number().finite().nonnegative().optional(),
  note: z.string().max(2000), effort: z.enum(['hard', 'okay', 'easy']), dueAt: z.number().finite().nonnegative().optional(),
  syncReadingConflicts: z.array(z.string()).optional(),
  syncRecovery: z.strictObject({ sourceSessionId: z.string(), rootSessionId: z.string(), sourceDeviceId: z.string(), sourceVersion: z.string() }).optional(),
  sourcePractice: z.enum(['heard', 'unavailable']).optional(),
})
export type JapaneseReadingDraft = z.infer<typeof japaneseReadingDraft>
export function normalizeKana(text: string): string {
  return text.normalize('NFKC').trim().replace(/[\s。、「」・]/gu, '').replace(/[ァ-ヶ]/gu, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
}
export function japaneseReadingResult(reading: JapaneseReading, draft: JapaneseReadingDraft) {
  // Accept common contextual alternatives; this is written word reading only,
  // never evidence that a learner produced these sounds or the correct pitch.
  const alternatives: Record<string, string[]> = { 明日: ['あす', 'みょうにち'], 昨日: ['さくじつ'] }
  return {
    meaning: reading.questions.map((q, i) => draft.meaning[i] === q.answer),
    kana: reading.words.map((w, i) => reading.kana ? draft.kana[i]?.normalize('NFKC').trim() === w.reading
      : [w.reading, ...(alternatives[w.text] ?? [])].includes(normalizeKana(draft.kana[i] ?? ''))),
  }
}
const day = 86400000
export function japaneseReadingHistory(sessions: StudySession[], now: number, catalog = japaneseReadings) {
  return sessions.flatMap(session => {
    const reading = catalog.find(r => r.id === session.materialId), parsed = japaneseReadingDraft.safeParse(session.draft)
    if (session.kind !== 'japanese-reading' || !reading || !parsed.success || session.stage !== 'completed'
      || !session.completedAt || !Number.isFinite(session.completedAt) || session.completedAt > now || session.startedAt > session.completedAt
      || parsed.data.lockedAt === undefined || parsed.data.lockedAt < session.startedAt || parsed.data.lockedAt > session.completedAt
      || !parsed.data.dueAt || parsed.data.dueAt <= session.completedAt) return []
    return [{ session, reading, draft: parsed.data, result: japaneseReadingResult(reading, parsed.data) }]
  }).sort((a, b) => a.session.completedAt! - b.session.completedAt! || a.session.id.localeCompare(b.session.id))
}
/** Conservative editorial selection, not a validated proficiency test. Repeated
 * pages and supported answers cannot independently promote a reading band. */
export function nextJapaneseReading(sessions: StudySession[], now: number): (JapaneseReading & { trial: boolean }) | undefined {
  const history = japaneseReadingHistory(sessions, now), latest = new Map(history.map(h => [h.reading.id, h]))
  let band = 0
  for (let current = 0; current < 2; current++) {
    const fresh = new Map(history.filter(h => h.reading.band === current && !h.draft.helped && !h.draft.seen && h.result.meaning.every(Boolean)
      // Both help and locked feedback expose the answers. Recheck imported or
      // late-synced branches, excluding the current submission itself.
      && !sessions.some(s => {
        if (s.id === h.session.id || !['japanese-reading', 'japanese-reading-conflict'].includes(s.kind) || s.materialId !== h.reading.id) return false
        const prior = japaneseReadingDraft.safeParse(s.draft).data
        return prior && (prior.helped && s.startedAt <= h.draft.lockedAt!
          || prior.lockedAt !== undefined && prior.lockedAt < h.draft.lockedAt!)
      }))
      .map(h => [h.reading.id, h]))
    const days = new Set([...fresh.values()].map(h => new Date(h.draft.lockedAt!).toISOString().slice(0, 10)))
    if (fresh.size >= 3 && days.size >= 2) band = current + 1
  }
  // Exposure/comfort controls which texts can be practised, NOT which unseen
  // results count as calibration. Keep revisits at an explored band available
  // even if all first encounters there used support, and allow a later trial
  // of the next band after comfortable independent revisits on two days.
  let frontier = Math.max(band, 0, ...history.map(h => h.reading.band))
  for (let current = 0; current < 2; current++) {
    const comfortable = history.filter(h => h.reading.band === current && !h.draft.helped && h.draft.effort !== 'hard' && h.result.meaning.every(Boolean))
    const days = new Set(comfortable.map(h => new Date(h.draft.lockedAt!).toISOString().slice(0, 10)))
    const exhausted = japaneseReadings.filter(r => r.band === current).every(r => latest.has(r.id))
    if (exhausted && days.size >= 2 && new Set(comfortable.map(h => h.reading.id)).size >= 2) frontier = Math.max(frontier, current + 1)
  }
  const recentDifficult = history.filter(h => (h.draft.effort === 'hard' || !h.result.meaning.every(Boolean)) && h.session.completedAt! > now - 7 * day).at(-1)
  if (recentDifficult) frontier = Math.max(0, Math.min(frontier, recentDifficult.reading.band - 1))
  const due = [...latest.values()].filter(h => h.draft.dueAt! <= now && h.reading.band <= frontier)
    .sort((a, b) => a.draft.dueAt! - b.draft.dueAt!)
  // At most two due-text revisits in a row while an unseen eligible text exists.
  const fresh = japaneseReadings.find(r => r.band === frontier && !latest.has(r.id))
  const twoRevisits = history.length >= 2 && history.slice(-2).every(h => h.draft.seen)
  const selected = due.length && !(twoRevisits && fresh) ? due[0]!.reading : fresh
    ?? japaneseReadings.find(r => r.band < frontier && !latest.has(r.id)) ?? due[0]?.reading
  return selected ? { ...selected, trial: selected.band > band } : undefined
}
export function japaneseReadingDelay(reading: JapaneseReading, draft: JapaneseReadingDraft, sessions: StudySession[], now: number): number {
  const result = japaneseReadingResult(reading, draft)
  if (draft.helped || draft.effort === 'hard' || !result.meaning.every(Boolean) || !result.kana.every(Boolean)
    || reading.kana && draft.sourcePractice !== 'heard') return day
  const previous = japaneseReadingHistory(sessions, now, reading.kana ? japaneseKana : japaneseReadings).filter(h => h.reading.id === reading.id)
  // Simple transparent 3/7/21-day text recheck; existing oral/chunk FSRS remains
  // separate. Never increase a gap merely because the page was opened.
  const last = previous.at(-1)
  const priorSuccess = last && !last.draft.helped && last.draft.effort !== 'hard' && last.result.meaning.every(Boolean) && last.result.kana.every(Boolean)
    && (!reading.kana || last.draft.sourcePractice === 'heard')
  return (priorSuccess ? (last.draft.dueAt! - last.session.completedAt! >= 7 * day ? 21 : 7) : 3) * day
}

/** Short foundation alongside communication. Completion selects exposure, not
 * mastery; publisher listening is only a labelled self-report. Never force a
 * backlog of alphabet drills before allowing meaningful conversation. */
export function nextJapaneseKana(sessions: StudySession[], now: number, needsBasics: boolean): JapaneseReading | undefined {
  const history = japaneseReadingHistory(sessions, now, japaneseKana), latest = new Map(history.map(h => [h.reading.id, h]))
  const order = needsBasics ? japaneseKana : [...japaneseKana.filter(r => r.kana?.script === 'rhythm'), ...japaneseKana.filter(r => r.kana?.script !== 'rhythm')]
  const fresh = order.find(r => !latest.has(r.id))
  const due = [...latest.values()].filter(h => h.draft.dueAt! <= now).sort((a, b) => a.draft.dueAt! - b.draft.dueAt!)
  const twoRevisits = history.length >= 2 && history.slice(-2).every(h => h.draft.seen)
  return due.length && !(fresh && twoRevisits) ? due[0]!.reading : fresh ?? due[0]?.reading
}
