import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TADOKU_GUIDE, TADOKU_LIMIT, TADOKU_URL, materialFromTadokuCatalog, parseTadokuCatalog, tadokuCatalogSchema } from '../src/content/tadoku-catalog'
import { materialSchema } from '../src/db/schema'
import { refreshExternalCatalog } from '../src/server/external-catalog'
import { createContentFetcher, type ContentFetcher } from '../src/server/content-network'
const levels = ['l-start', 'l0', 'l1', 'l2', 'l3', 'l4', 'l5']
const card = (level: string, index: number) => `<div class="freebooks-book-item sample" data-level="${level}">
  <div class="bl-thumb"><a href="https://tadoku.org/japanese/book/${index + 1000}/"><img src="https://not-fetched.example/cover.jpg"></a></div>
  <div class="bl-title"><a href="https://tadoku.org/japanese/book/${index + 1000}/">本 ${index + 1}</a></div></div>`
const html = () => `Free Tadoku Books <a href="${TADOKU_GUIDE}">How to use</a>` + levels.map(card).join('')
const snapshot = () => ({ version: 1 as const, sourceId: 'ja-tadoku' as const, language: 'ja' as const,
  checkedAt: Date.now(), revision: 'a'.repeat(64), entries: parseTadokuCatalog(html()) })

describe('publisher-only Japanese extensive reading catalog', () => {
  it('imports all seven publisher levels without turning books into listening or quiz materials', () => {
    const catalog = tadokuCatalogSchema.parse(snapshot()), materials = materialFromTadokuCatalog(catalog)
    expect(materials).toHaveLength(7)
    for (const material of materials) {
      expect(materialSchema.parse(material)).toEqual(material)
      expect(material.language).toBe('ja'); expect(material.externalStudy).toBeUndefined()
      expect(material.audioPath).toBeUndefined(); expect(material.transcript).toBe('')
      expect(material.question).toBe(''); expect(material.chunks).toEqual([])
      expect(materialSchema.safeParse({ ...material, language: 'en' }).success).toBe(false)
      expect(materialSchema.safeParse({ ...material, transcript: 'Copied publisher story' }).success).toBe(false)
    }
    expect(JSON.stringify(catalog)).not.toContain('not-fetched')
  })
  it('preserves base titles without importing furigana markup or descriptions', () => {
    const entries = parseTadokuCatalog(html().replace('本 1', '<ruby>本<rt>ほん</rt></ruby> &amp; 友だち'))
    expect(entries[0]!.title).toBe('本 & 友だち')
  })
  it.each([
    (text: string) => text.replace('data-level="l0"', 'data-level="l7"'),
    (text: string) => text.replace('book/1001/', 'book/1000/').replace('book/1001/', 'book/1000/'),
    (text: string) => text.replace('data-level="l0"', 'data-level="l0" data-level="l1"'),
    (text: string) => text.replace('Free Tadoku Books', 'Unreviewed collection'),
    (text: string) => text.replaceAll('https://tadoku.org/japanese/book/1000/', 'https://evil.example/book/1000/'),
    (text: string) => text.replace('本 1', '<script>active()</script><iframe src="https://evil.example/">bad</iframe>'),
    (text: string) => text.replace('本 1', '&unknown;'),
    () => 'x'.repeat(TADOKU_LIMIT + 1),
  ])('rejects changed, duplicate, ambiguous or unsafe directory input', alter => {
    expect(() => parseTadokuCatalog(alter(html()))).toThrow()
  })
  it('rejects cross-language snapshots and contradictory book identities', () => {
    expect(tadokuCatalogSchema.safeParse({ ...snapshot(), language: 'en' }).success).toBe(false)
    const catalog = snapshot(); catalog.entries[0]!.id = '9999'
    expect(tadokuCatalogSchema.safeParse(catalog).success).toBe(false)
  })
  it('uses the same bounded metadata capability with its own Japanese source lease', async () => {
    const rpc = vi.fn(async (_name, { action }) => ({ data: action === 'claim' ? { leaseToken: 'lease' } : true, error: null }))
    const fetcher = vi.fn<ContentFetcher>(async () => ({ status: 200, contentType: 'text/html', body: new TextEncoder().encode(html()),
      finalUrl: TADOKU_URL, etag: null, lastModified: null, retryAfter: null, dnsPinning: 'injected' }))
    expect(await refreshExternalCatalog({ rpc } as unknown as SupabaseClient, { sourceId: 'ja-tadoku', fetcher }))
      .toMatchObject({ refreshed: true, lessons: 7, sourceId: 'ja-tadoku' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toMatchObject({ exactUrls: [TADOKU_URL], role: 'page', maxBytes: TADOKU_LIMIT,
      source: { declaredLanguage: 'ja', urls: { audio: [], transcript: [] }, rights: { transcribe: false, redistribute: false } } })
    expect(rpc.mock.calls.map(call => call[1].args.sourceId)).toEqual(['ja-tadoku', 'ja-tadoku'])
  })
  it.runIf(process.env.LIVE_TADOKU_CATALOG === '1')('reads the actual first-party directory with no book/media fetch', async () => {
    let saved: unknown
    const rpc = vi.fn(async (_name, { action, args }) => {
      if (action === 'commit') saved = args.catalog
      return { data: action === 'claim' ? { leaseToken: 'fixture' } : true, error: null }
    })
    await refreshExternalCatalog({ rpc } as unknown as SupabaseClient, { sourceId: 'ja-tadoku', fetcher: createContentFetcher() })
    const catalog = tadokuCatalogSchema.parse(saved)
    expect(catalog.entries.length).toBeGreaterThan(100)
    expect(materialFromTadokuCatalog(catalog).every(material => materialSchema.safeParse(material).success)).toBe(true)
  }, 25000)
})
