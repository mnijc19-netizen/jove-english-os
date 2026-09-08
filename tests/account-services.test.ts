import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import { accountPreferencesSchema, accountServiceAccess, accountUsageSchema, initialAccountPreferences, readAccountServices, saveAccountPreferences } from '../src/cloud/services'
import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js'

const auth = vi.hoisted(() => ({ session: { user: { id: 'owner-a' }, access_token: 'fixture-owner-a' } as { user: { id: string }; access_token: string } | null,
  pause: undefined as Promise<void> | undefined,
  listeners: new Set<(event: AuthChangeEvent, session: Session | null) => void>() }))
vi.mock('../src/cloud/client', async () => {
  const { createPrincipalFence } = await import('../src/cloud/auth-fence')
  const events = { onAuthStateChange: (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
    auth.listeners.add(callback); return { data: { subscription: { id: 'fixture', callback, unsubscribe: () => { auth.listeners.delete(callback) } } } }
  } } as Pick<SupabaseClient['auth'], 'onAuthStateChange'>
  return {
  publicCloudConfig: { url: 'https://cloud.example.test', publishableKey: 'fixture-publishable' },
  cloudClient: { auth: { getSession: async () => { if (auth.pause) await auth.pause; return { data: { session: auth.session }, error: null } } } },
  createAuthFence: () => createPrincipalFence(events),
} })
const period = { startsAt: '2026-09-08T00:00:00Z', requests: 2, unknownCount: 1, reportedUsd: 0.05, heldUsd: 0.1 }
const summary = { today: period, week: period, month: period }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
let fetcher: ReturnType<typeof vi.fn>
beforeEach(async () => {
  await db.delete(); await db.open(); await db.syncMeta.put({ id: 'owner', value: 'owner-a' })
  auth.session = { user: { id: 'owner-a' }, access_token: 'fixture-owner-a' }
  auth.pause = undefined
  fetcher = vi.fn(async (input: string | URL, init: RequestInit) => {
    if (String(input).includes('account_service_summary')) return json(summary)
    if (init.method === 'POST') return json(null)
    return json(initialAccountPreferences)
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(async () => { expect(auth.listeners.size).toBe(0); vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.delete() })
describe('account service preferences and usage boundaries', () => {
  it('cancels a stalled initial session read and releases its subscription without waiting for the SDK', async () => {
    let release!: () => void
    auth.pause = new Promise<void>(resolve => { release = resolve })
    const controller = new AbortController()
    let finished = false
    const outcome = readAccountServices(undefined, controller.signal).catch(() => { finished = true })
    expect(auth.listeners.size).toBe(1)
    controller.abort()
    try {
      await vi.waitFor(() => expect(finished).toBe(true))
      expect(auth.listeners.size).toBe(0); expect(fetcher).not.toHaveBeenCalled()
    } finally { release(); await outcome }
  })
  it('uses real SDK requests pinned to one owner and a server aggregate for all three periods', async () => {
    expect(await readAccountServices()).toEqual({ preferences: initialAccountPreferences, usage: summary })
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture-owner-a')
    expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).searchParams.get('user_id') === 'eq.owner-a')).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/rpc/account_service_summary'))).toBe(true)
  })
  it('initializes only the owner and patches only the changed field', async () => {
    fetcher.mockImplementation(async (_input, init) => init.method === 'POST' ? json(null) : json({ ...initialAccountPreferences, daily_budget_usd: 2 }))
    expect((await saveAccountPreferences({ daily_budget_usd: 2 })).daily_budget_usd).toBe(2)
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body))).toEqual({ user_id: 'owner-a' })
    expect(JSON.parse(String(fetcher.mock.calls[1]![1].body))).toEqual({ daily_budget_usd: 2 })
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get('user_id')).toBe('eq.owner-a')
  })
  it.each([null, '', '0', -1, Number.NaN, Number.POSITIVE_INFINITY])('does not turn malformed budget %s into an apparently confirmed zero', value => {
    expect(accountPreferencesSchema.safeParse({ ...initialAccountPreferences, daily_budget_usd: value }).success).toBe(false)
  })
  it('accepts an explicit zero budget but never invents zero costs from null or missing totals', () => {
    expect(accountPreferencesSchema.safeParse({ ...initialAccountPreferences, daily_budget_usd: 0 }).success).toBe(true)
    expect(accountUsageSchema.safeParse({ ...summary, today: { ...period, reportedUsd: null } }).success).toBe(false)
    expect(accountUsageSchema.safeParse({ ...summary, today: { ...period, heldUsd: undefined } }).success).toBe(false)
  })
  it('rejects client owner overrides before any request', async () => {
    await expect(saveAccountPreferences({ ...initialAccountPreferences, user_id: 'owner-b' } as never)).rejects.toBeDefined()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects login mismatch and late results without displaying another owner’s totals', async () => {
    auth.session = null
    await expect(accountServiceAccess()).rejects.toThrow('Sign in')
    expect(fetcher).not.toHaveBeenCalled()
    auth.session = { user: { id: 'owner-a' }, access_token: 'fixture-owner-a' }
    const access = await accountServiceAccess()
    auth.session = { user: { id: 'owner-b' }, access_token: 'fixture-owner-b' }
    await expect(readAccountServices(access)).rejects.toThrow('account changed')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('never confirms a failed update or an unvalidated response', async () => {
    fetcher.mockResolvedValueOnce(json(null)).mockResolvedValueOnce(json({ message: 'Fixture failed' }, 503))
    await expect(saveAccountPreferences({ daily_budget_usd: 2 })).rejects.toThrow('not confirmed')
    fetcher.mockResolvedValueOnce(json(null)).mockResolvedValueOnce(json({ ...initialAccountPreferences, monthly_budget_usd: null }))
    await expect(saveAccountPreferences({ daily_budget_usd: 2 })).rejects.toBeDefined()
  })
  it('rejects a principal change inside the final IndexedDB owner check, including A to B to A', async () => {
    const access = await accountServiceAccess()
    const get = db.syncMeta.get.bind(db.syncMeta)
    vi.spyOn(db.syncMeta, 'get').mockImplementation(key => get(key).then(row => {
      if (String(key) === 'owner') {
        for (const id of ['owner-b', 'owner-a']) for (const listener of auth.listeners) listener('SIGNED_IN', { user: { id } } as Session)
      }
      return row
    }))
    await expect(readAccountServices(access)).rejects.toThrow('account changed')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not send a preference patch after sign-out during initialization', async () => {
    fetcher.mockImplementationOnce(async () => {
      for (const listener of auth.listeners) listener('SIGNED_OUT', null)
      return json(null)
    })
    await expect(saveAccountPreferences({ daily_budget_usd: 4 })).rejects.toThrow('account changed')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
