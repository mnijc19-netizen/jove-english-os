import { z } from 'zod'
import { publicGet, withDeadline } from '../ai/transport'
import { transcriptionWavDuration } from '../audio/transcription'
import { GatewayError, type ServerEnvironment } from './gateway'

const price = z.union([z.string().regex(/^\d+(?:\.\d+)?$/), z.number()]).transform(Number).pipe(z.number().finite().nonnegative())
const modelPrice = z.object({ id: z.string(), context_length: z.number().int().positive().optional(),
  pricing: z.object({ prompt: price, completion: price, request: price.optional() }) })
const modelPrices = z.object({ data: z.array(z.unknown()).max(10000) })
type ModelPrice = z.infer<typeof modelPrice>
let catalog: { fetchedAt: number; models: unknown[] } | undefined
let speechCatalog: { fetchedAt: number; models: unknown[] } | undefined
/** Character pricing is verified separately; context_length=0 is normal for TTS. */
export async function quoteSpeechDispatch(body: object, env: ServerEnvironment, signal?: AbortSignal): Promise<{ estimateUsd: number; body: object }> {
  const input = z.strictObject({ model: z.literal('microsoft/mai-voice-2'), voice: z.literal('en-US-Harper:MAI-Voice-2'),
    input: z.string().trim().min(1).max(800), response_format: z.literal('mp3') }).parse(body)
  if (!speechCatalog || Date.now() - speechCatalog.fetchedAt > 300000) {
    const data = await withDeadline(signal, 15000, scoped => publicGet('/models?output_modalities=speech', scoped))
    const checked = modelPrices.safeParse(data)
    if (!checked.success) throw new GatewayError(503, 'PRICING', 'Could not verify current speech pricing.')
    speechCatalog = { fetchedAt: Date.now(), models: checked.data.data }
  }
  const selected = z.object({ id: z.literal(input.model), architecture: z.object({ output_modalities: z.array(z.string()) }),
    pricing: z.object({ prompt: price, completion: price, request: price.optional() }) })
    .safeParse(speechCatalog.models.find(item => typeof item === 'object' && item !== null && 'id' in item && item.id === input.model))
  if (!selected.success || !selected.data.architecture.output_modalities.includes('speech') || selected.data.pricing.completion !== 0)
    throw new GatewayError(503, 'PRICING', 'The configured speech model price units need verification.')
  const published = selected.data.pricing.prompt
  const rate = Number(env('JOVE_TTS_USD_PER_CHARACTER') ?? published)
  if (!Number.isFinite(rate) || rate < published || rate <= 0 || rate > 0.001)
    throw new GatewayError(503, 'PRICING', 'The speech price policy is below the current published character rate.')
  // UTF-16 length conservatively counts supplementary Unicode characters twice.
  // This is a budget hold, not a reported provider invoice or certified voice.
  return { estimateUsd: Math.ceil((input.input.length * rate * 1.1 + (selected.data.pricing.request ?? 0) + 0.001) * 1e8) / 1e8, body }
}
export async function currentTextPrice(model: string, signal?: AbortSignal): Promise<ModelPrice> {
  if (!catalog || Date.now() - catalog.fetchedAt > 300000) {
    const data = await withDeadline(signal, 15000, scoped => publicGet('/models?output_modalities=text', scoped))
    const checked = modelPrices.safeParse(data)
    if (!checked.success) throw new GatewayError(503, 'PRICING', 'Could not verify current model pricing. Your practice remains saved.')
    catalog = { fetchedAt: Date.now(), models: checked.data.data }
  }
  const selected = modelPrice.safeParse(catalog.models.find(item => typeof item === 'object' && item !== null && 'id' in item && item.id === model))
  if (!selected.success) throw new GatewayError(503, 'PRICING', 'The configured model pricing is not available.')
  return selected.data
}
export function quoteTextDispatch(body: object, model: ModelPrice): { estimateUsd: number; body: object } {
  const checked = z.object({ model: z.literal(model.id), max_tokens: z.number().int().min(1).max(6000), messages: z.array(z.unknown()),
    provider: z.record(z.string(), z.unknown()).optional(), plugins: z.array(z.object({ id: z.literal('web'), engine: z.literal('exa'), max_results: z.number().int().min(1).max(3) })).max(1).optional() }).parse(body)
  const bytes = new TextEncoder().encode(JSON.stringify(body)).length
  // UTF-8 bytes plus framing conservatively bound ordinary text tokenization.
  // Search injects unseen text: reserve the published model context, not a guess.
  const promptBound = checked.plugins?.length ? model.context_length : bytes + 4096
  if (!promptBound || promptBound > 4000000) throw new GatewayError(503, 'PRICING', 'The search context budget could not be verified.')
  const { prompt, completion, request = 0 } = model.pricing
  const estimateUsd = (promptBound * prompt + checked.max_tokens * completion + request + (checked.plugins?.length ? 0.007 : 0)) * 1.05
  if (!Number.isFinite(estimateUsd) || estimateUsd > 1000) throw new GatewayError(503, 'PRICING', 'The request cost could not be bounded safely.')
  return { estimateUsd: Math.ceil(estimateUsd * 1e8) / 1e8, body: { ...body, provider: { ...checked.provider,
    data_collection: 'deny', max_price: { prompt: prompt * 1e6, completion: completion * 1e6, request } } } }
}
/** Explicit audio pricing units avoid confusing dollars/minute with dollars/token. */
export function quoteAudioDispatch(path: string, body: object, env: ServerEnvironment): { estimateUsd: number; body: object } {
  if (path === '/audio/transcriptions') {
    const input = z.object({ model: z.literal('deepgram/nova-3'), input_audio: z.object({ data: z.string(), format: z.literal('wav') }) }).parse(body)
    const duration = transcriptionWavDuration(Uint8Array.from(atob(input.input_audio.data), char => char.charCodeAt(0)))
    const rate = Number(env('JOVE_STT_USD_PER_MINUTE') ?? '0.0043')
    if (!Number.isFinite(rate) || rate < 0.0043 || rate > 1) throw new GatewayError(503, 'PRICING', 'The transcription price policy needs verification.')
    return { estimateUsd: Math.ceil((duration / 60 * rate * 1.1 + 0.001) * 1e8) / 1e8, body }
  }
  throw new GatewayError(503, 'PRICING', 'This audio operation requires separately verified price units.')
}
