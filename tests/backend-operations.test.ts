import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../scripts/backend-operations.mjs', import.meta.url), 'utf8')
  .replace(/^import .+\r?$/gmu, '').replace('import.meta.dirname', JSON.stringify(resolve('scripts')))
const ref = 'jovefixtureonlyaaaaa'
function check(mode = 'inspect', name = 'jove-english-os', linked = '', status = 'ACTIVE_HEALTHY',
  env: Record<string, string> = {}, migrationRows = JSON.stringify({ migrations: [{ local: '202609080001', remote: '202609080001', time: '202609080001' }], message: 'Migrations listed' })) {
  const messages: string[] = [], calls: string[][] = [], environments: Record<string, string>[] = []
  const process = { argv: ['node', 'script', mode, '--project-ref', ref], execPath: 'node', exitCode: 0,
    env,
    stdout: { write: (s: string) => messages.push(s) }, stderr: { write: (s: string) => messages.push(s) } }
  const execute = vi.fn((_binary: string, args: string[], options: { env: Record<string, string> }) => {
    calls.push(args)
    environments.push(options.env)
    if (args.includes('projects')) return JSON.stringify([{ id: ref, name, status }])
    if (args.includes('functions') && args.includes('list')) return JSON.stringify(['ai', 'content', 'speech-assess'].map(slug => ({ slug, status: 'ACTIVE' })))
    if (args.includes('migration')) return migrationRows
    return ''
  })
  vm.runInNewContext(source, { process, resolve, execFileSync: execute,
    existsSync: () => Boolean(linked), readdirSync: () => ['202609080001_sync.sql'],
    readFileSync: (path: string) => path.endsWith('config.toml') ? 'project_id = "jove-english-os"' : linked })
  return { process, calls, environments, messages: messages.join('') }
}
describe('explicit dedicated-backend operation fence', () => {
  it('inspects without creating resources or applying changes', () => {
    const result = check()
    expect(result.process.exitCode).toBe(0); expect(result.calls).toHaveLength(1)
    expect(result.calls[0]).toContain('projects')
  })
  it.each(['other-app-preview', 'other-app-production', 'unrelated'])('rejects %s before any mutation', name => {
    const result = check('deploy-functions', name)
    expect(result.process.exitCode).toBe(1); expect(result.calls).toHaveLength(1)
    expect(result.messages).not.toContain(name)
  })
  it('rejects an unhealthy project and a different existing link', () => {
    expect(check('migrate', 'jove-english-os', ref, 'COMING_UP').process.exitCode).toBe(1)
    const result = check('deploy-functions', 'jove-english-os', 'otherexistingtargetaa')
    expect(result.process.exitCode).toBe(1); expect(result.calls).toHaveLength(1)
  })
  it('requires an explicit matching link before migrating', () => {
    expect(check('migrate').process.exitCode).toBe(1)
    const result = check('migrate', 'jove-english-os', ref)
    expect(result.process.exitCode).toBe(0)
    expect(result.calls.some(args => args.includes('push') && args.includes('--linked'))).toBe(true)
    for (const args of result.calls.filter(args => args.includes('push') || args.includes('migration'))) {
      expect(args).toContain('--project-ref'); expect(args).toContain(ref)
    }
    expect(result.calls.find(args => args.includes('push'))).toContain('--skip-vault')
    for (const environment of result.environments) expect(environment.SUPABASE_PROJECT_ID).toBe(ref)
    expect(result.calls.flat()).not.toContain('reset'); expect(result.calls.flat()).not.toContain('config')
  })
  it('builds and deploys only the three named functions with the explicit verified reference', () => {
    const result = check('deploy-functions')
    expect(result.process.exitCode).toBe(0)
    const deploys = result.calls.filter(args => args.includes('deploy'))
    expect(deploys).toHaveLength(3)
    for (const args of deploys) expect(args.slice(args.indexOf('--project-ref'), args.indexOf('--project-ref') + 2)).toEqual(['--project-ref', ref])
  })
  it('rejects unsupported modes without invoking the CLI', () => {
    const result = check('reset')
    expect(result.process.exitCode).toBe(1); expect(result.calls).toHaveLength(0)
  })
  it.each(['SUPABASE_PROJECT_ID', 'SUPABASE_DB_URL', 'SUPABASE_API_URL', 'SUPABASE_CLI_BINARY_OVERRIDE'])(
    'rejects inherited routing override %s before any CLI call without printing its value', variable => {
      const result = check('migrate', 'jove-english-os', ref, 'ACTIVE_HEALTHY', { [variable]: 'different-target-fixture' })
      expect(result.process.exitCode).toBe(1); expect(result.calls).toHaveLength(0)
      expect(result.messages).not.toContain('different-target-fixture')
    })
  it.each(['', '202609080001 | | timestamp', '202609080001 | 202609080999 | timestamp'])(
    'refuses a missing or mismatched migration readback', rows => {
      const result = check('migrations', 'jove-english-os', ref, 'ACTIVE_HEALTHY', {}, rows)
      expect(result.process.exitCode).toBe(1)
      expect(result.calls.flat()).not.toContain('push')
    })
  it('accepts the observed current CLI JSON and the legacy version table', () => {
    expect(check('migrations', 'jove-english-os', ref).process.exitCode).toBe(0)
    expect(check('migrations', 'jove-english-os', ref, 'ACTIVE_HEALTHY', {}, '202609080001 | 202609080001 | timestamp').process.exitCode).toBe(0)
  })
  it.each(['{}', '{broken', JSON.stringify({ migrations: [{ local: '202609080001', remote: null }] }),
    JSON.stringify({ migrations: [{ local: '202609080001', remote: '202609080999' }] })])(
    'rejects malformed or mismatched JSON version readback', rows => {
      const result = check('migrations', 'jove-english-os', ref, 'ACTIVE_HEALTHY', {}, rows)
      expect(result.process.exitCode).toBe(1); expect(result.calls.flat()).not.toContain('push')
    })
})
