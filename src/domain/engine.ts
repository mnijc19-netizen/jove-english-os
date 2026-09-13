import { skillNames, type DailyPlan, type Material, type Profile, type ReviewCard, type Skill, type SkillName, type StudyEvent, type PlanTask } from './types'
import { startedTaskIds, planLongitudinal } from './longitudinal'
import { externalLessonCandidates, externalCatalogFresh } from '../content/external'

// Scores, strengths, confidence and fatigue use 0..1, matching the shared UI/provider contract.
const day = 86_400_000
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const spoken = new Set<SkillName>(['chunkProduction', 'speakingFluency', 'speakingAccuracy', 'pronunciation', 'prosody', 'interaction', 'realWorld'])
const textSkills = new Set<SkillName>(['vocabularyRecognition', 'vocabularyRecall', 'chunkRecognition', 'grammarProduction', 'reading', 'writing'])
const modalitySkill: Record<NonNullable<StudyEvent['modality']>, SkillName> = {
  recognition: 'chunkRecognition', listening: 'listeningWords', recall: 'vocabularyRecall',
  cloze: 'grammarProduction', speaking: 'chunkProduction', transfer: 'realWorld',
}

export function eventSkill(event: StudyEvent): SkillName | undefined {
  return event.skill ?? (event.modality ? modalitySkill[event.modality] : undefined)
}

/** A transcript or self-rating cannot establish independent spoken/acoustic ability. */
export function evidenceWeight(event: StudyEvent, skill = eventSkill(event)): number {
  if (['TASK_STARTED', 'TASK_COMPLETED', 'TASK_OFFERED', 'TASK_SKIPPED', 'PRACTICE_LOGGED', 'READING_STARTED', 'READING_OBSERVATION', 'READING_RESPONSE', 'READING_RETELL', 'REVIEW_BLOCK_COMPLETED'].includes(event.type.toUpperCase().replaceAll('-', '_'))) return 0
  if (!['objective', 'self-report', 'ai', 'text', 'acoustic'].includes(event.source)) return 0
  if (!skill || !Number.isFinite(event.score) || event.score! < 0 || event.score! > 1 || event.source === 'self-report') return 0
  if (event.source === 'text' && !textSkills.has(skill)) return 0
  if ((skill === 'pronunciation' || skill === 'prosody' || skill === 'speakingFluency') && event.source !== 'acoustic') return 0
  const scripted = event.prompted === true || event.data?.scripted === true
  const supportedAcoustic = event.source === 'acoustic' && (skill === 'pronunciation' || skill === 'prosody')
    && typeof event.data?.assessmentId === 'string' && !!event.data.assessmentId.trim()
    && typeof event.data?.provider === 'string' && !!event.data.provider.trim()
  if (spoken.has(skill)) {
    if (event.modality && event.modality !== 'speaking' && event.modality !== 'transfer') return 0
    // These flags attest to saved speech with a verified transcript; they are not acoustic scores.
    if (event.source === 'ai' && (event.data?.audioObserved !== true || event.data?.transcriptVerified !== true)) return 0
    if (scripted && !supportedAcoustic && event.score! >= 0.6) return 0
    if (scripted && !supportedAcoustic && ['speakingFluency', 'interaction', 'realWorld'].includes(skill)) return 0
    // A successful transfer requires an explicitly novel, identified context.
    if (skill === 'realWorld' && event.score! >= 0.6 && (!event.contextId?.trim() || event.data?.novelContext !== true)) return 0
  }
  return (event.source === 'ai' ? 0.6 : 1) * (scripted ? 0.25 : 1)
}

export function orderedEvents(events: StudyEvent[]): StudyEvent[] {
  const unique = new Map<string, StudyEvent>()
  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp || order(a.id, b.id))) {
    if (!unique.has(event.id) && Number.isFinite(event.timestamp)) unique.set(event.id, event)
  }
  return [...unique.values()]
}

export function aggregateSkills(events: StudyEvent[]): Skill[] {
  const ordered = orderedEvents(events)
  return skillNames.map(id => {
    let totalWeight = 0, estimate = 0, evidenceCount = 0, updatedAt = 0
    for (const event of ordered) {
      if (eventSkill(event) !== id) continue
      const weight = evidenceWeight(event, id)
      if (!weight) continue
      const score = event.prompted ? Math.min(event.score!, 0.6) : event.score!
      // Stable event-order EWMA: recent observations matter without inventing prior mastery.
      const alpha = evidenceCount ? 0.25 * weight : 1
      estimate += alpha * (score - estimate)
      totalWeight += weight
      evidenceCount++
      updatedAt = event.timestamp
    }
    return { id, score: Math.round(estimate * 10_000) / 10_000, confidence: Math.round((1 - Math.exp(-totalWeight / 8)) * 1000) / 1000, evidenceCount, updatedAt }
  })
}

export function skillLabel(name: SkillName): string {
  return ({ vocabularyRecognition: 'Word recognition', vocabularyRecall: 'Word recall', chunkRecognition: 'Chunk recognition', chunkProduction: 'Spontaneous chunks',
    listeningWords: 'Hearing words', listeningSentences: 'Sentence comprehension', naturalListening: 'Natural listening', speakingFluency: 'Speaking fluency',
    speakingAccuracy: 'Speaking accuracy', pronunciation: 'Intelligibility', prosody: 'Rhythm and intonation', grammarProduction: 'Grammar in use',
    reading: 'Reading', writing: 'Writing', interaction: 'Conversation', realWorld: 'Real-world transfer' })[name]
}

function localDate(now: number): string {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function fingerprint(value: unknown): string {
  let hash = 2166136261
  for (const c of JSON.stringify(value)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(36)
}

/** Legacy learn IDs remain language assignments; never rename persisted work. */
export function taskActivity(task: Pick<PlanTask, 'kind'> & { id?: string }): string {
  return task.kind === 'learn' ? task.id?.endsWith(':reading') ? 'reading' : 'chunks' : task.kind
}

export function taskPath(task: PlanTask): { path: string; query: Record<string, string> } {
  return {
    path: task.kind === 'shadow' ? '/listen' : ['repair', 'retell'].includes(task.kind) ? '/speak'
      : task.kind === 'assessment' ? '/progress' : `/${task.kind}`,
    query: { task: task.id, ...(task.materialId ? { material: task.materialId } : {}),
      ...(task.kind === 'learn' ? { mode: taskActivity(task) } : ['shadow', 'repair', 'retell'].includes(task.kind) ? { mode: task.kind } : {}),
      ...(task.kind === 'assessment' ? { assess: '1' } : {}) },
  }
}

export function nextAssignedTask(plan: DailyPlan, afterId?: string): PlanTask | undefined {
  const index = plan.tasks.findIndex(task => task.id === afterId)
  return [...plan.tasks.slice(index + 1), ...plan.tasks.slice(0, index + 1)].find(task => !task.done && !task.optional && task.minutes > 0)
}

export function makePlan(profile: Profile, skills: Skill[], cards: ReviewCard[], events: StudyEvent[], materials: Material[], previous?: DailyPlan, now = Date.now()): DailyPlan {
  const date = localDate(now)
  const today = previous?.date === date ? previous : undefined
  const ordered = orderedEvents(events.filter(e => e.timestamp <= now))
  const longitudinal = planLongitudinal({ profile, skills, cards, events, materials, now })
  const adjustment = longitudinal.adjustments
  const recent = ordered.filter(e => e.timestamp >= now - 7 * day)
  const priority: SkillName[] = ['naturalListening', 'chunkProduction', 'listeningWords', 'speakingFluency', 'interaction', 'grammarProduction', 'vocabularyRecall', 'reading', 'writing', ...skillNames]
  const failures = recent.filter(e => (e.score !== undefined && e.score < 0.6) || e.type === 'error-detected')
  const weakness = (id: SkillName) => {
    const skill = skills.find(s => s.id === id)
    const base = skill?.evidenceCount ? 1 - clamp(skill.score, 0, 1) : 0.55
    return base + failures.filter(e => eventSkill(e) === id).reduce((n, e) => n + (e.source === 'self-report' ? 0.02 : 0.08), 0)
  }
  const focus = [...new Set(priority)].sort((a, b) => weakness(b) - weakness(a) || priority.indexOf(a) - priority.indexOf(b))[0]
  const reviewBlockFinished = ordered.some(e => e.type === 'REVIEW_BLOCK_COMPLETED' && e.source === 'objective' && localDate(e.timestamp) === date)
  const selectedIds = new Set(reviewBlockFinished ? [] : longitudinal.reviews.selectedIds)
  const due = cards.filter(c => selectedIds.has(c.id))
  const fatigue = clamp(profile.fatigue, 0, 1)
  const budget = adjustment.minutes
  const inputSkills: SkillName[] = ['naturalListening', 'listeningWords', 'listeningSentences']
  const targetDifficulty = adjustment.targetDifficulty
  const interestTokens = profile.interests.map(i => i.toLocaleLowerCase('en-US'))
  const rank = (m: Material) => {
    const haystack = `${m.title} ${m.topic} ${m.keywords.join(' ')}`.toLocaleLowerCase('en-US')
    const interest = interestTokens.filter(i => i && haystack.includes(i)).length * 3
    // External participation is handled by the all-time candidate pool below;
    // offering/opening a link must not advance its curriculum position.
    const exposure = m.externalStudy ? 0 : recent.filter(e => e.data?.materialId === m.id).length
    return interest - Math.abs(m.difficulty - targetDifficulty) * 4 - exposure * 0.5
  }
  const approved = materials.filter(m => m.approved)
  const availableMaterials = approved.filter(m => externalCatalogFresh(m, now))
  const approachable = availableMaterials.filter(m => m.difficulty <= Math.min(1, targetDifficulty + 0.25))
  // Screened, approachable human speech leads normal listening. A hard authentic
  // recording does not displace a comprehensible bridge simply for being human.
  const authentic = approachable.filter(m => m.authenticPlayback && !m.synthetic)
  const external = externalLessonCandidates(approachable, ordered, now)
  const listeningPool = authentic.length ? authentic : external.length ? external : approachable.length ? approachable : availableMaterials
  const boundMaterialId = today?.tasks.find(task => !task.done && !task.optional && task.kind === 'listen')?.materialId ?? today?.tasks.find(task => !task.done && !task.optional && task.materialId)?.materialId
  const material = approved.find(item => item.id === boundMaterialId) ?? [...listeningPool].sort((a, b) =>
    (approachable.length ? rank(b) - rank(a) : Math.abs(a.difficulty - targetDifficulty) - Math.abs(b.difficulty - targetDifficulty)) || order(a.id, b.id))[0]
  const activityCount = (kinds: string[]) => recent.filter(e => kinds.includes(e.type.toLowerCase()) || (typeof e.data?.kind === 'string' && kinds.includes(e.data.kind.toLowerCase()))).length
  const inputCount = activityCount(['listen', 'listening', 'reading'])
  const outputCount = activityCount(['speak', 'speaking', 'retell', 'writing'])
  const fluencyCount = activityCount(['shadow', 'retell'])
  const actionableFailures = failures.filter(event => {
    const linked = typeof event.data?.errorId === 'string' ? cards.filter(card => card.errorId === event.data!.errorId) : []
    return !linked.length || linked.some(card => new Date(card.card.due).getTime() <= now)
  })
  const failuresDue = actionableFailures.length || due.some(card => card.errorId)
  const candidates: { kind: PlanTask['kind']; title: string; reason: string; weight: number; materialId?: string; id?: string }[] = []
  if (due.length) candidates.push({ kind: 'review', title: 'Revisit a manageable selection', reason: `${due.length} selected cards. Other due cards stay saved for later; each attempt keeps its own schedule.`, weight: Math.max(1, adjustment.reviewMinutes) })
  candidates.push({ kind: 'listen', title: 'Listen for the meaning', reason: material?.externalStudy
    ? `Practise “${material.title}” on the publisher page, then return to recall the meaning, reuse an expression and record your response.`
    : `Focus on ${skillLabel(focus).toLowerCase()}. ${material ? `Try “${material.title}”.` : 'Choose an approved passage.'} Work in ${adjustment.segmentSeconds}-second sections; aim for about ${adjustment.newInputSeconds} seconds of new input.`, weight: adjustment.inputMinutes / 3 + (inputSkills.includes(focus) ? 1 : 0) + (outputCount > inputCount ? 1 : 0), materialId: material?.id })
  const readingOptions = longitudinal.reading.candidates.filter(f => f.fit !== 'too-hard').flatMap(f => {
    const candidate = approved.find(m => m.id === f.materialId)
    return candidate && (f.fit === 'likely-fit' || candidate.difficulty <= adjustment.readingTargetDifficulty + 0.1) ? [candidate] : []
  })
  // A separate unseen reader can provide new reading observations after listening.
  // Familiar material remains a usable fallback, with exposure labelled by the page.
  const readingMaterial = profile.onboarded ? readingOptions.find(m => m.id !== material?.id && !ordered.some(e =>
    e.data?.materialId === m.id && !['TASK_OFFERED', 'TASK_STARTED', 'TASK_COMPLETED'].includes(e.type)))
    ?? readingOptions[0] : undefined
  if (readingMaterial) candidates.push({ kind: 'learn', title: 'Read something worth sharing',
    reason: 'Read at a comfortable pace, check useful words, then explain the meaning and retell it. Fit is provisional until observed.',
    weight: adjustment.readingMinutes / 3, materialId: readingMaterial.id, id: `${date}:learn:${readingMaterial.id}:reading` })
  const languageMaterial = material?.chunks.length ? material : [...approved].filter(m => m.chunks.length)
    .sort((a, b) => rank(b) - rank(a) || order(a.id, b.id))[0] ?? material
  candidates.push({ kind: 'learn', title: 'Make a chunk your own',
    reason: 'Use a useful expression in your own sentence, save it for spaced retrieval, then write a short rephrasing.',
    weight: (adjustment.languageMinutes + (readingMaterial ? 0 : adjustment.readingMinutes)) / 3,
    materialId: languageMaterial?.id, id: `${date}:learn:${languageMaterial?.id ?? 'practice'}:chunks` })
  candidates.push({ kind: 'speak', title: adjustment.speakingMode === 'guided-familiar' ? 'Start with a familiar situation' : 'Say it in your own words',
    reason: adjustment.speakingMode === 'guided-familiar' ? 'Keep it short: use a familiar topic and a full sentence, then try again with less help.' : adjustment.speakingMode === 'new-context-transfer' ? 'Try a new situation at familiar difficulty. Express a real meaning, then get focused feedback.' : 'Daily speaking: express your meaning independently, then get feedback.',
    weight: adjustment.speakingMinutes / 3 + (spoken.has(focus) ? 1 : 0) + (inputCount > outputCount ? 1 : 0) })
  if (failuresDue) candidates.push({ kind: 'repair', title: 'Repair and try a new context', reason: `Focus on up to ${adjustment.maxRepairTargets} useful corrections. Keep prompted retries separate from independent transfer.`, weight: 2 })
  const assignedFluency = today?.tasks.find(task => !task.optional && (task.kind === 'shadow' || task.kind === 'retell'))
  const fluencyKind = assignedFluency?.kind ?? (fatigue >= 0.6 ? 'shadow' : 'retell')
  // External listening already contains a recorded retell. Existing standalone
  // retell/shadow pages still require a local text reference; never invent one.
  const fluencyMaterial = material?.externalStudy ? [...approved].filter(m => !m.externalStudy && m.transcript.trim()).sort((a, b) => rank(b) - rank(a) || order(a.id, b.id))[0] : material
  candidates.push({ kind: fluencyKind, title: fluencyKind === 'shadow' ? 'Shadow a short sentence' : 'Retell without the script', reason: 'Build fluency through repetition and compare your recordings.', weight: adjustment.fluencyMinutes / 3 + (fluencyCount < Math.max(inputCount, outputCount) ? 0.5 : 0), materialId: fluencyMaterial?.id })
  const lastAssessment = [...ordered].reverse().find(e => ['assessment-completed', 'assessment_completed'].includes(e.type.toLowerCase()))
  if (profile.onboarded && now - (lastAssessment?.timestamp ?? profile.createdAt) >= 14 * day) {
    candidates.push({ kind: 'assessment', title: 'Your two-week check-in', reason: 'Compare listening, retelling, conversation and a real-life mission using a consistent rubric.', weight: 2 })
  }
  // The persisted plan is an assignment, not a fresh recommendation on every render.
  // Exposure, interests and fatigue may change priorities/minutes, never an active task's route.
  for (const candidate of candidates) {
    const assigned = today?.tasks.find(task => !task.done && !task.optional && taskActivity(task) === taskActivity(candidate))
      ?? (candidate.kind !== 'review' && candidate.kind !== 'repair' ? today?.tasks.find(task => !task.optional && taskActivity(task) === taskActivity(candidate)) : undefined)
    if (!assigned) continue
    candidate.id = assigned.id
    candidate.materialId = assigned.materialId
    candidate.title = assigned.title
    candidate.reason = assigned.reason
  }
  // A queue can drain before the UI commits completion. Keep its task addressable until that commit.
  for (const assigned of today?.tasks ?? []) {
    if (!assigned.done && !assigned.optional && !candidates.some(candidate => candidate.id === assigned.id)) {
      candidates.push({ ...assigned, weight: 1 })
    }
  }
  const planFingerprint = fingerprint({ profile, skills: [...skills].sort((a, b) => order(a.id, b.id)), due: due.map(c => [c.id, new Date(c.card.due).getTime()]).sort(), recent, material: material?.id, reading: readingMaterial?.id, adjustment, date })
  // Completed work keeps its identity/duration. Newly selected work never inherits a different task's done flag.
  const completed = (today?.tasks ?? []).filter(t => t.done).map(t => ({ ...t }))
  const taskId = (c: typeof candidates[number]) => {
    if (c.id) return c.id
    const queue = c.kind === 'review' ? fingerprint(due.map(card => [card.id, card.card.reps]).sort())
      : c.kind === 'repair' ? fingerprint([actionableFailures.map(event => event.id), due.filter(card => card.errorId).map(card => [card.id, card.card.reps, new Date(card.card.due).getTime()]).sort()]) : ''
    return `${date}:${c.kind}:${c.materialId ?? 'practice'}${queue ? `:${queue}` : ''}`
  }
  let outstanding = candidates.filter(c => !completed.some(t => t.id === taskId(c)
    || (taskActivity(t) === taskActivity(c) && c.kind !== 'review' && c.kind !== 'repair'
      && !t.optional
      && !today?.tasks.some(assigned => !assigned.done && assigned.id === taskId(c)))))
  const spent = completed.reduce((n, t) => n + (t.optional ? 0 : t.minutes), 0)
  const remaining = Math.max(0, budget - spent)
  const optional = (today?.tasks ?? []).filter(task => !task.done && task.optional).map(task => ({ ...task }))
  const locked = new Map<string, number>()
  let uncommitted = remaining
  const started = today?.tasks.some(task => !task.done && !task.optional) ? startedTaskIds(events, now) : new Set<string>()
  for (const task of today?.tasks ?? []) if (!task.done && !task.optional && started.has(task.id)) {
    if (task.minutes <= uncommitted) { locked.set(task.id, task.minutes); uncommitted -= task.minutes }
    else optional.push({ ...task, optional: true })
  }
  outstanding = outstanding.filter(candidate => !optional.some(task => task.id === taskId(candidate)))
  // Completed time is historical; never inflate today's budget to fit new arrivals.
  // No zero-minute placeholders: genuinely unused time alone can admit new work.
  const reviewIndex = outstanding.findIndex(c => c.kind === 'review')
  const allocations = outstanding.map(candidate => locked.get(taskId(candidate)) ?? 0)
  let available = remaining - allocations.reduce((sum, value) => sum + value, 0)
  const nonReview = outstanding.map((_, i) => i).filter(i => i !== reviewIndex && !locked.has(taskId(outstanding[i])))
  // A newly introduced activity must not displace an already begun assignment
  // when only a small part of today's unchanged budget remains.
  if (reviewIndex >= 0) {
    const extra = locked.has(taskId(outstanding[reviewIndex])) ? 0
      : Math.min(Math.max(1, adjustment.reviewMinutes) - allocations[reviewIndex], Math.max(0, available - nonReview.filter(i => !allocations[i]).length))
    allocations[reviewIndex] += extra
    available -= extra
  }
  const priorityOrder = [...nonReview].sort((a, b) => Number(outstanding[b].kind === 'speak') - Number(outstanding[a].kind === 'speak') || a - b)
  for (const i of priorityOrder) if (available > 0 && !allocations[i]) { allocations[i]++; available-- }
  const weights = nonReview.reduce((n, i) => n + outstanding[i].weight, 0)
  const extras = nonReview.map(i => ({ i, value: weights ? available * outstanding[i].weight / weights : 0 }))
  for (const { i, value } of extras) allocations[i] += Math.floor(value)
  let remainder = remaining - allocations.reduce((a, b) => a + b, 0)
  for (const { i } of extras.sort((a, b) => (b.value % 1) - (a.value % 1) || a.i - b.i)) if (remainder > 0) { allocations[i]++; remainder-- }
  if (remainder && reviewIndex >= 0 && !nonReview.length) {
    // A finished plan with only a small later review does not need to fill unused time.
    remainder = 0
  }
  const pending: PlanTask[] = outstanding.flatMap((c, index) => {
    const minutes = allocations[index]
    if (minutes <= 0) return []
    const { weight: _weight, ...task } = c
    void _weight
    return [{ ...task, id: taskId(c), minutes, done: false }]
  })
  const priorOrder = new Map(today?.tasks.map((task, index) => [task.id, index]))
  const nextOutput = today?.tasks.findIndex(task => ['speak', 'repair', 'retell', 'shadow', 'assessment'].includes(task.kind) && !task.done) ?? -1
  if (nextOutput >= 0) {
    // Fit a newly added learning activity into the automatic chain without
    // renaming/reordering any previously assigned or completed task.
    for (const task of pending.filter(t => t.kind === 'learn' && !priorOrder.has(t.id)))
      priorOrder.set(task.id, nextOutput - (taskActivity(task) === 'reading' ? 0.2 : 0.1))
  }
  const tasks = [...completed, ...pending, ...optional].sort((a, b) => (priorOrder.get(a.id) ?? Infinity) - (priorOrder.get(b.id) ?? Infinity))
  return { id: today?.id ?? date, date, minutes: tasks.reduce((n, t) => n + (t.optional ? 0 : t.minutes), 0), focus, tasks, evidenceFingerprint: planFingerprint, createdAt: today?.createdAt ?? now }
}
