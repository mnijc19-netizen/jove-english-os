import { test, expect } from '@playwright/test'
import { test as storageTest, records } from './browser-fixtures'
import type { StudyEvent } from '../../src/domain/types'

// Built-bundle contract, unlike japanese-preview's DEV-only source fixtures.
// Fresh synthetic profiles only; no owner login, provider call or PWA claim.
test.use({ serviceWorkers: 'block' })
storageTest.use({ serviceWorkers: 'block' })
test('Japanese production gate matches its navigation, diagnosis and data controls', async ({ page }) => {
  await page.goto('#/ja')
  // Closed mobile navigation is deliberately inert, not absent from the build.
  const japanese = page.getByRole('link', { name: '日本語 · 日语', exact: true, includeHidden: true })
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
  await page.getByText('已有一点日语基础？可选做起点了解', { exact: true }).click()
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

storageTest('Japanese legacy practice survives unavailable microphone with a separate written correction and no oral credit', async ({ page }, testInfo) => {
  storageTest.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese build gate is off')
  let paid = 0
  await page.route('https://openrouter.ai/**', route => { paid++; return route.abort() })
  await page.route('**/functions/v1/ai', route => { paid++; return route.abort() })
  await page.addInitScript(() => {
    const probe = window as Window & { __joveLegacyMicrophone?: 'denied' | 'missing' }
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      probe.__joveLegacyMicrophone = 'missing'
      return
    }
    Object.defineProperty(mediaDevices, 'getUserMedia', { configurable: true,
      value: async () => {
        probe.__joveLegacyMicrophone = 'denied'
        throw new DOMException('Synthetic microphone denial', 'NotAllowedError')
      } })
  })
  await page.goto('#/ja')
  await page.getByRole('button', { name: '我是零基础，不猜题直接起步', exact: true }).click()
  await page.getByRole('button', { name: '确认零基础起点', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^今日练习：/ })).toBeVisible()
  await page.evaluate(async () => {
    const request = indexedDB.open('jove-english-os-ja')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const id = 'fixture-ja-no-mic', materialId = 'ja-irodori-starter-1', timestamp = Date.now() - 1000
    try { await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['sessions', 'events'], 'readwrite')
      tx.objectStore('sessions').put({ id, kind: 'japanese-practice', materialId, startedAt: timestamp, stage: 'listen',
        draft: { taskId: 'fixture-ja-no-mic-task', revision: 0, listened: false, response: '',
          expression: '', example: '', audioId: '', retryAudioId: '', comparison: '' } })
      tx.objectStore('events').put({ id: `${id}:course-assignment`, type: 'JAPANESE_COURSE_ASSIGNED', timestamp, sessionId: id, source: 'objective',
        data: { materialId, coursePhase: 'delayed-transfer', contextId: `${materialId}:context:2`, contextPrompt: '早上向同事礼貌问候。' } })
      tx.objectStore('events').put({ id: `${id}:started`, type: 'TASK_STARTED', timestamp, sessionId: id, source: 'objective',
        data: { taskId: 'fixture-ja-no-mic-task', materialId, minutes: 5 } })
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    }) } finally { database.close() }
  })
  const english = await records(page, 'events')
  await page.goto('#/ja?session=fixture-ja-no-mic')
  await page.getByRole('button', { name: 'Record response', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Record response', exact: true })).toBeEnabled()
  const microphoneState = () => page.evaluate(() =>
    (window as Window & { __joveLegacyMicrophone?: 'denied' | 'missing' }).__joveLegacyMicrophone)
  await expect.poll(microphoneState).toMatch(/^(denied|missing)$/)
  testInfo.annotations.push({ type: 'microphone', description: (await microphoneState())! })
  await page.getByRole('button', { name: '不用麦克风，改用文字练习', exact: true }).click()
  await expect(page.getByText('文字／选句 → 保存原表达 → 核对并修正。', { exact: false })).toBeVisible()
  await page.getByRole('textbox', { name: '你想怎样回应这个情境？可用中文说意思，也可以如实写还不会。', exact: true }).fill('还不会，先练早晨问候')
  await page.getByRole('button', { name: '保存并继续', exact: true }).click()
  await expect.poll(async () => (await records(page, 'events', 'jove-english-os-ja'))
    .some(event => event.id === 'fixture-ja-no-mic:independent-attempt')).toBe(true)
  await expect(page.getByText('以下是本站练习例句，不是原站逐字字幕：', { exact: true })).toBeVisible()
  const first = (await records(page, 'events', 'jove-english-os-ja') as unknown as StudyEvent[]).find(event => event.id === 'fixture-ja-no-mic:independent-attempt')!
  expect(first.data).toMatchObject({ practiceMode: 'text', recordingBeforeHelp: false, speakingVerified: false, independentTransferVerified: false })
  expect(first.data?.audioId).toBeUndefined()
  await page.getByRole('textbox', { name: '换成自己的情况，说或写一句', exact: true }).fill('おはよう。')
  await page.getByRole('button', { name: '保存并继续', exact: true }).click()
  await page.getByRole('button', { name: '保存并继续', exact: true }).click()
  await page.getByRole('button', { name: '借助已讲例句完成修正', exact: true }).click()
  await page.getByRole('textbox', { name: '这次准备调整什么？', exact: true }).fill('对同事使用更礼貌的问候，不覆盖原句。')
  await page.getByRole('button', { name: '保存这次完整练习', exact: true }).click()
  await expect(page.getByRole('heading', { name: '这次练习已保存', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '这次练习已保存', exact: true })).toBeVisible()
  const saved = (await records(page, 'sessions', 'jove-english-os-ja')).find(row => row.id === 'fixture-ja-no-mic')!
  expect(saved.draft).toMatchObject({ practiceMode: 'choice', helped: true, listened: false, audioId: '', retryAudioId: '',
    example: 'おはよう。', retryText: 'おはようございます。' })
  const events = await records(page, 'events', 'jove-english-os-ja')
  expect(events.find(event => event.id === first.id)).toEqual(first)
  expect(events.find(event => event.id === 'fixture-ja-no-mic:reflection')).toMatchObject({ type: 'JAPANESE_TEXT_PRACTICE', source: 'text', prompted: true,
    data: { listened: false, practiceMode: 'choice', independentTransferVerified: false, speakingVerified: false } })
  expect(events.filter(event => event.id === 'fixture-ja-no-mic:completed')).toHaveLength(1)
  expect(await records(page, 'audio', 'jove-english-os-ja')).toEqual([])
  expect((await records(page, 'skills', 'jove-english-os-ja')).every(skill => skill.evidenceCount === 0)).toBe(true)
  expect(await records(page, 'events')).toEqual(english)
  expect(paid).toBe(0)
})

storageTest('Japanese delayed application saves a first answer before exposing reference help', async ({ page }) => {
  storageTest.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese build gate is off')
  let paid = 0
  await page.route('https://openrouter.ai/**', route => { paid++; return route.abort() })
  await page.route('**/functions/v1/ai', route => { paid++; return route.abort() })
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: '跳过', exact: true, includeHidden: true })).toHaveCount(6)
  await page.getByRole('button', { name: '我是零基础，不猜题直接起步', exact: true }).click()
  await page.getByRole('button', { name: '确认零基础起点', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^今日练习：/ })).toBeVisible()
  await page.evaluate(async () => {
    const request = indexedDB.open('jove-english-os-ja')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const now = Date.now(), id = 'fixture-delayed-practice', materialId = 'ja-irodori-starter-1', contextId = `${materialId}:context:2`
    // A native Blob fixture proves storage/disclosure wiring, not learner speech quality.
    const blob = new Blob([await (await fetch('audio/train-change-1.wav')).arrayBuffer()], { type: 'audio/wav' })
    try { await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['sessions', 'events', 'audio'], 'readwrite')
      tx.objectStore('sessions').put({ id, kind: 'japanese-practice', materialId, startedAt: now - 1000, stage: 'listen',
        draft: { taskId: 'fixture-delayed-task', revision: 0, listened: false, response: '', expression: '', example: '', audioId: 'fixture-delayed-first-audio', retryAudioId: '', comparison: '' } })
      tx.objectStore('audio').put({ id: 'fixture-delayed-first-audio', blob, mimeType: 'audio/wav', createdAt: now, duration: 1, kind: 'recording', processed: false, label: 'Synthetic independent-answer fixture' })
      tx.objectStore('events').put({ id: `${id}:course-assignment`, type: 'JAPANESE_COURSE_ASSIGNED', source: 'objective', timestamp: now,
        sessionId: id, contextId, data: { materialId, coursePhase: 'delayed-transfer', contextId, contextPrompt: '换成向邻居问候并告别。' } })
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    }) } finally { database.close() }
  })
  await page.goto('#/ja?session=fixture-delayed-practice')
  await expect(page.getByRole('textbox', { name: '不看参考，我会这样回答（日语）' })).toBeVisible()
  await expect(page.getByRole('link', { name: '打开原站真人音频 ↗' })).toHaveCount(0)
  await expect(page.getByText('以下是本站练习例句，不是原站逐字字幕：')).toHaveCount(0)
  await page.getByRole('textbox', { name: '不看参考，我会这样回答（日语）' }).fill('おはようございます。')
  await page.getByRole('button', { name: '保存并继续', exact: true }).click()
  await expect(page.getByText('以下是本站练习例句，不是原站逐字字幕：')).toBeVisible()
  await expect(page.getByRole('link', { name: '打开原站真人音频 ↗' })).toBeVisible()
  await page.getByRole('textbox', { name: '换成自己的情况，说或写一句' }).fill('こんにちは。')
  await expect.poll(async () => (await records(page, 'sessions', 'jove-english-os-ja')).find(row => row.id === 'fixture-delayed-practice')?.draft).toMatchObject({ response: 'おはようございます。', example: 'こんにちは。' })
  const first = (await records(page, 'events', 'jove-english-os-ja')).find(row => row.id === 'fixture-delayed-practice:independent-attempt')!
  expect(first).toMatchObject({ source: 'self-report', data: { response: 'おはようございます。', audioId: 'fixture-delayed-first-audio', masteryAssessed: false } })
  await page.reload()
  await expect(page.getByRole('textbox', { name: '换成自己的情况，说或写一句' })).toHaveValue('こんにちは。')
  // A metadata-only restore has no recording reference. It must allow a
  // supported replacement, without rewriting the frozen independent event.
  await page.evaluate(async () => {
    const request = indexedDB.open('jove-english-os-ja')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try { await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('sessions', 'readwrite'), store = tx.objectStore('sessions'), read = store.get('fixture-delayed-practice')
      read.onsuccess = () => store.put({ ...read.result, stage: 'speak', draft: { ...read.result.draft,
        listened: true, expression: 'こんにちは', audioId: '', retryAudioId: '', audioUnavailable: true } })
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    }) } finally { database.close() }
  })
  await page.reload()
  await expect(page.getByText('独立首答记录仍锁定。', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record response', exact: true })).toBeEnabled()
  expect((await records(page, 'events', 'jove-english-os-ja')).find(row => row.id === first.id)).toEqual(first)
  expect(paid).toBe(0)
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
  await expect(page.getByRole('radio', { name: '跳过', exact: true, includeHidden: true })).toHaveCount(6)
  await expect(page.getByRole('button', { name: '重试打开日语区', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('radio', { name: '跳过', exact: true, includeHidden: true })).toHaveCount(6)
  await expect(page.getByRole('button', { name: '重试打开日语区', exact: true })).toHaveCount(0)
  expect(cursors.en).toBeGreaterThan(0); expect(cursors.ja).toBeGreaterThan(0)
  expect(unexpected).toEqual([])
})

test('a beginner can correct a guessed diagnosis without clearing it or changing English', async ({ page }) => {
  test.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese build gate is off')
  const snapshot = () => page.evaluate(async () => {
    const read = async (name: string) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      try {
        const transaction = database.transaction(['assessments', 'profiles', 'events', 'sessions'])
        const rows = (store: string) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
          const request = transaction.objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
        const [assessments, profiles, events, sessions] = await Promise.all(['assessments', 'profiles', 'events', 'sessions'].map(rows))
        return { assessments, profiles, events, sessions }
      } finally { database.close() }
    }
    return { en: await read('jove-english-os'), ja: await read('jove-english-os-ja') }
  })
  await page.goto('#/ja')
  for (const answer of ['neko', 'koohii', '一拍', '昨天看了电影', 'に', '邀请一起吃饭']) {
    if (!(await page.getByRole('radio', { name: answer, exact: true }).isVisible())) await page.getByText('已有一点日语基础？可选做起点了解', { exact: true }).click()
    await page.getByRole('radio', { name: answer, exact: true }).check()
  }
  await page.getByRole('button', { name: '保存诊断，安排今天', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^今日练习：/ })).toBeVisible()
  const before = await snapshot()
  await page.getByRole('button', { name: '起点填错了？按零基础重新起步', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect((await snapshot()).ja.assessments).toEqual(before.ja.assessments)
  await page.getByRole('button', { name: '起点填错了？按零基础重新起步', exact: true }).click()
  await page.getByRole('button', { name: '确认零基础起点', exact: true }).click()
  await expect(page.getByTestId('japanese-starting-point')).toContainText('本人确认零基础')
  await expect(page.getByRole('heading', { name: '今日练习：零基础第一步：认识 あ・い・う・え・お', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('japanese-starting-point')).toContainText('本人确认零基础')
  const after = await snapshot()
  expect(after.en).toEqual(before.en)
  expect(after.ja.assessments.find(row => row.id === 'ja-initial-diagnostic')).toEqual(before.ja.assessments[0])
  expect(after.ja.assessments.find(row => row.id === 'ja-beginner-start')).toMatchObject({
    stage: 'self-reported-beginner', responses: { startingPoint: 'beginner' },
    scores: { scriptRecognition: null, sentenceMeaning: null, listening: null, speaking: null },
  })
  expect(after.ja.events).toEqual(before.ja.events)
  expect(after.ja.sessions).toEqual(before.ja.sessions)
})

test('Japanese absolute beginner is taught before recognition and can finish without typing Japanese or notes', async ({ page }) => {
  test.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese build gate is off')
  let paid = 0
  await page.route('**/functions/v1/ai', route => { paid++; return route.abort() })
  await page.route('https://openrouter.ai/**', route => { paid++; return route.abort() })
  await page.goto('#/ja')
  await page.getByRole('button', { name: '我是零基础，不猜题直接起步', exact: true }).click()
  await page.getByRole('button', { name: '确认零基础起点', exact: true }).click()
  await expect(page.getByRole('heading', { name: /今日练习：零基础第一步/ })).toBeVisible()
  await page.getByRole('button', { name: /^开始学习 · 约/ }).click()
  await expect(page).toHaveURL(/#\/ja\/read\?session=/)
  await expect(page.getByTestId('kana-teaching')).toContainText('先认识，不用猜，也不用写日语')
  await expect(page.getByRole('radio', { name: 'a', exact: true })).toHaveCount(0)
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await page.getByRole('radio', { name: '现在无法播放，先做字形练习' }).check()
  await page.getByRole('button', { name: '我已看过教学，开始点选练习' }).click()
  await expect(page.getByTestId('kana-teaching')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('radio', { name: '现在无法播放，先做字形练习' })).toBeChecked()
  await expect(page.getByTestId('kana-teaching')).toHaveCount(0)
  await page.getByRole('group', { name: '1. 「あ」对应哪个临时罗马字标记？' }).getByRole('radio', { name: 'a', exact: true }).check()
  await page.getByRole('group', { name: '2. 「お」对应哪个临时罗马字标记？' }).getByRole('radio', { name: 'o', exact: true }).check()
  await page.getByRole('group', { name: 'ai（爱） 对应哪种假名写法？' }).getByRole('radio', { name: 'あい', exact: true }).check()
  await page.getByRole('group', { name: 'ue（上面） 对应哪种假名写法？' }).getByRole('radio', { name: 'うえ', exact: true }).check()
  await page.getByRole('button', { name: '保存首答，再看解析' }).click()
  await expect(page.getByText('（使用过帮助）', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: '保存基础练习，安排下次回顾' })).toBeEnabled()
  await page.getByRole('button', { name: '保存基础练习，安排下次回顾' }).click()
  await expect(page.getByRole('heading', { name: '这次基础练习已保存' })).toBeVisible()
  const check = (await records(page, 'events', 'jove-english-os-ja')).find(row => row.type === 'JAPANESE_KANA_CHECK')!
  expect(check).toMatchObject({ prompted: true, data: { playbackObserved: false, publisherHeardSelfReport: false, listeningAssessed: false, acousticAssessed: false } })
  await page.getByRole('link', { name: '继续今日安排', exact: true }).click()
  await expect(page.getByRole('heading', { name: '暂时没有新的必做任务' })).toBeVisible()
  expect(paid).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
})
