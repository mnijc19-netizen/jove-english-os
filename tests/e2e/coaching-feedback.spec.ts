import { test, expect, type Page } from '@playwright/test'

test.use({ serviceWorkers: 'block' })
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
