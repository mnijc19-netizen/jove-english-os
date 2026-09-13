import { z } from 'zod'
import { cloudClient, createAuthFence, publicCloudConfig } from './client'
import { db } from '../db/db'
import { authenticPlaybackSchema, materialSchema } from '../db/schema'
import type { AuthenticPlayback, Material, StudyEvent } from '../domain/types'
import { abortable, checkAbort, readBytes, readJson, withDeadline } from '../ai/transport'
import { ProviderError } from '../ai/errors'
import { externalCatalogSchema, materialFromExternalCatalog } from '../content/external-catalog'
import { EXTERNAL_CATALOG_MAX_AGE } from '../content/external'

const segmentIdSchema = z.string().regex(/^authentic-[a-f0-9]{64}$/u)
const playbackWireSchema = z.object({ ...authenticPlaybackSchema.shape,
  bucket: z.literal('jove-content-audio'), objectPath: z.string().regex(/^clips\/[a-f0-9]{64}\/[a-f0-9]{64}$/u),
}).omit({ segmentId: true, sentenceRanges: true })
const sentenceSchema = z.object({ startSeconds: z.number().finite(), endSeconds: z.number().finite(), text: z.string().min(1).max(10000) })
const lessonSchema = z.object({ segmentId: segmentIdSchema, material: materialSchema, playback: playbackWireSchema,
  timedSentences: z.array(sentenceSchema).min(1).max(100) })
export const contentProfileSchema = z.object({ targetDifficulty: z.number().min(0).max(1), fatigue: z.number().min(0).max(1),
  interests: z.array(z.string().min(1).max(80)).max(20), requireGeneralAmerican: z.boolean().optional(),
}).strict()
export type ContentProfile = z.infer<typeof contentProfileSchema>
const canonical = (value: unknown) => JSON.stringify(value)
const digest = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
const identity = (text: string) => digest(new TextEncoder().encode(text))
const invalid = () => new ProviderError('INVALID_RESPONSE')
const transientAudio = new WeakSet<Blob>()
/** Playback succeeded, but the caller must not present this Blob as available offline. */
export const contentAudioIsTransient = (blob: Blob): boolean => transientAudio.has(blob)

async function access(signal: AbortSignal) {
  if (!cloudClient) throw new ProviderError('ACCOUNT_REQUIRED')
  const fence = createAuthFence()
  const dispose = () => { signal.removeEventListener('abort', dispose); fence.dispose() }
  signal.addEventListener('abort', dispose, { once: true })
  if (signal.aborted) dispose()
  const scoped = AbortSignal.any([signal, fence.signal])
  const wait = async <T>(pending: Promise<T>): Promise<T> => {
    try { return await abortable(pending, scoped) }
    catch (error) {
      if (fence.signal.aborted && !signal.aborted) throw new ProviderError('ACCOUNT_REQUIRED')
      throw error
    }
  }
  try {
  const { data, error } = await wait(cloudClient.auth.getSession())
  const session = data.session
  if (error || !session || !fence.bind(session.user.id) || (await wait(db.syncMeta.get('owner')))?.value !== session.user.id) throw new ProviderError('ACCOUNT_REQUIRED')
  const ownerId = session.user.id
  const assertLive = () => { checkAbort(signal); if (!fence.isCurrent()) throw new ProviderError('ACCOUNT_REQUIRED') }
  assertLive()
  const assertCurrent = async () => {
    assertLive()
    const current = await wait(cloudClient!.auth.getSession())
    assertLive()
    if (current.error || current.data.session?.user.id !== ownerId || (await wait(db.syncMeta.get('owner')))?.value !== ownerId)
      throw new ProviderError('ACCOUNT_REQUIRED')
    assertLive()
  }
  await assertCurrent()
  assertLive()
  return { ownerId, assertCurrent, assertLive, signal: fence.signal, dispose, headers: { 'Content-Type': 'application/json', apikey: publicCloudConfig.publishableKey,
    Authorization: `Bearer ${session.access_token}` } }
  } catch (error) { dispose(); throw error }
}
type Access = Awaited<ReturnType<typeof access>>
async function request(context: Access, body: unknown, signal: AbortSignal) {
  await context.assertCurrent(); context.assertLive(); checkAbort(signal)
  const response = await fetch(`${publicCloudConfig.url}/functions/v1/content`, { method: 'POST',
    headers: context.headers, body: canonical(body), signal, credentials: 'omit', redirect: 'error', cache: 'no-store' })
  await context.assertCurrent(); context.assertLive(); checkAbort(signal)
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new ProviderError(response.status === 401 || response.status === 403 ? 'ACCOUNT_REQUIRED' : 'ACCOUNT_SERVICE')
  }
  const value = await readJson(response, signal, 2_000_000)
  await context.assertCurrent(); context.assertLive(); checkAbort(signal)
  return value
}

/** Trust only the authenticated screened-lesson transport, never arbitrary imported metadata. */
export function materialFromContentLesson(input: unknown): Material {
  const lesson = lessonSchema.parse(input)
  const { bucket, objectPath, ...audio } = lesson.playback
  const playback = authenticPlaybackSchema.parse({ ...audio, segmentId: lesson.segmentId,
    sentenceRanges: lesson.timedSentences.map(({ startSeconds, endSeconds }) => ({ startSeconds, endSeconds })) })
  const material = lesson.material
  if (bucket !== 'jove-content-audio' || material.audioId || material.audioPath || material.authenticPlayback
    || material.id !== lesson.segmentId || !material.approved || material.synthetic || !material.sourceUrl || !material.license
    || objectPath !== `clips/${lesson.segmentId.slice(10)}/${playback.audioSha256}`
    || material.sentences.length !== lesson.timedSentences.length
    || material.sentences.some((sentence, i) => sentence !== lesson.timedSentences[i]!.text)
    || Math.abs(material.duration - (playback.endSeconds - playback.startSeconds)) > 1.01) throw invalid()
  // Never persist private signed URLs, whole-episode playback paths or device-local cache links.
  return materialSchema.parse({ ...material, authenticPlayback: playback })
}

export async function refreshContentLessons(profile: ContentProfile, signal?: AbortSignal): Promise<Material[]> {
  const checked = contentProfileSchema.parse(profile)
  return withDeadline(signal, 25_000, async scoped => {
    const context = await access(scoped)
    try {
    scoped = AbortSignal.any([scoped, context.signal])
    // A bounded refresh window has a stable identity across reloads and ambiguous failures.
    const requestId = `lessons-${Math.floor(Date.now() / 21_600_000)}-${(await identity(canonical(checked))).slice(0, 32)}`
    const response = z.object({ lessons: z.array(z.unknown()).max(10), requestId: z.literal(requestId) })
      .parse(await request(context, { action: 'lessons', profile: checked, limit: 5, requestId }, scoped))
    const materials = response.lessons.map(materialFromContentLesson)
    if (new Set(materials.map(m => m.id)).size !== materials.length) throw invalid()
    await context.assertCurrent(); context.assertLive(); checkAbort(scoped)
    await db.transaction('rw', [db.materials, db.syncMeta], async () => {
      if ((await db.syncMeta.get('owner'))?.value !== context.ownerId) throw new ProviderError('ACCOUNT_REQUIRED')
      // A reviewed segment is immutable. A changed transcript/audio needs a new segment ID.
      for (const material of materials) {
        const previous = await db.materials.get(material.id)
        if (previous && (previous.transcript !== material.transcript || canonical(previous.sentences) !== canonical(material.sentences)
          || (previous.authenticPlayback && canonical(previous.authenticPlayback) !== canonical(material.authenticPlayback)))) throw invalid()
      }
      context.assertLive(); checkAbort(scoped)
      if (materials.length) await db.materials.bulkPut(materials)
      context.assertLive(); checkAbort(scoped)
    })
    context.assertLive(); checkAbort(scoped)
    return materials
    } finally { context.dispose() }
  })
}

/** Separate page-only delivery; failed acoustic selection cannot block this catalog. */
export async function refreshExternalCourseCatalog(signal?: AbortSignal): Promise<Material[]> {
  return withDeadline(signal, 25_000, async scoped => {
    const context = await access(scoped)
    try {
      scoped = AbortSignal.any([scoped, context.signal])
      const response = z.strictObject({ catalog: externalCatalogSchema.nullable() })
        .parse(await request(context, { action: 'external-catalog' }, scoped))
      if (!response.catalog) return []
      if (response.catalog.checkedAt > Date.now() + 300_000 || response.catalog.checkedAt <= Date.now() - EXTERNAL_CATALOG_MAX_AGE) throw invalid()
      const materials = materialFromExternalCatalog(response.catalog).map(m => materialSchema.parse(m))
      await context.assertCurrent(); context.assertLive(); checkAbort(scoped)
      await db.transaction('rw', [db.materials, db.syncMeta], async () => {
        if ((await db.syncMeta.get('owner'))?.value !== context.ownerId) throw new ProviderError('ACCOUNT_REQUIRED')
        for (const material of materials) {
          const previous = await db.materials.get(material.id)
          // Existing user edits, transcripts, drafts and source identities are never overwritten.
          if (previous) {
            if (previous.sourceUrl !== material.sourceUrl || !previous.externalStudy) throw invalid()
            // Only source freshness advances; all learner-authored fields and creation time stay intact.
            await db.materials.update(previous.id, { 'externalStudy.checkedAt': Math.max(previous.externalStudy.checkedAt, response.catalog!.checkedAt) })
          } else await db.materials.add(material)
          context.assertLive(); checkAbort(scoped)
        }
      })
      context.assertLive(); checkAbort(scoped)
      return materials
    } finally { context.dispose() }
  })
}

function samePlayback(actual: z.infer<typeof playbackWireSchema>, expected: AuthenticPlayback): boolean {
  return Object.keys(playbackWireSchema.shape).every(key => key === 'bucket' || key === 'objectPath'
    || actual[key as keyof typeof actual] === expected[key as keyof AuthenticPlayback])
}
/** URL is used transiently for a bounded download. Never include a bearer token on the storage GET. */
function storageUrl(value: string, playback: AuthenticPlayback): string {
  const url = new URL(value), origin = new URL(publicCloudConfig.url)
  const path = `/storage/v1/object/sign/jove-content-audio/clips/${playback.segmentId.slice(10)}/${playback.audioSha256}`
  if (url.origin !== origin.origin || url.username || url.password || url.hash || decodeURIComponent(url.pathname) !== path
    || !url.searchParams.get('token') || [...url.searchParams.keys()].some(key => key !== 'token')
    || url.searchParams.getAll('token').length !== 1) throw invalid()
  return url.href
}
async function validBytes(blob: Blob, playback: AuthenticPlayback) {
  return blob.size === playback.byteLength && blob.type === playback.mimeType
    && await digest(new Uint8Array(await blob.arrayBuffer())) === playback.audioSha256
}
export async function prepareContentAudio(material: Material, signal?: AbortSignal): Promise<Blob> {
  const playback = authenticPlaybackSchema.parse(material.authenticPlayback)
  if (material.synthetic || !material.approved || material.id !== playback.segmentId
    || material.sentences.length !== playback.sentenceRanges.length) throw invalid()
  return withDeadline(signal, 45_000, async scoped => {
    const cacheId = `content-${playback.audioSha256}`
    const cached = await db.audio.get(cacheId)
    if (cached?.kind === 'content-cache' && await validBytes(cached.blob, playback)) { checkAbort(scoped); return cached.blob }
    const context = await access(scoped)
    try {
    scoped = AbortSignal.any([scoped, context.signal])
    const raw = z.object({ ...playbackWireSchema.shape, url: z.string().max(10000), expiresAt: z.number().finite(), segmentId: segmentIdSchema })
      .parse(await request(context, { action: 'audio', segmentId: playback.segmentId }, scoped))
    if (raw.segmentId !== playback.segmentId || !samePlayback(raw, playback)
      || raw.objectPath !== `clips/${playback.segmentId.slice(10)}/${playback.audioSha256}`
      || raw.expiresAt <= Date.now() || raw.expiresAt > Date.now() + 330_000) throw invalid()
    const response = await fetch(storageUrl(raw.url, playback), { signal: scoped, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' })
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new ProviderError('ACCOUNT_SERVICE') }
    const type = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
    const length = response.headers.get('Content-Length')
    if (type !== playback.mimeType || (length !== null && Number(length) !== playback.byteLength)) {
      void response.body?.cancel().catch(() => undefined); throw invalid()
    }
    const bytes = await readBytes(response, scoped, playback.byteLength)
    if (bytes.byteLength !== playback.byteLength || await digest(bytes) !== playback.audioSha256) throw invalid()
    const blob = new Blob([bytes], { type: playback.mimeType })
    await context.assertCurrent(); context.assertLive(); checkAbort(scoped)
    let saved = false
    try { await db.transaction('rw', [db.audio, db.settings, db.syncMeta], async () => {
      if ((await db.syncMeta.get('owner'))?.value !== context.ownerId) throw new ProviderError('ACCOUNT_REQUIRED')
      const limit = ((await db.settings.get('main'))?.value.audioLimitMB ?? 100) * 1024 * 1024
      const assets = await db.audio.toArray()
      const replaceable = assets.find(a => a.id === cacheId && a.kind === 'content-cache')
      if (replaceable) await db.audio.delete(cacheId)
      let used = assets.reduce((n, a) => n + a.blob.size, 0) - (replaceable?.blob.size ?? 0)
      let cacheUsed = assets.filter(a => a.kind === 'content-cache' && a.id !== cacheId).reduce((n, a) => n + a.blob.size, 0)
      for (const old of assets.filter(a => a.kind === 'content-cache' && a.id !== cacheId).sort((a, b) => a.createdAt - b.createdAt)) {
        if (used + blob.size <= limit && cacheUsed + blob.size <= 100 * 1024 * 1024) break
        await db.audio.delete(old.id); used -= old.blob.size; cacheUsed -= old.blob.size
      }
      context.assertLive(); checkAbort(scoped)
      // Never evict a learner's recording to cache a replaceable lesson.
      if (!assets.some(a => a.id === cacheId && a.kind !== 'content-cache') && used + blob.size <= limit) {
        await db.audio.put({ id: cacheId, blob, mimeType: blob.type, kind: 'content-cache',
          processed: true, duration: playback.durationSeconds, createdAt: Date.now(), label: material.title })
        saved = true
      }
      context.assertLive(); checkAbort(scoped)
    }) } catch (error) {
      // Safari private storage/actual quota errors do not invalidate already
      // authenticated, hash-checked bytes. Never swallow protocol/auth/abort errors.
      if (!(error instanceof Error) || !['QuotaExceededError', 'UnknownError'].includes(error.name)) throw error
      saved = false
    }
    await context.assertCurrent(); context.assertLive(); checkAbort(scoped)
    if (!saved) transientAudio.add(blob)
    return blob
    } finally { context.dispose() }
  })
}

/** Existing immutable learner events are the outbox; acknowledgements are device-local only. */
export async function flushContentHistory(events: readonly StudyEvent[], materials: readonly Material[], signal?: AbortSignal): Promise<void> {
  const candidates = events.flatMap(event => {
    const material = materials.find(m => m.id === event.data?.materialId)
    const action = event.type === 'TASK_STARTED' ? 'started' : event.type === 'TASK_COMPLETED' ? 'completed'
      : event.type === 'TASK_SKIPPED' ? 'skipped' : null
    return material?.authenticPlayback && action ? [{ event, segmentId: material.authenticPlayback.segmentId, action }] : []
  })
  if (!candidates.length) return
  await withDeadline(signal, 25_000, async scoped => {
    const context = await access(scoped)
    try {
    scoped = AbortSignal.any([scoped, context.signal])
    let sent = 0
    for (const row of candidates) {
      context.assertLive(); checkAbort(scoped)
      const eventId = await identity(row.event.id), id = `content-history:${context.ownerId}:${eventId}`
      if (await db.syncMeta.get(id)) continue
      z.object({ saved: z.literal(true) }).parse(await request(context,
        { action: 'history', segmentId: row.segmentId, eventId, event: row.action }, scoped))
      await context.assertCurrent(); context.assertLive(); checkAbort(scoped)
      await db.transaction('rw', db.syncMeta, async () => {
        if ((await db.syncMeta.get('owner'))?.value !== context.ownerId) throw new ProviderError('ACCOUNT_REQUIRED')
        context.assertLive(); checkAbort(scoped)
        await db.syncMeta.put({ id, value: true })
        context.assertLive(); checkAbort(scoped)
      })
      context.assertLive(); checkAbort(scoped)
      if (++sent >= 20) break
    }
    } finally { context.dispose() }
  })
}
