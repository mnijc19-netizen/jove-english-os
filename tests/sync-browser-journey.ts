import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { chromium, firefox, webkit, expect as browserExpect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { verifyNativeAudioJournal } from './native-audio-journal'

// Real local browser/Auth/PostgREST/Storage only. No trace, screenshot, session
// export or console capture: test keys and OTPs exist exclusively in memory.
const enabled = process.env.JOVE_LOCAL_BROWSER_TEST === '1'
const expect = browserExpect
const api = 'http://127.0.0.1:55321', appOrigin = 'http://127.0.0.1:55173', appURL = appOrigin + '/jove-english-os/'
// Windows uses the separate native-Linux WebKit entry point below; its bundled
// WebKit Blob/offline emulation is not a substitute for a regular Linux profile.
const engines = (process.env.JOVE_SYNC_BROWSERS ?? (process.platform === 'win32' ? 'chromium,firefox' : 'chromium,firefox,webkit')).split(',')
const failures: { path: string; status: number }[] = []
const transportFailures: { service: string; kind: string }[] = []
const localFetch: typeof fetch = (input, init) => {
  if (new URL(input instanceof Request ? input.url : String(input)).origin !== api) throw new Error('Non-Jove backend refused')
  return fetch(input, init)
}

export interface JourneyHooks {
  describe: (name: string, enabled: boolean, body: () => void) => void
  beforeAll: (body: () => Promise<void>, timeout?: number) => void
  afterAll: (body: () => Promise<void>) => void
  it: (name: string, body: () => Promise<void>, timeout?: number) => void
}
export function registerSyncBrowserJourneys({ describe, beforeAll, afterAll, it }: JourneyHooks) {
describe('dedicated local browser account/reset/offline sync journeys', enabled, () => {
  let admin: SupabaseClient, server: ChildProcess, ready = false
  let remoteEndpoint = '', browserContainer = ''
  const owners: string[] = [], objects: string[] = []
  const partitioned = new Set<BrowserContext>(), webkitContexts = new Set<BrowserContext>()
  const lastCodeRequest = new Map<string, number>()
  beforeAll(async () => {
    let config: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string }
    try {
      const raw = process.env.JOVE_LOCAL_BROWSER_CONFIG ?? execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'npx', process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npx supabase status --output json'] : ['supabase', 'status', '--output', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      config = JSON.parse(raw)
    } catch { throw new Error('Could not read local browser fixture configuration') }
    if (config.API_URL !== api && config.API_URL !== api + '/') throw new Error('Non-Jove backend refused')
    admin = createClient(api, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: localFetch } })
    // Public client configuration is injected into the dev server's memory, never
    // written into a build, env file or command-line argument.
    if (process.env.JOVE_LOCAL_BROWSER_EXTERNAL_APP !== '1') server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '55173', '--strictPort'], {
      windowsHide: true, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: api, VITE_SUPABASE_PUBLISHABLE_KEY: config.ANON_KEY },
    })
    let failed = false
    server?.on('error', () => { failed = true })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failed || (server && server.exitCode !== null)) throw new Error('Isolated browser dev server could not start')
      try { if ((await fetch(appURL, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break } } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (!ready) throw new Error('Isolated browser dev server did not become ready')
    if (process.platform === 'win32' && engines.some(engine => ['firefox', 'webkit'].includes(engine))) {
      // Reuse the already installed image, never change another worker's container
      // or global browser installation. The control endpoint binds loopback only.
      browserContainer = 'jove-sync-browsers-' + crypto.randomUUID()
      const path = crypto.randomUUID()
      execFileSync('docker', ['run', '--detach', '--rm', '--name', browserContainer, '--publish', '127.0.0.1:55174:55174',
        '--volume', resolve('.') + ':/app:ro', '--workdir', '/app', 'mcr.microsoft.com/playwright:v1.63.0-noble',
        'node', 'node_modules/playwright/cli.js', 'run-server', '--host', '0.0.0.0', '--port', '55174', '--path', '/' + path],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      remoteEndpoint = 'ws://127.0.0.1:55174/' + path
      for (let retry = 0; retry < 100; retry++) {
        try { if ((await fetch('http://127.0.0.1:55174', { signal: AbortSignal.timeout(500) })).ok) break } catch { /* startup */ }
        if (retry === 99) throw new Error('Isolated browser control server did not become ready')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }, 45000)
  afterAll(async () => {
    server?.kill()
    if (objects.length) await admin?.storage.from('jove-recordings').remove(objects)
    for (const owner of owners) await admin.auth.admin.deleteUser(owner)
    if (browserContainer) execFileSync('docker', ['stop', browserContainer], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  })
  async function provision() {
    const email = 'jove-browser-' + crypto.randomUUID() + '@example.invalid'
    const created = await admin.auth.admin.createUser({ email, email_confirm: true })
    if (created.error || !created.data.user) throw new Error('Local browser fixture provisioning failed')
    const owner = created.data.user.id; owners.push(owner)
    if ((await admin.from('app_members').insert({ user_id: owner })).error) throw new Error('Local browser membership provisioning failed')
    return { owner, email }
  }
  async function prepare(context: BrowserContext): Promise<Page> {
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (partitioned.has(context) && ['http:', 'https:'].includes(url.protocol)) return route.abort('internetdisconnected')
      return [api, appOrigin].includes(url.origin) || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort()
    })
    const page = await context.newPage()
    page.on('response', response => { if (response.status() >= 400) failures.push({ path: new URL(response.url()).pathname, status: response.status() }) })
    page.on('requestfailed', request => {
      if (partitioned.has(context)) return // Expected deliberate network partition.
      const path = new URL(request.url()).pathname, detail = request.failure()?.errorText ?? ''
      const service = path.startsWith('/storage/') ? 'storage' : path.startsWith('/auth/') ? 'auth'
        : path.startsWith('/rest/') ? 'database' : path.startsWith('/functions/') ? 'functions' : 'app'
      const kind = /file.*(?:missing|not found)|not.*read.*file/i.test(detail) ? 'file-unavailable'
        : /cancel|abort/i.test(detail) ? 'cancelled' : /disconnect|offline/i.test(detail) ? 'disconnected'
          : /access|permission|denied/i.test(detail) ? 'denied' : 'other'
      // Never retain raw errors, URLs, signed queries, headers or request bodies.
      if (transportFailures.length < 20) transportFailures.push({ service, kind })
    })
    await page.goto(appURL + '#/settings')
    await page.waitForFunction(async () => {
      const path = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(path)
      return !!await db.profiles.get('main')
    })
    await page.evaluate(async () => {
      const path = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(path)
      await db.profiles.update('main', { onboarded: true })
    })
    await page.reload()
    await browserExpect(page.getByLabel('Your email', { exact: true })).toBeVisible()
    return page
  }
  async function setDisconnected(context: BrowserContext, offline: boolean) {
    if (!webkitContexts.has(context)) return context.setOffline(offline)
    // Playwright WebKit setOffline(true) makes even a fresh, non-IDB Blob's
    // arrayBuffer() fail with NotReadableError. Partition real HTTP instead;
    // do not mock a successful response or alter Blob/IndexedDB implementations.
    if (offline) partitioned.add(context); else partitioned.delete(context)
    for (const page of context.pages()) await page.evaluate(offline => window.dispatchEvent(new Event(offline ? 'offline' : 'online')), offline)
    if (offline) for (const page of context.pages()) expect(await page.evaluate(async api => {
      try { await fetch(api + '/auth/v1/health'); return false } catch { return true }
    }, api)).toBe(true)
  }
  async function signIn(page: Page, email: string) {
    // Respect the actual Auth resend cooldown; never lower server rate limits.
    const remaining = 65000 - (Date.now() - (lastCodeRequest.get(email) ?? 0))
    if (remaining > 0) await page.waitForTimeout(remaining)
    await page.getByLabel('Your email', { exact: true }).fill(email)
    lastCodeRequest.set(email, Date.now())
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/v1/otp' && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Send sign-in code', exact: true }).click()
    const sent = await delivered
    if (!sent.ok()) {
      const body = await sent.json().catch(() => ({})), value = String(body.error_code ?? body.code ?? '')
      const code = /^[a-z_]{1,80}$/.test(value) ? value : 'unavailable'
      throw new Error('Local Auth code request denied: ' + sent.status() + ' ' + code)
    }
    await browserExpect(page.getByLabel('Email sign-in code', { exact: true })).toBeVisible()
    let code = ''
    // Read only mail addressed to this test's random owner. The real delivered
    // SMTP code stays in memory; no admin-issued substitute or captured trace.
    for (let retry = 0; retry < 30 && !code; retry++) {
      const mailbox = await fetch('http://127.0.0.1:55324/api/v1/search?query=' + encodeURIComponent('to:' + email)).then(response => response.json())
      for (const message of mailbox.messages ?? []) {
        if (new Date(message.Created).getTime() < lastCodeRequest.get(email)! - 1000) continue
        const mail = await fetch('http://127.0.0.1:55324/api/v1/message/' + encodeURIComponent(message.ID)).then(response => response.json())
        code = String(mail.Text || mail.HTML).match(/\b(\d{6})\b/)?.[1] ?? ''
        if (code) break
      }
      if (!code) await page.waitForTimeout(200)
    }
    if (!code) throw new Error('Local SMTP fixture did not deliver a sign-in code')
    try { await page.getByLabel('Email sign-in code', { exact: true }).fill(code) }
    catch { throw new Error('Local browser code entry failed') }
    finally { code = '' }
    await page.getByRole('button', { name: 'Sign in & continue', exact: true }).click()
  }
  async function sync(page: Page) {
    await page.evaluate(async () => { const path = '/jove-english-os/src/stores/cloud.ts'; await (await new Function('path', 'return import(path)')(path)).useCloud().syncNow() })
    await browserExpect.poll(() => page.evaluate(async () => {
      const path = '/jove-english-os/src/stores/cloud.ts'
      return (await new Function('path', 'return import(path)')(path)).useCloud().status
    }), { timeout: 30000 }).toBe('Synced')
  }
  async function reviewJourney(a: Page, b: Page, owner: string) {
    const fixture = await a.evaluate(async () => {
      const nativeImport = new Function('path', 'return import(path)')
      const { db } = await nativeImport('/jove-english-os/src/db/db.ts')
      const { addChunk } = await nativeImport('/jove-english-os/src/db/repository.ts')
      const source = await db.materials.toCollection().first()
      if (!source) throw new Error('Missing seeded local source material')
      const chunk = await addChunk({ text: 'We can recover this attempt', meaningEn: 'Continue from saved work', meaningZh: '', example: 'We can recover this attempt.' }, source.id)
      const card = (await db.cards.where('chunkId').equals(chunk.id).toArray()).find((row: { modality: string }) => row.modality === 'recall')
      const blockId = 'review-block:browser-legacy-review:all', draftId = `review-draft:${card.id}:0`
      await db.sessions.put({ id: blockId, kind: 'review-block', stage: 'selection', startedAt: Date.now(),
        draft: { taskId: 'browser-legacy-review', items: [{ cardId: card.id, reps: 0 }] } })
      await db.sessions.put({ id: draftId, kind: 'review', stage: 'checked', startedAt: Date.now(), draft: { response: chunk.text, revealed: true } })
      return { cardId: card.id, chunkId: chunk.id, text: chunk.text, legacyId: `review:${card.id}:1`, draftId }
    })
    await sync(a); await sync(b)
    await Promise.all([a, b].map(page => setDisconnected(page.context(), true)))
    // Genuine old counter collision: independent repository writes on two
    // offline profiles, not fabricated successful scheduler mocks.
    for (const [index, page] of [a, b].entries()) await page.evaluate(async ({ fixture, index }) => {
      const path = '/jove-english-os/src/db/repository.ts'
      await (await new Function('path', 'return import(path)')(path)).reviewCard(fixture.cardId, index ? 1 : 3,
        { eventId: fixture.legacyId, expectedReps: 0 })
    }, { fixture, index })
    await Promise.all([a, b].map(page => setDisconnected(page.context(), false)))
    await sync(a); await sync(b); await sync(a)
    await b.goto(appURL + '#/review?task=browser-legacy-review')
    await browserExpect(b.getByText('1 revisited this session', { exact: true })).toBeVisible()
    await browserExpect(b.getByText('Your saved selection is waiting for card history.', { exact: true })).toHaveCount(0)
    const legacy = await b.evaluate(async fixture => {
      const path = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(path)
      return { aliases: (await db.syncMeta.get('eventAliases'))?.value[fixture.legacyId],
        original: !!await db.events.get(fixture.legacyId), draft: (await db.sessions.get(fixture.draftId))?.draft.response }
    }, fixture)
    expect(legacy.aliases).toHaveLength(2); expect(legacy.original).toBe(false); expect(legacy.draft).toBe(fixture.text)
    const selected = await a.evaluate(async fixture => {
      const nativeImport = new Function('path', 'return import(path)'), { db } = await nativeImport('/jove-english-os/src/db/db.ts')
      const { reviewAttempt } = await nativeImport('/jove-english-os/src/sync/review.ts')
      const card = (await db.cards.where('chunkId').equals(fixture.chunkId).toArray()).find((row: { modality: string }) => row.modality === 'recall')
      const item = reviewAttempt(card.id, card.card.reps)
      await db.sessions.put({ id: 'review-block:browser-uuid-review:all', kind: 'review-block', stage: 'selection', startedAt: Date.now(),
        draft: { taskId: 'browser-uuid-review', items: [item] } })
      await db.sessions.put({ id: item.draftId, kind: 'review', stage: 'checked', startedAt: Date.now(), draft: { response: fixture.text, revealed: true } })
      return item
    }, fixture)
    await sync(a); await sync(b)
    await a.goto(appURL + '#/review?task=browser-uuid-review')
    await browserExpect(a.locator('#review-answer')).toHaveValue(fixture.text)
    await b.evaluate(async selected => {
      const path = '/jove-english-os/src/db/repository.ts'
      await (await new Function('path', 'return import(path)')(path)).reviewCard(selected.cardId, 3, { expectedReps: selected.reps })
    }, selected)
    await sync(b); await sync(a)
    await browserExpect(a.locator('#review-answer')).toHaveValue(fixture.text)
    await a.getByRole('button', { name: 'Good Independent', exact: true }).click()
    await browserExpect(a.getByText('1 revisited this session', { exact: true })).toBeVisible()
    await sync(a); await sync(b)
    await b.goto(appURL + '#/review?task=browser-uuid-review'); await b.reload()
    await browserExpect(b.getByText('1 revisited this session', { exact: true })).toBeVisible()
    const recovered = await b.evaluate(async selected => {
      const path = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(path)
      const review = await db.events.get(selected.attemptId), response = await db.events.get(selected.responseEventId)
      return { attemptId: review?.data.attemptId, previousReps: review?.data.previousReps, responseSession: response?.sessionId,
        draft: (await db.sessions.get(selected.draftId))?.draft.response }
    }, selected)
    expect(recovered).toEqual({ attemptId: selected.attemptId, previousReps: selected.reps + 1, responseSession: selected.draftId, draft: fixture.text })
    const rows = await admin.from('sync_operations').select('entity_id').eq('user_id', owner).eq('entity_type', 'events')
      .in('entity_id', [fixture.legacyId, selected.attemptId, selected.responseEventId])
    expect(rows.error).toBeNull()
    expect(rows.data?.filter(row => row.entity_id === fixture.legacyId)).toHaveLength(2)
    expect(rows.data?.filter(row => row.entity_id === selected.attemptId)).toHaveLength(1)
    expect(rows.data?.filter(row => row.entity_id === selected.responseEventId)).toHaveLength(1)
    await a.goto(appURL + '#/settings'); await sync(a); await sync(b)
  }
  async function state(page: Page) {
    return page.evaluate(async () => {
      const path = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(path)
      const audio = await db.audio.get('browser-original')
      return {
        owner: (await db.syncMeta.get('owner'))?.value,
        events: (await db.events.toArray()).filter((row: { id: string }) => row.id.startsWith('browser-evidence')).map((row: { id: string }) => row.id).sort(),
        draft: (await db.sessions.get('browser-draft'))?.draft,
        bytes: audio ? [...new Uint8Array(await audio.blob.arrayBuffer())] : [],
        operations: (await db.syncOperations.toArray()).map((row: { id: string }) => row.id).sort(),
      }
    })
  }
  async function readingConflictJourney(a: Page, b: Page, owner: string) {
    async function settings(page: Page) {
      const requests: string[] = []
      const failed = (request: import('@playwright/test').Request) => {
        const path = new URL(request.url()).pathname
        if (!path.startsWith('/jove-english-os/')) return
        requests.push(path.endsWith('/Settings.vue') ? 'settings-module' : path === '/jove-english-os/' ? 'dev-shell' : 'other-app-module')
      }
      page.on('requestfailed', failed)
      try {
        // Exercise the user's in-app route and its real save-before-leave guard.
        await page.getByRole('link', { name: 'Settings', exact: true }).click()
        await browserExpect(page.getByRole('heading', { level: 1, name: 'A few thoughtful settings.', exact: true })).toBeVisible()
      } catch {
        const state = await page.evaluate(() => ({ online: navigator.onLine, shell: !!document.querySelector('.app-shell'),
          fatal: !!document.querySelector('.fatal'), boot: !!document.querySelector('.boot'), reading: !!document.getElementById('reading-response'),
          settingsHeading: document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() === 'A few thoughtful settings.',
          settingsRoute: location.hash === '#/settings' }))
        throw new Error('Reading route did not reach Settings: ' + JSON.stringify({ state, requests }))
      } finally { page.off('requestfailed', failed) }
    }
    const fixture = await a.evaluate(async () => {
      const nativeImport = new Function('path', 'return import(path)')
      const { db } = await nativeImport('/jove-english-os/src/db/db.ts')
      const { useApp } = await nativeImport('/jove-english-os/src/stores/app.ts')
      const source = await db.materials.toCollection().first(), now = Date.now(), date = new Date(now).toLocaleDateString('en-CA')
      if (!source) throw new Error('Missing local reading material')
      const taskId = `${date}:learn:${source.id}:reading`, sessionId = `reading:${taskId}`
      // Synthetic assignments; the completion below comes from actual UI work.
      await db.profiles.update('main', { dailyMinutes: 45, fatigue: 0 })
      await db.plans.put({ id: date, date, minutes: 45, focus: 'reading', createdAt: now, evidenceFingerprint: 'browser-reading-conflict', tasks: [
        { id: taskId, kind: 'learn', title: 'Read something worth sharing', materialId: source.id, minutes: 9, done: false, reason: 'Shared original assignment' },
        { id: `${date}:speak:browser-reading-next`, kind: 'speak', title: 'Say it in your own words', minutes: 36, done: false, reason: 'Shared next assignment' },
      ] })
      await db.sessions.put({ id: sessionId, kind: 'reading', materialId: source.id, startedAt: now, stage: 'respond',
        draft: { passage: source.transcript, stage: 'respond', activeMs: 0, response: '', submittedResponse: '', retell: '', audioId: '' } })
      await db.events.put({ id: `started:${taskId}`, type: 'TASK_STARTED', source: 'objective', timestamp: now,
        data: { taskId, materialId: source.id, kind: 'reading' } })
      await useApp().refresh()
      return { materialId: source.id, taskId, sessionId, date }
    })
    await sync(a); await sync(b); await sync(a)
    const route = appURL + `#/learn?mode=reading&task=${encodeURIComponent(fixture.taskId)}&material=${encodeURIComponent(fixture.materialId)}`
    for (const page of [a, b]) {
      // This Auth/journal test serves dev modules, without the built PWA cache.
      // Visit the offline destination in this document before partitioning;
      // production shell/route precaching is covered by the built-app suite.
      await settings(page)
      await page.goto(route)
      await browserExpect(page.locator('#reading-response')).toBeVisible()
    }
    // Let the real component normalize the shared draft before partitioning.
    await sync(a); await sync(b); await sync(a)
    await Promise.all([a, b].map(page => setDisconnected(page.context(), true)))
    const submitted = 'My first device saved the meaning in a complete response.'
    const retell = 'I can explain the situation and describe a useful next step.'
    const unsent = 'My other device has an unfinished answer that must stay recoverable.'
    await a.locator('#reading-response').fill(submitted)
    await a.locator('#reading-retell').fill(retell)
    await a.getByRole('button', { name: 'Save reading & retell', exact: true }).click()
    try { await browserExpect(a.getByRole('button', { name: 'Continue to next task', exact: true })).toBeVisible() }
    catch {
      // Offline diagnostics use native IDB, not a new dev-module HTTP import.
      // Emit only booleans/counts/known stages; never owner, input or Auth data.
      const facts = await a.evaluate(async ({ fixture, submitted, retell }) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('jove-english-os'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject()
        })
        try {
          const read = <T>(table: string): Promise<T[]> => new Promise((resolve, reject) => {
            const request = database.transaction(table).objectStore(table).getAll()
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject()
          })
          const sessions = await read<{ id: string; kind: string; stage: string; draft: { response?: string; submittedResponse?: string; retell?: string } }>('sessions')
          const events = await read<{ type: string; sessionId?: string; data?: { taskId?: string } }>('events')
          const plans = await read<{ id: string; tasks: { id: string; minutes: number; done: boolean; optional?: boolean }[] }>('plans')
          const root = sessions.find(row => row.id === fixture.sessionId), task = plans.find(row => row.id === fixture.date)?.tasks.find(row => row.id === fixture.taskId)
          const error = [...document.querySelectorAll('.error')].map(node => node.textContent ?? '').join(' ')
          return { stage: ['ready', 'reading', 'respond', 'saved'].includes(root?.stage ?? '') ? root!.stage : 'unknown',
            responseSaved: root?.draft.response === submitted, submittedSaved: root?.draft.submittedResponse === submitted, retellSaved: root?.draft.retell === retell,
            separateLocalCopy: sessions.some(row => row.kind === 'reading-conflict' && row.draft.response === submitted),
            responseEvents: events.filter(row => row.sessionId === fixture.sessionId && row.type === 'READING_RESPONSE').length,
            retellEvents: events.filter(row => row.sessionId === fixture.sessionId && row.type === 'READING_RETELL').length,
            completions: events.filter(row => row.type === 'TASK_COMPLETED' && row.data?.taskId === fixture.taskId).length,
            taskFound: !!task, taskDone: task?.done ?? false, taskMinutes: task?.minutes ?? 0,
            conflictNotice: error.includes('Another device updated'), saveFailure: /Could not.*sav/i.test(error) }
        } finally { database.close() }
      }, { fixture, submitted, retell })
      throw new Error('Reading submission did not release continuation: ' + JSON.stringify(facts))
    }
    const originalEvents = await a.evaluate(async fixture => {
      const path = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(path)
      return (await db.events.toArray()).filter((event: { type: string; sessionId?: string; data?: { taskId?: string } }) =>
        event.sessionId === fixture.sessionId && ['READING_RESPONSE', 'READING_RETELL'].includes(event.type)
        || event.type === 'TASK_COMPLETED' && event.data?.taskId === fixture.taskId)
        .sort((left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id))
    }, fixture)
    expect(originalEvents).toHaveLength(3)
    await b.locator('#reading-response').fill(unsent)
    await browserExpect.poll(() => b.evaluate(async sessionId => {
      const path = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(path)
      return (await db.sessions.get(sessionId))?.draft.response
    }, fixture.sessionId)).toBe(unsent)
    // Hash routing preserves the loaded app while offline and flushes the drafts.
    for (const page of [a, b]) await settings(page)
    const beforeReconnect = await admin.from('sync_operations').select('id').eq('user_id', owner)
      .eq('entity_type', 'events').eq('entity_id', `completed:${fixture.taskId}`)
    expect(beforeReconnect.error).toBeNull(); expect(beforeReconnect.data).toEqual([])
    await Promise.all([a, b].map(page => setDisconnected(page.context(), false)))
    await sync(a); await sync(b); await sync(a)
    for (const page of [a, b]) {
      const merged = await page.evaluate(async fixture => {
        const nativeImport = new Function('path', 'return import(path)'), { db } = await nativeImport('/jove-english-os/src/db/db.ts')
        const { useApp } = await nativeImport('/jove-english-os/src/stores/app.ts')
        await useApp().refresh()
        const plan = useApp().plan, root = await db.sessions.get(fixture.sessionId)
        return { response: root?.draft.submittedResponse, retell: root?.draft.retell,
          task: plan.tasks.find((task: { id: string }) => task.id === fixture.taskId), minutes: plan.minutes,
          remaining: plan.tasks.filter((task: { done: boolean; optional?: boolean }) => !task.done && !task.optional)
            .reduce((sum: number, task: { minutes: number }) => sum + task.minutes, 0),
          completions: (await db.events.toArray()).filter((event: { type: string; data?: { taskId?: string } }) =>
            event.type === 'TASK_COMPLETED' && event.data?.taskId === fixture.taskId).length,
          conflicts: (await db.sessions.where('kind').equals('reading-conflict').toArray())
            .filter((session: { draft: { syncRecovery?: { rootSessionId?: string } } }) => session.draft.syncRecovery?.rootSessionId === fixture.sessionId)
            .map((session: { draft: { response?: string } }) => session.draft.response) }
      }, fixture)
      expect(merged.response).toBe(submitted); expect(merged.retell).toBe(retell)
      expect(merged.task).toMatchObject({ id: fixture.taskId, materialId: fixture.materialId, done: true, minutes: 9 })
      expect(merged.minutes).toBeLessThanOrEqual(45); expect(merged.remaining).toBeLessThanOrEqual(36)
      expect(merged.completions).toBe(1); expect(merged.conflicts).toEqual([unsent])
    }
    await b.goto(route)
    await b.getByRole('button', { name: 'Continue editing saved draft', exact: true }).click()
    await browserExpect(b.locator('#reading-response')).toHaveValue(unsent)
    await browserExpect(b.locator('#reading-retell')).toHaveValue('')
    await b.locator('#reading-retell').fill('I continued the unfinished draft without changing my original submission.')
    await b.getByRole('button', { name: 'Save reading & retell', exact: true }).click()
    await browserExpect(b.getByText('Saved. Ready to reflect on the meaning.', { exact: true })).toBeVisible()
    await settings(b); await sync(b); await sync(a)
    await a.goto(route); await a.reload()
    await a.getByRole('button', { name: 'Open recovered practice', exact: true }).click()
    await browserExpect(a.getByText('Saved. Ready to reflect on the meaning.', { exact: true })).toBeVisible()
    for (const page of [a, b]) {
      const restored = await page.evaluate(async fixture => {
        const path = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(path)
        const recovered = (await db.sessions.where('kind').equals('reading-recovery').toArray())
          .filter((session: { draft: { syncRecovery?: { rootSessionId?: string } } }) => session.draft.syncRecovery?.rootSessionId === fixture.sessionId)
        const events = await db.events.toArray(), root = await db.sessions.get(fixture.sessionId)
        return { count: recovered.length, response: recovered[0]?.draft.submittedResponse,
          original: root?.draft.submittedResponse, retell: root?.draft.retell,
          originalEvents: events.filter((event: { type: string; sessionId?: string; data?: { taskId?: string } }) =>
            event.sessionId === fixture.sessionId && ['READING_RESPONSE', 'READING_RETELL'].includes(event.type)
            || event.type === 'TASK_COMPLETED' && event.data?.taskId === fixture.taskId)
            .sort((left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)),
          invented: events.some((event: { type: string; sessionId?: string; skill?: string; score?: number; data?: { taskId?: string; assessmentId?: string } }) =>
            event.sessionId === recovered[0]?.id && (event.score !== undefined || event.skill !== undefined || event.data?.taskId || event.data?.assessmentId
              || ['TASK_COMPLETED', 'ASSESSMENT_COMPLETED'].includes(event.type))) }
      }, fixture)
      expect(restored).toEqual({ count: 1, response: unsent, original: submitted, retell, originalEvents, invented: false })
    }
    const uploaded = await admin.from('sync_operations').select('id').eq('user_id', owner)
      .eq('entity_type', 'events').eq('entity_id', `completed:${fixture.taskId}`)
    expect(uploaded.error).toBeNull(); expect(uploaded.data).toHaveLength(1)
    await settings(a); await settings(b)
    await sync(a); await sync(b)
  }
  for (const engine of engines) it(engine + ': real OTP, two offline profiles, verified audio, safe reset/restore, reload and member isolation', async () => {
    failures.length = 0; transportFailures.length = 0
    if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new Error('Unknown local browser engine')
    const type = { chromium, firefox, webkit }[engine as 'chromium' | 'firefox' | 'webkit']
    const contexts: BrowserContext[] = []
    let remoteBrowser: Browser | undefined
    let stage = 'launch'
    try {
      // WebKit private contexts on this Windows runtime cannot persist Blob IDB;
      // real disposable regular profiles preserve the native browser behavior.
      if (['firefox', 'webkit'].includes(engine) && remoteEndpoint) remoteBrowser = await type.connect(remoteEndpoint, { exposeNetwork: '<loopback>', timeout: 30000 })
      for (let index = 0; index < 2; index++) {
        const context = remoteBrowser ? await remoteBrowser.newContext() : await type.launchPersistentContext('', { headless: true })
        contexts.push(context); if (engine === 'webkit') webkitContexts.add(context)
      }
      stage = 'native recording metadata and multipart preservation'
      const probe = await contexts[0]!.newPage()
      try {
        await probe.route(appURL, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Native recording regression</title>' }))
        await probe.goto(appURL)
        await verifyNativeAudioJournal(probe)
      } finally { await probe.close() }
      stage = 'provision'; const fixture = await provision()
      stage = 'first page'; const a = await prepare(contexts[0]!)
      stage = 'existing local work before first account binding'
      await a.evaluate(async () => {
        const path = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(path)
        if (await db.syncMeta.get('owner')) throw new Error('First-login fixture was already bound')
        await db.sessions.put({ id: 'browser-preaccount-draft', kind: 'listen', stage: 'draft', startedAt: Date.now(), draft: { answer: 'Existing work before using an account' } })
        await db.events.put({ id: 'browser-preaccount-evidence', type: 'LISTEN_ATTEMPT', timestamp: Date.now(), score: 0.7, source: 'objective', skill: 'naturalListening' })
      })
      stage = 'first code verification'; await signIn(a, fixture.email)
      stage = 'first sync'; await sync(a)
      stage = 'second page'; const b = await prepare(contexts[1]!)
      stage = 'second code verification'; await signIn(b, fixture.email)
      stage = 'second sync'; await sync(b)
      const migrated = await b.evaluate(async () => {
        const path = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(path)
        return { draft: (await db.sessions.get('browser-preaccount-draft'))?.draft.answer,
          event: (await db.events.get('browser-preaccount-evidence'))?.score }
      })
      expect(migrated).toEqual({ draft: 'Existing work before using an account', event: 0.7 })
      const backup: string = await a.evaluate(async () => { const path = '/jove-english-os/src/db/repository.ts'; return (await new Function('path', 'return import(path)')(path)).exportBackup() })
      stage = 'offline local work'
      await Promise.all(contexts.map(context => setDisconnected(context, true)))
      for (const [index, page] of [a, b].entries()) await page.evaluate(async index => {
        const path = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(path), timestamp = Date.now()
        await db.transaction('rw', db.events, db.sessions, db.audio, async () => {
          await db.events.put({ id: 'browser-evidence-collision', type: 'LISTEN_ATTEMPT', timestamp: 1788815000000, score: index ? 0.8 : 0.2, source: 'objective', skill: 'naturalListening' })
          if (!index) {
            await db.audio.put({ id: 'browser-original', blob: new Blob([new Uint8Array([82,73,70,70,1,2,3,4])], { type: 'audio/wav' }),
              mimeType: 'audio/wav', createdAt: timestamp, duration: 1, kind: 'recording', processed: false, label: 'Browser storage fixture' })
            await db.sessions.put({ id: 'browser-draft', kind: 'listen', stage: 'draft', startedAt: timestamp, draft: { answer: 'Offline original answer', audioId: 'browser-original' } })
          }
        })
      }, index)
      const hash = await a.evaluate(async () => {
        const dbPath = '/jove-english-os/src/db/db.ts', audioPath = '/jove-english-os/src/sync/audio.ts'
        const nativeImport = new Function('path', 'return import(path)')
        return (await nativeImport(audioPath)).audioHash((await (await nativeImport(dbPath)).db.audio.get('browser-original')).blob)
      })
      objects.push(fixture.owner + '/browser-original-' + hash)
      const notUploaded = await admin.from('sync_operations').select('id').eq('user_id', fixture.owner).eq('entity_id', 'browser-evidence-collision')
      expect(notUploaded.error).toBeNull(); expect(notUploaded.data).toEqual([])
      stage = 'reconnect and converge'
      await Promise.all(contexts.map(context => setDisconnected(context, false)))
      await sync(a); await sync(b); await sync(a)
      stage = 'cross-device Review counter collision and durable rebased attempt'
      await reviewJourney(a, b, fixture.owner)
      stage = 'cross-device reading submission, unsent recovery and completed-plan budget'
      await readingConflictJourney(a, b, fixture.owner)
      const left = await state(a), right = await state(b)
      expect(left.events).toHaveLength(2); expect(right.events).toEqual(left.events)
      expect(right.draft).toEqual(left.draft); expect(right.bytes).toEqual([82,73,70,70,1,2,3,4])
      expect(right.owner).toBe(fixture.owner)
      stage = 'reset through Settings'
      await a.getByText('Reset local key and audio caches', { exact: true }).click()
      await a.locator('#reset-confirm').fill('RESET')
      await a.getByRole('button', { name: 'Reset local key & caches', exact: true }).click()
      await browserExpect(a.getByText('Optional local API key and audio caches cleared.', { exact: false })).toBeVisible()
      const reset = await state(a)
      expect(reset.owner).toBe(fixture.owner); expect(reset.events).toEqual(left.events); expect(reset.bytes).toEqual(left.bytes)
      expect(reset.operations).toEqual(left.operations)
      stage = 'merge old backup through Settings'
      await a.locator('#restore-file').setInputFiles({ name: 'older-fixture.json', mimeType: 'application/json', buffer: Buffer.from(backup) })
      await a.getByRole('button', { name: 'Validate & merge backup', exact: true }).click()
      await browserExpect(a.getByText('Backup merged with retained learning history.', { exact: false })).toBeVisible()
      expect((await state(a)).draft).toEqual(left.draft)
      stage = 'reload persistence'; await a.reload(); await sync(a)
      expect((await state(a)).bytes).toEqual(left.bytes)
      stage = 'sign out and reject other member in owned browser'
      await a.getByRole('button', { name: 'Sign out on this device', exact: true }).click()
      const other = await provision(); await signIn(a, other.email)
      await browserExpect(a.getByText('This account could not open this browser', { exact: false })).toBeVisible()
      expect((await state(a)).owner).toBe(fixture.owner)
      expect((await state(a)).events).toEqual(left.events)
      const leaked = await admin.from('sync_operations').select('id').eq('user_id', other.owner)
      expect(leaked.data).toEqual([])
    } catch (failure) {
      // Playwright's raw call logs may include OTP fill values. Never rethrow them.
      const diagnostics = await Promise.all(contexts.map(async context => {
        try { return await context.pages().at(-1)?.evaluate(async () => {
          const path = '/jove-english-os/src/stores/cloud.ts', cloud = (await new Function('path', 'return import(path)')(path)).useCloud()
          const dbPath = '/jove-english-os/src/db/db.ts', { db } = await new Function('path', 'return import(path)')(dbPath)
          const asset = await db.audio.get('browser-original')
          const safeName = (error: unknown) => {
            const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
            return typeof name === 'string' && ['NotFoundError', 'NotReadableError', 'AbortError', 'SecurityError', 'TypeError', 'InvalidStateError'].includes(name)
              ? name : 'unavailable'
          }
          let originalRead = 'absent', multipartRead = 'not-attempted'
          if (asset?.blob) {
            try {
              const bytes = new Uint8Array(await asset.blob.arrayBuffer())
              originalRead = bytes.join(',') === '82,73,70,70,1,2,3,4' ? 'verified-fixture' : 'different-bytes'
            } catch (error) { originalRead = safeName(error) }
            try {
              const form = new FormData(); form.append('cacheControl', '3600'); form.append('', asset.blob)
              const encoded = await new Request('https://example.invalid/', { method: 'POST', body: form }).arrayBuffer()
              multipartRead = encoded.byteLength > 8 ? 'encoded-fixture' : 'empty'
            } catch (error) { multipartRead = safeName(error) }
          }
          return { configured: cloud.configured, signedIn: !!cloud.userId, status: cloud.status, problem: cloud.problem,
            pending: cloud.pending, hasMore: cloud.hasMore, deferred: cloud.deferred, audioPending: cloud.audioPending,
            paused: cloud.paused, originalRead, multipartRead, originalIsBlob: asset?.blob instanceof Blob }
        }) } catch { return { appState: false, url: context.pages().at(-1)?.url().split('?')[0] } }
      }))
      const message = String(failure instanceof Error ? failure.message : failure)
      const safeFailure = /code verification/.test(stage) ? (message.startsWith('Local Auth code request denied:') ? message : '') : message.replace(/(?:eyJ|sb_)[A-Za-z0-9_.-]+/g, '[redacted]')
      throw new Error(engine + ' local account journey failed at: ' + stage + '; detail: ' + safeFailure + '; safe status: ' + JSON.stringify(diagnostics) + '; HTTP failures: ' + JSON.stringify(failures) + '; transport failures: ' + JSON.stringify(transportFailures))
    } finally {
      // Playwright may create an automatic failure-context snapshot even with
      // trace/video disabled. Clear sensitive form values and leave a blank page
      // before the runner observes context closure; never persist OTP entry.
      for (const context of contexts) {
        for (const page of context.pages()) {
          await page.evaluate(() => document.querySelectorAll('input').forEach(input => { input.value = ''; input.removeAttribute('value') })).catch(() => {})
          await page.goto('about:blank', { timeout: 2000 }).catch(() => {})
        }
        await context.close()
      }
      await remoteBrowser?.close()
    }
  }, 360000)
})
}
