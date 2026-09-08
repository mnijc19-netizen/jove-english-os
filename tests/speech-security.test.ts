import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import { createSpeechBrowserClient, type SpeechCloudConnection } from '../src/speech/client'
import { encodeAssessmentWav } from '../src/speech/wav'
import { normalizeAzureAssessment } from '../src/speech/normalize'

const identitySource = vi.hoisted(() => ({ auth: undefined as unknown }))
vi.mock('../src/cloud/client', async () => {
  const { createPrincipalFence } = await import('../src/cloud/auth-fence')
  return { cloudClient: null, createAuthFence: () => createPrincipalFence(identitySource.auth as Parameters<typeof createPrincipalFence>[0]) }
})
const sha = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), n => n.toString(16).padStart(2, '0')).join('')
const wav = () => encodeAssessmentWav(new Float32Array(16000).fill(0.1))
const request = () => ({ attemptId: 'attempt-a', recordingId: 'recording-a', referenceId: 'reference-a', referenceText: 'Good morning.', audioWav: wav() })
async function reference() {
  return { id: 'reference-a', text: 'Good morning.', audioUrl: 'https://unfetched.invalid/review.wav', audioSha256: await sha(wav()),
    materialId: null, sourceUrl: 'https://unfetched.invalid/source', rightsEvidence: 'INERT FIXTURE, NOT AN APPROVAL', reviewedAt: '2026-09-08T00:00:00Z', revokedAt: null,
    voiceReview: { locale: 'en-US', kind: 'human' as const, reviewId: 'fixture-review', rightsApproved: true, transcriptChecked: true,
      clearSingleSpeaker: true, naturalStressAndRhythm: true, generalAmericanReviewed: true, clippingOrIntrusiveNoise: false } }
}
async function result() {
  const input = request(), raw = { RecognitionStatus: 'Success', Offset: 0, Duration: 10000000, NBest: [{ Confidence: 0.9, AccuracyScore: 80,
    Words: [{ Word: 'Good', AccuracyScore: 80, ErrorType: 'None', Offset: 0, Duration: 5000000 }] }] }
  return { ok: true, assessmentId: 'assessment-a', usage: [], assessment: normalizeAzureAssessment(raw, { attemptId: input.attemptId, recordingId: input.recordingId, referenceId: input.referenceId,
    referenceSha256: await sha(new TextEncoder().encode(input.referenceText)), audioSeconds: 1, prosodyRequested: false }) }
}
function fixture() {
  let session: { user: { id: string }; access_token: string } | null = { user: { id: 'owner-a' }, access_token: 'inert.header.signature' }
  const callbacks = new Set<(event: string, value: typeof session) => void>()
  const cloud = { auth: {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    onAuthStateChange: vi.fn((callback: (event: string, value: typeof session) => void) => {
      callbacks.add(callback); return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } }
    }),
  }, functions: { invoke: vi.fn<SpeechCloudConnection['functions']['invoke']>() } }
  identitySource.auth = cloud.auth
  return { cloud, client: createSpeechBrowserClient(cloud), callbacks,
    switchOwner(id: string | null, emit = true) { session = id ? { user: { id }, access_token: 'inert.header.signature' } : null; if (emit) for (const callback of callbacks) callback(id ? 'SIGNED_IN' : 'SIGNED_OUT', session) } }
}
beforeEach(async () => { await db.open(); await db.syncMeta.put({ id: 'owner', value: 'owner-a' }) })
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.delete() })

describe('speech owner and reviewed-byte delivery fences', () => {
  it.each(['session', 'journal'] as const)('bounds each %s identity read without expiring the mounted principal fence', async mode => {
    const f = fixture(), gate = f.client.session()
    let outcome = 'pending'
    let release!: () => void
    const stalled = new Promise<void>(resolve => { release = resolve })
    const getSession = f.cloud.auth.getSession.getMockImplementation()!
    const getOwner = db.syncMeta.get.bind(db.syncMeta)
    if (mode === 'session') f.cloud.auth.getSession.mockImplementationOnce(async () => { await stalled; return { data: { session: { user: { id: 'late-owner' }, access_token: 'inert' } }, error: null } })
    else vi.spyOn(db.syncMeta, 'get').mockImplementationOnce(() => stalled.then(() => ({ id: 'owner', value: 'late-owner' })) as ReturnType<typeof db.syncMeta.get>)
    vi.useFakeTimers()
    try {
      void gate.assertCurrent().then(() => { outcome = 'success' }, error => { outcome = error.code })
      await vi.advanceTimersByTimeAsync(15001)
      expect(outcome).toBe('TIMEOUT')
      expect(gate.signal.aborted).toBe(false)
      vi.useRealTimers(); f.cloud.auth.getSession.mockImplementation(getSession)
      if (mode === 'journal') vi.spyOn(db.syncMeta, 'get').mockImplementation(key => getOwner(String(key)) as ReturnType<typeof db.syncMeta.get>)
      await expect(gate.assertCurrent()).resolves.toMatchObject({ user: { id: 'owner-a' } })
      release(); await Promise.resolve(); await Promise.resolve()
      expect(gate.isCurrent()).toBe(true)
      vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(30000)
      expect(gate.signal.aborted).toBe(false)
      f.switchOwner('owner-b'); f.switchOwner('owner-a')
      await expect(gate.assertCurrent()).rejects.toMatchObject({ code: 'AUTH' })
    } finally { gate.dispose(); release(); vi.useRealTimers() }
  })
  it.each(['assess', 'recover', 'references'] as const)('rejects late %s after session-only switch, with no new paid attempt', async action => {
    const f = fixture(), value = action === 'references' ? { references: [await reference()] } : await result()
    f.cloud.functions.invoke.mockImplementation(async () => { f.switchOwner('owner-b'); return { data: value, error: null } })
    const call = action === 'assess' ? f.client.assess(request()) : action === 'recover' ? f.client.recover(request()) : f.client.references()
    if (action === 'assess') expect(await call).toMatchObject({ ok: false, error: { code: 'AUTH' } })
    else await expect(call).rejects.toMatchObject({ code: 'AUTH' })
    expect(f.cloud.functions.invoke).toHaveBeenCalledOnce(); expect(f.callbacks.size).toBe(0)
  })
  it('rejects an A-B-A identity epoch even when final session and journal match', async () => {
    const f = fixture(), value = await result()
    f.cloud.functions.invoke.mockImplementation(async () => { f.switchOwner('owner-b'); f.switchOwner('owner-a'); return { data: value, error: null } })
    expect(await f.client.assess(request())).toMatchObject({ ok: false, error: { code: 'AUTH' } })
  })
  it('does not upload a recording from a journal bound to another owner', async () => {
    const f = fixture(); await db.syncMeta.put({ id: 'owner', value: 'owner-b' })
    f.cloud.functions.invoke.mockResolvedValue({ data: await result(), error: null })
    expect(await f.client.assess(request())).toMatchObject({ ok: false, error: { code: 'AUTH' } })
    expect(f.cloud.functions.invoke).not.toHaveBeenCalled()
  })
  it('catches a session change while the final journal read is pending', async () => {
    const f = fixture(), value = await result(), read = db.syncMeta.get.bind(db.syncMeta)
    let afterResponse = false
    f.cloud.functions.invoke.mockImplementation(async () => { afterResponse = true; return { data: value, error: null } })
    vi.spyOn(db.syncMeta, 'get').mockImplementation(key => (async () => {
      const row = await read(String(key)); if (afterResponse && String(key) === 'owner') f.switchOwner('owner-b'); return row
    })() as ReturnType<typeof db.syncMeta.get>)
    expect(await f.client.assess(request())).toMatchObject({ ok: false, error: { code: 'AUTH' } })
  })
  it('also checks the postawait session without relying only on notifications', async () => {
    const f = fixture(), value = await result()
    f.cloud.functions.invoke.mockImplementation(async () => { f.switchOwner('owner-b', false); return { data: value, error: null } })
    expect(await f.client.assess(request())).toMatchObject({ ok: false, error: { code: 'AUTH' } })
  })
  it('keeps same-owner refresh valid but cancels a stalled response immediately on sign-out', async () => {
    const f = fixture(), value = await result()
    f.cloud.functions.invoke.mockImplementation(async () => { f.switchOwner('owner-a'); return { data: value, error: null } })
    expect(await f.client.assess(request())).toMatchObject({ ok: true })
    f.cloud.functions.invoke.mockImplementation(() => new Promise(() => undefined))
    const pending = f.client.assess(request())
    await vi.waitFor(() => expect(f.cloud.functions.invoke).toHaveBeenCalledTimes(2))
    f.switchOwner(null)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'AUTH' } })
    expect(f.callbacks.size).toBe(0)
  })
  it('obtains reference audio by authenticated ID only and hashes the real bytes', async () => {
    const f = fixture(), ref = await reference(), bytes = wav()
    f.cloud.functions.invoke.mockResolvedValue({ data: { referenceId: ref.id, audioSha256: ref.audioSha256, byteLength: bytes.length,
      mimeType: 'audio/wav', audioBase64: Buffer.from(bytes).toString('base64') }, error: null })
    const audioClient = f.client as typeof f.client & { referenceAudio: (value: typeof ref) => Promise<Blob> }
    const blob = await audioClient.referenceAudio(ref)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes)
    expect(f.cloud.functions.invoke.mock.calls[0]![1].body).toEqual({ action: 'reference-audio', referenceId: ref.id })
    bytes[100] ^= 1
    f.cloud.functions.invoke.mockResolvedValue({ data: { referenceId: ref.id, audioSha256: ref.audioSha256, byteLength: bytes.length,
      mimeType: 'audio/wav', audioBase64: Buffer.from(bytes).toString('base64') }, error: null })
    await expect(audioClient.referenceAudio(ref)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('rejects audio delivery on account switch and revoked reference metadata without downloading', async () => {
    const f = fixture(), ref = await reference(), bytes = wav()
    f.cloud.functions.invoke.mockImplementation(async () => {
      f.switchOwner('owner-b')
      return { data: { referenceId: ref.id, audioSha256: ref.audioSha256, byteLength: bytes.length,
        mimeType: 'audio/wav', audioBase64: Buffer.from(bytes).toString('base64') }, error: null }
    })
    await expect(f.client.referenceAudio(ref)).rejects.toMatchObject({ code: 'AUTH' })
    await expect(f.client.referenceAudio({ ...ref, revokedAt: '2026-09-08T01:00:00Z' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.cloud.functions.invoke).toHaveBeenCalledOnce()
  })
})
