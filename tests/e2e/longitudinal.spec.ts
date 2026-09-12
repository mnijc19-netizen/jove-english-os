import { test, expect } from './browser-fixtures'
import type { Page } from '@playwright/test'
import { createEmptyCard } from 'ts-fsrs'
import type { Assessment, DailyPlan, Material, Profile, StudyEvent, StudySession } from '../../src/domain/types'
import { demoMaterials } from '../../src/content/materials'
import { changedFields, parseOperation, projectOperations, type RecordValue } from '../../src/sync/protocol'

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

test('route focus cannot interrupt an editor after navigation has rendered', async ({ page }) => {
  await page.goto('#/'); await page.getByRole('heading', { level: 1 }).waitFor()
  const now = await page.evaluate(() => Date.now())
  await page.clock.install({ time: new Date(now) })
  await page.clock.pauseAt(new Date(now + 1000))
  await page.goto(`#/learn?material=${demoMaterials[0]!.id}`)
  const editor = page.locator('.chunk-card textarea').first()
  await expect(editor).toBeEditable()
  await editor.focus()
  await expect(editor).toBeFocused()
  // A user can begin typing before a deferred route-focus callback runs.
  // Advance only the clock, never dispatch or replace a focus/input event.
  await page.clock.runFor(100)
  await expect(editor).toBeFocused()
  const response = 'I can use this expression to help a friend.'
  await page.keyboard.type(response)
  await expect(editor).toHaveValue(response)
  await expect(page.getByRole('button', { name: 'Save my example & practice later' }).first()).toBeEnabled()
  await expect.poll(async () => (await rows<StudySession>(page, 'sessions'))
    .find(row => row.id === `learn-draft-${demoMaterials[0]!.id}`)?.draft.recalled).toMatchObject({ [demoMaterials[0]!.chunks[0]!.text]: response })
})

test('synced unsent reading has an optional independent recovery that survives reload without repeating the assignment', async ({ page }) => {
  await page.goto('#/'); await page.getByRole('heading', { level: 1 }).waitFor()
  const now = await page.evaluate(() => Date.now()), date = await page.evaluate(() => new Date().toLocaleDateString('en-CA'))
  const material = reader(now), taskId = `${date}:learn:${material.id}:reading`, sessionId = `reading:${taskId}`
  const base: StudySession = { id: sessionId, kind: 'reading', materialId: material.id, startedAt: now - 5000, stage: 'respond',
    draft: { passage, activeMs: 4000, response: '', submittedResponse: '', retell: '' } }
  const saved = { ...base, completedAt: now, stage: 'saved', draft: { ...base.draft,
    response: 'My original saved meaning response.', submittedResponse: 'My original saved meaning response.', retell: 'My original submitted retell.', observationAt: now, completedAt: now } }
  const typed = { ...base, draft: { ...base.draft, response: 'My offline device kept this unfinished response.', retell: 'My offline device kept this unfinished retell.' } }
  const operation = (entityType: 'materials' | 'sessions' | 'events', record: unknown, clock: number, device = 1, previous?: unknown) => parseOperation({
    id: crypto.randomUUID(), deviceId: `00000000-0000-4000-8000-00000000000${device}`, logicalClock: clock,
    entityType, entityId: (record as RecordValue).id, kind: 'put', schemaVersion: 1,
    payload: { record, changed: changedFields(previous as RecordValue | undefined, record as RecordValue) } })
  const evidence: StudyEvent[] = [
    { id: `${sessionId}:response`, type: 'READING_RESPONSE', source: 'text', timestamp: now, sessionId, data: { materialId: material.id, taskId, response: saved.draft.response } },
    { id: `${sessionId}:retell`, type: 'READING_RETELL', source: 'text', timestamp: now, sessionId, data: { materialId: material.id, taskId, response: saved.draft.retell } },
    { id: `completed:${taskId}`, type: 'TASK_COMPLETED', source: 'objective', timestamp: now, data: { materialId: material.id, taskId, kind: 'reading', minutes: 15 } },
  ]
  // Actual protocol projection, synthetic owner-free data. This is UI/IDB
  // acceptance, not an Auth/server/provider or acoustic-quality claim.
  const projection = await projectOperations([operation('materials', material, 1), operation('sessions', base, 2), operation('sessions', saved, 3, 1, base),
    ...evidence.map(row => operation('events', row, 4)), operation('sessions', typed, 5, 2, base)])
  await put(page, 'materials', [material]); await put(page, 'sessions', projection.records.sessions); await put(page, 'events', projection.records.events)
  await put(page, 'plans', [{ id: date, date, minutes: 45, focus: 'reading', evidenceFingerprint: 'recovery-fixture', createdAt: now,
    tasks: [{ id: taskId, kind: 'learn', title: 'Read something worth sharing', materialId: material.id, minutes: 15, done: true, reason: 'Original submitted assignment' },
      { id: `${date}:speak:practice`, kind: 'speak', title: 'Say it in your own words', minutes: 30, done: false, reason: 'Original next assignment' }] }])
  await page.goto(`#/learn?material=${material.id}&task=${encodeURIComponent(taskId)}&mode=reading`)
  await page.reload() // Hydrate the raw IDB fixtures through normal app startup.
  await page.getByRole('button', { name: 'Continue editing saved draft', exact: true }).click()
  await expect(page.locator('#reading-response')).toHaveValue(typed.draft.response)
  await expect(page.locator('#reading-retell')).toHaveValue(typed.draft.retell)
  await page.locator('#reading-response').fill('I continued my own recovered draft without replacing the original response.')
  await expect.poll(async () => (await rows<StudySession>(page, 'sessions')).find(row => row.kind === 'reading-recovery')?.draft.response).toBe('I continued my own recovered draft without replacing the original response.')
  await page.reload()
  await page.getByRole('button', { name: 'Open recovered practice', exact: true }).click()
  await expect(page.locator('#reading-response')).toHaveValue(/I continued my own recovered draft/)
  await page.getByRole('button', { name: 'Save reading & retell', exact: true }).click()
  await expect.poll(async () => (await rows<StudySession>(page, 'sessions')).find(row => row.kind === 'reading-recovery')?.stage).toBe('saved')
  const allSessions = await rows<StudySession>(page, 'sessions'), recovered = allSessions.find(row => row.kind === 'reading-recovery')!
  expect(allSessions.filter(row => row.kind === 'reading-recovery')).toHaveLength(1)
  expect(allSessions.filter(row => row.kind === 'reading-conflict')).toHaveLength(1)
  expect(allSessions.find(row => row.id === sessionId)?.draft).toMatchObject({ submittedResponse: saved.draft.submittedResponse, retell: saved.draft.retell })
  expect(recovered.draft).toMatchObject({ activeMs: 0, priorExposure: true })
  const events = await rows<StudyEvent>(page, 'events')
  expect(events.filter(row => row.type === 'TASK_COMPLETED')).toEqual([evidence[2]])
  for (const original of evidence) expect(events.find(row => row.id === original.id)).toEqual(original)
  expect(events.filter(row => row.sessionId === recovered.id).every(row => !row.data?.taskId && !row.data?.assessmentId && row.score === undefined)).toBe(true)
  expect(events.find(row => row.sessionId === recovered.id && row.type === 'READING_OBSERVATION')?.data).toMatchObject({ firstPass: false, priorExposure: true, activeSeconds: 0 })
  await page.reload(); await page.getByRole('button', { name: 'Open recovered practice', exact: true }).click()
  await expect(page.getByText('Saved. Ready to reflect on the meaning.', { exact: true })).toBeVisible()
  expect((await rows<StudySession>(page, 'sessions')).filter(row => row.kind === 'reading-recovery')).toHaveLength(1)
})

test('completed required 45 minutes leaves the original nine-minute draft optional through reload and explicit completion', async ({ page }) => {
  await page.goto('#/'); await page.getByRole('heading', { level: 1 }).waitFor()
  const now = await page.evaluate(() => Date.now()), material = reader(now)
  const profile = (await rows<Profile>(page, 'profiles'))[0]!
  await put(page, 'profiles', [{ ...profile, onboarded: true, fatigue: 0, dailyMinutes: 45, createdAt: now }])
  await put(page, 'materials', [material]); await page.reload()
  const date = await page.evaluate(() => {
    const today = new Date()
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  })
  // Today computes recommendations; the normal start action commits the actual
  // assignment. Page readiness alone does not create a persisted plan.
  await page.getByRole('button', { name: 'Start today’s practice', exact: true }).click()
  await expect.poll(async () => (await rows<DailyPlan>(page, 'plans')).find(row => row.date === date)?.minutes).toBe(45)
  const plan = (await rows<DailyPlan>(page, 'plans')).find(row => row.date === date)!
  expect(plan.minutes).toBe(45)
  const { taskPath } = await import('../../src/domain/engine')
  const startedTask = plan.tasks.find(task => !task.done && !task.optional)!
  await expect.poll(() => {
    const [path, query] = new URL(page.url()).hash.slice(1).split('?')
    return { path, query: Object.fromEntries(new URLSearchParams(query)) }
  }).toEqual(taskPath(startedTask))
  // Historical completed assignments are the fixture; the optional continuation
  // below uses real DOM handlers, sessions, events, and the original task identity.
  const taskId = `${date}:learn:offline-original:reading`, sessionId = `reading:${taskId}`
  const optional = { id: taskId, kind: 'learn' as const, materialId: material.id, title: 'Original saved reading', reason: 'Other-device begun assignment', minutes: 9, done: false, optional: true }
  const completed = { ...plan, tasks: [...plan.tasks.map(task => ({ ...task, done: true })), optional] }
  const source: StudySession = { id: sessionId, kind: 'reading', materialId: material.id, startedAt: now, stage: 'respond',
    draft: { passage: material.transcript, response: 'My original unfinished response about understanding friends.', retell: '', activeMs: 4000 } }
  await put(page, 'plans', [completed]); await put(page, 'sessions', [source]); await page.goto('#/'); await page.reload()
  await expect(page.getByText('Today’s plan is complete. Let it settle; there is no need to clear the backlog.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Start today’s practice|Continue my practice)$/ })).toHaveCount(0)
  const resume = page.getByRole('button', { name: 'Continue optional practice', exact: true })
  await expect(resume).toHaveCount(1)
  expect((await rows<DailyPlan>(page, 'plans')).find(row => row.date === date)?.minutes).toBe(45)
  expect((await rows<StudySession>(page, 'sessions')).find(row => row.id === sessionId)).toEqual(source)
  const originalEvents = await rows<StudyEvent>(page, 'events')
  expect(originalEvents.some(event => event.data?.taskId === taskId)).toBe(false)
  await resume.click()
  await expect(page.locator('#reading-response')).toHaveValue(source.draft.response as string)
  await page.locator('#reading-retell').fill('Friends listen carefully and ask a kind question to understand each other.')
  await page.getByRole('button', { name: 'Save reading & retell', exact: true }).click()
  await expect.poll(async () => (await rows<StudySession>(page, 'sessions')).find(row => row.id === sessionId)?.stage).toBe('saved')
  const finished = (await rows<DailyPlan>(page, 'plans')).find(row => row.date === date)!
  expect(finished.tasks.find(task => task.id === taskId)).toEqual({ ...optional, done: true })
  expect(finished.minutes).toBe(45)
  const events = await rows<StudyEvent>(page, 'events')
  for (const original of originalEvents) expect(events.find(event => event.id === original.id)).toEqual(original)
  expect(events.filter(event => event.id === `completed:${taskId}`)).toHaveLength(1)
  expect(events.find(event => event.id === `completed:${taskId}`)?.data?.minutes).toBe(9)
  expect(events.find(event => event.id === `${sessionId}:response`)?.data?.response).toBe(source.draft.response)
  await page.getByRole('button', { name: 'Continue to next task', exact: true }).click()
  await expect(page.getByText('Today’s plan is complete. Let it settle; there is no need to clear the backlog.', { exact: true })).toBeVisible()
  await page.reload(); await expect(page.getByRole('button', { name: 'View optional practice', exact: true })).toHaveCount(1)
})

test('Today automatically connects assigned listening, separate reading, durable chunk writing and speaking', async ({ page }) => {
  // Real router, DOM, media playback, store and IndexedDB. Bundled synthetic
  // speech verifies the learning path, not human-content or acoustic quality.
  await page.goto('#/'); await page.getByRole('heading', { level: 1 }).waitFor()
  const now = await page.evaluate(() => Date.now())
  const listening = { ...demoMaterials[0]!, topic: 'Assigned listening fixture' }, reading = reader(now)
  await put(page, 'materials', [...(await rows<Material>(page, 'materials')).map(m => ({ ...m, approved: false })), listening, reading])
  const profile = (await rows<Profile>(page, 'profiles'))[0]!
  await put(page, 'profiles', [{ ...profile, onboarded: true, fatigue: 0, dailyMinutes: 45, interests: [listening.topic], createdAt: now }])
  await page.reload()
  expect(await rows(page, 'cards')).toHaveLength(0)
  await page.getByRole('button', { name: 'Start today’s practice' }).click()
  const plan = (await rows<DailyPlan>(page, 'plans'))[0]!
  const listenTask = plan.tasks.find(t => t.kind === 'listen')!, readTask = plan.tasks.find(t => t.id.endsWith(':reading'))!
  const chunkTask = plan.tasks.find(t => t.id.endsWith(':chunks'))!, speakTask = plan.tasks.find(t => t.kind === 'speak')!
  expect(listenTask.materialId).toBe(listening.id); expect(readTask.materialId).toBe(reading.id)
  expect(chunkTask.materialId).toBe(listening.id)
  expect(plan.minutes).toBeLessThanOrEqual(45); expect(plan.tasks.every(t => t.minutes > 0)).toBe(true)
  await page.getByRole('button', { name: 'Play audio', exact: true }).click()
  await expect.poll(() => page.locator('.audio-player audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Pause audio', exact: true }).click()
  await page.locator('#meaning').fill('The bus is slow, so the friend should get a table or meet at the bakery.')
  await page.getByRole('button', { name: 'Check my understanding', exact: true }).click()
  await page.getByRole('button', { name: 'Main idea + details', exact: true }).click()
  await page.getByRole('button', { name: 'Reveal English transcript', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to active recall' }).click()
  await expect.poll(() => new URLSearchParams(page.url().split('?')[1]).get('task')).toBe(readTask.id)
  await expect(page.getByRole('button', { name: 'Start reading', exact: true })).toBeVisible()
  await page.clock.install()
  await page.getByRole('button', { name: 'Start reading', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause reading', exact: true })).toBeVisible()
  await page.clock.runFor(4000)
  await page.getByRole('button', { name: 'I read this section', exact: false }).click()
  await page.locator('#reading-response').fill('Sharing stories and asking kind questions helps people understand one another.')
  await page.reload(); await expect(page.locator('#reading-response')).toHaveValue(/Sharing stories/)
  await page.locator('#reading-retell').fill('A good friend listens carefully and asks a question, then shares a useful detail.')
  await page.getByRole('button', { name: 'Save reading & retell' }).click()
  // A click starts async writes, it is not a durability acknowledgement.
  // Separate failure/retry tests cover interruption before this boundary.
  await expect.poll(async () => (await rows<StudySession>(page, 'sessions')).find(s => s.id === `reading:${readTask.id}`)?.stage).toBe('saved')
  await expect.poll(async () => (await rows<StudyEvent>(page, 'events')).filter(e => e.data?.taskId === readTask.id && ['READING_RESPONSE', 'READING_RETELL'].includes(e.type)).length).toBe(2)
  await expect(page.getByRole('button', { name: 'Continue to next task', exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Continue to next task', exact: true }).click()
  await expect.poll(() => new URLSearchParams(page.url().split('?')[1]).get('task')).toBe(chunkTask.id)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Make the expression')
  const expression = listening.chunks[0]!
  await page.locator('.chunk-card textarea').first().fill(`I am ${expression.text} to help a friend.`)
  await page.getByRole('button', { name: 'Save my example & practice later' }).first().click()
  await expect(page.getByRole('button', { name: 'Use these in conversation' })).toBeDisabled()
  await page.locator('#rephrase').fill('A slow bus delays the speaker. The friend can get a cafe table or try the bakery instead.')
  await page.getByRole('button', { name: 'Save & check my rephrasing' }).click()
  await expect.poll(async () => (await rows<StudyEvent>(page, 'events')).filter(e => e.type === 'WRITTEN_RESPONSE').length).toBe(1)
  await page.reload(); await expect(page.locator('#rephrase')).toHaveValue(/A slow bus/)
  await page.getByRole('button', { name: 'Use these in conversation' }).click()
  await expect.poll(() => new URLSearchParams(page.url().split('?')[1]).get('task')).toBe(speakTask.id)
  expect(page.url()).toContain('#/speak?')
  const completed = (await rows<DailyPlan>(page, 'plans')).find(p => p.id === plan.id)!
  for (const task of [listenTask, readTask, chunkTask]) expect(completed.tasks.find(t => t.id === task.id)?.done).toBe(true)
  expect(await rows(page, 'chunks')).toHaveLength(1); expect(await rows(page, 'cards')).toHaveLength(6)
  const events = await rows<StudyEvent>(page, 'events')
  expect(events.find(e => e.type === 'WRITTEN_RESPONSE')?.data).toMatchObject({ taskId: chunkTask.id, materialId: listening.id })
  expect(events.find(e => e.id === `completed:${readTask.id}`)?.data?.kind).toBe('reading')
  expect(events.filter(e => e.type === 'WRITING_EVALUATED')).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
})

test('same-page reading retry survives two real aborted commits and continues its assigned chunks', async ({ page }) => {
  await page.clock.install()
  await page.goto('#/'); await page.getByRole('heading', { level: 1 }).waitFor()
  const now = await page.evaluate(() => Date.now()), date = await page.evaluate(() => new Date().toLocaleDateString('en-CA'))
  const material = reader(now), taskId = `${date}:learn:${material.id}:reading`, chunkMaterial = demoMaterials[0]!
  const chunkId = `${date}:learn:${chunkMaterial.id}:chunks`
  await put(page, 'materials', [material])
  await put(page, 'plans', [{ id: date, date, minutes: 45, focus: 'reading', evidenceFingerprint: 'retry-fixture', createdAt: now,
    tasks: [
      { id: taskId, kind: 'learn', title: 'Read something worth sharing', materialId: material.id, minutes: 15, reason: 'Saved reading assignment', done: false },
      { id: chunkId, kind: 'learn', title: 'Make a chunk your own', materialId: chunkMaterial.id, minutes: 15, reason: 'Saved language assignment', done: false },
      { id: `${date}:speak:practice`, kind: 'speak', title: 'Speak', minutes: 15, reason: 'Saved speaking assignment', done: false },
    ] }])
  await page.reload(); await page.getByRole('button', { name: 'Start today’s practice' }).click()
  await page.getByRole('button', { name: 'Start reading', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause reading', exact: true })).toBeVisible()
  await page.clock.runFor(4000)
  await page.getByRole('button', { name: 'I read this section', exact: false }).click()
  await page.locator('#reading-response').fill('Sharing stories helps people understand one another.')
  await page.locator('#reading-retell').fill('A good friend listens carefully and asks a kind question.')
  // Exercise real native transaction rollback, not a mocked successful put.
  // This hook is confined to this disposable browser profile and these two writes.
  await page.evaluate(() => {
    const nativePut = IDBObjectStore.prototype.put
    let failures = 2
    IDBObjectStore.prototype.put = function (value, key) {
      const request = key === undefined ? nativePut.call(this, value) : nativePut.call(this, value, key)
      if (this.name === 'sessions' && value?.kind === 'reading' && value?.stage === 'saved' && failures > 0) {
        failures--; this.transaction.abort()
      }
      return request
    }
  })
  await page.getByRole('button', { name: 'Save reading & retell' }).click()
  await expect(page.getByRole('button', { name: 'Retry saving', exact: true })).toBeEnabled()
  const original = (await rows<StudyEvent>(page, 'events')).filter(e => e.data?.taskId === taskId && ['READING_RESPONSE', 'READING_RETELL'].includes(e.type))
  expect(original).toHaveLength(2)
  for (let failure = 0; failure < 2; failure++) {
    expect((await rows<StudySession>(page, 'sessions')).find(s => s.id === `reading:${taskId}`)?.stage).toBe('respond')
    await expect(page.getByRole('button', { name: 'Continue to next task', exact: true })).toHaveCount(0)
    if (!failure) {
      await page.getByRole('button', { name: 'Retry saving', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Retry saving', exact: true })).toBeEnabled()
    }
  }
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click()
  await expect.poll(async () => (await rows<StudySession>(page, 'sessions')).find(s => s.id === `reading:${taskId}`)?.stage).toBe('saved')
  await expect(page.getByRole('button', { name: 'Retry saving', exact: true })).toHaveCount(0)
  expect((await rows<StudyEvent>(page, 'events')).filter(e => e.data?.taskId === taskId && ['READING_RESPONSE', 'READING_RETELL'].includes(e.type))).toEqual(original)
  expect((await rows<StudyEvent>(page, 'events')).filter(e => e.id === `completed:${taskId}`)).toHaveLength(1)
  await page.getByRole('button', { name: 'Continue to next task', exact: true }).click()
  await expect.poll(() => Object.fromEntries(new URLSearchParams(page.url().split('?')[1]))).toEqual({ task: chunkId, material: chunkMaterial.id, mode: 'chunks' })
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Make the expression')
})

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
  await expect(page.getByRole('button', { name: 'Pause reading', exact: true })).toBeVisible()
  await page.clock.runFor(32000)
  await page.locator('.assessment-card').scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('reading-check-in.png') })
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
  await expect(page.getByRole('button', { name: 'Pause reading', exact: true })).toBeVisible()
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
