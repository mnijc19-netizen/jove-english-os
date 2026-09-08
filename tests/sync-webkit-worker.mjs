import { createServer, connect } from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// Invoked through docker exec stdin, never docker --env or a credential file.
// Loopback-only relays target this test's frontend and the dedicated local Jove
// service. They do not transform HTTP, Auth, CSP, Storage or IndexedDB.
let input = ''
for await (const part of process.stdin) input += part
let config
try { config = JSON.parse(input) } catch { throw new Error('Missing local in-memory configuration') }
input = ''
if (config.API_URL !== 'http://127.0.0.1:55321') throw new Error('Non-Jove backend refused')
const relays = []
try {
  for (const port of [55173, 55321, 55324]) {
    const relay = createServer(socket => {
      const remote = connect({ host: 'host.docker.internal', port })
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy())
      socket.pipe(remote); remote.pipe(socket)
    })
    await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(port, '127.0.0.1', resolve) })
    relays.push(relay)
  }
  const child = spawn(process.execPath, ['node_modules/playwright/cli.js', 'test', '--config', 'tests/sync-webkit.config.ts', '--output', '/tmp/jove-sync-webkit-' + randomUUID()], {
    stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, JOVE_LOCAL_BROWSER_TEST: '1', JOVE_SYNC_BROWSERS: 'webkit',
      JOVE_LOCAL_BROWSER_EXTERNAL_APP: '1', JOVE_LOCAL_BROWSER_CONFIG: JSON.stringify(config) },
  })
  config = undefined
  process.exitCode = await new Promise(resolve => child.on('exit', code => resolve(code ?? 1)))
} finally { for (const relay of relays) relay.close() }
