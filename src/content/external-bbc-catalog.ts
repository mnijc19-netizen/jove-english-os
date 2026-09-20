import { z } from 'zod'
import { externalMaterial } from './external'
import { parseXml, type XmlNode } from './pipeline'

export const BBC_CATALOG_SOURCE = 'bbc-six-minute'
export const BBC_CATALOG_URL = 'https://podcasts.files.bbci.co.uk/p02pc9tn.rss'
export const BBC_CATALOG_LIMIT = 2 * 1024 * 1024
const year = 365 * 86400_000
const itunes = 'http://www.itunes.com/dtds/podcast-1.0.dtd'
const pagePattern = /^https:\/\/www\.bbc\.co\.uk\/learningenglish\/english\/features\/6-minute-english_20\d{2}\/ep-\d{6}$/u
const timestamp = z.number().int().nonnegative().max(253402300799999)
const entrySchema = z.strictObject({
  id: z.string().regex(/^p[a-z0-9]{7}$/u), url: z.string().regex(pagePattern),
  title: z.string().min(1).max(160).refine(value => !/[<>]/u.test(value) && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)),
  publishedAt: timestamp, duration: z.number().int().min(180).max(600),
})
export const bbcCatalogSchema = z.strictObject({
  version: z.literal(1), sourceId: z.literal(BBC_CATALOG_SOURCE), language: z.literal('en'),
  checkedAt: timestamp, revision: z.string().regex(/^[a-f0-9]{64}$/u), entries: z.array(entrySchema).min(1).max(52),
}).refine(catalog => new Set(catalog.entries.map(e => e.id)).size === catalog.entries.length
  && new Set(catalog.entries.map(e => e.url)).size === catalog.entries.length
  && catalog.entries.every(e => e.publishedAt <= catalog.checkedAt && catalog.checkedAt - e.publishedAt < year))
export type BbcCatalog = z.infer<typeof bbcCatalogSchema>

function one(node: XmlNode, name: string, ns = ''): XmlNode | undefined {
  const values = node.children.filter(child => child.name === name && child.ns === ns)
  if (values.length > 1) throw new Error('CATALOG_AMBIGUOUS')
  return values[0]
}
function field(node: XmlNode, name: string, ns = ''): string {
  const value = one(node, name, ns)
  if (value?.children.length) throw new Error('CATALOG_NESTED_FIELD')
  return value?.text.trim() ?? ''
}

/** Fixed series only. Parse inert publisher metadata; never fetch enclosures or copy descriptions. */
export function parseBbcCatalog(xml: string, now: number): BbcCatalog['entries'] {
  if (new TextEncoder().encode(xml).byteLength > BBC_CATALOG_LIMIT || !Number.isSafeInteger(now) || now <= 0)
    throw new Error('CATALOG_LIMIT')
  const root = parseXml(xml), channel = one(root, 'channel')
  if (root.name !== 'rss' || root.ns || root.attrs.version !== '2.0' || !channel
    || field(channel, 'title') !== '6 Minute English' || field(channel, 'language') !== 'en'
    || field(channel, 'author', itunes) !== 'BBC Radio'
    || field(channel, 'new-feed-url', itunes) !== BBC_CATALOG_URL) throw new Error('CATALOG_SERIES')
  const items = channel.children.filter(child => child.name === 'item' && !child.ns)
  if (items.length > 1000) throw new Error('CATALOG_LIMIT')
  const entries: BbcCatalog['entries'] = [], ids = new Set<string>(), urls = new Set<string>()
  for (const item of items) {
    // Reject ambiguous structure. Unrelated trailers/old episodes are not lessons.
    const title = field(item, 'title'), description = field(item, 'description')
    const guid = /^urn:bbc:podcast:(p[a-z0-9]{7})$/u.exec(field(item, 'guid'))
    const publishedAt = Date.parse(field(item, 'pubDate'))
    if (!guid || !Number.isFinite(publishedAt) || publishedAt > now || now - publishedAt >= year
      || field(item, 'author', itunes) !== 'BBC Radio' || field(item, 'explicit', itunes) !== 'clean') continue
    // Named presenters and an episode-specific learning page bind this to the
    // editorial human-dialogue series, not a synthetic advert or an arbitrary feed link.
    if (!/\b(?:Neil|Georgie|Beth|Phil|Pippa|Rob|Sam|Catherine|Sian)\b/u.test(description)) continue
    const links = [...new Set([...description.matchAll(/href=["'](https:\/\/www\.bbc\.co\.uk\/learningenglish\/english\/features\/6-minute-english_20\d{2}\/ep-\d{6})["']/gu)].map(m => m[1]!))]
    if (links.length !== 1) continue
    const rawDuration = field(item, 'duration', itunes)
    if (!/^(?:\d{3}|[0-9]:[0-5][0-9])$/u.test(rawDuration)) continue
    const duration = rawDuration.split(':').map(Number).reduce((seconds, part) => seconds * 60 + part, 0)
    const parsed = entrySchema.safeParse({ id: guid[1], url: links[0], title, publishedAt, duration })
    if (!parsed.success) continue
    if (ids.has(parsed.data.id) || urls.has(parsed.data.url)) throw new Error('CATALOG_AMBIGUOUS')
    ids.add(parsed.data.id); urls.add(parsed.data.url); entries.push(parsed.data)
  }
  if (!entries.length) throw new Error('CATALOG_EMPTY')
  return entries.sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id)).slice(0, 52)
}

export function materialFromBbcCatalog(value: BbcCatalog) {
  const catalog = bbcCatalogSchema.parse(value)
  return catalog.entries.map(entry => {
    const material = externalMaterial({ id: `${BBC_CATALOG_SOURCE}-${entry.id}`,
      title: `6 Minute English · ${entry.title}`, url: entry.url, publisher: 'BBC Learning English',
      level: 'intermediate', difficulty: 0.72, duration: entry.duration, topic: 'Everyday ideas · human conversation · British English',
      mission: '先在 BBC 原站听真人主持人的一小段对话，不看文字；用中文或简单英语回想主题和一个理由。再核对原站文本，选一个日常表达，换成自己的真实情境录一段英语。听不懂就缩短到 30–60 秒再听。这是英式英语听力扩展，不改变你的美式口语目标；不必模仿英式口音。' })
    return { ...material, createdAt: entry.publishedAt, externalStudy: { ...material.externalStudy!, checkedAt: catalog.checkedAt } }
  })
}
