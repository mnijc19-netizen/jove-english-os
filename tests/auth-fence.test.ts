import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createPrincipalFence } from '../src/cloud/auth-fence'

function fixture() {
  let listener!: (event: AuthChangeEvent, session: Session | null) => void
  const unsubscribe = vi.fn()
  const auth = { onAuthStateChange: (callback: typeof listener) => {
    listener = callback; return { data: { subscription: { id: 'fixture', callback, unsubscribe } } }
  } } as Pick<SupabaseClient['auth'], 'onAuthStateChange'>
  const emit = (event: AuthChangeEvent, id: string | null) => listener(event, id ? { user: { id } } as Session : null)
  return { fence: createPrincipalFence(auth), emit, unsubscribe }
}
describe('synchronous request principal fence', () => {
  it('is unusable until bound to the session and permits same-owner refresh events', () => {
    const { fence, emit } = fixture()
    expect(fence.isCurrent()).toBe(false)
    expect(fence.bind('a')).toBe(true)
    for (const event of ['INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'] as const) {
      emit(event, 'a'); expect(fence.isCurrent()).toBe(true)
    }
    fence.dispose()
  })
  it('permanently invalidates A to B to A before any asynchronous verification can finish', () => {
    const { fence, emit } = fixture(); fence.bind('a')
    emit('SIGNED_IN', 'b')
    expect(fence.signal.aborted).toBe(true)
    emit('SIGNED_IN', 'a')
    expect(fence.isCurrent()).toBe(false); expect(fence.bind('a')).toBe(false)
  })
  it('rejects sign-out before the initial getSession result arrives', () => {
    const { fence, emit } = fixture()
    emit('SIGNED_OUT', null)
    expect(fence.bind('a')).toBe(false); expect(fence.signal.aborted).toBe(true)
  })
  it('rejects an initial mismatch and a principal transition before bind', () => {
    const first = fixture(); first.emit('INITIAL_SESSION', 'b')
    expect(first.fence.bind('a')).toBe(false)
    const second = fixture(); second.emit('INITIAL_SESSION', 'a'); second.emit('SIGNED_IN', 'b'); second.emit('SIGNED_IN', 'a')
    expect(second.fence.bind('a')).toBe(false)
  })
  it('allows a matching initial session but never rebinds an existing request to a different owner', () => {
    const { fence, emit } = fixture(); emit('INITIAL_SESSION', 'a')
    expect(fence.bind('a')).toBe(true); expect(fence.bind('b')).toBe(false)
    expect(fence.isCurrent()).toBe(false)
  })
  it('disposes exactly once and cannot be revived by a late callback', () => {
    const { fence, emit, unsubscribe } = fixture(); fence.bind('a')
    fence.dispose(); fence.dispose(); emit('SIGNED_IN', 'a')
    expect(unsubscribe).toHaveBeenCalledTimes(1); expect(fence.isCurrent()).toBe(false)
    expect(fence.bind('a')).toBe(false)
  })
  it('fails closed when the account client or subscription is unavailable', () => {
    expect(createPrincipalFence().bind('a')).toBe(false)
    const auth = { onAuthStateChange() { throw new Error('unavailable') } } as Pick<SupabaseClient['auth'], 'onAuthStateChange'>
    expect(createPrincipalFence(auth).signal.aborted).toBe(true)
  })
})
