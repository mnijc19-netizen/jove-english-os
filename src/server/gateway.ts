import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type ServerEnvironment = (name: string) => string | undefined
export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
export interface OwnerContext { ownerId: string; admin: SupabaseClient; user: SupabaseClient }
export function corsHeaders(request: Request, env: ServerEnvironment): Headers {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin' })
  const origin = request.headers.get('Origin')
  const allowed = (env('JOVE_ALLOWED_ORIGINS') ?? 'https://mnijc19-netizen.github.io').split(',').map(value => value.trim())
  if (origin && !allowed.includes(origin)) throw new GatewayError(403, 'ORIGIN', 'This origin is not allowed.')
  if (origin) headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-request-id, x-client-info')
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  return headers
}
export async function authenticatedOwner(request: Request, env: ServerEnvironment): Promise<OwnerContext> {
  const header = request.headers.get('Authorization') ?? ''
  if (!/^Bearer [^\s]+$/.test(header) || header.length > 8192) throw new GatewayError(401, 'SIGN_IN', 'Sign in to continue.')
  const url = env('SUPABASE_URL'), publicKey = env('SUPABASE_ANON_KEY') ?? env('SUPABASE_PUBLISHABLE_KEY')
  if (!url || !publicKey) throw new GatewayError(503, 'CONFIGURATION', 'The service is not configured yet.')
  const user = createClient(url, publicKey, { global: { headers: { Authorization: header } }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await user.auth.getUser(header.slice(7))
  if (error || !data.user) throw new GatewayError(401, 'SIGN_IN', 'Sign in again to continue. Your saved work is safe.')
  const member = await user.from('app_members').select('user_id').eq('user_id', data.user.id).maybeSingle()
  if (member.error || !member.data) throw new GatewayError(403, 'NOT_OWNER', 'This account does not have access to this learning space.')
  // Load the elevated credential only after cryptographic session validation and membership.
  const serverKey = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!serverKey) throw new GatewayError(503, 'CONFIGURATION', 'The server service needs configuration.')
  const admin = createClient(url, serverKey, { auth: { persistSession: false, autoRefreshToken: false } })
  return { ownerId: data.user.id, user, admin }
}
export async function boundedBody(request: Request, limit: number, timeoutMs = 15000): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new GatewayError(503, 'CONFIGURATION', 'The upload limit is not configured.')
  const cancelled = () => new GatewayError(408, 'UPLOAD_INTERRUPTED', 'The upload was interrupted. Your original work is retained.')
  // A buffered reader can win Promise.race against an already-rejected abort.
  // Do not acquire/read a stream at all when cancellation is already known.
  if (request.signal.aborted) throw cancelled()
  if (Number(request.headers.get('Content-Length') ?? 0) > limit) throw new GatewayError(413, 'TOO_LARGE', 'This request is too large.')
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let rejectRead: ((error: GatewayError) => void) | undefined
  let interruption: GatewayError | undefined
  const interrupted = new Promise<never>((_resolve, reject) => { rejectRead = reject })
  // Attach the handler before inspecting an already-aborted request.
  void interrupted.catch(() => undefined)
  const interrupt = (error: GatewayError) => { interruption ??= error; rejectRead?.(interruption) }
  const abort = () => interrupt(cancelled())
  request.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => interrupt(new GatewayError(408, 'UPLOAD_TIMEOUT', 'The upload took too long. Your original work is retained.')), timeoutMs)
  if (request.signal.aborted) abort()
  let length = 0, completed = false
  try {
    while (true) {
      if (request.signal.aborted) throw cancelled()
      if (interruption) throw interruption
      const read = reader.read().then(part => { if (part.done) completed = true; return part })
      const { value, done } = await Promise.race([read, interrupted])
      if (request.signal.aborted) throw cancelled()
      if (interruption) throw interruption
      if (done) break
      length += value.byteLength
      if (length > limit) throw new GatewayError(413, 'TOO_LARGE', 'This request is too large.')
      chunks.push(value)
    }
  } finally {
    clearTimeout(timer); request.signal.removeEventListener('abort', abort)
    // A fully consumed multipart body is already closed. Cancelling it again
    // can race an upstream encoder's final continuation on newer runtimes.
    if (!completed) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}
export async function digestRequest(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
export interface Reservation {
  id: string; request_id: string; fingerprint: string; status: 'reserved' | 'completed' | 'failed' | 'uncertain'; created_at: string;
  dispatch_nonce: string; acquired: boolean;
}
export async function reserve(context: OwnerContext, requestId: string, fingerprint: string,
  service: 'llm' | 'stt' | 'tts' | 'pronunciation' | 'content' | 'storage', estimateUsd: number): Promise<Reservation> {
  const nonce = crypto.randomUUID()
  const { data, error } = await context.admin.rpc('reserve_service_call', {
    owner_id: context.ownerId, request_id: requestId, fingerprint, service, estimated_usd: estimateUsd, claim_nonce: nonce,
  })
  if (error) throw new GatewayError(error.code === 'P0001' ? 429 : 503, error.code === 'P0001' ? 'BUDGET' : 'RESERVATION',
    error.code === 'P0001' ? 'Your practice budget has been reached. Local learning remains available.' : 'Could not safely reserve this request. Your work is saved.')
  if (!data?.id) throw new GatewayError(503, 'RESERVATION', 'The usage reservation could not be confirmed.')
  return { ...data, acquired: data.dispatch_nonce === nonce } as Reservation
}
export async function settle(context: OwnerContext, id: string, outcome: {
  status: 'completed' | 'failed' | 'uncertain'; actualUsd?: number | null; units?: number; unitName?: string;
}): Promise<void> {
  const update = context.admin.from('service_usage').update({ status: outcome.status,
    actual_usd: outcome.actualUsd ?? null, units: outcome.units ?? 0, unit_name: outcome.unitName ?? 'request', updated_at: new Date().toISOString(),
  }).eq('id', id).eq('user_id', context.ownerId)
  // The predicate is part of the database UPDATE, not a read-then-write check:
  // an unknown/cancelled settlement must never erase a confirmed charge (or zero).
  const { error } = await (outcome.actualUsd == null ? update.is('actual_usd', null) : update)
  if (error) throw new GatewayError(503, 'USAGE_PENDING', 'The request finished but usage confirmation needs retry. Your work is saved.')
}
export function jsonResponse(value: unknown, headers: Headers, status = 200): Response {
  const responseHeaders = new Headers(headers); responseHeaders.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(value), { status, headers: responseHeaders })
}
export function safeFailure(error: unknown, headers: Headers): Response {
  const known = error instanceof GatewayError ? error : new GatewayError(503, 'SERVICE_UNAVAILABLE', 'The service could not finish. Your saved work is safe; try again later.')
  return jsonResponse({ error: { code: known.code, message: known.message } }, headers, known.status)
}
