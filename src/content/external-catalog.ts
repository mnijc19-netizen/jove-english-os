import { z } from 'zod'
import { externalMaterial, externalMaterials } from './external'
import type { Material } from '../domain/types'
import { bbcCatalogSchema, materialFromBbcCatalog } from './external-bbc-catalog'

export const EXTERNAL_CATALOG_URL = 'https://learningenglish.voanews.com/p/5644.html'
export const EXTERNAL_CATALOG_SOURCE = 'voa-level1'
export const EXTERNAL_CATALOG_LIMIT = 256 * 1024
export const externalCatalogSourceSchema = z.enum(['voa-level1', 'voa-level2', 'bbc-six-minute'])
export type ExternalCatalogSource = z.infer<typeof externalCatalogSourceSchema>
type VoaCatalogSource = Exclude<ExternalCatalogSource, 'bbc-six-minute'>
export const externalCatalogCourses = {
  'voa-level1': { url: EXTERNAL_CATALOG_URL, lessons: 52, marker: '52 weeks', level: 'beginner',
    title: 'Everyday English', difficultyStart: 0.15, difficultySpan: 0.5 },
  'voa-level2': { url: 'https://learningenglish.voanews.com/p/6765.html', lessons: 30, marker: 'intermediate learners', level: 'intermediate',
    title: 'Everyday English · Intermediate', difficultyStart: 0.55, difficultySpan: 0.3 },
} as const
const origin = 'https://learningenglish.voanews.com'
const pagePath = /^\/a\/[a-z0-9-]+\/\d+\.html$/u
const urlSchema = z.string().max(2048).refine(raw => {
  try {
    const url = new URL(raw)
    return raw === url.href && url.origin === origin && !url.username && !url.password && !url.search && !url.hash && pagePath.test(url.pathname)
  } catch { return false }
})
const entriesSchema = (count: number) => z.array(z.strictObject({ position: z.number().int().min(1).max(count), url: urlSchema })).length(count)
  .refine(entries => new Set(entries.map(e => e.position)).size === count && new Set(entries.map(e => e.url)).size === count)
const voaCatalogSchema = z.strictObject({
  version: z.literal(1), sourceId: z.enum(['voa-level1', 'voa-level2']), language: z.literal('en'),
  checkedAt: z.number().int().nonnegative().max(253402300799999), revision: z.string().regex(/^[a-f0-9]{64}$/u),
  entries: z.array(z.strictObject({ position: z.number().int().min(1).max(52), url: urlSchema })).max(52),
}).refine(catalog => entriesSchema(externalCatalogCourses[catalog.sourceId].lessons).safeParse(catalog.entries).success)
export const externalCatalogSchema = z.union([voaCatalogSchema, bbcCatalogSchema])
export type ExternalCatalog = z.infer<typeof externalCatalogSchema>

/** Exact publisher-course adapter. Only numbers and page URLs leave the parser. */
export function parseExternalCatalogPage(html: string, sourceId: VoaCatalogSource = EXTERNAL_CATALOG_SOURCE): z.infer<typeof voaCatalogSchema>['entries'] {
  const course = externalCatalogCourses[z.enum(['voa-level1', 'voa-level2']).parse(sourceId)]
  if (new TextEncoder().encode(html).byteLength > EXTERNAL_CATALOG_LIMIT
    || !html.includes('Certified American English teachers') || !html.includes(course.marker)) throw new Error('CATALOG_FORMAT')
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
  return entriesSchema(course.lessons).parse([...positions].map(([position, url]) => ({ position, url })).sort((a, b) => a.position - b.position))
}

const legacyIds: Record<number, string> = { 1: 'external-voa-welcome', 3: 'external-voa-im-here', 10: 'external-voa-directions' }
export function materialFromExternalCatalog(catalog: ExternalCatalog): Material[] {
  const checked = externalCatalogSchema.parse(catalog)
  if (checked.sourceId === 'bbc-six-minute') return materialFromBbcCatalog(checked)
  const course = externalCatalogCourses[checked.sourceId]
  return checked.entries.map(entry => {
    const legacy = checked.sourceId === EXTERNAL_CATALOG_SOURCE ? externalMaterials.find(m => m.id === legacyIds[entry.position]) : undefined
    if (legacy && legacy.sourceUrl !== entry.url) throw new Error('CATALOG_LEGACY_CHANGED')
    const material = legacy ?? externalMaterial({ id: `${checked.sourceId}-${entry.position}`, title: `${course.title} · Lesson ${entry.position}`,
      url: entry.url, publisher: 'VOA Learning English', level: course.level,
      difficulty: Math.round((course.difficultyStart + (entry.position - 1) * course.difficultySpan / (course.lessons - 1)) * 1000) / 1000, duration: 0,
      topic: `Everyday life · VOA ${course.level} course`,
      mission: checked.sourceId === 'voa-level2'
        ? 'Listen to the main human conversation before reading; skip the animated Professor Bot narration as a speaking model. Recall what each person wants and explain their reasons. Check one useful expression, then record yourself using it to solve a different everyday situation.'
        : 'Open the lesson and listen to its main conversation before reading. Recall what happened, check one useful expression, then record yourself using it in a different everyday situation.' })
    return { ...material, createdAt: checked.checkedAt,
      externalStudy: { ...material.externalStudy!, checkedAt: checked.checkedAt } }
  })
}
