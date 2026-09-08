import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PublicCloudConfig } from '../cloud/client'

/** The client must be private to this access and have an immutable Authorization.
 * Never pass the session-mutating application client as `client`. */
export interface SyncAccess {
  ownerId: string
  client: SupabaseClient
  assertCurrent: () => Promise<void>
}

export async function bindSyncAccess(source: SupabaseClient, ownerId: string, config: PublicCloudConfig,
  assertLocal: () => Promise<void> = async () => {}, transport: typeof fetch = fetch): Promise<SyncAccess> {
  const session = await source.auth.getSession()
  const token = session.data.session?.access_token
  if (session.error || !token) throw new Error('Sign in before synchronizing')
  const assertCurrent = async () => {
    await assertLocal()
    const current = await source.auth.getSession()
    if (current.error || current.data.session?.access_token !== token || current.data.session.user.id !== ownerId)
      throw new Error('Account changed during sync. Local work is safe.')
    await assertLocal()
  }
  // Cached session.user is not proof of identity. Auth validates this exact JWT.
  const user = await source.auth.getUser(token)
  if (user.error || user.data.user?.id !== ownerId) throw new Error('Sync account does not match this browser owner')
  await assertCurrent()
  const client = createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${token}` },
      fetch: async (input, init) => {
        await assertCurrent()
        // Protect every request, including Storage's internal retry/download paths.
        const headers = new Headers(input instanceof Request ? input.headers : undefined)
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
        headers.set('Authorization', `Bearer ${token}`)
        const response = await transport(input, { ...init, headers })
        await assertCurrent()
        return response
      },
    },
  })
  return { ownerId, client, assertCurrent }
}

export async function accountRequest<T>(access: SyncAccess, request: () => PromiseLike<T>): Promise<T> {
  await access.assertCurrent()
  const result = await request()
  await access.assertCurrent()
  return result
}
