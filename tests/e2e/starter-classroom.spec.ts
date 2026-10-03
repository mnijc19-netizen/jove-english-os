import { type Page } from '@playwright/test'
import { test, expect, records } from './browser-fixtures'
import { starterEntryLessons, starterLesson, starterLessons, type StarterLesson } from '../../src/content/starter-courses'
import { defaultSettings } from '../../src/domain/types'

// Fresh synthetic learners, real built UI/IndexedDB/audio decoding. Not a human
// efficacy, native pronunciation or paid provider accuracy assessment.
test.use({ serviceWorkers: 'block' })
async function blockPaid(page: Page) {
  const calls: string[] = []
  await page.route('https://openrouter.ai/**', route => { calls.push(route.request().url()); return route.abort() })
  await page.route('**/functions/v1/ai', route => { calls.push(route.request().postData() ?? ''); return route.abort() })
  return calls
}
async function useSyntheticLocalProvider(page: Page) {
  await page.goto('#/settings')
  await expect(page.getByTestId('current-release')).toBeVisible()
  await page.evaluate(async settings => {
    const read = indexedDB.open('jove-english-os')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['secrets', 'settings'], 'readwrite')
      tx.objectStore('secrets').put({ id: 'openrouter', value: 'synthetic-classroom-marker-not-a-key' })
      tx.objectStore('secrets').put({ id: 'provider-mode', value: 'byok' })
      tx.objectStore('settings').put({ id: 'main', value: { ...settings, strongModel: 'fixture/starter-strong' } })
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    }); database.close()
  }, defaultSettings)
  await page.goto('#/course/en'); await page.reload()
}
async function seed(page: Page, language: 'en' | 'ja', lesson: StarterLesson, completedAgo = 1000) {
  await page.evaluate(async ({ language, prerequisites, completedAgo }) => {
    const read = indexedDB.open(language === 'ja' ? 'jove-english-os-ja' : 'jove-english-os')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('sessions', 'readwrite')
      for (const id of prerequisites) tx.objectStore('sessions').put({ id: `fixture-completed-${id}`, kind: 'starter-classroom', materialId: id,
        startedAt: Date.now() - completedAgo - 2000, completedAt: Date.now() - completedAgo, stage: 'done', draft: { purpose: 'lesson' } })
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    }); database.close()
  }, { language, prerequisites: lesson.prerequisites, completedAgo })
}
async function teachAndRecognize(page: Page, lesson: StarterLesson) {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(lesson.titleZh)
  await expect(page.getByText('新课堂试用版 · 教学、合成示范与 AI 反馈仍待人工复核。', { exact: true })).toBeVisible()
  await expect(page.getByText(lesson.model.meaningZh, { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await page.getByRole('button', { name: '我看过示范了，试一个小问题', exact: true }).click()
  await page.getByRole('radio', { name: lesson.recognition.choices.find(choice => choice.id === lesson.recognition.answerId)!.textZh, exact: true }).check()
  await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
  await page.getByRole('button', { name: '继续下一小步', exact: true }).click()
  for (const piece of lesson.scaffold.pieces) await page.getByRole('button', { name: piece, exact: true }).click()
  await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
  await page.getByRole('button', { name: '继续下一小步', exact: true }).click()
}

test('English starts by teaching, repairs a real error and preserves the first answer across reload', async ({ page }) => {
  const calls = await blockPaid(page), lesson = starterLessons[0]!
  await page.goto('#/course/en')
  await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
  await teachAndRecognize(page, lesson)
  const original = lesson.expression.errors[0]!
  await page.getByRole('textbox', { name: '试着用刚教的表达回应', exact: true }).fill(original.input)
  await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
  await expect(page.getByText(original.feedbackZh, { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText(original.feedbackZh, { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '试着用刚教的表达回应', exact: true }).fill(lesson.expression.reference)
  await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
  await page.getByRole('button', { name: '保存，结束这个小课', exact: true }).click()
  await expect(page.getByRole('heading', { name: '这次的小目标已经练过。', exact: true })).toBeVisible()
  const attempts = (await records(page, 'events')).filter(row => row.type === 'STARTER_ATTEMPT' && (row.data as Record<string, unknown>).stage === 'express')
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
  expect(attempts.map(row => (row.data as Record<string, unknown>).response)).toEqual([original.input, lesson.expression.reference])
  expect(attempts.every(row => row.prompted === true && row.score === undefined)).toBe(true)
  expect(calls).toEqual([])
})

test('editing a valid answer returns to one primary check action instead of silently advancing', async ({ page }) => {
  await blockPaid(page)
  const lesson = starterLessons[0]!
  await page.goto('#/course/en')
  await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
  await teachAndRecognize(page, lesson)
  const answer = page.getByRole('textbox', { name: '试着用刚教的表达回应', exact: true })
  await answer.fill(lesson.expression.reference)
  await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
  await expect(page.locator('.starter-focus .button.primary')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '看看这次表达', exact: true })).toHaveCount(0)
  await answer.fill(lesson.expression.errors[0]!.input)
  await expect(page.getByRole('button', { name: '保存，结束这个小课', exact: true })).toHaveCount(0)
  await expect(page.locator('.starter-focus .button.primary')).toHaveCount(1)
  await expect(page.getByText('下面是上一份已提交回答的反馈。', { exact: false })).toBeVisible()
  await expect(page.getByText('已保存在本机', { exact: true })).toBeVisible()
  // The reload must not race the debounced save; read the durable draft first.
  await expect.poll(async () => (await records(page, 'sessions')).some(session => (session.draft as Record<string, unknown>).response === lesson.expression.errors[0]!.input)).toBe(true)
  await page.reload()
  await expect(answer).toHaveValue(lesson.expression.errors[0]!.input)
  await expect(page.getByRole('button', { name: '保存，结束这个小课', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
  await expect(page.getByText(lesson.expression.errors[0]!.feedbackZh, { exact: true })).toBeVisible()
  expect((await records(page, 'events')).filter(event => event.type === 'TASK_COMPLETED')).toHaveLength(0)
})

test('an answer edited while the real local save is pending cannot dispatch AI for the earlier answer', async ({ page }) => {
  const calls = await blockPaid(page), lesson = starterLessons[0]!
  await useSyntheticLocalProvider(page)
  await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
  await teachAndRecognize(page, lesson)
  const answer = page.getByRole('textbox', { name: '试着用刚教的表达回应', exact: true })
  await answer.fill(lesson.expression.reference)
  await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
  await page.getByText('需要时请 AI 核对当前回答', { exact: true }).click()
  await page.getByRole('checkbox', { name: '同意本次云端处理', exact: true }).check()
  // An actual native readwrite transaction holds the session store. It writes
  // nothing; asynchronous get requests keep it alive until the test releases it.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const gate = window as Window & { __starterFlushRelease?: boolean }
    gate.__starterFlushRelease = false
    const open = indexedDB.open('jove-english-os')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const database = open.result, tx = database.transaction('sessions', 'readwrite'), store = tx.objectStore('sessions')
      tx.oncomplete = () => database.close(); tx.onabort = () => database.close()
      const keepAlive = () => { store.get('fixture-save-gate').onsuccess = () => { if (!gate.__starterFlushRelease) keepAlive() } }
      keepAlive(); resolve()
    }
  }))
  try {
    await answer.fill(lesson.expression.reference + ' ')
    await page.getByRole('button', { name: '请 AI 只核对这一处', exact: true }).click()
    await expect(page.getByText('保存中…', { exact: true })).toBeVisible()
    await answer.fill(lesson.expression.errors[0]!.input)
  } finally { await page.evaluate(() => { (window as Window & { __starterFlushRelease?: boolean }).__starterFlushRelease = true }) }
  await expect.poll(async () => (await records(page, 'sessions')).some(session => (session.draft as Record<string, unknown>).response === lesson.expression.errors[0]!.input)).toBe(true)
  await expect(answer).toHaveValue(lesson.expression.errors[0]!.input)
  expect(calls).toEqual([])
  expect((await records(page, 'events')).some(event => event.type === 'STARTER_FEEDBACK' && event.source === 'ai')).toBe(false)
})

test('a delayed synthetic AI response preserves a new unsent practice-mode change and original attempt', async ({ page }) => {
  const lesson = starterLessons[0]!, model = 'fixture/starter-strong'
  await page.clock.install()
  let releaseReply!: () => void, completionRequests = 0
  const replyGate = new Promise<void>(resolve => { releaseReply = resolve })
  await page.route('https://*.supabase.co/**', route => route.abort())
  await page.route('https://openrouter.ai/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/models')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{
      id: model, name: 'Synthetic classroom fixture', architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['structured_outputs', 'response_format'],
    }] }) })
    if (url.pathname.endsWith('/chat/completions')) {
      completionRequests++
      await replyGate
      return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify({ model,
        choices: [{ message: { content: JSON.stringify({ verdict: 'valid', feedbackZh: '本次示范句能表达问候和名字。',
          correction: null, nextAction: 'continue', evidence: lesson.expression.reference }) }, finish_reason: 'stop' }],
        usage: { total_tokens: 12, cost: 0 },
      }) })
    }
    return route.abort()
  })
  // Only the isolated test browser receives a non-credential fixture marker.
  await useSyntheticLocalProvider(page)
  await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
  await teachAndRecognize(page, lesson)
  await page.getByRole('button', { name: '不会打字 / 换成选句练习', exact: true }).click()
  await page.getByRole('button', { name: `用这句试着回应：${lesson.expression.reference}`, exact: true }).click()
  await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
  await expect.poll(async () => (await records(page, 'events')).filter(event => event.type === 'STARTER_ATTEMPT' && (event.data as Record<string, unknown>).stage === 'express')).toHaveLength(1)
  const first = (await records(page, 'events')).find(event => event.type === 'STARTER_ATTEMPT' && (event.data as Record<string, unknown>).stage === 'express')!
  await page.getByText('需要时请 AI 核对当前回答', { exact: true }).click()
  await page.getByRole('checkbox', { name: '同意本次云端处理', exact: true }).check()
  await page.getByRole('button', { name: '请 AI 只核对这一处', exact: true }).click()
  try {
    await expect.poll(() => completionRequests).toBe(1).catch(async failure => {
      await page.getByText('诊断信息', { exact: true }).click()
      throw new Error(`${failure.message}\nSynthetic fixture diagnosis: ${await page.locator('.ai-option').innerText()}`)
    })
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)))
    await page.getByRole('button', { name: '我想试着自己写', exact: true }).click()
    const edited = page.getByRole('textbox', { name: '试着用刚教的表达回应', exact: true })
    await expect(edited).toHaveValue('')
    releaseReply()
    await expect.poll(async () => (await records(page, 'events')).some(event => event.type === 'STARTER_FEEDBACK' && event.source === 'ai')).toBe(true).catch(async failure => {
      await page.getByText('诊断信息', { exact: true }).click()
      throw new Error(`${failure.message}\nSynthetic response diagnosis: ${await page.locator('.ai-option').innerText()}`)
    })
    await expect(edited).toBeEnabled()
    await expect(edited).toHaveValue('')
    await expect(page.getByText('下面是上一份已提交回答的反馈。', { exact: false })).toBeVisible()
    await page.clock.runFor(400)
    await expect.poll(async () => (await records(page, 'sessions')).some(session => {
      const draft = session.draft as Record<string, unknown>
      return draft.mode === 'text' && draft.response === ''
    })).toBe(true)
    await page.reload()
    await expect(edited).toHaveValue('')
    expect((await records(page, 'events')).find(event => event.id === first.id)).toEqual(first)
    expect(completionRequests).toBe(1)
  } finally { releaseReply() }
})

test('Japanese zero learner can listen and finish by supported selection without knowing kana or an input method', async ({ page }) => {
  test.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese production build gate is off')
  const calls = await blockPaid(page), lesson = starterLessons.find(lesson => lesson.id === 'ja-starter-1')!
  await page.goto('#/course/ja')
  await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
  const audio = page.getByLabel('日语短句合成示范', { exact: true })
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.readyState)).toBeGreaterThanOrEqual(2)
  await teachAndRecognize(page, lesson)
  await page.getByRole('button', { name: '不会打字 / 换成选句练习', exact: true }).click()
  await page.getByRole('button', { name: `用这句试着回应：${lesson.expression.reference}`, exact: true }).click()
  await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
  await page.getByRole('button', { name: '保存，结束这个小课', exact: true }).click()
  await expect(page.getByText('学习结束不代表已经掌握', { exact: false })).toBeVisible()
  expect((await records(page, 'events')).some(row => row.type === 'STARTER_ATTEMPT')).toBe(false)
  const attempts = (await records(page, 'events', 'jove-english-os-ja')).filter(row => row.type === 'STARTER_ATTEMPT')
  expect(attempts.every(row => row.prompted === true && row.score === undefined)).toBe(true)
  expect(calls).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

// All original contracts plus the first/final expanded lesson in each language;
// every intervening authored package has deterministic content/feedback tests.
for (const lesson of [...starterEntryLessons, ...['en-starter-4', 'en-starter-24', 'ja-starter-4', 'ja-starter-24'].map(id => starterLesson(id)!)]) test(`complete ${lesson.id} with no AI; transfer hides the answer until help or first submission`, async ({ page }) => {
  test.skip(lesson.language === 'ja' && process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese production build gate is off')
  const calls = await blockPaid(page)
  await page.goto(`#/course/${lesson.language}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('从能用的一句话开始。')
  await seed(page, lesson.language, lesson)
  await page.reload()
  await page.getByText('查看 24 节基础小课的顺序与讲解', { exact: true }).click()
  const card = page.locator('.course-list li').filter({ has: page.getByRole('heading', { name: `第 ${lesson.position} 课 · ${lesson.titleZh}`, exact: true }) })
  await card.getByRole('button', { name: `标准小课 · ${lesson.minutes.standard} 分钟`, exact: true }).click()
  await teachAndRecognize(page, lesson)
  await page.getByRole('textbox', { name: '试着用刚教的表达回应', exact: true }).fill(lesson.expression.reference)
  await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
  await page.getByRole('button', { name: '继续下一小步', exact: true }).click()
  await expect(page.getByRole('heading', { name: lesson.transfer[0]!.promptZh, exact: true })).toBeVisible()
  await expect(page.locator('.starter-example')).toHaveCount(0)
  await expect(page.locator('.starter-focus audio')).toHaveCount(0)
  await page.getByRole('textbox', { name: '试着用刚教的表达回应', exact: true }).fill(lesson.transfer[0]!.reference)
  await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
  await page.getByRole('button', { name: '保存，结束这个小课', exact: true }).click()
  await expect(page.getByRole('heading', { name: '这次的小目标已经练过。', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '这次的小目标已经练过。', exact: true })).toBeVisible()
  expect(calls).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('two unsuccessful attempts automatically simplify without erasing either original', async ({ page }) => {
  await blockPaid(page)
  const lesson = starterLessons[0]!
  await page.goto('#/course/en')
  await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
  await teachAndRecognize(page, lesson)
  for (let count = 0; count < 2; count++) {
    await page.getByRole('textbox', { name: '试着用刚教的表达回应', exact: true }).fill(lesson.expression.errors[0]!.input)
    await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
    await expect(page.getByText(lesson.expression.errors[0]!.feedbackZh, { exact: true })).toBeVisible()
  }
  await expect(page.getByRole('button', { name: `用这句试着回应：${lesson.expression.reference}`, exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: `用这句试着回应：${lesson.expression.reference}`, exact: true })).toBeVisible()
  const attempts = (await records(page, 'events')).filter(row => row.type === 'STARTER_ATTEMPT' && (row.data as Record<string, unknown>).stage === 'express')
  expect(attempts).toHaveLength(2)
  expect(attempts.every(row => (row.data as Record<string, unknown>).response === lesson.expression.errors[0]!.input)).toBe(true)
})

test('unchanged same-day clock ticks do not repeatedly read the classroom budget', async ({ page }) => {
  const calls = await blockPaid(page)
  const clockStart = new Date('2026-10-04T04:00:00.000Z')
  await page.clock.install({ time: clockStart })
  // Pause before loading the app, against the installed clock rather than the
  // Windows host clock (WebKit may already be milliseconds ahead of it).
  await page.clock.pauseAt(new Date(clockStart.getTime() + 60_000))
  await page.addInitScript(() => {
    const trace = { preferenceReads: 0 }
    Object.defineProperty(window, '__starterBudgetReadTrace', { value: trace, configurable: true })
    const original = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
      if (this.name === 'sessions' && query === 'language-time-preference') trace.preferenceReads++
      return original.call(this, query)
    }
  })
  await page.goto('#/today')
  await expect(page.getByRole('link', { name: '跟着示范，开始学一句 · 约 5 分钟', exact: true })).toBeVisible()
  const reads = () => page.evaluate(() => (window as unknown as { __starterBudgetReadTrace: { preferenceReads: number } }).__starterBudgetReadTrace.preferenceReads)
  const before = await reads()
  expect(before).toBeGreaterThan(0)
  await page.clock.fastForward(15000)
  await expect(page.getByRole('link', { name: '跟着示范，开始学一句 · 约 5 分钟', exact: true })).toBeVisible()
  expect(await reads()).toBe(before)
  expect(calls).toEqual([])
})

test('five-minute English cold start matches the displayed next lesson without creating Japanese storage', async ({ page }) => {
  const calls = await blockPaid(page), first = starterLesson('en-starter-1')!, second = starterLesson('en-starter-2')!
  await page.goto('#/course/en')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('从能用的一句话开始。')
  await seed(page, 'en', { ...first, prerequisites: [first.id] }, 2 * 86400000)
  await page.evaluate(async () => {
    const read = indexedDB.open('jove-english-os')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('profiles', 'readwrite'), request = tx.objectStore('profiles').get('main')
      request.onsuccess = () => tx.objectStore('profiles').put({ ...request.result, dailyMinutes: 5 })
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    }); database.close()
  })
  await page.goto('#/today?practice=1'); await page.reload()
  await expect(page.getByRole('heading', { name: second.goalZh, exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '先把学过的表达再用一次 · 约 3 分钟', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: '跟着示范，开始学一句 · 约 5 分钟', exact: true }).click()
  await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(second.titleZh)
  expect(await page.evaluate(async () => (await indexedDB.databases()).some(database => database.name === 'jove-english-os-ja'))).toBe(false)
  expect(calls).toEqual([])
})

test('a bookmarked continuation page still prioritizes due entry review instead of hiding it', async ({ page }) => {
  const calls = await blockPaid(page), lessons = starterLessons.filter(lesson => lesson.language === 'en')
  await page.goto('#/course/en')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('从能用的一句话开始。')
  await seed(page, 'en', { ...lessons[2]!, prerequisites: lessons.map(lesson => lesson.id) }, 2 * 86400000)
  await page.goto('#/today?practice=1')
  const review = page.getByRole('link', { name: '先把学过的表达再用一次 · 约 3 分钟', exact: true })
  await expect(review).toBeVisible()
  await expect(page.locator('.legacy-practice')).not.toHaveAttribute('open', '')
  await review.click()
  await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
  await expect(page.locator('.starter-example')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: lessons[0]!.transfer[0]!.promptZh, exact: true })).toBeVisible()
  expect(calls).toEqual([])
})

test('Japanese literacy can admit a declared zero learner directly without a diagnostic or input method', async ({ page }) => {
  test.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese production build gate is off')
  const calls = await blockPaid(page)
  await page.goto('#/ja/literacy')
  await page.getByRole('button', { name: '我还是零基础，接着学假名', exact: true }).click()
  await expect(page).toHaveURL(/#\/ja\/read\?session=/)
  await expect(page.getByTestId('kana-teaching')).toContainText('先认识，不用猜，也不用写日语')
  await expect(page.getByRole('textbox')).toHaveCount(0)
  expect(calls).toEqual([])
})

test('starting English first does not lock a new Japanese learner out of the shared daily budget', async ({ page }) => {
  test.skip(process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese production build gate is off')
  const calls = await blockPaid(page)
  await page.goto('#/course/en')
  await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(starterLessons[0]!.titleZh)
  await page.getByRole('button', { name: '暂停，回到今日安排', exact: true }).click()
  await page.goto('#/course/ja')
  await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(starterLessons.find(lesson => lesson.language === 'ja')!.titleZh)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect((await records(page, 'sessions')).filter(row => row.kind === 'starter-classroom')).toHaveLength(1)
  expect((await records(page, 'sessions', 'jove-english-os-ja')).filter(row => row.kind === 'starter-classroom')).toHaveLength(1)
  expect(calls).toEqual([])
})

for (const language of ['en', 'ja'] as const) test(`${language} third lesson automatically continues to fourth with recoverable foundation help`, async ({ page }) => {
  test.skip(language === 'ja' && process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese production build gate is off')
  const calls = await blockPaid(page), lesson = starterLesson(`${language}-starter-4`)!
  const assetRequests: string[] = []
  page.on('request', request => { if (request.url().includes('/audio/starter/')) assetRequests.push(request.url()) })
  await page.goto(`#/course/${language}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('从能用的一句话开始。')
  await seed(page, language, { ...lesson, prerequisites: starterEntryLessons.filter(item => item.language === language).map(item => item.id) })
  await page.goto(language === 'en' ? '#/today?practice=1' : '#/ja')
  await page.getByRole('link', { name: '跟着示范，开始学一句 · 约 5 分钟', exact: true }).click()
  await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(lesson.titleZh)
  const foundation = page.getByTestId('classroom-foundation'), check = lesson.foundation!.check
  if (page.viewportSize()!.width <= 600) {
    const button = page.getByRole('button', { name: '我看过示范了，试一个小问题', exact: true })
    await expect(button).toHaveCSS('position', 'fixed')
    await expect(button).toHaveCSS('min-height', '52px')
    const next = await button.boundingBox()
    const geometry = await button.evaluate(element => ({ rect: element.getBoundingClientRect().toJSON(),
      viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale },
      transform: getComputedStyle(element).transform, parentTransform: getComputedStyle(element.parentElement!).transform }))
    expect(next!.height, JSON.stringify(geometry)).toBeGreaterThanOrEqual(48)
    expect(next!.y).toBeGreaterThanOrEqual(0)
    expect(next!.y + next!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
    expect(next!.x).toBeGreaterThanOrEqual(0)
    expect(next!.x + next!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    const menu = page.getByRole('button', { name: 'Toggle navigation', exact: true })
    await menu.click()
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => button.evaluate(element => {
      const rect = element.getBoundingClientRect(), front = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return front === element || !!front && element.contains(front)
    })).toBe(false)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
  }
  await foundation.locator('summary').click()
  const wrong = check.choices.find(choice => choice.id !== check.answerId)!
  await foundation.getByRole('button', { name: wrong.textZh, exact: true }).click()
  await expect(foundation.getByRole('status')).toContainText('先回看')
  await foundation.getByRole('button', { name: check.choices.find(choice => choice.id === check.answerId)!.textZh, exact: true }).click()
  await expect(foundation.getByRole('status')).toContainText('讲解支持下')
  await page.reload()
  await foundation.locator('summary').click()
  await expect(foundation.getByRole('status')).toContainText('原答案保留')
  expect(await page.locator('.starter-focus audio').count()).toBe(0)
  const events = await records(page, 'events', language === 'en' ? 'jove-english-os' : 'jove-english-os-ja')
  const attempts = events.filter(event => event.type === 'STARTER_FOUNDATION_ATTEMPT')
  expect(attempts).toHaveLength(2)
  expect(attempts.every(event => event.prompted === true && (event.data as Record<string, unknown>).acousticAssessed === false)).toBe(true)
  expect(events.filter(event => event.type === 'STARTER_ATTEMPT')).toHaveLength(0)
  expect(assetRequests).toEqual([])
  expect(calls).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

for (const language of ['en', 'ja'] as const) test(`completed ${language} foundation sequence leads to a usable continuation, not another empty classroom`, async ({ page }) => {
  test.skip(language === 'ja' && process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese production build gate is off')
  const calls = await blockPaid(page)
  await page.goto(`#/course/${language}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('从能用的一句话开始。')
  const lessons = starterLessons.filter(lesson => lesson.language === language)
  await seed(page, language, { ...lessons[2]!, prerequisites: lessons.map(lesson => lesson.id) })
  // Actual classroom admission enables its language only after reserving a task.
  await page.evaluate(async language => {
    const read = indexedDB.open(language === 'ja' ? 'jove-english-os-ja' : 'jove-english-os')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('profiles', 'readwrite'), request = tx.objectStore('profiles').get('main')
      request.onsuccess = () => tx.objectStore('profiles').put({ ...request.result, onboarded: true })
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    }); database.close()
  }, language)
  await page.reload()
  await expect(page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '接续系统安排', exact: true })).toBeVisible()
  await page.goto(language === 'en' ? '#/today' : '#/ja')
  await page.getByRole('link', { name: language === 'en' ? '接着系统安排学下一步' : '接着学假名与阅读', exact: true }).click()
  if (language === 'en') {
    await expect(page).toHaveURL(/#\/today\?practice=1$/)
    await expect(page.locator('.legacy-practice')).toHaveAttribute('open', '')
    await expect(page.getByRole('button', { name: 'Start today’s practice', exact: true })).toBeVisible()
    await expect(page.getByLabel('下一项学习指引', { exact: true })).toBeVisible()
  } else {
    await expect(page).toHaveURL(/#\/ja\/literacy$/)
    await page.getByRole('button', { name: '开始下一步', exact: true }).click()
    await expect(page).toHaveURL(/#\/ja\/read\?session=/)
    await expect(page.getByTestId('kana-teaching')).toContainText('先认识，不用猜，也不用写日语')
    await expect(page.getByRole('textbox')).toHaveCount(0)
  }
  expect(calls).toEqual([])
  const completed = (await records(page, 'sessions', language === 'en' ? 'jove-english-os' : 'jove-english-os-ja'))
    .filter(row => String(row.id).startsWith('fixture-completed-'))
  expect(completed).toHaveLength(24)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test.describe('starter classroom offline continuity', () => {
  test.use({ serviceWorkers: 'allow' })
  test('cached teaching and short demonstration remain usable when the origin is disconnected', async ({ page, offlineServer, browserName }) => {
    await blockPaid(page)
    await page.goto(`${offlineServer.url}#/course/en`)
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
    })
    await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
    await expect(page.getByRole('heading', { name: starterLessons[0]!.titleZh, exact: true })).toBeVisible()
    await offlineServer.disconnect()
    await expect(fetch(offlineServer.url)).rejects.toThrow()
    // WebKit's synthetic offline switch can fail before its SW dispatch. The
    // actual origin is already stopped; verify the same real disconnected-origin
    // condition used by the existing PWA gate, without injecting cached assets.
    if (browserName !== 'webkit') await page.context().setOffline(true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const capability = await page.evaluate(async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000)
      try {
        const result = await fetch('/jove-english-os/audio/starter/en-starter-1.wav', { signal: controller.signal })
        const bytes = await result.arrayBuffer(), node = document.querySelector('main audio')
        return { status: result.status, bytes: bytes.byteLength, header: new TextDecoder().decode(bytes.slice(0, 4)),
          sourceScheme: node instanceof HTMLAudioElement ? node.src.split(':')[0] : null,
          wavSupport: new Audio().canPlayType('audio/wav'), webAudio: typeof AudioContext !== 'undefined',
          errorCode: node instanceof HTMLAudioElement ? node.error?.code ?? null : null,
          audioErrorVisible: document.body.textContent?.includes('示范暂未播放出来') }
      } catch { return { fetchFailed: true } } finally { clearTimeout(timer) }
    })
    await test.info().attach('offline-audio-native-capability', { body: JSON.stringify(capability), contentType: 'application/json' })
    expect(capability).toMatchObject({ status: 200, bytes: 94390, header: 'RIFF' })
    await teachAndRecognize(page, starterLessons[0]!)
    await page.getByRole('textbox', { name: '试着用刚教的表达回应', exact: true }).fill(starterLessons[0]!.expression.reference)
    await page.getByRole('button', { name: '看看这次表达', exact: true }).click()
    await page.getByRole('button', { name: '保存，结束这个小课', exact: true }).click()
    await expect(page.getByRole('heading', { name: '这次的小目标已经练过。', exact: true })).toBeVisible()
  })
  test('native media-capable WebKit and Chromium decode the cached demonstration with the origin stopped', async ({ page, offlineServer, browserName }) => {
    test.skip(process.platform === 'win32' && browserName === 'webkit', 'Windows WebKit cannot decode Blob media and lacks Web Audio. Native offline playback remains an unmet gate here; Linux media-capable WebKit and iPhone acceptance are required.')
    await page.goto(`${offlineServer.url}#/course/en`)
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
    })
    await page.getByRole('button', { name: '开始或接着上次学 · 约 3–5 分钟', exact: true }).click()
    await expect(page.getByRole('heading', { name: starterLessons[0]!.titleZh, exact: true })).toBeVisible()
    await offlineServer.disconnect()
    await expect(fetch(offlineServer.url)).rejects.toThrow()
    await page.reload()
    const audio = page.getByLabel('英语短句合成示范', { exact: true })
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.readyState)).toBeGreaterThanOrEqual(2)
  })
})
