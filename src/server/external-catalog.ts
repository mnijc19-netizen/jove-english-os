import type { SupabaseClient } from '@supabase/supabase-js'
import { EXTERNAL_CATALOG_LIMIT, EXTERNAL_CATALOG_SOURCE, EXTERNAL_CATALOG_URL, externalCatalogSchema,
  externalCatalogCourses, externalCatalogSourceSchema, type ExternalCatalogSource,
  materialFromExternalCatalog, parseExternalCatalogPage } from '../content/external-catalog'
import type { ContentSource } from '../content/pipeline-types'
import { createContentFetcher, type ContentFetcher } from './content-network'
import { digestRequest, GatewayError } from './gateway'

// This capability can fetch one HTML directory only: no audio/transcript/model routes.
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
  const course = externalCatalogCourses[sourceId], url = course.url
  const scopedArgs = sourceId === EXTERNAL_CATALOG_SOURCE ? {} : { sourceId }
  const courseSource: ContentSource = { ...source, id: sourceId, name: `VOA ${course.level} course directory`,
    feedUrl: url, homepage: url, notes: [`Official ${course.lessons}-lesson ${course.level} archive; link-only.`],
    rights: { ...source.rights, evidenceUrls: [url] },
    urls: { ...source.urls, page: [{ origin: 'https://learningenglish.voanews.com', pathPrefix: new URL(url).pathname }] } }
  const claim = await rpc(admin, 'claim', scopedArgs)
  if (!claim?.leaseToken) return { refreshed: false, reason: 'not-due-or-running' }
  try {
    options.signal?.throwIfAborted()
    const response = await (options.fetcher ?? createContentFetcher())({ url, source: courseSource, role: 'page',
      maxBytes: EXTERNAL_CATALOG_LIMIT, exactUrls: [url], timeoutMs: 20000, signal: options.signal })
    options.signal?.throwIfAborted()
    if (response.status !== 200 || response.contentType !== 'text/html' || response.finalUrl !== url) throw new Error('CATALOG_FETCH')
    const entries = parseExternalCatalogPage(new TextDecoder('utf-8', { fatal: true }).decode(response.body), sourceId)
    const catalog = externalCatalogSchema.parse({ version: 1, sourceId, language: 'en',
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
