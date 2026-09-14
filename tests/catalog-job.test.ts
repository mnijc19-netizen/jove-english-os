import { describe, expect, it, vi } from 'vitest'
import { refreshCourseDirectory } from '../scripts/refresh-course-directory.mjs'

const token = 'd'.repeat(64) // Fixture only, not a deployed credential.
describe('directory-only scheduler client', () => {
  it('uses one fixed endpoint/action without redirects or a user credential', async () => {
    const fetcher = vi.fn(async () => Response.json({ refreshed: true, lessons: 52, sourceId: 'voa-level1', revision: 'a'.repeat(64) }))
    expect(await refreshCourseDirectory(token, fetcher)).toContain('52 lessons')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]).toEqual(['https://lnkxdwzdcrtlucaezhkd.supabase.co/functions/v1/content', {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', 'X-Jove-Catalog-Job': token }, body: '{"action":"catalog-refresh"}' }])
  })
  it('accepts lease backoff without claiming a refresh happened', async () => {
    expect(await refreshCourseDirectory(token, async () => Response.json({ refreshed: false, reason: 'not-due-or-running' })))
      .toContain('not due')
  })
  it('never sends a request when the job credential is missing', async () => {
    const fetcher = vi.fn()
    await expect(refreshCourseDirectory('', fetcher)).rejects.toThrow('not configured')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not retry or expose a server response on failure', async () => {
    const fetcher = vi.fn(async () => new Response('sensitive-fixture-response', { status: 503 }))
    await expect(refreshCourseDirectory(token, fetcher)).rejects.toThrow('Directory refresh failed')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each([{}, { refreshed: true, lessons: 0 }, { refreshed: false, reason: 'not-authorized' }])('rejects unconfirmed outcomes: %j', async value => {
    await expect(refreshCourseDirectory(token, async () => Response.json(value))).rejects.toThrow('valid outcome')
  })
  it('bounds response bytes', async () => {
    await expect(refreshCourseDirectory(token, async () => new Response('x'.repeat(4097)))).rejects.toThrow('exceeds its limit')
  })
})
