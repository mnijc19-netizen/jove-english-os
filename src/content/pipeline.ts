import type { Material } from '../domain/types'
import type {
  AnalysisRequest, AnalysisResult, AudioArtifact, BoundInspection, ContentSegment, ContentSource,
  FeedBatch, FeedEpisode, Inspection, InspectionValues, LearnerContentProfile, LessonEnrichment,
  QualityReport, RightsUse, SliceBatch, SliceOptions, TextMetrics, TimedSentence, TimedTranscript,
  TranscriptCue, TranscriptFormat, TranscriptReference, UrlRule, VoaLessonCandidate, VoaLessonContract,
} from './pipeline-types'

export const PIPELINE_LIMITS = Object.freeze({
  feedBytes: 12 * 1024 * 1024, transcriptBytes: 2 * 1024 * 1024,
  xmlNodes: 150_000, xmlDepth: 32, feedItems: 1_000, batchItems: 25,
  cues: 30_000, cueTextChars: 8_000, mediaSeconds: 24 * 60 * 60,
  cueSeconds: 600, segments: 100,
})
const PODCAST_NS = 'https://podcastindex.org/namespace/1.0'
const ITUNES_NS = 'http://www.itunes.com/dtds/podcast-1.0.dtd'
const encoder = new TextEncoder()
const clamp = (value: number) => Math.min(1, Math.max(0, value))
const round = (value: number) => Math.round(value * 1_000) / 1_000
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export class ContentPipelineError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ContentPipelineError' }
}
function fail(code: string): never { throw new ContentPipelineError(code) }
/** JSONB and transports may reorder object keys. Evidence identities must survive that round trip. */
export function canonicalContentJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalContentJson).join(',')}]`
  return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalContentJson(child)}`).join(',')}}`
}
function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || encoder.encode(value).byteLength > max) fail('input-too-large-or-invalid')
  return value
}
function safePlain(value: string, max = 8_000): string {
  // eslint-disable-next-line no-control-regex -- Reject control/bidi characters in untrusted content.
  if (value.length > max || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) fail('unsafe-text')
  return value.replace(/\s+/gu, ' ').trim()
}
function assertNoActiveContent(value: string) {
  if (/<\s*\/?\s*(?:script|iframe|object|embed|svg|math)\b|\bon\w+\s*=|(?:javascript|vbscript)\s*:/iu.test(value)) fail('active-content')
}

/** Lexical SSRF guard only: the fetching backend must also pin/check resolved IPs and EVERY redirect. */
export function validateSourceUrl(raw: string, rules?: readonly UrlRule[]): string {
  // eslint-disable-next-line no-control-regex -- Reject raw control characters before WHATWG normalization.
  if (typeof raw !== 'string' || raw.length > 2_048 || /[\s\\\u0000-\u001f\u007f]/u.test(raw)) fail('unsafe-url')
  const rawPath = raw.split(/[?#]/u, 1)[0]!
  if (/%(?:00|0a|0d|2e|2f|5c|25)/iu.test(rawPath) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(rawPath)) fail('unsafe-url')
  let url: URL
  try { url = new URL(raw) } catch { fail('unsafe-url') }
  const host = url.hostname.toLowerCase()
  // Only public DNS hostnames; IP literals, numeric encodings, local and special-use names fail closed.
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || host.endsWith('.') ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|intranet|home|lan|test|invalid|example|onion)$/u.test(host)) fail('unsafe-url')
  // Avoid encoded slash/backslash/dot and double decoding changing a checked path later.
  if (/%(?:00|0a|0d|2e|2f|5c|25)/iu.test(url.pathname)) fail('unsafe-url')
  if (rules && !rules.some(rule => {
    if (rule.origin !== url.origin || !(rule.pathPrefix.endsWith('/') ? url.pathname.startsWith(rule.pathPrefix) : url.pathname === rule.pathPrefix)) return false
    if (rule.pathShape === 'art19-signed-audio') return !url.search && url.origin === 'https://content.production.cdn.art19.com' &&
      /^\/validation=\d{10},[a-f0-9-]{36},[A-Za-z0-9_-]{16,128}\/episodes\/[a-f0-9-]{36}\/[a-f0-9]{128}\/[A-Za-z0-9_-]{1,512}\.mp3$/u.test(url.pathname)
    if (rule.pathShape === 'open-yap-preview') return !url.search && url.origin === 'https://huggingface.co' &&
      /^\/datasets\/TheAgenticDataCompany\/open-yap-1k\/(?:resolve|blob)\/main\/preview\/conv_[a-f0-9]{12}\.mp3$/u.test(url.pathname)
    if (rule.pathShape === 'open-yap-cdn') {
      const keys = ['response-content-disposition', 'user_id', 'X-Xet-Cas-Uid', 'response-content-type', 'Expires', 'Policy', 'Signature', 'Key-Pair-Id']
      return url.origin === 'https://us.aws.cdn.hf.co' && /^\/xet-bridge-us\/6a97e8aabe471b1b359f7cd6\/[a-f0-9]{64}$/u.test(url.pathname) &&
        [...url.searchParams].length === keys.length && keys.every(key => url.searchParams.getAll(key).length === 1) &&
        keys.every(key => /^[^\r\n<>]{1,1800}$/u.test(url.searchParams.get(key) ?? '')) &&
        url.searchParams.get('response-content-type') === 'audio/mpeg' && /^\d{10}$/u.test(url.searchParams.get('Expires') ?? '') &&
        /conv_[a-f0-9]{12}\.mp3/u.test(url.searchParams.get('response-content-disposition') ?? '')
    }
    if (rule.query === 'hpr-file') return [...url.searchParams].length === 1 &&
      /^\/eps\/(hpr\d{4,6})\/\1\.(?:srt|ogg|mp3|opus)$/u.test(url.searchParams.get('filename') ?? '')
    if (rule.query === 'voa-zone') return url.origin === 'https://learningenglish.voanews.com' && url.pathname === '/podcast/' &&
      [...url.searchParams].length === 1 && /^(?:4456|987)$/u.test(url.searchParams.get('zoneId') ?? '')
    return !url.search
  })) fail('url-not-allowlisted')
  return url.href
}

/** Keep the feed enclosure as provenance; choose only the registered same-file
 * HPR CDN for transport instead of its rotating, sometimes unregistered mirrors. */
export function resolveEpisodeAudioUrl(episode: FeedEpisode, source: ContentSource): string {
  if (episode.sourceId !== source.id) fail('audio-source-mismatch')
  const original = validateSourceUrl(episode.audioUrl, source.urls.audio)
  const url = new URL(original)
  if (source.id !== 'hacker-public-radio' || url.origin !== 'https://hub.hackerpublicradio.org' || url.pathname !== '/ccdn.php') return original
  const file = url.searchParams.get('filename') ?? ''
  const match = /^\/eps\/(hpr\d{4,6})\/\1\.(?:ogg|mp3|opus)$/u.exec(file)
  if (!match || validateSourceUrl(episode.pageUrl, source.urls.page) !== `https://hackerpublicradio.org/eps/${match[1]}/index.html`)
    fail('audio-episode-mismatch')
  return validateSourceUrl(`https://hpr.nyc3.cdn.digitaloceanspaces.com${file}`, source.urls.audio)
}

function decodeXml(value: string): string {
  // Only the five predefined XML entities and bounded numeric references. No DTD or custom expansion.
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return value.replace(/&([^;\s<&]{1,32});|&/gu, (full: string, entity?: string) => {
    if (!entity) return fail('invalid-entity')
    if (Object.hasOwn(named, entity)) return named[entity]!
    if (!/^#(?:[0-9]{1,7}|x[0-9a-fA-F]{1,6})$/u.test(entity)) return fail('invalid-entity')
    const code = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    if (!(code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0x10ffff) ||
        code >= 0xd800 && code <= 0xdfff || code === 0xfffe || code === 0xffff) return fail('invalid-entity')
    return String.fromCodePoint(code)
  })
}
interface XmlNode { name: string; ns: string; attrs: Record<string, string>; text: string; children: XmlNode[] }

/** Extract an inert, exact Conversation block. Never execute the surrounding publisher page. */
export function parseVoaLessonPage(input: string, contract: VoaLessonContract): VoaLessonCandidate {
  boundedText(input, 1_048_576)
  if (/<!ENTITY|<!DOCTYPE(?!\s+html\s*>)/iu.test(input)) fail('unsafe-voa-page')
  validateSourceUrl(contract.pageUrl, [{ origin: 'https://learningenglish.voanews.com', pathPrefix: '/a/' }])
  validateSourceUrl(contract.audioUrl, [{ origin: 'https://voa-audio.voanews.eu', pathPrefix: '/vle/' }])
  const headings = [...input.matchAll(/<h2\b[^>]*>\s*Conversation\s*<\/h2>/giu)]
  if (headings.length !== 1) fail('voa-conversation-binding-changed')
  const start = headings[0]!.index! + headings[0]![0].length
  const end = input.slice(start).search(/<h2\b/iu)
  if (end < 0 || end > 131_072) fail('voa-conversation-binding-changed')
  const block = input.slice(start, start + end)
  // Publisher download controls have analytics onclick handlers. They are neither
  // imported nor executed. Scripts/embeds anywhere in this block still fail closed;
  // the selected audio descriptor and dialogue reject active attributes as well.
  if (/<\s*\/?\s*(?:script|iframe|object|embed|svg|math)\b/iu.test(block)) fail('active-content')
  const media = [...block.matchAll(/data-media-id="(\d+)"/gu)]
  const audio = [...block.matchAll(/<audio\b[^>]*\ssrc="([^"]+)"[^>]*>/giu)]
  if (media.length !== 1 || media[0]![1] !== contract.mediaId || audio.length !== 1 ||
      decodeXml(audio[0]![1]!) !== contract.audioUrl ||
      !block.includes('title="VOA - Voice of America English News"')) fail('voa-conversation-binding-changed')
  assertNoActiveContent(audio[0]![0])
  const first = block.search(/<(?:p|div)\b[^>]*>\s*(?:<(?:strong|b)>\s*)?Anna:/iu)
  if (first < 0) fail('voa-dialogue-missing')
  const transcriptHtml = block.slice(first)
  assertNoActiveContent(transcriptHtml)
  const lines: string[] = []
  for (const match of transcriptHtml.matchAll(/<(p|div)\b[^>]*>((?:(?!<\/?(?:p|div)\b)[\s\S])*?)<\/\1>/giu)) {
    const raw = match[2]!.replace(/<\/?(?:strong|em|b|i|br|span)\b[^>]*>/giu, '')
    const text = safePlain(decodeXml(raw.replace(/&nbsp;/gu, ' ')), 8_000)
    if (/^[A-Z][A-Za-z .()&'-]{0,65}:\s*\S/u.test(text)) lines.push(text)
  }
  if (lines.length < 4 || lines.length > 200) fail('voa-dialogue-missing')
  const text = lines.join('\n')
  if (text.length > 32_768) fail('input-too-large-or-invalid')
  // Notices are evidence to investigate, never a proof that unmarked audio has no third-party work.
  const thirdPartyNotices = [...transcriptHtml.matchAll(/[^<>\r\n]{0,120}\b(?:written by|composed by|courtesy of|Associated Press|Reuters|AFP|Getty|copyright)\b[^<>\r\n]{0,180}/giu)]
    .map(match => safePlain(decodeXml(match[0]), 350)).slice(0, 20)
  return { ...contract, publisher: 'Voice of America', attribution: 'VOA Learning English — credit learningenglish.voanews.com; source text retained for candidate review only.',
    publisherTranscript: { text, timing: 'unknown', binding: 'same-page-conversation-player', alignment: 'unverified' },
    thirdPartyNotices, thirdPartyAudio: 'unknown', humanAudio: 'unknown', status: 'candidate', eligible: false, supply: 'archive-supplement' }
}

/** Small, bounded RSS XML subset; not a general-purpose HTML/XML parser. Never creates a DOM. */
function parseXml(input: string): XmlNode {
  let xml = boundedText(input, PIPELINE_LIMITS.feedBytes).replace(/^\uFEFF/u, '')
  if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(xml)) fail('xml-declaration-forbidden')
  assertNoActiveContent(xml)
  xml = xml.replace(/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>/iu, '')
  // Podhome publishes this optional display hint. Discard it; NEVER resolve its href or execute XSLT.
  xml = xml.replace(/^\s*<\?xml-stylesheet\s+[^?<>]{1,2048}\?>/u, '')
  if (xml.includes('<?')) fail('xml-processing-instruction')
  const document: XmlNode = { name: '#document', ns: '', attrs: {}, text: '', children: [] }
  const stack = [{ node: document, qname: '#document', namespaces: {} as Record<string, string> }]
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/gy
  let offset = 0
  let count = 0
  while (offset < xml.length) {
    token.lastIndex = offset
    const match = token.exec(xml)
    if (!match) fail('malformed-xml')
    const raw = match[0]
    offset = token.lastIndex
    const parent = stack[stack.length - 1]!
    if (raw.startsWith('<!--')) {
      if (raw.slice(4, -3).includes('--')) fail('malformed-xml')
      continue
    }
    if (raw.startsWith('<![CDATA[') || !raw.startsWith('<')) {
      const text = raw.startsWith('<![CDATA[') ? raw.slice(9, -3) : decodeXml(raw)
      assertNoActiveContent(text)
      parent.node.text += text
      continue
    }
    if (raw.startsWith('</')) {
      const close = /^<\/([A-Za-z_][\w.:-]*)\s*>$/u.exec(raw)
      if (stack.length === 1 || !close || close[1] !== parent.qname) fail('malformed-xml')
      stack.pop()
      continue
    }
    const start = /^<([A-Za-z_][\w.:-]*)/u.exec(raw)
    if (!start || ++count > PIPELINE_LIMITS.xmlNodes || stack.length > PIPELINE_LIMITS.xmlDepth) fail('xml-limit-or-malformed')
    const selfClosing = raw.endsWith('/>')
    const tail = raw.slice(start[0].length, selfClosing ? -2 : -1)
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>
    const attr = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/gy
    let attrOffset = 0
    let attrCount = 0
    while (attrOffset < tail.length && tail.slice(attrOffset).trim()) {
      attr.lastIndex = attrOffset
      const a = attr.exec(tail)
      if (!a || ++attrCount > 64 || Object.hasOwn(attrs, a[1]!)) fail('malformed-xml-attribute')
      const value = decodeXml(a[2] ?? a[3] ?? '')
      assertNoActiveContent(value)
      attrs[a[1]!] = value
      attrOffset = attr.lastIndex
    }
    const namespaces = { ...parent.namespaces }
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'xmlns') namespaces[''] = value
      else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value
    }
    const parts = start[1]!.split(':')
    if (parts.length > 2 || parts.length === 2 && !namespaces[parts[0]!]) fail('xml-namespace')
    const node: XmlNode = {
      name: parts[parts.length - 1]!, ns: namespaces[parts.length === 2 ? parts[0]! : ''] ?? '',
      attrs, text: '', children: [],
    }
    parent.node.children.push(node)
    if (!selfClosing) stack.push({ node, qname: start[1]!, namespaces })
  }
  if (stack.length !== 1 || document.text.trim() || document.children.length !== 1) fail('malformed-xml')
  return document.children[0]!
}
const children = (node: XmlNode, name: string, ns = '') => node.children.filter(child => child.name === name && child.ns === ns)
function only(node: XmlNode, name: string, ns = ''): XmlNode | undefined {
  const found = children(node, name, ns)
  if (found.length > 1) fail('ambiguous-feed-field')
  return found[0]
}
function field(node: XmlNode, name: string, ns = ''): string | null {
  const found = only(node, name, ns)
  if (!found) return null
  if (found.children.length) fail('nested-feed-field')
  return safePlain(found.text) || null
}
function declaredLicense(node: XmlNode): string | null {
  const license = only(node, 'license', PODCAST_NS)
  if (!license) return null
  const url = license.attrs.url ? validateSourceUrl(license.attrs.url) : ''
  return `${field(node, 'license', PODCAST_NS) ?? ''} ${url}`.trim() || 'Unspecified license declaration'
}
export function transcriptFormat(mime: string): TranscriptFormat {
  switch (mime.split(';')[0]?.trim().toLowerCase()) {
    case 'application/json': return 'json'
    case 'text/vtt': return 'vtt'
    case 'application/x-subrip': case 'application/srt': case 'text/srt': return 'srt'
    default: return fail('unsupported-transcript-format')
  }
}
function mediaDuration(raw: string | null): number | null {
  if (raw === null) return null
  if (!/^(?:\d{1,6}|\d{1,3}:\d{2}(?::\d{2})?)$/u.test(raw)) fail('invalid-duration')
  const pieces = raw.split(':').map(Number)
  if (pieces.length > 1 && pieces.slice(1).some(n => n >= 60)) fail('invalid-duration')
  const duration = pieces.reduce((seconds, part) => seconds * 60 + part, 0)
  if (duration <= 0 || duration > PIPELINE_LIMITS.mediaSeconds) fail('invalid-duration')
  return duration
}
function sourceEnabled(source: ContentSource) {
  if (!source.enabled || source.rights.status !== 'verified' || source.rights.license === 'unknown' || !source.rights.stream) fail('source-disabled-or-rights-unknown')
}

/** One first-party JSONL manifest only. Metadata is not acoustic evidence and contains no caption times. */
export function parseOpenYapPreviewManifest(input: string, source: ContentSource, options: { maxItems?: number; now: number }): FeedBatch {
  sourceEnabled(source)
  const base = 'https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k'
  if (source.id !== 'open-yap-sample' || source.feedFormat !== 'open-yap-preview-jsonl' ||
      source.feedUrl !== `${base}/raw/main/preview/metadata.jsonl` || source.rights.license !== 'CC-BY-4.0') fail('unsupported-publisher-manifest')
  validateSourceUrl(source.feedUrl, source.urls.feed)
  const max = options.maxItems ?? PIPELINE_LIMITS.batchItems
  if (!Number.isInteger(max) || max < 1 || max > 100 || !finite(options.now) || options.now <= 0) fail('invalid-batch-limit')
  const text = boundedText(input, 131_072)
  assertNoActiveContent(text)
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter(line => line.trim())
  if (!lines.length || lines.length > 100) fail('invalid-publisher-manifest-size')
  const episodes: FeedEpisode[] = [], quarantined: FeedBatch['quarantined'] = [], seen = new Set<string>()
  let valid = 0
  for (const [itemIndex, line] of lines.entries()) {
    try {
      const row: unknown = JSON.parse(line)
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail('invalid-manifest-item')
      const value = row as Record<string, unknown>
      const keys = ['file_name', 'topics', 'relationship', 'duration_min', 'turns_per_minute', 'turn_taking_gap_ms', 'speech_dominance']
      if (Object.keys(value).some(key => !keys.includes(key)) || typeof value.file_name !== 'string' ||
          !/^conv_[a-f0-9]{12}\.mp3$/u.test(value.file_name) || typeof value.topics !== 'string' ||
          !safePlain(value.topics, 600) || typeof value.relationship !== 'string' || !safePlain(value.relationship, 100) ||
          !finite(value.duration_min) || value.duration_min <= 0 || value.duration_min > 240) fail('invalid-manifest-item')
      for (const key of ['turns_per_minute', 'turn_taking_gap_ms', 'speech_dominance']) if (value[key] !== undefined &&
          (!finite(value[key]) || value[key] < 0 || value[key] > (key === 'speech_dominance' ? 1 : 60_000))) fail('invalid-manifest-item')
      if (seen.has(value.file_name)) fail('duplicate-feed-item')
      seen.add(value.file_name)
      const audioUrl = validateSourceUrl(`${base}/resolve/main/preview/${value.file_name}`, source.urls.audio)
      const pageUrl = validateSourceUrl(`${base}/blob/main/preview/${value.file_name}`, source.urls.page)
      valid++
      if (episodes.length >= max) continue
      episodes.push({ sourceId: source.id, guid: value.file_name, title: `Everyday conversation: ${safePlain(value.topics, 600)}`,
        pageUrl, feedUrl: source.feedUrl, audioUrl, audioMime: 'audio/mpeg', audioBytes: null,
        publishedAt: null, durationSeconds: null, declaredLanguage: source.declaredLanguage, explicit: null,
        licenseNotice: 'CC-BY-4.0', licenseDeclared: true, attribution: source.rights.attribution, transcripts: [] })
      // Rounded duration_min and publisher speech statistics MUST NOT become measured duration or observed facts.
    } catch (error) {
      quarantined.push({ itemIndex, code: error instanceof ContentPipelineError ? error.code : 'invalid-manifest-json' })
    }
  }
  return { episodes, quarantined, totalItems: lines.length, deferredItems: Math.max(0, valid - episodes.length) }
}

export function parseRssFeed(xml: string, source: ContentSource, options: { maxItems?: number; now: number }): FeedBatch {
  sourceEnabled(source)
  validateSourceUrl(source.feedUrl, source.urls.feed)
  if (!finite(options.now) || options.now <= 0) fail('invalid-clock')
  const maxItems = options.maxItems ?? PIPELINE_LIMITS.batchItems
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) fail('invalid-batch-limit')
  const root = parseXml(xml)
  if (root.name !== 'rss' || root.ns || root.attrs.version !== '2.0') fail('unsupported-feed-format')
  const channel = only(root, 'channel')
  if (!channel) fail('missing-channel')
  const items = children(channel, 'item')
  if (items.length > PIPELINE_LIMITS.feedItems) fail('too-many-feed-items')
  const language = field(channel, 'language') ?? source.declaredLanguage
  const channelDeclaration = declaredLicense(channel)
  const channelLicense = channelDeclaration ?? field(channel, 'copyright')
  const batch: FeedBatch = { episodes: [], quarantined: [], totalItems: items.length, deferredItems: Math.max(0, items.length - maxItems) }
  const seen = new Set<string>()
  for (let index = 0; index < Math.min(items.length, maxItems); index++) {
    try {
      const item = items[index]!
      const title = field(item, 'title')
      const page = field(item, 'link')
      const enclosure = only(item, 'enclosure')
      if (!title || !page || !enclosure?.attrs.url) fail('missing-episode-fields')
      const pageUrl = validateSourceUrl(page, source.urls.page)
      const guid = field(item, 'guid') ?? pageUrl
      if (seen.has(guid)) fail('duplicate-episode')
      seen.add(guid)
      const audioUrl = validateSourceUrl(enclosure.attrs.url, source.urls.audio)
      const audioMime = enclosure.attrs.type?.toLowerCase()
      if (!audioMime || !['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/aac'].includes(audioMime)) fail('unsupported-audio-format')
      const length = enclosure.attrs.length
      const audioBytes = length && /^\d{1,12}$/u.test(length) ? Number(length) : null
      if (length && audioBytes === null) fail('invalid-audio-length')
      const date = field(item, 'pubDate')
      const publishedAt = date ? Date.parse(date) : null
      if (publishedAt !== null && (!finite(publishedAt) || publishedAt > options.now + 86_400_000)) fail('invalid-publication-date')
      const transcripts: TranscriptReference[] = []
      for (const node of children(item, 'transcript', PODCAST_NS)) {
        if (!node.attrs.url || !node.attrs.type) fail('invalid-transcript-reference')
        // Even an unsupported HTML reference must be safe, but it is never fetched/rendered.
        const url = validateSourceUrl(node.attrs.url, source.urls.transcript)
        let format: TranscriptFormat
        try { format = transcriptFormat(node.attrs.type) } catch { continue }
        if (transcripts.length >= 8) fail('too-many-transcript-references')
        if (!transcripts.some(t => t.url === url)) transcripts.push({ url, format,
          language: node.attrs.language ? safePlain(node.attrs.language, 64) : language, origin: 'publisher-feed' })
      }
      if (!transcripts.length && source.transcriptDiscovery === 'hpr-srt') {
        const match = /^\/eps\/(hpr\d{4,6})\/index\.html$/u.exec(new URL(pageUrl).pathname)
        if (!match) fail('unsupported-publisher-episode-url')
        const episode = match[1]!
        // Verified publisher CDN avoids relying on a randomly selected unapproved mirror.
        const url = validateSourceUrl(`https://hpr.nyc3.cdn.digitaloceanspaces.com/eps/${episode}/${episode}.srt`, source.urls.transcript)
        transcripts.push({ url, format: 'srt', language, origin: 'publisher-template' })
      }
      const explicit = field(item, 'explicit', ITUNES_NS)
      const itemDeclaration = declaredLicense(item)
      const licenseNotice = itemDeclaration ?? field(item, 'copyright') ?? channelLicense
      const creators = [field(item, 'author', ITUNES_NS), field(item, 'creator', 'http://purl.org/dc/elements/1.1/'),
        ...children(item, 'person', PODCAST_NS).slice(0, 32).map(person => safePlain(person.text, 200))].filter(Boolean)
      const creator = [...new Set(creators)].join(', ')
      batch.episodes.push({ sourceId: source.id, guid, title, pageUrl, feedUrl: source.feedUrl,
        audioUrl, audioMime, audioBytes, publishedAt, durationSeconds: mediaDuration(field(item, 'duration', ITUNES_NS)),
        declaredLanguage: language, explicit: explicit === null ? null : /^(?:yes|true|explicit)$/iu.test(explicit),
        licenseNotice, licenseDeclared: itemDeclaration !== null || channelDeclaration !== null,
        attribution: creator ? `${creator} / ${source.publisher}` : source.rights.attribution,
        transcripts: transcripts.sort((a, b) => ['vtt', 'srt', 'json'].indexOf(a.format) - ['vtt', 'srt', 'json'].indexOf(b.format)),
      })
    } catch (error) {
      if (!(error instanceof ContentPipelineError)) throw error
      batch.quarantined.push({ itemIndex: index, code: error.code })
    }
  }
  return batch
}

function captionText(raw: string): { text: string; speaker: string | null } {
  assertNoActiveContent(raw)
  const voice = /<v(?:\.[\w-]+)*\s+([^<>]+)>/u.exec(raw)?.[1] ?? null
  const stripped = raw.replace(/<\/?(?:b|i|u|c(?:\.[\w-]+)*|v(?:\.[\w-]+)*(?:\s+[^<>]+)?|lang(?:\s+[\w-]+)?)>/gu, '')
  const text = safePlain(decodeXml(stripped.replace(/&nbsp;/gu, ' ')), PIPELINE_LIMITS.cueTextChars)
  if (!text) fail('empty-cue')
  return { text, speaker: voice ? safePlain(voice, 200) : null }
}
function cueTime(raw: string, format: 'vtt' | 'srt'): number {
  const regex = format === 'vtt' ? /^(?:(\d{2,3}):)?(\d{2}):(\d{2})\.(\d{3})$/u : /^(\d{2,3}):(\d{2}):(\d{2}),(\d{3})$/u
  const match = regex.exec(raw)
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) fail('invalid-cue-time')
  return Number(match[1] ?? 0) * 3_600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1_000
}
function validateCues(cues: TranscriptCue[], mediaSeconds?: number): TranscriptCue[] {
  if (!cues.length || cues.length > PIPELINE_LIMITS.cues) fail('invalid-cue-count')
  if (mediaSeconds !== undefined && (!finite(mediaSeconds) || mediaSeconds <= 0 || mediaSeconds > PIPELINE_LIMITS.mediaSeconds)) fail('invalid-duration')
  let previousEnd = 0
  for (const cue of cues) {
    if (!finite(cue.startSeconds) || !finite(cue.endSeconds) || cue.startSeconds < 0 ||
        cue.endSeconds <= cue.startSeconds || cue.startSeconds < previousEnd ||
        cue.endSeconds - cue.startSeconds > PIPELINE_LIMITS.cueSeconds ||
        cue.endSeconds > (mediaSeconds ?? PIPELINE_LIMITS.mediaSeconds)) fail('invalid-or-overlapping-timing')
    if (!safePlain(cue.text, PIPELINE_LIMITS.cueTextChars)) fail('empty-cue')
    if (cue.speaker !== null) safePlain(cue.speaker, 200)
    previousEnd = cue.endSeconds
  }
  return cues
}
/** Database provenance identifier only. Never an external URL or a network fetch target. */
export function contentTranscriptUrn(itemId: string): string {
  if (!/^[a-f0-9]{64}$/u.test(itemId)) fail('invalid-stored-transcript-id')
  return `urn:jove:content-transcript:${itemId}`
}
function isStoredTranscript(reference: TranscriptReference): boolean {
  return reference.origin === 'authorized-stt' && /^urn:jove:content-transcript:[a-f0-9]{64}$/u.test(reference.url)
}
export function parseTimedTranscript(input: string, reference: TranscriptReference, mediaSeconds?: number): TimedTranscript {
  let text = boundedText(input, PIPELINE_LIMITS.transcriptBytes).replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  if (!isStoredTranscript(reference)) validateSourceUrl(reference.url)
  assertNoActiveContent(text)
  if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(text)) fail('xml-declaration-forbidden')
  const cues: TranscriptCue[] = []
  if (reference.format === 'json') {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { fail('invalid-json-transcript') }
    if (!parsed || typeof parsed !== 'object') fail('invalid-json-transcript')
    const object = parsed as Record<string, unknown>
    if (object.version !== '1.0.0' || !Array.isArray(object.segments) || object.segments.length > PIPELINE_LIMITS.cues) fail('unsupported-json-transcript')
    for (const item of object.segments) {
      if (!item || typeof item !== 'object') fail('invalid-json-cue')
      const segment = item as Record<string, unknown>
      if (!finite(segment.startTime) || !finite(segment.endTime) || typeof segment.body !== 'string' ||
          segment.speaker !== undefined && typeof segment.speaker !== 'string') fail('invalid-json-cue')
      cues.push({ startSeconds: segment.startTime, endSeconds: segment.endTime,
        text: safePlain(segment.body, PIPELINE_LIMITS.cueTextChars), speaker: typeof segment.speaker === 'string' ? safePlain(segment.speaker, 200) : null })
    }
  } else if (reference.format === 'vtt' || reference.format === 'srt') {
    if (reference.format === 'vtt') {
      if (!/^WEBVTT(?:[^\S\n]+[^\n]*)?\n/u.test(text)) fail('missing-webvtt-header')
      const end = text.indexOf('\n\n')
      if (end < 0 || text.slice(0, end).includes('-->')) fail('invalid-webvtt-header')
      text = text.slice(end + 2)
    }
    for (const block of text.split(/\n[\t ]*\n/gu).filter(part => part.trim())) {
      const lines = block.trim().split('\n')
      if (reference.format === 'vtt' && /^NOTE(?:\s|$)/u.test(lines[0]!)) continue
      if (/^(?:STYLE|REGION)(?:\s|$)/u.test(lines[0]!)) fail('unsupported-caption-block')
      let timingIndex = 0
      if (!lines[0]!.includes('-->')) {
        if (reference.format === 'srt' && !/^\d+$/u.test(lines[0]!)) fail('invalid-srt-index')
        safePlain(lines[0]!, 200)
        timingIndex = 1
      }
      const timing = /^(\S+)\s+-->\s+(\S+)(.*)$/u.exec(lines[timingIndex] ?? '')
      if (!timing) fail('invalid-caption-timing')
      if (timing[3]?.trim() && (reference.format === 'srt' || !/^(?:\s+(?:vertical|line|position|size|align):[\w%,.-]+)+$/u.test(timing[3]))) fail('unsupported-cue-settings')
      const content = captionText(lines.slice(timingIndex + 1).join(' '))
      cues.push({ startSeconds: cueTime(timing[1]!, reference.format), endSeconds: cueTime(timing[2]!, reference.format), ...content })
      if (cues.length > PIPELINE_LIMITS.cues) fail('invalid-cue-count')
    }
  } else fail('unsupported-transcript-format')
  return { format: reference.format, reference: { ...reference }, cues: validateCues(cues, mediaSeconds), alignment: 'unverified' }
}

function words(text: string): string[] { return text.toLowerCase().match(/[a-z]+(?:['’][a-z]+)*/gu) ?? [] }
export async function contentFingerprint(text: string): Promise<string> {
  boundedText(text, PIPELINE_LIMITS.transcriptBytes)
  return digest(words(text.normalize('NFKC').replace(/’/gu, "'")).join(' '))
}
async function digest(text: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
const endsSentence = (text: string) => /[.!?]["'”’)]*$/u.test(text) && !/\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc)\.$/iu.test(text)
function sentenceUnits(cues: TranscriptCue[], maxGap: number, coverage?: SliceOptions['audioCoverage']): { units: TimedSentence[]; quarantined: SliceBatch['quarantined'] } {
  const units: TimedSentence[] = []
  const quarantined: SliceBatch['quarantined'] = []
  let pending: TimedSentence | null = null
  const discard = () => {
    if (pending) quarantined.push({ startSeconds: pending.startSeconds, endSeconds: pending.endSeconds, code: 'incomplete-sentence-or-gap' })
    pending = null
  }
  cues.forEach((cue, index) => {
    // A cue straddling the retained audio end is wholly unavailable: no word
    // interpolation or punctuation from unheard speech may finish a sentence.
    // Iterate the original array so retained cue indices/reference stay intact.
    if (coverage && cue.endSeconds > coverage.endSeconds) {
      discard()
      quarantined.push({ startSeconds: cue.startSeconds, endSeconds: cue.endSeconds, code: 'outside-audio-coverage' })
      return
    }
    if (pending && cue.startSeconds - pending.endSeconds > maxGap) discard()
    if (!pending) pending = { ...cue, cueIndices: [index], timing: 'cue-boundaries', internalSentenceTiming: 'not-needed' }
    else {
      pending.text += ` ${cue.text}`
      pending.endSeconds = cue.endSeconds
      pending.cueIndices.push(index)
      if (pending.speaker !== cue.speaker) pending.speaker = null
    }
    if (endsSentence(cue.text)) {
      if (pending.text.split(/[.!?]+["'”’)]*\s+/u).length > 1) pending.internalSentenceTiming = 'unknown'
      units.push(pending)
      pending = null
    }
  })
  discard()
  return { units, quarantined }
}

export async function sliceTranscript(episode: FeedEpisode, transcript: TimedTranscript, source: ContentSource, options: SliceOptions): Promise<SliceBatch> {
  sourceEnabled(source)
  if (episode.sourceId !== source.id || episode.feedUrl !== source.feedUrl) fail('source-provenance-mismatch')
  validateSourceUrl(episode.audioUrl, source.urls.audio)
  validateSourceUrl(episode.pageUrl, source.urls.page)
  if (transcript.reference.origin === 'authorized-stt') {
    const derivation = transcript.reference.derivation
    if (!source.rights.transcribe || !(options.derivedTranscriptRules?.length || options.storedTranscriptId) || !derivation ||
        !/^[a-f0-9]{64}$/u.test(derivation.audioSha256) || !derivation.provider.trim() || !derivation.evidenceId.trim() ||
        !finite(derivation.processedAt) || derivation.processedAt <= 0 || derivation.processedAt > options.retrievedAt) fail('authorized-stt-required')
    if (derivation.audioDurationSeconds !== undefined && (!finite(derivation.audioDurationSeconds) ||
        derivation.audioDurationSeconds <= 0 || derivation.audioDurationSeconds > PIPELINE_LIMITS.mediaSeconds)) fail('invalid-duration')
    if (isStoredTranscript(transcript.reference)) {
      if (!options.storedTranscriptId || transcript.reference.url !== contentTranscriptUrn(options.storedTranscriptId)) fail('stored-transcript-provenance-mismatch')
    } else {
      if (!options.derivedTranscriptRules?.length) fail('authorized-stt-required')
      validateSourceUrl(transcript.reference.url, options.derivedTranscriptRules)
    }
  } else validateSourceUrl(transcript.reference.url, source.urls.transcript)
  if (!episode.transcripts.some(ref => ref.url === transcript.reference.url && ref.format === transcript.format)) fail('transcript-provenance-mismatch')
  validateCues(transcript.cues, episode.durationSeconds ?? undefined)
  const coverage = options.audioCoverage
  if (coverage !== undefined && (!coverage || coverage.startSeconds !== 0 || !finite(coverage.endSeconds) ||
      coverage.endSeconds <= 0 || coverage.endSeconds > 600)) fail('invalid-audio-coverage')
  const min = options.minSeconds ?? 30
  const max = options.maxSeconds ?? 120
  const target = options.targetSeconds ?? 60
  const gap = options.maxGapSeconds ?? 5
  const limit = options.maxSegments ?? PIPELINE_LIMITS.segments
  if (![min, max, target, gap, options.retrievedAt].every(finite) || min < 30 || max > 120 || min > target || target > max ||
      gap < 0 || gap > 10 || !Number.isInteger(limit) || limit < 1 || limit > PIPELINE_LIMITS.segments || options.retrievedAt <= 0) fail('invalid-slice-options')
  const { units, quarantined } = sentenceUnits(transcript.cues, gap, coverage)
  const segments: ContentSegment[] = []
  const episodeFingerprint = await digest(JSON.stringify([source.id, episode.guid]))
  for (let first = 0; first < units.length;) {
    let best = -1
    let distance = Infinity
    for (let last = first; last < units.length; last++) {
      if (last > first && units[last]!.startSeconds - units[last - 1]!.endSeconds > gap) break
      const duration = units[last]!.endSeconds - units[first]!.startSeconds
      if (duration > max) break
      if (duration >= min && Math.abs(duration - target) < distance) { best = last; distance = Math.abs(duration - target) }
    }
    if (best < 0 || segments.length >= limit) {
      quarantined.push({ startSeconds: units[first]!.startSeconds, endSeconds: units[first]!.endSeconds,
        code: segments.length >= limit ? 'segment-batch-limit' : 'no-coherent-duration-window' })
      first++
      continue
    }
    const sentences = units.slice(first, best + 1).map(unit => ({ ...unit, cueIndices: [...unit.cueIndices] }))
    const startSeconds = sentences[0]!.startSeconds
    const endSeconds = sentences[sentences.length - 1]!.endSeconds
    const text = sentences.map(sentence => sentence.text).join(' ')
    const fingerprint = await contentFingerprint(text)
    // Includes every cue boundary, so a revised timestamp file cannot reuse stale review.
    const timingFingerprint = await digest(canonicalContentJson([transcript.reference.url,
      sentences.flatMap(sentence => sentence.cueIndices.map(index => transcript.cues[index]))]))
    segments.push({
      id: `authentic-${await digest(JSON.stringify([episodeFingerprint, fingerprint, timingFingerprint]))}`,
      episodeFingerprint, contentFingerprint: fingerprint, timingFingerprint, sourceId: source.id,
      episode: { ...episode, transcripts: episode.transcripts.map(ref => ({ ...ref })) },
      transcriptReference: { ...transcript.reference }, startSeconds, endSeconds,
      durationSeconds: round(endSeconds - startSeconds), transcript: text, sentences,
      provenance: {
        publisher: source.publisher, license: source.rights.license, licenseEvidenceUrls: [...source.rights.evidenceUrls],
        attribution: `${episode.attribution}. ${episode.title}. ${episode.pageUrl}`,
        changes: `Excerpt ${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} seconds; ${transcript.reference.origin === 'authorized-stt' ? 'machine-transcribed from licensed audio; ' : ''}caption formatting normalized. Internal sentence times are not interpolated.`,
        retrievedAt: options.retrievedAt,
      },
    })
    first = best + 1
  }
  return { segments, quarantined }
}

export const INSPECTION_FACTS: readonly (keyof InspectionValues)[] = [
  'humanSpeech', 'englishSpeech', 'accent', 'clarity', 'noiseFraction', 'musicFraction',
  'speakerCount', 'transcriptAlignment', 'coherent', 'safe', 'thirdPartyClear', 'learningValue',
]
const acousticFacts = new Set<keyof InspectionValues>(['humanSpeech', 'englishSpeech', 'accent', 'clarity', 'noiseFraction', 'musicFraction', 'speakerCount', 'transcriptAlignment', 'thirdPartyClear'])
export function unknownInspection(reason = 'No inspection of the actual audio and transcript has been recorded.'): Inspection {
  return Object.fromEntries(INSPECTION_FACTS.map(key => [key, { status: 'unknown', reason }])) as Inspection
}
function validateArtifact(segment: ContentSegment, artifact: AudioArtifact) {
  if (!/^[a-f0-9]{64}$/u.test(artifact.sha256) || artifact.url !== segment.episode.audioUrl ||
      !finite(artifact.durationSeconds) || artifact.durationSeconds < segment.endSeconds || artifact.durationSeconds > PIPELINE_LIMITS.mediaSeconds) fail('audio-artifact-mismatch')
  if (artifact.coverage && (artifact.coverage.version !== 'mpeg-prefix-v1' || artifact.coverage.startSeconds !== 0 ||
      !finite(artifact.coverage.endSeconds) || Math.abs(artifact.coverage.endSeconds - artifact.durationSeconds) > 0.00000001 || artifact.durationSeconds > 600)) fail('audio-artifact-coverage-mismatch')
  if (segment.transcriptReference.origin === 'authorized-stt' && segment.transcriptReference.derivation?.audioSha256 !== artifact.sha256) fail('stt-audio-artifact-mismatch')
  if (segment.transcriptReference.origin === 'authorized-stt' &&
      canonicalContentJson(segment.transcriptReference.derivation?.audioCoverage ?? null) !== canonicalContentJson(artifact.coverage ?? null)) fail('stt-audio-artifact-mismatch')
}
function segmentSnapshot(segment: ContentSegment): string {
  return canonicalContentJson([segment.id, segment.sourceId, segment.episode, segment.transcriptReference,
    segment.startSeconds, segment.endSeconds, segment.durationSeconds, segment.transcript, segment.sentences, segment.provenance])
}
export function createAnalysisRequest(segment: ContentSegment, artifact: AudioArtifact): AnalysisRequest {
  validateArtifact(segment, artifact)
  return { segmentId: segment.id, timingFingerprint: segment.timingFingerprint, contentFingerprint: segment.contentFingerprint,
    segmentSnapshot: segmentSnapshot(segment), audioSha256: artifact.sha256, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds,
    transcript: segment.transcript, requiredFacts: [...INSPECTION_FACTS] }
}
function validFact(key: keyof InspectionValues, fact: Inspection[keyof InspectionValues], now: number): boolean {
  if (!fact || fact.status !== 'observed') return false
  const evidence = fact.evidence
  if (!evidence || !evidence.id?.trim() || !evidence.analyzer?.trim() || !evidence.version?.trim() ||
      !finite(evidence.assessedAt) || evidence.assessedAt <= 0 || evidence.assessedAt > now ||
      !finite(evidence.confidence) || evidence.confidence < 0.8 || evidence.confidence > 1 ||
      !['human-audio-review', 'machine-audio-analysis', 'machine-text-analysis'].includes(evidence.method) ||
      acousticFacts.has(key) && evidence.method === 'machine-text-analysis') return false
  if (key === 'accent') return ['general-american', 'other-english', 'mixed'].includes(String(fact.value))
  if (key === 'speakerCount') return finite(fact.value) && Number.isInteger(fact.value) && fact.value >= 1 && fact.value <= 20
  if (['clarity', 'noiseFraction', 'musicFraction', 'transcriptAlignment'].includes(key)) return finite(fact.value) && fact.value >= 0 && fact.value <= 1
  return typeof fact.value === 'boolean'
}
export function bindAnalysis(segment: ContentSegment, artifact: AudioArtifact, result: AnalysisResult, now: number): BoundInspection {
  validateArtifact(segment, artifact)
  if (!finite(now) || now <= 0 || result.segmentId !== segment.id || result.timingFingerprint !== segment.timingFingerprint ||
      result.contentFingerprint !== segment.contentFingerprint || result.audioSha256 !== artifact.sha256 ||
      result.segmentSnapshot !== segmentSnapshot(segment) ||
      result.startSeconds !== segment.startSeconds || result.endSeconds !== segment.endSeconds) fail('analysis-provenance-mismatch')
  const facts = unknownInspection()
  for (const key of INSPECTION_FACTS) {
    const fact = result.facts[key]
    if (fact && validFact(key, fact, now)) {
      // Copy only declared fields; provider output cannot carry executable config or hooks.
      Object.assign(facts, { [key]: structuredClone(fact) })
    }
  }
  return { segmentId: segment.id, timingFingerprint: segment.timingFingerprint,
    contentFingerprint: segment.contentFingerprint, segmentSnapshot: segmentSnapshot(segment), audioSha256: artifact.sha256, facts }
}

const topicWords: Record<string, readonly string[]> = {
  'Everyday life': ['home', 'family', 'friend', 'friends', 'cooking', 'weekend', 'camping', 'shopping', 'hobby'],
  Technology: ['software', 'computer', 'linux', 'technology', 'app', 'model', 'code', 'ai'],
  Work: ['work', 'meeting', 'colleague', 'interview', 'office', 'job', 'manager'],
  'Living abroad': ['landlord', 'rent', 'visa', 'airport', 'bank', 'transport', 'apartment', 'abroad'],
  Culture: ['music', 'film', 'movie', 'book', 'culture', 'concert', 'art'],
}
export function textMetrics(segment: ContentSegment, knownWords?: readonly string[]): TextMetrics {
  const tokens = words(segment.transcript)
  const sentenceCount = Math.max(1, segment.sentences.reduce((count, sentence) => count + sentence.text.split(/[.!?]+["'”’)]*\s+/u).length, 0))
  const mean = tokens.length / sentenceCount
  const long = tokens.filter(word => word.replace(/['’]/gu, '').length >= 8).length / Math.max(1, tokens.length)
  const wpm = tokens.length / segment.durationSeconds * 60
  const known = knownWords === undefined ? null : new Set(knownWords.flatMap(words))
  const unique = new Set(tokens)
  const topics = Object.entries(topicWords).filter(([, anchors]) => anchors.filter(word => unique.has(word)).length >= 2).map(([topic]) => topic)
  return { wordCount: tokens.length, sentenceCount, meanSentenceWords: round(mean), longWordFraction: round(long),
    contractionFraction: round(tokens.filter(token => /['’]/u.test(token)).length / Math.max(1, tokens.length)),
    transcriptWordsPerMinute: round(wpm), lexicalCoverage: known === null || !tokens.length ? null : round(tokens.filter(word => known.has(word)).length / tokens.length),
    difficulty: round(clamp(0.35 * clamp((mean - 6) / 24) + 0.35 * clamp(long / 0.35) + 0.3 * clamp((wpm - 80) / 160))),
    difficultyBasis: 'uncalibrated-text-timing-heuristic-v1', topics }
}
export function rightsReasons(source: ContentSource, episode: FeedEpisode, use: RightsUse, now: number): string[] {
  const reasons: string[] = []
  const rights = source.rights
  if (!source.enabled || rights.status !== 'verified' || rights.license === 'unknown' || !rights.evidenceUrls.length) reasons.push('rights-unverified')
  if (!finite(now) || !finite(source.verifiedAt) || source.verifiedAt > now || !finite(rights.recheckAfterDays) ||
      rights.recheckAfterDays <= 0 || now - source.verifiedAt > rights.recheckAfterDays * 86_400_000) reasons.push('rights-recheck-due')
  if (!rights.stream || !rights.excerpt || use.mode !== 'stream' && !rights.storeAudio ||
      use.mode === 'redistribute-excerpt' && !rights.redistribute) reasons.push('rights-use-forbidden')
  if (!['stream', 'private-excerpt', 'redistribute-excerpt'].includes(use.mode)) reasons.push('rights-use-forbidden')
  if (!use.attributionProvided || !use.changesIndicated || rights.shareAlike && !use.shareAlikeAccepted) reasons.push('rights-obligations-missing')
  if (episode.sourceId !== source.id || episode.feedUrl !== source.feedUrl) reasons.push('source-provenance-mismatch')
  // Copyright attribution alone does not conflict with CC. Restrictive/unknown license overrides need review.
  const notice = episode.licenseNotice
  const licenseMatchers: Record<ContentSource['rights']['license'], RegExp> = {
    'CC-BY-SA-4.0': /(?:CC[ -]BY[ -]SA[ -]4\.0\b|Attribution.?ShareAlike\s+4\.0\b|licenses\/by-sa\/4\.0\/)/iu,
    'CC-BY-4.0': /(?:CC[ -]BY[ -]4\.0\b|Attribution\s+4\.0\b|licenses\/by\/4\.0\/)/iu,
    'CC0-1.0': /(?:CC0[ -]1\.0\b|publicdomain\/zero\/1\.0\/)/iu,
    'VOA-public-domain': /public domain/iu,
    unknown: /(?!) /u,
  }
  if (notice && (/all rights reserved|\b(?:NC|ND)\b|non.?commercial|no.?derivatives|permission required/iu.test(notice) ||
    (episode.licenseDeclared || /creative commons|\bCC[0 -]|creativecommons\.org/iu.test(notice)) && !licenseMatchers[rights.license].test(notice))) reasons.push('conflicting-episode-license')
  return [...new Set(reasons)]
}

export interface AssessmentContext {
  source: ContentSource; now: number; use: RightsUse; profile: LearnerContentProfile
  artifact?: AudioArtifact; inspection?: BoundInspection
}
export function assessSegment(segment: ContentSegment, context: AssessmentContext): QualityReport {
  const { source, now, use, profile, artifact, inspection } = context
  const reasons = rightsReasons(source, segment.episode, use, now)
  if (!finite(profile.targetDifficulty) || profile.targetDifficulty < 0 || profile.targetDifficulty > 1 ||
      !finite(profile.fatigue) || profile.fatigue < 0 || profile.fatigue > 1) fail('invalid-learner-profile')
  const metrics = textMetrics(segment, profile.knownWords)
  let facts = unknownInspection()
  if (artifact && inspection && inspection.segmentId === segment.id && inspection.timingFingerprint === segment.timingFingerprint &&
      inspection.contentFingerprint === segment.contentFingerprint && inspection.audioSha256 === artifact.sha256 && inspection.segmentSnapshot === segmentSnapshot(segment)) {
    validateArtifact(segment, artifact)
    facts = unknownInspection()
    for (const key of INSPECTION_FACTS) if (validFact(key, inspection.facts[key], now)) Object.assign(facts, { [key]: structuredClone(inspection.facts[key]) })
  } else reasons.push('audio-inspection-required')
  const unknownFacts = INSPECTION_FACTS.filter(key => facts[key].status === 'unknown')
  for (const key of unknownFacts) if (key !== 'accent' || profile.requireGeneralAmerican) reasons.push(`unknown-${key}`)
  const value = <K extends keyof InspectionValues>(key: K): InspectionValues[K] | undefined => {
    const fact = facts[key]
    return fact.status === 'observed' ? fact.value : undefined
  }
  for (const key of ['humanSpeech', 'englishSpeech', 'coherent', 'safe', 'thirdPartyClear', 'learningValue'] as const) {
    if (value(key) === false) reasons.push(`failed-${key}`)
  }
  if (profile.requireGeneralAmerican && value('accent') !== undefined && value('accent') !== 'general-american') reasons.push('accent-mismatch')
  if ((value('clarity') ?? 1) < 0.75) reasons.push('low-clarity')
  if ((value('noiseFraction') ?? 0) > 0.15) reasons.push('excess-noise')
  if ((value('musicFraction') ?? 0) > 0.05) reasons.push('excess-music')
  if ((value('speakerCount') ?? 1) > 4) reasons.push('too-many-speakers')
  if ((value('transcriptAlignment') ?? 1) < 0.9) reasons.push('poor-transcript-alignment')
  if (!finite(segment.durationSeconds) || segment.durationSeconds < 30 || segment.durationSeconds > 120 ||
      Math.abs(segment.endSeconds - segment.startSeconds - segment.durationSeconds) > 0.001) reasons.push('invalid-segment-duration')
  if (metrics.wordCount < 35 || metrics.transcriptWordsPerMinute < 50 || metrics.transcriptWordsPerMinute > 260) reasons.push('unsuitable-text-timing')
  if (segment.episode.explicit === true) reasons.push('publisher-explicit')
  if (/\b(?:sponsor(?:ed)?|promo code|advertisement|subscribe and save)\b/iu.test(segment.transcript)) reasons.push('possible-advertisement')
  if (profile.recentContentFingerprints?.includes(segment.contentFingerprint)) reasons.push('duplicate-content')
  const accepted = reasons.length === 0
  const humanReviewed = INSPECTION_FACTS.filter(key => key !== 'accent' || profile.requireGeneralAmerican)
    .every(key => facts[key].status === 'observed' && facts[key].evidence.method === 'human-audio-review')
  const target = clamp(profile.targetDifficulty - profile.fatigue * 0.2)
  const interestMatch = metrics.topics.some(topic => profile.interests.some(interest => interest.toLowerCase() === topic.toLowerCase()))
  const repetition = profile.recentSourceIds?.filter(id => id === source.id).length ?? 0
  return {
    status: !accepted ? 'quarantined' : humanReviewed ? 'eligible-human-reviewed' : 'eligible-machine-screened',
    reasons: [...new Set(reasons)], unknownFacts, metrics, inspection: facts,
    quality: accepted ? round(Math.min(value('clarity')!, value('transcriptAlignment')!)) : null,
    fit: accepted ? round(clamp(0.8 * (1 - Math.abs(metrics.difficulty - target)) + (interestMatch ? 0.15 : 0) +
      (repetition === 0 ? 0.05 : -Math.min(0.2, repetition * 0.05)))) : null,
  }
}

/** Legacy Material cannot express timed streaming. Return a sidecar; never attach full episode audio to a 60s lesson. */
export function toMaterial(segment: ContentSegment, context: AssessmentContext, lesson: LessonEnrichment, createdAt: number): {
  material: Material
  playback: { url: string; startSeconds: number; endSeconds: number; audioSha256: string }
  quality: QualityReport
  timedSentences: TimedSentence[]
} {
  const quality = assessSegment(segment, context)
  if (quality.status === 'quarantined' || !context.artifact) fail('candidate-not-approved')
  if (!finite(createdAt) || createdAt <= 0 || !lesson.evidenceId?.trim() || !lesson.chunks.length || !lesson.keywords.length ||
      !safePlain(lesson.question, 2_000) || !safePlain(lesson.answer, 4_000)) fail('lesson-enrichment-required')
  for (const keyword of lesson.keywords) if (!safePlain(keyword, 200)) fail('invalid-lesson-keyword')
  for (const chunk of lesson.chunks) for (const text of Object.values(chunk)) safePlain(text, 2_000)
  const material: Material = {
    id: segment.id, title: safePlain(segment.episode.title, 1_000), topic: quality.metrics.topics[0] ?? 'Authentic conversation',
    difficulty: quality.metrics.difficulty, duration: segment.durationSeconds, transcript: segment.transcript,
    sentences: segment.sentences.map(sentence => sentence.text), sourceKind: 'discovery', sourceUrl: segment.episode.pageUrl,
    sourceLabel: `${segment.provenance.attribution} / ${quality.status === 'eligible-human-reviewed' ? 'human reviewed' : 'machine screened'}`,
    license: `${segment.provenance.license}; ${segment.provenance.licenseEvidenceUrls.join(' ')}; ${segment.provenance.changes}`,
    synthetic: false, approved: true, question: lesson.question, answer: lesson.answer,
    keywords: [...lesson.keywords], chunks: structuredClone(lesson.chunks), createdAt,
  }
  return { material, quality, playback: { url: segment.episode.audioUrl, startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds, audioSha256: context.artifact.sha256 },
  timedSentences: segment.sentences.map(sentence => ({ ...sentence, startSeconds: round(sentence.startSeconds - segment.startSeconds),
    endSeconds: round(sentence.endSeconds - segment.startSeconds), cueIndices: [...sentence.cueIndices] })) }
}

/** Conditional-fetch schedule is deterministic and persisted by the backend, not a browser timer. */
export function nextSourcePoll(source: ContentSource, lastAttemptAt: number, consecutiveFailures = 0): number {
  if (!finite(lastAttemptAt) || lastAttemptAt <= 0 || !finite(source.cadenceHours) || source.cadenceHours < 1 ||
      !Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) fail('invalid-poll-state')
  return lastAttemptAt + Math.min(168, source.cadenceHours * 2 ** Math.min(8, consecutiveFailures)) * 3_600_000
}
