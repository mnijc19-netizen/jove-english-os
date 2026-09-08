import { execFileSync, spawn } from 'node:child_process'

// Reuses the existing Jove browser worker container. No installation, global
// settings, migration, production backend, credential artifact or trace.
let config
try {
  config = JSON.parse(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx supabase status --output json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }))
} catch { throw new Error('Could not obtain dedicated local Jove configuration') }
if (config.API_URL !== 'http://127.0.0.1:55321') throw new Error('Non-Jove backend refused')
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--port', '55173', '--strictPort'], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: config.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: config.ANON_KEY },
})
try {
  for (let retry = 0; retry < 100; retry++) {
    if (server.exitCode !== null) throw new Error('Isolated native browser dev server could not start')
    try { if ((await fetch('http://127.0.0.1:55173/jove-english-os/', { signal: AbortSignal.timeout(500) })).ok) break } catch { /* startup */ }
    if (retry === 99) throw new Error('Native browser dev server did not become ready')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const child = spawn('docker', ['exec', '-i', 'jove-webkit-sidecar-20260908', 'node', 'tests/sync-webkit-worker.mjs'], { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] })
  child.stdin.end(JSON.stringify({ API_URL: config.API_URL, ANON_KEY: config.ANON_KEY, SERVICE_ROLE_KEY: config.SERVICE_ROLE_KEY }))
  config = undefined
  process.exitCode = await new Promise(resolve => child.on('exit', code => resolve(code ?? 1)))
} finally { server.kill() }
