// Deliberately absent from the browser barrel. Import only in an authenticated server function.
import { normalizeAzureAssessment } from './normalize'
import { validateAcousticRequest } from './schemas'
import { inspectAssessmentWav } from './wav'
import { SPEECH_LIMITS, SpeechError } from './types'
import type { AcousticRequest, AssessmentResult, SpeechUsage } from './types'

export interface AzureSpeechServerOptions {
  /** Trusted deployment config, never taken from a client request. Public Azure cloud only. */
  resourceName: string
  getCredentials: () => Promise<{ subscriptionKey: string }>
  fetch?: typeof fetch
  timeoutMs?: number
  /** Default 0. At most 1 extra attempt, only for explicit 429/503 responses. May cost twice. */
  maxRetries?: 0 | 1
}
function assertServer(): void {
  // Deno 1 exposes window === globalThis without a DOM. A window-only test
  // rejects a real Supabase server. This is misuse protection, not key security:
  // credentials still come exclusively from the authenticated server environment.
  const deno = (globalThis as typeof globalThis & { Deno?: { version?: { deno?: string }; serve?: unknown } }).Deno
  const denoServer = typeof deno?.version?.deno === 'string' && typeof deno.serve === 'function'
  if (typeof document !== 'undefined' || (!denoServer && (typeof window !== 'undefined' || ('WorkerGlobalScope' in globalThis && 'navigator' in globalThis)))) throw new SpeechError('SERVER_ONLY')
}
function base64Utf8(text: string): string { return btoa(String.fromCharCode(...new TextEncoder().encode(text))) }
async function sha256(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('')
}
function throwIfCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new SpeechError('CANCELLED') }
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    void response.body?.cancel().catch(() => undefined)
    throw new SpeechError('MALFORMED_RESPONSE')
  }
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > SPEECH_LIMITS.maxResponseBytes) throw new SpeechError('MALFORMED_RESPONSE')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new SpeechError('MALFORMED_RESPONSE') }
  } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => undefined); reader.releaseLock() }
}
/** A total deadline covers credential loading, fetch headers, and body consumption. */
async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, external?: AbortSignal): Promise<T> {
  throwIfCancelled(external)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort = () => {}
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(new SpeechError('CANCELLED')) }
    external?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => { controller.abort(); reject(new SpeechError('TIMEOUT')) }, timeoutMs)
  })
  try { return await Promise.race([run(controller.signal), deadline]) }
  finally { clearTimeout(timer); external?.removeEventListener('abort', onAbort) }
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new SpeechError('CANCELLED')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export function createAzureSpeechAdapter(options: AzureSpeechServerOptions): { assess: (request: AcousticRequest, signal?: AbortSignal) => Promise<AssessmentResult> } {
  assertServer()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(options.resourceName) || ![0, 1].includes(options.maxRetries ?? 0) || !Number.isInteger(options.timeoutMs ?? 20000) || (options.timeoutMs ?? 20000) < 100 || (options.timeoutMs ?? 20000) > 30000 || typeof options.getCredentials !== 'function') throw new SpeechError('CONFIGURATION')
  // Fixed origin and path prevent arbitrary egress or key forwarding through a redirect.
  const endpoint = `https://${options.resourceName}.cognitiveservices.azure.com/stt/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`
  const fetcher = options.fetch ?? globalThis.fetch
  const getCredentials = options.getCredentials
  const maxRetries = options.maxRetries ?? 0
  const timeoutMs = options.timeoutMs ?? 20000
  return { async assess(input, signal) {
    let requests = 0, seconds = 0, prosody = false
    const usage = (): SpeechUsage[] => (['azure.speech.pronunciation', ...(prosody ? ['azure.speech.prosody'] : [])] as SpeechUsage['service'][]).map(service => ({ service, requests, submittedAudioSeconds: requests * seconds, estimatedBillableSeconds: requests * Math.ceil(seconds), actualCostUsd: null, billingStatus: requests ? 'unknown' : 'not-submitted' }))
    try {
      assertServer(); throwIfCancelled(signal)
      const request = validateAcousticRequest(input)
      seconds = inspectAssessmentWav(request.audioWav).durationSeconds
      prosody = request.enableProsody === true
      const referenceSha256 = await sha256(request.referenceText)
      const header = base64Utf8(JSON.stringify({ ReferenceText: request.referenceText, GradingSystem: 'HundredMark', Granularity: 'Phoneme', Dimension: 'Comprehensive', EnableMiscue: 'True', EnableProsodyAssessment: prosody ? 'True' : 'False' }))
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let retryAfterMs: number | null = null
        const result = await withDeadline(async innerSignal => {
          let subscriptionKey: string
          try {
            const credentials = await getCredentials()
            subscriptionKey = credentials.subscriptionKey
            if (typeof subscriptionKey !== 'string' || !/^[a-zA-Z0-9_-]{16,256}$/.test(subscriptionKey)) throw new Error()
          } catch { throw new SpeechError('CONFIGURATION') }
          // A timed-out credential promise must never later send a request.
          if (innerSignal.aborted) throw new SpeechError('CANCELLED')
          requests++
          let response: Response
          try {
            response = await fetcher(endpoint, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': subscriptionKey, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000', Accept: 'application/json', 'Pronunciation-Assessment': header }, body: new Uint8Array(request.audioWav), signal: innerSignal, redirect: 'error', cache: 'no-store' })
          } catch { throw new SpeechError('NETWORK') }
          if (!response.ok) {
            void response.body?.cancel().catch(() => undefined)
            if ([429, 503].includes(response.status)) {
              const retry = response.headers.get('retry-after')
              const parsed = retry === null ? 500 : /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()
              // Do not retry earlier than a long provider backoff. Return control to caller.
              if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 5000) retryAfterMs = Math.max(250, parsed)
              return new SpeechError(response.status === 429 ? 'RATE_LIMIT' : 'UNAVAILABLE')
            }
            throw new SpeechError([401, 403].includes(response.status) ? 'AUTH' : response.status >= 500 ? 'UNAVAILABLE' : 'PROVIDER_ERROR')
          }
          if (innerSignal.aborted) { void response.body?.cancel().catch(() => undefined); throw new SpeechError('CANCELLED') }
          const raw = await boundedJson(response, innerSignal)
          if (innerSignal.aborted) throw new SpeechError('CANCELLED')
          return normalizeAzureAssessment(raw, { attemptId: request.attemptId, recordingId: request.recordingId, referenceId: request.referenceId, referenceSha256, audioSeconds: seconds, prosodyRequested: prosody })
        }, timeoutMs, signal)
        throwIfCancelled(signal)
        if (!(result instanceof SpeechError)) return { ok: true, assessment: result, usage: usage() }
        if (attempt === maxRetries || retryAfterMs === null) throw result
        await delay(retryAfterMs, signal)
      }
      throw new SpeechError('PROVIDER_ERROR')
    } catch (cause) {
      const error = signal?.aborted ? new SpeechError('CANCELLED') : cause instanceof SpeechError ? cause : new SpeechError('PROVIDER_ERROR')
      return { ok: false, error: { code: error.code, message: error.message, recoverable: true, retryable: error.retryable }, usage: usage() }
    }
  } }
}
