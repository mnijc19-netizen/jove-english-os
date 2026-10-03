import { type Page } from '@playwright/test'
import { test, expect, records } from './browser-fixtures'
import { starterLessons, type StarterLesson } from '../../src/content/starter-courses'

// Fresh synthetic learners, real built UI/IndexedDB/audio decoding. Not a human
// efficacy, native pronunciation or paid provider accuracy assessment.
test.use({ serviceWorkers: 'block' })
async function blockPaid(page: Page) {
  const calls: string[] = []
  await page.route('https://openrouter.ai/**', route => { calls.push(route.request().url()); return route.abort() })
  await page.route('**/functions/v1/ai', route => { calls.push(route.request().postData() ?? ''); return route.abort() })
  return calls
}
async function seed(page: Page, language: 'en' | 'ja', lesson: StarterLesson) {
  await page.evaluate(async ({ language, prerequisites }) => {
    const read = indexedDB.open(language === 'ja' ? 'jove-english-os-ja' : 'jove-english-os')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('sessions', 'readwrite')
      for (const id of prerequisites) tx.objectStore('sessions').put({ id: `fixture-completed-${id}`, kind: 'starter-classroom', materialId: id,
        startedAt: Date.now() - 3000, completedAt: Date.now() - 1000, stage: 'done', draft: { purpose: 'lesson' } })
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    }); database.close()
  }, { language, prerequisites: lesson.prerequisites })
}
async function teachAndRecognize(page: Page, lesson: StarterLesson) {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(lesson.titleZh)
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

for (const lesson of starterLessons) test(`complete ${lesson.id} with no AI; transfer hides the answer until help or first submission`, async ({ page }) => {
  test.skip(lesson.language === 'ja' && process.env.VITE_JOVE_JAPANESE !== '1', 'Japanese production build gate is off')
  const calls = await blockPaid(page)
  await page.goto(`#/course/${lesson.language}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('从能用的一句话开始。')
  await seed(page, lesson.language, lesson)
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
