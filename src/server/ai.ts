import { z } from 'zod'
import { OpenRouterProvider, type ProviderOptions } from '../ai/provider'
import { defaultSettings, type Usage } from '../domain/types'
import { authenticatedOwner, boundedBody, corsHeaders, digestRequest, GatewayError, jsonResponse, reserve, safeFailure, settle, type OwnerContext, type ServerEnvironment } from './gateway'
import { currentTextPrice, quoteAudioDispatch, quoteSpeechDispatch, quoteTextDispatch } from './pricing'
import { withDeadline } from '../ai/transport'

const text = z.string().trim().min(1).max(16000), targets = z.array(z.string().max(200)).max(20)
const identity = { requestId: z.uuid() }
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
])
export type AIRequest = z.infer<typeof aiRequestSchema>
type Provider = Pick<OpenRouterProvider, 'evaluate' | 'chat' | 'lookup' | 'analyzeMaterial' | 'generateMaterial' | 'discover' | 'transcribe' | 'synthesize' | 'takeNotices' | 'testConnection'>
export interface AIHandlerOptions {
  env: ServerEnvironment;
  authenticate?: typeof authenticatedOwner;
  provider?: (options: ProviderOptions) => Provider;
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
      // Supplemental synthetic practice only; this default does not certify a
      // General American reference or bypass the separately reviewed speech flow.
      const settings = { ...defaultSettings, fastModel: env('JOVE_FAST_MODEL') ?? 'google/gemini-3.8-flash', strongModel: env('JOVE_STRONG_MODEL') ?? 'anthropic/claude-opus-5',
        sttModel: env('JOVE_STT_MODEL') ?? 'deepgram/nova-3', ttsModel: env('JOVE_TTS_MODEL') ?? 'microsoft/mai-voice-2', voice: env('JOVE_TTS_VOICE') ?? 'en-US-Harper:MAI-Voice-2' }
      if (input.action === 'status') {
        if (!env('OPENROUTER_API_KEY')) throw new GatewayError(503, 'CONFIGURATION', 'The account AI service needs server configuration.')
        const verifier = (options.provider ?? (value => new OpenRouterProvider(value)))({ getKey: async () => env('OPENROUTER_API_KEY') ?? '', getSettings: () => settings })
        await verifier.testConnection(request.signal)
        return jsonResponse({ value: { label: 'Account AI connection verified' }, notices: [], usage: [] }, headers)
      }
      const model = input.action === 'transcribe' ? settings.sttModel : input.action === 'synthesize' ? settings.ttsModel
        : ['chat', 'discover'].includes(input.action) ? settings.fastModel : settings.strongModel
      if (!model || !env('OPENROUTER_API_KEY')) throw new GatewayError(503, 'CONFIGURATION', 'The account AI service needs server configuration. Your saved practice remains available.')
      // This zero-price logical row only excludes duplicate dispatchers. Every
      // actual upstream attempt reserves its own independently quoted budget.
      const reservation = await reserve(context, input.requestId, await digestRequest(JSON.stringify(input)),
        input.action === 'transcribe' ? 'stt' : input.action === 'synthesize' ? 'tts' : 'llm', 0)
      if (!reservation.acquired) {
        const prior = await cached(context, input.requestId)
        if (prior !== undefined) return jsonResponse(prior, headers)
        if (['failed', 'uncertain'].includes(reservation.status) || Date.now() - Date.parse(reservation.created_at) > 120000)
          throw new GatewayError(409, 'REQUEST_UNCERTAIN', 'The earlier request has no confirmed result. A new attempt may incur another charge.')
        throw new GatewayError(409, 'REQUEST_PENDING', 'This request is already recorded. Its result is not ready; your saved input can be retried as a new attempt.')
      }
      const usage: Usage[] = []
      let activeDispatch: Awaited<ReturnType<typeof reserve>> | undefined
      let dispatchIndex = 0
      let dispatchFailure: GatewayError | undefined
      const provider = (options.provider ?? (value => new OpenRouterProvider(value)))({
        getKey: async () => env('OPENROUTER_API_KEY') ?? '', getSettings: () => settings,
        beforeDispatch: async (dispatch, signal) => {
          try {
          const quote = dispatch.path === '/chat/completions'
            ? quoteTextDispatch(dispatch.body, await currentTextPrice(dispatch.model, signal))
            : dispatch.path === '/audio/speech' ? await quoteSpeechDispatch(dispatch.body, env, signal)
            : quoteAudioDispatch(dispatch.path, dispatch.body, env)
          activeDispatch = await reserve(context, `${input.requestId}:${++dispatchIndex}`, await digestRequest(JSON.stringify(quote.body)),
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
      const finish = async (value: unknown) => {
        const result = { value, notices: provider.takeNotices(), usage }
        const stored = await persistResult(context, input.requestId, result)
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
        }
        return jsonResponse(await finish(value), headers)
      } catch (error) { await failed(); throw dispatchFailure ?? error }
    } catch (error) { return safeFailure(error, headers) }
  }
}
