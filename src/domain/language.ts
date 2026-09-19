/** Workspace identity is infrastructure, not evidence inferred from text. */
import type { DailyPlan, StudyEvent } from './types'
import { startedTaskIds } from './longitudinal'
export type LearningLanguage = 'en' | 'ja'
export const languageDatabases: Record<LearningLanguage, string> = {
  en: 'jove-english-os', ja: 'jove-english-os-ja',
}
export function assertLearningLanguage(value: unknown): asserts value is LearningLanguage {
  if (value !== 'en' && value !== 'ja') throw new Error('Unsupported learning language')
}

export interface LanguageDay {
  enabled: boolean
  plan?: DailyPlan
  events: StudyEvent[]
  dueCards: number
}
export interface LanguageAllowance {
  completed: number
  reserved: number
  remaining: number
  planCap: number
}
/** Planned/completed task minutes are workload accounting, not measured learning
 * time or mastery. Already completed work is never rewritten to fit the budget. */
export function allocateLanguageDay(totalMinutes: number, spaces: Record<LearningLanguage, LanguageDay>, now: number) {
  if (!Number.isInteger(totalMinutes) || totalMinutes < 1 || totalMinutes > 1440 || !Number.isFinite(now)) throw new Error('Invalid shared daily budget')
  const date = new Date(now).toLocaleDateString('en-CA'), languages = ['en', 'ja'] as const
  const completed = { en: 0, ja: 0 }, requiredCompleted = { en: 0, ja: 0 }, active = { en: 0, ja: 0 }
  const allowed = (minutes: unknown): minutes is number => Number.isInteger(minutes) && Number(minutes) > 0 && Number(minutes) <= 1440
  for (const language of languages) {
    const space = spaces[language], tasks = space.plan?.date === date ? space.plan.tasks : []
    const done = new Map(tasks.filter(task => task.done).map(task => [task.id, task.minutes]))
    for (const event of space.events) if (event.type === 'TASK_COMPLETED' && event.source === 'objective' && event.timestamp <= now
      && new Date(event.timestamp).toLocaleDateString('en-CA') === date && typeof event.data?.taskId === 'string'
      && event.data.taskId.trim() && allowed(event.data.minutes) && !done.has(event.data.taskId)) done.set(event.data.taskId, event.data.minutes)
    completed[language] = [...done.values()].filter(allowed).reduce((sum, minutes) => sum + minutes, 0)
    requiredCompleted[language] = tasks.filter(task => task.done && !task.optional && allowed(task.minutes)).reduce((sum, task) => sum + task.minutes, 0)
    const started = startedTaskIds(space.events, now)
    active[language] = tasks.filter(task => !task.done && !task.optional && !done.has(task.id) && started.has(task.id) && allowed(task.minutes)).reduce((sum, task) => sum + task.minutes, 0)
  }
  const credited = completed.en + completed.ja, remaining = Math.max(0, totalMinutes - credited)
  const allocated = { en: 0, ja: 0 }, reserved = { en: 0, ja: 0 }
  const enabled = languages.filter(language => spaces[language].enabled)
  // Preserve in-progress work first. If offline histories exceed the budget,
  // retain them as history and stop adding compulsory tasks; never erase work.
  let available = remaining
  for (const language of enabled) {
    reserved[language] = allocated[language] = Math.min(active[language], available)
    available -= reserved[language]
  }
  const weight = (language: LearningLanguage) => 1 + Math.min(0.5, Math.max(0, Number.isFinite(spaces[language].dueCards) ? spaces[language].dueCards : 0) / 40)
  const first = new Date(now).getDate() % 2 ? 'ja' : 'en'
  // Small bounded integer allocation, based on the whole day's work. A switch
  // cannot create a fresh allowance, and overdue cards cannot monopolize it.
  while (available > 0 && enabled.length) {
    const next = [...enabled].sort((a, b) => (completed[a] + allocated[a]) / weight(a) - (completed[b] + allocated[b]) / weight(b)
      || Number(b === first) - Number(a === first))[0]!
    allocated[next]++; available--
  }
  const allowances = Object.fromEntries(languages.map(language => [language, {
    completed: completed[language], reserved: reserved[language], remaining: allocated[language],
    planCap: requiredCompleted[language] + allocated[language],
  }])) as Record<LearningLanguage, LanguageAllowance>
  return { date, totalMinutes, credited, remaining, overBudget: Math.max(0, credited - totalMinutes), allowances }
}
