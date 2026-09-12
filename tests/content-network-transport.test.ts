import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContentFetcher } from '../src/server/content-network'
import { ALLOWLISTED_CONTENT_SOURCES } from '../src/content/sources'
import { pinnedDenoContentHop, readContentHttpResponse } from '../src/server/content-deno-http'

const encoder = new TextEncoder()
const source = ALLOWLISTED_CONTENT_SOURCES.find(item => item.id === 'hacker-public-radio')!
const request = { url: source.feedUrl, source, role: 'feed' as const, maxBytes: 1024 }

function connection(response: string | Uint8Array, address = '1.1.1.1', fragment = 16384) {
  const bytes = typeof response === 'string' ? encoder.encode(response) : response
  let offset = 0
  return {
    remoteAddr: { transport: 'tcp' as const, hostname: address, port: 443 },
    close: vi.fn(),
    handshake: vi.fn(async () => ({ alpnProtocol: null })),
    read: vi.fn(async (buffer: Uint8Array) => {
      if (offset === bytes.length) return null
      const count = Math.min(fragment, buffer.length, bytes.length - offset)
      buffer.set(bytes.subarray(offset, offset + count)); offset += count
      return count
    }),
    write: vi.fn(async (buffer: Uint8Array) => buffer.length),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('bounded byte-zero audio acquisition', () => {
  const prefixRequest = { source, url: 'https://hpr.nyc3.cdn.digitaloceanspaces.com/eps/hpr4725.mp3',
    role: 'audio' as const, maxBytes: 5, audioPrefixBytes: 5 }
  function fixture(wire: string) {
    const tcp = connection(''), tls = connection(wire, undefined, 1)
    const connect = vi.fn(async () => tcp), startTls = vi.fn(async () => tls)
    vi.stubGlobal('Deno', { connect, startTls })
    return { tls, connect, run: () => createContentFetcher({ resolve: async () => ['1.1.1.1'] })(prefixRequest) }
  }
  it('keeps a bounded partial response distinct from the full source representation', async () => {
    const { tls, run } = fixture('HTTP/1.1 206 Partial Content\r\nContent-Type: audio/mpeg\r\nContent-Length: 5\r\nContent-Range: bytes 0-4/90000000\r\n\r\nhello')
    const result = await run()
    expect(result.byteCoverage).toEqual({ kind: 'prefix', start: 0, endExclusive: 5, totalBytes: 90000000 })
    expect(new TextDecoder().decode(tls.write.mock.calls[0]![0])).toContain('range: bytes=0-4\r\n')
    expect(new TextDecoder().decode(result.body)).toBe('hello')
    expect(result.dnsPinning).toBe('pinned-deno-tls')
    expect(tls.close).toHaveBeenCalledOnce()
  })
  it.each([200, 206])('labels a fully received small representation complete with status %i', async status => {
    const { run } = fixture(`HTTP/1.1 ${status} OK\r\nContent-Type: audio/mpeg\r\nContent-Length: 3\r\n${status === 206 ? 'Content-Range: bytes 0-2/3\r\n' : ''}\r\nabc`)
    expect((await run()).byteCoverage).toEqual({ kind: 'complete', start: 0, endExclusive: 3, totalBytes: 3 })
  })
  it.each([
    'bytes 1-5/90000000', 'bytes 0-4/*', 'bytes 0-4/4', 'bytes 0-5/90000000',
    'bytes 0-3/90000000', 'bytes 0-4/9007199254740992', 'bytes 0-4/90000000, bytes 0-4/90000000', '',
  ])('rejects an unverified range %s without promoting partial bytes to complete media', async range => {
    const { run } = fixture(`HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\nContent-Range: ${range}\r\n\r\nhello`)
    await expect(run()).rejects.toThrow('invalid-audio-prefix-response')
  })
  it.each([
    'Content-Range: bytes 0-4/90\r\nContent-Range: bytes 0-4/90\r\n',
    'Content-Type: multipart/byteranges; boundary=test\r\nContent-Range: bytes 0-4/90\r\n',
  ])('rejects ambiguous or multipart partial representations %#', async headers => {
    const { run } = fixture('HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\n' + headers + '\r\nhello')
    await expect(run()).rejects.toThrow()
  })
  it('never retries as a full download when the server ignores the range', async () => {
    const { connect, run } = fixture('HTTP/1.1 200 OK\r\nContent-Length: 90000000\r\n\r\n')
    await expect(run()).rejects.toThrow('response-too-large')
    expect(connect).toHaveBeenCalledOnce()
  })
  it.each([
    'HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-4/90\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n',
    'HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-4/90\r\nContent-Encoding: gzip\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Range: bytes 0-4/90\r\n\r\nhello',
    'HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nContent-Range: bytes */90\r\n\r\n',
    'HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-4/90\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\nContent-Range: bytes 0-4/5\r\n\r\n',
  ])('rejects oversized, encoded, contradictory or trailer-modified prefixes %#', async wire => {
    const { run } = fixture(wire)
    await expect(run()).rejects.toThrow()
  })
  it('accepts verified chunked prefix bytes without changing the byte coverage', async () => {
    const { run } = fixture('HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-4/90\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhe\r\n3\r\nllo\r\n0\r\n\r\n')
    expect((await run()).byteCoverage).toEqual({ kind: 'prefix', start: 0, endExclusive: 5, totalBytes: 90 })
  })
  it('keeps the prefix bound across redirects and refuses a rebound private address', async () => {
    const transport = vi.fn(async (_url: string, _addresses: string[], headers: Record<string, string>, limit: number) => {
      expect(headers.range).toBe('bytes=0-4')
      expect(limit).toBe(5)
      expect(headers.authorization).toBeUndefined()
      return { status: 302, headers: new Headers({ location: prefixRequest.url }), body: new Uint8Array() }
    })
    const resolve = vi.fn().mockResolvedValueOnce(['1.1.1.1']).mockResolvedValueOnce(['127.0.0.1'])
    await expect(createContentFetcher({ resolve, transport })(prefixRequest)).rejects.toThrow('non-public-dns-answer')
    expect(transport).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledTimes(2)
  })
  it.each(['bytes=1-4', 'bytes=0-5', 'bytes=0-4,6-7', 'bytes=0-4\r\nAuthorization: PRIVATE'])(
    'refuses unsafe native range %s before connecting', async range => {
      const runtime = { connect: vi.fn(), startTls: vi.fn() }
      await expect(pinnedDenoContentHop(runtime, prefixRequest.url, ['1.1.1.1'], { range }, 5, new AbortController().signal))
        .rejects.toThrow('invalid-pinned-request')
      expect(runtime.connect).not.toHaveBeenCalled()
    })
  it.each([0, -1, 1.5, 8388609, NaN])('rejects unsafe prefix size %s before DNS', async audioPrefixBytes => {
    const resolve = vi.fn(async () => ['1.1.1.1'])
    const transport = vi.fn(async () => ({ status: 200, headers: new Headers(), body: encoder.encode('hello') }))
    await expect(createContentFetcher({ resolve, transport })({ ...prefixRequest, audioPrefixBytes })).rejects.toThrow('invalid-audio-prefix-request')
    expect(resolve).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  })
  it('forbids ranges on metadata or conditional requests before DNS', async () => {
    const resolve = vi.fn(async () => ['1.1.1.1'])
    const transport = vi.fn(async () => ({ status: 200, headers: new Headers(), body: encoder.encode('hello') }))
    for (const override of [{ role: 'feed' as const }, { etag: 'prior' }, { lastModified: 'prior' }, { maxBytes: 4 }])
      await expect(createContentFetcher({ resolve, transport })({ ...prefixRequest, ...override })).rejects.toThrow('invalid-audio-prefix-request')
    expect(resolve).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('default Deno content transport', () => {
  it('connects only to the validated IP, verifies the original TLS hostname and never falls back to fetch', async () => {
    const tcp = connection(''), tls = connection('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello')
    const connect = vi.fn(async () => tcp), startTls = vi.fn(async () => tls)
    const fetch = vi.fn(async () => new Response('hello'))
    vi.stubGlobal('Deno', { connect, startTls }); vi.stubGlobal('fetch', fetch)
    const result = await createContentFetcher({ resolve: async () => ['1.1.1.1'] })(request)
    expect(connect).toHaveBeenCalledWith({ hostname: '1.1.1.1', port: 443, transport: 'tcp' })
    expect(startTls).toHaveBeenCalledWith(tcp, { hostname: new URL(request.url).hostname })
    expect(tls.handshake).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    expect(result.dnsPinning).toBe('pinned-deno-tls')
    expect(new TextDecoder().decode(result.body)).toBe('hello')
    expect(tls.close).toHaveBeenCalledOnce()
  })

  it('refuses an unsupported Deno socket API instead of fetching with a second DNS lookup', async () => {
    const fetch = vi.fn(async () => new Response('hello'))
    vi.stubGlobal('Deno', {}); vi.stubGlobal('fetch', fetch)
    await expect(createContentFetcher({ resolve: async () => ['1.1.1.1'] })(request))
      .rejects.toThrow('pinned-transport-unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('revalidates DNS after a redirect before opening another pinned socket', async () => {
    const tcp = connection(''), tls = connection('HTTP/1.1 302 Found\r\nLocation: ' + request.url + '\r\n\r\n')
    const connect = vi.fn(async () => tcp), startTls = vi.fn(async () => tls)
    const resolve = vi.fn().mockResolvedValueOnce(['1.1.1.1']).mockResolvedValueOnce(['127.0.0.1'])
    vi.stubGlobal('Deno', { connect, startTls })
    await expect(createContentFetcher({ resolve })(request)).rejects.toThrow('non-public-dns-answer')
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenCalledOnce()
    expect(tls.close).toHaveBeenCalledOnce()
  })

  it('rejects a private redirect URL without DNS lookup or another socket', async () => {
    const tcp = connection(''), tls = connection('HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1/private\r\n\r\n')
    const connect = vi.fn(async () => tcp), startTls = vi.fn(async () => tls), resolve = vi.fn(async () => ['1.1.1.1'])
    vi.stubGlobal('Deno', { connect, startTls })
    await expect(createContentFetcher({ resolve })(request)).rejects.toThrow('unsafe-url')
    expect(resolve).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledOnce()
    expect(tls.close).toHaveBeenCalledOnce()
  })

  it('never retries with unpinned fetch after a native connection failure', async () => {
    const connect = vi.fn(async () => { throw new Error('native API unavailable') })
    const fetch = vi.fn(async () => new Response('unsafe fallback'))
    vi.stubGlobal('Deno', { connect, startTls: vi.fn() }); vi.stubGlobal('fetch', fetch)
    await expect(createContentFetcher({ resolve: async () => ['1.1.1.1'] })(request)).rejects.toThrow('network-request-failed')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('bounded HTTP framing on the pinned socket', () => {
  it.each([1, 2, 7, 16384])('reads fixed length, chunked and close-delimited bodies at fragment size %i', async fragment => {
    for (const wire of [
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;name=value\r\nhe\r\n3\r\nllo\r\n0\r\nX-Checksum: fixture\r\n\r\n',
      'HTTP/1.0 200 OK\r\n\r\nhello',
    ]) {
      const result = await readContentHttpResponse(connection(wire, undefined, fragment), 5)
      expect(new TextDecoder().decode(result.body)).toBe('hello')
      expect(result.status).toBe(200)
    }
  })

  it('preserves binary bytes across coalesced read blocks', async () => {
    const body = Uint8Array.from({ length: 70003 }, (_, i) => i % 256)
    const head = encoder.encode('HTTP/1.1 200 OK\r\nContent-Length: ' + body.length + '\r\n\r\n')
    const wire = new Uint8Array(head.length + body.length)
    wire.set(head); wire.set(body, head.length)
    const result = await readContentHttpResponse(connection(wire, undefined, 7), body.length)
    expect(result.body).toEqual(body)
  })

  it('consumes bounded interim responses, but never treats interim headers as final headers', async () => {
    const result = await readContentHttpResponse(connection('HTTP/1.1 103 Early Hints\r\nLink: x\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'), 10)
    expect(result.headers.has('link')).toBe(false)
    expect(result.body.length).toBe(0)
  })

  it.each([204, 205, 301, 302, 303, 304, 307, 308])('does not wait for or consume a body for status %i', async status => {
    const socket = connection('HTTP/1.1 ' + status + ' Status\r\nLocation: /next\r\nContent-Length: 99999999\r\n\r\n', undefined, 1)
    const result = await readContentHttpResponse(socket, 10)
    expect(result.status).toBe(status)
    expect(result.body.length).toBe(0)
  })

  it.each([
    ['HTTP/2 200 OK\r\n\r\n', 'invalid-http-status'],
    ['HTTP/1.1 200 OK\n\n', 'invalid-http-framing'],
    ['HTTP/1.1 200 OK\rX', 'invalid-http-framing'],
    ['HTTP/1.1 101 Upgrade\r\n\r\n', 'unsupported-http-status'],
    ['HTTP/1.1 103 Hint\r\n\r\n'.repeat(6), 'unsupported-http-status'],
    ['HTTP/1.1 200 OK\r\n Folded: value\r\n\r\n', 'invalid-http-headers'],
    ['HTTP/1.1 200 OK\r\nX: bad\u0000value\r\n\r\n', 'invalid-http-headers'],
    ['HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx', 'ambiguous-http-framing'],
    ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n', 'ambiguous-http-framing'],
    ['HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n', 'ambiguous-http-framing'],
    ['HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n', 'compressed-response-not-supported'],
    ['HTTP/1.1 200 OK\r\nContent-Length: +1\r\n\r\nx', 'invalid-http-framing'],
    ['HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n', 'response-too-large'],
    ['HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhi', 'response-interrupted'],
    ['HTTP/1.1 200 OK\r\n\r\n123456', 'response-too-large'],
    ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n', 'response-too-large'],
    ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n-1\r\n', 'invalid-http-framing'],
    ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nxX\r\n', 'invalid-http-framing'],
    ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n', 'response-interrupted'],
    ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nLocation: /evil\r\n\r\n', 'invalid-http-trailer'],
    ['HTTP/1.1 200 OK\r\n' + 'X: y\r\n'.repeat(513), 'response-headers-too-large'],
    ['HTTP/1.1 200 OK\r\n' + ('X: ' + 'y'.repeat(8000) + '\r\n').repeat(5), 'response-headers-too-large'],
    ['HTTP/1.1 200 OK\r\nX: ' + 'y'.repeat(8193), 'invalid-http-framing'],
  ])('rejects malformed or over-budget response %#', async (wire, error) => {
    await expect(readContentHttpResponse(connection(wire, undefined, 2), 5)).rejects.toThrow(error)
  })

  it.each([0, -1, 1.5, 67108865, NaN])('rejects invalid response budget %s before reading', async limit => {
    const socket = connection('')
    await expect(readContentHttpResponse(socket, limit)).rejects.toThrow('invalid-network-limit')
    expect(socket.read).not.toHaveBeenCalled()
  })
})

describe('TLS socket ownership and cancellation', () => {
  function fixture() {
    const tcp = connection(''), tls = connection('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
    const runtime = { connect: vi.fn(async () => tcp), startTls: vi.fn(async () => tls) }
    const controller = new AbortController()
    const run = () => pinnedDenoContentHop(runtime, request.url, ['1.1.1.1'], { accept: '*/*' }, 1024, controller.signal)
    return { tcp, tls, runtime, controller, run }
  }

  it('writes the original HTTP hostname and supports partial writes', async () => {
    const { tls, run } = fixture(), sent: Uint8Array[] = []
    tls.write.mockImplementation(async bytes => { sent.push(bytes.slice(0, 3)); return Math.min(3, bytes.length) })
    await run()
    const wire = Buffer.concat(sent).toString('utf8')
    expect(wire).toContain('Host: ' + new URL(request.url).hostname + '\r\n')
    expect(wire).toContain('Connection: close\r\n')
    expect(wire.endsWith('\r\n\r\n')).toBe(true)
    expect(tls.close).toHaveBeenCalledOnce()
  })

  it('accepts Deno 2.1.4 startTls metadata lacking transport only after validating the TCP peer', async () => {
    const { tls, run } = fixture()
    Reflect.deleteProperty(tls.remoteAddr, 'transport')
    expect((await run()).status).toBe(200)
    expect(tls.handshake).toHaveBeenCalledOnce()
  })

  it.each(['tcp', 'tls'] as const)('rejects a different %s peer before writing any HTTP', async stage => {
    const test = fixture()
    test[stage].remoteAddr.hostname = '127.0.0.1'
    await expect(test.run()).rejects.toThrow('pinned-peer-mismatch')
    expect(test.tls.write).not.toHaveBeenCalled()
    expect(test[stage].close).toHaveBeenCalledOnce()
  })

  it('closes the TLS socket and sends no HTTP on certificate verification failure', async () => {
    const { tls, run } = fixture()
    tls.handshake.mockRejectedValue(new Error('certificate verify failed'))
    await expect(run()).rejects.toThrow('network-request-failed')
    expect(tls.write).not.toHaveBeenCalled()
    expect(tls.close).toHaveBeenCalledOnce()
  })

  it('rejects a negotiated protocol other than HTTP/1.1', async () => {
    const { tls, run } = fixture()
    tls.handshake.mockResolvedValue({ alpnProtocol: 'h2' } as never)
    await expect(run()).rejects.toThrow('unsupported-http-protocol')
    expect(tls.write).not.toHaveBeenCalled()
    expect(tls.close).toHaveBeenCalledOnce()
  })

  it('does not connect when already cancelled', async () => {
    const { runtime, controller, run } = fixture()
    controller.abort()
    await expect(run()).rejects.toThrow('network-timeout-or-cancelled')
    expect(runtime.connect).not.toHaveBeenCalled()
  })

  it.each(['connect', 'startTls'] as const)('closes a socket that arrives after cancellation during %s', async stage => {
    const { runtime, tcp, tls, controller, run } = fixture()
    let resolve!: (socket: typeof tcp) => void
    runtime[stage].mockImplementation(() => new Promise(done => { resolve = done }))
    const running = run()
    await vi.waitFor(() => expect(runtime[stage]).toHaveBeenCalledOnce())
    controller.abort()
    await expect(running).rejects.toThrow('network-timeout-or-cancelled')
    const late = stage === 'connect' ? tcp : tls
    resolve(late)
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce())
    expect(tls.write).not.toHaveBeenCalled()
  })

  it.each(['handshake', 'write', 'read'] as const)('cancels a stalled %s and closes the active TLS socket', async stage => {
    const { tls, controller, run } = fixture()
    tls[stage].mockImplementation(() => new Promise<never>(() => {}))
    const running = run()
    await vi.waitFor(() => expect(tls[stage]).toHaveBeenCalledOnce())
    controller.abort()
    await expect(running).rejects.toThrow('network-timeout-or-cancelled')
    expect(tls.close).toHaveBeenCalledOnce()
  })

  it.each([0, -1, NaN, 999999])('rejects invalid write count %s', async count => {
    const { tls, run } = fixture()
    tls.write.mockResolvedValue(count)
    await expect(run()).rejects.toThrow('request-interrupted')
    expect(tls.close).toHaveBeenCalledOnce()
  })
})
