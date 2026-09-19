// Dependency-free scheduler client. Never accepts a caller-selected URL/action.
import { pathToFileURL } from 'node:url'

const endpoint = 'https://lnkxdwzdcrtlucaezhkd.supabase.co/functions/v1/content'
class DirectoryJobError extends Error {
  constructor(message, diagnostics) { super(message); this.diagnostics = diagnostics }
}
// Only our own fixed categories/status/source IDs reach logs. Never serialize
// an upstream Error, message, body, URL, credential or stack, even on failure.
export function directoryJobDiagnostics(error) {
  return error instanceof DirectoryJobError ? error.diagnostics : [{ code: 'UNCLASSIFIED' }]
}
export async function refreshCourseDirectory(token, fetcher = fetch, sourceId = 'voa-level1') {
  const lessons = sourceId === 'voa-level1' ? 52 : sourceId === 'voa-level2' ? 30 : 0
  if (!lessons) throw new Error('Unknown directory source.')
  const failure = (code, message, status) => new DirectoryJobError(message, [{ sourceId, code, ...(status === undefined ? {} : { status }) }])
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) throw failure('CREDENTIAL', 'Directory job credential is not configured.')
  const signal = AbortSignal.timeout(30000)
  let response
  try { response = await fetcher(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit', signal,
    headers: { 'Content-Type': 'application/json', 'X-Jove-Catalog-Job': token },
    body: JSON.stringify({ action: 'catalog-refresh', ...(sourceId === 'voa-level1' ? {} : { sourceId }) }) }) }
  catch { throw failure(signal.aborted ? 'TIMEOUT' : 'TRANSPORT', 'Directory transport failed; no automatic retry.') }
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw failure('HTTP', 'Directory refresh failed; inspect backend health without repeating paid work.', response.status) }
  if (!response.body) throw failure('RESPONSE_MISSING', 'Directory response is missing.')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 4096) throw failure('RESPONSE_LIMIT', 'Directory response exceeds its limit.')
      chunks.push(part.value)
    }
  } catch (error) {
    if (error instanceof DirectoryJobError) throw error
    throw failure(signal.aborted ? 'TIMEOUT' : 'RESPONSE_READ', 'Directory response could not be read.')
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure('RESPONSE_JSON', 'Directory response is invalid.') }
  if (value?.refreshed === true && value.lessons === lessons && value.sourceId === sourceId
    && typeof value.revision === 'string' && /^[a-f0-9]{64}$/u.test(value.revision)) return `Course directory refreshed: ${lessons} lessons.`
  if (value?.refreshed === false && value.reason === 'not-due-or-running') return 'Course directory is not due or another refresh owns the lease.'
  throw failure('RESPONSE_CONTRACT', 'Directory refresh did not confirm a valid outcome.')
}

export async function refreshCourseDirectories(token, fetcher = fetch) {
  const results = await Promise.allSettled(['voa-level1', 'voa-level2'].map(source => refreshCourseDirectory(token, fetcher, source)))
  if (results.some(result => result.status === 'rejected')) throw new DirectoryJobError('One or more course directories failed; successful refreshes remain saved.',
    results.flatMap((result, index) => result.status === 'rejected' ? directoryJobDiagnostics(result.reason)
      : [{ sourceId: ['voa-level1', 'voa-level2'][index], code: 'SUCCESS_OR_NOT_DUE' }]))
  return results.map(result => result.value).join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(await refreshCourseDirectories(process.env.JOVE_CATALOG_JOB_TOKEN)) }
  catch (error) { console.error(`Course directory job failed: ${JSON.stringify(directoryJobDiagnostics(error))}. No credential or upstream response was logged.`); process.exitCode = 1 }
}
