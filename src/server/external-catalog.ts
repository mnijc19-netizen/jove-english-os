import type { SupabaseClient } from '@supabase/supabase-js'
import { EXTERNAL_CATALOG_LIMIT, EXTERNAL_CATALOG_SOURCE, EXTERNAL_CATALOG_URL, externalCatalogSchema,
  externalCatalogCourses, externalCatalogSourceSchema, type ExternalCatalogSource,
  materialFromExternalCatalog, parseExternalCatalogPage } from '../content/external-catalog'
import type { ContentSource } from '../content/pipeline-types'
import { createContentFetcher, type ContentFetcher } from './content-network'
import { digestRequest, GatewayError } from './gateway'
import { BBC_CATALOG_LIMIT, BBC_CATALOG_URL, parseBbcCatalog } from '../content/external-bbc-catalog'
import { TADOKU_LIMIT, TADOKU_URL, TADOKU_GUIDE, parseTadokuCatalog } from '../content/tadoku-catalog'

// Exact publisher directories only: no audio/transcript/model routes.
const source: ContentSource = {
  id: EXTERNAL_CATALOG_SOURCE, name: 'VOA beginner course directory', enabled: true,
  feedUrl: EXTERNAL_CATALOG_URL, homepage: EXTERNAL_CATALOG_URL, publisher: 'VOA Learning English',
  topics: ['Everyday life'], declaredLanguage: 'en', cadenceHours: 24, verifiedAt: Date.UTC(2026, 8, 13),
  supply: 'archive-supplement', transcriptDiscovery: 'none-stt', examples: [],
  rights: { status: 'uncertain', license: 'unknown', evidenceUrls: [EXTERNAL_CATALOG_URL],
    attribution: 'VOA Learning English', scope: 'Publisher links only; no media or transcript redistribution.',
    stream: false, excerpt: false, transcribe: false, storeAudio: false, redistribute: false, shareAlike: false, recheckAfterDays: 90 },
  urls: { feed: [], page: [{ origin: 'https://learningenglish.voanews.com', pathPrefix: '/p/5644.html' }], audio: [], transcript: [] },
  notes: ['Official 52-lesson beginner sequence; publisher video, not an acoustic certificate.'],
}
async function rpc(admin: SupabaseClient, action: string, args: Record<string, unknown> = {}) {
  const result = await admin.rpc('external_catalog_worker', { action, args })
  if (result.error) throw new GatewayError(503, 'EXTERNAL_CATALOG', 'The course directory is temporarily unavailable. Saved practice is unchanged.')
  return result.data
}
export async function readExternalCatalog(admin: SupabaseClient, sourceId: ExternalCatalogSource = EXTERNAL_CATALOG_SOURCE) {
  externalCatalogSourceSchema.parse(sourceId)
  const value = await rpc(admin, 'read', sourceId === EXTERNAL_CATALOG_SOURCE ? {} : { sourceId })
  const catalog = value ? externalCatalogSchema.parse(value) : null
  if (catalog && catalog.sourceId !== sourceId) throw new GatewayError(503, 'EXTERNAL_CATALOG', 'The requested course directory is unavailable.')
  return { catalog }
}
type CatalogOptions = { fetcher?: ContentFetcher; now?: () => number; signal?: AbortSignal; sourceId?: ExternalCatalogSource }
/** On-use repair also works when an external scheduler is delayed or disabled. */
export async function readOrRefreshExternalCatalog(admin: SupabaseClient, options: CatalogOptions = {}) {
  options.signal?.throwIfAborted()
  const previous = await readExternalCatalog(admin, options.sourceId)
  options.signal?.throwIfAborted()
  if (previous.catalog && (options.now ?? Date.now)() - previous.catalog.checkedAt < 6 * 3600_000) return previous
  try {
    await refreshExternalCatalog(admin, options)
    options.signal?.throwIfAborted()
    const current = await readExternalCatalog(admin, options.sourceId)
    options.signal?.throwIfAborted()
    return current
  } catch (error) {
    options.signal?.throwIfAborted()
    if (previous.catalog) return previous
    throw error
  }
}
export async function refreshExternalCatalog(admin: SupabaseClient, options: CatalogOptions = {}) {
  options.signal?.throwIfAborted()
  const sourceId = externalCatalogSourceSchema.parse(options.sourceId ?? EXTERNAL_CATALOG_SOURCE)
  const bbc = sourceId === 'bbc-six-minute'
  const tadoku = sourceId === 'ja-tadoku'
  const course = sourceId === 'voa-level1' || sourceId === 'voa-level2' ? externalCatalogCourses[sourceId] : undefined
  const url = course?.url ?? (tadoku ? TADOKU_URL : BBC_CATALOG_URL)
  const scopedArgs = sourceId === EXTERNAL_CATALOG_SOURCE ? {} : { sourceId }
  const publisher = tadoku ? 'NPO 多言語多読' : bbc ? 'BBC Learning English' : source.publisher
  const courseSource: ContentSource = { ...source, id: sourceId, name: tadoku ? 'Free Tadoku Books directory' : bbc ? 'BBC 6 Minute English episode directory' : `VOA ${course!.level} course directory`,
    feedUrl: url, homepage: url, publisher, declaredLanguage: tadoku ? 'ja' : 'en', verifiedAt: tadoku ? Date.UTC(2026, 8, 20, 4) : source.verifiedAt,
    supply: bbc || tadoku ? 'continuing-feed' : source.supply,
    notes: [tadoku ? 'Original publisher books for extensive reading only; no texts, translations, audio or tests.'
      : bbc ? 'Official named-presenter series; British listening extension, not an American pronunciation model.'
      : `Official ${course!.lessons}-lesson ${course!.level} archive; link-only.`],
    rights: { ...source.rights, attribution: publisher, evidenceUrls: tadoku ? [url, TADOKU_GUIDE] : [url] },
    urls: { feed: bbc ? [{ origin: new URL(url).origin, pathPrefix: new URL(url).pathname }] : [],
      page: bbc ? [] : [{ origin: new URL(url).origin, pathPrefix: new URL(url).pathname }], audio: [], transcript: [] } }
  const claim = await rpc(admin, 'claim', scopedArgs)
  if (!claim?.leaseToken) return { refreshed: false, reason: 'not-due-or-running' }
  try {
    options.signal?.throwIfAborted()
    const response = await (options.fetcher ?? createContentFetcher())({ url, source: courseSource, role: bbc ? 'feed' : 'page',
      maxBytes: tadoku ? TADOKU_LIMIT : bbc ? BBC_CATALOG_LIMIT : EXTERNAL_CATALOG_LIMIT, exactUrls: [url], timeoutMs: 20000, signal: options.signal })
    options.signal?.throwIfAborted()
    const contentTypes = bbc ? ['application/rss+xml', 'application/xml', 'text/xml'] : ['text/html']
    if (response.status !== 200 || !contentTypes.includes(response.contentType) || response.finalUrl !== url) throw new Error('CATALOG_FETCH')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body)
    const entries = sourceId === 'ja-tadoku' ? parseTadokuCatalog(text)
      : sourceId === 'bbc-six-minute' ? parseBbcCatalog(text, (options.now ?? Date.now)()) : parseExternalCatalogPage(text, sourceId)
    const catalog = externalCatalogSchema.parse({ version: 1, sourceId, language: tadoku ? 'ja' : 'en',
      checkedAt: (options.now ?? Date.now)(), revision: await digestRequest(JSON.stringify(entries)), entries })
    materialFromExternalCatalog(catalog) // Reject legacy ID rebinding before committing.
    options.signal?.throwIfAborted()
    const saved = await rpc(admin, 'commit', { ...scopedArgs, leaseToken: claim.leaseToken, catalog })
    if (saved !== true) throw new Error('CATALOG_LEASE')
    return { refreshed: true, lessons: entries.length, revision: catalog.revision, sourceId }
  } catch {
    await rpc(admin, 'fail', { ...scopedArgs, leaseToken: claim.leaseToken })
    throw new GatewayError(503, 'EXTERNAL_CATALOG_REFRESH', 'Course refresh failed. The last good directory and your work are retained.')
  }
}
