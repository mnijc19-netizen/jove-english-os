import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertCloudBuildConfig, withCloudCsp } from '../src/build/cloud-csp'
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
describe('exact-origin account CSP', () => {
  it('preserves the original policy without account configuration', () => {
    expect(withCloudCsp(html, '')).toBe(html)
  })
  it('permits just the configured account HTTPS origin and leaves all other directives unchanged', () => {
    const transformed = withCloudCsp(html, 'https://jove-fixture.supabase.co/')
    expect(transformed).toBe(html.replace("connect-src 'self' https://openrouter.ai;", "connect-src 'self' https://openrouter.ai https://jove-fixture.supabase.co;"))
    expect(transformed).not.toContain('*.supabase.co')
  })
  it('allows the dedicated loopback backend only during explicit local development/testing', () => {
    expect(() => withCloudCsp(html, 'http://127.0.0.1:55321')).toThrow()
    expect(withCloudCsp(html, 'http://127.0.0.1:55321', true)).toContain('https://openrouter.ai http://127.0.0.1:55321;')
    expect(() => withCloudCsp(html, 'http://127.0.0.1:54321', true)).toThrow()
  })
  it.each(['https://name:password@cloud.example.test', 'https://cloud.example.test/path', 'https://cloud.example.test/?a=1',
    'https://cloud.example.test/#fragment', "https://cloud.example.test';script-src *", 'http://public.example.test', 'javascript:alert(1)'])('rejects unsafe or ambiguous configuration %s', value => {
    expect(() => withCloudCsp(html, value, true)).toThrow()
  })
  it('fails closed if the expected CSP baseline changes', () => {
    expect(() => withCloudCsp(html.replace("connect-src 'self'", 'connect-src *'), 'https://cloud.example.test')).toThrow()
  })
})

describe('release public configuration gate', () => {
  const url = 'https://jove-fixture.supabase.co'
  const key = 'sb_publishable_fixture_not_a_real_key'
  const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role })).replace(/=+$/u, '')}.fixture`
  it('keeps local no-account demo builds possible but forbids an unconfigured release', () => {
    expect(() => assertCloudBuildConfig('', '', false)).not.toThrow()
    expect(() => assertCloudBuildConfig('', '', true)).toThrow('requires both')
    expect(() => assertCloudBuildConfig(url, '', false)).toThrow('requires both')
    expect(() => assertCloudBuildConfig('', key, false)).toThrow('requires both')
  })
  it('accepts only public credentials and never includes rejected values in errors', () => {
    expect(() => assertCloudBuildConfig(url, key, true)).not.toThrow()
    expect(() => assertCloudBuildConfig(url, jwt('anon'), true)).not.toThrow()
    for (const value of [jwt('service_role'), jwt('authenticated'), 'sb_secret_fixture_only', 'sb_publishable_', 'malformed']) {
      let error: unknown
      try { assertCloudBuildConfig(url, value, true) } catch (failure) { error = failure }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(value)
    }
  })
  it('does not allow a normal production release to use the local fixture backend', () => {
    expect(() => assertCloudBuildConfig('http://127.0.0.1:55321', key, true)).toThrow()
    expect(() => assertCloudBuildConfig('http://127.0.0.1:55321', key, false, true)).not.toThrow()
  })
})
