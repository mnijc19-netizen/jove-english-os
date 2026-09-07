import { expect, it } from 'vitest'
import { OpenRouterProvider } from '../src/ai/provider'
import { defaultSettings } from '../src/domain/types'

// Explicit public, keyless integration check. Ordinary tests remain deterministic/offline.
it.skipIf(process.env.JOVE_LIVE_CATALOG !== '1')('validates the current public OpenRouter catalog through the actual provider', async () => {
  const provider = new OpenRouterProvider({ getKey: async () => { throw new Error('Catalog must not request credentials') }, getSettings: () => defaultSettings })
  const models = await provider.listModels()
  const counts = Object.fromEntries(['text', 'transcription', 'speech'].map(modality => [modality, models.filter(model => model.outputModalities.includes(modality)).length]))
  expect(counts.text).toBeGreaterThan(0)
  expect(counts.transcription).toBeGreaterThan(0)
  expect(counts.speech).toBeGreaterThan(0)
  expect(models.some(model => model.outputModalities.includes('speech') && model.voices.length > 0)).toBe(true)
  expect(models.some(model => model.structured)).toBe(true)
  console.info('Public catalog counts (no credential or paid requests):', counts)
}, 20_000)
