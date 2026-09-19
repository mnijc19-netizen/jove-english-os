import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { allocateLanguageDay, type LanguageDay } from '../src/domain/language'
import { makePlan } from '../src/domain/engine'
import { defaultProfile, type DailyPlan, type StudyEvent } from '../src/domain/types'
import { JoveDatabase } from '../src/db/db'
import { readLanguageDay } from '../src/db/language-day'
import { demoMaterials } from '../src/content/materials'

const now = new Date(2026, 8, 20, 12).getTime(), date = new Date(now).toLocaleDateString('en-CA')
const empty = (): LanguageDay => ({ enabled: true, dueCards: 0, events: [] })
const plan = (id: string, minutes: number, done = false, optional = false): DailyPlan => ({ id: date, date, minutes: optional ? 0 : minutes,
  focus: 'naturalListening', evidenceFingerprint: 'fixture', createdAt: now,
  tasks: [{ id, kind: 'listen', title: 'Saved task', reason: 'Actual assigned work', minutes, done, ...(optional ? { optional } : {}) }] })
const finished = (id: string, minutes: number): StudyEvent => ({ id: `completed:${id}`, type: 'TASK_COMPLETED', source: 'objective',
  timestamp: now, data: { taskId: id, minutes } })
const databases: JoveDatabase[] = []
afterEach(async () => { for (const db of databases.splice(0)) await db.delete() })

describe('one daily budget across two independent learning spaces', () => {
  it('allocates one budget, not a full budget per language', () => {
    const result = allocateLanguageDay(45, { en: empty(), ja: empty() }, now)
    expect(result.allowances.en.remaining + result.allowances.ja.remaining).toBe(45)
    expect(Math.abs(result.allowances.en.remaining - result.allowances.ja.remaining)).toBe(1)
    expect(allocateLanguageDay(45, { en: empty(), ja: { ...empty(), enabled: false } }, now).allowances.en.remaining).toBe(45)
  })
  it('counts equal task IDs separately by language but deduplicates each completion', () => {
    const result = allocateLanguageDay(45, {
      en: { ...empty(), plan: plan('same', 15, true), events: [finished('same', 15), { ...finished('same', 15), id: 'duplicate' }] },
      ja: { ...empty(), plan: plan('same', 10, true), events: [finished('same', 10)] },
    }, now)
    expect(result.credited).toBe(25)
    expect(result.allowances.en.remaining + result.allowances.ja.remaining).toBe(20)
    expect(result.allowances.en.planCap + result.allowances.ja.planCap).toBe(45)
  })
  it('subtracts actual completion events even before a stale plan catches up', () => {
    const result = allocateLanguageDay(45, { en: { ...empty(), plan: plan('en', 30), events: [finished('en', 30)] }, ja: empty() }, now)
    expect(result.credited).toBe(30)
    expect(result.allowances.en.remaining).toBe(0)
    expect(result.allowances.ja.remaining).toBe(15)
  })
  it('never turns optional completed work or a language switch into a fresh daily quota', () => {
    const result = allocateLanguageDay(45, { en: { ...empty(), plan: plan('extra', 45, true, true) }, ja: empty() }, now)
    expect(result.allowances.en.planCap).toBe(0); expect(result.allowances.ja.planCap).toBe(0)
    expect(result.credited).toBe(45)
    const planned = makePlan(defaultProfile(), [], [], [], demoMaterials, undefined, now, result.allowances.en.planCap)
    expect(planned.tasks.filter(task => !task.optional && !task.done)).toEqual([])
  })
  it('keeps underway time before adding new tasks and does not let overdue cards monopolize the day', () => {
    const task = plan('started', 30), started: StudyEvent = { id: 'start', type: 'TASK_STARTED', source: 'objective', timestamp: now, data: { taskId: 'started', kind: 'listen' } }
    const result = allocateLanguageDay(45, { en: { ...empty(), plan: task, events: [started] }, ja: { ...empty(), dueCards: 10000 } }, now)
    expect(result.allowances.en.reserved).toBe(30); expect(result.allowances.ja.remaining).toBe(15)
    const balanced = allocateLanguageDay(45, { en: empty(), ja: { ...empty(), dueCards: 10000 } }, now)
    expect(balanced.allowances.en.remaining).toBeGreaterThanOrEqual(18)
  })
  it('preserves over-budget history and ignores future, self-report and previous-day completions', () => {
    const result = allocateLanguageDay(45, { en: { ...empty(), plan: plan('done', 60, true), events: [
      { ...finished('future', 20), timestamp: now + 1 }, { ...finished('old', 20), timestamp: now - 86400000 },
      { ...finished('claim', 20), source: 'self-report' },
    ] }, ja: empty() }, now)
    expect(result.credited).toBe(60); expect(result.overBudget).toBe(15)
    expect(result.allowances.en.remaining + result.allowances.ja.remaining).toBe(0)
  })
  it('rechecks the account boundary before combining workspaces and honors the shared preference', async () => {
    const en = new JoveDatabase(`day-en-${crypto.randomUUID()}`), ja = new JoveDatabase(`day-ja-${crypto.randomUUID()}`, 'ja')
    databases.push(en, ja)
    await en.profiles.put({ ...defaultProfile(), onboarded: true, dailyMinutes: 90 })
    await ja.profiles.put({ ...defaultProfile(), onboarded: true, dailyMinutes: 150 })
    await en.syncMeta.put({ id: 'owner', value: 'account-a' }); await ja.syncMeta.put({ id: 'owner', value: 'account-b' })
    expect(await readLanguageDay(en, now, ja)).toBeNull()
    await ja.syncMeta.put({ id: 'owner', value: 'account-a' })
    const combined = await readLanguageDay(en, now, ja)
    expect(combined?.totalMinutes).toBe(90)
    expect(combined!.allowances.en.remaining + combined!.allowances.ja.remaining).toBe(90)
  })
})
