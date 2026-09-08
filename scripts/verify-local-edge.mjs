import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const api = 'http://127.0.0.1:55321'
const routes = ['ai', 'content', 'speech-assess']
function run(file, args = [], env = process.env) {
  execFileSync(process.execPath, [resolve(root, file), ...args], {
    cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 240000,
  })
}
async function ready() {
  return (await Promise.all(routes.map(async route => {
    try {
      const response = await fetch(`${api}/functions/v1/${route}`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(2000),
      })
      // A gateway 401 is not proof that our actual bundled handler loaded.
      return response.status === 401 && (await response.json()).error?.code === 'SIGN_IN'
    } catch { return false }
  }))).every(Boolean)
}

try {
  // Verifies exact project/container/workspace and all migrations before any
  // disposable local Auth/Storage fixtures can be created. No remote target.
  run('scripts/verify-local-cloud.mjs')
  const until = Date.now() + 45000
  let available = await ready()
  while (!available && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 300))
    available = await ready()
  }
  if (!available) throw new Error('not ready')
  process.stdout.write('All three dedicated local Edge handlers are ready and require sign-in.\n')
  run('node_modules/vitest/vitest.mjs', ['run', 'tests/edge-live.test.ts'], { ...process.env, JOVE_LOCAL_EDGE_TEST: '1' })
} catch {
  // Never dump a process error: it can contain CLI output or environment data.
  process.stderr.write('Local Edge verification failed. Start the dedicated Jove functions server and retry; raw process details withheld.\n')
  process.exitCode = 1
}
