import { test } from '@playwright/test'
import { registerSyncBrowserJourneys } from './sync-browser-journey'

// Same assertions as Vitest; run natively in Linux so WebKit uses a disposable
// regular profile. Remote browser.newContext() is private and cannot store Blob.
registerSyncBrowserJourneys({
  describe: (name, enabled, body) => (enabled ? test.describe : test.describe.skip)(name, body),
  beforeAll: body => test.beforeAll(body), afterAll: body => test.afterAll(body),
  it: (name, body, timeout) => test(name, async () => { test.setTimeout(timeout ?? 360000); await body() }),
})
