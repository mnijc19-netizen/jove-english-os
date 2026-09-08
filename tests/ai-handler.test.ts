import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiRequestSchema, createAIHandler } from '../src/server/ai'
import { readingRubric } from '../src/domain/longitudinal'
import { OpenRouterProvider } from '../src/ai/provider'
import { chromium } from '@playwright/test'
import { GatewayError, type OwnerContext } from '../src/server/gateway'
import { quoteAudioDispatch, quoteTextDispatch } from '../src/server/pricing'
import { encodeTranscriptionWav, transcriptionWavDuration, normalizeTranscriptionAudio } from '../src/audio/transcription'

type Row = Record<string, unknown>
const owner = '00000000-0000-4000-8000-000000000001'
const evaluation = { summary: 'Clear request.', strengths: ['Clear meaning.'], errors: [], comprehension: 0.8, accuracy: 0.8,
  fluency: null, successfulChunks: [], nextPrompt: 'Explain why.' }
const model = (id: string) => ({ id, name: id, context_length: 32000, pricing: { prompt: '0.000001', completion: '0.000002', request: '0' },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs'] })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
let ledger: Map<string, Row>, results: Map<string, unknown>, budget: number, paid: ReturnType<typeof vi.fn>, handler: ReturnType<typeof createAIHandler>
let writeResult: ReturnType<typeof vi.fn>, settleGate: ((row: Row, update: Row) => Promise<void>) | undefined
const request = (body: object, origin?: string, signal?: AbortSignal) => new Request('https://jove.example.test/functions/v1/ai', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) })
const payload = (requestId = crypto.randomUUID()) => ({ action: 'evaluate', requestId, input: { kind: 'meaning', text: 'Please bring some water.', reference: 'Ask for water.' } })
function context(): OwnerContext {
  const admin = {
    async rpc(_name: string, input: Row) {
      const key = String(input.request_id), existing = ledger.get(key)
      if (existing) return existing.fingerprint === input.fingerprint ? { data: existing, error: null } : { data: null, error: { code: '23505' } }
      const total = [...ledger.values()].reduce((n, row) => n + Number(row.actual_usd ?? row.reserved_usd), 0)
      if (total + Number(input.estimated_usd) > budget) return { data: null, error: { code: 'P0001' } }
      const row = { id: crypto.randomUUID(), user_id: owner, request_id: key, fingerprint: input.fingerprint,
        dispatch_nonce: input.claim_nonce, status: 'reserved', reserved_usd: input.estimated_usd, actual_usd: null, created_at: new Date().toISOString() }
      ledger.set(key, row)
      return { data: row, error: null }
    },
    from(table: string) {
      const filters = new Map<string, unknown>()
      let update: Row | undefined, insert: Row | undefined
      const chain = {
        select() { return chain }, eq(key: string, value: unknown) { filters.set(key, value); return chain }, gt() { return chain },
        is(key: string, value: unknown) { filters.set(key, value); return chain }, abortSignal() { return chain },
        update(value: Row) { update = value; return chain },
        insert(value: Row) { insert = value; return chain },
        async maybeSingle() { return { data: results.has(String(filters.get('request_id'))) ? { result: results.get(String(filters.get('request_id'))) } : null, error: null } },
        then(resolve: (value: { error: null | { code: string } }) => unknown) {
          return (async () => {
            if (insert) return writeResult(insert)
            if (table === 'service_usage' && update) for (const row of ledger.values()) {
              if (row.id !== filters.get('id') || row.user_id !== filters.get('user_id')) continue
              await settleGate?.(row, update)
              if ([...filters].every(([key, value]) => row[key] === value)) Object.assign(row, update)
            }
            return { error: null }
          })().then(resolve)
        },
      }
      return chain
    },
  }
  return { ownerId: owner, admin, user: {} } as unknown as OwnerContext
}
beforeEach(() => {
  ledger = new Map(); results = new Map(); budget = 10
  settleGate = undefined
  writeResult = vi.fn(async (value: Row) => { results.set(String(value.request_id), value.result); return { error: null } })
  paid = vi.fn(async () => json({ model: 'fixture/strong', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(evaluation) } }], usage: { total_tokens: 30, cost: 0.001 } }))
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/models?')) return Promise.resolve(json({ data: [model('fixture/fast'), model('fixture/strong')] }))
    return paid(url, init)
  }))
  const values: Record<string, string> = { OPENROUTER_API_KEY: 'fixture-server-key', JOVE_FAST_MODEL: 'fixture/fast', JOVE_STRONG_MODEL: 'fixture/strong' }
  handler = createAIHandler({ env: name => values[name], authenticate: async () => context() })
})
afterEach(() => vi.unstubAllGlobals())
describe('real provider adapter behind authenticated server handler', () => {
  it('rejects unexpected origins, actions, oversized text and browser-supplied keys before dispatch', async () => {
    expect((await handler(request(payload(), 'https://untrusted.invalid'))).status).toBe(403)
    expect((await handler(request({ ...payload(), apiKey: 'must-not-be-used' }))).status).toBe(400)
    expect((await handler(request({ ...payload(), action: 'admin' }))).status).toBe(400)
    expect((await handler(request({ ...payload(), input: { kind: 'meaning', text: 'x'.repeat(16001) } }))).status).toBe(400)
    expect(paid).not.toHaveBeenCalled(); expect(ledger.size).toBe(0)
  })
  it('requires actual authentication and does not leak thrown credential/provider messages', async () => {
    const unauthenticated = createAIHandler({ env: () => undefined, authenticate: async () => { throw new GatewayError(401, 'SIGN_IN', 'Sign in.') } })
    expect((await unauthenticated(request(payload()))).status).toBe(401)
    paid.mockRejectedValueOnce(new Error('fixture-server-key internal upstream detail'))
    const response = await handler(request(payload()))
    expect(response.status).toBe(503)
    expect(await response.text()).not.toMatch(/fixture-server-key|upstream detail/)
  })
  it('reserves the actual dispatch before sending and stores a private replayable result', async () => {
    const original = payload()
    const response = await handler(request(original))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ value: { ...evaluation, provenance: { provider: 'OpenRouter', model: 'fixture/strong' } } })
    expect(ledger.get(original.requestId)).toMatchObject({ actual_usd: 0, unit_name: 'logical-request', status: 'completed' })
    expect(ledger.get(`${original.requestId}:1`)).toMatchObject({ actual_usd: 0.001, status: 'completed' })
    const body = JSON.parse(paid.mock.calls[0]![1].body)
    expect(body.provider).toMatchObject({ data_collection: 'deny', max_price: { prompt: 1, completion: 2, request: 0 } })
    expect((await handler(request(original))).status).toBe(200)
    expect(paid).toHaveBeenCalledOnce()
    expect(JSON.stringify([...results.values()])).not.toContain('fixture-server-key')
  })
  it('supplies a documented synthetic TTS default without requiring per-device voice selection', async () => {
    const values: Record<string, string> = { OPENROUTER_API_KEY: 'fixture-only-key', JOVE_FAST_MODEL: 'fixture/fast', JOVE_STRONG_MODEL: 'fixture/strong' }
    const factory = vi.fn((options: ConstructorParameters<typeof OpenRouterProvider>[0]) => {
      expect(options.getSettings()).toMatchObject({ ttsModel: 'microsoft/mai-voice-2', voice: 'en-US-Harper:MAI-Voice-2' })
      return new OpenRouterProvider(options)
    })
    const configured = createAIHandler({ env: name => values[name], authenticate: async () => context(), provider: factory })
    expect((await configured(request(payload()))).status).toBe(200)
    expect(factory).toHaveBeenCalledOnce()
  })
  it('routes real adapter synthesis through current character pricing and preserves returned MP3 bytes with unknown actual cost', async () => {
    const speech = { id: 'microsoft/mai-voice-2', name: 'MAI Voice 2', context_length: 0,
      architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
      supported_voices: ['en-US-Harper:MAI-Voice-2'], pricing: { prompt: '0.000022', completion: '0', request: '0' } }
    // Four zero-data MPEG-1 Layer III frames: decodable synthetic silence,
    // not a human/speech-quality fixture or approved General American reference.
    const mp3 = new Uint8Array(4 * 417)
    for (let frame = 0; frame < 4; frame++) mp3.set([0xff, 0xfb, 0x90, 0x64], frame * 417)
    const original = { action: 'synthesize', requestId: crypto.randomUUID(), text: 'Hello, friend.' }
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/models?')) return json({ data: url.includes('output_modalities=speech') ? [speech] : [model('fixture/fast'), model('fixture/strong')] })
      return paid(url, init)
    })
    vi.stubGlobal('fetch', fetcher)
    paid.mockImplementationOnce(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/v1/audio/speech')
      expect(JSON.parse(String(init.body))).toEqual({ model: speech.id, voice: speech.supported_voices[0], input: original.text, response_format: 'mp3' })
      const reservation = ledger.get(`${original.requestId}:1`)!
      expect(reservation.status).toBe('reserved')
      expect(reservation.reserved_usd).toBeCloseTo(original.text.length * 0.000022 * 1.1 + 0.001, 7)
      return new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } })
    })
    const response = await handler(request(original)), result = await response.json()
    expect(response.status).toBe(200)
    expect(result.value.mimeType).toBe('audio/mpeg')
    expect(Uint8Array.from(atob(result.value.audioBase64), character => character.charCodeAt(0))).toEqual(mp3)
    expect(result.usage).toEqual([expect.objectContaining({ model: speech.id, purpose: 'synthesize', tokens: null, cost: null })])
    expect(ledger.get(`${original.requestId}:1`)).toMatchObject({ status: 'uncertain', actual_usd: null })
    expect(result.value).not.toHaveProperty('assessmentId')
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/models?output_modalities=speech'))).toHaveLength(2)
    if (process.env.READING_BROWSER_URL) {
      const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }), page = await browser.newPage()
      try {
        // This checks the bytes returned by the actual handler, not the app UI.
        // Avoid loading the application or contacting any configured account.
        await page.setContent('<!doctype html><title>Isolated MP3 playback</title>')
        const decoded = await page.evaluate(async base64 => {
          const context = new AudioContext()
          try {
            const buffer = await context.decodeAudioData(Uint8Array.from(atob(base64), character => character.charCodeAt(0)).buffer)
            const player = context.createBufferSource(); player.buffer = buffer; player.connect(context.destination)
            await context.resume()
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { player.stop(); reject(new Error('Decoded fixture playback stalled')) }, 2000)
              player.onended = () => { clearTimeout(timer); resolve() }; player.start()
            })
            return { duration: buffer.duration, sampleRate: buffer.sampleRate }
          } finally { await context.close() }
        }, String(result.value.audioBase64))
        expect(decoded.duration).toBeGreaterThan(0); expect(decoded.sampleRate).toBeGreaterThan(0)
      } finally { await browser.close() }
    }
    expect((await handler(request(original))).status).toBe(200)
    budget = 0
    expect((await handler(request({ ...original, requestId: crypto.randomUUID() })))).toHaveProperty('status', 429)
    expect(paid).toHaveBeenCalledOnce()
  })
  it('stops a request when its reservation would exceed budget, without a paid POST', async () => {
    budget = 0
    const response = await handler(request(payload()))
    expect(response.status).toBe(429)
    expect(paid).not.toHaveBeenCalled()
    expect([...ledger.values()].every(row => row.reserved_usd === 0)).toBe(true)
  })
  it('retains the unconfirmed hold on a dispatched network failure and does not double-charge replay', async () => {
    paid.mockRejectedValueOnce(new TypeError('fixture disconnect'))
    const original = payload()
    expect((await handler(request(original))).status).toBe(503)
    const dispatch = ledger.get(`${original.requestId}:1`)!
    expect(dispatch.status).toBe('uncertain'); expect(dispatch.actual_usd).toBeNull(); expect(Number(dispatch.reserved_usd)).toBeGreaterThan(0)
    const retry = await handler(request(original))
    expect(retry.status).toBe(409); expect(await retry.json()).toMatchObject({ error: { code: 'REQUEST_UNCERTAIN' } })
    expect(paid).toHaveBeenCalledOnce()
  })
  it('reserves each actual provider retry independently', async () => {
    paid.mockResolvedValueOnce(json({}, 503))
    const original = payload()
    expect((await handler(request(original))).status).toBe(200)
    expect(paid).toHaveBeenCalledTimes(2)
    expect(ledger.has(`${original.requestId}:1`)).toBe(true); expect(ledger.has(`${original.requestId}:2`)).toBe(true)
    expect(ledger.get(`${original.requestId}:1`)?.actual_usd).toBeNull()
    expect(ledger.get(`${original.requestId}:2`)?.actual_usd).toBe(0.001)
  })
  it('accepts the stable reading kind and forwards the complete rubric through the real adapter', async () => {
    const reading = { action: 'evaluate', requestId: crypto.randomUUID(), input: {
      kind: readingRubric.version, text: 'Sharing stories helps friends understand one another.',
      reference: 'A friend listens carefully and asks questions.', rubric: JSON.stringify(readingRubric),
    } }
    expect(aiRequestSchema.safeParse(reading).success).toBe(true)
    expect(aiRequestSchema.safeParse({ ...reading, input: { ...reading.input, kind: 'x'.repeat(81) } }).success).toBe(false)
    expect((await handler(request(reading))).status).toBe(200)
    const sent = JSON.parse(paid.mock.calls[0]![1].body)
    const data = JSON.parse(sent.messages.at(-1).content).untrustedData
    expect(data.kind).toBe(readingRubric.version)
    expect(JSON.parse(data.rubric)).toEqual(readingRubric)
    expect(JSON.parse(data.rubric).task).toContain('supporting detail')
  })
  it('retries only transient result persistence and replays without another paid request', async () => {
    writeResult.mockResolvedValueOnce({ error: { code: '08006' } })
    const original = payload()
    const response = await handler(request(original))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ value: evaluation })
    expect(writeResult).toHaveBeenCalledTimes(2)
    expect((await handler(request(original))).status).toBe(200)
    expect(paid).toHaveBeenCalledOnce()
  })
  it('recovers a committed result after its insert acknowledgement was lost', async () => {
    writeResult.mockImplementationOnce(async (row: Row) => {
      results.set(String(row.request_id), row.result)
      return { error: { code: '08006' } }
    }).mockResolvedValueOnce({ error: { code: '23505' } })
    const original = payload(), response = await handler(request(original))
    expect(response.status).toBe(200)
    expect(await response.json()).not.toHaveProperty('delivery')
    expect(writeResult).toHaveBeenCalledTimes(2)
    expect(paid).toHaveBeenCalledOnce()
  })
  it('delivers the received result with an explicit local-recovery receipt after three storage failures', async () => {
    writeResult.mockResolvedValue({ error: { code: '08006' } })
    const original = payload(), response = await handler(request(original))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ value: evaluation, delivery: { requestId: original.requestId, cache: 'unconfirmed' } })
    expect(writeResult).toHaveBeenCalledTimes(3)
    expect(ledger.get(`${original.requestId}:1`)).toMatchObject({ status: 'completed', actual_usd: 0.001 })
    expect(results.size).toBe(0)
    // A different device without that delivered receipt cannot safely regenerate.
    expect((await handler(request(original))).status).toBe(409)
    expect(paid).toHaveBeenCalledOnce()
  })
  it('finishes streamed chat with the same unconfirmed-cache delivery contract instead of dropping the answer', async () => {
    writeResult.mockResolvedValue({ error: { code: '08006' } })
    paid.mockResolvedValueOnce(new Response(
      `data: ${JSON.stringify({ model: 'fixture/fast', choices: [{ delta: { content: 'Hello, friend.' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ model: 'fixture/fast', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 10, cost: 0.001 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }))
    const original = { action: 'chat', requestId: crypto.randomUUID(), messages: [{ role: 'user', content: 'Hi.' }],
      context: { mode: 'guided', scenario: 'Greeting', level: 'A2', targets: [] }, stream: true }
    const response = await handler(request(original)), events = (await response.text()).split('\n\n')
    const last = events.filter(event => event.startsWith('data: {')).map(event => JSON.parse(event.slice(6))).at(-1)
    expect(last).toMatchObject({ result: { value: 'Hello, friend.', delivery: { requestId: original.requestId, cache: 'unconfirmed' } } })
    expect(events).toContain('data: [DONE]')
    expect(writeResult).toHaveBeenCalledTimes(3); expect(paid).toHaveBeenCalledOnce()
  })
  it('bounds stalled result writes and still delivers the received result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      writeResult.mockImplementation(() => new Promise(() => undefined))
      const running = handler(request(payload()))
      await vi.waitFor(() => expect(writeResult).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(6500)
      const response = await running
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ value: evaluation, delivery: { cache: 'unconfirmed' } })
      expect(writeResult).toHaveBeenCalledTimes(3)
      expect(paid).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it.each(['known-first', 'unknown-first'] as const)('preserves known cost during cancelled concurrent settlement: %s', async order => {
    const latch = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
    const knownStarted = latch(), unknownStarted = latch(), known = latch(), unknown = latch()
    settleGate = async (row, patch) => {
      if (!String(row.request_id).endsWith(':1')) return
      if (patch.actual_usd === null) { unknownStarted.resolve(); await unknown.promise }
      else { knownStarted.resolve(); await known.promise }
    }
    const controller = new AbortController(), original = payload()
    const running = handler(request(original, undefined, controller.signal))
    await knownStarted.promise; controller.abort(); await unknownStarted.promise
    if (order === 'known-first') {
      known.resolve()
      await vi.waitFor(() => expect(ledger.get(`${original.requestId}:1`)?.actual_usd).toBe(0.001))
      unknown.resolve()
    } else { unknown.resolve(); await running; known.resolve() }
    await running
    await vi.waitFor(() => expect(ledger.get(`${original.requestId}:1`)).toMatchObject({ status: 'completed', actual_usd: 0.001 }))
    expect(paid).toHaveBeenCalledOnce()
  })
})
describe('bounded pricing units and real PCM derivatives', () => {
  it('does not conflate token, minute, byte and character prices', () => {
    const bytes = encodeTranscriptionWav(new Float32Array(16000 * 60).fill(0.01))
    expect(transcriptionWavDuration(bytes)).toBe(60)
    let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    const quote = quoteAudioDispatch('/audio/transcriptions', { model: 'deepgram/nova-3', input_audio: { format: 'wav', data: btoa(binary) } }, () => undefined)
    expect(quote.estimateUsd).toBeCloseTo(0.0043 * 1.1 + 0.001, 7)
    expect(() => quoteAudioDispatch('/audio/speech', { input: 'Hello' }, () => undefined)).toThrow(GatewayError)
  })
  it('rejects malformed or falsely labeled WAV durations and leaves original bytes untouched', async () => {
    const bytes = encodeTranscriptionWav(new Float32Array(16000).fill(0.25)), original = new Blob([bytes], { type: 'audio/webm' })
    const derivative = await normalizeTranscriptionAudio(original)
    expect(derivative.type).toBe('audio/wav'); expect(original.type).toBe('audio/webm')
    expect(new Uint8Array(await derivative.arrayBuffer())).toEqual(bytes)
    const invalid = bytes.slice(); new DataView(invalid.buffer).setUint32(24, 8000, true)
    expect(() => transcriptionWavDuration(invalid)).toThrow()
    expect(() => encodeTranscriptionWav(new Float32Array([NaN]))).toThrow()
    expect(() => encodeTranscriptionWav(new Float32Array(16000 * 301))).toThrow()
  })
  it('reserves unseen search context and applies per-unit provider price limits', () => {
    const plain = { model: 'fixture/strong', max_tokens: 1000, messages: [{ role: 'user', content: 'hello' }] }
    const price = { id: 'fixture/strong', context_length: 32000, pricing: { prompt: 0.000001, completion: 0.000002 } }
    const search = quoteTextDispatch({ ...plain, plugins: [{ id: 'web', engine: 'exa', max_results: 3 }] }, price)
    expect(search.estimateUsd).toBeGreaterThan(quoteTextDispatch(plain, price).estimateUsd)
    expect(() => quoteTextDispatch({ ...plain, plugins: [{ id: 'web', engine: 'unknown', max_results: 3 }] }, price)).toThrow()
  })
})
