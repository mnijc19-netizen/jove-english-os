import { test, expect, records } from './browser-fixtures'
import type { StudyEvent, StudySession } from '../../src/domain/types'

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
  const link=page.getByRole('link',{name:"Open today's listening lesson ↗"})
  await expect(link).toHaveAttribute('href','https://learningenglish.voanews.com/a/lets-learn-english-lesson-one/3111026.html')
  await expect(link).toHaveAttribute('rel','noopener noreferrer')
  await expect(page.locator('iframe, .audio-player')).toHaveCount(0)
  await expect(page.getByRole('button',{name:'Continue to notice an expression'})).toBeDisabled()
  await page.getByRole('checkbox',{name:/I listened and have returned/}).check()
  await page.locator('#external-summary').fill('Two neighbors introduce themselves.')
  await page.getByRole('button',{name:'Continue to notice an expression'}).click()
  await page.locator('#external-expression').fill('Nice to meet you')
  await page.locator('#external-example').fill('Nice to meet you, Sam. I work in design.')
  await page.getByRole('button',{name:'Continue to spoken retell'}).click()
  await expect(page.getByRole('button',{name:'Save practice and continue'})).toBeDisabled()
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
