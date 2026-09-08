import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSpeechHandler } from '../src/server/speech'
import type { OwnerContext } from '../src/server/gateway'
import { encodeAssessmentWav } from '../src/speech/wav'

async function fixture() {
  const bytes = encodeAssessmentWav(new Float32Array(16000).fill(0.1))
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('')
  const owner = '00000000-0000-4000-8000-000000000001', path = `references/${owner}/review-1/${hash}`
  const row = { user_id: owner, id: 'review-1', material_id: null, reference_text: 'Good morning.',
    audio_url: 'https://not-fetched.invalid/immutable-review.wav', audio_sha256: hash, source_url: 'https://not-fetched.invalid/source',
    rights_evidence: 'INERT FIXTURE NOT AN ACTUAL REVIEW', reviewed_at: '2026-09-08T00:00:00Z', revoked_at: null as string | null,
    voice_review: { locale: 'en-US', kind: 'human', reviewId: 'review-1', rightsApproved: true, transcriptChecked: true,
      clearSingleSpeaker: true, naturalStressAndRhythm: true, generalAmericanReviewed: true, clippingOrIntrusiveNoise: false } }
  const sign = vi.fn(async () => ({ data: { signedUrl: `http://kong:8000/storage/v1/object/sign/jove-content-audio/${path}?token=inert` }, error: null }))
  const from = vi.fn((table: string) => {
    if (table !== 'pronunciation_references') throw new Error('Audio retrieval must not assess or reserve a paid request')
    const filters: [string, unknown][] = []
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
      is: (key: string, value: unknown) => { filters.push([key, value]); return query },
      maybeSingle: async () => ({ data: filters.every(([key, value]) => (row as Record<string, unknown>)[key] === value) ? row : null, error: null }) }
    return query
  })
  const storage = vi.fn(() => ({ createSignedUrl: sign })), fetcher = vi.fn<typeof fetch>(async () => new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } }))
  vi.stubGlobal('fetch', fetcher)
  const env = vi.fn((name: string) => name === 'SUPABASE_URL' ? 'http://kong:8000' : undefined)
  const handler = createSpeechHandler({ env, authenticate: async () => ({ ownerId: owner, admin: { from, storage: { from: storage } } }) as unknown as OwnerContext })
  const request = (extra = {}) => handler(new Request('https://local.invalid/functions/v1/speech-assess', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reference-audio', referenceId: row.id, ...extra }) }))
  return { bytes, hash, path, row, sign, storage, fetcher, env, request }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('authenticated private pronunciation reference bytes', () => {
  it('downloads only the fixed private object on the exact configured internal origin, then verifies SHA', async () => {
    const f = await fixture(), response = await f.request()
    expect(response.status).toBe(200)
    const value = await response.json()
    expect(value).toMatchObject({ referenceId: f.row.id, audioSha256: f.hash, byteLength: f.bytes.length, mimeType: 'audio/wav' })
    expect(Buffer.from(value.audioBase64, 'base64')).toEqual(Buffer.from(f.bytes))
    expect(f.storage).toHaveBeenCalledWith('jove-content-audio'); expect(f.sign).toHaveBeenCalledWith(f.path, 60)
    expect(f.fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' })
    expect(f.env.mock.calls.flat()).not.toContain('AZURE_SPEECH_KEY')
    expect(JSON.stringify(value)).not.toContain('token='); expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
  it.each(['changed-bytes', 'redirect', 'oversize', 'revoked-during-read'] as const)('fails closed on %s without exposing audio', async mode => {
    const f = await fixture()
    f.fetcher.mockImplementation(async () => {
      if (mode === 'revoked-during-read') f.row.revoked_at = '2026-09-08T01:00:00Z'
      if (mode === 'changed-bytes') { const other = f.bytes.slice(); other[100] ^= 1; return new Response(other) }
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } })
      if (mode === 'oversize') return new Response(new Uint8Array(2_000_001))
      return new Response(f.bytes)
    })
    const response = await f.request(); expect(response.status).not.toBe(200)
    expect(await response.json()).not.toHaveProperty('audioBase64')
  })
  it.each(['http://169.254.169.254/', 'http://kong:8000.attacker.invalid/', 'http://kong:8000/storage/v1/object/sign/jove-content-audio/other?token=inert'])('rejects an unexpected signed origin/path %s before fetching', async url => {
    const f = await fixture(); f.sign.mockResolvedValue({ data: { signedUrl: url }, error: null })
    expect((await f.request()).status).not.toBe(200); expect(f.fetcher).not.toHaveBeenCalled()
  })
  it('bounds a stalled stream and never fetches a late signature after the deadline', async () => {
    const f = await fixture(); vi.useFakeTimers()
    try {
      f.fetcher.mockImplementation(async () => new Response(new ReadableStream({ start() { /* intentionally stalled */ } })))
      const pending = f.request(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(15001)
      expect((await pending).status).not.toBe(200)
      let finish!: (value: Awaited<ReturnType<typeof f.sign>>) => void
      f.sign.mockImplementation(() => new Promise(resolve => { finish = resolve }))
      const late = f.request(); await vi.waitFor(() => expect(f.sign).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(15001); expect((await late).status).not.toBe(200)
      finish({ data: { signedUrl: 'http://kong:8000/storage/v1/object/sign/jove-content-audio/' + f.path + '?token=inert' }, error: null })
      await Promise.resolve(); expect(f.fetcher).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('rejects client URLs/approval facts and revoked or different-owner records before signing', async () => {
    const f = await fixture()
    expect((await f.request({ audioUrl: 'https://attacker.invalid', rightsApproved: true })).status).toBe(400)
    f.row.revoked_at = '2026-09-08T01:00:00Z'
    const revoked = await f.request(); expect(revoked.status).toBe(422)
    expect(await revoked.json()).toMatchObject({ ok: false, error: { code: 'REFERENCE' }, usage: [] })
    f.row.revoked_at = null; f.row.user_id = 'other-owner'
    const missing = await f.request(); expect(missing.status).toBe(422)
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'REFERENCE' }, usage: [] })
    expect(f.sign).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled()
  })
})
