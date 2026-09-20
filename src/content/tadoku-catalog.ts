import { z } from 'zod'
import type { Material } from '../domain/types'
import { decodeXml } from './pipeline'

export const TADOKU_SOURCE = 'ja-tadoku'
export const TADOKU_URL = 'https://tadoku.org/japanese/en/free-books-en/'
export const TADOKU_GUIDE = 'https://tadoku.org/japanese/en/free-books-en/note-en/'
export const TADOKU_LIMIT = 2 * 1024 * 1024
export const tadokuLevels = ['Start', '0', '1', '2', '3', '4', '5'] as const
export const tadokuLevelSchema = z.enum(tadokuLevels)
export type TadokuLevel = z.infer<typeof tadokuLevelSchema>
const timestamp = z.number().int().nonnegative().max(253402300799999)
export const tadokuBookSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]{0,7}$/u), url: z.string().regex(/^https:\/\/tadoku\.org\/japanese\/book\/[1-9][0-9]{0,7}\/$/u),
  title: z.string().min(1).max(300).refine(value => !/[<>]/u.test(value) && [...value].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)),
  level: tadokuLevelSchema,
}).refine(book => book.url === `https://tadoku.org/japanese/book/${book.id}/`)
export type TadokuBook = z.infer<typeof tadokuBookSchema>
export const tadokuCatalogSchema = z.strictObject({
  version: z.literal(1), sourceId: z.literal(TADOKU_SOURCE), language: z.literal('ja'), checkedAt: timestamp,
  revision: z.string().regex(/^[a-f0-9]{64}$/u), entries: z.array(tadokuBookSchema).min(7).max(500),
}).refine(catalog => new Set(catalog.entries.map(e => e.id)).size === catalog.entries.length
  && new Set(catalog.entries.map(e => e.level)).size === 7)
export type TadokuCatalog = z.infer<typeof tadokuCatalogSchema>

function attribute(tag: string, name: string) {
  const found = [...tag.matchAll(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'gsu'))]
  if (found.length !== 1) throw new Error('TADOKU_ATTRIBUTE')
  return found[0]![2]!
}
/** One publisher directory; retain only titles, publisher levels and canonical links.
 * Never extract books, images, audio, descriptions, tests or translated content. */
export function parseTadokuCatalog(html: string): TadokuBook[] {
  if (new TextEncoder().encode(html).byteLength > TADOKU_LIMIT || !html.includes('Free Tadoku Books') || !html.includes(TADOKU_GUIDE))
    throw new Error('TADOKU_DIRECTORY')
  const inert = html.replace(/<!--[\s\S]*?-->/gu, '').replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
  const cards = [...inert.matchAll(/<div\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/giu)].filter(match => {
    if (match[1]!.length > 32768) throw new Error('TADOKU_LIMIT')
    const classes = [...match[1]!.matchAll(/(?:^|\s)class\s*=\s*(["'])(.*?)\1/gsu)]
    if (!classes.some(value => value[2]!.split(/\s/u).includes('freebooks-book-item'))) return false
    if (classes.length !== 1) throw new Error('TADOKU_ATTRIBUTE')
    return true
  })
  if (cards.length < 7 || cards.length > 500) throw new Error('TADOKU_LIMIT')
  const entries = cards.map((card, index) => {
    const rawLevel = attribute(card[1]!, 'data-level'), level = rawLevel === 'l-start' ? 'Start' : /^l[0-5]$/u.test(rawLevel) ? rawLevel.slice(1) : ''
    const block = inert.slice(card.index! + card[0].length, cards[index + 1]?.index ?? inert.length)
    const titleBlock = /<div\b[^>]*\bclass\s*=\s*["']bl-title["'][^>]*>([\s\S]*?)<\/div\s*>/u.exec(block)?.[1]
    if (!titleBlock || titleBlock.length > 4096) throw new Error('TADOKU_TITLE')
    const links = [...titleBlock.matchAll(/<a\b([^>]{0,2048})>([\s\S]*?)<\/a\s*>/gu)]
    if (links.length !== 1) throw new Error('TADOKU_TITLE')
    const url = attribute(links[0]![1]!, 'href')
    // Preserve the visible base title, not furigana, without ever executing markup.
    const plain = links[0]![2]!.replace(/<(rt|rp)\b[^>]*>[\s\S]*?<\/\1\s*>/gu, '')
      .replace(/<\/?(?:ruby|span)\b[^>]*>/gu, '').replace(/&nbsp;/gu, ' ')
    const title = decodeXml(plain).replace(/\s+/gu, ' ').trim()
    return tadokuBookSchema.parse({ id: /^https:\/\/tadoku\.org\/japanese\/book\/([1-9][0-9]{0,7})\/$/u.exec(url)?.[1], url, title, level })
  })
  return tadokuCatalogSchema.parse({ version: 1, sourceId: TADOKU_SOURCE, language: 'ja', checkedAt: 0, revision: '0'.repeat(64), entries }).entries
}

export function materialFromTadokuBook(book: TadokuBook, checkedAt: number): Material {
  const entry = tadokuBookSchema.parse(book)
  return { id: `ja-tadoku-${entry.id}`, language: 'ja', title: entry.title, topic: '日语轻松多读',
    difficulty: entry.level === 'Start' ? 0.05 : 0.1 + Number(entry.level) * 0.15, duration: 0,
    transcript: '', sentences: [], sourceKind: 'url', sourceUrl: entry.url, sourceLabel: 'NPO 多言語多読 · 原版多读',
    license: 'Attributed link only. Publisher books must not be copied, adapted, translated or turned into tests here.',
    synthetic: false, approved: true, question: '', answer: '', keywords: [], chunks: [], createdAt: timestamp.parse(checkedAt),
    externalReading: { publisher: 'NPO 多言語多読', level: entry.level, checkedAt } }
}
export function materialFromTadokuCatalog(value: TadokuCatalog): Material[] {
  const catalog = tadokuCatalogSchema.parse(value)
  return catalog.entries.map(book => materialFromTadokuBook(book, catalog.checkedAt))
}

// Two already-screened links remain usable when the directory service is offline.
// They are a fallback, not a claim that two books supply a long-term curriculum.
export const tadokuStarterMaterials = () => [
  { id: '6447', title: '何を飲みますか？', level: 'Start' as const },
  { id: '7347', title: 'カラスと水さし', level: '0' as const },
].map(book => materialFromTadokuBook({ ...book, url: `https://tadoku.org/japanese/book/${book.id}/` }, Date.UTC(2026, 8, 20, 4)))
