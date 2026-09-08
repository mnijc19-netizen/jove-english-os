import { z } from 'zod'
import { cloudClient, createAuthFence, publicCloudConfig } from '../cloud/client'
import { db } from '../db/db'
import { usageSchema } from '../db/schema'
import type { Usage } from '../domain/types'
import type { AIRequest } from '../server/ai'
import { evaluatedResultSchema, lookupSchema, materialSchema } from './schemas'
import { ProviderError, httpError } from './errors'
import { abortable, checkAbort, consumeSse, readJson, withDeadline } from './transport'
import { OpenRouterProvider, type ProviderNotice } from './provider'
import { normalizeTranscriptionAudio } from '../audio/transcription'

export type LearningProvider = Pick<OpenRouterProvider, keyof OpenRouterProvider>
const notices = z.array(z.strictObject({ kind: z.enum(['model-fallback', 'schema-fallback']), purpose: z.string(), from: z.string(), to: z.string() })).max(20)
const envelope = z.strictObject({ value: z.unknown(), notices, usage: z.array(usageSchema).max(10),
  delivery: z.strictObject({ requestId: z.uuid(), cache: z.literal('unconfirmed') }).optional() })
type ResultEnvelope = z.infer<typeof envelope>
const speechResult = z.strictObject({ audioBase64: z.string().min(4).max(2_000_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0), mimeType: z.literal('audio/mpeg') })
const resultSchemas: Record<AIRequest['action'], z.ZodType> = {
  status: z.strictObject({ label: z.string() }), evaluate: evaluatedResultSchema,
  chat: z.string().min(1).max(16000), lookup: lookupSchema, analyzeMaterial: materialSchema, generateMaterial: materialSchema,
  discover: z.array(z.strictObject({ title: z.string(), url: z.url(), description: z.string() })).max(3),
  transcribe: z.string().min(1).max(16000),
  synthesize: speechResult,
}
const pendingSchema = z.object({ requestId: z.uuid(), createdAt: z.number().finite(),
  recoveryUntil: z.number().finite().optional(),
  releaseReady: z.boolean().optional(),
  receipt: envelope.refine(value => !!value.delivery).optional(), receivedAt: z.number().finite().optional() })
const recoverySchema = z.strictObject({ requestId: z.uuid(), createdAt: z.number().finite(), recoveryUntil: z.number().finite() })
const RECEIPT_LIFETIME = 7 * 86400000
type Receipt = { requestId: string; receivedAt: number; receipt: ResultEnvelope }

function checkedResult(action: AIRequest['action'], input: unknown, requestId: string): ResultEnvelope {
  const result = envelope.safeParse(input)
  if (!result.success || (result.data.delivery && result.data.delivery.requestId !== requestId)) throw new ProviderError('INVALID_RESPONSE')
  const value = resultSchemas[action].safeParse(result.data.value)
  if (!value.success) throw new ProviderError('INVALID_RESPONSE')
  return { ...result.data, value: value.data }
}
type RequestInput = AIRequest extends infer R ? R extends AIRequest ? Omit<R, 'requestId'> : never : never

/** Uses account authentication, never a browser copy of the production AI key. */
export class CloudProvider implements LearningProvider {
  private notices: ProviderNotice[] = []
  // Only a short-lived fallback when local storage itself rejects a received
  // result. Never discard it and dispatch again while this instance is alive.
  private received = new Map<string, Receipt>()
  // A new paid identity is allowed only after this instance actually rejects
  // with ACCOUNT_UNCERTAIN, never merely because asynchronous cleanup ran.
  private warned = new Set<string>()
  constructor(private local: OpenRouterProvider, private onUsage: (usage: Usage) => Promise<void>) {}
  listModels(signal?: AbortSignal) { return this.local.listModels(signal) }
  retrieve(url: string, signal?: AbortSignal) { return this.local.retrieve(url, signal) }
  takeNotices() { return [...this.local.takeNotices(), ...this.notices.splice(0)] }
  private async accept(result: ResultEnvelope, assertCurrent: () => Promise<void>, assertIdentity: () => void): Promise<unknown> {
    this.notices.push(...result.notices)
    this.notices = this.notices.slice(-20)
    for (const usage of result.usage) {
      await assertCurrent()
      assertIdentity()
      await this.onUsage({ ...usage, purpose: `account:${usage.purpose}` })
    }
    await assertCurrent()
    assertIdentity()
    return result.value
  }
  private request(input: RequestInput, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<unknown> {
    const client = cloudClient
    if (!client) return Promise.reject(new ProviderError('ACCOUNT_SERVICE'))
    // Synchronous invalidation closes the gap *inside* async SDK/IDB checks,
    // including A -> B -> A. Subscribe before the first SDK/IDB await.
    const fence = createAuthFence()
    const lifetime = signal ? AbortSignal.any([signal, fence.signal]) : fence.signal
    let uncertainKey: string | undefined
    return withDeadline(lifetime, 75000, async scoped => {
      const { data, error } = await client.auth.getSession()
      if (error || !data.session) throw new ProviderError('ACCOUNT_REQUIRED')
      const ownerId = data.session.user.id
      if (!fence.bind(ownerId)) throw new ProviderError('ACCOUNT_REQUIRED')
      const assertIdentity = () => {
        if (!fence.isCurrent()) throw new ProviderError('ACCOUNT_REQUIRED')
        checkAbort(scoped)
      }
      assertIdentity()
      const owner = (await db.syncMeta.get('owner'))?.value
      if (owner !== ownerId) throw new ProviderError('ACCOUNT_REQUIRED')
      assertIdentity()
      const assertCurrent = async () => {
        assertIdentity()
        const current = await client.auth.getSession()
        assertIdentity()
        if (current.error || current.data.session?.user.id !== ownerId || (await db.syncMeta.get('owner'))?.value !== ownerId) throw new ProviderError('ACCOUNT_REQUIRED')
        assertIdentity()
        // Re-read after IDB for SDK notifications that have not been dispatched
        // yet. The synchronous fence still protects this final awaited read.
        const latest = await client.auth.getSession()
        assertIdentity()
        if (latest.error || latest.data.session?.user.id !== ownerId) throw new ProviderError('ACCOUNT_REQUIRED')
      }
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input))))].map(byte => byte.toString(16).padStart(2, '0')).join('')
      const pendingId = `ai-request:${ownerId}:${digest}`
      const recoveryId = `ai-retry:${ownerId}:${digest}`
      const pending: z.infer<typeof pendingSchema> = await db.transaction('rw', db.syncMeta, async () => {
        if ((await db.syncMeta.get('owner'))?.value !== ownerId) throw new ProviderError('ACCOUNT_REQUIRED')
        const pending = (await db.syncMeta.get(pendingId))?.value
        const parsed = pendingSchema.safeParse(pending)
        // A damaged received receipt is not permission for another paid call.
        if (pending !== undefined && !parsed.success) throw new ProviderError('INVALID_RESPONSE')
        if (parsed.success) {
          const key = `${pendingId}:${parsed.data.requestId}`
          if (!parsed.data.releaseReady || !this.warned.has(key)) return parsed.data
          // This is a subsequent explicit call, after the prior warning. Both
          // removal and allocation are serialized with competing requests.
          await db.syncMeta.delete(recoveryId)
          this.warned.delete(key); this.received.delete(key)
        } else {
          const prior = (await db.syncMeta.get(recoveryId))?.value
          if (prior !== undefined) {
            const recovery = recoverySchema.safeParse(prior)
            if (!recovery.success) throw new ProviderError('INVALID_RESPONSE')
            await db.syncMeta.put({ id: pendingId, value: recovery.data })
            return recovery.data
          }
        }
        const id = crypto.randomUUID()
        const value = { requestId: id, createdAt: Date.now() }
        await db.syncMeta.put({ id: pendingId, value })
        return value
      })
      const requestId = pending.requestId
      const receiptKey = `${pendingId}:${requestId}`
      // Every mutation below compares the owner and request identity inside the
      // same IDB transaction. A late response cannot replace a newer request.
      const assertStoredRequest = async () => {
        assertIdentity()
        if ((await db.syncMeta.get('owner'))?.value !== ownerId) throw new ProviderError('ACCOUNT_REQUIRED')
        const active = (await db.syncMeta.get(pendingId))?.value
        const retry = (await db.syncMeta.get(recoveryId))?.value
        for (const value of [active, retry]) {
          if (value === undefined) continue
          const stored = pendingSchema.safeParse(value)
          if (!stored.success) throw new ProviderError('INVALID_RESPONSE')
          if (stored.data.requestId !== requestId) throw new ProviderError('ACCOUNT_PENDING')
        }
        if (active === undefined && retry === undefined) throw new ProviderError('ACCOUNT_PENDING')
        assertIdentity()
      }
      const markUncertain = async () => {
        await assertCurrent(); checkAbort(scoped)
        await db.transaction('rw', db.syncMeta, async () => {
          await assertStoredRequest()
          // Drop any expired private receipt, but retain the identity until the
          // warning reaches the caller. Cancellation here must not authorize
          // another charge. A new instance conservatively warns again.
          await db.syncMeta.put({ id: pendingId, value: { requestId, createdAt: pending.createdAt, releaseReady: true } })
        })
        this.received.delete(receiptKey)
        await assertCurrent(); checkAbort(scoped)
        uncertainKey = receiptKey
      }
      const deliver = async (raw: unknown, receivedAt = Date.now()) => {
        // Validate the action before recording usage, caching or removing the
        // durable identity. An envelope alone does not establish valid evidence.
        const result = checkedResult(input.action, raw, requestId)
        await assertCurrent(); checkAbort(scoped)
        if (result.delivery) {
          this.received.set(receiptKey, { requestId, receipt: result, receivedAt })
          try {
            // syncMeta is local-only: not part of portable backups/sync records.
            await db.transaction('rw', db.syncMeta, async () => {
              await assertStoredRequest()
              await db.syncMeta.put({ id: pendingId, value: { ...pending, receipt: result, receivedAt } })
            })
          } catch (error) {
            if (error instanceof ProviderError) { this.received.delete(receiptKey); throw error }
            throw new ProviderError('USAGE')
          }
          this.received.delete(receiptKey)
          this.notices.push({ kind: 'result-cache-unconfirmed', purpose: input.action, from: 'account-server', to: 'this-device' })
        }
        const value = await this.accept(result, assertCurrent, assertIdentity)
        checkAbort(scoped)
        if (!result.delivery) await db.transaction('rw', db.syncMeta, async () => {
          await assertStoredRequest()
          // Atomically hand off the retry ID before removing the pending row.
          // Even cancellation after DELETE commits can only replay the same
          // server result. This local-only index contains no result or credentials.
          await db.syncMeta.put({ id: recoveryId, value: { requestId, createdAt: pending.createdAt,
            recoveryUntil: pending.recoveryUntil ?? pending.createdAt + RECEIPT_LIFETIME } })
          await db.syncMeta.delete(pendingId)
        })
        // Cleanup is asynchronous too: an account change/cancellation there
        // must fence both the final return and the JSON fallback delta callback.
        checkAbort(scoped)
        await assertCurrent()
        await db.transaction('r', db.syncMeta, assertStoredRequest)
        assertIdentity()
        return value
      }
      await assertCurrent()
      if (pending.releaseReady) { await markUncertain(); throw new ProviderError('ACCOUNT_UNCERTAIN') }
      if (pending.recoveryUntil !== undefined) {
        if (pending.recoveryUntil > Date.now() + RECEIPT_LIFETIME + 300000) throw new ProviderError('INVALID_RESPONSE')
        if (Date.now() >= pending.recoveryUntil) {
          await markUncertain()
          throw new ProviderError('ACCOUNT_UNCERTAIN')
        }
      }
      const receipt = this.received.get(receiptKey) ?? (pending.receipt ? { receipt: pending.receipt, receivedAt: pending.receivedAt, requestId } : undefined)
      if (receipt) {
        // Match server cache retention; never silently turn an expired receipt
        // into another bill. The following explicit retry may start a new call.
        if (receipt.receivedAt === undefined || receipt.receivedAt > Date.now() + 300000) throw new ProviderError('INVALID_RESPONSE')
        if (Date.now() - receipt.receivedAt >= RECEIPT_LIFETIME) {
          await markUncertain(); this.received.delete(receiptKey)
          throw new ProviderError('ACCOUNT_UNCERTAIN')
        }
        const value = await deliver(receipt.receipt, receipt.receivedAt)
        assertIdentity()
        if (onDelta && typeof value === 'string') onDelta(value)
        return value
      }
      if (this.received.size >= 10) throw new ProviderError('USAGE')
      const response = await fetch(`${publicCloudConfig.url}/functions/v1/ai`, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: scoped,
        headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: publicCloudConfig.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, requestId }),
      })
      await assertCurrent()
      if (!response.ok) {
        if (response.status === 409) {
          const prior = z.object({ error: z.object({ code: z.string() }) }).safeParse(await readJson(response, scoped))
          if (prior.success && prior.data.error.code === 'REQUEST_UNCERTAIN') {
            await markUncertain()
            throw new ProviderError('ACCOUNT_UNCERTAIN')
          }
          throw new ProviderError('ACCOUNT_PENDING')
        }
        void response.body?.cancel().catch(() => undefined)
        if ([401, 403].includes(response.status)) throw new ProviderError('ACCOUNT_REQUIRED')
        if (response.status >= 500) throw new ProviderError('ACCOUNT_SERVICE')
        if (response.status === 429) throw new ProviderError('BUDGET')
        throw httpError(response.status)
      }
      if (response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
        let result: unknown, finished = false
        let deliveryFailure: unknown, deliveryQueue = Promise.resolve()
        const stop = new AbortController(), deliverySignal = AbortSignal.any([scoped, stop.signal])
        try { await consumeSse(response, deliverySignal, value => {
          const event = z.union([
            z.strictObject({ delta: z.string().max(16000) }), z.strictObject({ result: envelope }),
            z.strictObject({ error: z.strictObject({ code: z.string(), message: z.string() }) }),
          ]).safeParse(value)
          if (!event.success) throw new ProviderError('INVALID_RESPONSE')
          // The framing parser is synchronous. Serialize async owner checks so
          // coalesced/fragmented UTF-8 frames cannot overtake checks or each other.
          // Attach rejection handling immediately and cancel reads on failure.
          deliveryQueue = deliveryQueue.then(async () => {
            checkAbort(deliverySignal)
            await abortable(assertCurrent(), deliverySignal)
            assertIdentity()
            checkAbort(deliverySignal)
            if ('error' in event.data) throw new ProviderError('UNAVAILABLE')
            if (finished) throw new ProviderError('INVALID_RESPONSE')
            if ('delta' in event.data) onDelta?.(event.data.delta)
            else { result = event.data.result; finished = true }
          }).catch(error => { deliveryFailure ??= error; stop.abort() })
        }) } catch (error) { deliveryFailure ??= error; stop.abort() }
        await deliveryQueue
        if (deliveryFailure) throw deliveryFailure
        if (!finished) throw new ProviderError('TRUNCATED')
        await assertCurrent()
        return deliver(result)
      }
      const result = await readJson(response, scoped, 2_100_000)
      await assertCurrent()
      const value = await deliver(result)
      assertIdentity()
      if (onDelta && typeof value === 'string') onDelta(value)
      return value
    }).catch(error => {
      if (fence.signal.aborted) throw new ProviderError('ACCOUNT_REQUIRED')
      if (error instanceof ProviderError && error.code === 'ACCOUNT_UNCERTAIN' && uncertainKey) {
        this.warned.add(uncertainKey)
        // Eviction only causes an extra warning, never a new paid dispatch.
        if (this.warned.size > 100) this.warned.delete(this.warned.values().next().value!)
      }
      throw error
    }).finally(() => fence.dispose())
  }
  async testConnection(signal?: AbortSignal) { return z.strictObject({ label: z.string() }).parse(await this.request({ action: 'status' }, signal)) }
  async evaluate(input: Parameters<OpenRouterProvider['evaluate']>[0], signal?: AbortSignal) {
    return evaluatedResultSchema.parse(await this.request({ action: 'evaluate', input }, signal))
  }
  async chat(messages: Parameters<OpenRouterProvider['chat']>[0], context: Parameters<OpenRouterProvider['chat']>[1], onDelta?: (text: string) => void, signal?: AbortSignal) {
    return z.string().min(1).max(16000).parse(await this.request({ action: 'chat', messages: messages.slice(-12), context, stream: !!onDelta }, signal, onDelta))
  }
  async lookup(expression: string, sourceSentence: string, signal?: AbortSignal) {
    return lookupSchema.parse(await this.request({ action: 'lookup', expression, sourceSentence }, signal))
  }
  async analyzeMaterial(text: string, signal?: AbortSignal) { return materialSchema.parse(await this.request({ action: 'analyzeMaterial', text }, signal)) }
  async generateMaterial(topic: string, signal?: AbortSignal) { return materialSchema.parse(await this.request({ action: 'generateMaterial', topic }, signal)) }
  async discover(topic: string, signal?: AbortSignal) {
    return z.array(z.strictObject({ title: z.string(), url: z.url(), description: z.string() })).max(3).parse(await this.request({ action: 'discover', topic }, signal))
  }
  async transcribe(blob: Blob, signal?: AbortSignal) {
    const wav = await normalizeTranscriptionAudio(blob, signal)
    const bytes = new Uint8Array(await wav.arrayBuffer())
    let binary = ''
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
    return z.string().min(1).max(16000).parse(await this.request({ action: 'transcribe', audioBase64: btoa(binary), mimeType: 'audio/wav' }, signal))
  }
  async synthesize(text: string, signal?: AbortSignal) {
    const result = speechResult.parse(await this.request({ action: 'synthesize', text }, signal))
    return new Blob([Uint8Array.from(atob(result.audioBase64), char => char.charCodeAt(0))], { type: result.mimeType })
  }
}

/** Per-call route selection preserves an explicit advanced BYOK fallback. */
export function routeProvider(local: OpenRouterProvider, remote: CloudProvider, useAccount: () => boolean): LearningProvider {
  return new Proxy(local, { get(target, name) {
    const selected = useAccount() ? remote : target
    const value = Reflect.get(selected, name)
    return typeof value === 'function' ? value.bind(selected) : value
  } })
}
