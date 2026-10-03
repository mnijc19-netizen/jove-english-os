import { test, expect, type Page } from '@playwright/test'
import { records } from './browser-fixtures'

// Fresh, synthetic learner profiles. These checks exercise navigation, stored
// records and isolation, not human proficiency, paid AI or physical microphones.
test.use({ serviceWorkers: 'block' })
const entries = [
  ['今日安排', '/ja'], ['听说练习', '/ja/practice'], ['假名与阅读', '/ja/literacy'],
  ['间隔复习', '/ja/reviews'], ['学习材料', '/ja/library'], ['学习进度', '/ja/progress'],
] as const
async function navigate(page: Page, label: string) {
  const toggle = page.getByRole('button', { name: 'Toggle navigation', exact: true })
  if (await toggle.isVisible()) await toggle.click()
  await page.getByRole('navigation', { name: '日语导航', exact: true }).getByRole('link', { name: label, exact: true }).click()
}
async function seed(page: Page, rows: { store: string; value: Record<string, unknown> }[]) {
  await page.evaluate(async rows => {
    const request = indexedDB.open('jove-english-os-ja')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try { await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([...new Set(rows.map(row => row.store))], 'readwrite')
      for (const row of rows) transaction.objectStore(row.store).put(row.value)
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error)
    }) } finally { database.close() }
  }, rows)
}
async function waitForWorkspace(page: Page, mode: string) {
  await expect(page.locator(`[data-workspace-mode="${mode}"]`)).toBeVisible()
  await expect(page.getByText('正在读取日语安排和本机记录…', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
}

test('all Japanese hubs are safe empty entries with visible mobile navigation and no invented starts', async ({ page }) => {
  test.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese build gate is off')
  let paid = 0
  await page.route('https://openrouter.ai/**', route => { paid++; return route.abort() })
  await page.route('**/functions/v1/ai', route => { paid++; return route.abort() })
  await page.goto('#/ja/library')
  await waitForWorkspace(page, 'library')
  const baseline = await records(page, 'events')
  const navigation = page.getByRole('navigation', { name: '日语导航', includeHidden: true })
  for (const [label, path] of entries) await expect(navigation.getByRole('link', { name: label, exact: true, includeHidden: true })).toHaveAttribute('href', `#${path}`)
  await expect(page.getByRole('heading', { name: '先告诉系统：我从零开始', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(page.getByRole('link', { name: '假名原声 ↗', exact: true })).toHaveAttribute('href', 'https://a1.marugotoweb.jp/en/hiragana.php')
  await page.locator('#japanese-material-category').selectOption('course')
  await expect(page.getByRole('link', { name: '查看原站资源 ↗', exact: true }).first()).toHaveAttribute('href', /^https:\/\/www\.irodori\.jpf\.go\.jp\//)
  for (const [label, path] of entries.slice(1)) {
    await navigate(page, label)
    await waitForWorkspace(page, path.slice('/ja/'.length))
    await expect(page.getByRole('link', { name: '从零基础开始', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('看见真实练过的内容。')
  await expect(page.locator('#japanese-material-category')).toHaveCount(0)
  expect((await records(page, 'events', 'jove-english-os-ja')).some(event => event.type === 'TASK_STARTED')).toBe(false)
  expect(await records(page, 'sessions', 'jove-english-os-ja')).toEqual([])
  expect(await records(page, 'events')).toEqual(baseline)
  expect(paid).toBe(0)
})

test('Japanese progress uses actual Japanese activities and preserves resumable legacy drafts', async ({ page }) => {
  test.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese build gate is off')
  await page.goto('#/ja/progress')
  await waitForWorkspace(page, 'progress')
  const now = Date.now(), draft = { taskId: 'fixture-saved-task', revision: 0, listened: false, response: '这是我之前保存的意思',
    expression: '', example: '', audioId: '', retryAudioId: '', comparison: '' }
  await seed(page, [
    { store: 'assessments', value: { id: 'ja-beginner-start', timestamp: now - 1000, variant: 1, stage: 'self-reported-beginner',
      responses: { startingPoint: 'beginner' }, scores: { scriptRecognition: null, sentenceMeaning: null, listening: null, speaking: null }, completedAt: now - 1000 } },
    { store: 'sessions', value: { id: 'fixture-resume-ja', kind: 'japanese-practice', materialId: 'ja-irodori-starter-1', startedAt: now - 500, stage: 'listen', draft } },
    { store: 'sessions', value: { id: 'fixture-finished-ja', kind: 'japanese-practice', materialId: 'ja-irodori-starter-2', startedAt: now - 10000, completedAt: now - 8000, stage: 'compare', draft: { ...draft, taskId: 'fixture-finished-task' } } },
    { store: 'sessions', value: { id: 'fixture-unavailable-ja', kind: 'japanese-extensive', materialId: 'ja-tadoku-6447', startedAt: now - 20000, completedAt: now - 19000, stage: 'unavailable', draft: {} } },
    { store: 'sessions', value: { id: 'fixture-other-kind', kind: 'conversation', startedAt: now - 30000, stage: 'complete', completedAt: now - 29000, draft: { title: 'Not Japanese practice' } } },
    { store: 'events', value: { id: 'fixture-finished-ja:completed', type: 'TASK_COMPLETED', timestamp: now - 8000, source: 'objective',
      sessionId: 'fixture-finished-ja', data: { taskId: 'fixture-finished-task', minutes: 5, materialId: 'ja-irodori-starter-2' } } },
  ])
  const englishBefore = await records(page, 'sessions')
  await page.reload(); await waitForWorkspace(page, 'progress')
  const counters = page.locator('.workspace-counts')
  await expect(counters.locator('div').filter({ hasText: '已保存练习' }).locator('dd')).toHaveText('3')
  await expect(counters.locator('div').filter({ hasText: '已完成任务记录' }).locator('dd')).toHaveText('1')
  await expect(counters.locator('div').filter({ hasText: '可继续的练习' }).locator('dd')).toHaveText('1')
  // Separate static routes reuse this same component. Changing mode must update
  // headings and rendered sections, without starting another learner task.
  await navigate(page, '学习材料'); await waitForWorkspace(page, 'library')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('知道在学什么，不必自己排课。')
  await page.locator('#japanese-material-category').selectOption('course')
  await navigate(page, '学习进度'); await waitForWorkspace(page, 'progress')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('看见真实练过的内容。')
  await expect(page.locator('#japanese-material-category')).toHaveCount(0)
  await expect(counters.locator('div').filter({ hasText: '已完成任务记录' }).locator('dd')).toHaveText('1')
  await expect(page.getByText('已结束或暂停，非完成证明', { exact: false })).toBeVisible()
  await expect(page.getByText('Not Japanese practice', { exact: true })).toHaveCount(0)
  await expect(page.getByText('这些是实际保存的活动与完成事件，不是能力分数。', { exact: false })).toBeVisible()
  const resume = page.getByRole('link', { name: '继续练习', exact: true })
  await expect(resume).toHaveAttribute('href', '#/ja?session=fixture-resume-ja')
  await resume.click()
  await expect(page).toHaveURL(/#\/ja\?session=fixture-resume-ja$/)
  await expect.poll(async () => (await records(page, 'sessions', 'jove-english-os-ja')).find(session => session.id === 'fixture-resume-ja')?.draft).toEqual(draft)
  expect(await records(page, 'sessions')).toEqual(englishBefore)
})

test('a Japanese learner starts only the saved next assignment from its hub', async ({ page }) => {
  test.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese build gate is off')
  await page.goto('#/ja/literacy'); await waitForWorkspace(page, 'literacy')
  const now = Date.now(), date = new Date(now).toLocaleDateString('en-CA')
  const profile = (await records(page, 'profiles', 'jove-english-os-ja'))[0]!
  // Established plans keep their assignment identity while the main foundation
  // work evolves. Opening the hub itself must not generate a learner start.
  const taskId = `${date}:ja:fixture-kana`
  await seed(page, [
    { store: 'profiles', value: { ...profile, onboarded: true } },
    { store: 'assessments', value: { id: 'ja-beginner-start', timestamp: now - 2000, variant: 1, stage: 'self-reported-beginner', responses: { startingPoint: 'beginner' },
      scores: { scriptRecognition: null, sentenceMeaning: null, listening: null, speaking: null }, completedAt: now - 2000 } },
    { store: 'plans', value: { id: date, date, createdAt: now - 1000, minutes: 3, focus: 'reading', evidenceFingerprint: 'fixture-existing-plan', tasks: [
      { id: taskId, kind: 'learn', title: '认识第一组假名', minutes: 3, reason: '先学字形和声音，不先写句子。', materialId: 'ja-kana-hiragana-1', done: false },
    ] } },
  ])
  await page.reload(); await waitForWorkspace(page, 'literacy')
  expect((await records(page, 'events', 'jove-english-os-ja')).some(event => event.type === 'TASK_STARTED')).toBe(false)
  const next = page.getByRole('button', { name: '开始下一步', exact: true })
  await expect(next).toBeEnabled(); await next.click()
  await expect(page).toHaveURL(/#\/ja\/read\?session=/)
  await expect(page.getByRole('navigation', { name: '日语导航', includeHidden: true }).getByRole('link', { name: '假名与阅读', exact: true, includeHidden: true })).toHaveAttribute('aria-current', 'page')
  const starts = (await records(page, 'events', 'jove-english-os-ja')).filter(event => event.type === 'TASK_STARTED')
  expect(starts).toHaveLength(1)
  expect(starts[0]).toMatchObject({ data: { taskId } })
  await expect(page.getByRole('alert')).toHaveCount(0)
})
