import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quoteSpeechDispatch } from '../src/server/pricing'

const body = { model: 'microsoft/mai-voice-2', voice: 'en-US-Harper:MAI-Voice-2', input: 'Hello there.', response_format: 'mp3' }
const row = { id: body.model, context_length: 0, architecture: { output_modalities: ['speech'] }, pricing: { prompt: '0.000022', completion: '0' } }
let now = Date.now(), fetcher: ReturnType<typeof vi.fn>
beforeEach(() => {
  now += 360_000; vi.spyOn(Date, 'now').mockReturnValue(now)
  fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [row] }), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('verified supplemental speech pricing', () => {
  it('uses the live character-price catalog, accepts zero TTS context length and caches only briefly', async () => {
    const result = await quoteSpeechDispatch(body, () => undefined)
    expect(result.estimateUsd).toBeCloseTo(body.input.length * 0.000022 * 1.1 + 0.001, 7)
    expect(fetcher.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/models?output_modalities=speech')
    await quoteSpeechDispatch(body, () => undefined); expect(fetcher).toHaveBeenCalledOnce()
    vi.mocked(Date.now).mockReturnValue(now + 301_000)
    await quoteSpeechDispatch(body, () => undefined); expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('does not accept a stale operator rate lower than the live published rate', async () => {
    await expect(quoteSpeechDispatch(body, () => '0.00001')).rejects.toMatchObject({ code: 'PRICING' })
  })
  it.each(['wrong-unit', 'wrong-modality', 'missing'])('fails closed for %s catalog data', async kind => {
    const changed = structuredClone(row)
    if (kind === 'wrong-unit') changed.pricing.completion = '0.00001'
    if (kind === 'wrong-modality') changed.architecture.output_modalities = ['text']
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ data: kind === 'missing' ? [] : [changed] })))
    await expect(quoteSpeechDispatch(body, () => undefined)).rejects.toMatchObject({ code: 'PRICING' })
  })
  it('does not apply this model’s rate to another model, voice or cloning request', async () => {
    await expect(quoteSpeechDispatch({ ...body, model: 'another/model' }, () => undefined)).rejects.toBeDefined()
    await expect(quoteSpeechDispatch({ ...body, voice: 'unverified-voice' }, () => undefined)).rejects.toBeDefined()
    await expect(quoteSpeechDispatch({ ...body, input_references: [{ type: 'input_audio' }] }, () => undefined)).rejects.toBeDefined()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
