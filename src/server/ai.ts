import { z } from 'zod'
import { checkedStarterAttempt, checkedStarterFeedback, OpenRouterProvider, type ProviderOptions } from '../ai/provider'
import { defaultSettings, type StudyEvent, type Usage } from '../domain/types'
import { authenticatedOwner, boundedBody, corsHeaders, digestRequest, GatewayError, jsonResponse, reserve, safeFailure, settle, type OwnerContext, type ServerEnvironment } from './gateway'
import { currentTextPrice, quoteAudioDispatch, quoteSpeechDispatch, quoteTextDispatch } from './pricing'
import { withDeadline } from '../ai/transport'
import { eventSchema } from '../db/schema'
import { starterAttemptFromEvent, type StarterAttempt } from '../domain/starter'
import type { LearningLanguage } from '../domain/language'

const text = z.string().trim().min(1).max(16000), targets = z.array(z.string().max(200)).max(20)
// Keep absent language absent in legacy English request hashes/receipts.
const identity = { requestId: z.uuid(), learningLanguage: z.enum(['en', 'ja']).optional() }
export const aiRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...identity, action: z.literal('status') }),
  z.strictObject({ ...identity, action: z.literal('evaluate'), input: z.strictObject({ kind: z.string().trim().min(1).max(80), text, reference: text.optional(), targets: targets.optional(), rubric: z.string().max(8000).optional() }) }),
  z.strictObject({ ...identity, action: z.literal('chat'), messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(4000) })).min(1).max(12),
    context: z.strictObject({ scenario: z.string().max(500), mode: z.string().max(100), level: z.string().max(100), targets }), stream: z.boolean().optional() }),
  z.strictObject({ ...identity, action: z.literal('lookup'), expression: z.string().min(1).max(200), sourceSentence: z.string().min(1).max(2000) }),
  z.strictObject({ ...identity, action: z.literal('analyzeMaterial'), text }),
  z.strictObject({ ...identity, action: z.literal('generateMaterial'), topic: z.string().min(1).max(500) }),
  z.strictObject({ ...identity, action: z.literal('discover'), topic: z.string().min(1).max(500) }),
  z.strictObject({ ...identity, action: z.literal('transcribe'), audioBase64: z.string().min(1).max(14000000), mimeType: z.enum(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/flac', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/aac']) }),
  z.strictObject({ ...identity, action: z.literal('synthesize'), text: z.string().trim().min(1).max(800) }),
  z.strictObject({ ...identity, action: z.literal('starterFeedback'), attemptId: z.string().trim().min(1).max(1000), review: z.boolean().optional() }),
])
export type AIRequest = z.infer<typeof aiRequestSchema>
type Provider = Pick<OpenRouterProvider, 'evaluate' | 'chat' | 'lookup' | 'analyzeMaterial' | 'generateMaterial' | 'discover' | 'transcribe' | 'synthesize' | 'takeNotices' | 'testConnection'>
  & Partial<Pick<OpenRouterProvider, 'starterFeedback'>>
export interface AIHandlerOptions {
  env: ServerEnvironment;
  authenticate?: typeof authenticatedOwner;
  provider?: (options: ProviderOptions) => Provider;
}

type StarterFeedbackRound = 1 | 2
const starterLogicalId = async (ownerId: string, language: LearningLanguage, id: string, round: StarterFeedbackRound) =>
  `starter:${await digestRequest(JSON.stringify([ownerId, language, id, round]))}`
const starterFingerprint = (attempt: StarterAttempt, language: LearningLanguage, round: StarterFeedbackRound) =>
  digestRequest(JSON.stringify({ action: 'starterFeedback', learningLanguage: language, attempt, feedbackRevision: round }))

/** Use the owner-scoped RLS client for both original answers and dispute evidence. */
async function starterEvents(context: OwnerContext, id: string, language: LearningLanguage, signal: AbortSignal): Promise<StudyEvent[]> {
  const table = language === 'en' ? 'sync_operations' : 'language_sync_operations'
  const columns = language === 'ja' ? 'user_id,entity_id,kind,payload,learning_language' : 'user_id,entity_id,kind,payload'
  let query = context.user.from(table).select(columns)
    .eq('user_id', context.ownerId).eq('entity_type', 'events').eq('entity_id', id).eq('kind', 'put')
  if (language === 'ja') query = query.eq('learning_language', 'ja')
  const { data, error } = await query.limit(101).abortSignal(signal)
  if (error) throw new GatewayError(503, 'ATTEMPT_LOOKUP', 'Could not verify your saved answer. Local teaching remains available.')
  if (!data?.length) return []
  if (data.length > 100) throw new GatewayError(409, 'ATTEMPT_CONFLICT', 'This saved answer needs reconciliation. Originals are retained.')
  return data.map(raw => {
    const parsed = z.object({ user_id: z.uuid(), entity_id: z.string(), kind: z.literal('put'),
      payload: z.object({ record: z.unknown() }), learning_language: z.enum(['en', 'ja']).optional() }).safeParse(raw)
    if (!parsed.success) throw new GatewayError(400, 'INPUT', 'This saved answer is not a valid classroom attempt.')
    const row = parsed.data, event = eventSchema.safeParse(row.payload.record)
    if (row.user_id !== context.ownerId || row.entity_id !== id || row.kind !== 'put' || language === 'ja' && row.learning_language !== 'ja'
      || !event.success || event.data.id !== id) throw new GatewayError(400, 'INPUT', 'This saved answer is not a valid classroom attempt.')
    return event.data
  })
}

/** Resolve only the signed-in owner's immutable attempt, never client teaching criteria. */
async function resolveStarterAttempt(context: OwnerContext, id: string, language: LearningLanguage, signal: AbortSignal): Promise<StarterAttempt> {
  const events = await starterEvents(context, id, language, signal)
  if (!events.length) throw new GatewayError(409, 'ATTEMPT_NOT_SYNCED', 'Sync this saved answer before requesting feedback. Local teaching remains available.')
  let original: StarterAttempt | undefined, fingerprint: string | undefined
  for (const event of events) {
    if (!['text', 'objective'].includes(event.source)) throw new GatewayError(400, 'INPUT', 'This saved answer is not a valid classroom attempt.')
    const candidate = starterAttemptFromEvent(event)
    let checked: StarterAttempt
    try {
      if (!candidate) throw new Error('Not a starter attempt')
      checked = checkedStarterAttempt(candidate, language).attempt
    } catch { throw new GatewayError(400, 'INPUT', 'The saved answer does not match this course, stage or version.') }
    const next = await digestRequest(JSON.stringify(checked))
    if (fingerprint !== undefined && fingerprint !== next) throw new GatewayError(409, 'ATTEMPT_CONFLICT', 'Different originals were found for this answer. Reconcile them before feedback.')
    original = checked; fingerprint = next
  }
  return original!
}

async function resolveStarterReview(context: OwnerContext, attempt: StarterAttempt, language: LearningLanguage, signal: AbortSignal) {
  const disputes = await starterEvents(context, `${attempt.id}:disputed`, language, signal)
  if (!disputes.length) throw new GatewayError(409, 'REVIEW_NOT_DISPUTED', 'Sync the dispute for this saved answer before requesting its one independent review.')
  let fingerprint: string | undefined
  for (const event of disputes) {
    if (event.type !== 'STARTER_FEEDBACK_DISPUTED' || event.source !== 'self-report' || event.sessionId !== attempt.sessionId
      || event.data?.attemptId !== attempt.id || event.data.lessonId !== attempt.lessonId || event.data.reason !== 'learner-disagrees'
      || event.timestamp < attempt.timestamp || event.timestamp > Date.now())
      throw new GatewayError(400, 'INPUT', 'The saved dispute does not match this original answer.')
    const next = await digestRequest(JSON.stringify(event))
    if (fingerprint !== undefined && fingerprint !== next) throw new GatewayError(409, 'ATTEMPT_CONFLICT', 'Different dispute originals need reconciliation before review.')
    fingerprint = next
  }
  const firstId = await starterLogicalId(context.ownerId, language, attempt.id, 1)
  const prior = await cached(context, firstId)
  if (typeof prior !== 'object' || prior === null || !('value' in prior))
    throw new GatewayError(409, 'REVIEW_NOT_READY', 'The first account feedback must be confirmed before independent review. Your original answer is retained.')
  const { data, error } = await context.admin.from('service_usage').select('fingerprint')
    .eq('user_id', context.ownerId).eq('request_id', firstId).abortSignal(signal).maybeSingle()
  const recorded = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(data)
  if (error || !recorded.success) throw new GatewayError(503, 'REVIEW_NOT_READY', 'The first feedback identity could not be verified safely.')
  if (recorded.data.fingerprint !== await starterFingerprint(attempt, language, 1))
    throw new GatewayError(409, 'ATTEMPT_CONFLICT', 'The original answer differs from its first feedback. Reconcile it before review.')
  let first
  try { first = checkedStarterFeedback(prior.value, attempt, language) }
  catch { throw new GatewayError(409, 'REVIEW_NOT_READY', 'The first feedback cannot be verified against this saved answer.') }
  if (!first.model) throw new GatewayError(409, 'REVIEW_MODEL_UNVERIFIED', 'The first model provenance is unavailable; an independent model cannot be verified safely.')
  return first
}

function reboundResult(value: unknown, requestId: string): unknown {
  if (typeof value !== 'object' || value === null || !('delivery' in value)) return value
  return { ...value, delivery: { requestId, cache: 'unconfirmed' } }
}
function binaryBlob(encoded: string, mime: string): Blob {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) throw new GatewayError(400, 'INPUT', 'Invalid audio encoding.')
  try { return new Blob([Uint8Array.from(atob(encoded), char => char.charCodeAt(0))], { type: mime }) }
  catch { throw new GatewayError(400, 'INPUT', 'Invalid audio encoding.') }
}
async function binaryResult(blob: Blob) {
  if (blob.size > 1_400_000) throw new GatewayError(413, 'AUDIO_LIMIT', 'Use a shorter phrase for synthesized practice.')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let value = ''
  for (let index = 0; index < bytes.length; index += 8192) value += String.fromCharCode(...bytes.subarray(index, index + 8192))
  return { audioBase64: btoa(value), mimeType: blob.type }
}
async function cached(context: OwnerContext, requestId: string): Promise<unknown | undefined> {
  const { data, error } = await context.admin.from('service_results').select('result').eq('user_id', context.ownerId).eq('request_id', requestId).gt('expires_at', new Date().toISOString()).maybeSingle()
  if (error) throw new GatewayError(503, 'CACHE', 'Could not check the earlier result safely.')
  return data?.result
}

/** Retry storage only, never the paid computation. Also handles a committed
 * INSERT whose acknowledgement was lost: a duplicate key is checked by readback. */
async function persistResult(context: OwnerContext, requestId: string, result: unknown): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 100))
    try {
      const stored = await withDeadline(undefined, 2000, async signal => {
        const { error } = await context.admin.from('service_results')
          .insert({ user_id: context.ownerId, request_id: requestId, result }).abortSignal(signal)
        if (!error) return true
        if (error.code !== '23505') return false
        const prior = await context.admin.from('service_results').select('result')
          .eq('user_id', context.ownerId).eq('request_id', requestId)
          .gt('expires_at', new Date().toISOString()).abortSignal(signal).maybeSingle()
        return !prior.error && prior.data?.result !== undefined
      })
      if (stored) return true
    } catch { /* bounded transient DB failure; keep the received result */ }
  }
  return false
}

/** Server gateway: the browser never selects endpoints, supplies keys, or receives them. */
export function createAIHandler(options: AIHandlerOptions): (request: Request) => Promise<Response> {
  const env = options.env
  return async request => {
    let headers = new Headers({ 'Cache-Control': 'no-store' })
    try {
      headers = corsHeaders(request, env)
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
      if (request.method !== 'POST') throw new GatewayError(405, 'METHOD', 'Use POST for this endpoint.')
      const context = await (options.authenticate ?? authenticatedOwner)(request, env)
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new GatewayError(415, 'TYPE', 'Use JSON for this endpoint.')
      let body: unknown
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(request, 15_000_000))) }
      catch (error) { if (error instanceof GatewayError) throw error; throw new GatewayError(400, 'INPUT', 'Invalid request body.') }
      const parsed = aiRequestSchema.safeParse(body)
      if (!parsed.success) throw new GatewayError(400, 'INPUT', 'Check the practice request and try again.')
      const input = parsed.data
      const learningLanguage = input.learningLanguage ?? 'en'
      const starterAttempt = input.action === 'starterFeedback'
        ? await resolveStarterAttempt(context, input.attemptId, learningLanguage, request.signal) : undefined
      const review = input.action === 'starterFeedback' && input.review === true
      const round: StarterFeedbackRound = review ? 2 : 1
      const firstFeedback = review ? await resolveStarterReview(context, starterAttempt!, learningLanguage, request.signal) : undefined
      const logicalId = starterAttempt
        ? await starterLogicalId(context.ownerId, learningLanguage, starterAttempt.id, round) : input.requestId
      const fingerprint = starterAttempt ? await starterFingerprint(starterAttempt, learningLanguage, round) : await digestRequest(JSON.stringify(input))
      // Supplemental synthetic practice only; this default does not certify a
      // General American reference or bypass the separately reviewed speech flow.
      const settings = { ...defaultSettings, fastModel: env('JOVE_FAST_MODEL') ?? 'google/gemini-3.8-flash', strongModel: env('JOVE_STRONG_MODEL') ?? 'anthropic/claude-opus-5',
        sttModel: env('JOVE_STT_MODEL') ?? 'deepgram/nova-3', ttsModel: env('JOVE_TTS_MODEL') ?? 'microsoft/mai-voice-2', voice: env('JOVE_TTS_VOICE') ?? 'en-US-Harper:MAI-Voice-2' }
      if (learningLanguage === 'ja') {
        // Never silently send Japanese through an English-only speech setup.
        settings.sttModel = env('JOVE_JA_STT_MODEL') ?? 'deepgram/nova-3'
        settings.ttsModel = env('JOVE_JA_TTS_MODEL') ?? ''
        settings.voice = env('JOVE_JA_TTS_VOICE') ?? ''
      }
      if (review && (!settings.fastModel || settings.fastModel === settings.strongModel || settings.fastModel === firstFeedback?.model))
        throw new GatewayError(503, 'REVIEW_MODEL_CONFIG', 'Independent review needs a different configured fast model. No new model call was made.')
      if (input.action === 'status') {
        if (!env('OPENROUTER_API_KEY')) throw new GatewayError(503, 'CONFIGURATION', 'The account AI service needs server configuration.')
        const verifier = (options.provider ?? (value => new OpenRouterProvider(value)))({ learningLanguage, getKey: async () => env('OPENROUTER_API_KEY') ?? '', getSettings: () => settings })
        await verifier.testConnection(request.signal)
        return jsonResponse({ value: { label: 'Account AI connection verified' }, notices: [], usage: [] }, headers)
      }
      const model = input.action === 'transcribe' ? settings.sttModel : input.action === 'synthesize' ? settings.ttsModel
        : review || ['chat', 'discover'].includes(input.action) ? settings.fastModel : settings.strongModel
      if (!model || !env('OPENROUTER_API_KEY')) throw new GatewayError(503, 'CONFIGURATION', 'The account AI service needs server configuration. Your saved practice remains available.')
      const usage: Usage[] = []
      let activeDispatch: Awaited<ReturnType<typeof reserve>> | undefined
      let dispatchIndex = 0
      let dispatchFailure: GatewayError | undefined
      const provider = (options.provider ?? (value => new OpenRouterProvider(value)))({
        learningLanguage,
        getKey: async () => env('OPENROUTER_API_KEY') ?? '', getSettings: () => settings,
        beforeDispatch: async (dispatch, signal) => {
          try {
          if (review && dispatch.model !== settings.fastModel)
            throw new GatewayError(503, 'REVIEW_MODEL_CONFIG', 'Independent review cannot fall back to the first model.')
          const quote = dispatch.path === '/chat/completions'
            ? quoteTextDispatch(dispatch.body, await currentTextPrice(dispatch.model, signal))
            : dispatch.path === '/audio/speech' ? await quoteSpeechDispatch(dispatch.body, env, signal)
            : quoteAudioDispatch(dispatch.path, dispatch.body, env)
          activeDispatch = await reserve(context, `${logicalId}:${++dispatchIndex}`, await digestRequest(JSON.stringify(quote.body)),
            dispatch.path === '/audio/transcriptions' ? 'stt' : dispatch.path === '/audio/speech' ? 'tts' : 'llm', quote.estimateUsd)
          if (!activeDispatch.acquired) throw new GatewayError(409, 'REQUEST_PENDING', 'This service attempt is already recorded.')
          return quote.body
          } catch (error) {
            // The reusable provider normalizes arbitrary exceptions. Preserve only
            // our own sanitized budget/configuration errors across that boundary.
            if (error instanceof GatewayError) dispatchFailure = error
            throw error
          }
        },
        onUsage: async row => {
          usage.push(row)
          if (!activeDispatch) throw new GatewayError(503, 'RESERVATION', 'The service attempt has no confirmed budget reservation.')
          await settle(context, activeDispatch.id, { status: row.cost === null ? 'uncertain' : 'completed', actualUsd: row.cost,
            units: row.tokens ?? 0, unitName: 'reported-tokens' })
          activeDispatch = undefined
        },
      })
      if (input.action === 'starterFeedback' && !provider.starterFeedback)
        throw new GatewayError(503, 'CONFIGURATION', 'The classroom feedback adapter is not configured. Local teaching remains available.')
      // This zero-price logical row only excludes duplicate dispatchers. Every
      // actual upstream attempt reserves its own independently quoted budget.
      const reservation = await reserve(context, logicalId, fingerprint,
        input.action === 'transcribe' ? 'stt' : input.action === 'synthesize' ? 'tts' : 'llm', 0)
      if (!reservation.acquired) {
        const prior = await cached(context, logicalId)
        if (prior !== undefined) return jsonResponse(input.action === 'starterFeedback' ? reboundResult(prior, input.requestId) : prior, headers)
        if (['failed', 'uncertain'].includes(reservation.status) || Date.now() - Date.parse(reservation.created_at) > 120000)
          throw new GatewayError(409, 'REQUEST_UNCERTAIN', 'The earlier request has no confirmed result. A new attempt may incur another charge.')
        throw new GatewayError(409, 'REQUEST_PENDING', 'This request is already recorded. Its result is not ready; your saved input can be retried as a new attempt.')
      }
      const finish = async (value: unknown) => {
        const result = { value, notices: provider.takeNotices(), usage }
        const stored = await persistResult(context, logicalId, result)
        try {
          await withDeadline(undefined, 2000, () => settle(context, reservation.id,
            { status: stored ? 'completed' : 'uncertain', actualUsd: 0, units: 0, unitName: 'logical-request' }))
        } catch { /* the reservation still excludes duplicate paid dispatchers */ }
        // Deliver received work even during a sustained cache outage. The client
        // must save this owner-bound receipt before applying it, and replay it
        // locally. If neither delivery nor server persistence succeeds, recovery
        // genuinely is unknown; the existing explicit new-charge warning applies.
        return stored ? result : { ...result, delivery: { requestId: input.requestId, cache: 'unconfirmed' as const } }
      }
      const failed = async () => {
        // Never pretend an uncertain network submission was free.
        if (activeDispatch) await settle(context, activeDispatch.id, { status: 'uncertain', actualUsd: null })
        await settle(context, reservation.id, { status: 'uncertain', actualUsd: 0, units: 0, unitName: 'logical-request' })
      }
      if (input.action === 'chat' && input.stream) {
        const controller = new AbortController(), encoder = new TextEncoder()
        const abort = () => controller.abort()
        request.signal.addEventListener('abort', abort, { once: true })
        const stream = new ReadableStream<Uint8Array>({
          start(output) {
            const send = (value: unknown) => output.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
            void provider.chat(input.messages, input.context, delta => send({ delta }), controller.signal)
              .then(async value => { send({ result: await finish(value) }); output.enqueue(encoder.encode('data: [DONE]\n\n')); output.close() })
              .catch(async () => { try { await failed(); send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Conversation could not finish. Your saved message is safe.' } }); output.close() } catch { try { output.error(new Error('Service interrupted')) } catch { /* consumer already cancelled */ } } })
              .finally(() => request.signal.removeEventListener('abort', abort))
          },
          cancel() { controller.abort() },
        })
        headers.set('Content-Type', 'text/event-stream')
        return new Response(stream, { headers })
      }
      try {
        let value: unknown
        switch (input.action) {
          case 'evaluate': value = await provider.evaluate(input.input, request.signal); break
          case 'chat': value = await provider.chat(input.messages, input.context, undefined, request.signal); break
          case 'lookup': value = await provider.lookup(input.expression, input.sourceSentence, request.signal); break
          case 'analyzeMaterial': value = await provider.analyzeMaterial(input.text, request.signal); break
          case 'generateMaterial': value = await provider.generateMaterial(input.topic, request.signal); break
          case 'discover': value = await provider.discover(input.topic, request.signal); break
          case 'transcribe': value = await provider.transcribe(binaryBlob(input.audioBase64, input.mimeType), request.signal); break
          case 'synthesize': value = await binaryResult(await provider.synthesize(input.text, request.signal)); break
          case 'starterFeedback': {
            if (!provider.starterFeedback) throw new GatewayError(503, 'CONFIGURATION', 'The classroom feedback adapter is not configured. Local teaching remains available.')
            const feedback = checkedStarterFeedback(await provider.starterFeedback(starterAttempt!, request.signal, { review }), starterAttempt!, learningLanguage)
            if (review && (!feedback.model || feedback.model === firstFeedback?.model || feedback.model === settings.strongModel))
              throw new GatewayError(503, 'REVIEW_MODEL_UNVERIFIED', 'The returned model cannot establish an independent review. Both the original answer and incurred usage are retained.')
            value = feedback
            break
          }
        }
        return jsonResponse(await finish(value), headers)
      } catch (error) { await failed(); throw dispatchFailure ?? error }
    } catch (error) { return safeFailure(error, headers) }
  }
}
