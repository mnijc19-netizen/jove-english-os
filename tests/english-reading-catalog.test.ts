import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ENGLISH_READING_LIMIT, englishReadingCatalogSchema, englishReadingDirectory, englishReadingLevels, materialFromEnglishReadingCatalog, parseEnglishReadingDirectory } from '../src/content/english-reading-catalog'
import { materialSchema } from '../src/db/schema'
import { refreshExternalCatalog } from '../src/server/external-catalog'
import { createContentFetcher, type ContentFetcher } from '../src/server/content-network'
const page = (level: string) => `<h1>${level} reading</h1><h2><a href="/free-resources/reading/${level.toLowerCase()}/our-test">Our test &amp; life</a></h2>
  <img src="https://unfetched.example/image.jpg"><p>Article text must stay out</p><a href="/user/login">Sign in</a>`
const catalog = () => ({ version: 1 as const, sourceId: 'en-bc-reading' as const, language: 'en' as const,
  checkedAt: Date.now(), revision: 'a'.repeat(64), entries: englishReadingLevels.flatMap(l => parseEnglishReadingDirectory(page(l), l)) })
describe('English publisher reading directories', () => {
  it('retains five levels as plain titles and full lesson-page links only', () => {
    const materials = materialFromEnglishReadingCatalog(catalog())
    expect(materials).toHaveLength(5)
    for (const m of materials) {
      expect(materialSchema.parse(m)).toEqual(m)
      expect(m).toMatchObject({ language: 'en', transcript: '', question: '', answer: '', chunks: [], externalReading: { publisher: 'British Council' } })
      expect(m.audioPath).toBeUndefined(); expect(m.externalStudy).toBeUndefined()
      expect(materialSchema.safeParse({ ...m, language: 'ja' }).success).toBe(false)
      expect(materialSchema.safeParse({ ...m, transcript: 'Copied article' }).success).toBe(false)
      expect(materialSchema.safeParse({ ...m, sourceUrl: m.sourceUrl + '?redirect=unsafe' }).success).toBe(false)
    }
    expect(JSON.stringify(materials)).not.toContain('Article text'); expect(JSON.stringify(materials)).not.toContain('unfetched')
  })
  it.each([
    (s: string) => s.replace('/a1/our-test', '/a1/../c1/other'),
    (s: string) => s.replace('href="', 'href="https://evil.example" href="'),
    (s: string) => s.replace('Our test &amp; life', '<iframe>Unsafe</iframe>'),
    (s: string) => s.replace('/a1/our-test', '/a1/our-test?download=1'),
    (s: string) => s.replace('A1 reading', 'A2 reading'),
    (s: string) => s + s,
    () => 'x'.repeat(ENGLISH_READING_LIMIT + 1),
  ])('rejects changed or ambiguous directory structure', change => expect(() => parseEnglishReadingDirectory(change(page('A1')), 'A1')).toThrow())
  it('rejects incomplete, cross-language or rebound catalogs', () => {
    expect(englishReadingCatalogSchema.safeParse({ ...catalog(), entries: catalog().entries.slice(1) }).success).toBe(false)
    expect(englishReadingCatalogSchema.safeParse({ ...catalog(), language: 'ja' }).success).toBe(false)
    const changed = catalog(); changed.entries[0]!.level = 'B1'
    expect(englishReadingCatalogSchema.safeParse(changed).success).toBe(false)
  })
  it('fetches only five pinned directories, then commits one atomic snapshot', async () => {
    const rpc = vi.fn(async (_name, { action }) => ({ data: action === 'claim' ? { leaseToken: 'test' } : true, error: null }))
    const fetcher = vi.fn<ContentFetcher>(async ({ url }) => ({ status: 200, contentType: 'text/html', body: new TextEncoder().encode(page(url.slice(-2).toUpperCase())),
      finalUrl: url, etag: null, lastModified: null, retryAfter: null, dnsPinning: 'injected' }))
    expect(await refreshExternalCatalog({ rpc } as unknown as SupabaseClient, { sourceId: 'en-bc-reading', fetcher })).toMatchObject({ refreshed: true, lessons: 5 })
    expect(fetcher.mock.calls.map(call => call[0].url)).toEqual(englishReadingLevels.map(englishReadingDirectory))
    expect(rpc.mock.calls.map(call => call[1].action)).toEqual(['claim', 'commit'])
    expect(fetcher.mock.calls[0]![0].source.rights).toMatchObject({ transcribe: false, redistribute: false, stream: false })
    fetcher.mockImplementation(async () => { throw new Error('Private upstream diagnostics') })
    await expect(refreshExternalCatalog({ rpc } as unknown as SupabaseClient, { sourceId: 'en-bc-reading', fetcher })).rejects.toThrow('last good directory')
    expect(rpc.mock.calls.slice(-2).map(call => call[1].action)).toEqual(['claim', 'fail'])
  })
  it.runIf(process.env.LIVE_ENGLISH_READING === '1')('reads the real directory only with the production bounded fetcher', async () => {
    let snapshot: unknown
    const rpc = vi.fn(async (_name, { action, args }) => { if (action === 'commit') snapshot = args.catalog; return { data: action === 'claim' ? { leaseToken: 'test' } : true, error: null } })
    await refreshExternalCatalog({ rpc } as unknown as SupabaseClient, { sourceId: 'en-bc-reading', fetcher: createContentFetcher() })
    const parsed = englishReadingCatalogSchema.parse(snapshot)
    expect(parsed.entries.length).toBeGreaterThan(40)
    expect(materialFromEnglishReadingCatalog(parsed).every(m => materialSchema.safeParse(m).success)).toBe(true)
    console.info(JSON.stringify({ sourceId: parsed.sourceId, entries: parsed.entries.length, bytes: JSON.stringify(parsed).length }))
  }, 25000)
})
