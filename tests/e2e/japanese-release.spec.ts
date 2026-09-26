import { test, expect } from '@playwright/test'

// Built-bundle contract, unlike japanese-preview's DEV-only source fixtures.
// Fresh synthetic profiles only; no owner login, provider call or PWA claim.
test.use({ serviceWorkers: 'block' })
test('Japanese production gate matches its navigation, diagnosis and data controls', async ({ page }) => {
  await page.goto('#/ja')
  const japanese = page.getByRole('link', { name: '日本語 · 日语', exact: true })
  if (process.env.VITE_JOVE_JAPANESE !== '1') {
    await expect(page).toHaveURL(/#\/today$/)
    await expect(japanese).toHaveCount(0)
    await page.goto('#/settings')
    await expect(page.locator('#data-language')).toHaveCount(0)
    expect((await page.evaluate(() => indexedDB.databases())).some(db => db.name === 'jove-english-os-ja')).toBe(false)
    return
  }
  await expect(japanese).toHaveCount(1)
  await expect(page.getByText('开发预览：本页尚未开放到正式网站。', { exact: false })).toHaveCount(0)
  const skip = page.getByRole('radio', { name: '跳过', exact: true })
  await expect(skip).toHaveCount(6)
  for (const choice of await skip.all()) await choice.check()
  await page.getByRole('button', { name: '保存诊断，安排今天', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^今日练习：/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^开始学习 · 约/ })).toBeEnabled()
  await page.reload()
  await expect(page.getByRole('heading', { name: /^今日练习：/ })).toBeVisible()
  await expect(skip).toHaveCount(0)
  await page.goto('#/settings')
  await expect(page.locator('#data-language')).toBeVisible()
  await page.locator('#data-language').selectOption('ja')
  await expect(page.getByText('当前操作只针对日语。', { exact: false })).toBeVisible()
})

test('signed-in English opens Japanese on the first attempt without another login', async ({ page }) => {
  test.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese build gate is off')
  // Keep the real SDK and its asynchronous INITIAL_SESSION notification.
  // Only HTTP/auth identity are synthetic; no owner session or backend write.
  const owner = '10000000-0000-4000-8000-000000000002', expires = Math.floor(Date.now() / 1000) + 3600
  const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'japanese@example.invalid',
    app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
  const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: owner, exp: expires, aud: 'authenticated' }]
    .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fixture-only'
  await page.addInitScript(session => {
    localStorage.setItem('jove-auth-session-v1', JSON.stringify(session))
  }, { access_token: token, refresh_token: 'fixture-only', expires_at: expires, expires_in: 3600, token_type: 'bearer', user })
  const cursors = { en: 0, ja: 0 }, unexpected: string[] = []
  await page.route('https://*.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version' }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(value) })
    if (path === '/auth/v1/user') return json(user)
    if (path === '/rest/v1/app_members') return json([{ user_id: owner }])
    if (path === '/rest/v1/service_preferences') return json([{ recording_retention: 'minimal' }])
    if (['/rest/v1/language_sync_operations', '/rest/v1/language_recording_manifest'].includes(path)) {
      if (path.endsWith('/language_sync_operations')) expect(url.searchParams.get('learning_language')).toBe('eq.ja')
      return json([])
    }
    if (['/rest/v1/sync_operations', '/rest/v1/recording_manifest'].includes(path)) return json([])
    if (['/rest/v1/rpc/append_sync_operations', '/rest/v1/rpc/append_language_sync_operations'].includes(path)) {
      const language = path.endsWith('/append_language_sync_operations') ? 'ja' : 'en', body = request.postDataJSON()
      if (language === 'ja') expect(body.learning_language).toBe('ja')
      return json(body.operations.map((op: { id: string }) => ({ id: op.id, cursor: ++cursors[language], received_at: new Date().toISOString() })))
    }
    if (path === '/functions/v1/content' && request.postDataJSON().action === 'external-catalog'
      && [undefined, 'voa-level1', 'voa-level2', 'bbc-six-minute', 'en-bc-reading', 'ja-tadoku', 'ja-irodori'].includes(request.postDataJSON().sourceId)) {
      return json({ catalog: null }) // A pending directory must not prevent account admission.
    }
    unexpected.push(path); return json({ error: 'unexpected-fixture-request' }, 500)
  })
  await page.goto('#/today')
  await expect.poll(() => cursors.en).toBeGreaterThan(0)
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  await expect(page.getByRole('button', { name: '重试打开日语区', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  await expect(page.getByRole('button', { name: '重试打开日语区', exact: true })).toHaveCount(0)
  expect(cursors.en).toBeGreaterThan(0); expect(cursors.ja).toBeGreaterThan(0)
  expect(unexpected).toEqual([])
})
