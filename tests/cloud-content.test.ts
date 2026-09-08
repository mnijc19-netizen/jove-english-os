import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import { contentAudioIsTransient, materialFromContentLesson, prepareContentAudio, refreshContentLessons, flushContentHistory } from '../src/cloud/content'
import { defaultProfile, defaultSettings, type StudyEvent } from '../src/domain/types'
import { demoMaterials } from '../src/content/materials'
import { makePlan } from '../src/domain/engine'
import { exportBackup } from '../src/db/repository'
import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js'

const auth = vi.hoisted(() => ({ session: { user: { id: 'content-owner-a' }, access_token: 'fixture-jwt-a' } as { user: { id: string }; access_token: string } | null,
  pause: undefined as Promise<void> | undefined,
  listeners: new Set<(event: AuthChangeEvent, session: Session | null) => void>() }))
vi.mock('../src/cloud/client', async () => {
  const { createPrincipalFence } = await import('../src/cloud/auth-fence')
  const events = { onAuthStateChange: (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
    auth.listeners.add(callback); return { data: { subscription: { id: 'fixture', callback, unsubscribe: () => { auth.listeners.delete(callback) } } } }
  } } as Pick<SupabaseClient['auth'], 'onAuthStateChange'>
  return { publicCloudConfig: { url: 'https://cloud.example.test', publishableKey: 'fixture-public' },
    cloudClient: { auth: { getSession: async () => { if (auth.pause) await auth.pause; return { data: { session: auth.session }, error: null } } } },
    createAuthFence: () => createPrincipalFence(events) }
})
const bytes = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69]) // Transport fixture, NOT a reviewed human recording.
const sha = createHash('sha256').update(bytes).digest('hex')
const segment = `authentic-${'a'.repeat(64)}`
const path = `clips/${'a'.repeat(64)}/${sha}`
const profile = { targetDifficulty: 0.4, fatigue: 0.3, interests: ['Daily life'], requireGeneralAmerican: true }
const playback = { bucket: 'jove-content-audio', objectPath: path, audioSha256: sha, startSeconds: 2, endSeconds: 42,
  sourceAudioSha256: 'b'.repeat(64), sourceStartSeconds: 102, sourceEndSeconds: 142, clipOriginSeconds: 100,
  timingBasis: 'pcm-sample-count', mimeType: 'audio/wav', byteLength: bytes.length, durationSeconds: 43 }
function lesson() {
  return { segmentId: segment, playback: { ...playback },
    material: { ...structuredClone(demoMaterials[0]!), id: segment, title: 'Transport fixture', sourceKind: 'discovery',
      difficulty: 0.4, duration: 40, transcript: 'First phrase. Second phrase.', sentences: ['First phrase.', 'Second phrase.'],
      sourceUrl: 'https://publisher.example.test/episode', sourceLabel: 'Fixture only', license: 'Fixture rights, not actual approval',
      synthetic: false, approved: true, audioPath: undefined },
    timedSentences: [{ startSeconds: 0, endSeconds: 19, text: 'First phrase.' }, { startSeconds: 20, endSeconds: 40, text: 'Second phrase.' }] }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const signed = () => ({ ...playback, segmentId: segment,
  url: `https://cloud.example.test/storage/v1/object/sign/jove-content-audio/${path}?token=fixture-signed-only`, expiresAt: Date.now() + 300_000 })
const audio = () => new Response(bytes, { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(bytes.length) } })
let fetcher: ReturnType<typeof vi.fn>
beforeEach(async () => {
  await db.delete(); await db.open()
  auth.session = { user: { id: 'content-owner-a' }, access_token: 'fixture-jwt-a' }
  auth.pause = undefined
  await db.syncMeta.put({ id: 'owner', value: auth.session.user.id })
  fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method !== 'POST') return audio()
    const body = JSON.parse(String(init.body))
    return body.action === 'lessons' ? json({ lessons: [lesson()], requestId: body.requestId })
      : body.action === 'history' ? json({ saved: true }) : json(signed())
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(async () => { expect(auth.listeners.size).toBe(0); vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.delete() })

describe('automatic authenticated lesson delivery', () => {
  it('releases the auth subscription on cancellation even while a later database transaction is still pending', async () => {
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
      entered()
      return new Dexie.Promise(resolve => { release = () => resolve(undefined) })
    })
    const controller = new AbortController(), outcome = refreshContentLessons(profile, controller.signal).catch(() => undefined)
    await started
    expect(auth.listeners.size).toBe(1); controller.abort()
    try {
      await outcome
      expect(auth.listeners.size).toBe(0)
      expect(await db.materials.count()).toBe(0)
    } finally { release() }
  })
  it('releases the auth subscription when cancelled during a stalled initial session read', async () => {
    let release!: () => void
    auth.pause = new Promise<void>(resolve => { release = resolve })
    const controller = new AbortController(), outcome = refreshContentLessons(profile, controller.signal).catch(() => undefined)
    expect(auth.listeners.size).toBe(1); controller.abort()
    try {
      await outcome
      await vi.waitFor(() => expect(auth.listeners.size).toBe(0))
      expect(fetcher).not.toHaveBeenCalled()
    } finally { release(); await vi.waitFor(() => expect(auth.listeners.size).toBe(0)) }
  })
  it('rolls back a lesson write when the principal changes inside the last database await', async () => {
    const put = db.materials.bulkPut.bind(db.materials)
    vi.spyOn(db.materials, 'bulkPut').mockImplementation(materials => put(materials).then(id => {
      for (const owner of ['content-owner-b', 'content-owner-a']) for (const listener of auth.listeners) listener('SIGNED_IN', { user: { id: owner } } as Session)
      return id
    }))
    await expect(refreshContentLessons(profile)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(await db.materials.count()).toBe(0)
  })
  it('rejects an audio response after a transient principal change even if getSession again returns the old owner', async () => {
    fetcher.mockImplementation(async (_url, init) => {
      if (init.method === 'POST') return json(signed())
      for (const owner of ['content-owner-b', 'content-owner-a']) for (const listener of auth.listeners) listener('SIGNED_IN', { user: { id: owner } } as Session)
      return audio()
    })
    await expect(prepareContentAudio(materialFromContentLesson(lesson()))).rejects.toBeDefined()
    expect(await db.audio.count()).toBe(0)
  })
  it('preserves attribution and relative sentence times, without signed URL or audioId', () => {
    const material = materialFromContentLesson(lesson())
    expect(material).toMatchObject({ id: segment, synthetic: false, sourceUrl: 'https://publisher.example.test/episode',
      authenticPlayback: { startSeconds: 2, sourceStartSeconds: 102, sentenceRanges: [{ startSeconds: 0, endSeconds: 19 }, { startSeconds: 20, endSeconds: 40 }] } })
    expect(material.audioId).toBeUndefined(); expect(material.audioPath).toBeUndefined()
  })
  it.each(['synthetic', 'sentence-text', 'overlap', 'source-time', 'wrong-object', 'whole-episode', 'unapproved'])('rejects inconsistent %s metadata', kind => {
    const row = lesson()
    if (kind === 'synthetic') row.material.synthetic = true
    if (kind === 'sentence-text') row.timedSentences[0]!.text = 'Different.'
    if (kind === 'overlap') row.timedSentences[1]!.startSeconds = 18
    if (kind === 'source-time') row.playback.sourceStartSeconds = 101
    if (kind === 'wrong-object') row.playback.objectPath = `clips/${'c'.repeat(64)}/${sha}`
    if (kind === 'whole-episode') Object.assign(row.material, { audioPath: 'https://publisher.example.test/full.mp3' })
    if (kind === 'unapproved') row.material.approved = false
    expect(() => materialFromContentLesson(row)).toThrow()
  })
  it('automatically persists selected lessons with a repeatable request identity, and exports no credentials', async () => {
    await refreshContentLessons(profile); await refreshContentLessons(profile)
    expect(await db.materials.count()).toBe(1)
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body)).requestId).toBe(JSON.parse(String(fetcher.mock.calls[1]![1].body)).requestId)
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: 'Bearer fixture-jwt-a' }, redirect: 'error', credentials: 'omit' })
    const backup = await exportBackup()
    expect(backup).not.toMatch(/fixture-jwt|fixture-public|fixture-signed|objectPath|storage\/v1/)
    expect(JSON.parse(backup).tables.materials[0].authenticPlayback.audioSha256).toBe(sha)
  })
  it('rejects a changed immutable lesson without overwriting local work', async () => {
    await refreshContentLessons(profile)
    const changed = lesson(); changed.material.transcript = 'Changed source.'
    fetcher.mockImplementationOnce(async (_url, init) => json({ lessons: [changed], requestId: JSON.parse(String(init.body)).requestId }))
    await expect(refreshContentLessons(profile)).rejects.toBeDefined()
    expect((await db.materials.get(segment))?.transcript).toBe('First phrase. Second phrase.')
  })
  it('does not send data without a matching owner or accept a late result after account change', async () => {
    auth.session = null
    await expect(refreshContentLessons(profile)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(fetcher).not.toHaveBeenCalled()
    auth.session = { user: { id: 'content-owner-a' }, access_token: 'fixture-jwt-a' }
    fetcher.mockImplementationOnce(async (_url, init) => {
      auth.session = { user: { id: 'content-owner-b' }, access_token: 'fixture-jwt-b' }
      return json({ lessons: [lesson()], requestId: JSON.parse(String(init.body)).requestId })
    })
    await expect(refreshContentLessons(profile)).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(await db.materials.count()).toBe(0)
  })
  it('prefers approachable human content while preserving an already assigned task', () => {
    const owner = { ...defaultProfile(), onboarded: true, interests: ['Technology'], createdAt: Date.now() }
    const material = materialFromContentLesson(lesson())
    const plan = makePlan(owner, [], [], [], [...demoMaterials, material])
    expect(plan.tasks.find(t => t.kind === 'listen')?.materialId).toBe(segment)
    const existing = makePlan(owner, [], [], [], demoMaterials)
    expect(makePlan(owner, [], [], [], [...demoMaterials, material], existing).tasks.find(t => t.kind === 'listen')?.id)
      .toBe(existing.tasks.find(t => t.kind === 'listen')?.id)
    material.difficulty = 1
    expect(makePlan(owner, [], [], [], [...demoMaterials, material]).tasks.find(t => t.kind === 'listen')?.materialId).not.toBe(segment)
  })
})

describe('short original audio caching and recovery', () => {
  it('checks actual bytes, caches the clip, and replays offline without a URL or new API call', async () => {
    const material = materialFromContentLesson(lesson())
    const blob = await prepareContentAudio(material)
    expect(contentAudioIsTransient(blob)).toBe(false)
    expect(await blob.arrayBuffer()).toEqual(bytes.buffer)
    expect(fetcher.mock.calls[1]![1].headers).toBeUndefined()
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' })
    expect((await db.audio.get(`content-${sha}`))?.kind).toBe('content-cache')
    auth.session = null; fetcher.mockRejectedValue(new Error('offline'))
    expect((await prepareContentAudio(material)).size).toBe(bytes.length)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each(['foreign-origin', 'wrong-path', 'expired', 'changed-range', 'bad-hash', 'oversize', 'wrong-type'])('rejects %s without caching', async kind => {
    const raw = signed()
    if (kind === 'foreign-origin') raw.url = raw.url.replace('cloud.example.test', 'attacker.example.test')
    if (kind === 'wrong-path') raw.url = raw.url.replace('/clips/', '/other/')
    if (kind === 'expired') raw.expiresAt = Date.now() - 1
    if (kind === 'changed-range') raw.startSeconds = 3
    fetcher.mockResolvedValueOnce(json(raw))
    if (kind === 'bad-hash') fetcher.mockResolvedValueOnce(new Response(bytes.map(() => 0), { headers: { 'Content-Type': 'audio/wav' } }))
    if (kind === 'oversize') fetcher.mockResolvedValueOnce(new Response(new Uint8Array(bytes.length + 1), { headers: { 'Content-Type': 'audio/wav' } }))
    if (kind === 'wrong-type') fetcher.mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'text/html' } }))
    await expect(prepareContentAudio(materialFromContentLesson(lesson()))).rejects.toBeDefined()
    expect(await db.audio.count()).toBe(0)
    if (['foreign-origin', 'wrong-path', 'expired', 'changed-range'].includes(kind)) expect(fetcher).toHaveBeenCalledOnce()
  })
  it('never discards a saved user recording when there is no cache capacity', async () => {
    await db.settings.put({ id: 'main', value: { ...defaultSettings, audioLimitMB: 0.00001 } })
    await db.audio.put({ id: 'original', blob: new Blob([bytes]), mimeType: 'audio/wav', kind: 'recording', processed: false, duration: 1, createdAt: 1, label: 'Saved original' })
    const blob = await prepareContentAudio(materialFromContentLesson(lesson()))
    expect(blob.size).toBe(bytes.length); expect(contentAudioIsTransient(blob)).toBe(true)
    expect((await db.audio.toArray()).map(a => a.id)).toEqual(['original'])
  })
  it.each(['QuotaExceededError', 'UnknownError'])('retains verified audio for this play when actual cache write fails with %s', async name => {
    vi.spyOn(db.audio, 'put').mockRejectedValueOnce(new DOMException('Fixture storage failure', name))
    const blob = await prepareContentAudio(materialFromContentLesson(lesson()))
    expect(await blob.arrayBuffer()).toEqual(bytes.buffer)
    expect(contentAudioIsTransient(blob)).toBe(true); expect(await db.audio.count()).toBe(0)
  })
  it('still rejects an account switch during a cache quota failure', async () => {
    vi.spyOn(db.audio, 'put').mockImplementationOnce(() => {
      auth.session = { user: { id: 'content-owner-b' }, access_token: 'fixture-jwt-b' }
      return Dexie.Promise.reject(new DOMException('Fixture storage failure', 'QuotaExceededError'))
    })
    await expect(prepareContentAudio(materialFromContentLesson(lesson()))).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(await db.audio.count()).toBe(0)
  })
  it('rejects cancelled work without making a network call', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(prepareContentAudio(materialFromContentLesson(lesson()), controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('retries actual history events idempotently after a disconnect, never inventing ability evidence', async () => {
    const events: StudyEvent[] = [{ id: 'original-event', type: 'TASK_COMPLETED', timestamp: Date.now(), source: 'objective', data: { materialId: segment } }]
    const material = materialFromContentLesson(lesson())
    fetcher.mockRejectedValueOnce(new TypeError('connection lost'))
    await expect(flushContentHistory(events, [material])).rejects.toBeDefined()
    await flushContentHistory(events, [material]); await flushContentHistory(events, [material])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body)
    expect(JSON.parse(String(fetcher.mock.calls[1]![1].body))).toMatchObject({ action: 'history', segmentId: segment, event: 'completed' })
    expect(await db.events.count()).toBe(0); expect(await db.skills.count()).toBe(0)
  })
})
