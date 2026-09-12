import { validateSourceUrl } from '../content/pipeline'
import type { ContentSource, ResourceRole } from '../content/pipeline-types'
import { ContentTransportError, pinnedDenoContentHop, type ContentDenoRuntime } from './content-deno-http'

export class ContentNetworkError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ContentNetworkError' }
}
export interface ContentFetchRequest {
  url: string; source: ContentSource; role: ResourceRole; maxBytes: number
  etag?: string | null; lastModified?: string | null; timeoutMs?: number; signal?: AbortSignal
  /** Policy checks use exact URLs, including every redirect; never inferred from remote HTML. */
  exactUrls?: readonly string[]
  /** One byte-zero acquisition, not arbitrary seeking or multi-request stitching. */
  audioPrefixBytes?: number
}
export interface ContentFetchResult {
  status: number; body: Uint8Array; finalUrl: string; contentType: string
  etag: string | null; lastModified: string | null; retryAfter: string | null
  dnsPinning: 'pinned-node-lookup' | 'pinned-deno-tls' | 'deno-preflight-only' | 'injected'
  /** Representation bytes only: this does not establish audio timing or quality. */
  byteCoverage?: { kind: 'complete' | 'prefix'; start: 0; endExclusive: number; totalBytes: number }
}
export type ContentFetcher = (request: ContentFetchRequest) => Promise<ContentFetchResult>
export type ContentDnsResolver = (hostname: string) => Promise<string[]>
const networkError = (code: string): never => { throw new ContentNetworkError(code) }

/** Conservative routability filter. IPv4-mapped IPv6, transition and special-use ranges are rejected. */
export function isPublicContentAddress(address: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(address)) {
    const parts = address.split('.').map(Number)
    if (parts.some((n, i) => n > 255 || String(n) !== address.split('.')[i])) return false
    const [a, b, c] = parts as [number, number, number, number]
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
      a === 192 && b === 0 && (c === 0 || c === 2) || a === 192 && b === 88 && c === 99 ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113)
  }
  if (!/^[a-f\d:]+$/iu.test(address) || !address.includes(':') || address.split('::').length > 2) return false
  const halves = address.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  if ([...left, ...right].some(part => !/^[a-f\d]{1,4}$/iu.test(part))) return false
  const missing = 8 - left.length - right.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return false
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map(part => Number.parseInt(part, 16))
  const [a, b] = groups as [number, number]
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && a !== 0x3fff &&
    !(a === 0x2001 && (b < 0x0200 || b === 0x0db8))
}

interface DenoDns extends Partial<ContentDenoRuntime> { resolveDns(host: string, kind: 'A' | 'AAAA'): Promise<string[]> }
const denoRuntime = () => (globalThis as typeof globalThis & { Deno?: DenoDns }).Deno
export const resolveContentAddresses: ContentDnsResolver = async hostname => {
  const deno = denoRuntime()
  if (deno) {
    const records = await Promise.allSettled([deno.resolveDns(hostname, 'A'), deno.resolveDns(hostname, 'AAAA')])
    const addresses: string[] = []
    for (const result of records) {
      if (result.status === 'fulfilled') addresses.push(...result.value)
      else if (!(result.reason instanceof Error) || !/NotFound|NotFoundError/u.test(result.reason.name)) networkError('dns-resolution-failed')
    }
    return addresses
  }
  // Query both DNS record families directly, as Deno does. OS getaddrinfo can add
  // synthesized transition addresses (observed Windows Teredo), which are not
  // publisher DNS answers. Every returned A/AAAA still must pass the caller's
  // public-address guard; never discard an unsafe answer or retry IPv4-only.
  const { resolve4, resolve6 } = await import('node:dns/promises')
  const records = await Promise.allSettled([resolve4(hostname), resolve6(hostname)])
  const addresses: string[] = []
  for (const result of records) {
    if (result.status === 'fulfilled') addresses.push(...result.value)
    else if (!(result.reason instanceof Error) || !('code' in result.reason) ||
        !['ENODATA', 'ENOTFOUND'].includes(String(result.reason.code))) networkError('dns-resolution-failed')
  }
  return addresses
}
function header(value: string | null): string | null {
  return value && value.length <= 1_024 && !/[\r\n]/u.test(value) ? value : null
}
interface Hop { status: number; body: Uint8Array; headers: Headers }
function prefixCoverage(result: Hop, limit: number): NonNullable<ContentFetchResult['byteCoverage']> {
  const range = result.headers.get('content-range'), length = result.headers.get('content-length')
  const type = result.headers.get('content-type')?.trim().toLowerCase() ?? ''
  const encoding = result.headers.get('content-encoding')?.trim().toLowerCase()
  if (!result.body.length || result.body.length > limit || type.startsWith('multipart/') || encoding && encoding !== 'identity' ||
      length !== null && (!/^\d{1,16}$/u.test(length) || Number(length) !== result.body.length))
    return networkError('invalid-audio-prefix-response')
  if (result.status === 200 && range === null)
    return { kind: 'complete', start: 0, endExclusive: result.body.length, totalBytes: result.body.length }
  const match = /^bytes 0-(\d{1,16})\/(\d{1,16})$/u.exec(range ?? '')
  if (result.status !== 206 || !match) return networkError('invalid-audio-prefix-response')
  const last = Number(match[1]), total = Number(match[2])
  if (!Number.isSafeInteger(last) || !Number.isSafeInteger(total) || total <= last ||
      last + 1 !== result.body.length || result.body.length !== Math.min(limit, total))
    return networkError('invalid-audio-prefix-response')
  return { kind: result.body.length === total ? 'complete' : 'prefix', start: 0, endExclusive: last + 1, totalBytes: total }
}
async function nodeHop(url: string, addresses: string[], headers: Record<string, string>, limit: number, signal: AbortSignal): Promise<Hop> {
  const { request } = await import('node:https')
  const selected = addresses.find(address => address.includes('.')) ?? addresses[0]!
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, headers, signal, rejectUnauthorized: true,
      servername: new URL(url).hostname,
      lookup: (_hostname, options, callback) => {
        const family = selected.includes(':') ? 6 : 4
        if (options.all) callback(null, [{ address: selected, family }])
        else callback(null, selected, family)
      },
    }, response => {
      const responseHeaders = new Headers()
      let ranges = 0
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        if (response.rawHeaders[i]!.toLowerCase() === 'content-range' && ++ranges > 1) {
          response.destroy(); reject(new ContentNetworkError('ambiguous-http-framing')); return
        }
      }
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === 'string') responseHeaders.set(key, value)
      }
      const status = response.statusCode ?? 0
      if ([301, 302, 303, 307, 308, 304].includes(status)) {
        response.destroy()
        resolve({ status, body: new Uint8Array(), headers: responseHeaders })
        return
      }
      if (responseHeaders.get('content-encoding') && responseHeaders.get('content-encoding') !== 'identity') {
        response.destroy(); reject(new ContentNetworkError('compressed-response-not-supported')); return
      }
      const length = responseHeaders.get('content-length')
      if (length && (!/^\d+$/u.test(length) || Number(length) > limit)) {
        response.destroy(); reject(new ContentNetworkError('response-too-large')); return
      }
      const chunks: Uint8Array[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > limit) { response.destroy(); reject(new ContentNetworkError('response-too-large')); return }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const body = new Uint8Array(bytes)
        let offset = 0
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length }
        resolve({ status, body, headers: responseHeaders })
      })
      response.on('error', () => reject(new ContentNetworkError('response-interrupted')))
      response.on('aborted', () => reject(new ContentNetworkError('response-interrupted')))
    })
    req.on('error', error => reject(error instanceof ContentNetworkError ? error : new ContentNetworkError(signal.aborted ? 'network-timeout-or-cancelled' : 'network-request-failed')))
    req.end()
  })
}
async function denoHop(url: string, addresses: string[], headers: Record<string, string>, limit: number, signal: AbortSignal): Promise<Hop> {
  try { return await pinnedDenoContentHop(denoRuntime()!, url, addresses, headers, limit, signal) }
  catch (error) { return networkError(error instanceof ContentTransportError ? error.code : 'network-request-failed') }
}

/** Both runtimes pin this hop's validated address and verify the original TLS hostname. No unpinned fallback. */
export function createContentFetcher(options: {
  resolve?: ContentDnsResolver
  /** Test/controlled-egress injection. Production defaults never bypass URL/DNS checks. */
  transport?: (url: string, addresses: string[], headers: Record<string, string>, limit: number, signal: AbortSignal) => Promise<Hop>
} = {}): ContentFetcher {
  return async request => {
    if (!Number.isInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 64 * 1024 * 1024) networkError('invalid-network-limit')
    const prefix = request.audioPrefixBytes
    if (prefix !== undefined && (request.role !== 'audio' || !Number.isSafeInteger(prefix) || prefix < 1 ||
        prefix > 8 * 1024 * 1024 || prefix > request.maxBytes || request.etag != null || request.lastModified != null))
      networkError('invalid-audio-prefix-request')
    const limit = prefix ?? request.maxBytes
    const timeout = Math.min(60_000, Math.max(1_000, request.timeoutMs ?? 20_000))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const abort = () => controller.abort()
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) controller.abort()
    let url = request.url
    try {
      for (let redirect = 0; redirect <= 5; redirect++) {
        validateSourceUrl(url, request.source.urls[request.role])
        if (request.exactUrls && !request.exactUrls.includes(url)) networkError('unapproved-exact-url')
        const addresses = await Promise.race([
          (options.resolve ?? resolveContentAddresses)(new URL(url).hostname),
          new Promise<never>((_, reject) => {
            if (controller.signal.aborted) reject(new ContentNetworkError('network-timeout-or-cancelled'))
            else controller.signal.addEventListener('abort', () => reject(new ContentNetworkError('network-timeout-or-cancelled')), { once: true })
          }),
        ])
        if (!addresses.length || addresses.length > 32 || addresses.some(address => !isPublicContentAddress(address))) networkError('non-public-dns-answer')
        const headers: Record<string, string> = { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'JoveEnglishContent/1.0' }
        if (prefix !== undefined) headers.range = `bytes=0-${prefix - 1}`
        if (redirect === 0 && header(request.etag ?? null)) headers['if-none-match'] = request.etag!
        if (redirect === 0 && header(request.lastModified ?? null)) headers['if-modified-since'] = request.lastModified!
        const deno = !!denoRuntime()
        const result = options.transport ? await options.transport(url, addresses, headers, limit, controller.signal) :
          deno ? await denoHop(url, addresses, headers, limit, controller.signal) : await nodeHop(url, addresses, headers, limit, controller.signal)
        if ([301, 302, 303, 307, 308].includes(result.status)) {
          const location = result.headers.get('location')
          if (!location) networkError('redirect-without-location')
          url = new URL(location!, url).href
          continue
        }
        return { status: result.status, body: result.body, finalUrl: url,
          ...(prefix !== undefined ? { byteCoverage: prefixCoverage(result, limit) } : {}),
          contentType: result.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '',
          etag: header(result.headers.get('etag')), lastModified: header(result.headers.get('last-modified')),
          retryAfter: header(result.headers.get('retry-after')),
          dnsPinning: options.transport ? 'injected' : deno ? 'pinned-deno-tls' : 'pinned-node-lookup' }
      }
      return networkError('too-many-redirects')
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
    }
  }
}
export const fetchContentResource: ContentFetcher = createContentFetcher()
