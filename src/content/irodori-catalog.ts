import { z } from 'zod'
import { japaneseMaterials } from './japanese'
import type { Material } from '../domain/types'

export const IRODORI_ORIGIN = 'https://www.irodori.jpf.go.jp'
export const IRODORI_LIMIT = 256 * 1024
export const irodoriCourses = ['starter', 'elementary01', 'elementary02', 'pre-intermediate'] as const
const courseSchema = z.enum(irodoriCourses)
export type IrodoriCourse = z.infer<typeof courseSchema>
export const irodoriDirectory = (course: IrodoriCourse) => `${IRODORI_ORIGIN}/en/${courseSchema.parse(course)}/pdf.html`
const lessonUrl = (course: IrodoriCourse, position: number) => `${IRODORI_ORIGIN}/en/${course}/audio/lesson${String(position).padStart(2, '0')}.html`
const entrySchema = z.strictObject({ course: courseSchema, position: z.number().int().min(1).max(18), url: z.string().max(160) })
  .refine(entry => entry.url === lessonUrl(entry.course, entry.position))
export const irodoriCatalogSchema = z.strictObject({
  version: z.literal(1), sourceId: z.literal('ja-irodori'), language: z.literal('ja'),
  checkedAt: z.number().int().nonnegative().max(253402300799999), revision: z.string().regex(/^[a-f0-9]{64}$/u),
  entries: z.array(entrySchema).length(72).refine(entries => new Set(entries.map(entry => entry.url)).size === 72),
})

function attributes(raw: string): Map<string, string> {
  if (raw.length > 4096) throw new Error('IRODORI_LINK')
  const values = new Map<string, string>()
  // Consume every complete attribute, including unrelated quoted values. A
  // string such as data-note='id="section_download"' is not an actual id.
  for (const attribute of raw.matchAll(/\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
    const name = attribute[1]!.toLowerCase()
    if (!['id', 'class', 'href'].includes(name)) continue
    if (values.has(name)) throw new Error('IRODORI_LINK')
    values.set(name, attribute[2] ?? attribute[3] ?? attribute[4] ?? '')
  }
  return values
}

/** Only known per-lesson HTML playback links from the lesson download section.
 * Navigation alone is not a valid catalog. No PDFs, transcripts or media fetched. */
export function parseIrodoriDirectory(html: string, course: IrodoriCourse): z.infer<typeof entrySchema>[] {
  courseSchema.parse(course)
  if (new TextEncoder().encode(html).byteLength > IRODORI_LIMIT) throw new Error('IRODORI_LIMIT')
  const inert = html.replace(/<!--[\s\S]*?-->/gu, '').replace(/<(script|style|noscript|template|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
  const entries: z.infer<typeof entrySchema>[] = []
  let depth = 0, closed = false
  // Tokenize all tags so div-looking text inside a span/a attribute cannot
  // open or close the directory container. All output remains plain metadata.
  for (const tag of inert.matchAll(/<(\/?)([a-z][a-z0-9:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/giu)) {
    const closing = tag[1] === '/', name = tag[2]!.toLowerCase(), attrs = closing ? new Map<string, string>() : attributes(tag[3]!)
    if (!depth) {
      if (!closing && name === 'div' && attrs.get('id') === 'section_download') depth = 1
      continue
    }
    if (name === 'div') {
      depth += closing ? -1 : 1
      if (!depth) { closed = true; break }
    }
    if (closing || name !== 'a' || !attrs.get('class')?.split(/\s/u).includes('link')) continue
    const href = attrs.get('href') ?? '', prefix = `/en/${course}/audio/lesson`
    const url = href.startsWith(prefix) ? IRODORI_ORIGIN + href : href
    if (!url.startsWith(IRODORI_ORIGIN + prefix)) continue
    const suffix = url.slice((IRODORI_ORIGIN + prefix).length)
    if (course === 'starter' && suffix === '00.html') continue // optional classroom prelude, not one of18 lessons
    if (!/^(0[1-9]|1[0-8])\.html$/u.test(suffix)) throw new Error('IRODORI_LESSON')
    entries.push(entrySchema.parse({ course, position: Number(suffix.slice(0, 2)), url }))
  }
  if (!closed || entries.length !== 18 || new Set(entries.map(entry => entry.position)).size !== 18) throw new Error('IRODORI_INCOMPLETE')
  return entries.sort((a, b) => a.position - b.position)
}

export function materialFromIrodoriCatalog(value: z.infer<typeof irodoriCatalogSchema>): Material[] {
  const catalog = irodoriCatalogSchema.parse(value)
  const urls = new Set(catalog.entries.map(entry => entry.url))
  return japaneseMaterials().map(material => {
    if (!material.sourceUrl || !urls.has(material.sourceUrl) || !material.externalStudy) throw new Error('IRODORI_IDENTITY')
    return { ...material, externalStudy: { ...material.externalStudy, directoryCheckedAt: catalog.checkedAt } }
  })
}
