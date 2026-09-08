import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../scripts/verify-release-readiness.mjs', import.meta.url), 'utf8')
const sha = 'a'.repeat(40), ref = 'jovefixtureonlyaaaaa'
async function run(overrides: Record<string, string | undefined> = {}, status = 401, code = 'SIGN_IN',
  response?: () => Response, deadlineMs = 10000) {
  const messages: string[] = []
  const process = { env: {
    JOVE_RELEASE_SHA: sha, JOVE_PRODUCTION_READY_SHA: sha, JOVE_PRODUCTION_PROJECT_REF: ref,
    VITE_SUPABASE_URL: `https://${ref}.supabase.co`, JOVE_PRODUCTION_READY_AT: new Date(Date.now() - 1000).toISOString(), ...overrides,
  }, exitCode: 0, stdout: { write: (s: string) => messages.push(s) }, stderr: { write: (s: string) => messages.push(s) } }
  const network = vi.fn(async () => response?.() ?? new Response(JSON.stringify({ error: { code } }), { status }))
  await vm.runInNewContext(`(async () => { ${source} })()`, { process, fetch: network, TextDecoder,
    AbortSignal: { timeout: () => AbortSignal.timeout(deadlineMs) } })
  return { process, network, messages: messages.join('') }
}
describe('default-closed commit-bound production release hold', () => {
  it('checks every actual handler only after a fresh exact-target approval', async () => {
    const result = await run()
    expect(result.process.exitCode).toBe(0); expect(result.network).toHaveBeenCalledTimes(3)
    for (const route of ['ai', 'content', 'speech-assess']) expect(result.network).toHaveBeenCalledWith(
      `https://${ref}.supabase.co/functions/v1/${route}`, expect.objectContaining({ redirect: 'error', body: '{}', method: 'POST' }))
    expect(result.messages).toContain('Production user journeys remain mandatory')
  })
  it.each([
    { JOVE_PRODUCTION_READY_SHA: '' }, { JOVE_PRODUCTION_READY_SHA: 'b'.repeat(40) },
    { JOVE_RELEASE_SHA: 'not-a-commit' }, { JOVE_PRODUCTION_PROJECT_REF: '' },
    { VITE_SUPABASE_URL: 'https://unprovisioned.invalid' }, { VITE_SUPABASE_URL: `https://${ref}.supabase.co/` },
    { VITE_SUPABASE_URL: 'http://127.0.0.1:55321' }, { JOVE_PRODUCTION_READY_AT: '' },
    { JOVE_PRODUCTION_READY_AT: new Date(Date.now() - 86401000).toISOString() },
    { JOVE_PRODUCTION_READY_AT: new Date(Date.now() + 60000).toISOString() },
  ])('blocks absent/stale/mismatched approval without network access: %j', async overrides => {
    const result = await run(overrides)
    expect(result.process.exitCode).toBe(1); expect(result.network).not.toHaveBeenCalled()
    expect(result.messages).not.toContain(sha); expect(result.messages).not.toContain(ref)
  })
  it.each([[200, 'SIGN_IN'], [401, 'Invalid JWT'], [404, 'NOT_FOUND'], [503, 'SERVICE_UNAVAILABLE']] as const)(
    'does not mistake gateway/status %s code %s for the required handler', async (status, code) => {
      const result = await run({}, status, code)
      expect(result.process.exitCode).toBe(1); expect(result.network).toHaveBeenCalledTimes(1)
    })
  it.each(['<html>unauthorized</html>', '{broken', JSON.stringify({ error: { code: 'SIGN_IN' }, padding: 'x'.repeat(4100) })])(
    'rejects malformed or oversized response bodies without printing them', async body => {
      const result = await run({}, 401, 'SIGN_IN', () => new Response(body, { status: 401 }))
      expect(result.process.exitCode).toBe(1); expect(result.messages).not.toContain(body)
    })
  it('rejects one failing later route rather than accepting the first response', async () => {
    let calls = 0
    const result = await run({}, 401, 'SIGN_IN', () => new Response(
      JSON.stringify({ error: { code: ++calls === 3 ? 'UNAVAILABLE' : 'SIGN_IN' } }), { status: 401 }))
    expect(result.process.exitCode).toBe(1); expect(result.network).toHaveBeenCalledTimes(3)
  })
  it('times out and cancels a body that hangs after successful response headers', async () => {
    const cancel = vi.fn()
    const result = await run({}, 401, 'SIGN_IN', () => new Response(new ReadableStream({ cancel }), { status: 401 }), 15)
    expect(result.process.exitCode).toBe(1); expect(cancel).toHaveBeenCalledOnce()
  })
  it('requires the same hold both before artifact upload and before actual deployment', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')
    const [verify, deploy] = workflow.split('\n  deploy:')
    expect(verify!.indexOf('node scripts/verify-release-readiness.mjs')).toBeGreaterThan(-1)
    expect(verify!.indexOf('node scripts/verify-release-readiness.mjs')).toBeLessThan(verify!.indexOf('actions/upload-pages-artifact@'))
    expect(deploy!.indexOf('node scripts/verify-release-readiness.mjs')).toBeGreaterThan(-1)
    expect(deploy!.indexOf('node scripts/verify-release-readiness.mjs')).toBeLessThan(deploy!.indexOf('actions/deploy-pages@'))
    expect(deploy).toContain('ref: ${{ github.sha }}')
  })
})
