import type { SupabaseClient } from '@supabase/supabase-js'

export interface AuthFence {
  bind(ownerId: string): boolean
  isCurrent(): boolean
  readonly signal: AbortSignal
  dispose(): void
}

/** Subscribe BEFORE the first session/IndexedDB await. Never await SDK work in the callback. */
export function createPrincipalFence(auth?: Pick<SupabaseClient['auth'], 'onAuthStateChange'>): AuthFence {
  const controller = new AbortController()
  let observed = false, principal: string | null = null, owner: string | undefined
  let disposed = false, unsubscribe: (() => void) | undefined
  const invalidate = () => { if (!controller.signal.aborted) controller.abort() }
  if (!auth) invalidate()
  else {
    try {
      const { data } = auth.onAuthStateChange((event, session) => {
        if (disposed || controller.signal.aborted) return
        const next = session?.user.id ?? null
        if (event === 'SIGNED_OUT' || (observed && next !== principal) || (owner !== undefined && next !== owner)) invalidate()
        else { principal = next; observed = true }
      })
      unsubscribe = () => data.subscription.unsubscribe()
    } catch { invalidate() }
  }
  return {
    signal: controller.signal,
    bind(ownerId) {
      if (disposed || controller.signal.aborted || !ownerId || (owner !== undefined && owner !== ownerId)) { invalidate(); return false }
      if (observed && principal !== ownerId) { invalidate(); return false }
      owner = ownerId; principal = ownerId; observed = true
      return true
    },
    isCurrent: () => !disposed && !controller.signal.aborted && owner !== undefined && principal === owner,
    dispose() {
      if (disposed) return
      disposed = true; invalidate(); unsubscribe?.()
    },
  }
}
