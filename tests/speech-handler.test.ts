import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
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
    const filters: [string, unknown][] = [], ordering: [string, boolean, boolean][] = []
    let update: Row | undefined, maximum: number | undefined
    const field = (row: Row, key: string) => key.split('->>').reduce<unknown>((value, part) => (value as Row)?.[part], row)
    const result = () => {
      calls.push(table)
      if (failures.has(table)) return { data: null, error: { message: 'PRIVATE DATABASE DETAIL' } }
      const rows = tables[table].filter(row => filters.every(([key, value]) => row[key] === value))
      if (update) rows.forEach(row => Object.assign(row, update))
      rows.sort((a, b) => {
        for (const [key, ascending, nullsFirst] of ordering) {
          const left = field(a, key), right = field(b, key)
          if (left == null || right == null) {
            const compared = Number(left != null) - Number(right != null)
            if (compared) return nullsFirst ? compared : -compared
            continue
          }
          const compared = String(left).localeCompare(String(right))
          if (compared) return ascending ? compared : -compared
        }
        return 0
      })
      return { data: rows.slice(0, maximum), error: null }
    }
    const chain = {
      select: () => chain, eq: (key: string, value: unknown) => { filters.push([key, value]); return chain },
      is: (key: string, value: unknown) => { filters.push([key, value]); return chain }, gt: () => chain,
      order: (key: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}) => {
        const ascending = options.ascending ?? true
        ordering.push([key, ascending, options.nullsFirst ?? !ascending]); return chain
      },
      limit: (count: number) => { maximum = count; return chain },
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
const referenceRequest = (filter: Record<string, unknown> = {}) => new Request('https://example.invalid', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'references', ...filter }),
})
describe('bounded reviewed reference discovery', () => {
  it.each([undefined, 'saved-reference'])('encodes owner, material, revocation, preferred ID and bound with the installed query builder (%s)', async preferredReferenceId => {
    const test = setup(), transport = vi.fn<typeof fetch>(async input => Response.json(new URL(String(input)).searchParams.has('id')
      ? [{ ...reference(), id: preferredReferenceId, material_id: 'current-material' }] : []))
    test.context.admin = createClient('https://unfetched.invalid', 'inert-fixture', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport },
    })
    const response = await test.handler(referenceRequest({ materialId: 'current-material', preferredReferenceId }))
    expect(response.status).toBe(200)
    expect((await response.json()).references.map((ref: { id: string }) => ref.id)).toEqual(preferredReferenceId ? [preferredReferenceId] : [])
    expect(transport).toHaveBeenCalledTimes(preferredReferenceId ? 2 : 1)
    if (preferredReferenceId) {
      const preferred = new URL(String(transport.mock.calls[0]![0]))
      expect(Object.fromEntries(preferred.searchParams)).toMatchObject({ user_id: `eq.${owner}`, material_id: 'eq.current-material',
        revoked_at: 'is.null', id: 'eq.saved-reference', limit: '1' })
    }
    const url = new URL(String(transport.mock.calls.at(-1)![0]))
    expect(url.pathname).toBe('/rest/v1/pronunciation_references')
    expect(url.searchParams.has('id')).toBe(false)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ user_id: `eq.${owner}`, material_id: 'eq.current-material',
      revoked_at: 'is.null', order: 'voice_review->>kind.asc.nullslast,id.asc', limit: '100' })
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.rpc).not.toHaveBeenCalled()
  })
  it('finds the current material after 100 earlier active owner references', async () => {
    const test = setup(), late = { ...reference(), id: 'z-late-reference', material_id: 'current-material' }
    test.tables.pronunciation_references = [...Array.from({ length: 100 }, (_, index) => ({ ...reference(), id: `a-${String(index).padStart(3, '0')}`, material_id: 'other-material' })), late]
    const global = await (await test.handler(referenceRequest())).json()
    expect(global.references).toHaveLength(100)
    expect(global.references.some((ref: { id: string }) => ref.id === late.id)).toBe(false)
    const response = await test.handler(referenceRequest({ materialId: 'current-material' }))
    expect(response.status).toBe(200)
    expect((await response.json()).references).toMatchObject([{ id: late.id, materialId: 'current-material' }])
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.rpc).not.toHaveBeenCalled()
  })
  it.each([{}, { materialId: 'current-material' }])('prioritizes human references before the 100-row bound with filter %j', async filter => {
    const test = setup(), late = { ...reference(), id: 'z-human', material_id: 'current-material' }
    test.tables.pronunciation_references = [...Array.from({ length: 100 }, (_, index) => ({ ...reference(), id: `a-${String(index).padStart(3, '0')}`, material_id: 'current-material', voice_review: { ...reference().voice_review, kind: 'synthetic' } })), late]
    const response = await test.handler(referenceRequest(filter))
    expect(response.status).toBe(200)
    const { references } = await response.json()
    expect(references).toHaveLength(100); expect(references[0]).toMatchObject({ id: late.id, voiceReview: { kind: 'human' } })
    expect(references[1].id).toBe('a-000'); expect(references[99].id).toBe('a-098')
  })
  it.each([{}, { materialId: 'current-material' }])('includes an approved saved reference beyond 100 without duplicates or losing the bound %j', async filter => {
    const test = setup(), saved = { ...reference(), id: 'z-saved', material_id: 'current-material', voice_review: { ...reference().voice_review, kind: 'synthetic' } }
    test.tables.pronunciation_references = [...Array.from({ length: 100 }, (_, index) => ({ ...reference(), id: `a-${String(index).padStart(3, '0')}`, material_id: 'current-material' })), saved]
    const response = await test.handler(referenceRequest({ ...filter, preferredReferenceId: saved.id }))
    expect(response.status).toBe(200)
    const { references } = await response.json()
    expect(references).toHaveLength(100); expect(references[0]).toMatchObject({ id: saved.id, voiceReview: { kind: 'synthetic' } })
    expect(references[1].id).toBe('a-000'); expect(references[99].id).toBe('a-098')
    test.tables.pronunciation_references = [saved, reference()]
    const small = await (await test.handler(referenceRequest({ preferredReferenceId: saved.id }))).json()
    expect(small.references.map((ref: { id: string }) => ref.id)).toEqual([saved.id, 'review-v1'])
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.rpc).not.toHaveBeenCalled()
  })
  it.each(['missing', 'revoked', 'other-owner', 'other-material'])('never grants a %s preferred reference', async mode => {
    const test = setup(), preferred = { ...reference(), id: 'saved-reference', material_id: 'current-material' } as Row
    const available = { ...reference(), id: 'available', material_id: 'current-material' }
    if (mode === 'revoked') preferred.revoked_at = '2026-09-08T01:00:00Z'
    if (mode === 'other-owner') preferred.user_id = 'another-owner'
    if (mode === 'other-material') preferred.material_id = 'another-material'
    test.tables.pronunciation_references = mode === 'missing' ? [available] : [preferred, available]
    const response = await test.handler(referenceRequest({ materialId: 'current-material', preferredReferenceId: preferred.id }))
    expect(response.status).toBe(200)
    expect((await response.json()).references).toMatchObject([{ id: available.id }])
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.rpc).not.toHaveBeenCalled()
  })
  it('fails preferred lookup without querying replacement candidates or inventing a review', async () => {
    const test = setup()
    test.tables.pronunciation_references = [{ ...reference(), material_id: 'current-material', voice_review: null }]
    const input = { materialId: 'current-material', preferredReferenceId: 'review-v1' }
    expect((await test.handler(referenceRequest(input))).status).toBe(400)
    expect(test.context.admin.from).toHaveBeenCalledOnce()
    test.failures.add('pronunciation_references')
    const response = await test.handler(referenceRequest(input))
    expect(response.status).toBe(503); expect((await response.json()).references).toBeUndefined()
    expect(test.context.admin.from).toHaveBeenCalledTimes(2)
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.rpc).not.toHaveBeenCalled()
  })
  it('keeps missing material empty and leaves unfiltered global discovery available', async () => {
    const test = setup()
    test.tables.pronunciation_references.push({ ...reference(), id: 'material-reference', material_id: 'another-material' })
    expect(await (await test.handler(referenceRequest({ materialId: 'missing-material' }))).json()).toEqual({ references: [] })
    const global = await (await test.handler(referenceRequest())).json()
    expect(global.references.map((ref: { materialId: string | null }) => ref.materialId)).toEqual(['another-material', null])
  })
  it('places null review kinds after valid candidates before the discovery cap', async () => {
    const test = setup(), current = { ...reference(), material_id: 'current-material' }
    test.tables.pronunciation_references = [
      { ...current, id: 'a-null-review', voice_review: null },
      { ...current, id: 'a-null-kind', voice_review: { ...current.voice_review, kind: null } },
      ...Array.from({ length: 100 }, (_, index) => ({ ...current, id: `b-${String(index).padStart(3, '0')}`, voice_review: { ...current.voice_review, kind: 'synthetic' } })),
      { ...current, id: 'z-human' },
    ]
    const response = await test.handler(referenceRequest({ materialId: 'current-material' }))
    expect(response.status).toBe(200)
    const { references } = await response.json()
    expect(references).toHaveLength(100); expect(references[0].id).toBe('z-human')
    expect(references.slice(1).every((ref: { voiceReview: { kind: string } }) => ref.voiceReview.kind === 'synthetic')).toBe(true)
  })
  it('reports scoped query failure without returning empty matches or querying a global fallback', async () => {
    const test = setup(); test.failures.add('pronunciation_references')
    const response = await test.handler(referenceRequest({ materialId: 'current-material' }))
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error.code).toBe('REFERENCE'); expect(body.references).toBeUndefined()
    expect(test.context.admin.from).toHaveBeenCalledOnce(); expect(test.fetcher).not.toHaveBeenCalled()
  })
  it('excludes other owners and revoked references even for the same material', async () => {
    const test = setup(), approved = { ...reference(), material_id: 'current-material' }
    test.tables.pronunciation_references = [approved, { ...approved, id: 'other-owner', user_id: 'another-owner' },
      { ...approved, id: 'revoked', revoked_at: '2026-09-08T01:00:00Z' }]
    expect((await (await test.handler(referenceRequest({ materialId: 'current-material' }))).json()).references).toMatchObject([{ id: approved.id }])
  })
  it.each([null, { ...reference().voice_review, kind: null }, { ...reference().voice_review, kind: 'unknown' },
    { ...reference().voice_review, generalAmericanReviewed: null }])('rejects null or invalid selected reviews without inventing approval %j', async voiceReview => {
    const test = setup()
    test.tables.pronunciation_references = [{ ...reference(), material_id: 'current-material', voice_review: voiceReview }]
    const response = await test.handler(referenceRequest({ materialId: 'current-material' }))
    expect(response.status).toBe(400); expect((await response.json()).references).toBeUndefined()
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.rpc).not.toHaveBeenCalled()
  })
  it.each([{ materialId: null }, { materialId: '' }, { materialId: ' ' }, { materialId: '../invalid' }, { materialId: 'a'.repeat(101) },
    { materialId: [] }, { materialId: {} }, { materialId: 42 }, { materialId: 'valid', user_id: 'another-owner' },
    { materialId: 'valid', limit: 1000 }, { materialId: 'valid', kind: 'human' },
    ...[null, '', '../invalid', 'a'.repeat(101), [], {}, 42].map(preferredReferenceId => ({ materialId: 'valid', preferredReferenceId }))])('rejects invalid or unauthorized discovery filters %j', async filter => {
    const test = setup(), response = await test.handler(referenceRequest(filter))
    expect(response.status).toBe(400); expect(test.context.admin.from).not.toHaveBeenCalled()
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.rpc).not.toHaveBeenCalled()
  })
  it.each([401, 403])('rejects unauthorized scoped discovery before any reference query (%i)', async status => {
    const test = setup(); test.authenticate.mockRejectedValue(new GatewayError(status, status === 401 ? 'SIGN_IN' : 'NOT_OWNER', 'private'))
    expect((await test.handler(referenceRequest({ materialId: 'current-material', preferredReferenceId: 'saved-reference' }))).status).toBe(status)
    expect(test.context.admin.from).not.toHaveBeenCalled(); expect(test.fetcher).not.toHaveBeenCalled(); expect(test.rpc).not.toHaveBeenCalled()
  })
})
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
    const oversized = request({ audioWav: new Blob([new Uint8Array(980000)], { type: 'audio/wav' }) })
    // A server receives multipart wire bytes, not Node's outgoing FormData
    // encoder. Node 24.20's encoder also throws after a plain reader.cancel()
    // with no app code involved. Preserve its real boundary/bytes and all
    // rejection assertions without disabling cancellation or error reporting.
    const wire = await oversized.arrayBuffer()
    expect(wire.byteLength).toBeGreaterThan(980000)
    expect((await test.handler(new Request(oversized.url, { method: 'POST', headers: oversized.headers, body: wire }))).status).toBe(413)
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
