import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSpeechHandler } from '../src/server/speech'
import { createAzureSpeechAdapter } from '../src/speech/azure.server'
import { GatewayError, type OwnerContext } from '../src/server/gateway'
import { encodeAssessmentWav } from '../src/speech/wav'

const owner = '00000000-0000-4000-8000-000000000501'
const reference = () => ({ user_id: owner, id: 'review-v1', material_id: null, reference_text: 'Good morning.',
  audio_url: 'https://example.invalid/reviewed.wav', source_url: 'https://example.invalid/source', audio_sha256: 'a'.repeat(64),
  rights_evidence: 'Inert fixture only. Not a certified voice.', reviewed_at: '2026-09-08T00:00:00Z', revoked_at: null,
  voice_review: { locale: 'en-US', kind: 'human', rightsApproved: true, transcriptChecked: true, clearSingleSpeaker: true,
    naturalStressAndRhythm: true, generalAmericanReviewed: true, clippingOrIntrusiveNoise: false, reviewId: 'review-v1' } })
const official = () => ({ RecognitionStatus: 'Success', Offset: 0, Duration: 10000000, NBest: [{ Confidence: 0.98503506,
  AccuracyScore: 80, FluencyScore: 70, CompletenessScore: 100, PronScore: 78, ProsodyScore: 75,
  Words: [{ Word: 'good', AccuracyScore: 60, ErrorType: 'Mispronunciation', Offset: 0, Duration: 4000000 },
    { Word: 'morning', AccuracyScore: 90, ErrorType: 'None', Offset: 4000000, Duration: 6000000 }] }] })
const wav = () => encodeAssessmentWav(new Float32Array(48000).fill(0.1))
function request(patch: Record<string, string | Blob> = {}, signal?: AbortSignal) {
  const body = new FormData()
  for (const [key, value] of Object.entries({ attemptId: 'attempt-1', recordingId: 'recording-1', referenceId: 'review-v1', audioWav: new Blob([wav()], { type: 'audio/wav' }), ...patch })) body.set(key, value)
  return new Request('https://example.invalid/functions/v1/speech-assess', { method: 'POST', body, signal })
}
type Row = Record<string, unknown>
function setup() {
  const tables: Record<string, Row[]> = { pronunciation_references: [reference()], service_preferences: [{ user_id: owner, prosody_enabled: true }], service_usage: [], service_results: [], acoustic_assessments: [] }
  const failures = new Set<string>(), calls: string[] = []
  const from = vi.fn((table: string) => {
    const filters: [string, unknown][] = []; let update: Row | undefined
    const result = () => {
      calls.push(table)
      if (failures.has(table)) return { data: null, error: { message: 'PRIVATE DATABASE DETAIL' } }
      const rows = tables[table].filter(row => filters.every(([key, value]) => row[key] === value))
      if (update) rows.forEach(row => Object.assign(row, update))
      return { data: rows, error: null }
    }
    const chain = {
      select: () => chain, eq: (key: string, value: unknown) => { filters.push([key, value]); return chain },
      is: (key: string, value: unknown) => { filters.push([key, value]); return chain }, gt: () => chain, order: () => chain, limit: () => chain,
      update: (value: Row) => { update = value; return chain },
      maybeSingle: async () => { const value = result(); return { ...value, data: value.data?.[0] ?? null } },
      insert: async (value: Row) => { calls.push(table + ':insert'); if (failures.has(table)) return { error: {} }; tables[table].push(value); return { error: null } },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    }
    return chain
  })
  const rpc = vi.fn(async (name: string, args: Row) => {
    calls.push(name)
    if (failures.has(name)) return { error: { code: name === 'reserve_service_call' ? 'P0001' : 'XX000' } }
    if (name === 'reserve_service_call') {
      let row = tables.service_usage.find(r => r.user_id === args.owner_id && r.request_id === args.request_id)
      if (row && row.fingerprint !== args.fingerprint) return { error: { code: '23505' } }
      if (!row) { row = { id: crypto.randomUUID(), user_id: args.owner_id, request_id: args.request_id, fingerprint: args.fingerprint,
        status: 'reserved', dispatch_nonce: args.claim_nonce, created_at: new Date().toISOString(), actual_usd: null, reserved_usd: args.estimated_usd }; tables.service_usage.push(row) }
      return { data: { ...row }, error: null }
    }
    const usage = tables.service_usage.find(row => row.id === args.usage_id)!
    tables.acoustic_assessments.push({ user_id: args.owner_id, attempt_id: usage.request_id, recording_id: args.recording_id, reference_id: args.reference_id, request_fingerprint: args.request_fingerprint, result: args.result })
    tables.service_results.push({ user_id: args.owner_id, request_id: usage.request_id, result: args.result })
    return { data: args.assessment_id, error: null }
  })
  const context = { ownerId: owner, admin: { from, rpc }, user: {} } as unknown as OwnerContext
  const env = vi.fn((name: string) => ({ AZURE_SPEECH_RESOURCE_NAME: 'inert-fixture', AZURE_SPEECH_KEY: 'x'.repeat(32), JOVE_SPEECH_MAX_DISPATCH_USD: '0.02' })[name])
  const fetcher = vi.fn(async () => { calls.push('provider'); return Response.json(official()) })
  const authenticate = vi.fn(async () => context)
  const handler = createSpeechHandler({ env, authenticate, provider: options => createAzureSpeechAdapter({ ...options, fetch: fetcher }) })
  return { handler, tables, failures, calls, fetcher, authenticate, env, rpc, context }
}
afterEach(() => vi.restoreAllMocks())
describe('real Fetch speech handler with official Azure response contract', () => {
  it('recovers historical private evidence without audio, active voice review, credentials or another budget hold', async () => {
    const test = setup(), result = await (await test.handler(request())).json()
    test.tables.pronunciation_references[0]!.revoked_at = '2026-09-08T01:00:00Z'; test.env.mockReturnValue(undefined)
    const recover = (recordingId: string) => new Request('https://example.invalid', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'recover', attemptId: 'attempt-1', recordingId, referenceId: 'review-v1' }) })
    expect(await (await test.handler(recover('recording-1'))).json()).toEqual(result)
    expect((await test.handler(recover('other-recording'))).status).toBe(404)
    expect(test.fetcher).toHaveBeenCalledOnce(); expect(test.tables.service_usage).toHaveLength(1)
  })
  it('validates authentication before reading speech credentials or uploading', async () => {
    const env = vi.fn<(name: string) => string | undefined>(() => undefined)
    const handler = createSpeechHandler({ env })
    expect((await handler(request())).status).toBe(401)
    expect(env.mock.calls.map(([name]) => name)).not.toContain('AZURE_SPEECH_KEY')
    const test = setup(); test.authenticate.mockRejectedValue(new GatewayError(403, 'NOT_OWNER', 'private'))
    const response = await test.handler(request()); expect(response.status).toBe(403); expect(test.fetcher).not.toHaveBeenCalled()
    expect(await response.text()).not.toContain('private')
  })
  it('derives policy on server, reserves before Azure, persists before returning, and recovers same attempt', async () => {
    const test = setup(), response = await test.handler(request()), result = await response.json()
    expect(response.status).toBe(200); expect(result).toMatchObject({ ok: true, assessmentId: expect.any(String), assessedAt: expect.any(Number) })
    expect(result.assessment.issues.length).toBeLessThanOrEqual(3)
    expect(test.calls.indexOf('reserve_service_call')).toBeLessThan(test.calls.indexOf('provider'))
    expect(test.calls.indexOf('provider')).toBeLessThan(test.calls.indexOf('complete_speech_assessment'))
    const providerOptions = test.fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(providerOptions[1].headers).get('Ocp-Apim-Subscription-Key')).toBe('x'.repeat(32))
    expect(test.tables.service_usage[0]).toMatchObject({ status: 'completed', actual_usd: null, units: 3 })
    expect(await (await test.handler(request())).json()).toEqual(result)
    expect(test.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('x'.repeat(32))
  })
  it('requires an explicit dispatch cap and rejects missing configuration without spending', async () => {
    const test = setup(); test.env.mockReturnValue(undefined)
    expect((await (await test.handler(request())).json()).ok).toBe(false)
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.tables.service_usage).toEqual([])
    test.env.mockImplementation(name => ({ AZURE_SPEECH_RESOURCE_NAME: 'fixture', AZURE_SPEECH_KEY: 'x'.repeat(32), JOVE_SPEECH_MAX_DISPATCH_USD: '0.00001' })[name])
    expect((await (await test.handler(request())).json()).error.code).toBe('CONFIGURATION')
    expect(test.tables.service_usage).toEqual([])
  })
  it.each<Record<string, string | Blob>>([{ referenceText: 'Untrusted' }, { enableProsody: 'true' }, { apiKey: 'untrusted' }, { attemptId: '../bad' }, { audioWav: new Blob(['bad'], { type: 'audio/wav' }) }])('rejects invalid or client-policy input before provider %#', async patch => {
    const test = setup(); expect((await test.handler(request(patch))).status).toBe(400); expect(test.fetcher).not.toHaveBeenCalled()
  })
  it('rejects duplicate multipart fields and oversized audio', async () => {
    const test = setup(), body = await request().formData(); body.append('attemptId', 'duplicate')
    expect((await test.handler(new Request('https://example.invalid', { method: 'POST', body }))).status).toBe(400)
    expect((await test.handler(request({ audioWav: new Blob([new Uint8Array(980000)], { type: 'audio/wav' }) }))).status).toBe(413)
    expect(test.fetcher).not.toHaveBeenCalled()
  })
  it.each(['missing', 'revoked', 'unknown-quality', 'other-owner'])('never assesses %s references', async mode => {
    const test = setup()
    if (mode === 'missing') test.tables.pronunciation_references = []
    if (mode === 'revoked') test.tables.pronunciation_references[0]!.revoked_at = '2026-09-08T01:00:00Z'
    if (mode === 'unknown-quality') (test.tables.pronunciation_references[0]!.voice_review as Row).naturalStressAndRhythm = null
    if (mode === 'other-owner') test.tables.pronunciation_references[0]!.user_id = 'other'
    expect((await test.handler(request())).status).toBe(422); expect(test.fetcher).not.toHaveBeenCalled()
  })
  it('authenticates reference discovery and returns no demo certifications', async () => {
    const test = setup(); test.tables.pronunciation_references = []
    const response = await test.handler(new Request('https://example.invalid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'references' }) }))
    expect(await response.json()).toEqual({ references: [] }); expect(test.authenticate).toHaveBeenCalled(); expect(test.fetcher).not.toHaveBeenCalled()
  })
  it('enforces budget before the provider call', async () => {
    const test = setup(); test.failures.add('reserve_service_call')
    const response = await test.handler(request()); expect(response.status).toBe(429); expect((await response.json()).error.code).toBe('BUDGET')
    expect(test.fetcher).not.toHaveBeenCalled()
  })
  it('holds unknown failed costs and requires explicit new-attempt consent, not automatic replay', async () => {
    const test = setup(); test.fetcher.mockResolvedValue(new Response('private upstream details', { status: 503 }))
    const result = await (await test.handler(request())).json()
    expect(result).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' }, retryAsNewAttempt: true })
    expect(test.tables.service_usage[0]).toMatchObject({ status: 'uncertain', actual_usd: null })
    expect(await (await test.handler(request())).json()).toEqual(result); expect(test.fetcher).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain('private upstream')
  })
  it.each([{ RecognitionStatus: 'NoMatch' }, { ...official(), NBest: [{ Confidence: 0.1, Words: [] }] }, { ...official(), apiKey: 'unsafe provider key' }])('rejects no speech, missing evidence, low-confidence or unsafe provider shape %#', async value => {
    const test = setup(); test.fetcher.mockResolvedValue(Response.json(value))
    const result = await (await test.handler(request())).json()
    expect(result.ok).toBe(false); expect(test.tables.acoustic_assessments).toHaveLength(0); expect(JSON.stringify(result)).not.toContain('unsafe provider key')
  })
  it('does not replay after persistence uncertainty, and recovers evidence after settlement failure', async () => {
    const test = setup(); test.failures.add('complete_speech_assessment')
    expect((await test.handler(request())).status).toBe(503)
    test.failures.delete('complete_speech_assessment')
    expect((await test.handler(request())).status).toBe(409); expect(test.fetcher).toHaveBeenCalledOnce()
    const next = setup(); next.failures.add('service_usage')
    expect((await next.handler(request())).status).toBe(503)
    next.failures.delete('service_usage')
    expect((await (await next.handler(request())).json()).ok).toBe(true); expect(next.fetcher).toHaveBeenCalledOnce()
  })
  it('rejects a changed waveform under a successful attempt ID and a cancelled upload', async () => {
    const test = setup(); await test.handler(request())
    const changed = encodeAssessmentWav(new Float32Array(48000).fill(0.2))
    expect((await test.handler(request({ audioWav: new Blob([changed], { type: 'audio/wav' }) }))).status).toBe(409)
    const controller = new AbortController(); controller.abort()
    expect((await test.handler(request({}, controller.signal))).status).toBe(408); expect(test.fetcher).toHaveBeenCalledOnce()
  })
})
