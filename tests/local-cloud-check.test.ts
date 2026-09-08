import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../scripts/verify-local-cloud.mjs', import.meta.url), 'utf8')
  .replace(/^import .+\r?$/gmu, '').replace('import.meta.dirname', JSON.stringify(resolve('scripts')))
const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8')
function startupFailure(stderr: string, status: number | null = 1, signal: string | null = null) {
  const messages: string[] = []
  const process = { argv: ['node', 'check', '--start'], execPath: 'node', exitCode: 0,
    stdout: { write: (value: string) => messages.push(value) }, stderr: { write: (value: string) => messages.push(value) } }
  const exec = vi.fn(() => { throw Object.assign(new Error('PRIVATE_PROCESS_DETAIL'), {
    stdout: 'PRIVATE_LOCAL_CREDENTIAL', stderr, status, signal,
  }) })
  vm.runInNewContext(source, { process, resolve, realpathSync: (path: string) => path,
    readFileSync: () => config, readdirSync: () => [], execFileSync: exec })
  return { process, messages: messages.join(''), exec }
}

describe('safe local backend startup diagnostics', () => {
  it.each([
    ['Cannot connect to the Docker daemon', 'DOCKER_UNAVAILABLE'],
    ['failed to pull image: manifest unknown', 'IMAGE_PULL_FAILED'],
    ['address already in use', 'PORT_BUSY'],
    ['no space left on device', 'NO_SPACE'],
    ['container is not healthy', 'HEALTH_CHECK_FAILED'],
    ['Applying migration 202609080004_content.sql: ERROR SQLSTATE 42P01', 'SQL_42P01'],
    ['Module not found jove-runtime.js', 'RUNTIME_MODULE_MISSING'],
  ])('classifies %s without echoing CLI data', (detail, marker) => {
    const result = startupFailure(`${detail}\nPRIVATE_LOCAL_CREDENTIAL`)
    expect(result.process.exitCode).toBe(1)
    expect(result.messages).toContain(marker)
    expect(result.messages).not.toContain('PRIVATE_')
    expect(result.messages).not.toContain(detail)
    expect(result.exec).toHaveBeenCalledTimes(1)
  })
  it('withholds arbitrary details, signal names and unknown SQLSTATE values', () => {
    const result = startupFailure('PRIVATE_ERROR SQLSTATE ABCDE', null, 'PRIVATE_SIGNAL')
    expect(result.messages).toContain('UNCLASSIFIED')
    expect(result.messages).not.toContain('PRIVATE_')
    expect(result.messages).not.toContain('ABCDE')
  })
  it('reports a known process timeout without relaxing startup failure', () => {
    const result = startupFailure('', null, 'SIGTERM')
    expect(result.messages).toContain('SIGTERM')
    expect(result.process.exitCode).toBe(1)
  })
  it('builds configured function dependencies before starting a fresh CI backend', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')
    expect(workflow.indexOf('run: npm run build:functions')).toBeGreaterThan(-1)
    expect(workflow.indexOf('run: npm run build:functions')).toBeLessThan(workflow.indexOf('run: npm run check:cloud-local -- --start'))
    expect(workflow).not.toContain('--ignore-health-check')
  })
})
