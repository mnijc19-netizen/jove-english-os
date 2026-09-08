import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAzureSpeechAdapter } from '../src/speech/azure.server'
import { compareAcousticAttempts, encodeAssessmentWav, inspectAssessmentWav, normalizeAzureAssessment, recordingToAssessmentWav, referenceVoiceEligible, SPEECH_LIMITS } from '../src/speech'
import type { AcousticRequest, AssessmentContext, ReferenceVoiceReview } from '../src/speech'

// Shape and sample values from Microsoft's REST documentation, fetched 2026-09-08:
// https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short
function restFixture() {
  return { RecognitionStatus: 'Success', Offset: 700000, Duration: 8400000, DisplayText: 'Good morning.', SNR: 38.76819,
    NBest: [{ Confidence: 0.98503506, Lexical: 'good morning', ITN: 'good morning', MaskedITN: 'good morning', Display: 'Good morning.',
      AccuracyScore: 100, FluencyScore: 100, ProsodyScore: 87.8, CompletenessScore: 100, PronScore: 95.1,
      Words: [{ Word: 'good', Offset: 700000, Duration: 2600000, Confidence: 0, AccuracyScore: 100, ErrorType: 'None',
        Feedback: { Prosody: { Break: { ErrorTypes: ['None'], BreakLength: 0 }, Intonation: { ErrorTypes: [], Monotone: { Confidence: 0, WordPitchSlopeConfidence: 0, SyllablePitchDeltaConfidence: 0.91385907 } } } } },
      { Word: 'morning', Offset: 3400000, Duration: 5700000, Confidence: 0, AccuracyScore: 100, ErrorType: 'None' }] }],
  }
}
// SDK nested pronunciation JSON; preserved provider values, not inferred from transcript.
// https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment
function sdkFixture() {
  return { RecognitionStatus: 0, Offset: 7500000, Duration: 13800000,
    NBest: [{ Confidence: 0.975003, Display: 'Hello.', PronunciationAssessment: { AccuracyScore: 100, FluencyScore: 100, CompletenessScore: 100, PronScore: 100 },
      Words: [{ Word: 'hello', Offset: 7500000, Duration: 13800000, PronunciationAssessment: { AccuracyScore: 99, ErrorType: 'None' },
        Syllables: [{ Syllable: 'hɛ', Offset: 7500000, Duration: 4100000, PronunciationAssessment: { AccuracyScore: 91 } }, { Syllable: 'loʊ', Offset: 11700000, Duration: 9600000, PronunciationAssessment: { AccuracyScore: 100 } }],
        Phonemes: [{ Phoneme: 'h', Offset: 7500000, Duration: 3500000, PronunciationAssessment: { AccuracyScore: 98, NBestPhonemes: [{ Phoneme: 'h', Score: 100 }] } },
          { Phoneme: 'ɛ', Offset: 11100000, Duration: 500000, PronunciationAssessment: { AccuracyScore: 47 } }] }] }],
  }
}
const context: AssessmentContext = { attemptId: 'attempt-1', recordingId: 'recording-1', referenceId: 'greeting-v1', referenceSha256: 'a'.repeat(64), audioSeconds: 3, prosodyRequested: true }
function wav(seconds = 3) { return encodeAssessmentWav(Float32Array.from({ length: seconds * 16000 }, (_, i) => Math.sin(i / 12) * 0.2)) }
function request(): AcousticRequest { return { attemptId: 'attempt-1', recordingId: 'recording-1', referenceId: 'greeting-v1', referenceText: 'Good morning.', locale: 'en-US', audioWav: wav(), enableProsody: true } }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }) }
// Generated inert test credential; no real credential is used or loaded from the environment.
const testCredential = () => 'x'.repeat(32)
function adapter(fetcher: typeof fetch, overrides: Partial<Parameters<typeof createAzureSpeechAdapter>[0]> = {}) {
  return createAzureSpeechAdapter({ resourceName: 'unit-test-speech', getCredentials: async () => ({ subscriptionKey: testCredential() }), fetch: fetcher, ...overrides })
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Azure acoustic evidence boundary', () => {
  it('accepts official flattened REST fields and ignores per-word zero recognition placeholders', () => {
    const result = normalizeAzureAssessment(restFixture(), context)
    expect(result.scores).toEqual({ accuracy: 100, fluency: 100, completeness: 100, prosody: 87.8, pronunciation: 95.1 })
    expect(result.words[0]).toMatchObject({ label: 'good', accuracy: 100, offsetMs: 70, durationMs: 260 })
    expect(result.recognitionConfidence).toBe(0.98503506)
    expect(result.issues).toEqual([])
    expect(result.raw.NBest[0]).not.toHaveProperty('ITN')
    expect(result.words[0].phonemes).toEqual([])
  })
  it('accepts official SDK nested fields, phonemes and syllables with precise provenance', () => {
    const result = normalizeAzureAssessment(sdkFixture(), context)
    expect(result.words[0].phonemes[1]).toMatchObject({ label: 'ɛ', accuracy: 47, offsetMs: 1110, durationMs: 50 })
    expect(result.words[0].syllables).toHaveLength(2)
    expect(result.scores.prosody).toBeNull()
    expect(result.issues).toEqual([{ kind: 'phoneme', wordIndex: 0, cue: expect.any(String), provenance: { provider: 'azure-speech', path: 'NBest[0].Words[0].Phonemes[1].PronunciationAssessment.AccuracyScore', value: 47 } }])
  })
  it('preserves missing evidence as null and does not calculate overall score', () => {
    const raw = restFixture()
    const best = raw.NBest[0] as Record<string, unknown>
    delete best.FluencyScore; delete best.ProsodyScore; delete best.PronScore; delete best.CompletenessScore
    const result = normalizeAzureAssessment(raw, context)
    expect(result.scores).toEqual({ accuracy: 100, fluency: null, completeness: null, prosody: null, pronunciation: null })
  })
  it('does not expose unrequested prosody as assessed', () => {
    expect(normalizeAzureAssessment(restFixture(), { ...context, prosodyRequested: false }).scores.prosody).toBeNull()
  })
  it.each(['NoMatch', 'InitialSilenceTimeout', 'BabbleTimeout', 'EndOfDictation'])('rejects %s', RecognitionStatus => {
    expect(() => normalizeAzureAssessment({ RecognitionStatus }, context)).toThrow(expect.objectContaining({ code: 'NO_SPEECH' }))
  })
  it('rejects transcript-only STT even with high confidence', () => {
    expect(() => normalizeAzureAssessment({ RecognitionStatus: 'Success', Offset: 0, Duration: 10000000, NBest: [{ Confidence: 0.99, Display: 'Good morning.' }] }, context)).toThrow(expect.objectContaining({ code: 'NO_EVIDENCE' }))
  })
  it('does not treat completeness or an overall score alone as acoustic evidence', () => {
    expect(() => normalizeAzureAssessment({ RecognitionStatus: 'Success', Offset: 0, Duration: 10000000, NBest: [{ Confidence: 0.99, CompletenessScore: 100, PronScore: 99 }] }, context)).toThrow(expect.objectContaining({ code: 'NO_EVIDENCE' }))
  })
  it.each([0, 0.49, undefined])('rejects insufficient recognition confidence %s', Confidence => {
    const raw = restFixture(); Object.assign(raw.NBest[0], { Confidence })
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(expect.objectContaining({ code: 'LOW_CONFIDENCE' }))
  })
  it('does not choose a later high-confidence hypothesis to bypass the gate', () => {
    const raw = restFixture(); raw.NBest.push(structuredClone(raw.NBest[0])); raw.NBest[0].Confidence = 0.1
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(expect.objectContaining({ code: 'LOW_CONFIDENCE' }))
  })
  it.each([-1, 101, NaN, Infinity, '90', null])('rejects malformed score %s', AccuracyScore => {
    const raw = restFixture(); Object.assign(raw.NBest[0], { AccuracyScore })
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })
  it('rejects inconsistent flat/nested scores', () => {
    const raw = restFixture(); Object.assign(raw.NBest[0], { PronunciationAssessment: { AccuracyScore: 2 } })
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })
  it('rejects impossible timestamps and zero speech duration', () => {
    const raw = restFixture(); raw.Duration = 0
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(expect.objectContaining({ code: 'NO_SPEECH' }))
    raw.Duration = 300000000
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })
  it.each(['Offset', 'Duration'] as const)('rejects an out-of-recording %s when its partner is missing', key => {
    const raw = restFixture()
    const word = raw.NBest[0].Words[0] as Record<string, unknown>
    word[key] = 200000000
    delete word[key === 'Offset' ? 'Duration' : 'Offset']
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })
  it('rejects zero-duration phoneme evidence rather than issuing a sound correction', () => {
    const raw = sdkFixture(); raw.NBest[0].Words[0].Phonemes[1].Duration = 0
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(expect.objectContaining({ code: 'NO_EVIDENCE' }))
  })
  it('preserves valid partial timestamps as unknown rather than inventing their partner', () => {
    const raw = restFixture(); delete (raw.NBest[0].Words[0] as Partial<typeof raw.NBest[0]['Words'][0]>).Duration
    expect(normalizeAzureAssessment(raw, context).words[0]).toMatchObject({ offsetMs: 70, durationMs: null })
  })
  it.each(['__proto__', 'constructor', 'prototype', 'apiKey', 'Authorization', 'subscriptionKey', 'access_token', 'secret', 'credentials'])('rejects unsafe nested key %s, even in discarded metadata', key => {
    const raw = restFixture(); Object.assign(raw, { metadata: JSON.parse(`{"${key}":"discard-me"}`) })
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })
  it('rejects accessors without invoking them', () => {
    const raw = restFixture(); const getter = vi.fn(); Object.defineProperty(raw, 'metadata', { get: getter, enumerable: true })
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(); expect(getter).not.toHaveBeenCalled()
  })
  it('rejects context metadata and credentials rather than copying them into results', () => {
    expect(() => normalizeAzureAssessment(restFixture(), { ...context, apiKey: 'untrusted' } as AssessmentContext)).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
    expect(() => normalizeAzureAssessment(restFixture(), { ...context, debug: 'untrusted' } as AssessmentContext)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => normalizeAzureAssessment(restFixture(), { ...context, prosodyRequested: 'true' } as unknown as AssessmentContext)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })
  it('rejects unsupported structures, cycles and excessive nested input safely', () => {
    for (const raw of [null, [], { RecognitionStatus: 'Success' }, { ...restFixture(), NBest: [] }]) expect(() => normalizeAzureAssessment(raw, context)).toThrow()
    const raw = restFixture(); Object.assign(raw, { cycle: raw })
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })
  it('keeps omissions as alignment flags, never phoneme measurements', () => {
    const raw = restFixture(); raw.NBest[0].Words[0].ErrorType = 'Omission'
    const result = normalizeAzureAssessment(raw, context)
    expect(result.words[0]).toMatchObject({ accuracy: null, offsetMs: null, phonemes: [], syllables: [] })
    expect(result.issues[0].provenance.value).toBe('Omission')
    raw.NBest[0].Words[1].ErrorType = 'Omission'
    expect(() => normalizeAzureAssessment(raw, context)).toThrow(expect.objectContaining({ code: 'NO_EVIDENCE' }))
  })
  it('caps feedback at three distinct targets and attaches raw values', () => {
    const raw = restFixture()
    raw.NBest[0].Words = Array.from({ length: 6 }, (_, i) => ({ ...raw.NBest[0].Words[0], Word: `word${i}`, AccuracyScore: 20 + i, ErrorType: 'Mispronunciation' }))
    raw.NBest[0].FluencyScore = 30
    const result = normalizeAzureAssessment(raw, context)
    expect(result.issues).toHaveLength(3)
    expect(new Set(result.issues.map(i => i.wordIndex)).size).toBe(3)
    expect(result.issues.every(i => i.provenance.value === 'Mispronunciation')).toBe(true)
  })
})

describe('server transport and recoverable usage', () => {
  it('sends an actual REST POST with server header credentials, exact WAV and encoded configuration', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(restFixture()))
    const source = request(); const original = source.audioWav.slice()
    const result = await adapter(fetcher).assess(source)
    expect(result.ok).toBe(true)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://unit-test-speech.cognitiveservices.azure.com/stt/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', body: original })
    const headers = new Headers(init?.headers)
    expect(headers.get('Ocp-Apim-Subscription-Key')).toBe(testCredential())
    expect(JSON.parse(atob(headers.get('Pronunciation-Assessment')!))).toEqual({ ReferenceText: 'Good morning.', GradingSystem: 'HundredMark', Granularity: 'Phoneme', Dimension: 'Comprehensive', EnableMiscue: 'True', EnableProsodyAssessment: 'True' })
    expect(source.audioWav).toEqual(original)
    expect(result.usage).toEqual(['azure.speech.pronunciation', 'azure.speech.prosody'].map(service => ({ service, requests: 1, submittedAudioSeconds: 3, estimatedBillableSeconds: 3, actualCostUsd: null, billingStatus: 'unknown' })))
    expect(JSON.stringify(result)).not.toContain(testCredential())
  })
  it('rejects browser use before loading credentials', () => {
    vi.stubGlobal('window', {})
    expect(() => adapter(vi.fn())).toThrow(expect.objectContaining({ code: 'SERVER_ONLY' }))
  })
  it('allows legacy Deno window without a document, but never a browser DOM', async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('Deno', { version: { deno: '1.46.3' }, serve: () => {} })
    const fetcher = vi.fn(async () => json(restFixture()))
    expect((await adapter(fetcher).assess(request())).ok).toBe(true)
    vi.stubGlobal('document', {})
    expect(() => adapter(fetcher)).toThrow(expect.objectContaining({ code: 'SERVER_ONLY' }))
  })
  it.each(['https://evil.example', 'valid.azure.com@evil.example', '../other', 'x\r\nauth', 'azure.com/path'])('rejects unsafe endpoint configuration %s', resourceName => {
    expect(() => adapter(vi.fn(), { resourceName })).toThrow(expect.objectContaining({ code: 'CONFIGURATION' }))
  })
  it.each(['apiKey', 'key', 'endpoint', 'settings', '__proto__'])('rejects client request key %s before credentials/network', async key => {
    const fetcher = vi.fn(); const credentials = vi.fn()
    const source = { ...request(), ...JSON.parse(`{"${key}":"untrusted"}`) }
    expect(await adapter(fetcher, { getCredentials: credentials }).assess(source)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' }, usage: [{ requests: 0 }] })
    expect(fetcher).not.toHaveBeenCalled(); expect(credentials).not.toHaveBeenCalled()
  })
  it('rejects unsupported locale, oversized reference and non-WAV inputs', async () => {
    const fetcher = vi.fn()
    for (const patch of [{ locale: 'en-GB' }, { referenceText: 'a'.repeat(SPEECH_LIMITS.maxReferenceBytes + 1) }, { audioWav: new Uint8Array([1, 2, 3]) }, { referenceText: '<speak>hello</speak>' }, { enableProsody: 'true' }]) {
      const result = await adapter(fetcher).assess({ ...request(), ...patch } as AcousticRequest)
      expect(result.ok).toBe(false)
      expect(result.usage[0].requests).toBe(0)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('sanitizes credential failures and invalid header characters', async () => {
    const fetcher = vi.fn()
    for (const getCredentials of [async () => { throw new Error('sensitive credential text') }, async () => ({ subscriptionKey: 'unsafe\r\nheader' })]) {
      const result = await adapter(fetcher, { getCredentials }).assess(request())
      expect(result).toMatchObject({ ok: false, error: { code: 'CONFIGURATION' } })
      expect(JSON.stringify(result)).not.toContain('sensitive'); expect(JSON.stringify(result)).not.toContain('unsafe')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([[401, 'AUTH'], [403, 'AUTH'], [400, 'PROVIDER_ERROR'], [429, 'RATE_LIMIT'], [500, 'UNAVAILABLE'], [503, 'UNAVAILABLE'], [302, 'PROVIDER_ERROR']])('normalizes HTTP %s without reflecting the raw body', async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private provider diagnostic', { status: status as number }))
    const result = await adapter(fetcher).assess(request())
    expect(result).toMatchObject({ ok: false, error: { code, recoverable: true } })
    expect(result.usage[0].requests).toBe(1)
    expect(JSON.stringify(result)).not.toContain('private')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('reports network errors safely and does not auto-replay potentially billed audio', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private URL and key'))
    const result = await adapter(fetcher, { maxRetries: 1 }).assess(request())
    expect(result).toMatchObject({ ok: false, error: { code: 'NETWORK' }, usage: expect.arrayContaining([{ ...result.usage[0], actualCostUsd: null, requests: 1 }]) })
    expect(fetcher).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain('private')
  })
  it('allows one explicit retry for 429 and counts both submissions including prosody', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '1' } })).mockResolvedValueOnce(json(restFixture()))
    const promise = adapter(fetcher, { maxRetries: 1 }).assess(request())
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    const result = await promise
    expect(result.ok).toBe(true)
    expect(result.usage.every(u => u.requests === 2 && u.submittedAudioSeconds === 6)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('honors a long Retry-After by returning instead of retrying early', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503, headers: { 'retry-after': '3600' } }))
    expect(await adapter(fetcher, { maxRetries: 1 }).assess(request())).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('snapshots validated options so later mutation cannot expand paid retries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }))
    const options: Parameters<typeof createAzureSpeechAdapter>[0] = { resourceName: 'unit-test-speech', getCredentials: async () => ({ subscriptionKey: testCredential() }), fetch: fetcher, maxRetries: 0 }
    const service = createAzureSpeechAdapter(options)
    options.maxRetries = 1
    expect(await service.assess(request())).toMatchObject({ ok: false, error: { code: 'RATE_LIMIT' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('cancels before request with no spend and retains recording bytes', async () => {
    const abort = new AbortController(); abort.abort()
    const fetcher = vi.fn(); const source = request(); const original = source.audioWav.slice()
    const result = await adapter(fetcher).assess(source, abort.signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'CANCELLED' }, usage: [{ requests: 0, billingStatus: 'not-submitted' }] })
    expect(source.audioWav).toEqual(original); expect(fetcher).not.toHaveBeenCalled()
  })
  it('cancels a pending request even if the injected fetch does not settle', async () => {
    const abort = new AbortController()
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}))
    const pending = adapter(fetcher).assess(request(), abort.signal)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); abort.abort()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' }, usage: expect.arrayContaining([expect.objectContaining({ requests: 1 })]) })
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
  it('cancels a retry delay and does not send the second recording', async () => {
    const abort = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '5' } }))
    const pending = adapter(fetcher, { maxRetries: 1 }).assess(request(), abort.signal)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); abort.abort()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('times out a stalled response body and cancels the stream', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')) }, cancel }), { headers: { 'content-type': 'application/json' } })
    const result = await adapter(vi.fn<typeof fetch>().mockResolvedValue(response), { timeoutMs: 100 }).assess(request())
    expect(result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' }, usage: expect.arrayContaining([expect.objectContaining({ requests: 1 })]) })
    expect(cancel).toHaveBeenCalled()
  })
  it('late credential resolution after timeout cannot issue a paid request', async () => {
    let release!: (value: { subscriptionKey: string }) => void
    const fetcher = vi.fn()
    const pending = adapter(fetcher, { timeoutMs: 100, getCredentials: () => new Promise(resolve => { release = resolve }) }).assess(request())
    expect(await pending).toMatchObject({ ok: false, error: { code: 'TIMEOUT' }, usage: expect.arrayContaining([expect.objectContaining({ requests: 0 })]) })
    release({ subscriptionKey: testCredential() }); await Promise.resolve(); await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects invalid JSON, HTML and oversized responses', async () => {
    for (const response of [new Response('{broken', { headers: { 'content-type': 'application/json' } }), new Response('<html>error</html>'), json({ huge: 'a'.repeat(SPEECH_LIMITS.maxResponseBytes) })]) {
      expect(await adapter(vi.fn<typeof fetch>().mockResolvedValue(response)).assess(request())).toMatchObject({ ok: false, error: { code: 'MALFORMED_RESPONSE' } })
    }
  })
  it('tracks only base service if prosody is disabled and rounds submitted seconds conservatively', async () => {
    const source = { ...request(), audioWav: wav(3.1), enableProsody: false }
    const result = await adapter(vi.fn<typeof fetch>().mockResolvedValue(json(restFixture()))).assess(source)
    expect(result.usage).toEqual([{ service: 'azure.speech.pronunciation', requests: 1, submittedAudioSeconds: 3.1, estimatedBillableSeconds: 4, actualCostUsd: null, billingStatus: 'unknown' }])
  })
})

describe('PCM conversion and retry practice', () => {
  it('encodes signed little-endian PCM16 and checks actual duration', () => {
    const samples = new Float32Array(16000); samples[0] = -1; samples[1] = 1; samples[2] = 2
    const bytes = encodeAssessmentWav(samples)
    const data = new DataView(bytes.buffer)
    expect(data.getInt16(44, true)).toBe(-32768); expect(data.getInt16(46, true)).toBe(32767); expect(data.getInt16(48, true)).toBe(32767)
    expect(inspectAssessmentWav(bytes)).toEqual({ durationSeconds: 1, sampleCount: 16000 })
  })
  it('enforces duration endpoints, rejects silence, invalid rate, samples, header and truncation', () => {
    expect(inspectAssessmentWav(wav(0.25)).durationSeconds).toBe(0.25)
    expect(inspectAssessmentWav(wav(30)).durationSeconds).toBe(30)
    for (const samples of [new Float32Array(3999), new Float32Array(480001), new Float32Array(16000), new Float32Array(16000).fill(NaN)]) expect(() => encodeAssessmentWav(samples)).toThrow()
    expect(() => encodeAssessmentWav(new Float32Array(16000), 48000)).toThrow()
    const bytes = wav(); bytes[24] = 0
    expect(() => inspectAssessmentWav(bytes)).toThrow()
    expect(() => inspectAssessmentWav(wav().subarray(0, 100))).toThrow()
  })
  it('reports unavailable browser decoding and cancellation without using network', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined)
    await expect(recordingToAssessmentWav(new Blob(['saved original']))).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    const abort = new AbortController(); abort.abort()
    await expect(recordingToAssessmentWav(new Blob(['saved original']), abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  })
  it('uses Web Audio decoding and mono rendering while preserving the input blob', async () => {
    const samples = new Float32Array(16000).fill(0.1)
    const source = { connect: vi.fn(), start: vi.fn(), buffer: null }
    const construct = vi.fn()
    class Offline {
      destination = {}
      constructor(...args: unknown[]) { construct(...args) }
      decodeAudioData = vi.fn(async () => ({ duration: 1, numberOfChannels: 2 }))
      createBufferSource = () => source
      startRendering = vi.fn(async () => ({ getChannelData: () => samples }))
    }
    vi.stubGlobal('OfflineAudioContext', Offline)
    const original = new Blob(['original mp4'], { type: 'audio/mp4' })
    expect(inspectAssessmentWav(await recordingToAssessmentWav(original)).durationSeconds).toBe(1)
    expect(construct).toHaveBeenCalledWith(1, 16000, 16000)
    expect(source.start).toHaveBeenCalled()
    expect(await original.text()).toBe('original mp4')
  })
  it('compares only different recordings under the same reference and settings', () => {
    const before = normalizeAzureAssessment(restFixture(), context)
    const raw = restFixture(); raw.NBest[0].AccuracyScore = 90
    const after = normalizeAzureAssessment(raw, { ...context, attemptId: 'attempt-2', recordingId: 'recording-2' })
    expect(compareAcousticAttempts(before, after)).toMatchObject({ comparable: true, deltas: { accuracy: -10 } })
    for (const patch of [{ referenceSha256: 'b'.repeat(64) }, { referenceId: 'other' }, { prosodyRequested: false }, { recordingId: before.recordingId }, { attemptId: before.attemptId }]) expect(compareAcousticAttempts(before, { ...after, ...patch }).comparable).toBe(false)
    after.scores.fluency = null
    expect(compareAcousticAttempts(before, after).deltas?.fluency).toBeNull()
  })
  it('requires observed reference review facts; locale or synthetic voice name is insufficient', () => {
    const review: ReferenceVoiceReview = { locale: 'en-US', kind: 'human', rightsApproved: true, transcriptChecked: true, clearSingleSpeaker: true, naturalStressAndRhythm: true, generalAmericanReviewed: true, clippingOrIntrusiveNoise: false, reviewId: 'review-1' }
    expect(referenceVoiceEligible(review)).toBe(true)
    expect(referenceVoiceEligible({ ...review, kind: 'synthetic' })).toBe(true)
    for (const patch of [{ locale: 'en-GB' }, { rightsApproved: null }, { generalAmericanReviewed: null }, { naturalStressAndRhythm: false }, { clippingOrIntrusiveNoise: true }, { reviewId: '' }]) expect(referenceVoiceEligible({ ...review, ...patch })).toBe(false)
  })
})
