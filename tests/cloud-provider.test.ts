import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import { CloudProvider } from '../src/ai/cloud-provider'
import { OpenRouterProvider } from '../src/ai/provider'
import { defaultSettings, type Usage } from '../src/domain/types'
import { exportBackup, initialize } from '../src/db/repository'

type FixtureSession = { user: { id: string }; access_token: string } | null
const auth = vi.hoisted(() => ({ session: { user: { id: 'owner-a' }, access_token: 'fixture-session-a' } as FixtureSession,
  listeners: new Set<(event: string, session: FixtureSession) => void>() }))
vi.mock('../src/cloud/client', async () => {
  const { createPrincipalFence } = await import('../src/cloud/auth-fence')
  const sdk = {
    getSession: async () => ({ data: { session: auth.session }, error: null }),
    onAuthStateChange: (callback: (event: string, session: FixtureSession) => void) => {
      auth.listeners.add(callback)
      return { data: { subscription: { id: 'fixture-subscription', callback,
        unsubscribe: () => { auth.listeners.delete(callback) } } } }
    },
  }
  return {
    publicCloudConfig: { url: 'https://cloud.example.test', publishableKey: 'fixture-publishable' },
    cloudClient: { auth: sdk },
    createAuthFence: () => createPrincipalFence(sdk as Parameters<typeof createPrincipalFence>[0]),
  }
})
function emitSession(owner: string | null, event = owner ? 'SIGNED_IN' : 'SIGNED_OUT') {
  auth.session = owner ? { user: { id: owner }, access_token: 'fixture-token' } : null
  for (const listener of auth.listeners) listener(event, auth.session)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const evaluation = { summary: 'Clear request.', strengths: ['Clear meaning.'], errors: [], comprehension: 0.8, accuracy: 0.8,
  fluency: null, successfulChunks: [], nextPrompt: 'Explain why.', provenance: { provider: 'OpenRouter', model: 'fixture/actual' } }
const envelope = (value: unknown, usage: Usage[] = []) => ({ value, usage, notices: [] })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const input = { kind: 'meaning', text: 'I would like some water.', reference: 'Ask for water.' }
const chatInput = [{ role: 'user' as const, content: 'Hi.' }], chatContext = { mode: 'guided', scenario: 'Greeting', level: 'beginner', targets: [] }
const newProvider = () => new CloudProvider(new OpenRouterProvider({ getKey: async () => '', getSettings: () => defaultSettings }), async value => { rows.push(value) })
const pendingRow = async () => (await db.syncMeta.toArray()).find(row => row.id.startsWith('ai-request:'))!
function localReceipt(value: unknown = evaluation) {
  fetcher.mockImplementationOnce(async (_url: string, options: RequestInit) => json({ ...envelope(value),
    delivery: { requestId: JSON.parse(String(options.body)).requestId, cache: 'unconfirmed' } }))
}
let provider: CloudProvider, fetcher: ReturnType<typeof vi.fn>, rows: Usage[]
beforeEach(async () => {
  await db.delete(); await db.open()
  await db.syncMeta.put({ id: 'owner', value: 'owner-a' })
  auth.session = { user: { id: 'owner-a' }, access_token: 'fixture-session-a' }
  auth.listeners.clear()
  rows = []
  provider = new CloudProvider(new OpenRouterProvider({ getKey: async () => '', getSettings: () => defaultSettings }), async value => { rows.push(value) })
  fetcher = vi.fn(async () => json(envelope(evaluation)))
  vi.stubGlobal('fetch', fetcher)
})

// The optional runtime gate uses the production provider/client and native IDB.
// Only the Supabase network client is a fixture; no app account, server or key is used.
type BrowserFixture = {
  production: { CloudProvider: typeof CloudProvider; OpenRouterProvider: typeof OpenRouterProvider; db: typeof db; defaultSettings: typeof defaultSettings }
  fixtureAuth: { session: FixtureSession; listeners: Set<(event: string, session: FixtureSession) => void>; emit(owner: string): void }
  fixtureClient: { auth: { getSession(): Promise<{ data: { session: FixtureSession }; error: null }>; onAuthStateChange(callback: (event: string, session: FixtureSession) => void): { data: { subscription: { unsubscribe(): void } } } } }
}
let browserBundle: Promise<string> | undefined
function runtimeBundle() {
  browserBundle ??= build({ stdin: { contents: `export { CloudProvider } from './src/ai/cloud-provider';
    export { OpenRouterProvider } from './src/ai/provider'; export { db } from './src/db/db';
    export { defaultSettings } from './src/domain/types';`, resolveDir: process.cwd(), loader: 'ts' },
  write: false, bundle: true, platform: 'browser', format: 'iife', globalName: 'production',
  define: { 'import.meta.env': JSON.stringify({ DEV: true, VITE_SUPABASE_URL: 'https://cloud.example.test', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' }) },
  plugins: [{ name: 'fixture-account-only', setup(builder) {
    builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'account', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const createClient = () => globalThis.fixtureClient', loader: 'js' }))
  } }],
  }).then(result => result.outputFiles[0]!.text)
  return browserBundle
}
describe.skipIf(!process.env.CLOUD_BROWSER_TESTS)('native IndexedDB and synchronous auth runtime regressions', () => {
  it.each(['owner-aba', 'cancel-retry', 'cancel-warning', 'late-receipt'] as const)('%s with the actual bundled provider', async kind => {
    const browser = await chromium.launch(), page = await browser.newPage()
    try {
      // Intercept the entire fresh context: even an accidental external request
      // cannot reach a production service. Localhost supplies a secure IDB origin.
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated cloud regression</title>' }))
      await page.goto('http://127.0.0.1:4181/provider-regression')
      await page.evaluate(() => {
        const w = globalThis as unknown as BrowserFixture
        w.fixtureAuth = { session: { user: { id: 'owner-a' }, access_token: 'fixture-token' }, listeners: new Set(),
          emit(owner) { this.session = { user: { id: owner }, access_token: 'fixture-token' }; for (const cb of this.listeners) cb('SIGNED_IN', this.session) } }
        w.fixtureClient = { auth: {
          getSession: async () => ({ data: { session: w.fixtureAuth.session }, error: null }),
          onAuthStateChange: callback => { w.fixtureAuth.listeners.add(callback); return { data: { subscription: { unsubscribe: () => { w.fixtureAuth.listeners.delete(callback) } } } } },
        } }
      })
      await page.addScriptTag({ content: await runtimeBundle() })
      const result = await page.evaluate(async scenario => {
        const w = globalThis as unknown as BrowserFixture, { db, CloudProvider, OpenRouterProvider, defaultSettings } = w.production
        await db.open(); await db.syncMeta.put({ id: 'owner', value: 'owner-a' })
        const makeProvider = () => new CloudProvider(new OpenRouterProvider({ getKey: async () => '', getSettings: () => defaultSettings }), async () => undefined)
        let provider = makeProvider()
        const messages = [{ role: 'user' as const, content: 'Hi.' }], context = { mode: 'guided', scenario: 'Greeting', level: 'beginner', targets: [] }
        const seen: string[] = [], ids: string[] = []
        const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
        const envelope = (value: string) => ({ value, notices: [], usage: [] })
        const code = (error: unknown) => (error as { code?: string }).code ?? 'UNEXPECTED'
        const watch = (value: Promise<unknown>) => value.then(() => 'DELIVERED', code)
        const waitCalls = async (count: number) => {
          const until = Date.now() + 1500
          while (ids.length < count && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
          if (ids.length !== count) throw new Error('Fixture dispatch did not reach checkpoint')
        }
        let dispatch: (id: string, count: number) => Promise<Response> = async () => json(envelope('Private result.'))
        globalThis.fetch = async (_url, options) => {
          const id = JSON.parse(String(options?.body)).requestId as string
          ids.push(id); return dispatch(id, ids.length)
        }
        let failure = '', followup = ''
        if (scenario === 'owner-aba') {
          let afterHeaders = false, reads = 0
          const get = db.syncMeta.get.bind(db.syncMeta)
          Object.defineProperty(db.syncMeta, 'get', { configurable: true, value: (key: string) => get(key).then(row => {
            if (key === 'owner' && afterHeaders && ++reads === 2) { w.fixtureAuth.emit('owner-b'); w.fixtureAuth.emit('owner-a') }
            return row
          }) })
          dispatch = async () => {
            afterHeaders = true
            return new Response(`data: ${JSON.stringify({ delta: 'Private A fragment.' })}\n\ndata: ${JSON.stringify({ result: envelope('Private A result.') })}\n\ndata: [DONE]\n\n`,
              { headers: { 'Content-Type': 'text/event-stream' } })
          }
          failure = await watch(provider.chat(messages, context, text => seen.push(text)))
        } else if (scenario === 'cancel-retry' || scenario === 'cancel-warning') {
          const cancel = new AbortController(), remove = db.syncMeta.delete.bind(db.syncMeta), put = db.syncMeta.put.bind(db.syncMeta)
          if (scenario === 'cancel-warning') dispatch = async () => json({ error: { code: 'REQUEST_UNCERTAIN' } }, 409)
          Object.defineProperty(db.syncMeta, 'delete', { configurable: true, value: (key: string) => remove(key).then(() => {
            if (key.startsWith('ai-request:')) cancel.abort()
          }) })
          Object.defineProperty(db.syncMeta, 'put', { configurable: true, value: (row: { id: string; value: unknown }) => put(row).then(key => {
            if ((row.value as { releaseReady?: boolean }).releaseReady) cancel.abort()
            return key
          }) })
          failure = await watch(provider.chat(messages, context, text => seen.push(text), cancel.signal))
          await new Promise(resolve => setTimeout(resolve, 0))
          Object.defineProperty(db.syncMeta, 'delete', { configurable: true, value: remove })
          Object.defineProperty(db.syncMeta, 'put', { configurable: true, value: put })
          db.close(); await db.open(); provider = makeProvider()
          followup = scenario === 'cancel-warning' ? await watch(provider.chat(messages, context, text => seen.push(text)))
            : await provider.chat(messages, context, text => seen.push(text))
        } else {
          let oldResolve!: (response: Response) => void, newResolve!: (response: Response) => void
          const oldResponse = new Promise<Response>(resolve => { oldResolve = resolve }), newResponse = new Promise<Response>(resolve => { newResolve = resolve })
          dispatch = async (_id, count) => count === 1 ? oldResponse : count === 2
            ? json({ error: { code: 'REQUEST_UNCERTAIN' } }, 409) : count === 3 ? newResponse : json({ error: { code: 'REQUEST_PENDING' } }, 409)
          const old = watch(provider.chat(messages, context, text => seen.push(text)))
          await waitCalls(1)
          const warned = await watch(provider.chat(messages, context, () => undefined))
          if (warned !== 'ACCOUNT_UNCERTAIN') throw new Error('Fixture did not warn before releasing request')
          const current = provider.chat(messages, context, () => undefined)
          await waitCalls(3)
          oldResolve(json({ ...envelope('Late old private result.'), delivery: { requestId: ids[0], cache: 'unconfirmed' } }))
          failure = await old
          const row = (await db.syncMeta.toArray()).find(row => row.id.startsWith('ai-request:'))!
          if ((row.value as { requestId: string }).requestId !== ids[2]) throw new Error('Old receipt overwrote new request')
          followup = await watch(provider.chat(messages, context, () => undefined))
          newResolve(json(envelope('Current result.')))
          if (await current !== 'Current result.') throw new Error('Current result was lost')
        }
        await new Promise(resolve => setTimeout(resolve, 0))
        return { failure, followup, ids, seen, listeners: w.fixtureAuth.listeners.size }
      }, kind)
      if (kind === 'owner-aba') { expect(result.failure).toBe('ACCOUNT_REQUIRED'); expect(result.seen).toEqual([]); expect(result.ids).toHaveLength(1) }
      else if (kind === 'cancel-retry') {
        expect(result.failure).toBe('CANCELLED'); expect(result.followup).toBe('Private result.')
        expect(result.ids).toHaveLength(2); expect(result.ids[0]).toBe(result.ids[1]); expect(result.seen).toEqual(['Private result.'])
      } else if (kind === 'cancel-warning') {
        expect(result.failure).toBe('CANCELLED'); expect(result.followup).toBe('ACCOUNT_UNCERTAIN')
        expect(result.ids).toHaveLength(1); expect(result.seen).toEqual([])
      } else {
        expect(result.failure).toBe('ACCOUNT_PENDING'); expect(result.followup).toBe('ACCOUNT_PENDING'); expect(result.seen).toEqual([])
        expect(result.ids).toHaveLength(4); expect(result.ids[0]).toBe(result.ids[1]); expect(result.ids[2]).not.toBe(result.ids[0]); expect(result.ids[3]).toBe(result.ids[2])
      }
      expect(result.listeners).toBe(0)
    } finally { await browser.close() }
  })
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.delete(); expect(auth.listeners.size).toBe(0) })
describe('account provider and durable retry identity', () => {
  it('requires login and the local journal owner before sending any learner data', async () => {
    auth.session = null
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    auth.session = { user: { id: 'other-owner' }, access_token: 'fixture-other' }
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses a pinned JWT, accepts transport provenance, and separates account from BYOK usage', async () => {
    fetcher.mockResolvedValueOnce(json(envelope(evaluation, [{ id: 'usage-one', timestamp: Date.now(), model: 'fixture/actual', purpose: 'evaluate', tokens: 10, cost: 0.001 }])))
    await expect(provider.evaluate(input)).resolves.toEqual(evaluation)
    const [url, request] = fetcher.mock.calls[0]!
    expect(url).toBe('https://cloud.example.test/functions/v1/ai')
    expect(request).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer fixture-session-a' } })
    expect(JSON.parse(request.body)).toMatchObject({ action: 'evaluate', input })
    expect(rows[0]).toMatchObject({ purpose: 'account:evaluate', model: 'fixture/actual', cost: 0.001 })
    expect((await db.syncMeta.toArray()).filter(row => row.id.startsWith('ai-request:'))).toHaveLength(0)
  })
  it('reuses the stored request after an ambiguous network failure, including a new provider instance', async () => {
    fetcher.mockRejectedValueOnce(new TypeError('fixture disconnect'))
    await expect(provider.evaluate(input)).rejects.toBeDefined()
    const pending = (await db.syncMeta.toArray()).find(row => row.id.startsWith('ai-request:'))!
    expect(JSON.stringify(pending)).not.toContain(input.text)
    provider = new CloudProvider(new OpenRouterProvider({ getKey: async () => '', getSettings: () => defaultSettings }), async () => undefined)
    await provider.evaluate(input)
    const ids = fetcher.mock.calls.map(([, request]) => JSON.parse(request.body).requestId)
    expect(ids[1]).toBe(ids[0])
  })
  it('does not reset a still-running request or silently retry it as a fresh paid call', async () => {
    fetcher.mockResolvedValueOnce(json({ error: { code: 'REQUEST_PENDING' } }, 409))
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'ACCOUNT_PENDING' })
    await provider.evaluate(input)
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).requestId).toBe(JSON.parse(fetcher.mock.calls[0]![1].body).requestId)
  })
  it('warns before a genuinely uncertain previous request may be retried as a new charge', async () => {
    fetcher.mockResolvedValueOnce(json({ error: { code: 'REQUEST_UNCERTAIN' } }, 409))
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'ACCOUNT_UNCERTAIN' })
    expect(fetcher).toHaveBeenCalledOnce()
    await provider.evaluate(input)
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).requestId).not.toBe(JSON.parse(fetcher.mock.calls[0]![1].body).requestId)
  })
  it.each(['cancel', 'account-change', 'reopen'] as const)('does not authorize a fresh charge when %s hides the uncertain-result warning', async interruption => {
    fetcher.mockResolvedValueOnce(json({ error: { code: 'REQUEST_UNCERTAIN' } }, 409))
    const controller = new AbortController(), remove = db.syncMeta.delete.bind(db.syncMeta), put = db.syncMeta.put.bind(db.syncMeta)
    // Cover both the former deletion and the durable warning-marker handoff.
    const interrupt = () => { if (interruption === 'account-change') emitSession('owner-b'); else controller.abort() }
    const deletion = vi.spyOn(db.syncMeta, 'delete').mockImplementation(key => remove(key).then(interrupt))
    const writing = vi.spyOn(db.syncMeta, 'put').mockImplementation((...args) => put(...args).then(key => {
      if ((args[0].value as { releaseReady?: boolean }).releaseReady) interrupt()
      return key
    }))
    await expect(provider.evaluate(input, controller.signal)).rejects.toMatchObject({ code: interruption === 'account-change' ? 'ACCOUNT_REQUIRED' : 'CANCELLED' })
    await new Promise(resolve => setTimeout(resolve, 0))
    deletion.mockRestore(); writing.mockRestore()
    emitSession('owner-a')
    if (interruption === 'reopen') { db.close(); await db.open(); provider = newProvider() }
    // The next call must show the warning (or replay the old identity), never
    // silently allocate and dispatch a new paid request after CANCELLED.
    fetcher.mockResolvedValueOnce(json({ error: { code: 'REQUEST_UNCERTAIN' } }, 409))
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'ACCOUNT_UNCERTAIN' })
    const ids = fetcher.mock.calls.map(([, request]) => JSON.parse(request.body).requestId)
    expect(new Set(ids).size).toBe(1)
  })
  it('rejects late results after account change, before applying usage or assessment', async () => {
    fetcher.mockImplementationOnce(async () => {
      auth.session = { user: { id: 'other-owner' }, access_token: 'fixture-other' }
      return json(envelope(evaluation))
    })
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(rows).toEqual([])
  })
  it.each(
    ['json', 'sse'].flatMap(transport => ['session', 'binding', 'both', 'sign-out', 'cancel'].map(change => ({ transport, change }))),
  )('fences final $transport delivery when $change occurs during pending cleanup', async ({ transport, change }) => {
    const answer = 'Private final answer belonging to owner A.'
    fetcher.mockResolvedValueOnce(transport === 'json' ? json(envelope(answer))
      : new Response(`data: ${JSON.stringify({ result: envelope(answer) })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }))
    const controller = new AbortController(), delta = vi.fn(), remove = db.syncMeta.delete.bind(db.syncMeta)
    let cleaned = false
    const deletion = vi.spyOn(db.syncMeta, 'delete').mockImplementation(key => remove(key).then(async () => {
      if (!String(key).startsWith('ai-request:')) return
      cleaned = true
      if (change === 'session' || change === 'both') auth.session = { user: { id: 'owner-b' }, access_token: 'fixture-b' }
      if (change === 'binding' || change === 'both') await db.syncMeta.put({ id: 'owner', value: 'owner-b' })
      if (change === 'sign-out') auth.session = null
      if (change === 'cancel') controller.abort()
    }))
    await expect(provider.chat(chatInput, chatContext, delta, controller.signal))
      .rejects.toMatchObject({ code: change === 'cancel' ? 'CANCELLED' : 'ACCOUNT_REQUIRED' })
    // Drain continuations too: rejecting the caller alone must not leave a late
    // JSON fallback callback running after cancellation/account replacement.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cleaned).toBe(true); expect(delta).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
    deletion.mockRestore()
    auth.session = { user: { id: 'owner-a' }, access_token: 'fixture-session-a' }
    await db.syncMeta.put({ id: 'owner', value: 'owner-a' })
    db.close(); await db.open(); provider = newProvider()
    fetcher.mockResolvedValueOnce(json(envelope(answer)))
    await expect(provider.chat(chatInput, chatContext, delta)).resolves.toBe(answer)
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).requestId).toBe(JSON.parse(fetcher.mock.calls[0]![1].body).requestId)
    expect(delta).toHaveBeenCalledExactlyOnceWith(answer)
  })
  it.each(['switch', 'aba', 'sign-out'] as const)('fences auth %s inside an awaited owner read before the first SSE delta', async transition => {
    const read = db.syncMeta.get.bind(db.syncMeta)
    let afterHeaders = false, ownerReads = 0
    vi.spyOn(db.syncMeta, 'get').mockImplementation(key => read(key).then(row => {
      if (String(key) === 'owner' && afterHeaders && ++ownerReads === 2) {
        emitSession(transition === 'sign-out' ? null : 'owner-b')
        if (transition === 'aba') emitSession('owner-a')
      }
      return row
    }))
    fetcher.mockImplementationOnce(async () => {
      afterHeaders = true
      return new Response(`data: ${JSON.stringify({ delta: 'Private A fragment.' })}\n\ndata: ${JSON.stringify({ result: envelope('Private A result.') })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const delta = vi.fn()
    await expect(provider.chat(chatInput, chatContext, delta)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(delta).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each(['INITIAL_SESSION', 'TOKEN_REFRESHED', 'SIGNED_IN'])('does not invalidate a same-owner %s event', async event => {
    fetcher.mockImplementationOnce(async () => { emitSession('owner-a', event); return json(envelope(evaluation)) })
    await expect(provider.evaluate(input)).resolves.toEqual(evaluation)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('aborts a silent stream on an auth event without waiting for another delta', async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn(), delta = vi.fn()
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { output = controller }, cancel }),
      { headers: { 'Content-Type': 'text/event-stream' } }))
    const running = provider.chat(chatInput, chatContext, delta)
    const rejected = expect(running).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: 'Before switch.' })}\n\n`))
    await vi.waitFor(() => expect(delta).toHaveBeenCalledOnce())
    emitSession('owner-b')
    await rejected
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(delta).toHaveBeenCalledExactlyOnceWith('Before switch.')
    expect(await pendingRow()).toBeDefined()
  })
  it.each(['receipt', 'confirmed', 'uncertain'] as const)('does not let a late %s replace, clear or deliver over a newer request', async responseKind => {
    const firstResponse = deferred<Response>(), thirdResponse = deferred<Response>()
    fetcher.mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce(json({ error: { code: 'REQUEST_UNCERTAIN' } }, 409))
      .mockImplementationOnce(() => thirdResponse.promise)
      .mockResolvedValueOnce(json({ error: { code: 'REQUEST_PENDING' } }, 409))
    const delta = vi.fn(), first = provider.chat(chatInput, chatContext, delta)
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'ACCOUNT_PENDING' })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    const oldId = JSON.parse(fetcher.mock.calls[0]![1].body).requestId
    await expect(provider.chat(chatInput, chatContext, () => undefined)).rejects.toMatchObject({ code: 'ACCOUNT_UNCERTAIN' })
    const third = provider.chat(chatInput, chatContext, () => undefined)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
    const newId = JSON.parse(fetcher.mock.calls[2]![1].body).requestId
    expect(newId).not.toBe(oldId)
    firstResponse.resolve(responseKind === 'uncertain' ? json({ error: { code: 'REQUEST_UNCERTAIN' } }, 409)
      : json({ ...envelope('Old result.'), ...(responseKind === 'receipt' ? { delivery: { requestId: oldId, cache: 'unconfirmed' } } : {}) }))
    await firstRejected
    expect((await pendingRow()).value).toMatchObject({ requestId: newId })
    expect(delta).not.toHaveBeenCalled()
    // A failed CAS must not leave the old in-memory receipt shadowing newId.
    await expect(provider.chat(chatInput, chatContext, () => undefined)).rejects.toMatchObject({ code: 'ACCOUNT_PENDING' })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(JSON.parse(fetcher.mock.calls[3]![1].body).requestId).toBe(newId)
    thirdResponse.resolve(json(envelope('New result.')))
    await expect(third).resolves.toBe('New result.')
  })
  it('does not accept a malformed result as evaluation evidence', async () => {
    fetcher.mockResolvedValueOnce(json(envelope({ ...evaluation, fluency: 0.99 }, [{ id: 'invalid-evidence-usage', timestamp: Date.now(), model: 'fixture/actual', purpose: 'evaluate', tokens: 10, cost: 0.001 }])))
    await expect(provider.evaluate(input)).rejects.toBeDefined()
    const pending = await pendingRow()
    expect(pending).toBeDefined(); expect(pending.value).not.toHaveProperty('receipt'); expect(rows).toEqual([])
    await provider.evaluate(input)
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).requestId).toBe(JSON.parse(fetcher.mock.calls[0]![1].body).requestId)
  })
  it('reads actual SSE deltas and the confirmed final result', async () => {
    fetcher.mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ delta: 'Hello.' })}\n\ndata: ${JSON.stringify({ result: envelope('Hello.') })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }))
    const delta = vi.fn()
    await expect(provider.chat([{ role: 'user', content: 'Hi.' }], { mode: 'guided', scenario: 'Greeting', level: 'beginner', targets: [] }, delta)).resolves.toBe('Hello.')
    expect(delta).toHaveBeenCalledWith('Hello.')
  })
  it('rejects an incomplete stream while retaining the recoverable request identity', async () => {
    fetcher.mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ delta: 'Hello.' })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }))
    await expect(provider.chat([{ role: 'user', content: 'Hi.' }], { mode: 'guided', scenario: 'Greeting', level: 'beginner', targets: [] }, () => undefined)).rejects.toMatchObject({ code: 'TRUNCATED' })
    expect((await db.syncMeta.toArray()).some(row => row.id.startsWith('ai-request:'))).toBe(true)
  })
  it.each(['switch', 'sign-out', 'binding'] as const)('rejects every late SSE delta after %s, including coalesced frames', async change => {
    fetcher.mockResolvedValueOnce(new Response(
      `data: ${JSON.stringify({ delta: 'First A fragment.' })}\n\ndata: ${JSON.stringify({ delta: 'Late private A fragment.' })}\n\ndata: ${JSON.stringify({ result: envelope('Final A answer.') })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }))
    const seen: string[] = []
    const delta = (value: string) => {
      seen.push(value)
      if (change === 'switch') auth.session = { user: { id: 'owner-b' }, access_token: 'fixture-b' }
      else if (change === 'sign-out') auth.session = null
      else void db.syncMeta.put({ id: 'owner', value: 'owner-b' })
    }
    await expect(provider.chat(chatInput, chatContext, delta)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(seen).toEqual(['First A fragment.']); expect(rows).toEqual([])
    expect(await pendingRow()).toBeDefined()
  })
  it('preserves UTF-8 framing and delta order while asynchronous identity checks are pending', async () => {
    const parts = ['你', '你好', '你好 friend.']
    const bytes = new TextEncoder().encode(parts.map(delta => `data: ${JSON.stringify({ delta })}\r\n\r\n`).join('') +
      `data: ${JSON.stringify({ result: envelope(parts[2]) })}\r\n\r\ndata: [DONE]\r\n\r\n`)
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (let index = 0; index < bytes.length; index += 2) controller.enqueue(bytes.slice(index, index + 2))
      controller.close()
    } }), { headers: { 'Content-Type': 'text/event-stream' } }))
    const delta = vi.fn()
    await expect(provider.chat(chatInput, chatContext, delta)).resolves.toBe(parts[2])
    expect(delta.mock.calls.map(([value]) => value)).toEqual(parts)
  })
  it('cancels the reader promptly when identity changes during an unfinished stream', async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn(), first = 'First A fragment.', seen = vi.fn()
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { output = controller }, cancel }),
      { headers: { 'Content-Type': 'text/event-stream' } }))
    const running = provider.chat(chatInput, chatContext, seen)
    const rejected = expect(running).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: first })}\n\n`))
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith(first))
    auth.session = null
    output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: 'Must not escape.' })}\n\n`))
    await rejected
    expect(cancel).toHaveBeenCalledOnce(); expect(seen).toHaveBeenCalledOnce()
  })
  it('saves an unconfirmed server result locally before delivery and replays it after a new instance/database reopen', async () => {
    localReceipt()
    await expect(provider.evaluate(input)).resolves.toEqual(evaluation)
    const pending = await pendingRow()
    expect(pending.value).toMatchObject({ receipt: { value: evaluation, delivery: { cache: 'unconfirmed' } } })
    expect(provider.takeNotices()).toContainEqual(expect.objectContaining({ kind: 'result-cache-unconfirmed' }))
    db.close(); await db.open(); provider = newProvider()
    await expect(provider.evaluate(input)).resolves.toEqual(evaluation)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(await pendingRow()).toEqual(pending)
  })
  it('replays a delivered streaming result locally with the complete final text and no further request', async () => {
    fetcher.mockImplementationOnce(async (_url: string, options: RequestInit) => {
      const result = { ...envelope('Hello, friend.'), delivery: { requestId: JSON.parse(String(options.body)).requestId, cache: 'unconfirmed' } }
      return new Response(`data: ${JSON.stringify({ delta: 'Hello,' })}\n\ndata: ${JSON.stringify({ result })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } })
    })
    await expect(provider.chat(chatInput, chatContext, () => undefined)).resolves.toBe('Hello, friend.')
    provider = newProvider()
    const delta = vi.fn()
    await expect(provider.chat(chatInput, chatContext, delta)).resolves.toBe('Hello, friend.')
    expect(delta).toHaveBeenCalledExactlyOnceWith('Hello, friend.'); expect(fetcher).toHaveBeenCalledOnce()
  })
  it('rejects malformed synthesized audio before deleting its pending identity', async () => {
    fetcher.mockResolvedValueOnce(json(envelope({ audioBase64: 'not base64!', mimeType: 'audio/mpeg' })))
    await expect(provider.synthesize('Hello.')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(await pendingRow()).toBeDefined(); expect(rows).toEqual([])
  })
  it('keeps recovery receipts out of portable backups, secrets and the sync outbox', async () => {
    await initialize([])
    localReceipt(); await provider.evaluate(input)
    const backup = await exportBackup()
    expect(backup).not.toContain(evaluation.summary); expect(backup).not.toContain('ai-request:')
    expect(await db.secrets.count()).toBe(0); expect(await db.syncOperations.count()).toBe(0)
  })
  it('keeps the successful retry index metadata-only, owner-bound and out of portable backups', async () => {
    await initialize([])
    await provider.evaluate(input)
    const stored = (await db.syncMeta.toArray()).find(row => row.id.startsWith('ai-retry:'))!
    expect(stored.id).toMatch(/^ai-retry:owner-a:[a-f0-9]{64}$/)
    expect(Object.keys(stored.value as object).sort()).toEqual(['createdAt', 'recoveryUntil', 'requestId'])
    expect(JSON.stringify(stored)).not.toContain(input.text)
    const backup = await exportBackup()
    expect(backup).not.toContain('ai-retry:'); expect(backup).not.toContain('fixture-session-a')
    expect(await db.secrets.count()).toBe(0); expect(await db.syncOperations.count()).toBe(0)
    auth.session = { user: { id: 'owner-b' }, access_token: 'fixture-b' }
    await db.syncMeta.put({ id: 'owner', value: 'owner-b' })
    await provider.evaluate(input)
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).requestId).not.toBe(JSON.parse(fetcher.mock.calls[0]![1].body).requestId)
  })
  it('does not extend the successful retry lifetime and warns at expiry before a new charge', async () => {
    await provider.evaluate(input)
    const row = (await db.syncMeta.toArray()).find(row => row.id.startsWith('ai-retry:'))!
    const value = row.value as { requestId: string; recoveryUntil: number }
    const now = vi.spyOn(Date, 'now').mockReturnValue(value.recoveryUntil - 1)
    db.close(); await db.open(); provider = newProvider()
    await provider.evaluate(input)
    expect((await db.syncMeta.get(row.id))?.value).toEqual(row.value)
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).requestId).toBe(value.requestId)
    now.mockReturnValue(value.recoveryUntil)
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'ACCOUNT_UNCERTAIN' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await provider.evaluate(input)
    expect(JSON.parse(fetcher.mock.calls[2]![1].body).requestId).not.toBe(value.requestId)
  })
  it.each(['corrupt', 'future'] as const)('fails closed on a %s retry index without dispatching', async fault => {
    await provider.evaluate(input)
    const row = (await db.syncMeta.toArray()).find(row => row.id.startsWith('ai-retry:'))!
    await db.syncMeta.put({ ...row, value: { ...(row.value as object),
      ...(fault === 'corrupt' ? { requestId: 'not-a-uuid' } : { recoveryUntil: Date.now() + 7 * 86400000 + 301000 }) } })
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('rolls back pending cleanup if the metadata-only recovery index cannot be written', async () => {
    const put = db.syncMeta.put.bind(db.syncMeta)
    const fail = vi.spyOn(db.syncMeta, 'put').mockImplementation((...args) => {
      if (args[0].id.startsWith('ai-retry:')) return Dexie.Promise.reject(new Error('fixture quota failure'))
      return put(...args)
    })
    await expect(provider.evaluate(input)).rejects.toBeDefined()
    expect(await pendingRow()).toBeDefined()
    fail.mockRestore(); provider = newProvider()
    await provider.evaluate(input)
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).requestId).toBe(JSON.parse(fetcher.mock.calls[0]![1].body).requestId)
  })
  it('never writes a malformed action result or mismatched request receipt', async () => {
    localReceipt({ ...evaluation, fluency: 0.99 })
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect((await pendingRow()).value).not.toHaveProperty('receipt'); expect(rows).toEqual([])
    fetcher.mockResolvedValueOnce(json({ ...envelope(evaluation), delivery: { requestId: crypto.randomUUID(), cache: 'unconfirmed' } }))
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect((await pendingRow()).value).not.toHaveProperty('receipt')
  })
  it('does not replay another owner receipt after session or journal binding changes', async () => {
    localReceipt(); await provider.evaluate(input)
    auth.session = { user: { id: 'owner-b' }, access_token: 'fixture-b' }
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    auth.session = { user: { id: 'owner-a' }, access_token: 'fixture-a' }
    await db.syncMeta.put({ id: 'owner', value: 'owner-b' })
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('warns at receipt expiry before any new paid call, and does not renew lifetime on replay', async () => {
    localReceipt(); await provider.evaluate(input)
    const pending = await pendingRow(), value = pending.value as { receivedAt: number; requestId: string }
    const now = vi.spyOn(Date, 'now').mockReturnValue(value.receivedAt + 7 * 86400000 - 1)
    await expect(provider.evaluate(input)).resolves.toEqual(evaluation)
    expect((await pendingRow()).value).toMatchObject({ receivedAt: value.receivedAt })
    now.mockReturnValue(value.receivedAt + 7 * 86400000)
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'ACCOUNT_UNCERTAIN' })
    expect(fetcher).toHaveBeenCalledOnce()
    await provider.evaluate(input)
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).requestId).not.toBe(value.requestId)
  })
  it('rejects corrupt/future receipts without silently allocating another request', async () => {
    localReceipt(); await provider.evaluate(input)
    const pending = await pendingRow()
    await db.syncMeta.put({ ...pending, value: { ...(pending.value as object), receivedAt: Date.now() + 301000 } })
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await db.syncMeta.put({ ...pending, value: { ...(pending.value as object), receipt: { value: { invalid: true } } } })
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('retains a received result in memory when local receipt persistence fails, then retries storage without paying again', async () => {
    localReceipt()
    const realPut = db.syncMeta.put.bind(db.syncMeta)
    const fail = vi.spyOn(db.syncMeta, 'put').mockImplementation((...args) => {
      if ((args[0].value as { receipt?: unknown })?.receipt) return Dexie.Promise.reject(new Error('fixture storage full'))
      return realPut(...args)
    })
    await expect(provider.evaluate(input)).rejects.toMatchObject({ code: 'USAGE' })
    expect((await pendingRow()).value).not.toHaveProperty('receipt')
    fail.mockRestore()
    await expect(provider.evaluate(input)).resolves.toEqual(evaluation)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
