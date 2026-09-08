import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { cloudClient, createAuthFence, publicCloudConfig } from './client'
import { db } from '../db/db'
import { abortable, checkAbort } from '../ai/transport'

export const accountPreferencesSchema = z.object({
  daily_budget_usd: z.number().finite().min(0).max(1000),
  monthly_budget_usd: z.number().finite().min(0).max(10000),
  recording_retention: z.enum(['minimal', 'assessment-only', 'more-history']),
  prosody_enabled: z.boolean(),
})
export type AccountPreferences = z.infer<typeof accountPreferencesSchema>
export const initialAccountPreferences: AccountPreferences = {
  daily_budget_usd: 1, monthly_budget_usd: 30, recording_retention: 'minimal', prosody_enabled: true,
}
const periodSchema = z.object({ startsAt: z.iso.datetime({ offset: true }), requests: z.number().int().nonnegative(),
  unknownCount: z.number().int().nonnegative(), reportedUsd: z.number().finite().nonnegative(), heldUsd: z.number().finite().nonnegative() })
export const accountUsageSchema = z.object({ today: periodSchema, week: periodSchema, month: periodSchema })
export type AccountUsage = z.infer<typeof accountUsageSchema>

export interface AccountServiceAccess {
  ownerId: string
  client: SupabaseClient
  assertCurrent: () => Promise<void>
  assertLive: () => void
  signal: AbortSignal
  dispose: () => void
}
/** No session/key is copied into learner records. Pin requests to one principal. */
export async function accountServiceAccess(signal = AbortSignal.timeout(15000)): Promise<AccountServiceAccess> {
  if (!cloudClient) throw new Error('The account service is not connected to this build.')
  const fence = createAuthFence()
  const dispose = () => { signal.removeEventListener('abort', dispose); fence.dispose() }
  signal.addEventListener('abort', dispose, { once: true })
  if (signal.aborted) dispose()
  const scoped = AbortSignal.any([signal, fence.signal])
  const wait = async <T>(pending: Promise<T>): Promise<T> => {
    try { return await abortable(pending, scoped) }
    catch (error) {
      if (fence.signal.aborted && !signal.aborted) throw new Error('The signed-in account changed. Reopen this page before continuing.')
      throw error
    }
  }
  try {
  const { data, error } = await wait(cloudClient.auth.getSession())
  const session = data.session
  if (error || !session || !fence.bind(session.user.id) || (await wait(db.syncMeta.get('owner')))?.value !== session.user.id) throw new Error('Sign in to your learning account first.')
  const assertLive = () => { checkAbort(signal); if (!fence.isCurrent()) throw new Error('The signed-in account changed. Reopen this page before continuing.') }
  assertLive()
  const ownerId = session.user.id
  const client = createClient(publicCloudConfig.url, publicCloudConfig.publishableKey, {
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const assertCurrent = async () => {
    assertLive()
    const current = await wait(cloudClient!.auth.getSession())
    assertLive()
    if (current.error || current.data.session?.user.id !== ownerId || (await wait(db.syncMeta.get('owner')))?.value !== ownerId)
      throw new Error('The signed-in account changed. Reopen this page before continuing.')
    assertLive()
  }
  await assertCurrent()
  assertLive()
  return { ownerId, client, assertCurrent, assertLive, signal: fence.signal, dispose }
  } catch (error) { dispose(); throw error }
}
export async function readAccountServices(access?: AccountServiceAccess, signal = AbortSignal.timeout(15000)) {
  const context = access ?? await accountServiceAccess(signal)
  try {
  signal = AbortSignal.any([signal, context.signal])
  await abortable(context.assertCurrent(), signal)
  context.assertLive(); signal.throwIfAborted()
  const [preferences, usage] = await abortable(Promise.all([
    context.client.from('service_preferences').select('daily_budget_usd,monthly_budget_usd,recording_retention,prosody_enabled').eq('user_id', context.ownerId).abortSignal(signal).maybeSingle(),
    context.client.rpc('account_service_summary').abortSignal(signal),
  ]), signal)
  await abortable(context.assertCurrent(), signal)
  context.assertLive(); signal.throwIfAborted()
  if (preferences.error || usage.error) throw new Error('Could not refresh account usage. Earlier learning records are safe.')
  return { preferences: accountPreferencesSchema.parse(preferences.data ?? initialAccountPreferences), usage: accountUsageSchema.parse(usage.data) }
  } catch (error) { context.assertLive(); throw error }
  finally { context.dispose() }
}
export async function saveAccountPreferences(patch: Partial<AccountPreferences>, access?: AccountServiceAccess, signal = AbortSignal.timeout(15000)) {
  const checked = accountPreferencesSchema.partial().strict().parse(patch)
  if (!Object.keys(checked).length) throw new Error('There is no preference change to save.')
  const context = access ?? await accountServiceAccess(signal)
  try {
  signal = AbortSignal.any([signal, context.signal])
  await abortable(context.assertCurrent(), signal)
  context.assertLive(); signal.throwIfAborted()
  // Initialize only the primary key; subsequent updates patch individual fields,
  // so another device's unrelated preference is not overwritten by a stale form.
  const initialized = await context.client.from('service_preferences').upsert({ user_id: context.ownerId }, { onConflict: 'user_id', ignoreDuplicates: true }).abortSignal(signal)
  context.assertLive(); signal.throwIfAborted()
  if (initialized.error) throw new Error('Could not initialize your account preferences.')
  const updated = await context.client.from('service_preferences').update(checked).eq('user_id', context.ownerId)
    .select('daily_budget_usd,monthly_budget_usd,recording_retention,prosody_enabled').abortSignal(signal).single()
  await abortable(context.assertCurrent(), signal)
  context.assertLive(); signal.throwIfAborted()
  if (updated.error) throw new Error('Your account preferences were not confirmed. Refresh before trying again.')
  return accountPreferencesSchema.parse(updated.data)
  } catch (error) { context.assertLive(); throw error }
  finally { context.dispose() }
}
