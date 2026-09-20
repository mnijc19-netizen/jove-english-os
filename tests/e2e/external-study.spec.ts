import { test, expect, records } from './browser-fixtures'
import type { StudyEvent, StudySession } from '../../src/domain/types'
import { externalMaterials } from '../../src/content/external'

test.describe('catalog delivery', () => {
// Route interception must not be shadowed by a service worker. Real PWA/offline
// lifecycle is covered separately, without this option or mocked cloud routes.
test.use({ serviceWorkers: 'block' })
test('signed-in Library loads and retries the directory before initial learning setup', async ({ page }) => {
  // Only cloud transport/auth are fixtures; use the real store, IndexedDB and UI.
  // No owner's session, cloud write, publisher media or paid provider is used.
  const owner = '10000000-0000-4000-8000-000000000001', expires = Math.floor(Date.now() / 1000) + 3600
  const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'catalog@example.invalid',
    app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
  const token = [ { alg: 'HS256', typ: 'JWT' }, { sub: owner, exp: expires, aud: 'authenticated' } ]
    .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fixture-only'
  await page.addInitScript(session => {
    localStorage.setItem('jove-auth-session-v1', JSON.stringify(session))
  }, { access_token: token, refresh_token: 'fixture-only', expires_at: expires, expires_in: 3600, token_type: 'bearer', user })
  const legacy: Record<number, string> = { 1: 'external-voa-welcome', 3: 'external-voa-im-here', 10: 'external-voa-directions' }
  const catalog = { version: 1, sourceId: 'voa-level1', language: 'en', checkedAt: Date.now(), revision: 'a'.repeat(64),
    entries: Array.from({ length: 52 }, (_, i) => ({ position: i + 1,
      url: externalMaterials.find(m => m.id === legacy[i + 1])?.sourceUrl ?? `https://learningenglish.voanews.com/a/lesson-${i + 1}/${9000000 + i}.html` })) }
  const intermediate = { ...catalog, sourceId: 'voa-level2', entries: Array.from({ length: 30 }, (_, i) => ({
    position: i + 1, url: `https://learningenglish.voanews.com/a/level-two-lesson-${i + 1}/${9100000 + i}.html` })) }
  const continuing = { ...catalog, sourceId: 'bbc-six-minute', entries: [{ id: 'p0abcdef', title: 'Everyday ideas',
    url: 'https://www.bbc.co.uk/learningenglish/english/features/6-minute-english_2026/ep-260917',
    publishedAt: Date.now() - 86400_000, duration: 381 }] }
  let attempts = 0, cursor = 0
  const unexpected: string[] = []
  await page.route('https://*.supabase.co/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version' }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(value) })
    if (path === '/auth/v1/user') return json(user)
    if (path === '/rest/v1/app_members') return json([{ user_id: owner }])
    if (path === '/rest/v1/service_preferences') return json([{ recording_retention: 'minimal' }])
    if (path === '/rest/v1/sync_operations' || path === '/rest/v1/recording_manifest') return json([])
    if (path === '/rest/v1/rpc/append_sync_operations') return json(request.postDataJSON().operations.map((op: { id: string }) =>
      ({ id: op.id, cursor: ++cursor, received_at: new Date().toISOString() })))
    if (path === '/functions/v1/content' && request.postDataJSON().action === 'external-catalog') {
      if (request.postDataJSON().sourceId === 'bbc-six-minute') return json({ catalog: continuing })
      if (request.postDataJSON().sourceId === 'voa-level2') return json({ catalog: intermediate })
      attempts++
      return attempts === 1 ? json({ error: 'fixture-unavailable' }, 503) : json({ catalog })
    }
    unexpected.push(path); return json({ error: 'unexpected-fixture-request' }, 500)
  })
  await page.goto('#/library')
  const status = page.getByRole('status', { name: 'Course directory status' })
  await expect(status).toContainText('Some courses loaded; another course directory is unavailable.')
  expect((await records(page, 'profiles'))[0]).toMatchObject({ onboarded: false })
  await page.getByRole('textbox', { name: 'Search materials' }).fill('Everyday English · Lesson 2')
  await expect(page.getByRole('heading', { name: 'Everyday English · Lesson 2', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry course directory' }).click()
  await expect(status).toContainText('Course directory loaded.')
  await expect(page.getByRole('heading', { name: 'Everyday English · Lesson 2', exact: true })).toBeVisible()
  expect((await records(page, 'materials')).filter(m => String(m.id).startsWith('external-voa-'))).toHaveLength(82)
  await page.getByRole('textbox', { name: 'Search materials' }).fill('Everyday English · Intermediate · Lesson 1')
  await expect(page.getByRole('heading', { name: 'Everyday English · Intermediate · Lesson 1', exact: true })).toBeVisible()
  await page.reload()
  await expect(status).toContainText('Course directory loaded.')
  expect((await records(page, 'profiles'))[0]).toMatchObject({ onboarded: false })
  expect(await records(page, 'events')).toEqual([])
  expect(unexpected).toEqual([])
  await page.getByRole('textbox', { name: 'Search materials' }).fill('Everyday English · Lesson 2')
  await expect(page.getByRole('heading', { name: 'Everyday English · Lesson 2', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('catalog-before-setup.png') })
  if (process.env.VITE_JOVE_CONTINUING_COURSES !== '1') {
    expect((await records(page, 'materials')).some(m => String(m.id).startsWith('external-bbc-'))).toBe(false)
    return // Compatibility release must not emit BBC operations yet.
  }
  await page.getByRole('textbox', { name: 'Search materials' }).fill('6 Minute English')
  await expect(page.getByRole('heading', { name: '6 Minute English · Everyday ideas', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Explore', exact: false }).click()
  await expect(page.getByRole('link', { name: "Open today's listening lesson ↗" })).toHaveAttribute('href', continuing.entries[0]!.url)
  await expect(page.getByText('不改变你的美式口语目标', { exact: false })).toBeVisible()
  await page.locator('#external-summary').fill('我先记下听懂的主题，稍后继续。')
  await expect.poll(async () => (await records(page, 'sessions')).some(s =>
    (s as unknown as StudySession).draft.answer === '我先记下听懂的主题，稍后继续。')).toBe(true)
  await page.reload()
  await expect(page.locator('#external-summary')).toHaveValue('我先记下听懂的主题，稍后继续。')
  expect((await records(page, 'events')).some(e => e.type === 'EXTERNAL_LISTEN_REFLECTION')).toBe(false)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('continuing-course-draft.png') })
})
})

test('external lesson saves a guided draft without media downloads or invented ability', async ({ page }) => {
  const externalRequests: string[] = [], assessments: string[] = []
  page.on('request', request => {
    if (/voanews|esl-lab|esllab|akamaized/u.test(request.url())) externalRequests.push(request.url())
    if (request.url().includes('/speech-assess')) assessments.push(request.url())
  })
  await page.goto('#/listen?material=external-voa-welcome')
  await expect(page).toHaveTitle('Jove Language · Make it second nature')
  await expect(page.locator('.brand:visible').first()).toContainText('Jove Language')
  const manifest = await page.request.get('manifest.webmanifest')
  expect(manifest.ok()).toBe(true)
  expect(await manifest.json()).toMatchObject({ name: 'Jove Language OS', short_name: 'Jove Language',
    start_url: '/jove-english-os/', scope: '/jove-english-os/' })
  await expect(page.getByRole('heading', { name:'Welcome: introduce yourself' })).toBeVisible()
  await expect(page.getByText('先听第一段短对话', { exact: false })).toBeVisible()
  await expect(page.getByText('现在再看原站文本', { exact: false })).toHaveCount(0)
  const link=page.getByRole('link',{name:"Open today's listening lesson ↗"})
  await expect(link).toHaveAttribute('href','https://learningenglish.voanews.com/a/lets-learn-english-lesson-one/3111026.html')
  await expect(link).toHaveAttribute('rel','noopener noreferrer')
  await expect(page.locator('iframe, .audio-player')).toHaveCount(0)
  await expect(page.getByRole('button',{name:'Continue to notice an expression'})).toBeDisabled()
  await page.getByRole('checkbox',{name:/I listened and have returned/}).check()
  await page.locator('#external-summary').fill('Two neighbors introduce themselves.')
  await page.getByRole('button',{name:'Continue to notice an expression'}).click()
  await expect(page.getByText('现在再看原站文本', { exact: false })).toBeVisible()
  await page.locator('#external-expression').fill('Nice to meet you')
  await page.locator('#external-example').fill('Nice to meet you, Sam. I work in design.')
  await page.getByRole('button',{name:'Continue to spoken retell'}).click()
  await expect(page.getByRole('button',{name:'Save practice and continue'})).toBeDisabled()
  // Disabled also means "no recording" and is not a save-completion barrier.
  // Reload only after the actual active draft and stage have committed.
  await expect(page.locator('section.panel[aria-busy]').filter({ has: page.getByRole('heading', { name: 'Welcome: introduce yourself' }) }))
    .toHaveAttribute('aria-busy', 'false')
  await expect.poll(async () => (await records(page, 'sessions')).some(s => {
    const saved = s as unknown as StudySession
    return saved.materialId === 'external-voa-welcome' && saved.stage === '2'
      && saved.draft.answer === 'Two neighbors introduce themselves.'
      && saved.draft.externalExpression === 'Nice to meet you'
      && saved.draft.externalExample === 'Nice to meet you, Sam. I work in design.'
  })).toBe(true)
  await page.reload()
  await expect(page.getByRole('heading',{name:'3 · Close the script and retell'})).toBeVisible()
  await page.getByRole('button',{name:'Previous step'}).click()
  await expect(page.locator('#external-expression')).toHaveValue('Nice to meet you')
  const sessions=await records(page,'sessions') as unknown as StudySession[]
  expect(sessions.some(s=>s.materialId==='external-voa-welcome' && s.draft.answer==='Two neighbors introduce themselves.')).toBe(true)
  const events=await records(page,'events') as unknown as StudyEvent[]
  expect(events.some(e=>['AUDIO_PLAYED','COMPREHENSION_RESPONSE','PRONUNCIATION_ASSESSED'].includes(e.type))).toBe(false)
  expect(externalRequests).toEqual([]); expect(assessments).toEqual([])
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('language-brand.png'), fullPage: true })
  await page.goto('#/settings')
  const heading=page.getByRole('heading',{name:'Your learning account',exact:true})
  await expect(heading).toBeVisible()
  const title=await heading.boundingBox(), description=await heading.locator('..').locator('p').boundingBox()
  expect(title).not.toBeNull(); expect(description).not.toBeNull()
  expect(title!.y+title!.height).toBeLessThanOrEqual(description!.y)
  expect(Math.abs(title!.x-description!.x)).toBeLessThan(1)
})

test('an unavailable external lesson gets an automatic alternative without completing or erasing the original draft', async ({ page }) => {
  await page.goto('#/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  // Open an assigned external task through its actual Today route.
  await page.getByRole('button', { name: 'Start today’s practice', exact: true }).click()
  // The first task can be Review on other fixtures; this fresh workspace starts listening.
  await expect(page).toHaveURL(/#\/listen\?/u)
  const originalUrl = page.url()
  await expect(page.getByRole('button', { name: 'This lesson won’t open — choose an alternative' })).toBeVisible()
  await page.locator('#external-summary').fill('Keep this unfinished thought even if the publisher page fails.')
  await page.getByRole('button', { name: 'This lesson won’t open — choose an alternative' }).click()
  await expect(page).not.toHaveURL(originalUrl)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const originalMaterial = new URL(originalUrl.replace('#', '')).searchParams.get('material')!
  const sessions = await records(page, 'sessions') as unknown as StudySession[]
  expect(sessions.some(session => session.materialId === originalMaterial && !session.completedAt
    && session.draft.answer === 'Keep this unfinished thought even if the publisher page fails.')).toBe(true)
  const events = await records(page, 'events') as unknown as StudyEvent[]
  expect(events.filter(event => event.type === 'EXTERNAL_LINK_UNAVAILABLE')).toHaveLength(1)
  expect(events.some(event => ['TASK_COMPLETED', 'EXTERNAL_LISTEN_REFLECTION'].includes(event.type))).toBe(false)
  const replacementUrl = page.url()
  await page.reload()
  await expect(page).toHaveURL(replacementUrl)
  await page.goto(originalUrl)
  await expect(page.locator('#external-summary')).toHaveValue('Keep this unfinished thought even if the publisher page fails.')
})

test('English Today shares the daily allowance with an independently saved Japanese workspace', async ({ page }) => {
  await page.goto('#/')
  await expect(page.getByRole('button', { name: 'Start today’s practice', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const open = (name: string, version?: number) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, version)
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const english = await open('jove-english-os')
    const japanese = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('jove-english-os-ja', english.version)
      request.onupgradeneeded = () => {
        const transaction = english.transaction([...english.objectStoreNames], 'readonly')
        for (const name of english.objectStoreNames) {
          const source = transaction.objectStore(name), target = request.result.createObjectStore(name, { keyPath: source.keyPath, autoIncrement: source.autoIncrement })
          for (const index of source.indexNames) { const definition = source.index(index); target.createIndex(index, definition.keyPath, { unique: definition.unique, multiEntry: definition.multiEntry }) }
        }
      }
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const read = (store: string, key: string) => new Promise<unknown>((resolve, reject) => {
      const request = english.transaction(store).objectStore(store).get(key)
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const profile = await read('profiles', 'main') as Record<string, unknown>, owner = await read('syncMeta', 'owner')
    await new Promise<void>((resolve, reject) => {
      const transaction = japanese.transaction(['profiles', 'syncMeta', 'events'], 'readwrite')
      transaction.objectStore('profiles').put({ ...profile, dailyMinutes: 150, onboarded: true })
      transaction.objectStore('syncMeta').put({ id: 'learningLanguage', value: 'ja' })
      if (owner) transaction.objectStore('syncMeta').put(owner)
      transaction.objectStore('events').put({ id: 'ja-browser-completion', type: 'TASK_COMPLETED', source: 'objective', timestamp: Date.now(), data: { taskId: 'ja-task', minutes: 40 } })
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error)
    })
    english.close(); japanese.close()
  })
  await page.reload()
  await expect(page.getByText(/两种语言共用今天的 45 分钟/u)).toBeVisible()
  await expect(page.getByText(/英语还可安排 5 分钟，日语 0 分钟/u)).toBeVisible()
  await expect(page.getByText('5 min planned', { exact: true })).toBeVisible()
})

test.describe('external spoken retell',()=>{
  test.use({captureMode:'synthetic'})
  // Windows WebKit has no audio APIs; Linux CI validates its real PCM recorder.
  test.skip(({browserName})=>process.platform==='win32' && browserName==='webkit','Windows WebKit has no capture APIs')
  test('requires a saved recording and persists reflection before completing',async({page})=>{
    await page.goto('#/listen?material=external-voa-welcome')
    await page.getByRole('checkbox',{name:/I listened and have returned/}).check()
    await page.locator('#external-summary').fill('The neighbors meet and check a name.')
    await page.getByRole('button',{name:'Continue to notice an expression'}).click()
    await page.locator('#external-expression').fill('Nice to meet you')
    await page.locator('#external-example').fill('Nice to meet you. I am new here.')
    await page.getByRole('button',{name:'Continue to spoken retell'}).click()
    await page.getByRole('button',{name:'Record response',exact:true}).click()
    await expect(page.locator('.record-status')).toContainText('3s / 180s')
    await page.getByRole('button',{name:'Stop & save',exact:true}).click()
    await expect(page.getByRole('button',{name:'Save practice and continue'})).toBeEnabled()
    await page.getByRole('button',{name:'Save practice and continue'}).click()
    await expect(page).toHaveURL(/#\/today$/u)
    const events=await records(page,'events') as unknown as StudyEvent[]
    expect(events.find(e=>e.type==='EXTERNAL_LISTEN_REFLECTION')).toMatchObject({source:'self-report',data:{playbackObserved:false,comprehensionVerified:false}})
    expect(events.find(e=>e.type==='EXTERNAL_RETELL_RECORDED')).toMatchObject({source:'objective',data:{acousticAssessed:false}})
    expect(events.filter(e=>e.type.startsWith('EXTERNAL_')).every(e=>e.score===undefined)).toBe(true)
  })
})
