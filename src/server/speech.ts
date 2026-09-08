import { createAzureSpeechAdapter, type AzureSpeechServerOptions } from '../speech/azure.server'
import { MAX_REFERENCE_AUDIO_BYTES, parseReviewedReference, referenceAudioHash, referenceAudioMime, speechId } from '../speech/references'
import { readBytes, withDeadline, checkAbort } from '../ai/transport'
import { validateAcousticRequest } from '../speech/schemas'
import { inspectAssessmentWav } from '../speech/wav'
import { SPEECH_LIMITS, SpeechError, type AssessmentResult } from '../speech/types'
import { authenticatedOwner, boundedBody, corsHeaders, digestRequest, GatewayError, jsonResponse, reserve, settle,
  type OwnerContext, type ServerEnvironment } from './gateway'

export interface SpeechHandlerOptions {
  env: ServerEnvironment
  authenticate?: typeof authenticatedOwner
  provider?: (options: AzureSpeechServerOptions) => ReturnType<typeof createAzureSpeechAdapter>
}
const referenceColumns = 'id,material_id,reference_text,audio_url,audio_sha256,voice_review,reviewed_at,source_url,rights_evidence,revoked_at'
const fail = (status: number, code: string, message: string) => new GatewayError(status, code, message)
const safeErrors: Record<string, string> = {
  SIGN_IN: 'Sign in again before assessing your saved recording.', NOT_OWNER: 'This account cannot use this learning space.',
  BUDGET: 'Your practice budget has been reached. The original recording stays saved.',
  REFERENCE: 'A currently reviewed General American reference is required. No assessment was submitted.',
  REQUEST_PENDING: 'This attempt is already running or its outcome is uncertain. Check again before choosing a new service attempt.',
  REQUEST_CONFLICT: 'This attempt ID belongs to different saved input. Start a distinct attempt.',
  RESULT_PENDING: 'Provider submission may have completed, but its result could not be confirmed. The original recording stays saved.',
}
function failure(error: unknown, headers: Headers) {
  const code = error instanceof SpeechError ? error.code : error instanceof GatewayError ? error.code : 'UNAVAILABLE'
  const status = error instanceof GatewayError ? error.status : error instanceof SpeechError ? 400 : 503
  const message = safeErrors[code] ?? (error instanceof SpeechError ? error.message : 'The service could not finish safely. Your original recording stays saved.')
  return jsonResponse({ ok: false, error: { code, message, recoverable: true, retryable: true }, usage: [] }, headers, status)
}
async function previous(context: OwnerContext, attemptId: string, fingerprint: string): Promise<unknown | null> {
  const { data, error } = await context.admin.from('acoustic_assessments').select('result,request_fingerprint')
    .eq('user_id', context.ownerId).eq('attempt_id', attemptId).maybeSingle()
  if (error) throw fail(503, 'RESULT_PENDING', '')
  if (data) {
    if (data.request_fingerprint !== fingerprint) throw fail(409, 'REQUEST_CONFLICT', '')
    return data.result
  }
  return null
}
async function referenceAudio(context: OwnerContext, id: string, env: ServerEnvironment, signal: AbortSignal) {
  return withDeadline(signal, 15000, async scoped => {
    const reviewed = async () => {
      const selected = await context.admin.from('pronunciation_references').select(referenceColumns)
        .eq('user_id', context.ownerId).eq('id', id).is('revoked_at', null).maybeSingle()
      checkAbort(scoped)
      if (selected.error || !selected.data) throw fail(422, 'REFERENCE', '')
      return parseReviewedReference(selected.data)
    }
    const reference = await reviewed()
    if (!speechId(context.ownerId)) throw fail(403, 'NOT_OWNER', '')
    const objectPath = `references/${context.ownerId}/${reference.id}/${reference.audioSha256}`
    // Only the operator's exact configured storage origin, including local Edge's
    // http://kong:8000. Neither client input nor audio_url selects a fetch target.
    const configured = new URL(env('SUPABASE_URL') ?? '')
    if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.search || configured.hash || configured.pathname !== '/') throw fail(503, 'CONFIGURATION', '')
    const signed = await context.admin.storage.from('jove-content-audio').createSignedUrl(objectPath, 60)
    checkAbort(scoped)
    if (signed.error || !signed.data?.signedUrl) throw fail(503, 'REFERENCE', '')
    const url = new URL(signed.data.signedUrl)
    const expectedPath = `/storage/v1/object/sign/jove-content-audio/${objectPath}`
    if (url.origin !== configured.origin || url.username || url.password || url.hash || url.pathname !== expectedPath ||
      !url.searchParams.get('token') || [...url.searchParams.keys()].some(key => key !== 'token')) throw fail(422, 'REFERENCE', '')
    const response = await fetch(url.href, { signal: scoped, redirect: 'error', credentials: 'omit', cache: 'no-store' })
    if (!response.ok || response.redirected || Number(response.headers.get('Content-Length') ?? 0) > MAX_REFERENCE_AUDIO_BYTES) {
      void response.body?.cancel().catch(() => undefined); throw fail(422, 'REFERENCE', '')
    }
    const bytes = await readBytes(response, scoped, MAX_REFERENCE_AUDIO_BYTES)
    if (await referenceAudioHash(bytes) !== reference.audioSha256) throw fail(422, 'REFERENCE', '')
    const mimeType = referenceAudioMime(bytes)
    // Revocation during signing/download must not turn into a fresh playable grant.
    const current = await reviewed()
    if (current.audioSha256 !== reference.audioSha256 || current.voiceReview?.reviewId !== reference.voiceReview?.reviewId) throw fail(422, 'REFERENCE', '')
    checkAbort(scoped)
    let binary = ''
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
    return { referenceId: reference.id, audioSha256: reference.audioSha256, byteLength: bytes.length, mimeType, audioBase64: btoa(binary) }
  }, { normalizeErrors: false })
}
/** Authenticated Fetch handler; no serve(), Deno env reads or browser dependency. */
export function createSpeechHandler(options: SpeechHandlerOptions): (request: Request) => Promise<Response> {
  return async request => {
    let headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    try {
      headers = corsHeaders(request, options.env)
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
      if (request.method !== 'POST') throw fail(405, 'METHOD', '')
      const context = await (options.authenticate ?? authenticatedOwner)(request, options.env)
      const contentType = request.headers.get('content-type') ?? ''
      // A bounded authenticated discovery path; no client-authored text or policy.
      if (contentType.startsWith('application/json')) {
        let body: unknown
        try { body = JSON.parse(new TextDecoder().decode(await boundedBody(request, 1024))) }
        catch (error) { if (error instanceof GatewayError) throw error; throw fail(400, 'INVALID_REQUEST', '') }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'INVALID_REQUEST', '')
        const input = body as Record<string, unknown>
        if (input.action === 'reference-audio') {
          if (Object.keys(input).length !== 2 || !speechId(input.referenceId)) throw fail(400, 'INVALID_REQUEST', '')
          return jsonResponse(await referenceAudio(context, input.referenceId, options.env, request.signal), headers)
        }
        if (input.action === 'recover') {
          if (Object.keys(input).length !== 4 || !speechId(input.attemptId) || !speechId(input.recordingId) || !speechId(input.referenceId)) throw fail(400, 'INVALID_REQUEST', '')
          const saved = await context.admin.from('acoustic_assessments').select('result').eq('user_id', context.ownerId)
            .eq('attempt_id', input.attemptId).eq('recording_id', input.recordingId).eq('reference_id', input.referenceId).maybeSingle()
          if (saved.error) throw fail(503, 'RESULT_PENDING', '')
          if (!saved.data) throw fail(404, 'REQUEST_PENDING', '')
          // Historical read only: does not need an active reference, resubmit audio,
          // read an Azure credential or acquire another budget reservation.
          return jsonResponse(saved.data.result, headers)
        }
        const materialId = input.materialId, preferredReferenceId = input.preferredReferenceId
        if (Object.keys(input).some(key => !['action', 'materialId', 'preferredReferenceId'].includes(key)) || input.action !== 'references' ||
          (materialId !== undefined && !speechId(materialId)) || (preferredReferenceId !== undefined && !speechId(preferredReferenceId))) throw fail(400, 'INVALID_REQUEST', '')
        const query = () => {
          let scoped = context.admin.from('pronunciation_references').select(referenceColumns)
            .eq('user_id', context.ownerId).is('revoked_at', null)
          if (materialId !== undefined) scoped = scoped.eq('material_id', materialId)
          return scoped
        }
        // Resume the saved original even when its still-approved reference has
        // fallen outside the browse cap. This never relaxes the reference gate.
        let preferred: ReturnType<typeof parseReviewedReference> | undefined
        if (preferredReferenceId !== undefined) {
          const selected = await query().eq('id', preferredReferenceId).limit(1).maybeSingle()
          if (selected.error) throw fail(503, 'REFERENCE', '')
          if (selected.data) preferred = parseReviewedReference(selected.data)
        }
        // Apply material scope and human-before-synthetic ordering before the cap.
        // Every returned row must still pass the complete review validation below.
        const { data, error } = await query().order('voice_review->>kind', { nullsFirst: false }).order('id').limit(100)
        if (error) throw fail(503, 'REFERENCE', '')
        const references = (data ?? []).map(parseReviewedReference)
        return jsonResponse({ references: preferred ? [preferred, ...references.filter(ref => ref.id !== preferred.id)].slice(0, 100) : references }, headers)
      }
      if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw fail(415, 'TYPE', '')
      const bytes = await boundedBody(request, SPEECH_LIMITS.maxWavBytes + 16384)
      let form: FormData
      try { form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData() }
      catch { throw fail(400, 'INVALID_REQUEST', '') }
      const expected = ['attemptId', 'recordingId', 'referenceId', 'audioWav']
      if ([...form.keys()].length !== 4 || expected.some(key => form.getAll(key).length !== 1) || [...form.keys()].some(key => !expected.includes(key))) throw fail(400, 'INVALID_REQUEST', '')
      const attemptId = form.get('attemptId'), recordingId = form.get('recordingId'), referenceId = form.get('referenceId'), audio = form.get('audioWav')
      if (!speechId(attemptId) || !speechId(recordingId) || !speechId(referenceId) || !(audio instanceof Blob) || audio.size > SPEECH_LIMITS.maxWavBytes || audio.type !== 'audio/wav') throw fail(400, 'INVALID_REQUEST', '')
      const audioWav = new Uint8Array(await audio.arrayBuffer())
      const { durationSeconds } = inspectAssessmentWav(audioWav)
      const selected = await context.admin.from('pronunciation_references').select(referenceColumns).eq('user_id', context.ownerId).eq('id', referenceId).maybeSingle()
      if (selected.error || !selected.data) throw fail(422, 'REFERENCE', '')
      let reference
      try { reference = parseReviewedReference(selected.data) } catch { throw fail(422, 'REFERENCE', '') }
      const fingerprint = await digestRequest(JSON.stringify({ attemptId, recordingId, referenceId, wavSha256: await digestRequest(audioWav),
        referenceSha256: await digestRequest(reference.text), reviewId: reference.voiceReview!.reviewId }))
      const recovered = await previous(context, attemptId, fingerprint)
      if (recovered) return jsonResponse(recovered, headers)
      if (reference.revokedAt) throw fail(422, 'REFERENCE', '')
      const preferences = await context.admin.from('service_preferences').select('prosody_enabled').eq('user_id', context.ownerId).maybeSingle()
      if (preferences.error) throw fail(503, 'CONFIGURATION', '')
      const enableProsody = preferences.data?.prosody_enabled === true
      const input = validateAcousticRequest({ attemptId, recordingId, referenceId, referenceText: reference.text, locale: 'en-US', audioWav, enableProsody })
      const resourceName = options.env('AZURE_SPEECH_RESOURCE_NAME') ?? ''
      if (!resourceName || !options.env('AZURE_SPEECH_KEY')) throw new SpeechError('CONFIGURATION')
      // Conservative hold, NOT invoice reconciliation. No adapter auto-retry.
      // Operator explicitly chooses a per-dispatch hard budget hold. There is no
      // unverified silent .02 fallback. Provider-side credit limits still apply.
      const estimate = Number(options.env('JOVE_SPEECH_MAX_DISPATCH_USD') ?? '')
      const retailFloor = Math.ceil(durationSeconds) * (enableProsody ? 1.3 : 1) / 3600
      if (!Number.isFinite(estimate) || estimate < retailFloor || estimate > 10) throw new SpeechError('CONFIGURATION')
      const provider = (options.provider ?? createAzureSpeechAdapter)({ resourceName,
        getCredentials: async () => ({ subscriptionKey: options.env('AZURE_SPEECH_KEY') ?? '' }), maxRetries: 0 })
      if (request.signal.aborted) throw new SpeechError('CANCELLED')
      const reservation = await reserve(context, attemptId, fingerprint, 'pronunciation', estimate)
      if (reservation.fingerprint !== fingerprint) throw fail(409, 'REQUEST_CONFLICT', '')
      if (!reservation.acquired) {
        const recoveredAfterRace = await previous(context, attemptId, fingerprint)
        if (recoveredAfterRace) return jsonResponse(recoveredAfterRace, headers)
        const cache = await context.admin.from('service_results').select('result').eq('user_id', context.ownerId).eq('request_id', attemptId).gt('expires_at', new Date().toISOString()).maybeSingle()
        if (cache.error) throw fail(503, 'RESULT_PENDING', '')
        if (cache.data) return jsonResponse(cache.data.result, headers)
        // Never steal an in-flight reservation or replay an ambiguous submission.
        return jsonResponse({ ok: false, error: { code: 'REQUEST_PENDING', message: safeErrors.REQUEST_PENDING, recoverable: true, retryable: true }, usage: [],
          retryAsNewAttempt: reservation.status !== 'reserved' || Date.now() - Date.parse(reservation.created_at) > 90000 }, headers, 409)
      }
      let result: AssessmentResult
      try { result = await provider.assess(input, request.signal) }
      catch {
        await settle(context, reservation.id, { status: 'uncertain' })
        throw fail(503, 'RESULT_PENDING', '')
      }
      const units = result.usage.find(row => row.service === 'azure.speech.pronunciation')?.submittedAudioSeconds ?? 0
      if (!result.ok) {
        const outcome = { ...result, retryAsNewAttempt: true }
        const stored = await context.admin.from('service_results').insert({ user_id: context.ownerId, request_id: attemptId, result: outcome })
        await settle(context, reservation.id, { status: units > 0 ? 'uncertain' : 'failed', actualUsd: units > 0 ? null : 0, units, unitName: 'submitted-audio-seconds' })
        if (stored.error) throw fail(503, 'RESULT_PENDING', '')
        return jsonResponse(outcome, headers)
      }
      const assessmentId = crypto.randomUUID(), assessedAt = Date.now()
      const response = { ...result, assessmentId, assessedAt }
      // RPC atomically binds immutable evidence/result to its acquired private ledger
      // row. Response loss or settlement failure recovers without another Azure call.
      const stored = await context.admin.rpc('complete_speech_assessment', { owner_id: context.ownerId, usage_id: reservation.id,
        claim_nonce: reservation.dispatch_nonce, request_fingerprint: fingerprint, assessment_id: assessmentId,
        recording_id: recordingId, reference_id: referenceId, result: response })
      if (stored.error) {
        await settle(context, reservation.id, { status: 'uncertain', units, unitName: 'submitted-audio-seconds' })
        throw fail(503, 'RESULT_PENDING', '')
      }
      await settle(context, reservation.id, { status: 'completed', units, unitName: 'submitted-audio-seconds', actualUsd: null })
      return jsonResponse(response, headers)
    } catch (error) { return failure(error, headers) }
  }
}
