import { skillNames, type DailyPlan, type Material, type Profile, type ReviewCard, type Skill, type SkillName, type StudyEvent, type PlanTask } from './types'

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
  if (!['objective', 'self-report', 'ai', 'text', 'acoustic'].includes(event.source)) return 0
  if (!skill || !Number.isFinite(event.score) || event.score! < 0 || event.score! > 1 || event.source === 'self-report') return 0
  if (event.source === 'text' && !textSkills.has(skill)) return 0
  if ((skill === 'pronunciation' || skill === 'prosody' || skill === 'speakingFluency') && event.source !== 'acoustic') return 0
  if (spoken.has(skill)) {
    if (event.modality && event.modality !== 'speaking' && event.modality !== 'transfer') return 0
    // These flags attest to saved speech with a verified transcript; they are not acoustic scores.
    if (event.source === 'ai' && (event.data?.audioObserved !== true || event.data?.transcriptVerified !== true)) return 0
    if (event.prompted && event.score! >= 0.6) return 0
    // A successful transfer requires an explicitly novel, identified context.
    if (skill === 'realWorld' && event.score! >= 0.6 && (!event.contextId?.trim() || event.data?.novelContext !== true)) return 0
  }
  return (event.source === 'ai' ? 0.6 : 1) * (event.prompted ? 0.25 : 1)
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

export function makePlan(profile: Profile, skills: Skill[], cards: ReviewCard[], events: StudyEvent[], materials: Material[], previous?: DailyPlan, now = Date.now()): DailyPlan {
  const date = localDate(now)
  const today = previous?.date === date ? previous : undefined
  const ordered = orderedEvents(events.filter(e => e.timestamp <= now))
  const recent = ordered.filter(e => e.timestamp >= now - 7 * day)
  const priority: SkillName[] = ['naturalListening', 'chunkProduction', 'listeningWords', 'speakingFluency', 'interaction', 'grammarProduction', 'vocabularyRecall', 'reading', 'writing', ...skillNames]
  const failures = recent.filter(e => (e.score !== undefined && e.score < 0.6) || e.type === 'error-detected')
  const weakness = (id: SkillName) => {
    const skill = skills.find(s => s.id === id)
    const base = skill?.evidenceCount ? 1 - clamp(skill.score, 0, 1) : 0.55
    return base + failures.filter(e => eventSkill(e) === id).reduce((n, e) => n + (e.source === 'self-report' ? 0.02 : 0.08), 0)
  }
  const focus = [...new Set(priority)].sort((a, b) => weakness(b) - weakness(a) || priority.indexOf(a) - priority.indexOf(b))[0]
  const due = cards.filter(c => new Date(c.card.due).getTime() <= now)
  const fatigue = clamp(profile.fatigue, 0, 1)
  const requested = clamp(Math.round(profile.dailyMinutes), 15, 180)
  const budget = Math.max(15, Math.round(requested * (1 - fatigue * 0.4)))
  const inputSkills: SkillName[] = ['naturalListening', 'listeningWords', 'listeningSentences']
  const observed = skills.filter(s => inputSkills.includes(s.id) && s.evidenceCount)
  const targetDifficulty = observed.length ? observed.reduce((n, s) => n + s.score, 0) / observed.length : 0.35
  const interestTokens = profile.interests.map(i => i.toLocaleLowerCase('en-US'))
  const rank = (m: Material) => {
    const haystack = `${m.title} ${m.topic} ${m.keywords.join(' ')}`.toLocaleLowerCase('en-US')
    const interest = interestTokens.filter(i => i && haystack.includes(i)).length * 3
    const exposure = recent.filter(e => e.data?.materialId === m.id).length
    return interest - Math.abs(m.difficulty - targetDifficulty) * 4 - exposure * 0.5
  }
  const approved = materials.filter(m => m.approved)
  const approachable = approved.filter(m => m.difficulty <= Math.min(1, targetDifficulty + 0.25))
  const boundMaterialId = today?.tasks.find(task => !task.done && task.kind === 'listen')?.materialId ?? today?.tasks.find(task => !task.done && task.materialId)?.materialId
  const material = approved.find(item => item.id === boundMaterialId) ?? [...(approachable.length ? approachable : approved)].sort((a, b) =>
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
  if (due.length) candidates.push({ kind: 'review', title: 'Revisit your chunks', reason: `${due.length} cards due, with separate listening, recall and production practice.`, weight: Math.min(3, 1 + due.length / 10) })
  candidates.push({ kind: 'listen', title: 'Listen for the meaning', reason: `Focus on ${skillLabel(focus).toLowerCase()}. ${material ? `Try “${material.title}”.` : 'Choose or import an approved passage.'}`, weight: 3 + (inputSkills.includes(focus) ? 1 : 0) + (outputCount > inputCount ? 1 : 0), materialId: material?.id })
  candidates.push({ kind: 'learn', title: focus === 'reading' || focus === 'writing' ? 'Read and rephrase' : 'Make a chunk your own', reason: 'Recall complete expressions, then use them in a short written response.', weight: 1.5 + (focus === 'reading' || focus === 'writing' ? 1 : 0), materialId: material?.id })
  candidates.push({ kind: 'speak', title: 'Say it in your own words', reason: 'Daily speaking: express your meaning independently, then get feedback.', weight: 3 + (spoken.has(focus) ? 1 : 0) + (inputCount > outputCount ? 1 : 0) })
  if (failuresDue) candidates.push({ kind: 'repair', title: 'Repair and try a new context', reason: `${actionableFailures.length} recent difficulties. Keep prompted retries separate from independent transfer.`, weight: 2 })
  const assignedFluency = today?.tasks.find(task => task.kind === 'shadow' || task.kind === 'retell')
  const fluencyKind = assignedFluency?.kind ?? (fatigue >= 0.6 ? 'shadow' : 'retell')
  candidates.push({ kind: fluencyKind, title: fluencyKind === 'shadow' ? 'Shadow a short sentence' : 'Retell without the script', reason: 'Build fluency through repetition and compare your recordings.', weight: fluencyCount < Math.max(inputCount, outputCount) ? 2 : 1.5, materialId: material?.id })
  const lastAssessment = [...ordered].reverse().find(e => ['assessment-completed', 'assessment_completed'].includes(e.type.toLowerCase()))
  if (profile.onboarded && now - (lastAssessment?.timestamp ?? profile.createdAt) >= 14 * day) {
    candidates.push({ kind: 'assessment', title: 'Your two-week check-in', reason: 'Compare listening, retelling, conversation and a real-life mission using a consistent rubric.', weight: 2 })
  }
  // The persisted plan is an assignment, not a fresh recommendation on every render.
  // Exposure, interests and fatigue may change priorities/minutes, never an active task's route.
  for (const candidate of candidates) {
    const assigned = today?.tasks.find(task => !task.done && task.kind === candidate.kind)
      ?? (candidate.kind !== 'review' && candidate.kind !== 'repair' ? today?.tasks.find(task => task.kind === candidate.kind) : undefined)
    if (!assigned || (assigned.materialId && !approved.some(item => item.id === assigned.materialId))) continue
    candidate.id = assigned.id
    candidate.materialId = assigned.materialId
    candidate.title = assigned.title
    candidate.reason = assigned.reason
  }
  // A queue can drain before the UI commits completion. Keep its task addressable until that commit.
  for (const assigned of today?.tasks ?? []) {
    if (!assigned.done && !candidates.some(candidate => candidate.kind === assigned.kind)
      && (!assigned.materialId || approved.some(item => item.id === assigned.materialId))) {
      candidates.push({ ...assigned, weight: 1 })
    }
  }
  const planFingerprint = fingerprint({ profile, skills: [...skills].sort((a, b) => order(a.id, b.id)), due: due.map(c => [c.id, new Date(c.card.due).getTime()]).sort(), recent, material: material?.id, date })
  // Completed work keeps its identity/duration. Newly selected work never inherits a different task's done flag.
  const completed = (today?.tasks ?? []).filter(t => t.done).map(t => ({ ...t }))
  const taskId = (c: typeof candidates[number]) => {
    if (c.id) return c.id
    const queue = c.kind === 'review' ? fingerprint(due.map(card => [card.id, card.card.reps]).sort())
      : c.kind === 'repair' ? fingerprint([actionableFailures.map(event => event.id), due.filter(card => card.errorId).map(card => [card.id, card.card.reps, new Date(card.card.due).getTime()]).sort()]) : ''
    return `${date}:${c.kind}:${c.materialId ?? 'practice'}${queue ? `:${queue}` : ''}`
  }
  const outstanding = candidates.filter(c => !completed.some(t => t.id === taskId(c)
    || (t.kind === c.kind && c.kind !== 'review' && c.kind !== 'repair')))
  const spent = completed.reduce((n, t) => n + t.minutes, 0)
  const remaining = Math.max(outstanding.length, budget - spent)
  const weights = outstanding.reduce((n, c) => n + c.weight, 0)
  let allocated = 0
  const pending: PlanTask[] = outstanding.map((c, index) => {
    const extra = remaining - outstanding.length
    const minutes = index === outstanding.length - 1 ? remaining - allocated : 1 + Math.floor(extra * c.weight / weights)
    allocated += minutes
    const { weight: _weight, ...task } = c
    void _weight
    return { ...task, id: taskId(c), minutes, done: false }
  })
  const priorOrder = new Map(today?.tasks.map((task, index) => [task.id, index]))
  const tasks = [...completed, ...pending].sort((a, b) => (priorOrder.get(a.id) ?? Infinity) - (priorOrder.get(b.id) ?? Infinity))
  return { id: today?.id ?? date, date, minutes: tasks.reduce((n, t) => n + t.minutes, 0), focus, tasks, evidenceFingerprint: planFingerprint, createdAt: today?.createdAt ?? now }
}
