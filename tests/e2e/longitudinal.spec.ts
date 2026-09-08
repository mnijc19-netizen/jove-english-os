import { test, expect } from './browser-fixtures'
import type { Page } from '@playwright/test'
import { createEmptyCard } from 'ts-fsrs'
import type { Assessment, DailyPlan, Material, StudyEvent } from '../../src/domain/types'

const passage = 'People share stories because they want to understand one another. A good friend listens carefully and asks a kind question. We can learn from ordinary moments and small surprises. Try to explain your idea using familiar words and a useful detail. Then ask your friend what they think about it.'
const reader = (now: number): Material => ({ id: 'reading-check-fixture', title: 'A story to share', topic: 'Everyday life', difficulty: 0.3,
  duration: 60, transcript: passage, sentences: passage.match(/[^.!?]+[.!?]*/g)!, sourceKind: 'curated', sourceLabel: 'Original test passage',
  approved: true, synthetic: false, question: 'How do stories help?', answer: 'People understand one another.', keywords: [], chunks: [], createdAt: now - 86400000 })
async function rows<T>(page: Page, table: string): Promise<T[]> {
  return page.evaluate(name => new Promise<T[]>((resolve, reject) => {
    const request = indexedDB.open('jove-english-os'); request.onerror = () => reject(request.error)
    request.onsuccess = () => { const database = request.result, tx = database.transaction(name), read = tx.objectStore(name).getAll()
      read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); tx.oncomplete = () => database.close() }
  }), table)
}
async function put(page: Page, table: string, values: unknown[]) {
  await page.evaluate(({ table, values }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('jove-english-os'); request.onerror = () => reject(request.error)
    request.onsuccess = () => { const database = request.result, tx = database.transaction(table, 'readwrite')
      tx.oncomplete = () => { database.close(); resolve() }; tx.onabort = () => reject(tx.error)
      for (const value of values) tx.objectStore(table).put(value) }
  }), { table, values })
}

test('five-part assessment preserves reading through reload without inventing improvement', async ({ page }) => {
  // Install before component timers exist; installing later can orphan native intervals.
  await page.clock.install()
  await page.goto('#/progress'); await page.getByRole('heading', { level: 1 }).waitFor()
  const now = await page.evaluate(() => Date.now()), material = reader(now)
  await put(page, 'materials', [material])
  const dialogue = [0, 1, 2].flatMap(i => [{ id: 'partner-' + i, role: 'assistant', text: 'What would work for you?', timestamp: now - 20000 + i * 1000 },
    { id: 'learner-' + i, role: 'user', text: 'I can offer a flexible plan and ask for your preference.', timestamp: now - 19500 + i * 1000 }])
  dialogue.push({ id: 'partner-end', role: 'assistant', text: 'That is a clear next step.', timestamp: now - 10000 })
  // First three steps are historical fixtures, not claims of live audio/provider validation.
  await put(page, 'assessments', [{ id: 'five-part-fixture', timestamp: now - 60000, variant: 0, stage: '3', scores: { Listening: null, Retell: null, Conversation: null },
    responses: { rubric: 'demo-1', observationVersion: '2', 'dialogue-3': JSON.stringify(dialogue), readingMaterialSnapshot: JSON.stringify(material) } }])
  await page.goto('#/progress?assess=1'); await page.reload()
  await page.getByRole('button', { name: 'Save & continue' }).click()
  await page.getByRole('button', { name: 'Start reading', exact: true }).waitFor()
  expect((await rows<Assessment>(page, 'assessments')).find(a => a.id === 'five-part-fixture')?.completedAt).toBeUndefined()
  await page.getByRole('button', { name: 'Start reading', exact: true }).click()
  await page.clock.runFor(32000)
  await page.locator('.assessment-card').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `.work/reading-check-in-${test.info().project.name}.png` })
  await page.getByRole('button', { name: 'I read this section', exact: false }).click()
  await page.locator('#reading-response').fill('Sharing a story helps people understand each other; asking a kind question makes listening useful.')
  await page.reload(); await page.locator('#reading-response').waitFor()
  await expect(page.locator('#reading-response')).toHaveValue(/Sharing a story/)
  await page.locator('#reading-retell').fill('A good friend listens carefully, asks a question, and shares an idea with a useful detail.')
  await page.getByRole('button', { name: 'Save reading & retell' }).click()
  await expect(page.getByRole('button', { name: 'Finish five-part check-in' })).toBeEnabled()
  expect((await rows<StudyEvent>(page, 'events')).filter(e => e.skill === 'reading' && e.score !== undefined)).toHaveLength(0)
  await page.getByRole('button', { name: 'Finish five-part check-in' }).click()
  await expect.poll(async () => (await rows<Assessment>(page, 'assessments')).find(a => a.id === 'five-part-fixture')?.stage).toBe('complete')
  const assessment = (await rows<Assessment>(page, 'assessments')).find(a => a.id === 'five-part-fixture')!
  expect(assessment.scores.Reading).toBeNull()
  expect(assessment.responses.Reading).toContain('Sharing a story')
  expect(assessment.responses.readingRetell).toContain('A good friend')
  expect(assessment.responses['scorer-4']).toContain('not improvement')
  await page.goto('#/progress'); await page.reload()
  await expect(page.getByRole('region', { name: 'Four-week evidence and adjustments' })).toContainText('still unknown')
  expect((await rows<StudyEvent>(page, 'events')).filter(e => e.id === 'five-part-fixture-complete')).toHaveLength(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
})

test('completed daily budget offers optional review without adding plan minutes or completing due cards', async ({ page }) => {
  await page.goto('#/'); await page.getByRole('heading', { level: 1 }).waitFor()
  const now = await page.evaluate(() => Date.now()), date = await page.evaluate(() => new Date().toLocaleDateString('en-CA'))
  const plan: DailyPlan = { id: date, date, minutes: 45, focus: 'reading', evidenceFingerprint: 'fixture', createdAt: now,
    tasks: ['listen', 'learn', 'speak', 'retell'].map((kind, i) => ({ id: `${date}:${kind}:finished`, kind: kind as DailyPlan['tasks'][number]['kind'],
      title: 'Completed practice', minutes: i === 0 ? 15 : 10, reason: 'Actual completion fixture', done: true })) }
  await put(page, 'plans', [plan])
  await put(page, 'chunks', [{ id: 'extra-chunk', text: 'Keep in touch', meaningEn: 'Continue contacting someone', meaningZh: '', sourceSentence: 'Let us keep in touch.',
    examples: [], register: 'neutral', sourceIds: [], readingStrength: 0, listeningStrength: 0, recallStrength: 0, productionStrength: 0, spontaneousUses: 0, createdAt: now }])
  await put(page, 'cards', [{ id: 'extra-card', chunkId: 'extra-chunk', modality: 'recognition', card: createEmptyCard(now - 1), contextIds: [] }])
  await page.reload()
  await expect(page.getByRole('link', { name: 'Optional extra review' })).toBeVisible()
  expect((await rows<DailyPlan>(page, 'plans')).find(p => p.id === date)?.minutes).toBe(45)
  await page.getByRole('link', { name: 'Optional extra review' }).click()
  await page.getByRole('combobox', { name: 'Practice type' }).selectOption('recognition')
  await page.locator('#review-answer').waitFor()
  const cards = await rows<{ id: string; card: { reps: number } }>(page, 'cards')
  expect(cards.find(c => c.id === 'extra-card')?.card.reps).toBe(0)
  expect((await rows<DailyPlan>(page, 'plans')).find(p => p.id === date)).toMatchObject({ minutes: 45, tasks: plan.tasks })
  await expect(page.getByText("This optional practice does not add tasks or minutes to today's plan.")).toBeVisible()
})

test('changing goals and interests preserves a begun reading task and its response', async ({ page }) => {
  await page.clock.install()
  await page.goto('#/'); await page.getByRole('heading', { level: 1 }).waitFor()
  const now = await page.evaluate(() => Date.now()), date = await page.evaluate(() => new Date().toLocaleDateString('en-CA'))
  const material = reader(now), taskId = `${date}:learn:${material.id}:reading`
  await put(page, 'materials', [material])
  await put(page, 'plans', [{ id: date, date, minutes: 45, focus: 'reading', evidenceFingerprint: 'begin-fixture', createdAt: now,
    tasks: [{ id: taskId, kind: 'learn', title: 'Read something worth sharing', minutes: 45, reason: 'Original reading assignment', done: false, materialId: material.id }] }])
  await page.reload()
  await page.getByRole('button', { name: 'Start today’s practice' }).click()
  await page.getByRole('button', { name: 'Start reading', exact: true }).click()
  await page.clock.runFor(4000)
  await page.getByRole('button', { name: 'I read this section', exact: false }).click()
  await page.locator('#reading-response').fill('Preserve my first thought while I change my learning preferences.')
  await page.goto('#/onboarding')
  await page.getByLabel('Your main direction').selectOption('Movies & natural listening')
  await page.locator('.topic-chips button').first().click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect.poll(async () => (await rows<DailyPlan>(page, 'plans')).find(p => p.id === date)?.tasks.find(t => t.id === taskId)?.materialId).toBe(material.id)
  await page.goto(`#/learn?mode=reading&task=${encodeURIComponent(taskId)}&material=${material.id}`)
  await expect(page.locator('#reading-response')).toHaveValue('Preserve my first thought while I change my learning preferences.')
  const starts = (await rows<StudyEvent>(page, 'events')).filter(e => e.id === `started:${taskId}`)
  expect(starts).toHaveLength(1)
  expect((await rows<DailyPlan>(page, 'plans')).find(p => p.id === date)?.tasks.find(t => t.id === taskId)?.done).toBe(false)
})
