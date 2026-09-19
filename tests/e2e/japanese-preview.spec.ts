import { test, expect } from '@playwright/test'

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
