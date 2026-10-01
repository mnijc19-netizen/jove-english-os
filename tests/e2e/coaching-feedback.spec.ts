import { test, expect, type Page } from '@playwright/test'
import { test as storageTest } from './browser-fixtures'

test.use({ serviceWorkers: 'block' })
storageTest.use({ serviceWorkers: 'block' })
// Synthetic local journals only, no account, API key, microphone or paid call.
async function put(page: Page, database: string, table: string, rows: object[]) {
  await page.evaluate(async ({ database, table, rows }) => {
    const request = indexedDB.open(database)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error('Fixture database unavailable'))
      request.onupgradeneeded = () => request.transaction?.abort()
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(table, 'readwrite')
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('Fixture write failed'))
        for (const row of rows) tx.objectStore(table).put(row)
      })
    } finally { db.close() }
  }, { database, table, rows })
}
function feedback(original: string, corrected: string) {
  return { summary: `SUMMARY ${corrected}`, strengths: [`STRENGTH ${corrected}`],
    errors: [{ category: 'grammar', original, corrected, hint: `HINT ${corrected}`, explanation: `EXPLANATION ${corrected}` }],
    comprehension: null, accuracy: null, fluency: null, successfulChunks: [], nextPrompt: `NEXT ${corrected}` }
}
async function checkReveal(page: Page, original: string, corrected: string) {
  const section = page.getByRole('region', { name: '已保存的文字反馈' })
  await expect(section.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  await expect(section).toContainText(original)
  await expect(section).not.toContainText(corrected)
  await section.getByRole('button').click()
  await expect(section).toContainText(`SUMMARY ${corrected}`)
  await expect(section).toContainText(`HINT ${corrected}`)
  await expect(section).toContainText('不代表发音')
  await expect(section.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.reload()
  await expect(section.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  await expect(section).not.toContainText(corrected)
}

test('English saved conversation keeps corrections behind explicit help and survives reload', async ({ page }) => {
  await page.goto('#/settings')
  await expect(page.getByTestId('current-release')).toBeVisible()
  const original = 'Yesterday I go.', corrected = 'Yesterday I went.'
  await put(page, 'jove-english-os', 'conversations', [{ id: 'fixture-feedback-en', mode: 'guided', scenario: 'Browser fixture',
    startedAt: Date.now(), completedAt: Date.now(), messages: [{ id: 'fixture-answer', role: 'user', text: original, timestamp: Date.now() }], evaluation: feedback(original, corrected) }])
  await page.goto('#/speak?conversation=fixture-feedback-en')
  await checkReveal(page, original, corrected)
})

test('Japanese saved dialogue uses the same answer-safe reveal without blending English records', async ({ page }) => {
  test.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese build gate is off')
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  const original = '駅を行きたいです。', corrected = '駅に行きたいです。'
  await put(page, 'jove-english-os-ja', 'sessions', [{ id: 'fixture-feedback-ja', kind: 'japanese-dialogue', materialId: 'ja-irodori-starter-1',
    startedAt: Date.now(), stage: 'interact', draft: { revision: 1, taskId: 'fixture-task', minutes: 5, answer: { text: '', audioId: '', confirmed: false },
      transcript: '', turns: Array.from({ length: 3 }, (_, i) => ({ id: `fixture-turn-${i}`, text: original, audioId: '', confirmed: true,
        reply: 'そうですか。', replyKind: 'offline', attempts: 0 })), comparison: '', retryAudioId: '', feedback: feedback(original, corrected), feedbackAttempts: 1 } }])
  await page.goto('#/ja/talk?session=fixture-feedback-ja')
  await checkReveal(page, original, corrected)
})

storageTest('completed Japanese practice reopens its originals and coaching without creating learning or paid requests', async ({ page, browserName }) => {
  storageTest.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese build gate is off')
  let paidRequests = 0
  await page.route('**/functions/v1/ai', route => { paidRequests++; return route.abort() })
  await page.route('https://openrouter.ai/**', route => { paidRequests++; return route.abort() })
  await page.goto('#/ja')
  await page.getByRole('button', { name: '我是零基础，不猜题直接起步', exact: true }).click()
  await page.getByRole('button', { name: '确认零基础起点', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^今日练习：/ })).toBeVisible()
  const id = 'fixture-completed-practice', now = Date.now(), original = '私学生です', corrected = '私は学生です。'
  const practice = { id, kind: 'japanese-practice', materialId: 'ja-irodori-starter-1', startedAt: now - 60000, completedAt: now, stage: 'completed',
    draft: { taskId: 'fixture-completed-task', revision: 4, listened: true, response: '听到了问候', expression: 'おはよう', example: 'おはようございます。',
      audioId: 'fixture-original', retryAudioId: 'fixture-retry', comparison: '完整说一遍' } }
  const coach = { id: `ja-coach:${id}`, kind: 'japanese-coach', materialId: practice.materialId, startedAt: now - 1000, completedAt: now, stage: 'completed',
    draft: { revision: 1, text: original, confirmed: true, transcript: '', audioId: '', feedback: [{ id: 'fixture-feedback', input: original, createdAt: now, result: feedback(original, corrected) }] } }
  await put(page, 'jove-english-os-ja', 'sessions', [practice, coach])
  await page.evaluate(async () => {
    const blob = new Blob([await (await fetch('audio/train-change-1.wav')).arrayBuffer()], { type: 'audio/wav' })
    const request = indexedDB.open('jove-english-os-ja')
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('audio', 'readwrite'); tx.oncomplete = () => resolve()
        tx.onerror = event => reject(new Error(`Fixture audio: ${(event.target as IDBRequest).error?.name ?? tx.error?.name ?? 'unknown transaction error'}`))
        tx.onabort = () => reject(tx.error ?? new Error('Fixture audio write aborted'))
        for (const id of ['fixture-original', 'fixture-retry']) tx.objectStore('audio').put({ id, blob, mimeType: 'audio/wav', createdAt: Date.now(), duration: 1, kind: 'recording', processed: false, label: 'Synthetic fixture' })
      })
    } finally { db.close() }
  })
  const snapshot = () => page.evaluate(async () => {
    const read = async (name: string, stores: string[]) => {
      const request = indexedDB.open(name)
      const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      try {
        const tx = db.transaction(stores)
        return await Promise.all(stores.map(store => new Promise<unknown[]>((resolve, reject) => {
          const req = tx.objectStore(store).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
        })))
      } finally { db.close() }
    }
    return { ja: await read('jove-english-os-ja', ['sessions', 'events', 'cards']), en: await read('jove-english-os', ['sessions', 'events', 'cards']) }
  })
  const before = await snapshot()
  await page.reload()
  await page.getByRole('link', { name: /见面与告别.*回看/ }).click()
  await expect(page.getByRole('heading', { name: '这次练习已保存', exact: true })).toBeVisible()
  await expect(page.getByText('听到了问候', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '保存这次完整练习', exact: true })).toHaveCount(0)
  await expect(page.locator('audio')).toHaveCount(2)
  for (const player of await page.locator('audio').all()) await expect(player).toHaveAttribute('src', /^blob:/)
  // Windows WebKit retains readyState 0 for this fixture; do not call it playback
  // acceptance. Keep storage/UI/immutability checks; Linux CI checks decoding.
  if (browserName !== 'webkit' || process.platform !== 'win32') {
    await expect.poll(() => page.locator('audio').evaluateAll(elements => elements.map(e => (e as HTMLAudioElement).readyState))).toEqual([4, 4])
  } else storageTest.info().annotations.push({ type: 'media-limit', description: 'Windows WebKit audio decoding unavailable; not physical-iPhone playback proof.' })
  await page.getByRole('button', { name: '查看或接续 AI 辅导', exact: true }).click()
  const answer = page.getByRole('textbox', { name: '写下自己刚才说的日语，或核对转写后修改' })
  await expect(answer).toHaveValue(original); await expect(answer).toHaveAttribute('readonly', '')
  await expect(page.getByRole('checkbox', { name: /我核对过这段文字/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: '转写首答录音（可能收费）', exact: true })).toHaveCount(0)
  const help = page.getByRole('button', { name: '查看 AI 提示与参考表达', exact: true })
  await expect(help).toHaveAttribute('aria-expanded', 'false'); await help.click()
  await expect(page.getByText(`SUMMARY ${corrected}`, { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '查看或接续 AI 辅导', exact: true }).click()
  await expect(help).toHaveAttribute('aria-expanded', 'false')
  expect(await snapshot()).toEqual(before)
  expect(paidRequests).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.screenshot({ path: storageTest.info().outputPath('japanese-completed.png') })
  // A failed read must not turn recovery into creation of a coaching journal.
  await page.getByRole('button', { name: '查看或接续 AI 辅导', exact: true }).click()
  const ownerBefore = await page.evaluate(async id => {
    const request = indexedDB.open('jove-english-os-ja')
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try {
      const owner = await new Promise<unknown>(resolve => { const req = db.transaction('syncMeta').objectStore('syncMeta').get('owner'); req.onsuccess = () => resolve(req.result ?? null) })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['sessions', 'syncMeta'], 'readwrite'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
        tx.objectStore('sessions').delete(`ja-coach:${id}`)
        tx.objectStore('syncMeta').put({ id: 'owner', value: 'fixture-other-owner' })
      })
      return owner
    } finally { db.close() }
  }, id)
  await page.getByRole('button', { name: '查看或接续 AI 辅导', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: '学习账号已改变' })).toBeVisible()
  await page.evaluate(async owner => {
    const request = indexedDB.open('jove-english-os-ja')
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('syncMeta', 'readwrite'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
        if (owner) tx.objectStore('syncMeta').put(owner); else tx.objectStore('syncMeta').delete('owner')
      })
    } finally { db.close() }
  }, ownerBefore)
  const withoutCoach = await snapshot()
  await page.getByRole('button', { name: '重新载入已保存的辅导（保留本页文字副本）', exact: true }).click()
  await expect(page.getByText('这次没有保存可接续的 AI 回答。', { exact: false })).toBeVisible()
  expect(await snapshot()).toEqual(withoutCoach)
  expect(paidRequests).toBe(0)
})
