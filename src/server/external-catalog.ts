import type { SupabaseClient } from '@supabase/supabase-js'
import { EXTERNAL_CATALOG_LIMIT, EXTERNAL_CATALOG_SOURCE, EXTERNAL_CATALOG_URL, externalCatalogSchema,
  externalCatalogCourses, externalCatalogSourceSchema, type ExternalCatalogSource,
  materialFromExternalCatalog, parseExternalCatalogPage } from '../content/external-catalog'
import type { ContentSource } from '../content/pipeline-types'
import { createContentFetcher, type ContentFetcher } from './content-network'
import { digestRequest, GatewayError } from './gateway'
import { BBC_CATALOG_LIMIT, BBC_CATALOG_URL, parseBbcCatalog } from '../content/external-bbc-catalog'
import { TADOKU_LIMIT, TADOKU_URL, TADOKU_GUIDE, parseTadokuCatalog } from '../content/tadoku-catalog'
import { ENGLISH_READING_LIMIT, englishReadingDirectory, englishReadingLevels, parseEnglishReadingDirectory } from '../content/english-reading-catalog'
import { IRODORI_LIMIT, irodoriCourses, irodoriDirectory, parseIrodoriDirectory } from '../content/irodori-catalog'

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
  if (result.error) {
    // Fixed categories only: upstream messages/details can contain SQL or data.
    // https://docs.postgrest.org/en/stable/references/errors.html
    const raw = result.error.code
    const code = ['PGRST000', 'PGRST001', 'PGRST002'].includes(raw) ? 'EXTERNAL_CATALOG_CONNECTION'
      : ['PGRST003', '53300', '57014'].includes(raw) ? 'EXTERNAL_CATALOG_BUSY'
      : ['PGRST202', 'PGRST205', '42883', '42P01'].includes(raw) ? 'EXTERNAL_CATALOG_SCHEMA'
      : raw === '42501' ? 'EXTERNAL_CATALOG_PERMISSION'
      : raw === '22023' ? 'EXTERNAL_CATALOG_INVALID' : 'EXTERNAL_CATALOG'
    throw new GatewayError(503, code, 'The course directory is temporarily unavailable. Saved practice is unchanged.')
  }
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
  const reading = sourceId === 'en-bc-reading'
  const irodori = sourceId === 'ja-irodori'
  const course = sourceId === 'voa-level1' || sourceId === 'voa-level2' ? externalCatalogCourses[sourceId] : undefined
  const url = course?.url ?? (tadoku ? TADOKU_URL : reading ? englishReadingDirectory('A1') : irodori ? irodoriDirectory('starter') : BBC_CATALOG_URL)
  const scopedArgs = sourceId === EXTERNAL_CATALOG_SOURCE ? {} : { sourceId }
  const publisher = tadoku ? 'NPO 多言語多読' : reading ? 'British Council' : irodori ? '日本国际交流基金 · いろどり' : bbc ? 'BBC Learning English' : source.publisher
  const directories = reading ? englishReadingLevels.map(englishReadingDirectory) : irodori ? irodoriCourses.map(irodoriDirectory) : [url]
  const courseSource: ContentSource = { ...source, id: sourceId, name: tadoku ? 'Free Tadoku Books directory' : reading ? 'British Council graded reading directories' : irodori ? 'Irodori reviewed course directories' : bbc ? 'BBC 6 Minute English episode directory' : `VOA ${course!.level} course directory`,
    feedUrl: url, homepage: url, publisher, declaredLanguage: tadoku || irodori ? 'ja' : 'en', verifiedAt: tadoku || reading || irodori ? Date.UTC(2026, 8, 20, 4) : source.verifiedAt,
    supply: bbc || tadoku ? 'continuing-feed' : source.supply,
    notes: [irodori ? 'Four finite course directories. Only72 existing lesson-page links; directory presence is not a new content or acoustic-quality review.'
      : reading ? 'Five CEFR-labelled directories. Attributed full lesson-page links only, no copied articles, exercises or media. No endorsement.'
      : tadoku ? 'Original publisher books for extensive reading only; no texts, translations, audio or tests.'
      : bbc ? 'Official named-presenter series; British listening extension, not an American pronunciation model.'
      : `Official ${course!.lessons}-lesson ${course!.level} archive; link-only.`],
    rights: { ...source.rights, attribution: publisher, evidenceUrls: reading ? [url, 'https://www.britishcouncil.org/terms'] : tadoku ? [url, TADOKU_GUIDE] : [url] },
    urls: { feed: bbc ? [{ origin: new URL(url).origin, pathPrefix: new URL(url).pathname }] : [],
      page: bbc ? [] : directories.map(page => ({ origin: new URL(page).origin, pathPrefix: new URL(page).pathname })), audio: [], transcript: [] } }
  const claim = await rpc(admin, 'claim', scopedArgs)
  if (!claim?.leaseToken) return { refreshed: false, reason: 'not-due-or-running' }
  try {
    options.signal?.throwIfAborted()
    const fetcher = options.fetcher ?? createContentFetcher()
    async function fetchDirectory(directory: string) {
      const response = await fetcher({ url: directory, source: courseSource, role: bbc ? 'feed' : 'page',
        maxBytes: reading ? ENGLISH_READING_LIMIT : irodori ? IRODORI_LIMIT : tadoku ? TADOKU_LIMIT : bbc ? BBC_CATALOG_LIMIT : EXTERNAL_CATALOG_LIMIT,
        exactUrls: [directory], timeoutMs: 20000, signal: options.signal })
      const contentTypes = bbc ? ['application/rss+xml', 'application/xml', 'text/xml'] : ['text/html']
      if (response.status !== 200 || !contentTypes.includes(response.contentType) || response.finalUrl !== directory) throw new Error('CATALOG_FETCH')
      return new TextDecoder('utf-8', { fatal: true }).decode(response.body)
    }
    // One complete snapshot or retain the previous one: a failed level must not
    // erase its readers or make the remaining levels appear to be the full catalog.
    const pages = await Promise.all(directories.map(fetchDirectory))
    options.signal?.throwIfAborted()
    const text = pages[0]!
    const entries = sourceId === 'ja-irodori' ? pages.flatMap((page, index) => parseIrodoriDirectory(page, irodoriCourses[index]!))
      : sourceId === 'ja-tadoku' ? parseTadokuCatalog(text)
      : sourceId === 'en-bc-reading' ? pages.flatMap((page, index) => parseEnglishReadingDirectory(page, englishReadingLevels[index]!))
      : sourceId === 'bbc-six-minute' ? parseBbcCatalog(text, (options.now ?? Date.now)()) : parseExternalCatalogPage(text, sourceId)
    const catalog = externalCatalogSchema.parse({ version: 1, sourceId, language: tadoku || irodori ? 'ja' : 'en',
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
