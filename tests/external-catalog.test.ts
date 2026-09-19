import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { EXTERNAL_CATALOG_LIMIT, EXTERNAL_CATALOG_URL, externalCatalogSchema, materialFromExternalCatalog, parseExternalCatalogPage } from '../src/content/external-catalog'
import { externalLessonCandidates, externalMaterials } from '../src/content/external'
import { materialSchema } from '../src/db/schema'
import { readOrRefreshExternalCatalog, refreshExternalCatalog } from '../src/server/external-catalog'
import { catalogJobAdmin, createContentHandler } from '../src/server/content'
import { createContentFetcher, type ContentFetcher } from '../src/server/content-network'
import { aggregateSkills, makePlan } from '../src/domain/engine'
import { defaultProfile, type Skill, type StudyEvent } from '../src/domain/types'

const now = Date.UTC(2026, 8, 13, 8)
const legacy: Record<number, string> = { 1: 'external-voa-welcome', 3: 'external-voa-im-here', 10: 'external-voa-directions' }
const entries = Array.from({ length: 52 }, (_, i) => ({ position: i + 1,
  url: externalMaterials.find(m => m.id === legacy[i + 1])?.sourceUrl ?? `https://learningenglish.voanews.com/a/lesson-${i + 1}/${9000000 + i}.html` }))
const anchors = entries.map(e => `<a href="${e.url}" title="Lesson ${e.position}: Sample">Course</a>`).join('\n')
const html = `Certified American English teachers; 52 weeks\n${anchors}`
const catalog = { version: 1 as const, sourceId: 'voa-level1' as const, language: 'en' as const, checkedAt: now, revision: 'a'.repeat(64), entries }
const intermediateEntries = Array.from({ length: 30 }, (_, i) => ({ position: i + 1,
  url: `https://learningenglish.voanews.com/a/lets-learn-english-level-2-lesson-${i + 1}/${9100000 + i}.html` }))
const intermediateHtml = `Certified American English teachers; intermediate learners\n${intermediateEntries
  .map(e => `<a href="${e.url}" title="Lesson ${e.position}: Sample">Course</a>`).join('\n')}`
const intermediateCatalog = { ...catalog, sourceId: 'voa-level2' as const, entries: intermediateEntries }

describe('bounded publisher course catalog', () => {
  it('accepts the separate 30-lesson intermediate course without rebinding beginner identities', () => {
    expect(parseExternalCatalogPage(intermediateHtml, 'voa-level2')).toEqual(intermediateEntries)
    const materials = materialFromExternalCatalog(intermediateCatalog)
    expect(materials).toHaveLength(30)
    const beginnerIds = new Set(materialFromExternalCatalog(catalog).map(m => m.id))
    for (const item of materials) {
      expect(materialSchema.parse(item)).toEqual(item)
      expect(beginnerIds.has(item.id)).toBe(false)
      expect(item.externalStudy?.level).toBe('intermediate')
      expect(item.difficulty).toBeGreaterThanOrEqual(0.55)
      expect(item.difficulty).toBeLessThanOrEqual(0.85)
      expect(item.audioPath).toBeUndefined(); expect(item.transcript).toBe('')
    }
  })
  it('fails closed on swapped, incomplete and ambiguous intermediate directories', () => {
    expect(() => parseExternalCatalogPage(html, 'voa-level2')).toThrow()
    expect(() => parseExternalCatalogPage(intermediateHtml)).toThrow()
    expect(() => parseExternalCatalogPage(intermediateHtml.replace('Lesson 30:', 'Lesson 31:'), 'voa-level2')).toThrow()
    expect(externalCatalogSchema.safeParse({ ...intermediateCatalog, entries }).success).toBe(false)
    expect(externalCatalogSchema.safeParse({ ...catalog, entries: intermediateEntries }).success).toBe(false)
    expect(externalCatalogSchema.safeParse({ ...intermediateCatalog, sourceId: 'arbitrary' }).success).toBe(false)
  })
  it('keeps course positions independent and expires both catalog-only reserves', () => {
    const beginner = materialFromExternalCatalog(catalog), intermediate = materialFromExternalCatalog(intermediateCatalog)
    expect(externalLessonCandidates([...beginner, ...intermediate], [], now).map(m => m.id))
      .toEqual(['external-voa-welcome', 'external-voa-level2-1'])
    expect(externalLessonCandidates(intermediate, [], now + 91 * 86400000)).toEqual([])
    expect(externalLessonCandidates(intermediate.slice(0, 2), [{ id: 'practice', type: 'EXTERNAL_LISTEN_REFLECTION',
      source: 'self-report', sessionId: 'saved', timestamp: now - 1, data: { materialId: intermediate[0]!.id,
        response: 'summary', expression: 'expression', example: 'my example', audioId: 'audio', listened: true,
        playbackObserved: false, comprehensionVerified: false } }], now).map(m => m.id)).toEqual(['external-voa-level2-2'])
  })
  it('plans by observed ability rather than promoting a learner from beginner participation alone', () => {
    const materials = [...materialFromExternalCatalog(catalog), ...materialFromExternalCatalog(intermediateCatalog)]
    const profile = { ...defaultProfile(), createdAt: now - 86400000, onboarded: true }
    const evidence = (score: number): Skill[] => [{ id: 'naturalListening', score, confidence: 0.8, evidenceCount: 6, updatedAt: now }]
    const history: StudyEvent[] = materials.filter(m => m.externalStudy?.level === 'beginner').map((m, i) => ({
      id: `reflection-${i}`, type: 'EXTERNAL_LISTEN_REFLECTION', sessionId: `practice-${i}`, timestamp: now - 1000 - i,
      source: 'self-report', data: { materialId: m.id, response: 'summary', expression: 'expression', example: 'my example',
        audioId: `audio-${i}`, listened: true, playbackObserved: false, comprehensionVerified: false } }))
    const lowPlan = makePlan(profile, evidence(0.15), [], history, materials, undefined, now)
    expect(lowPlan.tasks.find(task => task.kind === 'listen')?.materialId).not.toMatch(/^external-voa-level2-/u)
    expect(aggregateSkills(history).every(skill => skill.evidenceCount === 0)).toBe(true)
    const higherPlan = makePlan(profile, evidence(0.65), [], [], materials, undefined, now)
    expect(higherPlan.tasks.find(task => task.kind === 'listen')?.materialId).toBe('external-voa-level2-1')
    const bound = makePlan(profile, evidence(0.65), [], history, materials, lowPlan, now)
    expect(bound.tasks.find(task => task.kind === 'listen')?.materialId).toBe(lowPlan.tasks.find(task => task.kind === 'listen')?.materialId)
  })
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
  it('binds intermediate source to every RPC and only its exact publisher directory', async () => {
    const db = persistence(), fetcher = vi.fn<ContentFetcher>(async () => ({ ...fetched(intermediateHtml),
      finalUrl: 'https://learningenglish.voanews.com/p/6765.html' }))
    const handler = createContentHandler(() => undefined, { authenticateCatalogJob: async () => db.admin, catalogFetcher: fetcher, now: () => now })
    const response = await handler(new Request('https://project.example/content', { method: 'POST',
      headers: { 'X-Jove-Catalog-Job': 'fixture-only' }, body: '{"action":"catalog-refresh","sourceId":"voa-level2"}' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sourceId: 'voa-level2', lessons: 30, refreshed: true })
    expect(fetcher.mock.calls[0]?.[0]).toMatchObject({ url: 'https://learningenglish.voanews.com/p/6765.html',
      exactUrls: ['https://learningenglish.voanews.com/p/6765.html'], source: { id: 'voa-level2' } })
    for (const call of vi.mocked(db.admin.rpc).mock.calls) expect(call[1]).toMatchObject({ args: { sourceId: 'voa-level2' } })
  })
  it('rejects cross-course readback rather than advancing the wrong reserve', async () => {
    const db = persistence(); db.state.catalog = catalog
    await expect(readOrRefreshExternalCatalog(db.admin, { sourceId: 'voa-level2', now: () => now }))
      .rejects.toMatchObject({ code: 'EXTERNAL_CATALOG' })
    expect(db.calls).toEqual(['read'])
  })
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
  it('serves a fresh directory without contacting its publisher', async () => {
    const db = persistence(); db.state.catalog = catalog
    const fetcher = vi.fn(async () => fetched())
    expect(await readOrRefreshExternalCatalog(db.admin, { fetcher, now: () => now })).toEqual({ catalog })
    expect(db.calls).toEqual(['read']); expect(fetcher).not.toHaveBeenCalled()
  })
  it('repairs an old directory on use without relying on the scheduler', async () => {
    const db = persistence(); db.state.catalog = catalog
    const later = now + 6 * 3600_000
    const result = await readOrRefreshExternalCatalog(db.admin, { fetcher: async () => fetched(), now: () => later })
    expect(result.catalog?.checkedAt).toBe(later)
    expect(db.calls).toEqual(['read', 'claim', 'commit', 'read'])
  })
  it('retains a readable reserve on publisher failure instead of deleting courses', async () => {
    const db = persistence(); db.state.catalog = catalog
    expect(await readOrRefreshExternalCatalog(db.admin, { fetcher: async () => fetched('incomplete'), now: () => now + 7 * 3600_000 }))
      .toEqual({ catalog })
    expect(db.calls).toEqual(['read', 'claim', 'fail'])
  })
  it('does not hide a failed initial refresh behind an empty success', async () => {
    const db = persistence()
    await expect(readOrRefreshExternalCatalog(db.admin, { fetcher: async () => fetched('incomplete') }))
      .rejects.toMatchObject({ code: 'EXTERNAL_CATALOG_REFRESH' })
  })
  it('honors cancellation before even reading the directory', async () => {
    const db = persistence(), controller = new AbortController(); controller.abort()
    await expect(readOrRefreshExternalCatalog(db.admin, { signal: controller.signal })).rejects.toBeDefined()
    expect(db.calls).toEqual([])
  })
  it('uses separate directory authority without looking up an owner or invoking paid work', async () => {
    const db = persistence(), denied = vi.fn(() => { throw new Error('Unrelated authority must not run') })
    const handler = createContentHandler(() => undefined, { authenticate: denied, authenticateJob: denied,
      authenticateCatalogJob: async () => db.admin, catalogFetcher: async () => fetched(), providerFetch: denied, now: () => now })
    const response = await handler(new Request('https://project.example/content', { method: 'POST',
      headers: { 'X-Jove-Catalog-Job': 'fixture-only' }, body: '{"action":"catalog-refresh"}' }))
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ lessons: 52 })
    expect(db.calls).toEqual(['claim', 'commit']); expect(denied).not.toHaveBeenCalled()
  })
  it.each(['{}', '{"action":"refresh"}', '{"action":"provider-status"}', '{"action":"lessons"}',
    '{"action":"catalog-refresh","sourceId":"unknown"}', '{"action":"catalog-refresh","sourceId":null}',
    '{"action":"external-catalog"}', '{"action":"catalog-refresh","ownerId":"another-owner"}'])('rejects action escalation with directory authority: %s', body => {
    const db = persistence()
    const handler = createContentHandler(() => undefined, { authenticateCatalogJob: async () => db.admin })
    return handler(new Request('https://project.example/content', { method: 'POST', headers: { 'X-Jove-Catalog-Job': 'fixture-only' }, body }))
      .then(response => { expect(response.status).toBe(400); expect(db.calls).toEqual([]) })
  })
  it.each(['Origin', 'Authorization', 'X-Jove-Content-Job'])('rejects mixed authority: %s', async header => {
    const auth = vi.fn(), handler = createContentHandler(() => undefined, { authenticateCatalogJob: auth })
    const response = await handler(new Request('https://project.example/content', { method: 'POST',
      headers: { 'X-Jove-Catalog-Job': 'fixture-only', [header]: header === 'Origin' ? 'https://mnijc19-netizen.github.io' : 'fixture-only' }, body: '{"action":"catalog-refresh"}' }))
    expect(response.status).toBe(403); expect(auth).not.toHaveBeenCalled()
  })
  it('checks the real directory credential before constructing an elevated client', async () => {
    const seen: string[] = [], credential = 'd'.repeat(64)
    const env = (name: string) => { seen.push(name); return ({ JOVE_CATALOG_JOB_TOKEN: credential,
      SUPABASE_URL: 'https://project.example', SUPABASE_SERVICE_ROLE_KEY: 'fixture-server-key' } as Record<string, string>)[name] }
    await expect(catalogJobAdmin(new Request('https://project.example/content', { headers: { 'X-Jove-Catalog-Job': 'e'.repeat(64) } }), env))
      .rejects.toMatchObject({ code: 'CATALOG_JOB_AUTH' })
    expect(seen).toEqual(['JOVE_CATALOG_JOB_TOKEN'])
    await expect(catalogJobAdmin(new Request('https://project.example/content', { headers: { 'X-Jove-Catalog-Job': credential } }), env)).resolves.toBeDefined()
  })
  it.runIf(process.env.LIVE_EXTERNAL_CATALOG === '1').each(['voa-level1', 'voa-level2'] as const)('reads the actual pinned %s publisher directory without media or AI', async sourceId => {
    const db = persistence()
    const lessons = sourceId === 'voa-level1' ? 52 : 30
    expect(await refreshExternalCatalog(db.admin, { fetcher: createContentFetcher(), sourceId })).toMatchObject({ lessons, refreshed: true, sourceId })
    expect(externalCatalogSchema.parse(db.state.catalog).entries).toHaveLength(lessons)
  }, 30000)
})
