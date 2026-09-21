import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkPublishedRelease, releaseSchema } from '../src/release'
import { releaseManifest, releaseMetadata } from '../src/build/release'

const release = { schema: 1, buildId: 'aaaaaaa-0123456789ab', revision: 'a'.repeat(40), dirty: false, builtAt: '2026-09-22T00:00:00.000Z' }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('uses one public build identity for the generated metadata and no environment payload', () => {
  const data = releaseMetadata()
  expect(releaseSchema.safeParse(data).success).toBe(true)
  expect(Object.keys(data).sort()).toEqual(['buildId', 'builtAt', 'dirty', 'revision', 'schema'])
  expect(data.revision).toMatch(/^[a-f0-9]{40}$/u)
  const emitFile = vi.fn(), hook = releaseManifest(data).generateBundle
  expect(typeof hook).toBe('function')
  if (typeof hook === 'function') Reflect.apply(hook, { emitFile }, [])
  expect(emitFile).toHaveBeenCalledWith({ type: 'asset', fileName: 'release.json', source: JSON.stringify(data) })
})
it('fetches a fresh relative manifest once, without credentials, and checks the worker without activating it', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(release)), worker = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('fetch', fetcher)
  expect(await checkPublishedRelease('/jove-english-os/', undefined, worker)).toEqual(release)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]?.[0]).toMatch(/^\/jove-english-os\/release.json\?check=\d+$/u)
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' })
  expect(worker).toHaveBeenCalledOnce()
})
it.each([
  () => new Response('offline', { status: 503 }),
  () => new Response('<html>old shell</html>', { headers: { 'content-type': 'text/html' } }),
  () => Response.json({ ...release, schema: 2 }),
  () => Response.json({ ...release, revision: 'unknown' }),
  () => Response.json({ ...release, extra: 'must not execute or display' }),
  () => Response.json({ ...release, builtAt: 'yesterday' }),
  () => new Response('x'.repeat(4097), { headers: { 'content-type': 'application/json' } }),
])('cannot call a failed/malformed response the current release', async response => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
  await expect(checkPublishedRelease('/jove-english-os/')).rejects.toThrow()
})
it('bounds a stalled request without a retry', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn(() => new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', fetcher)
  const result = expect(checkPublishedRelease('/jove-english-os/')).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(8001)
  await result
  expect(fetcher).toHaveBeenCalledOnce()
})
it('bounds a stalled worker check as well as manifest IO', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(release)))
  const result = expect(checkPublishedRelease('/jove-english-os/', undefined, () => new Promise<void>(() => {}))).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(8001)
  await result
})
it('honors disposal and does not precache the public release JSON', async () => {
  const controller = new AbortController(); controller.abort()
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(checkPublishedRelease('/jove-english-os/', controller.signal)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
  const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
  expect(config).toContain('globPatterns: ["**/*.{js,css,html,svg,wav,png}"]')
})
