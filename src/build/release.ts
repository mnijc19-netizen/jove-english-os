import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Plugin } from 'vite'

/** Only public source/build identity; never serialize process.env or cloud keys. */
export function releaseMetadata(cwd = process.cwd()) {
  let revision: string | null = null, dirty = true
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true }).trim()
    if (/^[a-f0-9]{40}$/u.test(head)) revision = head
    dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd, encoding: 'utf8', windowsHide: true }).trim()
  } catch { /* A source archive remains explicitly unversioned, not a release claim. */ }
  return { schema: 1 as const, buildId: `${revision?.slice(0, 7) ?? 'local'}-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    revision, dirty, builtAt: new Date().toISOString() }
}

export function releaseManifest(metadata: ReturnType<typeof releaseMetadata>): Plugin {
  return { name: 'jove-release-manifest', generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'release.json', source: JSON.stringify(metadata) })
  } }
}
