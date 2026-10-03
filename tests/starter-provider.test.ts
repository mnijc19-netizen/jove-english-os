import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { aiRequestSchema, createAIHandler } from '../src/server/ai'
import { digestRequest, GatewayError, type OwnerContext } from '../src/server/gateway'
import { OpenRouterProvider } from '../src/ai/provider'
import { CloudProvider } from '../src/ai/cloud-provider'
import { db, JoveDatabase } from '../src/db/db'
import { defaultSettings, type StudyEvent } from '../src/domain/types'
import type { StarterAttempt } from '../src/domain/starter'

const auth = vi.hoisted(() => ({ owner: '00000000-0000-4000-8000-000000000001',
  listeners: new Set<(event: string, session: { user: { id: string } } | null) => void>() }))
vi.mock('../src/cloud/client', async () => {
  const { createPrincipalFence } = await import('../src/cloud/auth-fence')
  const sdk = {
    getSession: async () => ({ data: { session: { user: { id: auth.owner }, access_token: 'fixture-session' } }, error: null }),
    onAuthStateChange(callback: (event: string, session: { user: { id: string } } | null) => void) {
      auth.listeners.add(callback)
      return { data: { subscription: { id: 'fixture-subscription', callback, unsubscribe: () => { auth.listeners.delete(callback) } } } }
    },
  }
  return { cloudClient: { auth: sdk }, publicCloudConfig: { url: 'https://cloud.example.test', publishableKey: 'fixture-public' },
    createAuthFence: () => createPrincipalFence(sdk as unknown as Parameters<typeof createPrincipalFence>[0]) }
})

type Row = Record<string, unknown>
const owner = '00000000-0000-4000-8000-000000000001'
const otherOwner = '00000000-0000-4000-8000-000000000002'
const model = (id: string) => ({ id, name: id, context_length: 32000,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs'],
  pricing: { prompt: '0.000001', completion: '0.000002', request: '0' } })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const attempt = (patch: Partial<StarterAttempt> = {}): StarterAttempt => ({ id: 'saved-attempt', sessionId: 'starter-session',
  lessonId: 'en-starter-1', lessonVersion: 1, stage: 'express', contextId: 'en-starter-1:introduced',
  response: "Hi, I'm Jove.", prompted: true, mode: 'text', timestamp: 1000, ...patch })
const output = (evidence = "Hi, I'm Jove.") => ({ verdict: 'valid', feedbackZh: '这句话能介绍自己的名字。',
  correction: null, nextAction: 'continue', evidence })
const event = (value: StarterAttempt): StudyEvent => ({ id: value.id, sessionId: value.sessionId, type: 'STARTER_ATTEMPT',
  timestamp: value.timestamp, source: 'text', prompted: value.prompted, contextId: value.contextId,
  data: { lessonId: value.lessonId, lessonVersion: value.lessonVersion, stage: value.stage, contextId: value.contextId,
    response: value.response, mode: value.mode, ...(value.audioId ? { audioId: value.audioId } : {}) } })
const operation = (value = attempt(), userId = owner, language = 'en') => ({ user_id: userId, entity_id: value.id,
  entity_type: 'events', kind: 'put', learning_language: language, payload: { record: event(value) } })
const disputed = (value = attempt(), userId = owner, language = 'en', patch: Partial<StudyEvent> = {}) => {
  const record: StudyEvent = { id: `${value.id}:disputed`, type: 'STARTER_FEEDBACK_DISPUTED', timestamp: value.timestamp + 1,
    sessionId: value.sessionId, source: 'self-report', data: { attemptId: value.id, lessonId: value.lessonId, reason: 'learner-disagrees' }, ...patch }
  return { ...operation(value, userId, language), entity_id: record.id, payload: { record } }
}
const request = (body: object) => new Request('https://jove.example.test/functions/v1/ai', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const body = (patch: Row = {}) => ({ action: 'starterFeedback', attemptId: 'saved-attempt', learningLanguage: 'en',
  requestId: crypto.randomUUID(), ...patch })
const settings = { ...defaultSettings, strongModel: 'fixture/strong', fastModel: 'fixture/fast' }
const local = (language: 'en' | 'ja' = 'en') => new OpenRouterProvider({ learningLanguage: language,
  getKey: async () => 'fixture-key', getSettings: () => settings })
const values: Record<string, string> = { OPENROUTER_API_KEY: 'fixture-key', JOVE_STRONG_MODEL: 'fixture/strong', JOVE_FAST_MODEL: 'fixture/fast' }

let operations: ReturnType<typeof operation>[], ledger: Map<string, Row>, results: Map<string, unknown>, budget: number
let reads: { table: string; filters: Map<string, unknown> }[], cacheWritesFail: boolean
let paid: Mock<(url: string, init: RequestInit) => Promise<Response>>, fetcher: Mock<(url: string, init?: RequestInit) => Promise<Response>>
function context(principal = owner): OwnerContext {
  const admin = {
    async rpc(_name: string, input: Row) {
      const key = `${principal}:${input.request_id}`, previous = ledger.get(key)
      if (previous) return previous.fingerprint === input.fingerprint ? { data: previous, error: null } : { data: null, error: { code: '23505' } }
      const total = [...ledger.values()].filter(row => row.user_id === principal).reduce((sum, row) => sum + Number(row.actual_usd ?? row.reserved_usd), 0)
      if (total + Number(input.estimated_usd) > budget) return { data: null, error: { code: 'P0001' } }
      const row = { id: crypto.randomUUID(), user_id: principal, request_id: input.request_id, fingerprint: input.fingerprint,
        dispatch_nonce: input.claim_nonce, status: 'reserved', reserved_usd: input.estimated_usd, actual_usd: null, created_at: new Date().toISOString() }
      ledger.set(key, row)
      return { data: row, error: null }
    },
    from(table: string) {
      if (!['service_results', 'service_usage'].includes(table)) throw new Error('Elevated credentials cannot resolve learner answers')
      const filters = new Map<string, unknown>()
      let inserted: Row | undefined, updated: Row | undefined
      const chain = {
        select() { return chain }, eq(key: string, value: unknown) { filters.set(key, value); return chain },
        is(key: string, value: unknown) { filters.set(key, value); return chain }, gt() { return chain }, abortSignal() { return chain },
        insert(row: Row) { inserted = row; return chain }, update(row: Row) { updated = row; return chain },
        async maybeSingle() {
          if (table === 'service_usage') {
            const row = ledger.get(`${principal}:${filters.get('request_id')}`)
            return { data: row && [...filters].every(([key, value]) => row[key] === value) ? { fingerprint: row.fingerprint } : null, error: null }
          }
          return { data: results.has(`${principal}:${filters.get('request_id')}`)
            ? { result: results.get(`${principal}:${filters.get('request_id')}`) } : null, error: null }
        },
        then(resolve: (value: { error: null | { code: string } }) => unknown) {
          if (inserted && !cacheWritesFail) results.set(`${principal}:${inserted.request_id}`, inserted.result)
          if (updated) for (const row of ledger.values()) if ([...filters].every(([key, value]) => row[key] === value)) Object.assign(row, updated)
          return Promise.resolve({ error: inserted && cacheWritesFail ? { code: 'fixture-outage' } : null }).then(resolve)
        },
      }
      return chain
    },
  }
  const user = {
    from(table: string) {
      const filters = new Map<string, unknown>()
      reads.push({ table, filters })
      let limit = 101
      const chain = {
        select() { return chain }, eq(key: string, value: unknown) { filters.set(key, value); return chain },
        limit(value: number) { limit = value; return chain }, abortSignal() { return chain },
        then(resolve: (value: { data: ReturnType<typeof operation>[]; error: null }) => unknown) {
          const data = operations.filter(row => row.user_id === principal
            && (table === 'sync_operations' ? row.learning_language === 'en' : row.learning_language === 'ja')
            && [...filters].every(([key, value]) => row[key as keyof typeof row] === value)).slice(0, limit)
          return Promise.resolve({ data, error: null }).then(resolve)
        },
      }
      return chain
    },
  }
  return { ownerId: principal, admin, user } as unknown as OwnerContext
}
const handler = (principal = owner) => createAIHandler({ env: name => values[name], authenticate: async () => context(principal) })

beforeEach(async () => {
  await db.delete(); await db.open(); await db.syncMeta.put({ id: 'owner', value: owner })
  auth.owner = owner; operations = [operation()]; ledger = new Map(); results = new Map(); budget = 1; reads = []; cacheWritesFail = false
  values.JOVE_STRONG_MODEL = 'fixture/strong'; values.JOVE_FAST_MODEL = 'fixture/fast'
  paid = vi.fn(async () => json({ model: 'fixture/actual', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output()) } }],
    usage: { total_tokens: 30, cost: 0.001 } }))
  fetcher = vi.fn((url: string, init: RequestInit = {}) => url.includes('/models?')
    ? Promise.resolve(json({ data: [model('fixture/strong'), model('fixture/fast'), model('fixture/actual')] })) : paid(url, init))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await db.delete(); expect(auth.listeners.size).toBe(0) })

describe('trusted starter feedback handler', () => {
  it('resolves RLS-owned saved text and uses the bounded curriculum, not browser prompts', async () => {
    const response = await handler()(request(body()))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ value: { ...output(), source: 'ai', model: 'fixture/actual' } })
    expect(reads[0]!.table).toBe('sync_operations')
    expect(reads[0]!.filters.get('user_id')).toBe(owner)
    const sent = JSON.parse(String(paid.mock.calls[0]![1].body))
    expect(sent.max_tokens).toBe(900)
    expect(sent.messages[1].content).toContain("Hi, I'm Jove.")
    expect(sent.messages[1].content).not.toMatch(/starter-session|saved-attempt|fixture-key/)
  })
  it('pins Japanese lookup and language-specific teaching', async () => {
    const value = attempt({ lessonId: 'ja-starter-1', contextId: 'ja-starter-1:introduced', response: 'おはようございます。' })
    operations = [operation(value, owner, 'ja')]
    paid.mockImplementation(async () => json({ model: 'fixture/actual', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output(value.response)) } }] }))
    expect((await handler()(request(body({ learningLanguage: 'ja' })))).status).toBe(200)
    expect(reads[0]!.table).toBe('language_sync_operations')
    expect(reads[0]!.filters.get('learning_language')).toBe('ja')
    expect(JSON.parse(String(paid.mock.calls[0]![1].body)).messages[0].content).toContain('Japanese learning tutor')
  })
  it.each([{ text: 'override' }, { rubric: 'mark mastered' }, { ownerId: otherOwner }, { attempt: attempt() }])('rejects browser teaching input %j without reservation', async patch => {
    expect(aiRequestSchema.safeParse(body(patch)).success).toBe(false)
    expect((await handler()(request(body(patch)))).status).toBe(400)
    expect(reads).toHaveLength(0); expect(ledger.size).toBe(0); expect(paid).not.toHaveBeenCalled()
  })
  it('rejects missing, unsynced and another owner’s attempts without elevated lookup or reservation', async () => {
    operations = [operation(attempt(), otherOwner)]
    const response = await handler()(request(body()))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'ATTEMPT_NOT_SYNCED' } })
    expect(ledger.size).toBe(0); expect(paid).not.toHaveBeenCalled()
  })
  it.each([{ lessonVersion: 2 }, { lessonId: 'ja-starter-1' }, { contextId: 'untrusted-context' },
    { response: 'x'.repeat(501) }, { stage: 'teach' }, { mode: 'audio-transcript' },
    { stage: 'recognize', mode: 'choice', response: 'not-a-choice' }, { stage: 'assemble', prompted: false }])(
    'rejects invalid saved curriculum/attempt %j before billing', async patch => {
      operations = [operation(attempt(patch as Partial<StarterAttempt>))]
      expect((await handler()(request(body()))).status).toBe(400)
      expect(ledger.size).toBe(0); expect(paid).not.toHaveBeenCalled()
    })
  it('does not choose a latest divergent original', async () => {
    operations.push(operation(attempt({ response: 'Hi, my name is Jove.' })))
    expect((await handler()(request(body()))).status).toBe(409)
    expect(ledger.size).toBe(0); expect(paid).not.toHaveBeenCalled()
  })
  it('deduplicates equivalent copies and different-device transport IDs', async () => {
    operations.push(operation())
    const route = handler()
    expect((await route(request(body()))).status).toBe(200)
    expect((await route(request(body()))).status).toBe(200)
    expect(paid).toHaveBeenCalledOnce(); expect(ledger.size).toBe(2)
    expect([...results.keys()][0]).toContain(':starter:')
  })
  it('prevents concurrent cross-device dispatch', async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>(done => { release = done })
    paid.mockImplementation(() => pending)
    const route = handler(), first = route(request(body()))
    await vi.waitFor(() => expect(paid).toHaveBeenCalledOnce())
    expect((await route(request(body()))).status).toBe(409)
    release(json({ model: 'fixture/actual', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output()) } }], usage: { cost: 0.001 } }))
    expect((await first).status).toBe(200)
    expect((await route(request(body()))).status).toBe(200); expect(paid).toHaveBeenCalledOnce()
  })
  it('keeps owner namespaces and billing separate', async () => {
    operations.push(operation(attempt(), otherOwner))
    expect((await handler()(request(body()))).status).toBe(200)
    expect((await handler(otherOwner)(request(body()))).status).toBe(200)
    expect(paid).toHaveBeenCalledTimes(2); expect(results.size).toBe(2)
  })
  it('denies actual dispatch at zero budget and cannot bypass the hold with a new transport ID', async () => {
    budget = 0
    const route = handler()
    expect((await route(request(body()))).status).toBe(429)
    expect(paid).not.toHaveBeenCalled()
    expect((await route(request(body()))).status).toBe(409)
    expect(paid).not.toHaveBeenCalled()
  })
  it('uses the current transport ID for unconfirmed delivery and never re-dispatches during a cache outage', async () => {
    cacheWritesFail = true
    const payload = body(), route = handler(), response = await route(request(payload))
    expect(await response.json()).toMatchObject({ delivery: { requestId: payload.requestId, cache: 'unconfirmed' } })
    expect((await route(request(body()))).status).toBe(409); expect(paid).toHaveBeenCalledOnce()
  })
  it('rebinds a cached delivery envelope to the requesting transport identity', async () => {
    const route = handler()
    await route(request(body()))
    const key = [...results.keys()][0]!
    results.set(key, { ...results.get(key) as Row, delivery: { requestId: crypto.randomUUID(), cache: 'unconfirmed' } })
    const payload = body(), response = await route(request(payload))
    expect(await response.json()).toMatchObject({ delivery: { requestId: payload.requestId } }); expect(paid).toHaveBeenCalledOnce()
  })
  it('rejects invalid provider output after accounting, without retry or cached teaching', async () => {
    paid.mockImplementation(async () => json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...output(), evidence: 'invented answer' }) } }], usage: { cost: 0.001 } }))
    const route = handler()
    expect((await route(request(body()))).status).toBe(503)
    expect(results.size).toBe(0); expect(paid).toHaveBeenCalledOnce()
    expect([...ledger.values()].some(row => row.actual_usd === 0.001)).toBe(true)
    expect((await route(request(body()))).status).toBe(409); expect(paid).toHaveBeenCalledOnce()
  })
  it('rejects unauthenticated requests before learner lookup', async () => {
    const route = createAIHandler({ env: () => undefined, authenticate: async () => { throw new GatewayError(401, 'SIGN_IN', 'Sign in.') } })
    expect((await route(request(body()))).status).toBe(401); expect(reads).toHaveLength(0); expect(paid).not.toHaveBeenCalled()
  })
  it('does not reserve or silently fall back when an older injected adapter lacks starter feedback', async () => {
    const provider = local()
    const legacy = { evaluate: provider.evaluate.bind(provider), chat: provider.chat.bind(provider), lookup: provider.lookup.bind(provider),
      analyzeMaterial: provider.analyzeMaterial.bind(provider), generateMaterial: provider.generateMaterial.bind(provider),
      discover: provider.discover.bind(provider), transcribe: provider.transcribe.bind(provider), synthesize: provider.synthesize.bind(provider),
      takeNotices: provider.takeNotices.bind(provider), testConnection: provider.testConnection.bind(provider) }
    const route = createAIHandler({ env: name => values[name], authenticate: async () => context(), provider: () => legacy })
    expect((await route(request(body()))).status).toBe(503)
    expect(ledger.size).toBe(0); expect(paid).not.toHaveBeenCalled()
  })
})

describe('one independent starter review', () => {
  const reviewBody = () => body({ review: true })
  const reviewCompletion = (actual = 'fixture/fast', evidence = "Hi, I'm Jove.") => json({ model: actual,
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output(evidence)) } }], usage: { cost: 0.001 } })
  async function ready() {
    const route = handler()
    expect((await route(request(body()))).status).toBe(200)
    operations.push(disputed())
    paid.mockImplementation(async () => reviewCompletion())
    return route
  }
  it.each([{ revision: 2 }, { feedbackRevision: 3 }, { review: 2 }, { review: true, revision: 3 }])(
    'does not let client revisions choose additional billing rounds %j', async patch => {
      expect((await handler()(request(body(patch)))).status).toBe(400)
      expect(ledger.size).toBe(0); expect(paid).not.toHaveBeenCalled()
    })
  it('rejects review without an owned synced dispute before reserving or dispatching', async () => {
    const route = handler()
    expect((await route(request(body()))).status).toBe(200)
    operations.push(disputed(attempt(), otherOwner))
    const response = await route(request(reviewBody()))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'REVIEW_NOT_DISPUTED' } })
    expect(ledger.size).toBe(2); expect(paid).toHaveBeenCalledOnce()
  })
  it('requires confirmed first account feedback rather than jumping straight to round two', async () => {
    operations.push(disputed())
    const response = await handler()(request(reviewBody()))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'REVIEW_NOT_READY' } })
    expect(ledger.size).toBe(0); expect(paid).not.toHaveBeenCalled()
  })
  it.each([{ type: 'STARTER_FEEDBACK' }, { source: 'ai' }, { sessionId: 'other-session' }, { timestamp: 999 },
    { timestamp: 253402300799999 }, { data: { attemptId: 'other-attempt', lessonId: 'en-starter-1', reason: 'learner-disagrees' } },
    { data: { attemptId: 'saved-attempt', lessonId: 'ja-starter-1', reason: 'learner-disagrees' } },
    { data: { attemptId: 'saved-attempt', lessonId: 'en-starter-1', reason: 'override' } }])(
    'rejects a dispute not strictly bound to the original attempt %j', async patch => {
      const route = handler()
      expect((await route(request(body()))).status).toBe(200)
      operations.push(disputed(attempt(), owner, 'en', patch as Partial<StudyEvent>))
      expect((await route(request(reviewBody()))).status).toBe(400)
      expect(ledger.size).toBe(2); expect(paid).toHaveBeenCalledOnce()
    })
  it('does not arbitrate divergent dispute originals', async () => {
    const route = await ready()
    operations.push(disputed(attempt(), owner, 'en', { timestamp: 1002 }))
    expect((await route(request(reviewBody()))).status).toBe(409)
    expect(ledger.size).toBe(2); expect(paid).toHaveBeenCalledOnce()
  })
  it('requires the original first-round ledger fingerprint even if old evidence still matches', async () => {
    const route = await ready()
    operations[0] = operation(attempt({ response: "Hi, I'm Jove. Hi." }))
    const response = await route(request(reviewBody()))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'ATTEMPT_CONFLICT' } })
    expect(ledger.size).toBe(2); expect(paid).toHaveBeenCalledOnce()
  })
  it('binds exactly two canonical rounds and caches repeated reviews regardless of transport UUID', async () => {
    const route = await ready()
    operations.push(disputed())
    for (let count = 0; count < 3; count++) {
      const response = await route(request(reviewBody()))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ value: { source: 'ai', model: 'fixture/fast' } })
    }
    expect((await route(request(body({ review: false })))).status).toBe(200)
    const roundIds = await Promise.all([1, 2].map(async round => `starter:${await digestRequest(JSON.stringify([owner, 'en', 'saved-attempt', round]))}`))
    expect([...results.keys()].sort()).toEqual(roundIds.map(id => `${owner}:${id}`).sort())
    expect(ledger.size).toBe(4); expect(paid).toHaveBeenCalledTimes(2)
    expect(paid.mock.calls.map(([, init]) => JSON.parse(String(init.body)).model)).toEqual(['fixture/strong', 'fixture/fast'])
    const prompt = JSON.parse(String(paid.mock.calls[1]![1].body)).messages
    expect(prompt[0].content).toContain('Independently recheck')
    expect(prompt[1].content).not.toContain('fixture/actual') // No first verdict/model anchoring.
  })
  it('concurrent review transports cannot dispatch two independent reviews', async () => {
    const route = await ready()
    let release!: (response: Response) => void
    paid.mockImplementation(() => new Promise<Response>(resolve => { release = resolve }))
    const first = route(request(reviewBody()))
    await vi.waitFor(() => expect(paid).toHaveBeenCalledTimes(2))
    expect((await route(request(reviewBody()))).status).toBe(409)
    release(reviewCompletion())
    expect((await first).status).toBe(200)
    expect((await route(request(reviewBody()))).status).toBe(200)
    expect(paid).toHaveBeenCalledTimes(2)
  })
  it('rebinds second-round cached receipts to the requesting transport UUID', async () => {
    const route = await ready()
    await route(request(reviewBody()))
    const id = `starter:${await digestRequest(JSON.stringify([owner, 'en', 'saved-attempt', 2]))}`, key = `${owner}:${id}`
    results.set(key, { ...results.get(key) as Row, delivery: { requestId: crypto.randomUUID(), cache: 'unconfirmed' } })
    const payload = reviewBody(), response = await route(request(payload))
    expect(await response.json()).toMatchObject({ delivery: { requestId: payload.requestId } })
    expect(paid).toHaveBeenCalledTimes(2)
  })
  it.each(['fixture/strong', 'fixture/actual'])('rejects fast model %s already used or configured for the first judgment before reservation', async fast => {
    const route = await ready()
    values.JOVE_FAST_MODEL = fast
    expect((await route(request(reviewBody()))).status).toBe(503)
    expect(ledger.size).toBe(2); expect(paid).toHaveBeenCalledOnce()
  })
  it('does not substitute strong when the configured review model is unavailable', async () => {
    const route = await ready()
    fetcher.mockImplementation((url, init = {}) => url.includes('/models?')
      ? Promise.resolve(json({ data: [model('fixture/strong'), model('fixture/actual')] })) : paid(url, init))
    expect((await route(request(reviewBody()))).status).toBe(503)
    expect((await route(request(reviewBody()))).status).toBe(409)
    expect(paid).toHaveBeenCalledOnce()
  })
  it('requires real first-model provenance before incurring review cost', async () => {
    paid.mockImplementation(async () => json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output()) } }], usage: { cost: 0.001 } }))
    const route = handler()
    expect((await route(request(body()))).status).toBe(200)
    operations.push(disputed())
    const response = await route(request(reviewBody()))
    expect(await response.json()).toMatchObject({ error: { code: 'REVIEW_MODEL_UNVERIFIED' } })
    expect(ledger.size).toBe(2); expect(paid).toHaveBeenCalledOnce()
  })
  it('rejects a review transport actually returning the first model and never pays for a third round', async () => {
    const route = await ready()
    paid.mockImplementation(async () => reviewCompletion('fixture/actual'))
    const response = await route(request(reviewBody()))
    expect(await response.json()).toMatchObject({ error: { code: 'REVIEW_MODEL_UNVERIFIED' } })
    expect(results.size).toBe(1)
    expect([...ledger.values()].filter(row => row.actual_usd === 0.001)).toHaveLength(2)
    expect((await route(request(reviewBody()))).status).toBe(409); expect(paid).toHaveBeenCalledTimes(2)
  })
  it('reserves a separate second-round budget and blocks replay after denial', async () => {
    const route = await ready()
    budget = 0.001
    expect((await route(request(reviewBody()))).status).toBe(429)
    expect((await route(request(reviewBody()))).status).toBe(409)
    expect(paid).toHaveBeenCalledOnce()
  })
  it('keeps Japanese dispute authorization in its own RLS stream', async () => {
    const value = attempt({ lessonId: 'ja-starter-1', contextId: 'ja-starter-1:introduced', response: 'おはようございます。' })
    operations = [operation(value, owner, 'ja')]
    paid.mockImplementation(async () => reviewCompletion('fixture/actual', value.response))
    const route = handler(), payload = () => body({ learningLanguage: 'ja' })
    expect((await route(request(payload()))).status).toBe(200)
    operations.push(disputed(value, owner, 'en'))
    expect((await route(request({ ...payload(), review: true }))).status).toBe(409)
    operations.push(disputed(value, owner, 'ja'))
    paid.mockImplementation(async () => reviewCompletion('fixture/fast', value.response))
    expect((await route(request({ ...payload(), review: true }))).status).toBe(200)
    expect(reads.filter(read => read.filters.get('entity_id') === `${value.id}:disputed`).every(read =>
      read.table === 'language_sync_operations' && read.filters.get('user_id') === owner && read.filters.get('learning_language') === 'ja')).toBe(true)
    expect(paid).toHaveBeenCalledTimes(2)
  })
})

describe('starter provider contracts', () => {
  it('BYOK validates its lesson and attempt before any network call', async () => {
    await expect(local().starterFeedback(attempt({ lessonVersion: 2 }))).rejects.toMatchObject({ code: 'INPUT' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([400, 404, 422, 429, 503])('does not automatically retry a paid starter response %s', async status => {
    paid.mockImplementation(async () => json({}, status))
    await expect(local().starterFeedback(attempt())).rejects.toBeDefined()
    expect(paid).toHaveBeenCalledOnce()
  })
  it('BYOK reports actual transport model, not a model field authored inside JSON', async () => {
    const feedback = await local().starterFeedback(attempt())
    expect(feedback).toMatchObject({ source: 'ai', model: 'fixture/actual' })
    paid.mockImplementation(async () => json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...output(), model: 'fabricated' }) } }] }))
    await expect(local().starterFeedback(attempt())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('cloud sends only attempt identity and checks returned teaching against its saved attempt', async () => {
    fetcher.mockImplementation(async () => json({ value: { ...output(), source: 'ai', model: 'fixture/actual' }, usage: [], notices: [] }))
    const provider = new CloudProvider(local(), async () => {})
    expect(await provider.starterFeedback(attempt())).toMatchObject({ verdict: 'valid', source: 'ai' })
    const sent = JSON.parse(String(fetcher.mock.calls[0]![1]!.body))
    expect(Object.keys(sent).sort()).toEqual(['action', 'attemptId', 'learningLanguage', 'requestId'])
    expect(sent).toMatchObject({ action: 'starterFeedback', attemptId: 'saved-attempt', learningLanguage: 'en' })
    expect(JSON.stringify(sent)).not.toContain("Hi, I'm Jove.")
    expect((await provider.starterFeedback(attempt())).source).toBe('ai')
    expect(fetcher).toHaveBeenCalledTimes(2) // Server canonical identity supplies the cached result.
  })
  it('cloud adds only the explicit review flag and preserves the old signal argument', async () => {
    fetcher.mockImplementation(async () => json({ value: { ...output(), source: 'ai', model: 'fixture/fast' }, usage: [], notices: [] }))
    const provider = new CloudProvider(local(), async () => {})
    const signal = new AbortController().signal
    expect(await provider.starterFeedback(attempt(), signal, { review: true })).toMatchObject({ model: 'fixture/fast' })
    const sent = JSON.parse(String(fetcher.mock.calls[0]![1]!.body))
    expect(Object.keys(sent).sort()).toEqual(['action', 'attemptId', 'learningLanguage', 'requestId', 'review'])
    expect(sent.review).toBe(true); expect(JSON.stringify(sent)).not.toContain("Hi, I'm Jove.")
  })
  it('BYOK explicitly routes review to fast with transport provenance and no anchoring', async () => {
    paid.mockImplementation(async () => json({ model: 'fixture/fast', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output()) } }] }))
    expect(await local().starterFeedback(attempt(), undefined, { review: true })).toMatchObject({ source: 'ai', model: 'fixture/fast' })
    const sent = JSON.parse(String(paid.mock.calls[0]![1].body))
    expect(sent.model).toBe('fixture/fast'); expect(sent.max_tokens).toBe(900)
    expect(sent.messages[0].content).toContain('Independently recheck')
    expect(paid).toHaveBeenCalledOnce()
  })
  it.each([400, 404, 422, 429, 503])('never automatically retries a paid review response %s', async status => {
    paid.mockImplementation(async () => json({}, status))
    await expect(local().starterFeedback(attempt(), undefined, { review: true })).rejects.toBeDefined()
    expect(paid).toHaveBeenCalledOnce()
  })
  it('rejects review without a real transport model rather than inventing provenance', async () => {
    paid.mockImplementation(async () => json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output()) } }] }))
    await expect(local().starterFeedback(attempt(), undefined, { review: true })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(paid).toHaveBeenCalledOnce()
  })
  it('cloud keeps Japanese ownership and wire language separate', async () => {
    const ja = new JoveDatabase(`starter-provider-ja-${crypto.randomUUID()}`, 'ja')
    try {
      await ja.syncMeta.put({ id: 'owner', value: owner })
      const value = attempt({ lessonId: 'ja-starter-1', contextId: 'ja-starter-1:introduced', response: 'おはようございます。' })
      fetcher.mockImplementation(async () => json({ value: { ...output(value.response), source: 'ai' }, usage: [], notices: [] }))
      const provider = new CloudProvider(local('ja'), async () => {}, ja)
      expect((await provider.starterFeedback(value)).source).toBe('ai')
      expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).learningLanguage).toBe('ja')
      await db.syncMeta.put({ id: 'owner', value: otherOwner })
      await expect(provider.starterFeedback(value)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
      expect(fetcher).toHaveBeenCalledOnce()
    } finally { await ja.delete() }
  })
})
