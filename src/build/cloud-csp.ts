/** Extend the existing policy with exactly the configured account origin.
 * This is build-time configuration, never a URL accepted from imported content. */
function accountOrigin(configuredUrl: string, allowLocal: boolean): string {
  let url: URL
  try { url = new URL(configuredUrl) } catch { throw new Error('Invalid configured account origin') }
  const loopback = allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '55321'
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.search || url.hash
    || !['', '/'].includes(url.pathname)) throw new Error('Account services require an exact HTTPS origin; local testing uses only the dedicated Jove port')
  return url.origin
}

/** Fail before bundling if a release has no cloud or contains a server credential. */
export function assertCloudBuildConfig(url: string, key: string, required: boolean, allowLocal = false): void {
  if (!url && !key && !required) return
  if (!url || !key) throw new Error('This release requires both public account URL and publishable key; server secrets must never be passed to Vite')
  accountOrigin(url, allowLocal)
  if (/^sb_publishable_[A-Za-z0-9_-]{16,128}$/u.test(key)) return
  try {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(key)) throw new Error('not a JWT')
    const payload = JSON.parse(atob(key.split('.')[1]!.replace(/-/gu, '+').replace(/_/gu, '/')))
    if (payload.role === 'anon') return
  } catch { /* Never echo a rejected value. */ }
  throw new Error('Only a publishable key or legacy anon key is allowed in the frontend build')
}

export function withCloudCsp(html: string, configuredUrl: string, allowLocal = false): string {
  if (!configuredUrl) return html
  const origin = accountOrigin(configuredUrl, allowLocal)
  const policy = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]+)("\s*\/>)/u
  const match = policy.exec(html)
  if (!match || !match[2]!.includes("connect-src 'self' https://openrouter.ai;")) throw new Error('The baseline account connection policy could not be verified')
  return html.replace(policy, (_all, before: string, content: string, after: string) =>
    before + content.replace("connect-src 'self' https://openrouter.ai;", `connect-src 'self' https://openrouter.ai ${origin};`) + after)
}
