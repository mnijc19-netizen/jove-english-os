import type { SupabaseClient } from '@supabase/supabase-js'
import { EXTERNAL_CATALOG_LIMIT, EXTERNAL_CATALOG_SOURCE, EXTERNAL_CATALOG_URL, externalCatalogSchema,
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
export async function readExternalCatalog(admin: SupabaseClient) {
  const value = await rpc(admin, 'read')
  return { catalog: value ? externalCatalogSchema.parse(value) : null }
}
export async function refreshExternalCatalog(admin: SupabaseClient, options: { fetcher?: ContentFetcher; now?: () => number; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted()
  const claim = await rpc(admin, 'claim')
  if (!claim?.leaseToken) return { refreshed: false, reason: 'not-due-or-running' }
  try {
    options.signal?.throwIfAborted()
    const response = await (options.fetcher ?? createContentFetcher())({ url: EXTERNAL_CATALOG_URL, source, role: 'page',
      maxBytes: EXTERNAL_CATALOG_LIMIT, exactUrls: [EXTERNAL_CATALOG_URL], timeoutMs: 20000, signal: options.signal })
    options.signal?.throwIfAborted()
    if (response.status !== 200 || response.contentType !== 'text/html' || response.finalUrl !== EXTERNAL_CATALOG_URL) throw new Error('CATALOG_FETCH')
    const entries = parseExternalCatalogPage(new TextDecoder('utf-8', { fatal: true }).decode(response.body))
    const catalog = externalCatalogSchema.parse({ version: 1, sourceId: EXTERNAL_CATALOG_SOURCE, language: 'en',
      checkedAt: (options.now ?? Date.now)(), revision: await digestRequest(JSON.stringify(entries)), entries })
    materialFromExternalCatalog(catalog) // Reject legacy ID rebinding before committing.
    options.signal?.throwIfAborted()
    const saved = await rpc(admin, 'commit', { leaseToken: claim.leaseToken, catalog })
    if (saved !== true) throw new Error('CATALOG_LEASE')
    return { refreshed: true, lessons: entries.length, revision: catalog.revision, sourceId: EXTERNAL_CATALOG_SOURCE }
  } catch {
    await rpc(admin, 'fail', { leaseToken: claim.leaseToken })
    throw new GatewayError(503, 'EXTERNAL_CATALOG_REFRESH', 'Course refresh failed. The last good directory and your work are retained.')
  }
}
