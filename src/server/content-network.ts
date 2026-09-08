import { validateSourceUrl } from '../content/pipeline'
import type { ContentSource, ResourceRole } from '../content/pipeline-types'

export class ContentNetworkError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ContentNetworkError' }
}
export interface ContentFetchRequest {
  url: string; source: ContentSource; role: ResourceRole; maxBytes: number
  etag?: string | null; lastModified?: string | null; timeoutMs?: number; signal?: AbortSignal
  /** Policy checks use exact URLs, including every redirect; never inferred from remote HTML. */
  exactUrls?: readonly string[]
}
export interface ContentFetchResult {
  status: number; body: Uint8Array; finalUrl: string; contentType: string
  etag: string | null; lastModified: string | null; retryAfter: string | null
  dnsPinning: 'pinned-node-lookup' | 'deno-preflight-only' | 'injected'
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

interface DenoDns { resolveDns(host: string, kind: 'A' | 'AAAA'): Promise<string[]> }
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
async function denoHop(url: string, headers: Record<string, string>, limit: number, signal: AbortSignal): Promise<Hop> {
  const response = await fetch(url, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', signal })
  if ([301, 302, 303, 307, 308, 304].includes(response.status)) {
    await response.body?.cancel()
    return { status: response.status, body: new Uint8Array(), headers: response.headers }
  }
  if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
    await response.body?.cancel(); return networkError('compressed-response-not-supported')
  }
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/u.test(length) || Number(length) > limit)) {
    await response.body?.cancel(); return networkError('response-too-large')
  }
  const reader = response.body?.getReader()
  if (!reader) return { status: response.status, body: new Uint8Array(), headers: response.headers }
  const parts: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) networkError('response-too-large')
      parts.push(value)
    }
  } finally { await reader.cancel() }
  const body = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) { body.set(part, offset); offset += part.length }
  return { status: response.status, body, headers: response.headers }
}

/** Node pins the validated address via HTTPS lookup. Deno fetch cannot pin DNS; this is reported in every result. */
export function createContentFetcher(options: {
  resolve?: ContentDnsResolver
  /** Test/controlled-egress injection. Production defaults never bypass URL/DNS checks. */
  transport?: (url: string, addresses: string[], headers: Record<string, string>, limit: number, signal: AbortSignal) => Promise<Hop>
} = {}): ContentFetcher {
  return async request => {
    if (!Number.isInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 64 * 1024 * 1024) networkError('invalid-network-limit')
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
        if (redirect === 0 && header(request.etag ?? null)) headers['if-none-match'] = request.etag!
        if (redirect === 0 && header(request.lastModified ?? null)) headers['if-modified-since'] = request.lastModified!
        const deno = !!denoRuntime()
        const result = options.transport ? await options.transport(url, addresses, headers, request.maxBytes, controller.signal) :
          deno ? await denoHop(url, headers, request.maxBytes, controller.signal) : await nodeHop(url, addresses, headers, request.maxBytes, controller.signal)
        if ([301, 302, 303, 307, 308].includes(result.status)) {
          const location = result.headers.get('location')
          if (!location) networkError('redirect-without-location')
          url = new URL(location!, url).href
          continue
        }
        return { status: result.status, body: result.body, finalUrl: url,
          contentType: result.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '',
          etag: header(result.headers.get('etag')), lastModified: header(result.headers.get('last-modified')),
          retryAfter: header(result.headers.get('retry-after')),
          dnsPinning: options.transport ? 'injected' : deno ? 'deno-preflight-only' : 'pinned-node-lookup' }
      }
      return networkError('too-many-redirects')
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
    }
  }
}
export const fetchContentResource: ContentFetcher = createContentFetcher()
