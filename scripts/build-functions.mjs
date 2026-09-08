import { build } from 'esbuild'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')
const result = await build({
  entryPoints: [resolve(root, 'src/server/runtime.ts')],
  outfile: resolve(root, 'supabase/functions/_shared/jove-runtime.js'),
  bundle: true, platform: 'neutral', format: 'esm', target: 'es2022',
  conditions: ['deno', 'import', 'default'], mainFields: ['module', 'main'], external: ['node:*'],
  sourcemap: false, minify: false, metafile: true,
})
const inputs = Object.keys(result.metafile.inputs)
if (inputs.some(path => /src\/(?:pages|stores|cloud)\//.test(path.replaceAll('\\', '/')))) throw new Error('Browser state crossed the server bundle boundary')
const output = await readFile(resolve(root, 'supabase/functions/_shared/jove-runtime.js'), 'utf8')
if (/sb_secret_[A-Za-z0-9_-]{15,}|sk-or-v1-[a-f0-9]{32,}/.test(output)) throw new Error('Unexpected credential-like value in function build')
process.stdout.write(`Server runtime built (${Buffer.byteLength(output)} bytes); browser-state and credential-pattern gates passed.\n`)
