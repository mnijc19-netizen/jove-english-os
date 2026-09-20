import { z } from 'zod'
import type { Material } from '../domain/types'
import { decodeXml } from './pipeline'

export const ENGLISH_READING_SOURCE = 'en-bc-reading'
export const ENGLISH_READING_ORIGIN = 'https://learnenglish.britishcouncil.org'
export const englishReadingLevels = ['A1', 'A2', 'B1', 'B2', 'C1'] as const
export const englishReadingLevelSchema = z.enum(englishReadingLevels)
export type EnglishReadingLevel = z.infer<typeof englishReadingLevelSchema>
export const ENGLISH_READING_LIMIT = 256 * 1024
export const englishReadingDirectory = (level: EnglishReadingLevel) => `${ENGLISH_READING_ORIGIN}/free-resources/reading/${englishReadingLevelSchema.parse(level).toLowerCase()}`
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
export const englishReaderSchema = z.strictObject({
  id: z.string().min(1).max(120).regex(slug), level: englishReadingLevelSchema,
  title: z.string().min(1).max(160).refine(value => !/[<>]/u.test(value) && [...value].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)),
  url: z.string().max(300),
}).refine(entry => entry.url === `${englishReadingDirectory(entry.level)}/${entry.id}`)
export type EnglishReader = z.infer<typeof englishReaderSchema>
export const englishReadingCatalogSchema = z.strictObject({
  version: z.literal(1), sourceId: z.literal(ENGLISH_READING_SOURCE), language: z.literal('en'),
  checkedAt: z.number().int().nonnegative().max(253402300799999), revision: z.string().regex(/^[a-f0-9]{64}$/u),
  entries: z.array(englishReaderSchema).min(5).max(500),
}).refine(catalog => new Set(catalog.entries.map(e => `${e.level}:${e.id}`)).size === catalog.entries.length
  && englishReadingLevels.every(level => { const count = catalog.entries.filter(e => e.level === level).length; return count >= 1 && count <= 100 }))

/** Only linked H2 titles from five screened directories. Never article bodies,
 * publisher exercises, images, comments, worksheets or login destinations. */
export function parseEnglishReadingDirectory(html: string, level: EnglishReadingLevel): EnglishReader[] {
  const directory = englishReadingDirectory(level), path = new URL(directory).pathname
  if (new TextEncoder().encode(html).byteLength > ENGLISH_READING_LIMIT || !html.includes(`${level} reading`)) throw new Error('READING_DIRECTORY')
  const inert = html.replace(/<!--[\s\S]*?-->/gu, '').replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
  const entries: EnglishReader[] = []
  for (const h2 of inert.matchAll(/<h2\b[^>]{0,4096}>([\s\S]*?)<\/h2\s*>/giu)) {
    if (h2[1]!.length > 4096) throw new Error('READING_TITLE')
    const links = [...h2[1]!.matchAll(/<a\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/giu)]
    const matching = links.filter(link => link[1]!.includes(path + '/'))
    if (!matching.length) continue
    if (links.length !== 1) throw new Error('READING_TITLE')
    const hrefs = [...matching[0]![1]!.matchAll(/(?:^|\s)href\s*=\s*(["'])(.*?)\1/gsu)]
    if (hrefs.length !== 1) throw new Error('READING_LINK')
    const href = hrefs[0]![2]!, url = href.startsWith(path + '/') ? ENGLISH_READING_ORIGIN + href : href
    const id = url.startsWith(directory + '/') ? url.slice(directory.length + 1) : ''
    const title = decodeXml(matching[0]![2]!.replace(/<\/?(?:span|em|strong)\b[^>]*>/gu, '').replace(/&nbsp;/gu, ' ')).replace(/\s+/gu, ' ').trim()
    entries.push(englishReaderSchema.parse({ id, level, title, url }))
  }
  if (!entries.length || entries.length > 100 || new Set(entries.map(e => e.id)).size !== entries.length) throw new Error('READING_ENTRIES')
  return entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function materialFromEnglishReader(value: EnglishReader, checkedAt: number): Material {
  const entry = englishReaderSchema.parse(value)
  return { id: `en-bc-${entry.level.toLowerCase()}-${entry.id}`, language: 'en', title: entry.title, topic: `English reading · ${entry.level}`,
    difficulty: [0.15, 0.3, 0.5, 0.7, 0.85][englishReadingLevels.indexOf(entry.level)]!, duration: 0,
    sourceKind: 'url', sourceUrl: entry.url, sourceLabel: `British Council LearnEnglish · ${entry.level} reading`,
    license: 'Attributed full lesson-page link only; no copied articles, exercises, worksheets or media. No endorsement implied.',
    transcript: '', sentences: [], question: '', answer: '', keywords: [], chunks: [], synthetic: false, approved: true, createdAt: checkedAt,
    externalReading: { publisher: 'British Council', level: entry.level, checkedAt } }
}
export function materialFromEnglishReadingCatalog(value: z.infer<typeof englishReadingCatalogSchema>): Material[] {
  const catalog = englishReadingCatalogSchema.parse(value)
  return catalog.entries.map(entry => materialFromEnglishReader(entry, catalog.checkedAt))
}
