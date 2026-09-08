import { httpError, normalizeError, ProviderError } from './errors'

export const API = 'https://openrouter.ai/api/v1'
export const REQUEST_TIMEOUT_MS = 60_000
export const SSE_IDLE_TIMEOUT_MS = 20_000

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof ProviderError
    ? signal.reason : new ProviderError('CANCELLED')
}

/** Also bounds non-fetch work such as injected callbacks and stalled response bodies. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) void promise.catch(() => undefined)
  checkAbort(signal)
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason instanceof ProviderError ? signal.reason : new ProviderError('CANCELLED')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

export async function withDeadline<T>(signal: AbortSignal | undefined, ms: number, work: (signal: AbortSignal) => Promise<T>, options: { normalizeErrors?: boolean } = {}): Promise<T> {
  checkAbort(signal)
  const controller = new AbortController()
  const abort = () => controller.abort(new ProviderError('CANCELLED'))
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new ProviderError('TIMEOUT')), ms)
  try { return await abortable(work(controller.signal), controller.signal) }
  catch (error) {
    checkAbort(controller.signal)
    // Server domain errors retain their HTTP/recovery contract when explicitly
    // requested. Cancellation/deadline above still takes precedence.
    throw options.normalizeErrors === false ? error : normalizeError(error)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.abort(new ProviderError('CANCELLED'))
  }
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new ProviderError('CANCELLED')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function readBytes(response: Response, signal: AbortSignal, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new ProviderError('INVALID_RESPONSE')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > limit) throw new ProviderError('INVALID_RESPONSE')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export function parseJson(text: string): unknown {
  try { return JSON.parse(text) }
  catch { throw new ProviderError('INVALID_RESPONSE') }
}

export async function readJson(response: Response, signal: AbortSignal, limit = 1_000_000): Promise<unknown> {
  return parseJson(new TextDecoder().decode(await readBytes(response, signal, limit)))
}

/** Only GETs and explicit 429/503 responses retry; an ambiguous paid POST never replays. */
export async function publicGet(path: string, signal: AbortSignal): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${API}${path}`, { signal, credentials: 'omit', cache: 'no-store', redirect: 'error' })
    if (response.ok) return readJson(response, signal, 8_000_000)
    void response.body?.cancel().catch(() => undefined)
    if (attempt === 0 && (response.status === 429 || response.status === 503)) { await delay(250, signal); continue }
    throw httpError(response.status)
  }
  throw new ProviderError('UNAVAILABLE')
}

/** SSE framing across byte/UTF-8/CRLF boundaries, comments and multiline data fields. */
export async function consumeSse(response: Response, signal: AbortSignal, onEvent: (event: unknown) => void): Promise<void> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new ProviderError('INVALID_RESPONSE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', data: string[] = [], doneEvent = false, bytes = 0
  const line = (value: string) => {
    if (value === '') {
      if (data.length) {
        const payload = data.join('\n')
        data = []
        if (payload === '[DONE]') doneEvent = true
        else onEvent(parseJson(payload))
      }
    } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''))
  }
  try {
    while (!doneEvent) {
      const chunk = await withDeadline(signal, SSE_IDLE_TIMEOUT_MS, scoped => abortable(reader.read(), scoped))
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      bytes += chunk.value?.byteLength ?? 0
      if (bytes > 1_000_000) throw new ProviderError('INVALID_RESPONSE')
      let index: number
      while (!doneEvent && (index = buffer.search(/[\r\n]/)) >= 0) {
        if (!chunk.done && buffer[index] === '\r' && index === buffer.length - 1) break
        const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1
        line(buffer.slice(0, index))
        buffer = buffer.slice(index + width)
      }
      if (chunk.done) break
    }
    if (!doneEvent) throw new ProviderError('TRUNCATED')
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock() }
}
