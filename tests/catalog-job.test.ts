import { describe, expect, it, vi } from 'vitest'
import { directoryJobDiagnostics, refreshCourseDirectories, refreshCourseDirectory } from '../scripts/refresh-course-directory.mjs'

const token = 'd'.repeat(64) // Fixture only, not a deployed credential.
describe('directory-only scheduler client', () => {
  it('refreshes all fixed sources independently with exact courses and bounded episode counts', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const sourceId = JSON.parse(String(init?.body)).sourceId ?? 'voa-level1'
      return Response.json({ refreshed: true, lessons: sourceId === 'voa-level1' ? 52 : sourceId === 'ja-tadoku' ? 141 : sourceId === 'ja-irodori' ? 72 : 30, sourceId, revision: 'b'.repeat(64) })
    })
    const result = await refreshCourseDirectories(token, fetcher)
    expect(result).toContain('52 lessons'); expect(result).toContain('30 lessons')
    expect(result).toContain('141 lessons')
    expect(fetcher).toHaveBeenCalledTimes(6)
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe('{"action":"catalog-refresh","sourceId":"voa-level2"}')
  })
  it.each([6, 501, 7.5])('rejects an invalid Japanese directory size %s', async lessons => {
    await expect(refreshCourseDirectory(token, async () => Response.json({ refreshed: true, lessons,
      sourceId: 'ja-tadoku', revision: 'a'.repeat(64) }), 'ja-tadoku')).rejects.toThrow('valid outcome')
  })
  it('attempts the other course after one fails and never reports aggregate success', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      JSON.parse(String(init?.body)).sourceId
        ? Response.json({ refreshed: false, reason: 'not-due-or-running' })
        : new Response('failure', { status: 503 }))
    await expect(refreshCourseDirectories(token, fetcher)).rejects.toThrow('successful refreshes remain saved')
    expect(fetcher).toHaveBeenCalledTimes(6)
  })
  it('waits for each source response body before starting the next, with no concurrent requests or retries', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      async start(controller) {
        await pending
        controller.enqueue(new TextEncoder().encode('{"refreshed":false,"reason":"not-due-or-running"}'))
        controller.close()
      },
    })))
    const result = refreshCourseDirectories(token, fetcher)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetcher).toHaveBeenCalledOnce()
    release()
    await expect(result).resolves.toContain('not due')
    expect(fetcher).toHaveBeenCalledTimes(6)
  })
  it('rejects a valid snapshot result for the wrong requested course', async () => {
    await expect(refreshCourseDirectory(token, async () => Response.json({ refreshed: true, lessons: 52,
      sourceId: 'voa-level1', revision: 'a'.repeat(64) }), 'voa-level2')).rejects.toThrow('valid outcome')
  })
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
  it('reports a fixed HTTP status and successful sibling without logging sensitive response or credential text', async () => {
    let failure: unknown
    try { await refreshCourseDirectories(token, async (_url: string | URL | Request, init?: RequestInit) =>
      JSON.parse(String(init?.body)).sourceId ? Response.json({ refreshed: false, reason: 'not-due-or-running' })
        : new Response(`sensitive-response-${token}`, { status: 401 })) } catch (error) { failure = error }
    expect(directoryJobDiagnostics(failure)).toEqual([{ sourceId: 'voa-level1', code: 'HTTP', status: 401 },
      { sourceId: 'voa-level2', code: 'SUCCESS_OR_NOT_DUE' }, { sourceId: 'bbc-six-minute', code: 'SUCCESS_OR_NOT_DUE' }, { sourceId: 'ja-tadoku', code: 'SUCCESS_OR_NOT_DUE' }, { sourceId: 'en-bc-reading', code: 'SUCCESS_OR_NOT_DUE' }, { sourceId: 'ja-irodori', code: 'SUCCESS_OR_NOT_DUE' }])
    expect(JSON.stringify(directoryJobDiagnostics(failure))).not.toContain(token)
  })
  it('categorizes credential and transport errors without using arbitrary error messages or attached diagnostics', async () => {
    for (const [credential, code] of [['', 'CREDENTIAL'], [token, 'TRANSPORT']]) {
      let failure: unknown
      try { await refreshCourseDirectory(credential, async () => { throw Object.assign(new Error(`upstream-${token}`), { diagnostics: token }) }) } catch (error) { failure = error }
      expect(directoryJobDiagnostics(failure)).toEqual([{ sourceId: 'voa-level1', code }])
    }
    expect(directoryJobDiagnostics(Object.assign(new Error(token), { diagnostics: token }))).toEqual([{ code: 'UNCLASSIFIED' }])
  })
  it.each(['EXTERNAL_CATALOG', 'EXTERNAL_CATALOG_REFRESH', 'EXTERNAL_CATALOG_CONNECTION', 'EXTERNAL_CATALOG_BUSY',
    'EXTERNAL_CATALOG_SCHEMA', 'EXTERNAL_CATALOG_PERMISSION', 'EXTERNAL_CATALOG_INVALID', 'CATALOG_JOB_AUTH', 'CONFIGURATION'])('retains only the known backend category %s, never its body or message', async backendCode => {
    let failure: unknown
    try { await refreshCourseDirectory(token, async () => Response.json({ error: { code: backendCode, message: `secret-${token}`, details: token }, arbitrary: token }, { status: 503 })) }
    catch (error) { failure = error }
    expect(directoryJobDiagnostics(failure)).toEqual([{ sourceId: 'voa-level1', code: 'HTTP', status: 503, backendCode }])
    expect(JSON.stringify(directoryJobDiagnostics(failure))).not.toContain(token)
  })
  it.each([JSON.stringify({ error: { code: token } }), JSON.stringify({ error: { code: { secret: token } } }), 'x'.repeat(4097), '<html>unavailable</html>'])('keeps HTTP evidence when its body has no safe code', async body => {
    let failure: unknown
    try { await refreshCourseDirectory(token, async () => new Response(body, { status: 503 })) } catch (error) { failure = error }
    expect(directoryJobDiagnostics(failure)).toEqual([{ sourceId: 'voa-level1', code: 'HTTP', status: 503 }])
  })
  it('stops reading a stalled error body after two seconds without redispatch', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(), fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 503 }))
    try {
      const result = refreshCourseDirectory(token, fetcher).catch(error => directoryJobDiagnostics(error))
      await vi.advanceTimersByTimeAsync(2100)
      expect(await result).toEqual([{ sourceId: 'voa-level1', code: 'HTTP', status: 503 }])
      expect(fetcher).toHaveBeenCalledOnce()
      expect(cancel).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})
