import { afterEach, describe, expect, it, vi } from 'vitest'
import { withDeadline } from '../src/ai/transport'
import { ProviderError } from '../src/ai/errors'

afterEach(() => vi.useRealTimers())
describe('deadline error boundaries', () => {
  const domain = Object.assign(new Error('Fixture reference unavailable'), { code: 'REFERENCE', status: 422 })
  it('preserves server domain errors only when explicitly requested', async () => {
    await expect(withDeadline(undefined, 1000, async () => { throw domain }, { normalizeErrors: false })).rejects.toBe(domain)
    await expect(withDeadline(undefined, 1000, async () => { throw domain })).rejects.toBeInstanceOf(ProviderError)
  })
  it('keeps caller cancellation ahead of an otherwise preserved domain failure', async () => {
    const controller = new AbortController()
    await expect(withDeadline(controller.signal, 1000, async () => { controller.abort(); throw domain },
      { normalizeErrors: false })).rejects.toMatchObject({ code: 'CANCELLED' })
  })
  it('still ends a stalled server operation at the real configured deadline', async () => {
    vi.useFakeTimers()
    const operation = withDeadline(undefined, 25, () => new Promise(() => undefined), { normalizeErrors: false })
    const failed = expect(operation).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(25); await failed
  })
})
