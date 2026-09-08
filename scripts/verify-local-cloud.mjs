import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const root = realpathSync(resolve(import.meta.dirname, '..'))
const container = 'supabase_db_jove-english-os'
function run(binary, args, label, input) {
  try {
    return execFileSync(binary, args, { cwd: root, encoding: 'utf8', input,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 240000, maxBuffer: 8 * 1024 * 1024 })
  } catch {
    // CLI status and process errors may contain local credentials. Do not echo them.
    throw new Error(`Dedicated local verification failed at ${label}; no credentials or raw process output were printed`)
  }
}
const cli = (args, label) => run(process.execPath, [resolve(root, 'node_modules/supabase/dist/supabase.js'), ...args, '--workdir', root], label)
const sql = (body, label) => run('docker', ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], label, body)

try {
  const config = readFileSync(resolve(root, 'supabase/config.toml'), 'utf8')
  const section = name => config.match(new RegExp(`\\[${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`))?.[1] ?? ''
  if (!/^project_id\s*=\s*"jove-english-os"\s*$/m.test(config)
    || !/^port\s*=\s*55321\s*$/m.test(section('api')) || !/^port\s*=\s*55322\s*$/m.test(section('db'))) {
    throw new Error('Refusing a configuration outside the dedicated Jove local project')
  }
  if (process.argv.includes('--start')) cli(['start'], 'local startup')
  const status = JSON.parse(cli(['status', '--output', 'json'], 'local status'))
  if (status.API_URL !== 'http://127.0.0.1:55321') throw new Error('Refusing a non-Jove-local backend')
  const inspection = JSON.parse(run('docker', ['inspect', '--format', '{{json .}}', container], 'local container identity'))
  if (!inspection.State?.Running || inspection.Config?.Labels?.['com.supabase.cli.project'] !== 'jove-english-os'
    || realpathSync(inspection.Config?.Labels?.['com.supabase.cli.workdir'] ?? '') !== root) throw new Error('Local container identity does not match this workspace')
  if (process.argv.includes('--start')) cli(['migration', 'up', '--local'], 'local migrations')
  const expected = readdirSync(resolve(root, 'supabase/migrations')).filter(file => /^\d+_.+\.sql$/u.test(file)).map(file => file.split('_')[0]).sort()
  const actual = sql('select version from supabase_migrations.schema_migrations order by version;', 'migration readback').trim().split(/\r?\n/u)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Local migration readback does not match the current source set')
  for (const name of ['sync', 'services', 'content', 'speech']) {
    const body = readFileSync(resolve(root, `supabase/tests/${name}.test.sql`), 'utf8')
    if (/^\s*commit\b/imu.test(body)) throw new Error('A local verification fixture may not commit')
    const statements = body.replace(/^\s*(?:begin|rollback);\s*$/gimu, '')
    sql(`BEGIN;\n${statements}\nROLLBACK;`, `${name} transactional assertions`)
    process.stdout.write(`Local ${name} SQL assertions passed; fixture transaction rolled back.\n`)
  }
  process.stdout.write(`Dedicated Jove local backend verified: ${expected.length} migrations, four SQL suites. This is not production acceptance.\n`)
} catch (error) {
  // Only locally authored error messages are emitted; parse errors are sanitized.
  process.stderr.write(error instanceof Error && /^(?:Dedicated|Refusing|Local|A local)/u.test(error.message)
    ? `${error.message}\n` : 'Local verification could not validate the expected response. Raw output withheld.\n')
  process.exitCode = 1
}
