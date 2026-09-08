import { describe, expect, it, vi } from 'vitest'
import { authenticatedOwner, boundedBody, corsHeaders, digestRequest, GatewayError, safeFailure, settle, type OwnerContext } from '../src/server/gateway'
import { createClient } from '@supabase/supabase-js'
import { retentionDecision } from '../src/sync/audio'

describe('authenticated service gateway', () => {
  it('rejects unauthenticated calls before loading any credential', async () => {
    const env = vi.fn(() => 'must-not-be-read')
    await expect(authenticatedOwner(new Request('https://example.test/functions/v1/ai'), env)).rejects.toMatchObject({ status: 401 })
    expect(env).not.toHaveBeenCalled()
  })
  it('allows only configured browser origins without wildcard credential sharing', () => {
    const allowed = new Request('https://example.test', { headers: { Origin: 'https://mnijc19-netizen.github.io' } })
    expect(corsHeaders(allowed, () => undefined).get('Access-Control-Allow-Origin')).toBe('https://mnijc19-netizen.github.io')
    expect(() => corsHeaders(new Request('https://example.test', { headers: { Origin: 'https://attacker.invalid' } }), () => undefined)).toThrow(GatewayError)
  })
  it('bounds actual streaming bytes, independently of claimed content length', async () => {
    const oversized = new Request('https://example.test', { method: 'POST', body: 'abcdef' })
    await expect(boundedBody(oversized, 5)).rejects.toMatchObject({ status: 413 })
    expect(new TextDecoder().decode(await boundedBody(new Request('https://example.test', { method: 'POST', body: 'abc' }), 3))).toBe('abc')
  })
  it('never includes arbitrary exception details in service responses', async () => {
    const response = safeFailure(new Error('secret-like internal fixture must remain private'), new Headers())
    const body = await response.text()
    expect(body).not.toContain('secret-like')
    expect(response.status).toBe(503)
  })
  it('bounds a stalled upload and observes cancellation without leaking a reader', async () => {
    const cancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled })
    const request = new Request('https://example.test', { method: 'POST', body, duplex: 'half' } as RequestInit)
    await expect(boundedBody(request, 10, 20)).rejects.toMatchObject({ status: 408, code: 'UPLOAD_TIMEOUT' })
    expect(cancelled).toHaveBeenCalledOnce()
    const controller = new AbortController()
    controller.abort()
    await expect(boundedBody(new Request('https://example.test', { method: 'POST', body: 'abc', signal: controller.signal }), 10)).rejects.toMatchObject({ status: 408 })
  })
  it('uses an actual SHA-256 fingerprint', async () => {
    expect(await digestRequest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it.each([0, 0.001])('uses an atomic null predicate to preserve a confirmed cost of %s, retaining the owner filter', async cost => {
    const row = { id: 'usage-row', user_id: 'owner-a', actual_usd: cost, status: 'completed' }
    const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input)), patch = JSON.parse(String(options?.body))
      const matches = url.searchParams.get('id') === `eq.${row.id}` && url.searchParams.get('user_id') === `eq.${row.user_id}` &&
        (url.searchParams.get('actual_usd') !== 'is.null' || row.actual_usd === null)
      if (matches) Object.assign(row, patch)
      return new Response(null, { status: 204 })
    })
    const admin = createClient('https://fixture.invalid', 'fixture-public-key', { global: { fetch: fetcher },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    const context: OwnerContext = { ownerId: 'owner-a', user: admin, admin }
    await settle(context, row.id, { status: 'uncertain', actualUsd: null })
    expect(row).toMatchObject({ status: 'completed', actual_usd: cost })
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('actual_usd')).toBe('is.null')
    await settle({ ...context, ownerId: 'owner-b' }, row.id, { status: 'completed', actualUsd: 42 })
    expect(row.actual_usd).toBe(cost)
  })
})
describe('privacy-aware recording retention', () => {
  const now = 1788815000000, asset = { kind: 'recording' as const, processed: true, createdAt: now }
  const none = { active: false, assessment: false, pronunciation: false }
  it('protects unfinished originals regardless of the selected history policy', () => {
    for (const policy of ['minimal', 'assessment-only', 'more-history'] as const) {
      expect(retentionDecision({ ...asset, processed: false }, policy, none, now)?.expiresAt).toBeNull()
      expect(retentionDecision(asset, policy, { ...none, active: true }, now)?.expiresAt).toBeNull()
    }
  })
  it('keeps assessments and limits optional ordinary history without sliding expiration', () => {
    expect(retentionDecision(asset, 'minimal', none, now)).toBeNull()
    expect(retentionDecision(asset, 'assessment-only', { ...none, assessment: true }, now)?.expiresAt).toBeNull()
    const retained = retentionDecision(asset, 'more-history', none, now)
    expect(retained?.expiresAt).toBe(now + 30 * 86400000)
    expect(retentionDecision(asset, 'more-history', none, now + 31 * 86400000)).toBeNull()
    expect(retentionDecision({ ...asset, kind: 'generated' }, 'more-history', none, now)).toBeNull()
  })
})
