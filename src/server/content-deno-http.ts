/** One bounded HTTP/1.1 exchange on a verified TLS connection, never a pooled socket. */
export interface ContentSocket {
  read(buffer: Uint8Array): Promise<number | null>
  write(buffer: Uint8Array): Promise<number>
  close(): void
  remoteAddr: { transport?: string; hostname: string; port: number }
}
interface TlsSocket extends ContentSocket { handshake(): Promise<{ alpnProtocol: string | null }> }
export interface ContentDenoRuntime {
  connect(options: { hostname: string; port: number; transport: 'tcp' }): Promise<ContentSocket>
  startTls(socket: ContentSocket, options: { hostname: string }): Promise<TlsSocket>
}
export class ContentTransportError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ContentTransportError' }
}
function fail(code: string): never { throw new ContentTransportError(code) }
const token = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/u
// HTTP field values permit HTAB and visible Latin-1, never embedded controls.
const fieldValue = /^[\t\x20-\x7e\x80-\xff]*$/u
const redirects = new Set([301, 302, 303, 307, 308, 304])

class WireReader {
  private readonly buffer = new Uint8Array(16 * 1024)
  private position = 0
  private size = 0
  private framingBytes = 0
  constructor(private readonly socket: Pick<ContentSocket, 'read'>) {}
  private async available(): Promise<boolean> {
    if (this.position < this.size) return true
    const count = await this.socket.read(this.buffer)
    if (count === null) return false
    if (!Number.isInteger(count) || count <= 0 || count > this.buffer.length) fail('response-interrupted')
    this.position = 0; this.size = count
    return true
  }
  async line(limit = 8192): Promise<string> {
    const bytes: number[] = []
    for (;;) {
      if (!await this.available()) fail('response-interrupted')
      const byte = this.buffer[this.position++]!
      if (++this.framingBytes > 1024 * 1024) fail('response-framing-too-large')
      if (byte === 10) {
        if (bytes.pop() !== 13) fail('invalid-http-framing')
        return String.fromCharCode(...bytes)
      }
      if (bytes.length > limit || bytes.at(-1) === 13) fail('invalid-http-framing')
      bytes.push(byte)
    }
  }
  async part(max: number): Promise<Uint8Array | null> {
    if (!await this.available()) return null
    const end = Math.min(this.size, this.position + max)
    const part = this.buffer.slice(this.position, end)
    this.position = end
    return part
  }
}

function field(line: string): [string, string] {
  const colon = line.indexOf(':')
  const name = line.slice(0, colon)
  const value = line.slice(colon + 1)
  if (colon < 1 || !token.test(name) || !fieldValue.test(value)) fail('invalid-http-headers')
  return [name.toLowerCase(), value.trim()]
}

/** No decompression, pooling, protocol upgrade or unbounded framing. Caller closes the socket. */
export async function readContentHttpResponse(socket: Pick<ContentSocket, 'read'>, limit: number): Promise<{
  status: number; headers: Headers; body: Uint8Array
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024 * 1024) fail('invalid-network-limit')
  const reader = new WireReader(socket)
  let headers = new Headers(), status = 0, headerBytes = 0, headerCount = 0
  for (let interim = 0; interim <= 5; interim++) {
    const first = await reader.line()
    const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: (.*))?$/u.exec(first)
    if (!match || !fieldValue.test(match[2] ?? '')) fail('invalid-http-status')
    status = Number(match[1]); headers = new Headers(); headerBytes += first.length + 2
    for (;;) {
      const line = await reader.line()
      headerBytes += line.length + 2
      if (headerBytes > 32768 || ++headerCount > 512) fail('response-headers-too-large')
      if (!line) break
      const [name, value] = field(line)
      if (['content-length', 'transfer-encoding', 'content-range'].includes(name) && headers.has(name)) fail('ambiguous-http-framing')
      headers.append(name, value)
    }
    if (status >= 200) break
    if (![100, 102, 103].includes(status) || interim === 5) fail('unsupported-http-status')
  }
  // Redirects and conditional responses are checked by the outer fetcher before the next socket.
  if (redirects.has(status) || status === 204 || status === 205) return { status, headers, body: new Uint8Array() }
  const encoding = headers.get('content-encoding')?.toLowerCase()
  if (encoding && encoding !== 'identity') fail('compressed-response-not-supported')
  const transfer = headers.get('transfer-encoding')?.toLowerCase(), length = headers.get('content-length')
  if (transfer && (transfer !== 'chunked' || length !== null)) fail('ambiguous-http-framing')
  if (length !== null && !/^\d{1,16}$/u.test(length)) fail('invalid-http-framing')
  const declared = length === null ? null : Number(length)
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > limit)) fail('response-too-large')
  // Coalesce fragmented reads: a peer sending one byte at a time must not retain
  // millions of tiny array objects inside the bounded body budget.
  const parts: Uint8Array[] = []
  let bytes = 0, tailUsed = 0
  const add = (part: Uint8Array) => {
    if (part.length > limit - bytes) fail('response-too-large')
    let offset = 0
    while (offset < part.length) {
      let tail = parts.at(-1)
      if (!tail || tailUsed === tail.length) {
        tail = new Uint8Array(Math.min(65536, limit - bytes))
        parts.push(tail); tailUsed = 0
      }
      const count = Math.min(tail.length - tailUsed, part.length - offset)
      tail.set(part.subarray(offset, offset + count), tailUsed)
      tailUsed += count; offset += count; bytes += count
    }
  }
  const take = async (count: number) => {
    if (count > limit - bytes) fail('response-too-large')
    while (count) {
      const part = await reader.part(count)
      if (!part) fail('response-interrupted')
      add(part); count -= part.length
    }
  }
  if (transfer) {
    for (let chunks = 0; ; chunks++) {
      if (chunks >= 65536) fail('response-framing-too-large')
      const line = await reader.line(1024), semicolon = line.indexOf(';')
      const size = semicolon < 0 ? line : line.slice(0, semicolon)
      // Chunk extensions are bounded opaque metadata; they cannot change the hex size or body framing.
      if (!/^[a-f\d]{1,12}$/iu.test(size) || !fieldValue.test(line)) fail('invalid-http-framing')
      const count = Number.parseInt(size, 16)
      if (!count) {
        let trailerBytes = 0
        for (let trailers = 0; ; trailers++) {
          const trailer = await reader.line()
          trailerBytes += trailer.length + 2
          if (trailerBytes > 16384 || trailers > 128) fail('response-headers-too-large')
          if (!trailer) break
          const [name] = field(trailer)
          if (['content-length', 'transfer-encoding', 'content-encoding', 'content-range', 'content-type', 'host', 'location', 'authorization'].includes(name)) fail('invalid-http-trailer')
        }
        break
      }
      await take(count)
      if (await reader.line(0) !== '') fail('invalid-http-framing')
    }
  } else if (declared !== null) await take(declared)
  else {
    for (;;) {
      const part = await reader.part(16 * 1024)
      if (!part) break
      add(part)
    }
  }
  const body = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) {
    const count = Math.min(part.length, bytes - offset)
    body.set(part.subarray(0, count), offset); offset += count
  }
  return { status, headers, body }
}

function ip(address: string): string {
  if (!/^[a-f\d:.]+$/iu.test(address)) fail('pinned-peer-mismatch')
  try { return new URL(address.includes(':') ? 'http://[' + address + ']' : 'http://' + address).hostname }
  catch { return fail('pinned-peer-mismatch') }
}
function peer(socket: ContentSocket, selected: string, upgraded = false): void {
  // Deno 2.1.4 startTls omits the transport field (unlike connectTls), but
  // preserves the peer IP/port of the already verified, consumed TCP socket.
  const address = socket.remoteAddr
  if (!address || (address.transport !== 'tcp' && !(upgraded && address.transport === undefined)) ||
    address.port !== 443 || ip(address.hostname) !== ip(selected)) fail('pinned-peer-mismatch')
}

/** Addresses have already ALL passed the fetcher's public-DNS guard, on this exact redirect hop. */
export async function pinnedDenoContentHop(runtime: Partial<ContentDenoRuntime>, rawUrl: string, addresses: string[],
  headers: Record<string, string>, limit: number, signal: AbortSignal) {
  if (typeof runtime.connect !== 'function' || typeof runtime.startTls !== 'function') fail('pinned-transport-unavailable')
  const url = new URL(rawUrl), selected = addresses.find(address => address.includes('.')) ?? addresses[0]
  if (!selected || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail('invalid-pinned-request')
  const allowed = new Set(['accept', 'accept-encoding', 'user-agent', 'if-none-match', 'if-modified-since', 'range'])
  for (const [name, value] of Object.entries(headers)) {
    if (!allowed.has(name) || value.length > 1024 || !/^[\t\x20-\x7e]*$/u.test(value)) fail('invalid-pinned-request')
  }
  if (headers.range !== undefined && (!/^bytes=0-(?:0|[1-9]\d{0,6})$/u.test(headers.range) ||
      Number(headers.range.slice(8)) >= Math.min(limit, 8 * 1024 * 1024) || headers['if-none-match'] !== undefined || headers['if-modified-since'] !== undefined))
    fail('invalid-pinned-request')
  const request = new TextEncoder().encode('GET ' + url.pathname + url.search + ' HTTP/1.1\r\nHost: ' + url.hostname +
    '\r\nConnection: close\r\n' + Object.entries(headers).map(([name, value]) => name + ': ' + value + '\r\n').join('') + '\r\n')
  if (request.length > 8192) fail('invalid-pinned-request')
  if (signal.aborted) fail('network-timeout-or-cancelled')
  let active: ContentSocket | undefined, finished = false, rejectAbort: (reason: Error) => void = () => {}
  const close = (socket: ContentSocket) => { try { socket.close() } catch { /* Already consumed or closed. */ } }
  const closeActive = () => { if (active) { const socket = active; active = undefined; close(socket) } }
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
  void aborted.catch(() => {})
  const onAbort = () => { closeActive(); rejectAbort(new ContentTransportError('network-timeout-or-cancelled')) }
  signal.addEventListener('abort', onAbort, { once: true })
  const race = <T>(step: Promise<T>) => Promise.race([step, aborted])
  const own = <T extends ContentSocket>(step: Promise<T>) => race(step.then(socket => {
    if (finished || signal.aborted) { close(socket); return fail('network-timeout-or-cancelled') }
    active = socket; return socket
  }))
  try {
    const tcp = await own(runtime.connect!({ hostname: selected, port: 443, transport: 'tcp' }))
    peer(tcp, selected)
    const tls = await own(runtime.startTls!(tcp, { hostname: url.hostname }))
    peer(tls, selected, true)
    if (typeof tls.handshake !== 'function') fail('pinned-transport-unavailable')
    const handshake = await race(tls.handshake())
    if (handshake.alpnProtocol !== null && handshake.alpnProtocol !== 'http/1.1') fail('unsupported-http-protocol')
    let sent = 0
    while (sent < request.length) {
      const count = await race(tls.write(request.subarray(sent)))
      if (!Number.isSafeInteger(count) || count < 1 || count > request.length - sent) fail('request-interrupted')
      sent += count
    }
    return await race(readContentHttpResponse(tls, limit))
  } catch (error) {
    if (error instanceof ContentTransportError) throw error
    return fail(signal.aborted ? 'network-timeout-or-cancelled' : 'network-request-failed')
  } finally {
    finished = true; signal.removeEventListener('abort', onAbort); closeActive()
  }
}
