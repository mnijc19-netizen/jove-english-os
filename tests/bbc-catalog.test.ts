import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BBC_CATALOG_LIMIT, BBC_CATALOG_URL, bbcCatalogSchema, parseBbcCatalog } from '../src/content/external-bbc-catalog'
import { externalCatalogSchema, materialFromExternalCatalog } from '../src/content/external-catalog'
import { externalLessonCandidates, externalMaterials } from '../src/content/external'
import { materialSchema } from '../src/db/schema'
import { makePlan } from '../src/domain/engine'
import { defaultProfile } from '../src/domain/types'
import { refreshExternalCatalog } from '../src/server/external-catalog'
import { createContentFetcher, type ContentFetcher } from '../src/server/content-network'

const now = Date.UTC(2026, 8, 20)
const item = (id = 'p0abcdef', date = 'Thu, 17 Sep 2026 08:34:00 +0000', episode = '260917') => `<item>
  <title>A useful everyday topic</title><description><![CDATA[<p>Georgie and Neil discuss daily life.</p>
  <a href="https://www.bbc.co.uk/learningenglish/english/features/6-minute-english_2026/ep-${episode}">Episode</a>]]></description>
  <guid>urn:bbc:podcast:${id}</guid><pubDate>${date}</pubDate><itunes:duration>381</itunes:duration>
  <itunes:author>BBC Radio</itunes:author><itunes:explicit>clean</itunes:explicit>
  <enclosure url="https://not-allowed.example/audio.mp3" type="audio/mpeg"/></item>`
const feed = (items = item()) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
  <title>6 Minute English</title><language>en</language><itunes:author>BBC Radio</itunes:author>
  <itunes:new-feed-url>${BBC_CATALOG_URL}</itunes:new-feed-url>${items}</channel></rss>`
const snapshot = () => ({ version: 1 as const, sourceId: 'bbc-six-minute' as const, language: 'en' as const,
  checkedAt: now, revision: 'a'.repeat(64), entries: parseBbcCatalog(feed(), now) })

describe('continuing human-series link catalog', () => {
  it('keeps only plain metadata with stable episode identities, never audio, descriptions or answers', () => {
    const catalog = externalCatalogSchema.parse(snapshot()), materials = materialFromExternalCatalog(catalog)
    expect(materials).toHaveLength(1)
    const material = materialSchema.parse(materials[0])
    expect(material.id).toBe('external-bbc-six-minute-p0abcdef')
    expect(material.transcript).toBe(''); expect(material.audioPath).toBeUndefined(); expect(material.authenticPlayback).toBeUndefined()
    expect(material.externalStudy?.mission).toContain('不改变你的美式口语目标')
    expect(JSON.stringify(catalog)).not.toMatch(/enclosure|not-allowed|Georgie/)
    expect(materialFromExternalCatalog({ ...snapshot(), checkedAt: now + 86400_000 })[0]!.id).toBe(material.id)
  })
  it.each([
    (xml: string) => xml.replace('6 Minute English', 'unreviewed show'),
    (xml: string) => xml.replace('<language>en</language>', '<language>ja</language>'),
    (xml: string) => xml.replace('<rss ', '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///private">]><rss '),
    (xml: string) => xml.replace('</title>', '</title><title>Duplicate</title>'),
    (xml: string) => xml.replace('www.bbc.co.uk/learningenglish', 'evil.example/learningenglish'),
    (xml: string) => xml.replace('Georgie and Neil', 'Synthetic host'),
    (xml: string) => xml.replace('>clean<', '>explicit<'),
    (xml: string) => xml.replace('Sep 2026', 'Sep 2027'),
    (xml: string) => xml.replace('381', '900'),
    () => feed(item() + item()),
    () => 'x'.repeat(BBC_CATALOG_LIMIT + 1),
  ])('rejects changed series, ambiguous, unsafe or ineligible input', change => {
    expect(() => parseBbcCatalog(change(feed()), now)).toThrow()
  })
  it('skips trailers/old episodes and rejects stale, cross-language or duplicate snapshots', () => {
    const result = parseBbcCatalog(feed(item() + item('p0abcdeg', 'Thu, 01 Jan 2020 08:34:00 +0000', '200101')), now)
    expect(result).toHaveLength(1)
    for (const catalog of [{ ...snapshot(), language: 'ja' }, { ...snapshot(), entries: [] },
      { ...snapshot(), entries: [...result, ...result] }, { ...snapshot(), checkedAt: now + 366 * 86400_000 }])
      expect(bbcCatalogSchema.safeParse(catalog).success).toBe(false)
  })
  it('expires new assignment without erasing saved material and does not displace the beginner route', () => {
    const materials = materialFromExternalCatalog(snapshot())
    expect(externalLessonCandidates(materials, [], now + 91 * 86400_000)).toEqual([])
    const profile = { ...defaultProfile(), onboarded: true }
    const plan = makePlan(profile, [{ id: 'naturalListening', score: 0.15, confidence: 0.8, evidenceCount: 6, updatedAt: now }],
      [], [], [...externalMaterials, ...materials], undefined, now)
    expect(plan.tasks.find(t => t.kind === 'listen')?.materialId).not.toMatch(/bbc/)
  })
  it('fetches only the exact RSS with separate lease and no paid/audio route', async () => {
    const rpc = vi.fn(async (_name, { action }) => ({ data: action === 'claim' ? { leaseToken: 'lease' } : true, error: null }))
    const fetcher = vi.fn<ContentFetcher>(async () => ({ status: 200, contentType: 'application/rss+xml', body: new TextEncoder().encode(feed()),
      finalUrl: BBC_CATALOG_URL, etag: null, lastModified: null, retryAfter: null, dnsPinning: 'injected' as const }))
    expect(await refreshExternalCatalog({ rpc } as unknown as SupabaseClient, { sourceId: 'bbc-six-minute', fetcher, now: () => now }))
      .toMatchObject({ refreshed: true, lessons: 1, sourceId: 'bbc-six-minute' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toMatchObject({ role: 'feed', exactUrls: [BBC_CATALOG_URL], maxBytes: BBC_CATALOG_LIMIT })
    expect(rpc.mock.calls.map(call => call[1].args.sourceId)).toEqual(['bbc-six-minute', 'bbc-six-minute'])
  })
  it.runIf(process.env.LIVE_BBC_CATALOG === '1')('accepts the actual pinned publisher RSS without fetching any media', async () => {
    let saved: unknown
    const rpc = vi.fn(async (_name, { action, args }) => {
      if (action === 'commit') saved = args.catalog
      return { data: action === 'claim' ? { leaseToken: 'fixture-lease' } : true, error: null }
    })
    await refreshExternalCatalog({ rpc } as unknown as SupabaseClient, { sourceId: 'bbc-six-minute', fetcher: createContentFetcher() })
    const result = externalCatalogSchema.parse(saved)
    expect(result.entries.length).toBeGreaterThan(10)
    expect(materialFromExternalCatalog(result).every(m => materialSchema.safeParse(m).success)).toBe(true)
    console.log(`Publisher feed accepted: ${result.entries.length} metadata-only lesson links; no audio or paid request.`)
  }, 25000)
})
