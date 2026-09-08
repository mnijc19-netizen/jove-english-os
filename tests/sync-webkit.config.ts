import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: 'sync-webkit-local.spec.ts', workers: 1, retries: 0, timeout: 360000,
  reporter: [['line']], use: { trace: 'off', screenshot: 'off', video: 'off' },
})
