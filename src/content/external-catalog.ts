import { z } from 'zod'
import { externalMaterial, externalMaterials } from './external'
import type { Material } from '../domain/types'

export const EXTERNAL_CATALOG_URL = 'https://learningenglish.voanews.com/p/5644.html'
export const EXTERNAL_CATALOG_SOURCE = 'voa-level1'
export const EXTERNAL_CATALOG_LIMIT = 256 * 1024
const origin = 'https://learningenglish.voanews.com'
const pagePath = /^\/a\/[a-z0-9-]+\/\d+\.html$/u
const urlSchema = z.string().max(2048).refine(raw => {
  try {
    const url = new URL(raw)
    return raw === url.href && url.origin === origin && !url.username && !url.password && !url.search && !url.hash && pagePath.test(url.pathname)
  } catch { return false }
})
const entriesSchema = z.array(z.strictObject({ position: z.number().int().min(1).max(52), url: urlSchema })).length(52)
  .refine(entries => new Set(entries.map(e => e.position)).size === 52 && new Set(entries.map(e => e.url)).size === 52)
export const externalCatalogSchema = z.strictObject({
  version: z.literal(1), sourceId: z.literal(EXTERNAL_CATALOG_SOURCE), language: z.literal('en'),
  checkedAt: z.number().int().nonnegative().max(253402300799999), revision: z.string().regex(/^[a-f0-9]{64}$/u), entries: entriesSchema,
})
export type ExternalCatalog = z.infer<typeof externalCatalogSchema>

/** Exact publisher-course adapter. Only numbers and page URLs leave the parser. */
export function parseExternalCatalogPage(html: string): ExternalCatalog['entries'] {
  if (new TextEncoder().encode(html).byteLength > EXTERNAL_CATALOG_LIMIT
    || !html.includes('Certified American English teachers') || !html.includes('52 weeks')) throw new Error('CATALOG_FORMAT')
  const inert = html.replace(/<!--[\s\S]*?-->/gu, '').replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
  const positions = new Map<number, string>()
  for (const match of inert.matchAll(/<a\b([^>]{0,4096})>/giu)) {
    const attrs = [...match[1]!.matchAll(/(?:^|\s)(href|title)\s*=\s*(["'])(.*?)\2/giu)]
    const title = attrs.find(a => a[1]!.toLowerCase() === 'title')?.[3] ?? ''
    const lesson = /^Lesson\s+(\d{1,2}):/u.exec(title)
    if (!lesson) continue
    if (attrs.filter(a => a[1]!.toLowerCase() === 'href').length !== 1
      || attrs.filter(a => a[1]!.toLowerCase() === 'title').length !== 1) throw new Error('CATALOG_AMBIGUOUS')
    const href = attrs.find(a => a[1]!.toLowerCase() === 'href')![3]!
    // Do not normalize encoded paths, credentials, query redirects or arbitrary hosts.
    if (!(pagePath.test(href) || href.startsWith(origin + '/a/'))) throw new Error('CATALOG_URL')
    const url = urlSchema.parse(href.startsWith('/') ? origin + href : href), position = Number(lesson[1])
    if (positions.has(position) && positions.get(position) !== url) throw new Error('CATALOG_AMBIGUOUS')
    positions.set(position, url)
  }
  return entriesSchema.parse([...positions].map(([position, url]) => ({ position, url })).sort((a, b) => a.position - b.position))
}

const legacyIds: Record<number, string> = { 1: 'external-voa-welcome', 3: 'external-voa-im-here', 10: 'external-voa-directions' }
export function materialFromExternalCatalog(catalog: ExternalCatalog): Material[] {
  const checked = externalCatalogSchema.parse(catalog)
  return checked.entries.map(entry => {
    const legacy = externalMaterials.find(m => m.id === legacyIds[entry.position])
    if (legacy && legacy.sourceUrl !== entry.url) throw new Error('CATALOG_LEGACY_CHANGED')
    const material = legacy ?? externalMaterial({ id: `voa-level1-${entry.position}`, title: `Everyday English · Lesson ${entry.position}`,
      url: entry.url, publisher: 'VOA Learning English', level: 'beginner',
      difficulty: Math.round((0.15 + (entry.position - 1) / 102) * 1000) / 1000, duration: 0,
      topic: 'Everyday life · VOA beginner course',
      mission: 'Open the lesson and listen to its main conversation before reading. Recall what happened, check one useful expression, then record yourself using it in a different everyday situation.' })
    return { ...material, createdAt: checked.checkedAt,
      externalStudy: { ...material.externalStudy!, checkedAt: checked.checkedAt } }
  })
}
