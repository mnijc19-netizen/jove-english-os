import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
it.each([undefined, '', '0', 'true', 'yes', '01'])('keeps production Japanese off for non-explicit flag %s', async value => {
  vi.stubEnv('DEV', false); vi.stubEnv('VITE_JOVE_JAPANESE', value); vi.resetModules()
  expect(await import('../src/release-flags')).toMatchObject({ japaneseEnabled: false, japaneseDevelopment: false })
})
it('enables the real production workspace only with the explicit build flag, without a preview label', async () => {
  vi.stubEnv('DEV', false); vi.stubEnv('VITE_JOVE_JAPANESE', '1'); vi.resetModules()
  expect(await import('../src/release-flags')).toMatchObject({ japaneseEnabled: true, japaneseDevelopment: false })
})
it('retains the existing local development preview', async () => {
  vi.stubEnv('DEV', true); vi.stubEnv('VITE_JOVE_JAPANESE', undefined); vi.resetModules()
  expect(await import('../src/release-flags')).toMatchObject({ japaneseEnabled: true, japaneseDevelopment: true })
})
it('uses the same release gate for every workspace entry/control surface', () => {
  for (const path of ['src/main.ts', 'src/App.vue', 'src/components/CloudAccount.vue', 'src/pages/Settings.vue']) {
    const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
    expect(source).toMatch(/import \{ japaneseEnabled(?:, japaneseDevelopment)? \} from ["']\.{1,2}\/release-flags["']/u)
    expect(source).not.toContain('import.meta.env.DEV')
  }
})
