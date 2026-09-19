import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// Explicit development-only acceptance; production intentionally has no /ja
// route until sync/review/AI integration is ready. No live owner/provider calls.
test.skip(process.env.JOVE_JAPANESE_PREVIEW !== '1', 'Japanese workspace is a local development candidate')
test.use({ serviceWorkers: 'block' })

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

test('Japanese AI feedback retains checked input through failure, shows a hint first and reloads without another charge', async ({ page }) => {
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
  await expect(page.getByText('先试着改一处：想想用哪个助词标记话题。', { exact: true })).toBeVisible()
  await expect(page.getByText('私は学生です。', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '想过后，查看示例与解释' }).click()
  await expect(page.getByText('私は学生です。', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('先试着改一处：想想用哪个助词标记话题。', { exact: true })).toBeVisible()
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
