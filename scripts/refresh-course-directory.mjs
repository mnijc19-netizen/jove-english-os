// Dependency-free scheduler client. Never accepts a caller-selected URL/action.
import { pathToFileURL } from 'node:url'

const endpoint = 'https://lnkxdwzdcrtlucaezhkd.supabase.co/functions/v1/content'
export async function refreshCourseDirectory(token, fetcher = fetch) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) throw new Error('Directory job credential is not configured.')
  const signal = AbortSignal.timeout(30000)
  const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit', signal,
    headers: { 'Content-Type': 'application/json', 'X-Jove-Catalog-Job': token }, body: '{"action":"catalog-refresh"}' })
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('Directory refresh failed; inspect backend health without repeating paid work.') }
  if (!response.body) throw new Error('Directory response is missing.')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 4096) throw new Error('Directory response exceeds its limit.')
      chunks.push(part.value)
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Directory response is invalid.') }
  if (value?.refreshed === true && value.lessons === 52 && value.sourceId === 'voa-level1'
    && typeof value.revision === 'string' && /^[a-f0-9]{64}$/u.test(value.revision)) return 'Course directory refreshed: 52 lessons.'
  if (value?.refreshed === false && value.reason === 'not-due-or-running') return 'Course directory is not due or another refresh owns the lease.'
  throw new Error('Directory refresh did not confirm a valid outcome.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(await refreshCourseDirectory(process.env.JOVE_CATALOG_JOB_TOKEN)) }
  catch { console.error('Course directory job failed. No credential or upstream response was logged.'); process.exitCode = 1 }
}
