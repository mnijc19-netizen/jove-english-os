import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Execute only the repository's trusted scan script, with in-memory fixture IO.
const source = readFileSync(new URL('../scripts/security-check.mjs', import.meta.url), 'utf8').replace(/^import .+;\r?$/gmu, '')
function scan(file: string, body: string) {
  const read = vi.fn(() => body), messages: string[] = []
  const process = { argv: [], exitCode: 0 }
  vm.runInNewContext(source, { path, Buffer, process,
    execFileSync: () => file + '\0', fs: { existsSync: () => true, readFileSync: read },
    console: { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message) },
  })
  return { code: process.exitCode, message: messages.join('\n'), read }
}
describe('secret scan file coverage and safe reporting', () => {
  it.each(['.env', '.env.production', 'config/.env.local', 'private.pem', 'server.key', 'bundle.p12', 'bundle.pfx'])('rejects %s without reading or printing its contents', file => {
    const result = scan(file, 'private container fixture contents')
    expect(result.code).toBe(1); expect(result.read).not.toHaveBeenCalled()
    expect(result.message).toContain(file)
    expect(result.message).not.toContain('private container fixture contents')
  })
  it.each(['fixture.ts', 'migration.sql', 'app.js.map', '.env.example'])('scans %s and reports only the path/rule', file => {
    const marker = 'sk-' + 'or-v1-' + 'a'.repeat(32)
    const result = scan(file, marker)
    expect(result.code).toBe(1); expect(result.read).toHaveBeenCalledTimes(1)
    expect(result.message).not.toContain(marker)
  })
  it('rejects a privileged JWT while allowing a nonsecret example template', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.fixture'
    expect(scan('fixture.ts', token).code).toBe(1)
    expect(scan('.env.example', 'VITE_SUPABASE_URL=<public-project-url>').code).toBe(0)
  })
})
