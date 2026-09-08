import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createPrincipalFence } from './auth-fence'

export interface PublicCloudConfig { url: string; publishableKey: string }
export function validCloudConfig(input: PublicCloudConfig): boolean {
  try {
    const url = new URL(input.url)
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return false
    const localPage = typeof location !== 'undefined' && ['127.0.0.1', 'localhost'].includes(location.hostname)
    if (url.protocol !== 'https:' && !((import.meta.env.DEV || localPage) && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) return false
    if (input.publishableKey.startsWith('sb_publishable_')) return true
    const payload = JSON.parse(atob(input.publishableKey.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    return payload.role === 'anon'
  } catch { return false }
}
export function createCloudClient(config: PublicCloudConfig): SupabaseClient {
  if (!validCloudConfig(config)) throw new Error('Invalid public cloud configuration. Never use a server key in the browser.')
  return createClient(config.url, config.publishableKey, { auth: {
    persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
    storageKey: 'jove-auth-session-v1',
  } })
}
export const publicCloudConfig: PublicCloudConfig = {
  url: import.meta.env.VITE_SUPABASE_URL ?? '', publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '',
}
export const cloudClient = validCloudConfig(publicCloudConfig) ? createCloudClient(publicCloudConfig) : null
export const createAuthFence = () => createPrincipalFence(cloudClient?.auth)
