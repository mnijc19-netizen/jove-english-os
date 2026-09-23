import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// Source-module fixtures require the development server. Built production
// routing is covered by japanese-release.spec.ts. No live owner/provider calls.
test.skip(process.env.JOVE_JAPANESE_PREVIEW !== '1', 'Japanese workspace is a local development candidate')
test.use({ serviceWorkers: 'block' })

test('two actual tabs share one English-Japanese audio allowance without overwriting originals', async ({ page, context }) => {
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  const other = await context.newPage()
  await other.goto('#/ja')
  await expect(other.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  await page.evaluate(async () => {
    const path = '/jove-english-os/src/db/db.ts', { db: en, createLanguageDatabase } = await import(/* @vite-ignore */ path)
    const ja = createLanguageDatabase('ja'); await ja.open(); ja.close()
    const setting = await en.settings.get('main')
    // Tiny isolated fixture budget, never the owner's browser/account.
    await en.settings.put({ ...setting, value: { ...setting.value, audioLimitMB: 10 / 1024 / 1024 } })
    await en.audio.put({ id: 'original', blob: new Blob(['keep']), createdAt: 1, duration: 1, kind: 'recording', processed: false, mimeType: 'audio/wav', label: 'Fixture' })
  })
  const writes = await Promise.all([page, other].map((target, index) => target.evaluate(async language => {
    const paths = ['/jove-english-os/src/db/db.ts', '/jove-english-os/src/db/audio.ts']
    const [{ createLanguageDatabase }, { withAudioBudget }] = await Promise.all(paths.map(path => import(/* @vite-ignore */ path)))
    const database = createLanguageDatabase(language)
    try {
      await withAudioBudget(database, async (budget: { assertFits: (bytes: number) => void }) => {
        budget.assertFits(4)
        await database.audio.put({ id: `new-${language}`, blob: new Blob(['next']), createdAt: 2, duration: 1, kind: 'recording', processed: false, mimeType: 'audio/wav', label: 'Fixture' })
      }); return 'saved'
    } catch (error) { return error instanceof Error && error.message.includes('combined audio storage limit') ? 'full' : 'unexpected' }
    finally { database.close() }
  }, index ? 'ja' : 'en')))
  expect(writes.sort()).toEqual(['full', 'saved'])
  const persisted = await page.evaluate(async () => {
    const path = '/jove-english-os/src/db/db.ts', { createLanguageDatabase } = await import(/* @vite-ignore */ path)
    const en = createLanguageDatabase('en'), ja = createLanguageDatabase('ja')
    const rows = (await en.audio.toArray()).concat(await ja.audio.toArray()), original = await (await en.audio.get('original')).blob.text()
    en.close(); ja.close(); return { bytes: rows.reduce((n: number, row: { blob: Blob }) => n + row.blob.size, 0), original }
  })
  expect(persisted).toEqual({ bytes: 8, original: 'keep' })
  await other.close()
})

test('Japanese kana foundation resumes without an IME and keeps unavailable audio as script-only evidence', async ({ page }, testInfo) => {
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  const fixture = await page.evaluate(async () => {
    const paths = ['/jove-english-os/src/db/db.ts', '/jove-english-os/src/db/japanese.ts', '/jove-english-os/src/content/japanese-kana.ts']
    const [{ db: en, createLanguageDatabase }, { createJapaneseWorkspace }, { japaneseKana }] = await Promise.all(paths.map(path => import(/* @vite-ignore */ path)))
    const ja = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(ja, en), unit = japaneseKana[0]
    await learning.open()
    const saved = await learning.reading.start({ id: 'browser-foundation', kind: 'learn', title: unit.title, reason: 'Browser fixture', minutes: 3, materialId: unit.id, done: false })
    ja.close(); return { id: saved.id as string, unit }
  })
  await page.goto(`#/ja/read?session=${encodeURIComponent(fixture.id)}`)
  await expect(page.getByRole('heading', { name: '每次几个字，听过再认。' })).toBeVisible()
  await expect(page.getByRole('link', { name: '打开原站示范' })).toHaveAttribute('href', fixture.unit.kana.sourceUrl)
  await expect(page.getByRole('button', { name: '保存首答，再看解析' })).toBeDisabled()
  await page.getByRole('radio', { name: '现在无法播放，先做字形练习' }).check()
  for (const question of fixture.unit.questions) await page.getByRole('group', { name: question.prompt, exact: false }).getByRole('radio', { name: question.answer, exact: true }).check()
  for (const word of fixture.unit.words) await page.getByRole('group', { name: `${word.text} 对应哪种假名写法？`, exact: true }).getByRole('radio', { name: word.reading, exact: true }).check()
  await expect(page.getByRole('status').filter({ hasText: '首答与笔记已保存在本机' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('radio', { name: '现在无法播放，先做字形练习' })).toBeChecked()
  await page.screenshot({ path: `test-results/ja-kana-${testInfo.project.name}.png`, fullPage: true })
  await page.getByRole('button', { name: '保存首答，再看解析' }).click()
  await expect(page.getByRole('heading', { name: '字形结果不等于发音成绩' })).toBeVisible()
  await expect(page.getByText('本次只做字形练习，之后仍要听原声。', { exact: false })).toBeVisible()
  await page.getByRole('textbox', { name: '换一个情境用一用（也可先用中文记下调整）' }).fill('明天再听 あ／お，今天先分清字形。')
  await page.getByRole('button', { name: '保存基础练习，安排下次回顾' }).click()
  await expect(page.getByRole('heading', { name: '这次基础练习已保存' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '这次基础练习已保存' })).toBeVisible()
  const evidence = await page.evaluate(async id => {
    const path = '/jove-english-os/src/db/db.ts', { db: en, createLanguageDatabase } = await import(/* @vite-ignore */ path)
    const ja = createLanguageDatabase('ja'), saved = await ja.sessions.get(id), events = await ja.events.toArray()
    const check = events.find((event: { type: string }) => event.type === 'JAPANESE_KANA_CHECK')
    const result = { matches: check.data.scriptRecognitionMatches + check.data.kanaMatches, heard: check.data.publisherHeardSelfReport,
      listening: check.data.listeningAssessed, acoustic: check.data.acousticAssessed, due: saved.draft.dueAt - saved.completedAt,
      englishSessions: await en.sessions.count(), overflow: document.documentElement.scrollWidth > innerWidth + 1 }
    ja.close(); return result
  }, fixture.id)
  expect(evidence).toEqual({ matches: 4, heard: false, listening: false, acoustic: false, due: 86400000, englishSessions: 0, overflow: false })
})

test('Japanese original reading locks independent evidence, resumes help and schedules a separate text revisit', async ({ page }, testInfo) => {
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  const sessionId = await page.evaluate(async () => {
    const paths = ['/jove-english-os/src/db/db.ts', '/jove-english-os/src/db/japanese.ts']
    const [{ db: en, createLanguageDatabase }, { createJapaneseWorkspace }] = await Promise.all(paths.map(path => import(/* @vite-ignore */ path)))
    const ja = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(ja, en)
    await learning.open()
    const saved = await learning.reading.start({ id: 'browser-reading', kind: 'learn', title: '早餐留言', reason: 'Browser fixture', minutes: 5, materialId: 'ja-reading-0-1', done: false })
    ja.close(); return saved.id as string
  })
  await page.goto(`#/ja/read?session=${encodeURIComponent(sessionId)}`)
  await expect(page.getByRole('heading', { name: '先读懂，再试着读出来。' })).toBeVisible()
  await page.getByRole('radio', { name: '早餐在哪里', exact: true }).check()
  await page.getByRole('textbox', { name: '牛乳 的假名读法' }).fill('ぎゅうにゅう')
  await expect(page.getByRole('status').filter({ hasText: '首答与笔记已保存在本机' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('radio', { name: '早餐在哪里', exact: true })).toBeChecked()
  await expect(page.getByRole('textbox', { name: '牛乳 的假名读法' })).toHaveValue('ぎゅうにゅう')
  await page.getByRole('button', { name: '需要帮助：展开中文与假名' }).click()
  await expect(page.getByText('借助提示学习很正常；这次不会记录为独立答对。')).toBeVisible()
  await page.reload()
  await expect(page.getByText('借助提示学习很正常；这次不会记录为独立答对。')).toBeVisible()
  await page.getByRole('radio', { name: '七点', exact: true }).check()
  await page.getByRole('textbox', { name: '七時 的假名读法' }).fill('しちじ')
  await page.getByRole('button', { name: '保存首答，再看解析' }).click()
  await expect(page.getByRole('heading', { name: '理解和读法分开看' })).toBeVisible()
  await expect(page.getByText('本篇理解参考匹配 2/2 · 假名参考匹配 2/2（使用过帮助）')).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(0)
  await page.getByRole('textbox', { name: '换一个情境用一用（也可先用中文记下调整）' }).fill('パンはかばんの中です。')
  await expect(page.getByRole('status').filter({ hasText: '首答与笔记已保存在本机' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('textbox')).toHaveValue('パンはかばんの中です。')
  await page.screenshot({ path: `test-results/ja-reading-${testInfo.project.name}.png`, fullPage: true })
  await page.getByRole('button', { name: '保存阅读，安排下次回顾' }).click()
  await expect(page.getByRole('heading', { name: '这次阅读已保存' })).toBeVisible()
  await expect(page.getByRole('link', { name: '打开推荐原版' })).toHaveAttribute('href', 'https://tadoku.org/japanese/book/6447/')
  await page.reload()
  await expect(page.getByRole('heading', { name: '这次阅读已保存' })).toBeVisible()
  const evidence = await page.evaluate(async id => {
    const path = '/jove-english-os/src/db/db.ts', { db: en, createLanguageDatabase } = await import(/* @vite-ignore */ path)
    const ja = createLanguageDatabase('ja'), session = await ja.sessions.get(id), events = await ja.events.toArray()
    const result = { completed: !!session.completedAt, help: session.draft.helped, due: session.draft.dueAt - session.completedAt,
      checks: events.filter((event: { type: string }) => event.type === 'JAPANESE_READING_CHECK').length,
      skillEvidence: events.filter((event: { skill?: string }) => event.skill).length, englishSessions: await en.sessions.count(),
      overflow: document.documentElement.scrollWidth > innerWidth + 1 }
    ja.close(); return result
  }, sessionId)
  expect(evidence).toEqual({ completed: true, help: true, due: 86400000, checks: 1, skillEvidence: 0, englishSessions: 0, overflow: false })
  // The projector's actual incremental conflict merge is covered by the DB
  // regression. Here verify the projected copy is discoverable in the UI.
  await page.evaluate(async id => {
    const path = '/jove-english-os/src/db/db.ts', { createLanguageDatabase } = await import(/* @vite-ignore */ path)
    const ja = createLanguageDatabase('ja'), saved = await ja.sessions.get(id), conflictId = `${id}:fixture-conflict`
    await ja.sessions.put({ ...saved, id: conflictId, kind: 'japanese-reading-conflict', draft: { ...saved.draft, note: '另一台设备尚未提交的笔记。' } })
    await ja.sessions.put({ ...saved, draft: { ...saved.draft, syncReadingConflicts: [conflictId] } }); ja.close()
  }, sessionId)
  await page.reload()
  await expect(page.getByRole('heading', { name: '另一台设备的回答也保留了' })).toBeVisible()
  await page.getByText('查看保留的答案与笔记', { exact: true }).click()
  await expect(page.locator('pre')).toContainText('另一台设备尚未提交的笔记。')
  await expect(page.getByRole('heading', { name: '这次阅读已保存' })).toBeVisible()
})

test('Japanese diagnosis resumes after refresh and leaves English setup untouched', async ({ page }) => {
  await page.goto('#/ja')
  await page.getByRole('radio', { name: 'neko', exact: true }).check()
  await expect(page.getByRole('status').filter({ hasText: '已保存在本机' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('radio', { name: 'neko', exact: true })).toBeChecked()
  for (const option of await page.getByRole('radio', { name: '跳过', exact: true }).all()) await option.check()
  await page.getByRole('button', { name: '保存诊断，安排今天' }).click()
  await expect(page.getByRole('heading', { name: '今日练习：见面与告别' })).toBeVisible()
  await expect(page.getByText('日语当前安排', { exact: false })).toBeVisible()
  await page.getByRole('link', { name: '返回英语', exact: true }).click()
  await expect(page).toHaveURL(/#\/today$/)
  const englishOnboarded = await page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const opening = indexedDB.open('jove-english-os')
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const database = opening.result, read = database.transaction('profiles').objectStore('profiles').get('main')
      read.onsuccess = () => { resolve(read.result.onboarded); database.close() }
    }
  }))
  expect(englishOnboarded).toBe(false)
})

test('Japanese guided practice saves two recordings and restores drafts without English evidence', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Uses the configured Chromium fake microphone, not physical-device proof')
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  for (const option of await page.getByRole('radio', { name: '跳过', exact: true }).all()) await option.check()
  await page.getByRole('button', { name: '保存诊断，安排今天' }).click()
  await page.getByRole('button', { name: /开始学习/ }).click()
  await page.getByRole('checkbox', { name: '我已经实际听过一段原声' }).check()
  await page.getByRole('textbox').fill('早上见到新同事，在打招呼。')
  await page.getByRole('button', { name: '保存并继续' }).click()
  await expect(page.getByText('以下是本站练习例句，不是原站逐字字幕：')).toBeVisible()
  await page.getByRole('textbox', { name: '选一个想用的日语表达' }).fill('おはようございます')
  await page.getByRole('textbox', { name: '换成自己的情况，说或写一句' }).fill('おはようございます。')
  await page.getByRole('link', { name: '保存后回到今日安排' }).click()
  await page.getByRole('link', { name: /继续草稿/ }).click()
  await expect(page.getByRole('textbox', { name: '换成自己的情况，说或写一句' })).toHaveValue('おはようございます。')
  await page.getByRole('button', { name: '保存并继续' }).click()
  await page.getByRole('button', { name: 'Record response', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '1s / 180s' })).toBeVisible()
  await page.getByRole('button', { name: 'Stop & save', exact: true }).click()
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Transcribe/ })).toHaveCount(0)
  await page.getByRole('button', { name: '保存并继续' }).click()
  await expect(page.getByLabel('日语首次回答录音')).toBeVisible()
  await page.getByRole('textbox', { name: '这次准备调整什么？' }).fill('注意长音，完整重说。')
  await page.getByRole('combobox', { name: /这次的难度感觉/ }).selectOption('hard')
  await page.getByRole('combobox', { name: /这次的难度感觉/ }).selectOption({ label: '暂不反馈' })
  await page.getByRole('button', { name: 'Record response', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '1s / 180s' })).toBeVisible()
  await page.getByRole('button', { name: 'Stop & save', exact: true }).click()
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存这次完整练习' }).click()
  await expect(page.getByRole('heading', { name: '这次练习已保存' })).toBeVisible()
  const counts = await page.evaluate(async () => {
    async function count(name: string, table: string) { return new Promise<number>((resolve, reject) => {
      const opening = indexedDB.open(name)
      opening.onerror = () => reject(opening.error)
      opening.onsuccess = () => { const database = opening.result, read = database.transaction(table).objectStore(table).count()
        read.onsuccess = () => { resolve(read.result); database.close() } }
    }) }
    return { jaAudio: await count('jove-english-os-ja', 'audio'), jaCards: await count('jove-english-os-ja', 'cards'),
      enAudio: await count('jove-english-os', 'audio'), enCards: await count('jove-english-os', 'cards') }
  })
  expect(counts).toEqual({ jaAudio: 2, jaCards: 6, enAudio: 0, enCards: 0 })
})

test('Japanese graded continuation and expression-specific reading help work after reload', async ({ page }) => {
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  const fixture = await page.evaluate(async () => {
    const paths = ['/jove-english-os/src/db/db.ts', '/jove-english-os/src/db/japanese.ts', '/jove-english-os/src/domain/japanese.ts', '/jove-english-os/src/content/japanese.ts']
    const [{ db, createLanguageDatabase }, { createJapaneseWorkspace }, { japanesePlacementItems }, { japaneseStarterLessons }] = await Promise.all(paths.map(path => import(path)))
    const database = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(database, db), now = Date.now()
    await learning.open(); await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map((item: { id: string }) => [item.id, '跳过'])), true)
    // Isolated historical fixtures, not learner evidence or publisher playback.
    for (const [index, lesson] of japaneseStarterLessons.entries()) await database.events.put({ id: `fixture:${index}`, type: 'EXTERNAL_LISTEN_REFLECTION', source: 'self-report',
      sessionId: `historical:${index}`, timestamp: now - 3 * 86400000 + index, data: { materialId: lesson.id, response: 'Fixture', expression: 'Fixture', example: 'Fixture', audioId: 'fixture-history',
        listened: true, playbackObserved: false, comprehensionVerified: false } })
    // Only an unstarted fixture plan is removed, so actual planning picks the successor.
    await database.plans.clear()
    const plan = await learning.today(), task = plan.tasks.find((item: { kind: string }) => item.kind === 'listen'), session = await learning.start(task.id)
    await learning.save(session.id, { ...session.draft, listened: true, response: '在介绍现在的工作' }, 'notice')
    const material = await database.materials.get(task.materialId), chunk = await learning.repository.addChunk(material.chunks[0], material.id)
    // Don't let these newly seeded review cards replace the tested bound task.
    for (const card of await database.cards.toArray()) await database.cards.put({ ...card, card: { ...card.card, due: new Date(now + 86400000) } })
    const result = { sessionId: session.id, materialId: task.materialId, chunkId: chunk.id, count: await database.materials.filter((m: { id: string }) => m.id.startsWith('ja-irodori-')).count() }
    database.close(); return result
  })
  expect(fixture.count).toBe(54); expect(fixture.materialId).toBe('ja-irodori-elementary01-1')
  await page.goto('#/ja?session=' + encodeURIComponent(fixture.sessionId)); await page.reload()
  await expect(page.getByRole('heading', { name: '介绍现在的工作' })).toBeVisible()
  await expect(page.getByRole('link', { name: '打开原站真人音频 ↗' })).toHaveAttribute('href', 'https://www.irodori.jpf.go.jp/en/elementary01/audio/lesson01.html')
  const hide = page.getByRole('button', { name: '收起读法', exact: true }), show = page.getByRole('button', { name: '查看假名和拍数', exact: true })
  await hide.click(); await expect(show).toHaveAttribute('aria-expanded', 'false')
  await show.click(); await expect(hide).toHaveAttribute('aria-expanded', 'true')
  await page.evaluate(async chunkId => {
    const path = '/jove-english-os/src/db/db.ts', { createLanguageDatabase } = await import(path)
    const database = createLanguageDatabase('ja')
    for (const [index, delay] of [2 * 86400000, 86400000].entries()) {
      const id = `reading-fixture-${index}`, timestamp = Date.now() - delay
      await database.events.bulkPut([{ id: `${id}:response`, type: 'REVIEW_RESPONSE', source: 'self-report', sessionId: id, chunkId, modality: 'recall', timestamp: timestamp - 1, prompted: false, data: { response: 'ホテルデハタライテイマス。' } },
        { id: `${id}:rating`, type: 'review', source: 'self-report', sessionId: id, chunkId, modality: 'recall', timestamp, prompted: false, data: { responseEventId: `${id}:response`, scheduledRating: 3 } }])
    }
    database.close()
  }, fixture.chunkId)
  await page.reload()
  await expect(show).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText(/这句参考表达已在两次隔天复习中独立写出假名/)).toBeVisible()
  await show.click(); await expect(hide).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('Japanese switching waits for an in-flight stage save rather than displaying the previous session', async ({ page }) => {
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  for (const option of await page.getByRole('radio', { name: '跳过', exact: true }).all()) await option.check()
  await page.getByRole('button', { name: '保存诊断，安排今天' }).click()
  await page.getByRole('button', { name: /开始学习/ }).click()
  await page.getByRole('checkbox', { name: '我已经实际听过一段原声' }).check()
  await page.getByRole('textbox').fill('听到了问候。')
  const origin = page.url()
  await page.evaluate(async () => {
    const path = '/jove-english-os/src/db/db.ts', module = await import(path)
    let prototype = Object.getPrototypeOf(module.db.sessions)
    while (!Object.hasOwn(prototype, 'put')) prototype = Object.getPrototypeOf(prototype)
    const original = prototype.put
    const probe = window as unknown as { releaseJapaneseSave: () => void; japaneseSavePending: boolean }
    prototype.put = function (...args: unknown[]) {
      const result = original.apply(this, args)
      const record = args[0] as { kind?: string; stage?: string }
      if (this.name === 'sessions' && record.kind === 'japanese-practice' && record.stage === 'notice') {
        prototype.put = original
        return result.then((value: unknown) => module.JoveDatabase.waitFor(new Promise(resolve => {
          probe.japaneseSavePending = true
          probe.releaseJapaneseSave = () => resolve(value)
        })))
      }
      return result
    }
  })
  await page.getByRole('button', { name: '保存并继续' }).click()
  await page.waitForFunction(() => (window as unknown as { japaneseSavePending: boolean }).japaneseSavePending)
  await page.getByRole('link', { name: '保存后回到今日安排' }).click()
  await expect(page).toHaveURL(origin)
  await expect(page.getByRole('status').filter({ hasText: '正在保存，请稍后再切换。' })).toBeVisible()
  await page.evaluate(() => (window as unknown as { releaseJapaneseSave: () => void }).releaseJapaneseSave())
  await expect(page.getByText('以下是本站练习例句，不是原站逐字字幕：')).toBeVisible()
  await page.getByRole('link', { name: '保存后回到今日安排' }).click()
  await expect(page.getByRole('heading', { name: '今日练习：见面与告别' })).toBeVisible()
})

test('Japanese Today leads into a persisted due review and returns to the remaining lesson', async ({ page }) => {
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  for (const option of await page.getByRole('radio', { name: '跳过', exact: true }).all()) await option.check()
  await page.getByRole('button', { name: '保存诊断，安排今天' }).click()
  // Isolated browser fixture: one previously learned expression with only its
  // recall modality due. This is not claimed as real owner learning history.
  await page.evaluate(async () => {
    const databasePath = '/jove-english-os/src/db/db.ts', repositoryPath = '/jove-english-os/src/db/repository.ts'
    const { createLanguageDatabase } = await import(databasePath), { createLearningRepository } = await import(repositoryPath)
    const database = createLanguageDatabase('ja'), material = await database.materials.get('ja-irodori-starter-1')
    const chunk = await createLearningRepository(database).addChunk(material.chunks[0], material.id)
    await database.chunks.update(chunk.id, { createdAt: Date.now() - 86400000 })
    for (const card of await database.cards.toArray()) if (card.modality !== 'recall') {
      await database.cards.put({ ...card, card: { ...card.card, due: new Date(Date.now() + 86400000) } })
    }
    database.close()
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: '今日练习：把学过的日语真正想起来' })).toBeVisible()
  await page.getByRole('button', { name: /开始学习/ }).click()
  await expect(page).toHaveURL(/#\/ja\/review\?session=/)
  await page.getByRole('textbox').fill('おはようございます。')
  await page.getByRole('link', { name: '返回日语今日安排' }).click()
  await page.getByRole('link', { name: '日语延迟复习 · 继续草稿' }).click()
  await expect(page.getByRole('textbox')).toHaveValue('おはようございます。')
  await page.getByRole('button', { name: '保存首答，查看参考' }).click()
  await expect(page.getByRole('textbox')).toBeDisabled()
  await page.getByRole('button', { name: '想起来了', exact: true }).click()
  await expect(page.getByRole('heading', { name: '这一小组已保存' })).toBeVisible()
  await page.getByRole('link', { name: '继续今日安排', exact: true }).click()
  await expect(page.getByRole('heading', { name: '今日练习：见面与告别' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('Japanese review keeps the first answer when another device advances the card', async ({ page }) => {
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  const id = await page.evaluate(async () => {
    const paths = ['/jove-english-os/src/db/db.ts', '/jove-english-os/src/db/japanese.ts', '/jove-english-os/src/domain/japanese.ts']
    const [{ db, createLanguageDatabase }, { createJapaneseWorkspace }, { japanesePlacementItems }] = await Promise.all(paths.map(path => import(path)))
    const database = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(database, db)
    await learning.open()
    await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map((item: { id: string }) => [item.id, '跳过'])), true)
    const material = await database.materials.get('ja-irodori-starter-1'), chunk = await learning.repository.addChunk(material.chunks[0], material.id)
    await database.chunks.update(chunk.id, { createdAt: Date.now() - 86400000 })
    for (const card of await database.cards.toArray()) if (card.modality !== 'recall') await database.cards.put({ ...card, card: { ...card.card, due: new Date(Date.now() + 86400000) } })
    const plan = await learning.today(), session = await learning.start(plan.tasks[0].id)
    database.close(); return session.id as string
  })
  await page.goto(`#/ja/review?session=${encodeURIComponent(id)}`)
  await page.getByRole('textbox').fill('首答：おはようございます。')
  await page.getByRole('button', { name: '保存首答，查看参考' }).click()
  await expect(page.getByRole('button', { name: '想起来了', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const paths = ['/jove-english-os/src/db/db.ts', '/jove-english-os/src/db/repository.ts']
    const [{ createLanguageDatabase }, { createLearningRepository }] = await Promise.all(paths.map(path => import(path)))
    const database = createLanguageDatabase('ja'), card = (await database.cards.toArray()).find((card: { modality: string }) => card.modality === 'recall')
    await createLearningRepository(database).reviewCard(card.id, 3, { source: 'self-report' }); database.close()
  })
  await page.getByRole('button', { name: '想起来了', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Review changed on another device')
  await page.getByRole('button', { name: '保留首答，略过已变动卡片' }).click()
  await expect(page.getByRole('heading', { name: '这一小组已保存' })).toBeVisible()
  const saved = await page.evaluate(async id => {
    const path = '/jove-english-os/src/db/db.ts', { createLanguageDatabase } = await import(path), database = createLanguageDatabase('ja')
    const session = await database.sessions.get(id), completed = await database.events.where('type').equals('TASK_COMPLETED').count()
    database.close(); return { item: session.draft.items[0], completed }
  }, id)
  expect(saved.item).toMatchObject({ response: '首答：おはようございます。', skipped: 'schedule-changed' })
  expect(saved.completed).toBe(0)
})

test('Japanese Settings exports isolated backup and restores missing-recording practice on a fresh device', async ({ page, browser }) => {
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  const sessionId = await page.evaluate(async () => {
    const paths = ['/jove-english-os/src/db/db.ts', '/jove-english-os/src/db/japanese.ts', '/jove-english-os/src/domain/japanese.ts']
    const [{ db, createLanguageDatabase }, { createJapaneseWorkspace }, { japanesePlacementItems }] = await Promise.all(paths.map(path => import(path)))
    const database = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(database, db)
    await learning.open(); await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map((item: { id: string }) => [item.id, '跳过'])), true)
    const plan = await learning.today(), session = await learning.start(plan.tasks[0].id)
    await database.audio.bulkPut(['first', 'retry'].map(id => ({ id, blob: new Blob(['fixture-recording']), mimeType: 'audio/wav', createdAt: Date.now(), duration: 1, kind: 'recording', processed: false, label: 'Fixture' })))
    await learning.save(session.id, { ...session.draft, listened: true, response: '见到同事打招呼', expression: 'おはようございます', example: 'おはようございます。', audioId: 'first', retryAudioId: 'retry', comparison: '保留对照笔记' }, 'compare')
    database.close(); return session.id
  })
  await page.goto('#/settings')
  await page.getByLabel('备份、恢复及清理缓存的语言').selectOption('ja')
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export backup', exact: true }).click()
  const downloaded = await downloading, bytes = await readFile((await downloaded.path())!)
  expect(downloaded.suggestedFilename()).toContain('jove-japanese-backup')
  expect(JSON.parse(bytes.toString())).toMatchObject({ schemaVersion: 3, learningLanguage: 'ja' })
  expect(bytes.toString()).not.toContain('fixture-recording')
  await page.getByLabel('备份、恢复及清理缓存的语言').selectOption('en')
  await page.locator('#restore-file').setInputFiles({ name: 'ja.json', mimeType: 'application/json', buffer: bytes })
  await page.getByRole('button', { name: 'Validate & merge backup', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('another learning language')

  const device = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL, serviceWorkers: 'block', permissions: ['microphone'],
    viewport: test.info().project.use.viewport, isMobile: test.info().project.use.isMobile, hasTouch: test.info().project.use.hasTouch })
  try {
    const target = await device.newPage()
    await target.goto('#/ja')
    await expect(target.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
    await target.goto('#/settings')
    await target.getByLabel('备份、恢复及清理缓存的语言').selectOption('ja')
    await target.locator('#restore-file').setInputFiles({ name: 'ja.json', mimeType: 'application/json', buffer: bytes })
    await target.getByRole('button', { name: 'Validate & merge backup', exact: true }).click()
    await expect(target.getByRole('status').filter({ hasText: 'Backup merged with retained learning history' })).toBeVisible()
    await target.goto('#/ja?session=' + encodeURIComponent(sessionId))
    await expect(target.getByText('这个备份不含部分录音文件', { exact: false })).toBeVisible()
    await expect(target.getByText('3 / 4 · 换个情境说', { exact: true })).toBeVisible()
    await target.getByRole('button', { name: 'Record response', exact: true }).click()
    await expect(target.getByRole('status').filter({ hasText: '1s / 180s' })).toBeVisible()
    await target.getByRole('button', { name: 'Stop & save', exact: true }).click()
    await expect(target.getByText('Saved on this device', { exact: true })).toBeVisible()
    await target.getByRole('button', { name: '保存并继续' }).click()
    await expect(target.getByLabel('这次准备调整什么？')).toHaveValue('保留对照笔记')
    expect(await target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally { await device.close() }
})

test('Japanese three-turn dialogue resumes a failed reply, retains turns and finishes with a real recorded retry', async ({ page }) => {
  let calls = 0
  let releaseCancelledReply: (() => void) | undefined
  const feedback = { summary: '三轮都回应了问题，先调整助词。', strengths: ['回应对方'], errors: [{ category: 'grammar', original: '私学生', corrected: '私は学生です。', hint: '主题后面少了什么？', explanation: '这里用は标记话题。' }],
    comprehension: null, accuracy: 0.6, fluency: null, successfulChunks: [], nextPrompt: '换成另一种身份，完整重说。' }
  await page.route('https://openrouter.ai/api/v1/**', async route => {
    const request = route.request()
    if (request.url().includes('/models?')) return route.fulfill({ json: { data: [{ id: 'fixture/japanese-talk', name: 'Fixture',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs'] }] } })
    calls++
    const body = request.postDataJSON()
    expect(body.messages[0].content).toContain('Japanese learning tutor for a native Chinese speaker')
    if (calls === 1) return route.fulfill({ status: 401, json: { error: { message: 'Fixture authentication failure' } } })
    if (calls === 3) { await new Promise<void>(resolve => { releaseCancelledReply = resolve }); return route.abort().catch(() => {}) }
    return route.fulfill({ json: { model: 'fixture/japanese-talk', choices: [{ finish_reason: 'stop', message: { content: body.response_format ? JSON.stringify(feedback) : 'そうですか。もう少し教えてください。' } }], usage: { total_tokens: 40, cost: 0.001 } } })
  })
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  const id = await page.evaluate(async () => {
    const paths = ['/jove-english-os/src/db/db.ts', '/jove-english-os/src/db/japanese.ts', '/jove-english-os/src/domain/japanese.ts']
    const [{ db, createLanguageDatabase }, { createJapaneseWorkspace }, { japanesePlacementItems }] = await Promise.all(paths.map(path => import(path)))
    await db.secrets.bulkPut([{ id: 'openrouter', value: 'fixture-only-browser-key' }, { id: 'provider-mode', value: 'byok' }])
    const settings = await db.settings.get('main'); settings.value.fastModel = 'fixture/japanese-talk'; settings.value.strongModel = 'fixture/japanese-talk'; await db.settings.put(settings)
    const database = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(database, db)
    await learning.open(); await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map((item: { id: string }) => [item.id, '跳过'])), true)
    const task = { id: 'fixture:ja:dialogue', kind: 'speak', title: '三轮情境对话', minutes: 5, reason: 'Fixture', materialId: 'ja-irodori-starter-3', done: false }
    const date = new Date().toLocaleDateString('en-CA')
    await database.plans.put({ id: date, date, minutes: 5, focus: 'realWorld', tasks: [task], createdAt: Date.now() })
    const session = await learning.dialogue.start(task); database.close(); return session.id
  })
  await page.goto('#/ja/talk?session=' + encodeURIComponent(id)); await page.reload()
  const input = page.getByRole('textbox', { name: '本轮日语回答', exact: true })
  const checked = page.getByRole('checkbox', { name: /已核对本轮文字/ })
  await page.getByRole('button', { name: 'Record response', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '1s / 180s' })).toBeVisible()
  await page.getByRole('button', { name: 'Stop & save', exact: true }).click()
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible()
  await input.fill('私学生です。'); await checked.check()
  await page.getByRole('button', { name: '发送并继续交流（AI，可能收费）' }).click()
  await expect(page.getByRole('alert')).toContainText('不会自动重试')
  await expect(page.getByText('私学生です。', { exact: true })).toBeVisible()
  await expect(page.getByLabel('日语第1轮录音')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '恢复／重试 AI 回复（可能再次收费）' })).toBeVisible(); expect(calls).toBe(1)
  await page.getByRole('button', { name: '恢复／重试 AI 回复（可能再次收费）' }).click()
  await expect(input).toBeVisible()
  await input.fill('日本語を勉強しています。'); await checked.check()
  await page.getByRole('button', { name: '发送并继续交流（AI，可能收费）' }).click()
  await expect.poll(() => Boolean(releaseCancelledReply)).toBe(true)
  await page.getByRole('button', { name: '停止等待，保留回答', exact: true }).click()
  await page.getByRole('button', { name: '用离线应答继续', exact: true }).click()
  releaseCancelledReply!()
  await expect(page.getByText('离线固定应答提示 · 不是 AI 回复')).toBeVisible()
  expect(calls).toBe(3)
  await input.fill('あなたは何を勉強していますか。'); await checked.check()
  await page.getByRole('button', { name: '发送并继续交流（AI，可能收费）' }).click()
  await expect(page.getByRole('heading', { name: '现在只改一处，然后完整重说' })).toBeVisible()
  await page.getByRole('button', { name: '请 AI 总结三轮表达（可能收费）' }).click()
  const feedbackHelp = page.getByRole('button', { name: '查看 AI 提示与参考表达', exact: true })
  await expect(feedbackHelp).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('主题后面少了什么？', { exact: true })).toHaveCount(0)
  await expect(page.getByText('私は学生です。', { exact: true })).toHaveCount(0)
  await feedbackHelp.click()
  await expect(page.getByText('私は学生です。', { exact: true })).toBeVisible()
  const used = calls
  await page.reload()
  await expect(feedbackHelp).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('三轮都回应了问题，先调整助词。')).toHaveCount(0)
  expect(calls).toBe(used)
  await page.screenshot({ path: `test-results/ja-dialogue-${test.info().project.name}.png`, fullPage: true })
  await page.getByRole('textbox', { name: '准备调整的一处表达' }).fill('加上主题助词，换成朋友的身份介绍。')
  await page.getByRole('button', { name: 'Record response', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '1s / 180s' })).toBeVisible()
  await page.getByRole('button', { name: 'Stop & save', exact: true }).click()
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存三轮对话与完整重说' }).click()
  await expect(page.getByRole('heading', { name: '三轮练习和重说已保存' })).toBeVisible()
  await page.reload(); await expect(page.getByRole('heading', { name: '三轮练习和重说已保存' })).toBeVisible()
  const result = await page.evaluate(async () => {
    const path = '/jove-english-os/src/db/db.ts', { db, createLanguageDatabase } = await import(path), database = createLanguageDatabase('ja')
    const result = { englishSessions: await db.sessions.count(), japaneseAudio: await database.audio.count(),
      abilityEvidence: (await database.skills.toArray()).reduce((sum: number, skill: { evidenceCount: number }) => sum + skill.evidenceCount, 0) }
    database.close(); return result
  })
  expect(result).toEqual({ englishSessions: 0, japaneseAudio: 2, abilityEvidence: 0 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('Japanese AI feedback retains checked input through failure, reveals help on request and reloads without another charge', async ({ page }) => {
  let calls = 0
  const evaluation = { summary: '意思清楚，先改主题助词。', strengths: ['表达身份'], errors: [{ category: 'grammar', original: '私学生です', corrected: '私は学生です。', hint: '想想用哪个助词标记话题。', explanation: 'は标记这里的话题。' }],
    comprehension: null, accuracy: 0.5, fluency: null, successfulChunks: [], nextPrompt: '换成朋友的身份，完整重说一次。' }
  await page.route('https://openrouter.ai/api/v1/**', async route => {
    const request = route.request()
    if (request.url().includes('/models?')) return route.fulfill({ json: { data: [{ id: 'fixture/japanese', name: 'Fixture',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs'] }] } })
    calls++
    expect(request.postDataJSON().messages[0].content).toContain('Japanese learning tutor for a native Chinese speaker')
    if (calls === 1) return route.fulfill({ status: 401, json: { error: { message: 'Fixture authentication failure' } } })
    return route.fulfill({ json: { model: 'fixture/japanese', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(evaluation) } }], usage: { total_tokens: 30, cost: 0.001 } } })
  })
  await page.goto('#/ja')
  await expect(page.getByRole('radio', { name: '跳过', exact: true })).toHaveCount(6)
  const sessionId = await page.evaluate(async () => {
    const paths = ['/jove-english-os/src/db/db.ts', '/jove-english-os/src/db/japanese.ts', '/jove-english-os/src/domain/japanese.ts']
    const [{ db, createLanguageDatabase }, { createJapaneseWorkspace }, { japanesePlacementItems }] = await Promise.all(paths.map(path => import(path)))
    await db.secrets.bulkPut([{ id: 'openrouter', value: 'fixture-only-browser-key' }, { id: 'provider-mode', value: 'byok' }])
    const settings = await db.settings.get('main'); settings.value.fastModel = 'fixture/japanese'; settings.value.strongModel = 'fixture/japanese'; await db.settings.put(settings)
    const database = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(database, db)
    await learning.open(); await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map((item: { id: string }) => [item.id, '跳过'])), true)
    const plan = await learning.today(), session = await learning.start(plan.tasks[0].id)
    await database.audio.put({ id: 'first', blob: new Blob(['fixture-only-audio']), mimeType: 'audio/wav', createdAt: Date.now(), duration: 1, kind: 'recording', processed: false, label: 'Fixture' })
    await learning.save(session.id, { ...session.draft, listened: true, response: '问候', expression: 'おはよう', example: 'おはようございます。', audioId: 'first' }, 'compare')
    database.close(); return session.id
  })
  await page.goto('#/ja?session=' + encodeURIComponent(sessionId)); await page.reload()
  const answer = page.getByRole('textbox', { name: '写下自己刚才说的日语，或核对转写后修改' })
  await answer.fill('私学生です')
  await page.getByRole('checkbox', { name: /我核对过这段文字/ }).check()
  await page.getByRole('button', { name: '请 AI 帮我改进（可能收费）' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'AI 或保存暂未完成' })).toBeVisible()
  await expect(answer).toHaveValue('私学生です')
  await page.reload()
  await expect(answer).toHaveValue('私学生です')
  await page.getByRole('button', { name: '请 AI 帮我改进（可能收费）' }).click()
  const help = page.getByRole('button', { name: '查看 AI 提示与参考表达', exact: true })
  await expect(help).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText(evaluation.summary, { exact: true })).toHaveCount(0)
  await expect(page.getByText(evaluation.errors[0]!.hint, { exact: true })).toHaveCount(0)
  await expect(page.getByText('私は学生です。', { exact: true })).toHaveCount(0)
  await help.click()
  await expect(page.getByText('私は学生です。', { exact: true })).toBeVisible()
  await page.reload()
  await expect(help).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('私は学生です。', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '查看已保存的反馈' }).click()
  await expect(page.getByRole('button', { name: '查看已保存的反馈' })).toBeEnabled()
  expect(calls).toBe(2)
  expect(await page.evaluate(async () => {
    const path = '/jove-english-os/src/db/db.ts', { db, createLanguageDatabase } = await import(path), ja = createLanguageDatabase('ja')
    const result = { enUsage: await db.usage.count(), jaUsage: await ja.usage.count(), aiEvidence: await ja.events.filter((event: { source: string }) => event.source === 'ai').count() }
    ja.close(); return result
  })).toEqual({ enUsage: 0, jaUsage: 2, aiEvidence: 0 })
  await page.locator('.ja-coach').scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('japanese-coach.png') })
  await page.evaluate(async id => {
    const path = '/jove-english-os/src/db/db.ts', { createLanguageDatabase } = await import(path), ja = createLanguageDatabase('ja')
    const coach = await ja.sessions.get(`ja-coach:${id}`)
    coach.draft.text = '另一设备保存的回答'; coach.draft.revision++; await ja.sessions.put(coach); ja.close()
  }, sessionId)
  await page.getByRole('button', { name: '查看已保存的反馈' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '没有提交另一份回答' })).toBeVisible()
  expect(calls).toBe(2)
  await expect(answer).toHaveValue('私学生です')
  await page.evaluate(async id => {
    const path = '/jove-english-os/src/db/db.ts', { createLanguageDatabase, JoveDatabase } = await import(path), ja = createLanguageDatabase('ja')
    let prototype = Object.getPrototypeOf(ja.sessions)
    while (!Object.hasOwn(prototype, 'get')) prototype = Object.getPrototypeOf(prototype)
    const original = prototype.get
    prototype.get = function (...args: unknown[]) {
      const result = original.apply(this, args)
      if (this.name === 'sessions' && args[0] === `ja-coach:${id}`) {
        prototype.get = original
        return result.then((value: unknown) => JoveDatabase.waitFor(new Promise(resolve => {
          (window as unknown as { releaseCoachReload: () => void }).releaseCoachReload = () => resolve(value)
        })))
      }
      return result
    }
    ja.close()
  }, sessionId)
  await page.getByRole('button', { name: '重新载入已保存的辅导（保留本页文字副本）' }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseCoachReload?: () => void }).releaseCoachReload)).toBe('function')
  await page.getByRole('button', { name: '停止等待，保留回答' }).click()
  await answer.fill('取消等待后继续写的新回答')
  await page.evaluate(() => (window as unknown as { releaseCoachReload: () => void }).releaseCoachReload())
  await expect(page.getByRole('alert').filter({ hasText: '没有覆盖旧记录' })).toBeVisible()
  await expect(answer).toHaveValue('取消等待后继续写的新回答')
  await page.getByRole('button', { name: '重新载入已保存的辅导（保留本页文字副本）' }).click()
  await expect(answer).toHaveValue('另一设备保存的回答')
  await expect(page.getByText('重新载入前的本页文字副本', { exact: true })).toBeVisible()
})
