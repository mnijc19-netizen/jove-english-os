import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { authenticatedOwner, boundedBody, corsHeaders, digestRequest, GatewayError, jsonResponse, reserve, safeFailure, settle,
  type OwnerContext, type ServerEnvironment } from './gateway'
import { createContentAudioServices, inspectContentProviderAccess } from './content-audio'
import { validateSourceUrl } from '../content/pipeline'
import { recordContentLearningUse, runContentRefresh, selectAndPersistContentLessons, type ContentBudget, type ContentRefreshOptions, type PersistedContentSegment } from './content-worker'

const profileSchema = z.object({ targetDifficulty: z.number().min(0).max(1), fatigue: z.number().min(0).max(1),
  interests: z.array(z.string().min(1).max(80)).max(20), requireGeneralAmerican: z.boolean().optional(),
  recentContentFingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(100).optional(),
  recentSourceIds: z.array(z.string().max(100)).max(100).optional(),
}).strict()
const segmentId = z.string().regex(/^authentic-[a-f0-9]{64}$/u)
const providerStatusPayload = z.object({ action: z.literal('provider-status') }).strict()
// Job authority cannot select arbitrary owner actions, even if added later.
const jobPayload = z.union([z.object({}).strict().transform(() => ({ action: 'refresh' as const })), providerStatusPayload])
const payload = z.discriminatedUnion('action', [
  z.object({ action: z.literal('lessons'), profile: profileSchema, limit: z.number().int().min(1).max(10).optional(), requestId: z.string().min(1).max(80).optional() }).strict(),
  z.object({ action: z.literal('audio'), segmentId }).strict(),
  z.object({ action: z.literal('history'), segmentId, eventId: z.string().min(1).max(100), event: z.enum(['started','completed','skipped']) }).strict(),
  z.object({ action: z.literal('status') }).strict(),
  providerStatusPayload,
  z.object({ action: z.literal('refresh') }).strict(),
])
export function createContentBudget(context: OwnerContext): ContentBudget {
  const owned = new Set<string>()
  return {
    async checkAvailable(request) {
      if (request.ownerId !== context.ownerId) throw new GatewayError(403, 'CONTENT_OWNER', 'Content belongs to a different owner.')
      if (!Number.isFinite(request.maxCostUsd) || request.maxCostUsd <= 0 || request.maxCostUsd > 20)
        throw new GatewayError(503, 'CONTENT_BUDGET', 'The content budget could not be checked.')
      const result = await context.admin.rpc('service_budget_available', { owner_id: context.ownerId, estimated_usd: request.maxCostUsd }).abortSignal(request.signal)
      if (result.error || typeof result.data !== 'boolean') throw new GatewayError(503, 'CONTENT_BUDGET', 'The content budget could not be checked.')
      return result.data
    },
    async reserve(request) {
      if (request.ownerId !== context.ownerId) throw new GatewayError(403, 'CONTENT_OWNER', 'Content belongs to a different owner.')
      const reservation = await reserve(context, request.requestId, request.fingerprint, 'content', request.maxCostUsd)
      if (reservation.acquired) owned.add(reservation.id)
      return { reservationId: reservation.id, allowed: true, acquired: reservation.acquired, replay: !reservation.acquired }
    },
    async settle(outcome) {
      if (!owned.has(outcome.reservationId)) throw new GatewayError(409, 'CONTENT_DISPATCH', 'This job did not acquire the provider dispatch.')
      await settle(context, outcome.reservationId, { status: outcome.status, actualUsd: outcome.usage?.costUsd,
        units: outcome.usage?.units, unitName: outcome.usage?.unitName })
    },
  }
}
async function contentRpc<T>(context: OwnerContext, action: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await context.admin.rpc('content_worker', { action, args: { ...args, ownerId: context.ownerId } })
  if (result.error) throw new GatewayError(result.error.code === '42501' ? 403 : 503, 'CONTENT_PERSISTENCE', 'Content is unavailable or no longer eligible.')
  return result.data as T
}
/** Deployment config only, never Host/Forwarded headers or request JSON. */
export function contentPublicOrigin(env: ServerEnvironment): string {
  const raw = env('JOVE_PUBLIC_SUPABASE_URL') ?? env('SUPABASE_PUBLIC_URL') ?? env('SUPABASE_URL')
  try {
    if (!raw) throw new Error()
    const url = new URL(raw)
    if (raw !== url.origin && raw !== url.origin + '/') throw new Error()
    if (!['http://127.0.0.1:55321', 'http://localhost:55321'].includes(url.origin)) validateSourceUrl(url.origin)
    return url.origin
  } catch { throw new GatewayError(503, 'CONTENT_PUBLIC_ORIGIN', 'Configure this dedicated backend’s public browser origin.') }
}
export function contentSignedPlaybackUrl(signed: string, objectPath: string, env: ServerEnvironment): string {
  const origin = contentPublicOrigin(env)
  try {
    const url = new URL(signed), internal = new URL(env('SUPABASE_URL') ?? origin)
    const path = `/storage/v1/object/sign/jove-content-audio/${objectPath}`
    if (!/^clips\/[a-f0-9]{64}\/[a-f0-9]{64}$/u.test(objectPath) || ![internal.origin, origin].includes(url.origin) ||
        url.username || url.password || url.hash || url.pathname !== path || !url.searchParams.get('token') ||
        [...url.searchParams].length !== 1 || url.searchParams.getAll('token').length !== 1) throw new Error()
    // Preserve only the validated path and signature; SDK uses its internal base URL when signing.
    return origin + path + url.search
  } catch { throw new GatewayError(503, 'CONTENT_SIGNED_URL', 'Audio access could not be safely created.') }
}
async function scheduledOwner(request: Request, env: ServerEnvironment): Promise<OwnerContext> {
  const supplied = request.headers.get('X-Jove-Content-Job') ?? '', expected = env('JOVE_CONTENT_JOB_TOKEN')
  // Hash comparison has fixed length; no URL/query credentials, service JWT or public key accepted as job authority.
  if (!expected || expected.length < 32 || supplied.length > 512 || await digestRequest(supplied) !== await digestRequest(expected)) {
    throw new GatewayError(401, 'CONTENT_JOB_AUTH', 'The scheduled job is not authorized.')
  }
  const url = env('SUPABASE_URL'), key = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new GatewayError(503, 'CONFIGURATION', 'The dedicated content backend is not configured.')
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const result = await admin.rpc('content_worker', { action: 'owner', args: {} })
  if (result.error || !result.data?.ownerId) throw new GatewayError(503, 'CONTENT_OWNER', 'A single configured owner is required for the scheduled job.')
  return { ownerId: result.data.ownerId as string, admin, user: admin }
}

/** Bundle as Deno.serve(createContentHandler(env)). No provider/service credential is sent to the browser.
 * Browser POST uses authenticatedOwner; cron POST uses the separate Vault job token. Test seams are server-owned only. */
export function createContentHandler(env: ServerEnvironment, dependencies: {
  authenticate?: typeof authenticatedOwner
  authenticateJob?: typeof scheduledOwner
  workerOptions?: (context: OwnerContext) => Partial<ContentRefreshOptions>
  providerFetch?: typeof fetch
  now?: () => number
} = {}): (request: Request) => Promise<Response> {
  const now = dependencies.now ?? Date.now
  return async request => {
    let headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    try {
      headers = corsHeaders(request, env)
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
      if (request.method !== 'POST') throw new GatewayError(405, 'METHOD', 'Use POST.')
      const scheduled = request.headers.has('X-Jove-Content-Job')
      if (scheduled && request.headers.has('Origin')) throw new GatewayError(403, 'CONTENT_JOB_ORIGIN', 'Browser requests cannot act as the scheduler.')
      const context = scheduled ? await (dependencies.authenticateJob ?? scheduledOwner)(request, env) :
        await (dependencies.authenticate ?? authenticatedOwner)(request, env)
      const bytes = await boundedBody(request, 32 * 1024)
      let raw: unknown
      try { raw = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {} } catch { throw new GatewayError(400, 'CONTENT_REQUEST', 'Invalid content request.') }
      const parsed = (scheduled ? jobPayload : payload).safeParse(raw)
      if (!parsed.success) throw new GatewayError(400, scheduled ? 'CONTENT_JOB_REQUEST' : 'CONTENT_REQUEST', 'Invalid content request.')
      const body = parsed.data
      if (body.action === 'provider-status') return jsonResponse(await inspectContentProviderAccess({
        env, fetcher: dependencies.providerFetch, now, signal: request.signal,
      }), headers)
      if (body.action === 'status') return jsonResponse(await contentRpc(context, 'status'), headers)
      if (body.action === 'history') {
        await recordContentLearningUse({ adminClient: context.admin, ownerId: context.ownerId, ...body })
        return jsonResponse({ saved: true }, headers)
      }
      if (body.action === 'audio') {
        const record = await contentRpc<PersistedContentSegment>(context, 'playback', { segmentId: body.segmentId })
        if (!record.clip || record.status !== 'eligible') throw new GatewayError(403, 'CONTENT_AUDIO', 'This audio is not eligible.')
        const signed = await context.admin.storage.from('jove-content-audio').createSignedUrl(record.clip.objectPath, 300)
        if (signed.error || !signed.data?.signedUrl) throw new GatewayError(503, 'CONTENT_AUDIO', 'Audio access could not be created.')
        return jsonResponse({ ...record.clip, url: contentSignedPlaybackUrl(signed.data.signedUrl, record.clip.objectPath, env), expiresAt: now() + 300_000,
          segmentId: body.segmentId, sourceId: record.segment.sourceId }, headers)
      }
      if (body.action === 'lessons') {
        await contentRpc(context, 'profile', { profile: body.profile })
        const fingerprint = await digestRequest(JSON.stringify(body.profile))
        const requestId = body.requestId ?? `today-${Math.floor(now() / 86_400_000)}-${fingerprint.slice(0, 24)}`
        const lessons = await selectAndPersistContentLessons({ adminClient: context.admin, ownerId: context.ownerId,
          profile: body.profile, requestId, limit: body.limit, now })
        return jsonResponse({ lessons, requestId }, headers)
      }
      const services = createContentAudioServices({ env, fetcher: dependencies.providerFetch, now })
      try {
        const savedProfile = await contentRpc<z.infer<typeof profileSchema> | null>(context, 'profile')
        const result = await runContentRefresh({ adminClient: context.admin, ownerId: context.ownerId, now,
          analyzeAudio: services.available ? services.analyzeAudio : undefined, transcribe: services.available ? services.transcribe : undefined, analyzerVersion: services.version,
          transcriberVersion: services.version, prepareTranscription: services.prepareTranscription, budget: createContentBudget(context),
          costCeilings: { analysisUsd: 0.5, transcriptionUsd: 0.5 }, profile: savedProfile ?? undefined, audioAcquisition: 'mpeg-prefix-v1',
          limits: { runMs: 110_000, episodesPerSource: 1, segmentsPerEpisode: 2, audioItemsPerRun: 1 },
          ...dependencies.workerOptions?.(context), signal: request.signal,
        })
        const cleanup = await services.dispose()
        if (!services.available) result.nextGates.push('CONTENT_AUDIO_CREDENTIAL_REQUIRED')
        if (cleanup.providerFilesPendingExpiry) result.nextGates.push('provider-file-cleanup-retry-required')
        return jsonResponse({ ...result, providerFilesPendingExpiry: cleanup.providerFilesPendingExpiry }, headers)
      } finally { await services.dispose() }
    } catch (error) { return safeFailure(error, headers) }
  }
}
