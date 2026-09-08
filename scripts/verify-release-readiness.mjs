// Public metadata only. This release hold is issued AFTER actual backend
// readback; it does not turn a local fixture or a claimed approval into proof.
async function boundedJson(response, signal) {
  if (!response.body || signal.aborted) throw new Error('body')
  const reader = response.body.getReader(), chunks = []
  let size = 0, rejectAbort
  const interrupted = new Promise((_, reject) => { rejectAbort = reject })
  const abort = () => { rejectAbort(new Error('deadline')); void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) throw new Error('deadline')
    while (true) {
      const part = await Promise.race([reader.read(), interrupted])
      if (part.done) break
      size += part.value.byteLength
      if (size > 4096) throw new Error('body limit')
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally {
    signal.removeEventListener('abort', abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
try {
  const env = process.env
  const sha = env.JOVE_RELEASE_SHA ?? ''
  const ref = env.JOVE_PRODUCTION_PROJECT_REF ?? ''
  if (!/^[a-f0-9]{40}$/u.test(sha) || env.JOVE_PRODUCTION_READY_SHA !== sha) throw new Error('approval')
  if (!/^[a-z0-9]{20}$/u.test(ref) || env.VITE_SUPABASE_URL !== `https://${ref}.supabase.co`) throw new Error('target')
  const verifiedAt = Date.parse(env.JOVE_PRODUCTION_READY_AT ?? '')
  if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() || Date.now() - verifiedAt > 86400000) throw new Error('expired')
  for (const route of ['ai', 'content', 'speech-assess']) {
    const signal = AbortSignal.timeout(10000)
    const response = await fetch(`${env.VITE_SUPABASE_URL}/functions/v1/${route}`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: '{}', signal,
    })
    if (response.status !== 401 || (await boundedJson(response, signal)).error?.code !== 'SIGN_IN') throw new Error('handler')
  }
  process.stdout.write('Commit-bound Jove release hold satisfied; all three hosted handlers require sign-in. Production user journeys remain mandatory.\n')
} catch {
  process.stderr.write('Pages release held: a fresh approval for this exact commit and dedicated Jove backend, plus live authenticated-handler readiness, is required. No configuration values were printed.\n')
  process.exitCode = 1
}
