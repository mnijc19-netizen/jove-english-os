import { fsrs, State } from 'ts-fsrs'
import { skillNames, type Material, type Modality, type Profile, type ReviewCard, type Skill, type SkillName, type StudyEvent } from './types'

/**
 * Planning policy, not a calibrated learning model. No writes, clock reads, random
 * IDs, completion events or FSRS transitions. Callers persist real attempts only.
 * Dates are epoch milliseconds; interruption thresholds are elapsed 24h periods.
 * Distinct practice days use UTC so device time zones/DST cannot change the result.
 * Future/invalid events and conflicting duplicate IDs are excluded, not clamped.
 *
 * Research-to-policy limits (bounded primary-source audit, 2026-09-08):
 * Anggia & Habok (2025), https://doi.org/10.1038/s41598-025-92326-9:
 * university ER groups improved reading; motivation did not guarantee achievement.
 * Saito (2025), https://doi.org/10.22492/ije.13.1.02: interest/familiarity,
 * difficulty and fatigue related to engagement; observational associations.
 * Neither validates our 95/98% coverage bands, 3/7/14-day recovery, 8 observations,
 * 0.10 score deltas, or minute allocations. These are conservative, inspectable
 * product policies. Sentence length is a complexity proxy, not a syntax/CEFR score.
 * Four strands, retrieval and spaced practice follow LEARNING_SCIENCE.md; FSRS
 * retrievability is an estimate for card priority, never demonstrated proficiency.
 */
const DAY = 86_400_000
const WINDOW = 28 * DAY
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const unit = (n: unknown): n is number => finite(n) && n >= 0 && n <= 1
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))
const round = (n: number) => Math.round(n * 10_000) / 10_000
const dayOf = (n: number) => Math.floor(n / DAY)
const mean = (ns: readonly number[]) => ns.reduce((a, b) => a + b, 0) / ns.length
const median = (ns: readonly number[]) => {
  const sorted = [...ns].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const nonempty = (s: unknown): s is string => typeof s === 'string' && !!s.trim()
const validTime = (n: unknown): n is number => finite(n) && n >= 0 && n <= 8.64e15
function checkNow(now: number) {
  if (!validTime(now)) throw new RangeError('now must be a valid nonnegative epoch-millisecond timestamp')
}
function dateValue(value: unknown): number | null {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value
    : typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN
  return validTime(time) ? time : null
}
function canonical(value: unknown): string {
  if (value instanceof Date) return String(value.getTime())
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compare(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return `${typeof value}:${JSON.stringify(String(value))}`
}
export interface EvidenceDiagnostics { invalidEvents: number; futureEvents: number; duplicateEvents: number; conflictingIds: number }
function cleanEvents(events: readonly StudyEvent[], now: number) {
  checkNow(now)
  const diagnostics: EvidenceDiagnostics = { invalidEvents: 0, futureEvents: 0, duplicateEvents: 0, conflictingIds: 0 }
  const records = new Map<string, StudyEvent>(), signatures = new Map<string, string>(), conflicts = new Set<string>(), futureIds = new Set<string>()
  for (const event of events) {
    if (!nonempty(event.id) || !validTime(event.timestamp)) { diagnostics.invalidEvents++; continue }
    if (event.timestamp > now) futureIds.add(event.id)
    // Check duplicate conflicts before time filtering: a future copy cannot hide a collision.
    const signature = canonical(event)
    if (signatures.has(event.id)) {
      if (signatures.get(event.id) !== signature) conflicts.add(event.id)
      else diagnostics.duplicateEvents++
    } else { records.set(event.id, event); signatures.set(event.id, signature) }
  }
  diagnostics.conflictingIds = conflicts.size
  diagnostics.futureEvents = futureIds.size
  const ordered = [...records.values()].filter(event => {
    if (event.timestamp > now) return false
    return !conflicts.has(event.id)
  }).sort((a, b) => a.timestamp - b.timestamp || compare(a.id, b.id))
  return { ordered, diagnostics }
}
const modalitySkill: Record<Modality, SkillName> = {
  recognition: 'chunkRecognition', listening: 'listeningWords', recall: 'vocabularyRecall',
  cloze: 'grammarProduction', speaking: 'chunkProduction', transfer: 'realWorld',
}
const spoken = new Set<SkillName>(['chunkProduction', 'speakingFluency', 'speakingAccuracy', 'pronunciation', 'prosody', 'interaction', 'realWorld'])
const textSkills = new Set<SkillName>(['vocabularyRecognition', 'vocabularyRecall', 'chunkRecognition', 'grammarProduction', 'reading', 'writing'])
const skillOf = (e: StudyEvent) => e.skill ?? (e.modality ? modalitySkill[e.modality] : undefined)
const kindOf = (e: StudyEvent) => e.type.toUpperCase().replaceAll('-', '_')
function measuredScore(e: StudyEvent): boolean {
  const skill = skillOf(e)
  if (['TASK_COMPLETED', 'TASK_OFFERED', 'TASK_SKIPPED', 'PRACTICE_LOGGED', 'READING_OBSERVATION', 'TRANSCRIPT_REVEALED'].includes(kindOf(e))) return false
  if (!skill || !unit(e.score) || !['objective', 'ai', 'text', 'acoustic'].includes(e.source)) return false
  if (e.source === 'text' && !textSkills.has(skill)) return false
  if (['pronunciation', 'prosody', 'speakingFluency'].includes(skill) && e.source !== 'acoustic') return false
  if (spoken.has(skill)) {
    if (e.modality && !['speaking', 'transfer'].includes(e.modality)) return false
    if (e.source === 'ai' && (e.data?.audioObserved !== true || e.data?.transcriptVerified !== true)) return false
    if (e.prompted && e.score! >= 0.6) return false
    if (skill === 'realWorld' && e.score! >= 0.6 && (!nonempty(e.contextId) || e.data?.novelContext !== true)) return false
  }
  return true
}
const taskKinds = new Set(['review', 'listen', 'learn', 'reading', 'shadow', 'speak', 'repair', 'retell', 'assessment'])
function practice(e: StudyEvent): boolean {
  if (measuredScore(e)) return true
  if (e.source !== 'objective') return false
  if (kindOf(e) === 'TASK_COMPLETED' && typeof e.data?.kind === 'string' && taskKinds.has(e.data.kind)) return true
  return ['PRACTICE_LOGGED', 'READING_OBSERVATION'].includes(kindOf(e)) &&
    finite(e.data?.activeSeconds) && e.data.activeSeconds >= 30 && e.data.activeSeconds <= 7200 && nonempty(e.sessionId)
}
export interface RecoveryPlan {
  mode: 'none' | 'restart-3' | 'restart-7' | 'restart-14'
  evidence: 'unknown' | 'observed'
  interruptionDays: number | null
  lastPracticeAt: number | null
  resumedAt: number | null
  /** Only distinct practice days BEFORE today's UTC bucket advance restoration. */
  restoredPracticeDays: number
  restorationDays: number
  loadFactor: number
  minutes: number
  difficultyDelta: number
  reviewBudgetSeconds: number
  maxReviewCards: number
}
export function planRecovery(profile: Profile, events: readonly StudyEvent[], now: number): RecoveryPlan {
  const active = cleanEvents(events, now).ordered.filter(practice)
  const requested = finite(profile.dailyMinutes) ? clamp(Math.round(profile.dailyMinutes), 15, 180) : 45
  const fatigue = unit(profile.fatigue) ? profile.fatigue : 0
  const normalMinutes = Math.round(requested * (1 - fatigue * 0.4))
  let episode: { days: number; resumedAt: number | null } | null = null
  for (let i = 1; i < active.length; i++) {
    const days = Math.floor((active[i].timestamp - active[i - 1].timestamp) / DAY)
    if (days >= 3) episode = { days, resumedAt: active[i].timestamp }
  }
  const lastPracticeAt = active.at(-1)?.timestamp ?? null
  if (lastPracticeAt !== null && now - lastPracticeAt >= 3 * DAY) {
    episode = { days: Math.floor((now - lastPracticeAt) / DAY), resumedAt: null }
  }
  const severity = !episode ? 0 : episode.days >= 14 ? 14 : episode.days >= 7 ? 7 : 3
  const restorationDays = severity === 14 ? 7 : severity === 7 ? 5 : severity === 3 ? 3 : 0
  const restoredPracticeDays = episode?.resumedAt === null || !episode ? 0 : new Set(active
    .filter(e => e.timestamp >= episode.resumedAt! && dayOf(e.timestamp) < dayOf(now)).map(e => dayOf(e.timestamp))).size
  const recovering = severity > 0 && restoredPracticeDays < restorationDays
  const startFactor = severity === 14 ? 0.5 : severity === 7 ? 0.65 : 0.8
  const progress = recovering ? restoredPracticeDays / restorationDays : 1
  const loadFactor = recovering ? round(startFactor + (1 - startFactor) * progress) : 1
  const minutes = Math.max(10, Math.floor(normalMinutes * loadFactor))
  return {
    mode: recovering ? `restart-${severity as 3 | 7 | 14}` : 'none', evidence: active.length ? 'observed' : 'unknown',
    interruptionDays: episode?.days ?? (lastPracticeAt === null ? null : Math.floor((now - lastPracticeAt) / DAY)),
    lastPracticeAt, resumedAt: episode?.resumedAt ?? null, restoredPracticeDays: Math.min(restoredPracticeDays, restorationDays),
    restorationDays, loadFactor, minutes,
    difficultyDelta: recovering ? round(-(severity === 14 ? 0.15 : severity === 7 ? 0.1 : 0.05) * (1 - progress)) : 0,
    reviewBudgetSeconds: Math.min(600, Math.floor(minutes * 0.2) * 60),
    maxReviewCards: recovering ? Math.floor((severity === 14 ? 6 : severity === 7 ? 8 : 10) + progress * 10) : 20,
  }
}

export interface ReviewSelectionOptions { budgetSeconds: number; maxCards: number }
export interface SelectedReview {
  cardId: string; chunkId: string; modality: Modality; estimatedSeconds: number
  errorId?: string; retrievability: number | null; priority: number; reasons: string[]
}
export interface ReviewSelection {
  selected: SelectedReview[]; selectedIds: string[]; estimatedSeconds: number
  dueCount: number; deferredCount: number; excludedCardIds: string[]
}
const secondsByModality: Record<Modality, number> = { recognition: 20, listening: 35, recall: 40, cloze: 40, speaking: 75, transfer: 90 }
const scheduler = fsrs({ enable_fuzz: false })
/** Bounded queue suggestions only. Deferred cards keep their original due/state/reps. */
export function selectMeaningfulReviews(cards: readonly ReviewCard[], events: readonly StudyEvent[], now: number, options: ReviewSelectionOptions): ReviewSelection {
  const recent = cleanEvents(events, now).ordered.filter(e => e.timestamp >= now - WINDOW)
  const budget = finite(options.budgetSeconds) ? clamp(Math.floor(options.budgetSeconds), 0, 1800) : 0
  const maxCards = finite(options.maxCards) ? clamp(Math.floor(options.maxCards), 0, 50) : 0
  const unique = new Map<string, ReviewCard>(), conflicts = new Set<string>(), excluded = new Set<string>()
  for (const card of cards) {
    if (unique.has(card.id) && canonical(unique.get(card.id)) !== canonical(card)) conflicts.add(card.id)
    else unique.set(card.id, card)
  }
  const candidates: SelectedReview[] = []
  for (const card of unique.values()) {
    const due = dateValue(card.card.due), last = card.card.last_review === undefined ? null : dateValue(card.card.last_review)
    if (conflicts.has(card.id) || !nonempty(card.id) || !nonempty(card.chunkId) || due === null ||
      !Object.hasOwn(secondsByModality, card.modality) || ![State.New, State.Learning, State.Review, State.Relearning].includes(card.card.state) ||
      !finite(card.card.reps) || !Number.isInteger(card.card.reps) || card.card.reps < 0 ||
      (card.card.last_review !== undefined && (last === null || last > now || due < last))) {
      excluded.add(card.id); continue
    }
    if (due > now) continue
    let retrievability: number | null = null
    if (card.card.state !== State.New && card.card.reps > 0 && last !== null && finite(card.card.stability) && card.card.stability > 0) {
      const estimated = scheduler.get_retrievability({ ...card.card, due: new Date(due), last_review: new Date(last) }, now, false)
      if (unit(estimated)) retrievability = round(estimated)
    }
    const failures = new Set(recent.filter(e => e.modality === card.modality && e.chunkId === card.chunkId && measuredScore(e) && e.score! < 0.6)
      .map(e => e.sessionId ?? `${dayOf(e.timestamp)}`)).size
    const importance = 1 + (card.errorId ? 0.8 : 0) + (['speaking', 'transfer'].includes(card.modality) ? 0.35 : 0) + Math.min(3, failures) * 0.25
    const overdue = Math.min(1, (now - due) / WINDOW)
    const priority = round(importance * (0.5 + (retrievability === null ? 0.25 : 1 - retrievability)) + overdue * 0.25)
    const reasons = [retrievability === null ? 'decay-unknown' : 'fsrs-decay-estimate']
    if (card.errorId) reasons.push('linked-error')
    if (failures) reasons.push('recent-modality-failures')
    if (['speaking', 'transfer'].includes(card.modality)) reasons.push('productive-use')
    candidates.push({ cardId: card.id, chunkId: card.chunkId, modality: card.modality, estimatedSeconds: secondsByModality[card.modality],
      ...(card.errorId ? { errorId: card.errorId } : {}), retrievability, priority, reasons })
  }
  candidates.sort((a, b) => b.priority - a.priority || compare(a.cardId, b.cardId))
  const selected: SelectedReview[] = [], chunkCounts = new Map<string, number>()
  let estimatedSeconds = 0
  // Value first, then fit the time budget; cheap recognition must not crowd out production.
  for (const candidate of candidates) {
    if (selected.length >= maxCards) break
    if (estimatedSeconds + candidate.estimatedSeconds > budget || (chunkCounts.get(candidate.chunkId) ?? 0) >= 2 ||
      selected.some(s => s.chunkId === candidate.chunkId && s.modality === candidate.modality)) continue
    selected.push(candidate); estimatedSeconds += candidate.estimatedSeconds
    chunkCounts.set(candidate.chunkId, (chunkCounts.get(candidate.chunkId) ?? 0) + 1)
  }
  return { selected, selectedIds: selected.map(s => s.cardId), estimatedSeconds, dueCount: candidates.length,
    deferredCount: candidates.length - selected.length, excludedCardIds: [...excluded].sort(compare) }
}

/**
 * Comparable score events require explicit rubricVersion, comparisonKey,
 * conditionsKey, difficulty (0..1), firstPass:true, priorExposure:false,
 * prompted:false and sessionId. Keys describe task/rubric/assistance conditions;
 * rotating prompts are only comparable when the collector explicitly attests it.
 * Source, modality, exact editorial difficulty and skill also split cohorts.
 * Never add these tags retrospectively to unobserved legacy conditions.
 */
export interface ComparableObservationData {
  rubricVersion: string; comparisonKey: string; conditionsKey: string; difficulty: number
  firstPass: true; priorExposure: false
}
/** Missing facts are not defaults. Only explicit independent, first-pass observations enter trends. */
export function comparableObservation(facts: {
  rubricVersion: string; comparisonKey: string; difficulty: number; evaluator: string | null
  conditions: string | null; firstPass: boolean | null; priorExposure: boolean | null; prompted: boolean | null
}): ComparableObservationData | null {
  if (!nonempty(facts.rubricVersion) || !nonempty(facts.comparisonKey) || !unit(facts.difficulty)
    || !nonempty(facts.evaluator) || !nonempty(facts.conditions) || facts.firstPass !== true
    || facts.priorExposure !== false || facts.prompted !== false) return null
  return { rubricVersion: facts.rubricVersion, comparisonKey: facts.comparisonKey,
    conditionsKey: JSON.stringify([facts.conditions, facts.evaluator]), difficulty: facts.difficulty,
    firstPass: true, priorExposure: false }
}
/** The model selected in Settings is not proof of the model which actually evaluated a response. */
export function assessmentEvaluator(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('provenance' in result)) return null
  const p = result.provenance
  return p && typeof p === 'object' && 'provider' in p && 'model' in p && nonempty(p.provider) && nonempty(p.model)
    ? JSON.stringify([p.provider, p.model]) : null
}
/** Useful to the store when preferences change. Offering/navigating past a task is not work. */
export function hasTaskStarted(taskId: string, events: readonly StudyEvent[], now: number): boolean {
  return cleanEvents(events, now).ordered.some(e => e.data?.taskId === taskId &&
    ['TASK_STARTED', 'READING_STARTED', 'READING_RESPONSE', 'REVIEW_RESPONSE', 'ASSESSMENT_RESPONSE', 'LISTENING_RESPONSE', 'SPEAKING_RESPONSE'].includes(kindOf(e)))
}
export const readingRubric = {
  version: 'reading-meaning-v2',
  task: 'Explain the main idea, give one accurate supporting detail, then express a relevant personal response. Retell separately without the passage.',
  anchors: ['Missing, unrelated or contradictory meaning', 'Main idea partly understood; detail missing or inaccurate', 'Accurate main idea and supporting detail; relevant response'],
} as const
/** Provisional comparison strata, not standardized equivalent test forms. Never pool all passages. */
export function readingComparisonKey(material: Material): string | null {
  const count = words(material.transcript), complexity = sentenceWords(material)
  if (!unit(material.difficulty) || count < 40 || count > 600 || !finite(complexity) || complexity <= 0) return null
  return `reading-main-idea-detail:${count < 120 ? 'short' : count < 240 ? 'medium' : 'long'}:sentence-${complexity <= 14 ? 'short' : complexity <= 24 ? 'medium' : 'long'}`
}
/** The approved passage is frozen into the assessment before the learner sees it. */
export function selectReadingAssessment(profile: Profile, materials: readonly Material[], events: readonly StudyEvent[], now: number): Material | null {
  const ordered = cleanEvents(events, now).ordered
  const exposed = (m: Material) => ordered.some(e => e.data?.materialId === m.id && !['TASK_STARTED', 'TASK_OFFERED', 'TASK_COMPLETED'].includes(kindOf(e)))
  return [...materials].filter(m => materialEligible(m, now) && readingComparisonKey(m)).sort((a, b) =>
    Number(exposed(a)) - Number(exposed(b)) || Math.abs(a.difficulty - 0.35) - Math.abs(b.difficulty - 0.35)
    || Number(interested(profile, b)) - Number(interested(profile, a)) || compare(a.id, b.id))[0] ?? null
}
export interface ReadingSavedEvidence {
  sessionId: string; materialId: string; observationAt: number; response: string; retell: string
  audioId?: string; activeSeconds: number; priorExposure: boolean; score: number | null; evaluated: boolean
}
export type TrendStatus = 'unknown' | 'plateau' | 'regression' | 'improving' | 'maintaining' | 'variable'
export interface SkillTrend {
  skill: SkillName; status: TrendStatus; comparableDays: number; cohort: string | null
  weekly: { days: number; score: number | null }[]; delta: number | null; reason: string
}
export type Strand = 'input' | 'output' | 'language' | 'fluency'
const strands: Strand[] = ['input', 'output', 'language', 'fluency']
export type TargetActivity = 'listening' | 'reading' | 'speaking'
/** Objective PRACTICE_LOGGED summary; strand times in a session must not overlap. */
export interface PracticeObservationData { strand: Strand; activeSeconds: number }
/** Objective TASK_OFFERED and its TASK_SKIPPED/TASK_COMPLETED outcome share taskId. */
export interface TaskOpportunityData {
  taskId: string; kind: 'listen' | 'listening' | 'reading' | 'speak' | 'speaking' | 'retell'
  reason?: 'too-hard' | 'uncomfortable' | 'not-interested' | 'busy' | 'offline' | 'permission-denied'
}
export interface AvoidanceSignal {
  activity: TargetActivity; status: 'unknown' | 'possible-avoidance' | 'engaged'
  resolvedOffers: number; avoidantSkips: number; reason: string
}
export interface BalanceSignal {
  status: 'unknown' | 'imbalanced' | 'balanced'; shares: Record<Strand, number> | null
  underrepresented: Strand[]; observedSeconds: number; reason: string
}
export interface LongitudinalSignals { trends: SkillTrend[]; avoidance: AvoidanceSignal[]; balance: BalanceSignal; diagnostics: EvidenceDiagnostics }
const weekOf = (timestamp: number, now: number) => Math.min(3, Math.floor((timestamp - (now - WINDOW)) / (7 * DAY)))
function trendFor(skill: SkillName, events: readonly StudyEvent[], now: number): SkillTrend {
  const groups = new Map<string, StudyEvent[]>()
  for (const e of events) {
    const d = e.data
    if (skillOf(e) !== skill || !measuredScore(e) || e.prompted !== false || !nonempty(e.sessionId) ||
      d?.firstPass !== true || d.priorExposure !== false || !unit(d.difficulty) ||
      !nonempty(d.rubricVersion) || !nonempty(d.comparisonKey) || !nonempty(d.conditionsKey)) continue
    const key = JSON.stringify([d.rubricVersion, d.comparisonKey, d.conditionsKey, d.difficulty, e.source, e.modality ?? 'none'])
    const group = groups.get(key) ?? []
    group.push(e); groups.set(key, group)
  }
  const cohorts = [...groups].map(([key, group]) => {
    const sessions = new Set<string>(), days = new Set<number>()
    const distinct = group.filter(e => {
      if (sessions.has(e.sessionId!) || days.has(dayOf(e.timestamp))) return false
      sessions.add(e.sessionId!); days.add(dayOf(e.timestamp)); return true
    })
    const samples = Array.from({ length: 4 }, (_, i) => distinct.filter(e => weekOf(e.timestamp, now) === i).map(e => e.score!))
    return { key, distinct, samples, enough: samples.every(s => s.length >= 2) }
  }).sort((a, b) => Number(b.enough) - Number(a.enough) || b.distinct.length - a.distinct.length || compare(a.key, b.key))
  const chosen = cohorts[0]
  const weekly = Array.from({ length: 4 }, (_, i) => ({ days: chosen?.samples[i].length ?? 0,
    score: chosen?.samples[i].length ? round(mean(chosen.samples[i])) : null }))
  const base = { skill, comparableDays: chosen?.distinct.length ?? 0, cohort: chosen?.key ?? null, weekly }
  if (!chosen?.enough) return { ...base, status: 'unknown', delta: null, reason: 'need-two-comparable-days-in-each-of-four-weeks' }
  const scores = chosen.samples.map(mean), early = mean(scores.slice(0, 2)), late = mean(scores.slice(2))
  const delta = round(late - early)
  const noisy = chosen.samples.some(s => Math.max(...s) - Math.min(...s) > 0.3)
  let status: TrendStatus = 'variable'
  if (!noisy && delta <= -0.1 && scores.slice(2).every(s => s <= early - 0.08)) status = 'regression'
  else if (!noisy && delta >= 0.08 && scores.slice(2).every(s => s >= early + 0.05)) status = 'improving'
  else if (!noisy && Math.abs(delta) <= 0.03 && Math.max(...scores) - Math.min(...scores) <= 0.05) status = late >= 0.85 ? 'maintaining' : 'plateau'
  return { ...base, status, delta, reason: noisy ? 'within-week-variation-too-large' : 'descriptive-comparable-observations-not-a-clinical-or-causal-diagnosis' }
}
function targetActivity(kind: unknown): TargetActivity | null {
  return kind === 'speak' || kind === 'speaking' || kind === 'retell' ? 'speaking'
    : kind === 'listen' || kind === 'listening' ? 'listening' : kind === 'reading' ? 'reading' : null
}
function avoidanceFor(activity: TargetActivity, events: readonly StudyEvent[], now: number): AvoidanceSignal {
  const offers = new Map<string, StudyEvent>()
  for (const e of events) if (e.source === 'objective' && kindOf(e) === 'TASK_OFFERED' &&
    targetActivity(e.data?.kind) === activity && nonempty(e.data?.taskId) && !offers.has(e.data.taskId)) offers.set(e.data.taskId, e)
  const resolved: { offer: StudyEvent; avoided: boolean }[] = []
  for (const [id, offer] of offers) {
    const outcomes = events.filter(e => e.timestamp >= offer.timestamp && e.source === 'objective' && e.data?.taskId === id &&
      targetActivity(e.data?.kind) === activity && ['TASK_COMPLETED', 'TASK_SKIPPED'].includes(kindOf(e)))
    if (outcomes.some(e => kindOf(e) === 'TASK_COMPLETED')) resolved.push({ offer, avoided: false })
    else if (outcomes.some(e => ['too-hard', 'uncomfortable', 'not-interested'].includes(String(e.data?.reason)))) resolved.push({ offer, avoided: true })
    // Busy/offline/permission failure and unanswered offers do not establish avoidance.
  }
  const weeks = Array.from({ length: 4 }, (_, i) => resolved.filter(r => weekOf(r.offer.timestamp, now) === i))
  const enough = weeks.every(w => w.length >= 2 && new Set(w.map(r => dayOf(r.offer.timestamp))).size >= 2)
  const avoidantSkips = resolved.filter(r => r.avoided).length
  return { activity, resolvedOffers: resolved.length, avoidantSkips,
    status: !enough ? 'unknown' : avoidantSkips / resolved.length >= 0.6 && weeks.slice(2).every(w => w.filter(r => r.avoided).length / w.length >= 0.5) ? 'possible-avoidance' : 'engaged',
    reason: enough ? 'explicit-difficulty-or-interest-skips-not-inferred-motivation' : 'need-resolved-offers-on-two-days-per-week' }
}
function balanceOf(events: readonly StudyEvent[], now: number): BalanceSignal {
  // Emit one cumulative measured summary per session/strand. Later summaries replace
  // earlier ones; planned TASK_COMPLETED.minutes is deliberately not elapsed time.
  const sessions = new Map<string, StudyEvent>()
  for (const e of events) if (e.source === 'objective' && ['PRACTICE_LOGGED', 'TASK_COMPLETED'].includes(kindOf(e)) &&
    nonempty(e.sessionId) && strands.includes(e.data?.strand as Strand) && finite(e.data?.activeSeconds) && e.data.activeSeconds >= 30 && e.data.activeSeconds <= 7200) {
    sessions.set(JSON.stringify([e.sessionId, e.data.strand]), e)
  }
  const records = [...sessions.values()]
  const seconds = Object.fromEntries(strands.map(s => [s, records.filter(e => e.data?.strand === s).reduce((n, e) => n + (e.data!.activeSeconds as number), 0)])) as Record<Strand, number>
  const observedSeconds = Object.values(seconds).reduce((a, b) => a + b, 0)
  const enough = Array.from({ length: 4 }, (_, i) => records.filter(e => weekOf(e.timestamp, now) === i)).every(w =>
    new Set(w.map(e => dayOf(e.timestamp))).size >= 2 && w.reduce((n, e) => n + (e.data!.activeSeconds as number), 0) >= 600)
  if (!enough) return { status: 'unknown', shares: null, underrepresented: [], observedSeconds, reason: 'need-measured-practice-across-four-weeks' }
  const shares = Object.fromEntries(strands.map(s => [s, round(seconds[s] / observedSeconds)])) as Record<Strand, number>
  const underrepresented = strands.filter(s => shares[s] < 0.12)
  return { status: underrepresented.length || Object.values(shares).some(s => s > 0.5) ? 'imbalanced' : 'balanced',
    shares, underrepresented, observedSeconds, reason: 'rolling-strand-time-is-program-balance-not-ability' }
}
export function analyzeLongitudinal(events: readonly StudyEvent[], now: number): LongitudinalSignals {
  const { ordered, diagnostics } = cleanEvents(events, now)
  const recent = ordered.filter(e => e.timestamp >= now - WINDOW)
  return { trends: skillNames.map(skill => trendFor(skill, recent, now)),
    avoidance: (['listening', 'reading', 'speaking'] as const).map(activity => avoidanceFor(activity, recent, now)),
    balance: balanceOf(recent, now), diagnostics }
}

/**
 * READING_OBSERVATION is objective session telemetry, not a proficiency score.
 * Word samples must actually be checked; missing lookups/timers remain unknown.
 * activeSeconds excludes paused/background time; wordsRead counts actually read
 * tokens, not the length of an opened page. One first-pass summary per session.
 */
export interface ReadingObservationData {
  materialId: string; firstPass: true; priorExposure: false
  coverageMethod?: 'checked-word-sample'; knownWordCount?: number; sampledWordCount?: number
  wordsRead?: number; activeSeconds?: number; lookupCount?: number
}
export interface ReadingFit {
  materialId: string; eligible: boolean; fit: 'unknown' | 'likely-fit' | 'stretch' | 'too-hard'
  confidence: 'unknown' | 'limited' | 'moderate'; basis: 'none' | 'material-sample' | 'similar-passages'
  observationCount: number; interestMatch: boolean
  metrics: { vocabularyCoverage: number | null; lookupsPer100Words: number | null; wordsPerMinute: number | null;
    speedRatio: number | null; sentenceWords: number; sentenceLengthRatio: number | null }
  recommendedSegmentWords: number; reasons: string[]
}
const words = (text: string) => text.match(/\p{L}+(?:['’-]\p{L}+)*/gu)?.length ?? 0
function sentenceWords(material: Material): number {
  const sentences = (material.sentences.length ? material.sentences : material.transcript.split(/[.!?]+/)).map(words).filter(n => n > 0)
  return sentences.length ? mean(sentences) : 0
}
function interested(profile: Profile, m: Material): boolean {
  const haystack = `${m.title} ${m.topic} ${m.keywords.join(' ')}`.toLowerCase()
  return profile.interests.some(i => !!i.trim() && haystack.includes(i.trim().toLowerCase()))
}
function materialEligible(m: Material, now: number) {
  return m.approved && !!m.transcript.trim() && unit(m.difficulty) && validTime(m.createdAt) && m.createdAt <= now
}
interface ReadingSample { event: StudyEvent; material: Material; known: number | null; sampled: number | null; count: number | null; wpm: number | null; lookups: number | null }
function readingSamples(events: readonly StudyEvent[], materials: readonly Material[], now: number): ReadingSample[] {
  const byId = new Map(materials.map(m => [m.id, m])), sessions = new Set<string>()
  const samples: ReadingSample[] = []
  for (const e of cleanEvents(events, now).ordered) {
    const d = e.data, material = typeof d?.materialId === 'string' ? byId.get(d.materialId) : undefined
    if (e.timestamp < now - WINDOW || e.source !== 'objective' || kindOf(e) !== 'READING_OBSERVATION' ||
      !nonempty(e.sessionId) || sessions.has(e.sessionId) || e.prompted === true || d?.firstPass !== true || d.priorExposure !== false ||
      !material || !materialEligible(material, e.timestamp)) continue
    const availableWords = words(material.transcript)
    const validCoverage = d.coverageMethod === 'checked-word-sample' && finite(d.sampledWordCount) && Number.isInteger(d.sampledWordCount) &&
      d.sampledWordCount >= 20 && d.sampledWordCount <= Math.min(10000, availableWords) && finite(d.knownWordCount) && Number.isInteger(d.knownWordCount) && d.knownWordCount >= 0 && d.knownWordCount <= d.sampledWordCount
    const count = finite(d.wordsRead) && Number.isInteger(d.wordsRead) && d.wordsRead >= 40 && d.wordsRead <= Math.min(100000, availableWords) ? d.wordsRead : null
    const rawWpm = count !== null && finite(d.activeSeconds) && d.activeSeconds >= 20 && d.activeSeconds <= 7200 ? count * 60 / d.activeSeconds : null
    const wpm = rawWpm !== null && rawWpm >= 5 && rawWpm <= 600 ? rawWpm : null
    const lookups = count !== null && finite(d.lookupCount) && Number.isInteger(d.lookupCount) && d.lookupCount >= 0 && d.lookupCount <= count ? d.lookupCount : null
    if (!validCoverage && count === null) continue
    sessions.add(e.sessionId)
    samples.push({ event: e, material, known: validCoverage ? d.knownWordCount as number : null,
      sampled: validCoverage ? d.sampledWordCount as number : null, count, wpm, lookups })
  }
  return samples
}
function fitFromSamples(material: Material, profile: Profile, samples: readonly ReadingSample[], now: number): ReadingFit {
  const length = sentenceWords(material)
  const direct = samples.filter(s => s.material.id === material.id)
  const similar = samples.filter(s => Math.abs(s.material.difficulty - material.difficulty) <= 0.1 &&
    Math.abs(sentenceWords(s.material) - length) <= Math.max(4, length * 0.3))
  const cohort = direct.length ? direct : similar
  const coverageSamples = cohort.filter(s => s.sampled !== null), lookupSamples = cohort.filter(s => s.lookups !== null)
  const coverage = coverageSamples.length ? coverageSamples.reduce((n, s) => n + s.known!, 0) / coverageSamples.reduce((n, s) => n + s.sampled!, 0) : null
  const lookupRate = lookupSamples.length ? lookupSamples.reduce((n, s) => n + s.lookups!, 0) * 100 / lookupSamples.reduce((n, s) => n + s.count!, 0) : null
  // Relative speed is within-person at comparable editorial difficulty. No universal WPM norm.
  const baseline = samples.filter(s => Math.abs(s.material.difficulty - material.difficulty) <= 0.1 && s.wpm !== null && s.material.id !== material.id)
  const speeds = cohort.flatMap(s => s.wpm === null ? [] : [s.wpm])
  const wpm = speeds.length ? median(speeds) : null
  const baselineWpm = baseline.length >= 3 ? median(baseline.map(s => s.wpm!)) : null
  const speedRatio = wpm !== null && baselineWpm !== null ? wpm / baselineWpm : null
  const lengthBaseline = samples.length >= 3 ? median(samples.map(s => sentenceWords(s.material)).filter(n => n > 0)) : null
  const lengthRatio = lengthBaseline !== null && lengthBaseline > 0 ? length / lengthBaseline : null
  const complete = cohort.filter(s => s.sampled !== null && s.lookups !== null && s.wpm !== null)
  const enough = complete.length >= 3 && new Set(complete.map(s => dayOf(s.event.timestamp))).size >= 3 &&
    new Set(complete.map(s => s.material.id)).size >= 2 && complete.reduce((n, s) => n + s.sampled!, 0) >= 150
  const reasons = ['sentence-length-is-only-a-complexity-proxy', 'coverage-is-sampled-recognition-not-comprehension']
  const eligible = materialEligible(material, now)
  if (!eligible) reasons.push('material-not-approved-or-invalid')
  let fit: ReadingFit['fit'] = 'unknown'
  if (coverage !== null && coverage < 0.95 || lookupRate !== null && lookupRate > 5 || speedRatio !== null && speedRatio < 0.65 || lengthRatio !== null && lengthRatio > 1.5) fit = 'too-hard'
  else if (coverage !== null && coverage < 0.98 || lookupRate !== null && lookupRate > 2 || speedRatio !== null && speedRatio < 0.85 || lengthRatio !== null && lengthRatio > 1.2) fit = 'stretch'
  else if (enough && coverage !== null && lookupRate !== null && speedRatio !== null && lengthRatio !== null) fit = 'likely-fit'
  if (!enough) reasons.push('insufficient-independent-reading-samples')
  if (coverage === null) reasons.push('vocabulary-coverage-unknown')
  if (lookupRate === null) reasons.push('lookup-rate-unknown')
  if (speedRatio === null) reasons.push('personal-speed-baseline-unknown')
  if (lengthRatio === null) reasons.push('sentence-complexity-fit-unknown')
  if (!direct.length && cohort.length) reasons.push('similar-passage-estimate-unseen-vocabulary-remains-unknown')
  return { materialId: material.id, eligible, fit, confidence: enough ? 'moderate' : cohort.length ? 'limited' : 'unknown',
    basis: direct.length ? 'material-sample' : similar.length ? 'similar-passages' : 'none', observationCount: cohort.length,
    interestMatch: interested(profile, material), metrics: { vocabularyCoverage: coverage === null ? null : round(coverage),
      lookupsPer100Words: lookupRate === null ? null : round(lookupRate), wordsPerMinute: wpm === null ? null : round(wpm),
      speedRatio: speedRatio === null ? null : round(speedRatio), sentenceWords: round(length), sentenceLengthRatio: lengthRatio === null ? null : round(lengthRatio) },
    recommendedSegmentWords: fit === 'too-hard' ? 60 : fit === 'stretch' || fit === 'unknown' ? 100 : 250, reasons }
}
export function assessReadingFit(material: Material, profile: Profile, events: readonly StudyEvent[], materials: readonly Material[], now: number): ReadingFit {
  checkNow(now)
  return fitFromSamples(material, profile, readingSamples(events, materials, now), now)
}

export interface LongitudinalInput {
  profile: Profile; skills: readonly Skill[]; events: readonly StudyEvent[]; cards: readonly ReviewCard[]; materials: readonly Material[]; now: number
}
export interface LongitudinalPlan {
  now: number; recovery: RecoveryPlan; reviews: ReviewSelection; signals: LongitudinalSignals
  reading: { materialId: string | null; mode: 'graded' | 'probe' | 'bridge-needed' | 'no-material'; candidates: ReadingFit[]; segmentWords: number; response: 'meaning-and-personal-response' }
  adjustments: {
    minutes: number; targetDifficulty: number; readingTargetDifficulty: number; difficultyDelta: number
    /** Relative NEW passage volume; minutes already include recovery, do not scale them again. */
    inputVolumeMultiplier: number; newInputSeconds: number; segmentSeconds: number
    /** These six integer minute allocations sum to minutes; speaking always has >=2. */
    inputMinutes: number; readingMinutes: number; speakingMinutes: number; reviewMinutes: number; languageMinutes: number; fluencyMinutes: number
    speakingMode: 'guided-familiar' | 'new-context-transfer' | 'independent-retell'
    maxRepairTargets: 1 | 2 | 3; reasons: string[]
  }
}
/** Integrate these actual queue/material/budget fields into the existing persisted plan. */
export function planLongitudinal(input: LongitudinalInput): LongitudinalPlan {
  const { profile, skills, events, cards, materials, now } = input
  checkNow(now)
  const recovery = planRecovery(profile, events, now), signals = analyzeLongitudinal(events, now)
  const reviews = selectMeaningfulReviews(cards, events, now, { budgetSeconds: recovery.reviewBudgetSeconds, maxCards: recovery.maxReviewCards })
  const usableSkills = skills.filter(s => s.evidenceCount >= 3 && unit(s.confidence) && s.confidence >= 0.25 && unit(s.score) &&
    validTime(s.updatedAt) && s.updatedAt <= now && s.updatedAt >= now - WINDOW)
  const observedInput = usableSkills.filter(s => ['naturalListening', 'listeningWords', 'listeningSentences'].includes(s.id))
  const baseDifficulty = observedInput.length ? mean(observedInput.map(s => s.score)) : 0.35
  const regression = signals.trends.some(t => t.status === 'regression')
  const plateau = signals.trends.some(t => t.status === 'plateau')
  const improvingInput = signals.trends.some(t => ['naturalListening', 'listeningWords', 'listeningSentences'].includes(t.skill) && t.status === 'improving')
  const avoidance = signals.avoidance.filter(a => a.status === 'possible-avoidance').map(a => a.activity)
  const reasons: string[] = []
  if (recovery.mode !== 'none') reasons.push('restore-load-after-observed-interruption')
  if (regression) reasons.push('reduce-difficulty-and-new-input-until-comparable-recheck')
  if (plateau) reasons.push('vary-context-and-use-short-meaningful-output')
  if (avoidance.length) reasons.push('short-familiar-interest-matched-start')
  if (!observedInput.length) reasons.push('input-difficulty-is-provisional-not-a-proficiency-score')
  const difficultyDelta = clamp(recovery.difficultyDelta + (regression ? -0.1 : improvingInput && recovery.mode === 'none' && profile.fatigue < 0.6 ? 0.05 : 0), -0.25, 0.05)
  const targetDifficulty = round(clamp(baseDifficulty + difficultyDelta, 0.1, 0.9))
  const readingSkill = usableSkills.find(s => s.id === 'reading')
  const targetReading = clamp((readingSkill?.score ?? 0.35) + difficultyDelta, 0.1, 0.9)
  const samples = readingSamples(events, materials, now)
  const rank = { 'likely-fit': 0, unknown: 1, stretch: 2, 'too-hard': 3 }
  const byId = new Map(materials.map(m => [m.id, m]))
  const candidates = materials.map(m => fitFromSamples(m, profile, samples, now)).filter(f => f.eligible).sort((a, b) =>
    rank[a.fit] - rank[b.fit] || Number(byId.get(a.materialId)!.difficulty > targetReading + 0.1) - Number(byId.get(b.materialId)!.difficulty > targetReading + 0.1) ||
    Number(b.interestMatch) - Number(a.interestMatch) || Math.abs(byId.get(a.materialId)!.difficulty - targetReading) - Math.abs(byId.get(b.materialId)!.difficulty - targetReading) || compare(a.materialId, b.materialId))
  const chosen = candidates.find(c => c.fit !== 'too-hard' && (c.fit === 'likely-fit' || byId.get(c.materialId)!.difficulty <= targetReading + 0.1))
  const reading: LongitudinalPlan['reading'] = { materialId: chosen?.materialId ?? null,
    mode: !candidates.length ? 'no-material' : !chosen ? 'bridge-needed' : chosen.fit === 'likely-fit' ? 'graded' : 'probe',
    candidates, segmentWords: chosen?.recommendedSegmentWords ?? 60, response: 'meaning-and-personal-response' }
  const weights = [3, 2, 3, 1, 1] // listening input, reading input, spoken output, deliberate language, fluency
  for (const strand of signals.balance.underrepresented) {
    if (strand === 'input') { weights[0] += 1; weights[1] += 1 }
    if (strand === 'output') weights[2] += 2
    if (strand === 'language') weights[3] += 2
    if (strand === 'fluency') weights[4] += 2
  }
  if (signals.balance.status === 'imbalanced') reasons.push('rebalance-measured-four-strand-practice')
  if (signals.trends.some(t => t.skill === 'reading' && ['plateau', 'regression'].includes(t.status))) weights[1] += 1
  if (plateau) weights[2] += 1
  if (regression || avoidance.includes('listening')) weights[0] = 2
  if (avoidance.includes('reading')) weights[1] = 1
  if (avoidance.includes('speaking')) weights[2] = 1
  const reviewMinutes = Math.ceil(reviews.estimatedSeconds / 60)
  const allocations = [2, 2, 2, 1, 1]
  const extra = recovery.minutes - reviewMinutes - 8, sumWeights = weights.reduce((a, b) => a + b, 0)
  const fractions = weights.map((w, i) => {
    const share = extra * w / sumWeights; allocations[i] += Math.floor(share)
    return { i, fraction: share - Math.floor(share) }
  }).sort((a, b) => b.fraction - a.fraction || a.i - b.i)
  const remainder = recovery.minutes - reviewMinutes - allocations.reduce((a, b) => a + b, 0)
  for (let i = 0; i < remainder; i++) allocations[fractions[i].i]++
  const supported = recovery.mode !== 'none' || regression || avoidance.includes('speaking')
  return { now, recovery, reviews, signals, reading, adjustments: { minutes: recovery.minutes, targetDifficulty, readingTargetDifficulty: round(targetReading),
    difficultyDelta: round(difficultyDelta), inputVolumeMultiplier: round(recovery.loadFactor * (regression ? 0.85 : 1)),
    newInputSeconds: Math.round(120 * recovery.loadFactor * (regression ? 0.85 : 1)),
    segmentSeconds: supported || avoidance.includes('listening') ? 20 : plateau ? 30 : 60,
    inputMinutes: allocations[0], readingMinutes: allocations[1], speakingMinutes: allocations[2], reviewMinutes,
    languageMinutes: allocations[3], fluencyMinutes: allocations[4],
    speakingMode: supported ? 'guided-familiar' : plateau ? 'new-context-transfer' : 'independent-retell',
    maxRepairTargets: recovery.mode !== 'none' ? 1 : regression ? 2 : 3, reasons } }
}
