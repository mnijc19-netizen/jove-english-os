import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { EXTERNAL_CATALOG_LIMIT, EXTERNAL_CATALOG_URL, externalCatalogSchema, materialFromExternalCatalog, parseExternalCatalogPage } from '../src/content/external-catalog'
import { externalLessonCandidates, externalMaterials } from '../src/content/external'
import { materialSchema } from '../src/db/schema'
import { refreshExternalCatalog } from '../src/server/external-catalog'
import { createContentHandler } from '../src/server/content'
import { createContentFetcher, type ContentFetcher } from '../src/server/content-network'

const now = Date.UTC(2026, 8, 13, 8)
const legacy: Record<number, string> = { 1: 'external-voa-welcome', 3: 'external-voa-im-here', 10: 'external-voa-directions' }
const entries = Array.from({ length: 52 }, (_, i) => ({ position: i + 1,
  url: externalMaterials.find(m => m.id === legacy[i + 1])?.sourceUrl ?? `https://learningenglish.voanews.com/a/lesson-${i + 1}/${9000000 + i}.html` }))
const anchors = entries.map(e => `<a href="${e.url}" title="Lesson ${e.position}: Sample">Course</a>`).join('\n')
const html = `Certified American English teachers; 52 weeks\n${anchors}`
const catalog = { version: 1 as const, sourceId: 'voa-level1' as const, language: 'en' as const, checkedAt: now, revision: 'a'.repeat(64), entries }

describe('bounded publisher course catalog', () => {
  it('extracts all 52 distinct positions and only page metadata', () => {
    expect(parseExternalCatalogPage(html)).toEqual(entries)
    expect(parseExternalCatalogPage(html + '\n' + anchors)).toEqual(entries)
    expect(materialFromExternalCatalog(catalog)).toHaveLength(52)
    for (const item of materialFromExternalCatalog(catalog)) {
      expect(materialSchema.parse(item)).toEqual(item)
      expect(item.transcript).toBe(''); expect(item.sentences).toEqual([])
      expect(item.audioPath).toBeUndefined(); expect(item.authenticPlayback).toBeUndefined()
    }
    expect(JSON.stringify(catalog).length).toBeLessThan(12000)
  })
  it('preserves the three existing VOA identities and rejects rebinding', () => {
    const materials = materialFromExternalCatalog(catalog)
    for (const id of Object.values(legacy)) expect(materials.find(m => m.id === id)?.sourceUrl).toBe(externalMaterials.find(m => m.id === id)?.sourceUrl)
    expect(() => materialFromExternalCatalog({ ...catalog, entries: entries.map((e,i) => i ? e : { ...e, url: 'https://learningenglish.voanews.com/a/changed/123.html' }) })).toThrow('CATALOG_LEGACY_CHANGED')
  })
  it('uses course order for fresh input instead of title, difficulty or string ID order', () => {
    const materials = materialFromExternalCatalog(catalog)
    expect(externalLessonCandidates(materials, [], now).map(m => m.id)).toEqual(['external-voa-welcome'])
    const practised = { id: 'first', type: 'EXTERNAL_LISTEN_REFLECTION', source: 'self-report' as const, sessionId: 'saved', timestamp: now - 1,
      data: { materialId: 'external-voa-welcome', response: 'summary', expression: 'expression', example: 'my example', audioId: 'saved-audio', listened: true, playbackObserved: false, comprehensionVerified: false } }
    expect(externalLessonCandidates(materials, [practised], now).map(m => m.id)).toEqual(['external-voa-level1-2'])
  })
  it.each(['javascript:alert(1)', 'https://evil.example/a/lesson/1.html', '//evil.example/a/lesson/1.html',
    'https://user:pass@learningenglish.voanews.com/a/lesson/1.html', 'https://learningenglish.voanews.com/a/lesson/1.html?next=evil',
    'https://learningenglish.voanews.com/a/lesson/1.mp3'])( 'rejects a changed course target: %s', url => {
    expect(() => parseExternalCatalogPage(html.replace(entries[1]!.url, url))).toThrow()
  })
  it.each([
    html.replace('Lesson 52:', 'Lesson 51:'), html.replace('Lesson 52:', 'Lesson 53:'),
    html.replace(anchors.split('\n').at(-1)!, ''), html.replace('52 weeks', 'one lesson'),
    `Certified American English teachers; 52 weeks<!--${anchors}-->`,
    `Certified American English teachers; 52 weeks<script>${anchors}</script>`,
    html.replaceAll('title=', 'data-title='), html + `<a href="${entries[1]!.url}" title="Lesson 1: Conflict">x</a>`,
  ])('rejects missing/ambiguous/non-content directory markup', value => expect(() => parseExternalCatalogPage(value)).toThrow())
  it('rejects oversized input and malformed snapshots', () => {
    expect(() => parseExternalCatalogPage(html + 'x'.repeat(EXTERNAL_CATALOG_LIMIT))).toThrow()
    expect(externalCatalogSchema.safeParse({ ...catalog, language: 'ja' }).success).toBe(false)
    expect(externalCatalogSchema.safeParse({ ...catalog, entries: entries.slice(0, 51) }).success).toBe(false)
  })
})

function persistence(afterClaim?: () => void) {
  const calls: string[] = [], state: { catalog: unknown; lease: boolean } = { catalog: null, lease: false }
  const admin = { rpc: vi.fn(async (_name: string, { action, args }: { action: string; args: Record<string, unknown> }) => {
    calls.push(action)
    if (action === 'claim') { if (state.lease) return { data: {}, error: null }; state.lease = true; afterClaim?.(); return { data: { leaseToken: 'lease' }, error: null } }
    if (action === 'commit') { state.catalog = args.catalog; state.lease = false; return { data: true, error: null } }
    if (action === 'fail') { state.lease = false; return { data: true, error: null } }
    return { data: state.catalog, error: null }
  }) } as unknown as SupabaseClient
  return { admin, calls, state }
}
const fetched = (text = html) => ({ status: 200, contentType: 'text/html', body: new TextEncoder().encode(text), finalUrl: EXTERNAL_CATALOG_URL,
  etag: null, lastModified: null, retryAfter: null, dnsPinning: 'injected' as const })
describe('independent no-model catalog worker', () => {
  it.each(['before-claim', 'after-claim', 'after-fetch', 'after-digest'])('does not commit when cancelled %s', async point => {
    const controller = new AbortController(), db = persistence(() => { if (point === 'after-claim') controller.abort() })
    if (point === 'before-claim') controller.abort()
    if (point === 'after-digest') {
      const digest = crypto.subtle.digest.bind(crypto.subtle)
      vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
        const result = await digest(...args); controller.abort(); return result
      })
    }
    const fetcher = vi.fn(async () => { if (point === 'after-fetch') controller.abort(); return fetched() })
    await expect(refreshExternalCatalog(db.admin, { fetcher, signal: controller.signal })).rejects.toBeDefined()
    expect(db.calls).not.toContain('commit'); expect(db.state.catalog).toBeNull()
    expect(db.state.lease).toBe(false)
    if (point === 'before-claim') expect(db.calls).toEqual([])
    else expect(db.calls).toEqual(['claim', 'fail'])
    vi.restoreAllMocks()
  })
  it('claims, fetches one bounded page and commits one complete snapshot', async () => {
    const db = persistence(), fetcher = vi.fn<ContentFetcher>(async () => fetched())
    expect(await refreshExternalCatalog(db.admin, { fetcher, now: () => now })).toMatchObject({ refreshed: true, lessons: 52 })
    expect(db.calls).toEqual(['claim', 'commit'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toMatchObject({ role: 'page', exactUrls: [EXTERNAL_CATALOG_URL], maxBytes: EXTERNAL_CATALOG_LIMIT })
  })
  it('preserves the last good snapshot on incomplete replacement without an automatic retry', async () => {
    const db = persistence(); db.state.catalog = catalog
    const fetcher = vi.fn(async () => fetched('incomplete'))
    await expect(refreshExternalCatalog(db.admin, { fetcher })).rejects.toMatchObject({ code: 'EXTERNAL_CATALOG_REFRESH' })
    expect(db.state.catalog).toBe(catalog); expect(db.calls).toEqual(['claim', 'fail']); expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('does not fetch while another job owns the lease', async () => {
    const db = persistence(); db.state.lease = true
    const fetcher = vi.fn(async () => fetched())
    expect(await refreshExternalCatalog(db.admin, { fetcher })).toMatchObject({ refreshed: false })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('dispatches scheduled catalog work without provider, audio or budget access', async () => {
    const db = persistence(), providerFetch = vi.fn(() => { throw new Error('must not call a model') })
    const handler = createContentHandler(() => undefined, { authenticateJob: async () => ({ ownerId: 'owner', admin: db.admin, user: db.admin }),
      catalogFetcher: async () => fetched(), providerFetch, now: () => now })
    const response = await handler(new Request('https://project.example/content', { method: 'POST',
      headers: { 'X-Jove-Content-Job': 'test-only-job', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'catalog-refresh' }) }))
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ lessons: 52 })
    expect(providerFetch).not.toHaveBeenCalled(); expect(db.calls).toEqual(['claim', 'commit'])
  })
  it.runIf(process.env.LIVE_EXTERNAL_CATALOG === '1')('reads the actual pinned publisher directory without media or AI', async () => {
    const db = persistence()
    expect(await refreshExternalCatalog(db.admin, { fetcher: createContentFetcher() })).toMatchObject({ lessons: 52, refreshed: true })
    expect(externalCatalogSchema.parse(db.state.catalog).entries).toHaveLength(52)
  }, 30000)
})
