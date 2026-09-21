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
