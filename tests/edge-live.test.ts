import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Dedicated local real Deno/Auth/Storage only. No provider calls, real voice
// approval, credential logging, screenshots, or other projects are involved.
describe.skipIf(process.env.JOVE_LOCAL_EDGE_TEST !== '1')('actual local Edge and private reference transport', () => {
  const api = 'http://127.0.0.1:55321'
  const referenceId = 'transport-' + crypto.randomUUID()
  let admin: SupabaseClient, member: SupabaseClient, stranger: SupabaseClient, owner = '', other = '', key = ''
  let objectPath = '', memberToken = '', strangerToken = ''
  const fixture = new Uint8Array(32044)
  fixture.set(new TextEncoder().encode('RIFF'), 0); fixture.set(new TextEncoder().encode('WAVEfmt '), 8)
  const header = new DataView(fixture.buffer)
  header.setUint32(4, fixture.length - 8, true); header.setUint32(16, 16, true); header.setUint16(20, 1, true)
  header.setUint16(22, 1, true); header.setUint32(24, 16000, true); header.setUint32(28, 32000, true)
  header.setUint16(32, 2, true); header.setUint16(34, 16, true)
  fixture.set(new TextEncoder().encode('data'), 36); header.setUint32(40, fixture.length - 44, true)
  const sha = createHash('sha256').update(fixture).digest('hex')
  const localFetch: typeof fetch = (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== api) throw new Error('Non-Jove local request refused')
    return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15000) })
  }
  async function post(route: string, body: unknown, token?: string) {
    return localFetch(`${api}/functions/v1/${route}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', apikey: key, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  }
  beforeAll(async () => {
    let config: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string }
    try {
      config = JSON.parse(execFileSync(process.execPath, [resolve('node_modules/supabase/dist/supabase.js'), 'status', '--output', 'json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, windowsHide: true }))
    } catch { throw new Error('Dedicated local configuration unavailable; raw credential output withheld') }
    if (config.API_URL !== api) throw new Error('Non-Jove local backend refused')
    key = config.ANON_KEY
    const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: localFetch } }
    admin = createClient(api, config.SERVICE_ROLE_KEY, options)
    member = createClient(api, key, options); stranger = createClient(api, key, options)
    for (const [index, client] of [member, stranger].entries()) {
      const email = `jove-edge-${crypto.randomUUID()}@example.invalid`, password = crypto.randomUUID() + crypto.randomUUID()
      const user = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      if (user.error || !user.data.user) throw new Error('Local fixture user creation failed')
      if (index === 0) owner = user.data.user.id; else other = user.data.user.id
      const session = await client.auth.signInWithPassword({ email, password })
      if (session.error || !session.data.session) throw new Error('Local fixture sign-in failed')
      if (index === 0) memberToken = session.data.session.access_token; else strangerToken = session.data.session.access_token
    }
    if ((await admin.from('app_members').insert({ user_id: owner })).error) throw new Error('Local fixture membership failed')
    objectPath = `references/${owner}/${referenceId}/${sha}`
    if ((await admin.storage.from('jove-content-audio').upload(objectPath, fixture, { contentType: 'audio/wav', upsert: false })).error) throw new Error('Local private fixture upload failed')
    // Fixture-only synthetic silence under a disposable QA owner, removed below.
    // These flags exercise the authorization transport; they certify no real voice.
    if ((await admin.from('pronunciation_references').insert({ user_id: owner, id: referenceId, material_id: null,
      reference_text: 'Synthetic transport fixture only.', audio_url: 'https://fixture.invalid/not-a-fetch-target', audio_sha256: sha,
      source_url: 'https://fixture.invalid/transport-only', rights_evidence: 'Test-generated silence, not a reviewed human course.',
      voice_review: { kind: 'synthetic', locale: 'en-US', rightsApproved: true, transcriptChecked: true, clearSingleSpeaker: true,
        naturalStressAndRhythm: true, generalAmericanReviewed: true, clippingOrIntrusiveNoise: false, reviewId: referenceId },
      reviewed_by: owner, reviewed_at: new Date().toISOString() })).error) throw new Error('Local reference fixture setup failed')
  }, 60000)
  afterAll(async () => {
    if (!admin) return
    if (objectPath && (await admin.storage.from('jove-content-audio').remove([objectPath])).error) throw new Error('Local fixture audio cleanup failed')
    if (owner && (await admin.from('pronunciation_references').delete().eq('user_id', owner).eq('id', referenceId)).error) throw new Error('Local fixture reference cleanup failed')
    for (const id of [owner, other].filter(Boolean)) if ((await admin.auth.admin.deleteUser(id)).error) throw new Error('Local fixture user cleanup failed')
    memberToken = ''; strangerToken = ''; key = ''
  }, 30000)
  it('loads all three real Deno routes and rejects unauthenticated calls', async () => {
    for (const route of ['ai', 'content', 'speech-assess']) expect((await post(route, {})).status).toBe(401)
  }, 45000)
  it('serves only the owner’s exact private reference bytes through authenticated Deno and internal Storage signing', async () => {
    const response = await post('speech-assess', { action: 'reference-audio', referenceId }, memberToken)
    expect(response.status).toBe(200)
    const result = await response.json() as { referenceId: string; audioSha256: string; mimeType: string; byteLength: number; audioBase64: string }
    expect(result.referenceId).toBe(referenceId); expect(result.mimeType).toBe('audio/wav')
    expect(result.byteLength).toBe(fixture.length)
    expect(createHash('sha256').update(Buffer.from(result.audioBase64, 'base64')).digest('hex')).toBe(sha)
    expect(result.audioSha256).toBe(sha)
    expect((await stranger.storage.from('jove-content-audio').download(objectPath)).data).toBeNull()
    expect((await post('speech-assess', { action: 'reference-audio', referenceId }, strangerToken)).status).toBe(403)
  }, 45000)
  it('reads an empty reviewed course list honestly and refuses reference audio after revocation without a paid call', async () => {
    const lessons = await post('content', { action: 'lessons', profile: { targetDifficulty: 0.3, fatigue: 0, interests: ['Daily life'] }, limit: 2, requestId: referenceId }, memberToken)
    expect(lessons.status).toBe(200)
    expect((await lessons.json() as { lessons: unknown[] }).lessons).toEqual([])
    if ((await admin.from('pronunciation_references').update({ revoked_at: new Date().toISOString() }).eq('user_id', owner).eq('id', referenceId)).error) throw new Error('Local fixture revocation failed')
    expect((await post('speech-assess', { action: 'reference-audio', referenceId }, memberToken)).status).toBe(422)
    const usage = await admin.from('service_usage').select('id', { count: 'exact', head: true }).eq('user_id', owner)
    if (usage.error) throw new Error('Local usage readback failed')
    expect(usage.count).toBe(0)
  }, 45000)
})
