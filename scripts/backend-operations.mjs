import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
function run(file, args = [], projectRef) {
  return execFileSync(process.execPath, [resolve(root, file), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(projectRef ? { SUPABASE_PROJECT_ID: projectRef } : {}) },
    timeout: 240000, maxBuffer: 8 * 1024 * 1024,
  })
}
const cli = (args, target) => run('node_modules/supabase/dist/supabase.js', [...args, '--workdir', root], target)
try {
  const [mode, flag, target, ...rest] = process.argv.slice(2)
  if (!['inspect', 'migrate', 'migrations', 'deploy-functions'].includes(mode) || flag !== '--project-ref'
    || !/^[a-z0-9]{20}$/u.test(target ?? '') || rest.length) throw new Error('arguments')
  if (process.env.SUPABASE_PROJECT_ID && process.env.SUPABASE_PROJECT_ID !== target) throw new Error('conflicting target environment')
  // Presence-only checks: do not read or expose possible connection credentials.
  for (const name of ['SUPABASE_DB_URL', 'SUPABASE_API_URL', 'SUPABASE_CLI_BINARY_OVERRIDE']) {
    if (Object.hasOwn(process.env, name)) throw new Error('routing override')
  }
  if (!/^project_id\s*=\s*"jove-english-os"\s*$/mu.test(readFileSync(resolve(root, 'supabase/config.toml'), 'utf8'))) throw new Error('workspace')
  const projects = JSON.parse(cli(['projects', 'list', '--output', 'json'], target))
  if (!Array.isArray(projects)) throw new Error('project metadata')
  const matches = projects.filter(project => project.id === target)
  if (matches.length !== 1 || matches[0].name !== 'jove-english-os' || matches[0].status !== 'ACTIVE_HEALTHY') throw new Error('dedicated target')
  const linkPath = resolve(root, 'supabase/.temp/project-ref')
  const linked = existsSync(linkPath) ? readFileSync(linkPath, 'utf8').trim() : ''
  if (linked && linked !== target) throw new Error('different existing link')
  if (mode === 'migrate' || mode === 'migrations') {
    if (linked !== target) throw new Error('explicit link required')
    // Only audited additive migrations; no reset, seed, config push or other target.
    if (mode === 'migrate') cli(['db', 'push', '--linked', '--project-ref', target, '--skip-vault', '--yes'], target)
    const listing = cli(['migration', 'list', '--linked', '--project-ref', target, '--output', 'json'], target)
    const expected = readdirSync(resolve(root, 'supabase/migrations')).filter(name => /^\d+_.+\.sql$/u.test(name)).map(name => name.split('_')[0]).sort()
    let pairs
    if (listing.trimStart().startsWith('{') || listing.trimStart().startsWith('[')) {
      // Current CLI emits this object, including in automatic agent mode.
      const result = JSON.parse(listing)
      if (!Array.isArray(result.migrations)) throw new Error('migration response')
      pairs = result.migrations.map(row => {
        if (!row || typeof row.local !== 'string' || typeof row.remote !== 'string'
          || !/^\d*$/u.test(row.local) || !/^\d*$/u.test(row.remote)) throw new Error('migration row')
        return [row.local, row.remote]
      })
    } else {
      // Native CLI may print a Markdown table even with -o json; Go releases
      // use bare digits. Only accept balanced backticks around numeric cells.
      pairs = listing.split(/\r?\n/u).map(line => {
        const row = /^\s*(?:`(\d+)`|(\d*))\s*\|\s*(?:`(\d+)`|(\d*))\s*\|/u.exec(line)
        if (!row && (/^\s*(?:`|\d|\|)/u.test(line) || /\|\s*`?\d/u.test(line))) throw new Error('malformed migration row')
        return row ? [row[1] ?? row[2], row[3] ?? row[4]] : null
      }).filter(Boolean)
    }
    const local = pairs.map(row => row[0]).filter(Boolean).sort(), remote = pairs.map(row => row[1]).filter(Boolean).sort()
    if (!expected.length || JSON.stringify(expected) !== JSON.stringify(local) || JSON.stringify(expected) !== JSON.stringify(remote)) throw new Error('migration readback')
    process.stdout.write(`Current local and remote migration versions match (${expected.length}); RLS and owner journeys remain separate checks.\n`)
  }
  if (mode === 'deploy-functions') {
    run('scripts/build-functions.mjs')
    for (const name of ['ai', 'content', 'speech-assess']) cli(['functions', 'deploy', name, '--project-ref', target], target)
    const deployed = JSON.parse(cli(['functions', 'list', '--project-ref', target, '--output', 'json'], target))
    if (!Array.isArray(deployed) || !['ai', 'content', 'speech-assess'].every(name => deployed.some(fn => fn.slug === name && fn.status === 'ACTIVE'))) throw new Error('function readback')
  }
  process.stdout.write(`Dedicated Jove ${mode} command completed for ${target}. Owner/Auth, exact migration/RLS readback, provider quality, scheduler and production journeys are still separate gates.\n`)
} catch {
  process.stderr.write('Jove backend operation refused or failed. Check the explicit healthy Jove target, existing link and authorized CLI access. No credentials or raw CLI output were printed; no other target is selected automatically.\n')
  process.exitCode = 1
}
