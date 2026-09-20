import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { IRODORI_LIMIT, irodoriCourses, irodoriDirectory, irodoriCatalogSchema, materialFromIrodoriCatalog, parseIrodoriDirectory, type IrodoriCourse } from '../src/content/irodori-catalog'
import { japaneseMaterials } from '../src/content/japanese'
import { materialSchema } from '../src/db/schema'
import { refreshExternalCatalog } from '../src/server/external-catalog'
import { createContentFetcher, type ContentFetcher } from '../src/server/content-network'
const links = (course: IrodoriCourse) => Array.from({ length: 18 }, (_, i) =>
  `<a href="/en/${course}/audio/lesson${String(i + 1).padStart(2, '0')}.html" class="link">MP3 Play</a>`).join('')
const page = (course: IrodoriCourse) => `<nav>${links(course)}</nav><div id="section_download">${links(course)}</div><p>Uncopied teaching material.</p>`
const catalog = () => ({ version: 1 as const, sourceId: 'ja-irodori' as const, language: 'ja' as const,
  checkedAt: Date.now(), revision: 'f'.repeat(64), entries: irodoriCourses.flatMap(course => parseIrodoriDirectory(page(course), course)) })
describe('finite Japanese course directory maintenance', () => {
  it('keeps existing72 authored lessons, IDs, screening dates and prompts, changing only directory freshness', () => {
    const input = catalog(), materials = materialFromIrodoriCatalog(input), existing = japaneseMaterials()
    expect(materials).toHaveLength(72)
    for (const [index, material] of materials.entries()) {
      expect(materialSchema.parse(material)).toEqual(material)
      expect(material.externalStudy!.directoryCheckedAt).toBe(input.checkedAt)
      expect({ ...material, externalStudy: existing[index]!.externalStudy }).toEqual(existing[index])
      expect(material.transcript).toBe(''); expect(material.audioPath).toBeUndefined()
    }
    expect(JSON.stringify(materials)).not.toContain('Uncopied')
  })
  it.each([
    (s: string) => s.replace('id="section_download"', 'id="other"'),
    (s: string) => s.slice(0, s.indexOf('<div')),
    (s: string) => s.replaceAll('lesson18.html', 'lesson17.html'),
    (s: string) => s.replaceAll('lesson18.html', 'lesson18.html?next=evil'),
    (s: string) => s.replaceAll('lesson18.html', '../audio/lesson18.html'),
    (s: string) => s.replaceAll('href="/en/starter/audio/lesson18.html"', 'href="https://evil.example/lesson18.html"'),
    (s: string) => s.replaceAll('href="/en/starter/audio/lesson18.html"', 'href="/en/starter/audio/lesson18.html" href="https://evil.example"'),
    (s: string) => s.replace('</div>', links('starter') + '</div>'),
    () => 'x'.repeat(IRODORI_LIMIT + 1),
  ])('rejects missing body, malformed or incomplete/rebound lesson directories', mutate => {
    expect(() => parseIrodoriDirectory(mutate(page('starter')), 'starter')).toThrow()
  })
  it('does not accept navigation or script/comment links as missing body lessons', () => {
    const bad = `<nav>${links('starter')}</nav><div id="section_download"><script>${links('starter')}</script><!--${links('starter')}--></div>`
    expect(() => parseIrodoriDirectory(bad, 'starter')).toThrow()
  })
  it('bounds the actual download container, ignoring repeated footer/navigation links', () => {
    const footer = `<footer>${links('starter')}</footer>`
    expect(() => parseIrodoriDirectory('<div id="section_download"></div>' + footer, 'starter')).toThrow()
    expect(parseIrodoriDirectory(page('starter') + footer, 'starter')).toHaveLength(18)
    const nested = `<div id="section_download"><div data-note="</div>"><div>${links('starter')}</div></div></div>${footer}`
    expect(parseIrodoriDirectory(nested, 'starter')).toHaveLength(18)
    const phantom = `<div><div id="section_download"><span data-note="<div>"></span></div>${footer}</div>`
    expect(() => parseIrodoriDirectory(phantom, 'starter')).toThrow()
    const safe = `<div id="section_download"><span data-note="</div>"></span>${links('starter')}</div>${footer}`
    expect(parseIrodoriDirectory(safe, 'starter')).toHaveLength(18)
    expect(() => parseIrodoriDirectory(`<span data-note='<div id="section_download">'></span>${links('starter')}</div>`, 'starter')).toThrow()
    expect(() => parseIrodoriDirectory(`<div data-note='id="section_download"'>${links('starter')}</div>`, 'starter')).toThrow()
  })
  it('rejects partial or duplicate courses and English rebinding', () => {
    expect(irodoriCatalogSchema.safeParse({ ...catalog(), entries: catalog().entries.slice(0, 54) }).success).toBe(false)
    const repeated = catalog(); repeated.entries[71] = repeated.entries[0]!
    expect(irodoriCatalogSchema.safeParse(repeated).success).toBe(false)
    expect(irodoriCatalogSchema.safeParse({ ...catalog(), language: 'en' }).success).toBe(false)
  })
  it('fetches exactly four bounded HTML directories, then commits once; failure preserves the prior catalog', async () => {
    const rpc = vi.fn(async (_name, { action }) => ({ data: action === 'claim' ? { leaseToken: 'test' } : true, error: null }))
    const fetcher = vi.fn<ContentFetcher>(async ({ url }) => ({ status: 200, contentType: 'text/html', finalUrl: url,
      body: new TextEncoder().encode(page(url.split('/')[4] as IrodoriCourse)), etag: null, lastModified: null, retryAfter: null, dnsPinning: 'injected' }))
    expect(await refreshExternalCatalog({ rpc } as unknown as SupabaseClient, { sourceId: 'ja-irodori', fetcher })).toMatchObject({ refreshed: true, lessons: 72 })
    expect(fetcher.mock.calls.map(call => call[0].url)).toEqual(irodoriCourses.map(irodoriDirectory))
    for (const [request] of fetcher.mock.calls) {
      expect(request).toMatchObject({ role: 'page', exactUrls: [request.url], maxBytes: IRODORI_LIMIT })
      expect(request.source.rights).toMatchObject({ transcribe: false, redistribute: false, stream: false })
    }
    expect(rpc.mock.calls.map(call => call[1].action)).toEqual(['claim', 'commit'])
    fetcher.mockImplementation(async () => { throw new Error('private upstream error') })
    await expect(refreshExternalCatalog({ rpc } as unknown as SupabaseClient, { sourceId: 'ja-irodori', fetcher })).rejects.toMatchObject({ code: 'EXTERNAL_CATALOG_REFRESH' })
    expect(rpc.mock.calls.slice(-2).map(call => call[1].action)).toEqual(['claim', 'fail'])
  })
  it.runIf(process.env.LIVE_IRODORI_CATALOG === '1')('checks the real four directories without downloading PDF/audio', async () => {
    let snapshot: unknown
    const rpc = vi.fn(async (_name, { action, args }) => { if (action === 'commit') snapshot = args.catalog; return { data: action === 'claim' ? { leaseToken: 'test' } : true, error: null } })
    await refreshExternalCatalog({ rpc } as unknown as SupabaseClient, { sourceId: 'ja-irodori', fetcher: createContentFetcher() })
    const parsed = irodoriCatalogSchema.parse(snapshot)
    expect(parsed.entries).toHaveLength(72)
    console.info(JSON.stringify({ source: parsed.sourceId, entries: parsed.entries.length, bytes: JSON.stringify(parsed).length }))
  }, 25000)
})
