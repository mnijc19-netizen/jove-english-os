import { describe, expect, it } from 'vitest'
import {
  assessSegment, bindAnalysis, contentFingerprint, contentTranscriptUrn, createAnalysisRequest, INSPECTION_FACTS,
  nextSourcePoll, parseRssFeed, parseOpenYapPreviewManifest, parseVoaLessonPage, parseTimedTranscript, PIPELINE_LIMITS, rightsReasons,
  sliceTranscript, textMetrics, toMaterial, transcriptFormat, unknownInspection, validateSourceUrl,
} from '../src/content/pipeline'
import { ALLOWLISTED_CONTENT_SOURCES, CONTENT_SOURCES, OPEN_YAP_SAMPLE_SOURCE, VOA_LESSON_CANDIDATES } from '../src/content/sources'
import type {
  AnalysisResult, AudioArtifact, ContentSegment, ContentSource, FeedEpisode, Inspection,
  LearnerContentProfile, ObservationEvidence, RightsUse, TranscriptReference,
} from '../src/content/pipeline-types'

const now = Date.UTC(2026, 8, 8, 12)
describe('exact VOA scene candidates retain unknown acoustic and temporal facts', () => {
  const contract = VOA_LESSON_CANDIDATES[0]!
  const page = `<html><h2>Conversation</h2><div data-media-id="${contract.mediaId}" title="VOA - Voice of America English News">
    <audio src="${contract.audioUrl}"></audio></div>
    <div>Anna: Where is the library?</div><div>Marsha: It is <strong>nearby</strong>.</div>
    <div>Anna: Thank you.</div><div>Marsha: You are welcome.</div><h2>Quiz</h2></html>`
  it('binds only the exact audio/player to plain publisher dialogue without claiming timed subtitles or review', () => {
    const result = parseVoaLessonPage(page, contract)
    expect(result).toMatchObject({ status: 'candidate', eligible: false, thirdPartyAudio: 'unknown', humanAudio: 'unknown',
      publisherTranscript: { timing: 'unknown', alignment: 'unverified', binding: 'same-page-conversation-player' } })
    expect(result.publisherTranscript.text).toContain('Marsha: It is nearby.')
    expect(result.publisherTranscript).not.toHaveProperty('cues')
    expect(ALLOWLISTED_CONTENT_SOURCES.some(source => VOA_LESSON_CANDIDATES.some(row => row.id === source.id))).toBe(false)
  })
  it.each(['audio', 'player', 'duplicate', 'script', 'entity', 'html-text'])('rejects %s substitution before using candidate data', change => {
    const invalid = change === 'audio' ? page.replace(contract.audioUrl, 'https://private.local/track.mp3') :
      change === 'player' ? page.replace(contract.mediaId, '123456') :
      change === 'duplicate' ? page.replace('<h2>Quiz', '<h2>Conversation</h2><h2>Quiz') :
      change === 'script' ? page.replace('Where is', '<script>alert(1)</script>Where is') :
      change === 'entity' ? '<!DOCTYPE html [<!ENTITY x "bad">]>' + page : page.replace('Where is', '&lt;script&gt;Where is')
    expect(() => parseVoaLessonPage(invalid, contract)).toThrow()
    if (change === 'entity') expect(() => parseVoaLessonPage('<!DOCTYPE html SYSTEM "https://private.local/external.dtd">' + page, contract)).toThrow()
  })
  it('retains third-party credits as a warning, never as public-domain approval', () => {
    const result = parseVoaLessonPage(page.replace('<h2>Quiz', '<div>The song was written by Another Author.</div><h2>Quiz'), contract)
    expect(result.thirdPartyNotices.join(' ')).toContain('written by Another Author')
    expect(result.eligible).toBe(false)
  })
  it('does not import publisher download controls and rejects active dialogue attributes', () => {
    const chrome = page.replace('<div>Anna:', '<a onclick="analytics()">Download</a><div>Anna:')
    expect(parseVoaLessonPage(chrome, contract).publisherTranscript.text).not.toContain('analytics')
    expect(() => parseVoaLessonPage(page.replace('<div>Marsha:', '<div onclick="evil()">Marsha:'), contract)).toThrow()
  })
})
const origin = 'https://podcast.example.org'
const source = (): ContentSource => ({
  ...structuredClone(ALLOWLISTED_CONTENT_SOURCES[0]!), id: 'test-original', name: 'Original test podcast',
  feedUrl: `${origin}/feed`, homepage: origin, publisher: 'Test author', declaredLanguage: 'en-US',
  urls: { feed: [{ origin, pathPrefix: '/feed' }], page: [{ origin, pathPrefix: '/episodes/' }],
    audio: [{ origin, pathPrefix: '/audio/' }], transcript: [{ origin, pathPrefix: '/transcripts/' }] },
  examples: [],
})
const reference = (format: TranscriptReference['format'] = 'vtt'): TranscriptReference => ({
  url: `${origin}/transcripts/one.${format}`, format, language: 'en-US', origin: 'publisher-feed',
})
const episode = (): FeedEpisode => ({
  sourceId: 'test-original', guid: 'one', title: 'A weekend with friends', pageUrl: `${origin}/episodes/one`,
  feedUrl: `${origin}/feed`, audioUrl: `${origin}/audio/one.mp3`, audioMime: 'audio/mpeg',
  audioBytes: 100_000, publishedAt: now - 86_400_000, durationSeconds: 300, declaredLanguage: 'en-US',
  explicit: null, licenseNotice: null, attribution: 'Test author', transcripts: [reference()],
})
// Original fixture prose, not a copied podcast transcript. All inspection evidence below is synthetic TEST DATA.
const sentences = [
  'My friends came over to our home last weekend, and we decided to cook dinner together before watching a movie.',
  'I went shopping early in the morning because we needed fresh vegetables and some bread from the little local shop.',
  'When everyone arrived, I asked each friend to choose a simple job so that we could prepare the meal together.',
  'One friend brought a book about camping, which gave us an idea for another trip when the weather gets warmer.',
  'We talked about the music we liked and the hobbies we wanted to try while the food was slowly cooking.',
  'After dinner we cleaned the kitchen, made some tea, and agreed to meet again at the same time next month.',
]
const timestamp = (seconds: number, comma = false) => {
  const hours = Math.floor(seconds / 3_600).toString().padStart(2, '0')
  const minutes = Math.floor(seconds % 3_600 / 60).toString().padStart(2, '0')
  const secs = (seconds % 60).toFixed(3).padStart(6, '0')
  return `${hours}:${minutes}:${comma ? secs.replace('.', ',') : secs}`
}
const vtt = (start = 0) => `WEBVTT\n\n${sentences.map((text, index) =>
  `${timestamp(start + index * 10)} --> ${timestamp(start + (index + 1) * 10)}\n${text}`).join('\n\n')}\n`
const itemXml = (extra = '', id = 'one') => `<item><title>A weekend &amp; a meal</title><guid>${id}</guid>
  <link>${origin}/episodes/${id}</link><pubDate>Mon, 07 Sep 2026 12:00:00 GMT</pubDate>
  <enclosure url="${origin}/audio/${id}.mp3" length="100000" type="audio/mpeg"/>
  <itunes:duration>05:00</itunes:duration>${extra}</item>`
const rss = (items = itemXml(), extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:p="https://podcastindex.org/namespace/1.0">
<channel><title>Test podcast</title><language>en-US</language>${extra}${items}</channel></rss>`
const transcriptTag = `<p:transcript url="${origin}/transcripts/one.vtt" type="text/vtt" language="en-US"/>`
const use: RightsUse = { mode: 'private-excerpt', attributionProvided: true, changesIndicated: true, shareAlikeAccepted: true }
const profile: LearnerContentProfile = { targetDifficulty: 0.45, fatigue: 0, interests: ['Everyday life'], requireGeneralAmerican: true }
async function segment(start = 0): Promise<ContentSegment> {
  return (await sliceTranscript(episode(), parseTimedTranscript(vtt(start), reference()), source(), { retrievedAt: now })).segments[0]!
}
const artifact = (candidate: ContentSegment): AudioArtifact => ({ sha256: 'a'.repeat(64), url: candidate.episode.audioUrl, durationSeconds: 300 })
function inspectionFacts(method: ObservationEvidence['method'] = 'machine-audio-analysis'): Inspection {
  const evidence: ObservationEvidence = { id: 'fixture-only', analyzer: 'test-analyzer', version: 'test-v1', assessedAt: now - 1, confidence: 0.95, method }
  const values = {
    humanSpeech: true, englishSpeech: true, accent: 'general-american', clarity: 0.9, noiseFraction: 0.01,
    musicFraction: 0, speakerCount: 2, transcriptAlignment: 0.96, coherent: true, safe: true, thirdPartyClear: true, learningValue: true,
  }
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { status: 'observed', value, evidence: { ...evidence } }])) as Inspection
}
function analysis(candidate: ContentSegment, facts = inspectionFacts()): AnalysisResult {
  const request = createAnalysisRequest(candidate, artifact(candidate))
  return { ...request, facts }
}
function context(candidate: ContentSegment, facts = inspectionFacts()) {
  return { source: source(), now, use, profile, artifact: artifact(candidate),
    inspection: bindAnalysis(candidate, artifact(candidate), analysis(candidate, facts), now) }
}

describe('bounded RSS and publisher transcript discovery', () => {
  it('recognizes the namespace URI regardless of prefix and decodes only predefined entities', () => {
    const batch = parseRssFeed(rss(itemXml(transcriptTag)), source(), { now })
    expect(batch.quarantined).toEqual([])
    expect(batch.episodes[0]).toMatchObject({ title: 'A weekend & a meal', durationSeconds: 300,
      explicit: null, transcripts: [reference()] })
  })
  it('handles CDATA, comments, quoted > in attributes and self-closing whitespace', () => {
    const xml = rss(itemXml(transcriptTag.replace('/>', ' />')).replace('A weekend &amp; a meal', '<![CDATA[A weekend meal]]>'))
      .replace('<channel>', '<channel><!-- original fixture --> <image title="a > b"/>')
    expect(parseRssFeed(xml, source(), { now }).episodes[0]?.title).toBe('A weekend meal')
  })
  it.each([
    ['DTD', '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///private">]>'],
    ['entity declaration', '<!ENTITY x "boom">'],
    ['unknown processing instruction', '<?execute href="evil"?>'],
    ['script', '<script>alert(1)</script>'],
    ['CDATA script', '<![CDATA[<script>alert(1)</script>]]>'],
    ['encoded script', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['unknown entity', '&external;'],
    ['bare ampersand', 'A & B'],
    ['duplicate attribute', '<item a="1" a="2"/>'],
    ['malformed nesting', '<item></channel></item>'],
  ])('rejects %s without resolving entities or creating a DOM', (_, content) => {
    expect(() => parseRssFeed(rss(itemXml(), content), source(), { now })).toThrow()
  })
  it('discards a bounded leading stylesheet hint without resolving its URL', () => {
    const xml = rss().replace('?>', '?>\n<?xml-stylesheet type="text/xsl" href="xslsheet"?>')
    expect(parseRssFeed(xml, source(), { now }).episodes).toHaveLength(1)
  })
  it('rejects spoofed namespace transcript tags as unsupported, never trusted links', () => {
    const xml = rss(itemXml(transcriptTag)).replace('https://podcastindex.org/namespace/1.0', 'https://attacker.example.org/namespace')
    expect(parseRssFeed(xml, source(), { now }).episodes[0]?.transcripts).toEqual([])
  })
  it('enforces byte, depth, count and caller batch limits', () => {
    expect(() => parseRssFeed('x'.repeat(PIPELINE_LIMITS.feedBytes + 1), source(), { now })).toThrow('input-too-large')
    expect(() => parseRssFeed(rss('<x>'.repeat(35) + '</x>'.repeat(35)), source(), { now })).toThrow('xml-limit')
    expect(() => parseRssFeed(rss('<item/>'.repeat(1_001)), source(), { now })).toThrow('too-many-feed-items')
    expect(() => parseRssFeed(rss(), source(), { now, maxItems: 101 })).toThrow('invalid-batch-limit')
    expect(parseRssFeed(rss(itemXml('', 'a') + itemXml('', 'b')), source(), { now, maxItems: 1 }))
      .toMatchObject({ totalItems: 2, deferredItems: 1, episodes: [expect.objectContaining({ guid: 'a' })] })
  })
  it('quarantines a bad item while preserving the next valid item and reports duplicate GUIDs', () => {
    const bad = itemXml().replace(`${origin}/audio/one.mp3`, 'https://127.0.0.1/private')
    const batch = parseRssFeed(rss(bad + itemXml('', 'two') + itemXml('', 'two')), source(), { now })
    expect(batch.episodes.map(item => item.guid)).toEqual(['two'])
    expect(batch.quarantined.map(item => item.code)).toEqual(['unsafe-url', 'duplicate-episode'])
  })
  it('quarantines future dates, invalid durations, multiple enclosures and unsupported media', () => {
    for (const xml of [itemXml().replace('2026', '2038'), itemXml().replace('05:00', '04:99'),
      itemXml().replace('</item>', `<enclosure url="${origin}/audio/two.mp3"/></item>`), itemXml().replace('audio/mpeg', 'text/html')]) {
      expect(parseRssFeed(rss(xml), source(), { now }).episodes).toEqual([])
    }
  })
  it('never treats text/HTML as timed subtitles and leaves missing transcripts explicit', () => {
    const tags = transcriptTag.replace('text/vtt', 'text/html') + transcriptTag
    expect(parseRssFeed(rss(itemXml(tags)), source(), { now }).episodes[0]?.transcripts).toHaveLength(1)
    expect(parseRssFeed(rss(), source(), { now }).episodes[0]?.transcripts).toEqual([])
    expect(() => transcriptFormat('text/html')).toThrow('unsupported-transcript-format')
  })
  it('uses only the verified HPR episode URL pattern for fallback SRT discovery', () => {
    const hpr = CONTENT_SOURCES.find(s => s.id === 'hacker-public-radio')!
    const xml = rss(itemXml().replace(`${origin}/episodes/one`, 'https://hackerpublicradio.org/eps/hpr4721/index.html')
      .replace(`${origin}/audio/one.mp3`, 'https://hub.hackerpublicradio.org/ccdn.php?filename=/eps/hpr4721/hpr4721.mp3'))
    expect(parseRssFeed(xml, hpr, { now }).episodes[0]?.transcripts[0]).toMatchObject({
      url: 'https://hpr.nyc3.cdn.digitaloceanspaces.com/eps/hpr4721/hpr4721.srt', origin: 'publisher-template',
    })
  })
})

describe('bounded first-party everyday conversation manifest', () => {
  const entry = { file_name: 'conv_d4005da6db98.mp3', topics: 'daily routines, travel planning, visa and paperwork', relationship: 'friends',
    duration_min: 29, turns_per_minute: 7.2, turn_taking_gap_ms: 440, speech_dominance: 0.51 }
  const parse = (input: string, maxItems = 25) => parseOpenYapPreviewManifest(input, OPEN_YAP_SAMPLE_SOURCE, { now, maxItems })
  it('produces real source provenance without inventing dates, media times, captions or acoustic facts', () => {
    const batch = parse(JSON.stringify(entry))
    expect(batch.episodes[0]).toMatchObject({ sourceId: 'open-yap-sample', guid: entry.file_name, audioMime: 'audio/mpeg',
      publishedAt: null, durationSeconds: null, audioBytes: null, explicit: null, transcripts: [], licenseNotice: 'CC-BY-4.0' })
    expect(batch.episodes[0]!.audioUrl).toBe(`https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k/resolve/main/preview/${entry.file_name}`)
    expect(JSON.stringify(batch)).not.toContain('speech_dominance')
    expect(OPEN_YAP_SAMPLE_SOURCE.supply).toBe('archive-supplement')
  })
  it('bounds metadata bytes, row count and batch size and reports duplicate rows', () => {
    expect(() => parse('x'.repeat(131_073))).toThrow('input-too-large')
    expect(() => parse(Array(101).fill('{}').join('\n'))).toThrow('invalid-publisher-manifest-size')
    expect(() => parse('{}', 101)).toThrow('invalid-batch-limit')
    const batch = parse([entry, entry, { ...entry, file_name: 'conv_aaaaaaaaaaaa.mp3' }].map(row => JSON.stringify(row)).join('\n'), 1)
    expect(batch.episodes).toHaveLength(1); expect(batch.deferredItems).toBe(1)
    expect(batch.quarantined).toEqual([{ itemIndex: 1, code: 'duplicate-feed-item' }])
  })
  it.each([
    { file_name: '../private.mp3' }, { file_name: 'https://localhost/audio.mp3' }, { file_name: 'shard-00000.tar' },
    { audioUrl: 'https://evil.example.org/audio.mp3' }, { transcript: 'invented' }, { duration_min: -1 }, { speech_dominance: 2 },
  ])('quarantines unsupported manifest row %j without expanding the allowlist', override => {
    expect(parse(JSON.stringify({ ...entry, ...override })).episodes).toEqual([])
  })
  it('rejects active content and non-approved dataset adapters', () => {
    expect(() => parse(JSON.stringify({ ...entry, topics: '<script>run()</script>' }))).toThrow('active-content')
    expect(() => parseOpenYapPreviewManifest(JSON.stringify(entry), { ...OPEN_YAP_SAMPLE_SOURCE, id: 'other-dataset' }, { now })).toThrow('unsupported-publisher-manifest')
  })
})

describe('source URL boundary', () => {
  it.each([
    'http://podcast.example.org/feed', 'https://localhost/feed', 'https://server.local/feed',
    'https://intranet/feed', 'https://10.0.0.1/feed', 'https://127.0.0.1/feed',
    'https://2130706433/feed', 'https://0x7f000001/feed', 'https://[::1]/feed',
    'https://[::ffff:127.0.0.1]/feed', 'https://169.254.169.254/latest', 'https://user:pass@podcast.example.org/feed',
    'https://podcast.example.org:8443/feed', 'https://podcast.example.org./feed',
    'https://podcast.example.org/feed#script', 'https://podcast.example.org/%2e%2e/feed',
    'https://podcast.example.org/transcripts/%252e%252e/file', 'https://podcast.example.org/\nfeed',
    'file:///audio.mp3', 'javascript:alert(1)',
  ])('rejects unsafe source URL %s', url => expect(() => validateSourceUrl(url, source().urls.feed)).toThrow())
  it('checks exact origins, prefix boundaries and allowed query shapes', () => {
    expect(validateSourceUrl(`${origin}/feed`, source().urls.feed)).toBe(`${origin}/feed`)
    for (const url of [`${origin}/feed-attacker`, `${origin}.evil.com/feed`, `${origin}/feed?target=http://localhost`])
      expect(() => validateSourceUrl(url, source().urls.feed)).toThrow('url-not-allowlisted')
    const hpr = CONTENT_SOURCES.find(s => s.id === 'hacker-public-radio')!
    expect(() => validateSourceUrl('https://hub.hackerpublicradio.org/ccdn.php?filename=http://localhost', hpr.urls.audio)).toThrow()
    expect(() => validateSourceUrl('https://hub.hackerpublicradio.org/ccdn.php?filename=/eps/hpr4721/hpr9999.srt', hpr.urls.transcript)).toThrow()
  })
})

describe('timed transcript subset', () => {
  it('parses WebVTT voice tags, cue settings, multiline content, CRLF and BOM', () => {
    const text = '\uFEFFWEBVTT\r\n\r\nNOTE publisher note\r\nmetadata\r\n\r\ncue-1\r\n00:00:01.000 --> 00:00:03.500 align:start\r\n<v Alice><i>Hello</i> &amp; welcome.\r\n</v>\r\n'
    expect(parseTimedTranscript(text, reference()).cues).toEqual([{ startSeconds: 1, endSeconds: 3.5, text: 'Hello & welcome.', speaker: 'Alice' }])
  })
  it('parses SRT millisecond timing and official Podcasting 2.0 JSON with real end times', () => {
    expect(parseTimedTranscript('1\n00:00:01,250 --> 00:00:03,500\nHello there.\n', reference('srt')).cues[0]?.startSeconds).toBe(1.25)
    expect(parseTimedTranscript(JSON.stringify({ version: '1.0.0', segments: [
      { startTime: 0, endTime: 2.25, body: 'Hello there.', speaker: 'Alice' },
    ] }), reference('json')).cues[0]).toEqual({ startSeconds: 0, endSeconds: 2.25, text: 'Hello there.', speaker: 'Alice' })
  })
  it.each([
    ['missing endTime', { startTime: 0, body: 'Hello.' }],
    ['numeric strings', { startTime: '0', endTime: 2, body: 'Hello.' }],
    ['negative time', { startTime: -1, endTime: 2, body: 'Hello.' }],
    ['backward time', { startTime: 2, endTime: 1, body: 'Hello.' }],
    ['zero duration', { startTime: 2, endTime: 2, body: 'Hello.' }],
    ['huge cue', { startTime: 0, endTime: 601, body: 'Hello.' }],
    ['HTML script', { startTime: 0, endTime: 1, body: '<script>bad</script>' }],
  ])('rejects JSON %s without guessing boundaries', (_, cue) => {
    expect(() => parseTimedTranscript(JSON.stringify({ version: '1.0.0', segments: [cue] }), reference('json'))).toThrow()
  })
  it.each([
    'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello.\n\n00:00:01.999 --> 00:00:03.000\nOverlap.',
    'WEBVTT\n\n00:99:00.000 --> 01:40:00.000\nInvalid minute.',
    'WEBVTT\n\nSTYLE\n::cue { color: red; }',
    'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<img src=x onerror=evil()>',
    'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n&lt;script&gt;bad&lt;/script&gt;',
    '00:00:00.000 --> 00:00:01.000\nMissing header.',
  ])('rejects unsafe, overlapping or unsupported caption content', text => expect(() => parseTimedTranscript(text, reference())).toThrow())
  it('rejects cues beyond the supplied actual media duration and oversize input', () => {
    expect(() => parseTimedTranscript(vtt(), reference(), 59.999)).toThrow('invalid-or-overlapping-timing')
    expect(() => parseTimedTranscript('x'.repeat(PIPELINE_LIMITS.transcriptBytes + 1), reference())).toThrow('input-too-large')
  })
})

describe('coherent intervals, timing provenance and duplicate identity', () => {
  it('makes a 60-second complete sentence slice without altering media offsets', async () => {
    const candidate = await segment(40)
    expect(candidate).toMatchObject({ startSeconds: 40, endSeconds: 100, durationSeconds: 60, transcript: sentences.join(' ') })
    expect(candidate.sentences[0]).toMatchObject({ startSeconds: 40, endSeconds: 50, timing: 'cue-boundaries' })
    expect(candidate.provenance.attribution).toContain(episode().pageUrl)
    expect(candidate.provenance.changes).toContain('40.000')
    expect(candidate.contentFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })
  it('joins split sentence cues, retaining unknown internal timing for multi-sentence cues', async () => {
    const input = 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nWe wanted to\n\n00:00:05.000 --> 00:00:10.000\ncook dinner together.\n\n00:00:10.000 --> 00:00:40.000\nWe went shopping. Then we cooked a meal.\n'
    const result = await sliceTranscript(episode(), parseTimedTranscript(input, reference()), source(), { retrievedAt: now })
    expect(result.segments[0]?.sentences[0]).toMatchObject({ cueIndices: [0, 1], text: 'We wanted to cook dinner together.', startSeconds: 0, endSeconds: 10 })
    expect(result.segments[0]?.sentences[1]?.internalSentenceTiming).toBe('unknown')
  })
  it('does not pad short material, bridge long gaps or cut a long sentence', async () => {
    const transcript = parseTimedTranscript('WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nFirst sentence.\n\n00:00:30.000 --> 00:00:40.000\nAnother sentence.\n', reference())
    const result = await sliceTranscript(episode(), transcript, source(), { retrievedAt: now })
    expect(result.segments).toEqual([])
    expect(result.quarantined).toHaveLength(2)
    const long = parseTimedTranscript('WEBVTT\n\n00:00:00.000 --> 00:02:10.000\nOne long sentence.\n', reference())
    expect((await sliceTranscript(episode(), long, source(), { retrievedAt: now })).segments).toEqual([])
  })
  it('quarantines unfinished tails and creates non-overlapping windows deterministically', async () => {
    const input = vtt() + '\n00:01:00.000 --> 00:01:10.000\nAn unfinished thought\n'
    const a = await sliceTranscript(episode(), parseTimedTranscript(input, reference()), source(), { retrievedAt: now })
    const b = await sliceTranscript(episode(), parseTimedTranscript(input, reference()), source(), { retrievedAt: now })
    expect(a).toEqual(b)
    expect(a.quarantined).toContainEqual({ startSeconds: 60, endSeconds: 70, code: 'incomplete-sentence-or-gap' })
    const twice = vtt() + '\n' + vtt(60).replace('WEBVTT\n\n', '')
    const windows = await sliceTranscript(episode(), parseTimedTranscript(twice, reference()), source(), { retrievedAt: now })
    expect(windows.segments.map(s => [s.startSeconds, s.endSeconds])).toEqual([[0, 60], [60, 120]])
  })
  it('normalizes punctuation/whitespace for duplicates but invalidates timing identity when cues change', async () => {
    expect(await contentFingerprint('Hello, WORLD!')).toBe(await contentFingerprint(' hello world '))
    const first = await segment()
    const shifted = await segment(1)
    expect(first.contentFingerprint).toBe(shifted.contentFingerprint)
    expect(first.timingFingerprint).not.toBe(shifted.timingFingerprint)
    expect(first.id).not.toBe(shifted.id)
  })
  it('rejects mismatched source, transcript reference and invalid slicing bounds', async () => {
    const transcript = parseTimedTranscript(vtt(), reference())
    await expect(sliceTranscript({ ...episode(), sourceId: 'another' }, transcript, source(), { retrievedAt: now })).rejects.toThrow('source-provenance')
    await expect(sliceTranscript({ ...episode(), transcripts: [] }, transcript, source(), { retrievedAt: now })).rejects.toThrow('transcript-provenance')
    await expect(sliceTranscript(episode(), transcript, source(), { retrievedAt: now, minSeconds: 10 })).rejects.toThrow('invalid-slice-options')
  })
  it('supports licensed server STT only through explicitly trusted storage and binds its original audio bytes', async () => {
    const ref: TranscriptReference = { ...reference(), url: 'https://owner-content.example.org/transcripts/one.vtt', origin: 'authorized-stt',
      derivation: { audioSha256: 'a'.repeat(64), provider: 'test-provider', processedAt: now - 1, evidenceId: 'test-stt-job' } }
    const input = parseTimedTranscript(vtt(), ref)
    const item = { ...episode(), transcripts: [ref] }
    await expect(sliceTranscript(item, input, source(), { retrievedAt: now })).rejects.toThrow('authorized-stt-required')
    const options = { retrievedAt: now, derivedTranscriptRules: [{ origin: 'https://owner-content.example.org', pathPrefix: '/transcripts/' }] }
    const candidate = (await sliceTranscript(item, input, source(), options)).segments[0]!
    expect(candidate.provenance.changes).toContain('machine-transcribed')
    expect(() => createAnalysisRequest(candidate, { ...artifact(candidate), sha256: 'b'.repeat(64) })).toThrow('stt-audio-artifact')
    const disallowed = source()
    disallowed.rights.transcribe = false
    await expect(sliceTranscript(item, input, disallowed, options)).rejects.toThrow('authorized-stt-required')
  })
  it('binds a non-fetchable stored STT reference to its trusted database item without weakening publisher URL checks', async () => {
    const id = '1'.repeat(64)
    const ref: TranscriptReference = { ...reference(), url: contentTranscriptUrn(id), origin: 'authorized-stt',
      derivation: { audioSha256: 'a'.repeat(64), audioDurationSeconds: 70, provider: 'test-stt', processedAt: now - 1, evidenceId: 'test-job' } }
    const input = parseTimedTranscript(vtt(), ref), item = { ...episode(), transcripts: [ref] }
    expect((await sliceTranscript(item, input, source(), { retrievedAt: now, storedTranscriptId: id })).segments).toHaveLength(1)
    await expect(sliceTranscript(item, input, source(), { retrievedAt: now })).rejects.toThrow('authorized-stt-required')
    await expect(sliceTranscript(item, input, source(), { retrievedAt: now, storedTranscriptId: '2'.repeat(64) })).rejects.toThrow('stored-transcript-provenance-mismatch')
    expect(() => validateSourceUrl(ref.url)).toThrow()
    expect(() => parseTimedTranscript(vtt(), { ...ref, origin: 'publisher-feed' })).toThrow()
    expect(() => parseTimedTranscript(vtt(), { ...ref, url: 'http://127.0.0.1:55321/content-transcripts/one.json' })).toThrow()
    expect(() => parseTimedTranscript(vtt(), { ...ref, url: `${ref.url}?url=https://example.org` })).toThrow()
    expect(() => contentTranscriptUrn('../one')).toThrow('invalid-stored-transcript-id')
  })
})

describe('observed vs unknown, rights and adaptive fit', () => {
  it('keeps caption identity and audio binding across JSONB object-key reordering', async()=>{
    const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'
      ?Object.fromEntries(Object.entries(value).reverse().map(([key,child])=>[key,reorder(child)])):value
    const candidate=await segment(),ctx=context(candidate)
    const restored=reorder(candidate) as ContentSegment
    expect(assessSegment(restored,ctx).status).toBe('eligible-machine-screened')
    const transcript=parseTimedTranscript(vtt(),reference())
    const sliced=await sliceTranscript(episode(),reorder(transcript) as typeof transcript,source(),{retrievedAt:now})
    expect(sliced.segments[0]!.id).toBe(candidate.id)
    expect(createAnalysisRequest(restored,artifact(restored)).segmentSnapshot).toBe(createAnalysisRequest(candidate,artifact(candidate)).segmentSnapshot)
  })
  it('never marks an uninspected recording reviewed from metadata or text metrics', async () => {
    const candidate = await segment()
    const report = assessSegment(candidate, { source: source(), now, use, profile })
    expect(report.status).toBe('quarantined')
    expect(report.unknownFacts).toEqual(INSPECTION_FACTS)
    expect(report.quality).toBeNull()
    expect(report.fit).toBeNull()
    expect(report.metrics.lexicalCoverage).toBeNull()
    expect(report.metrics.difficultyBasis).toBe('uncalibrated-text-timing-heuristic-v1')
    expect(report.metrics.transcriptWordsPerMinute).toBeGreaterThan(100)
  })
  it('binds analysis to actual bytes, complete span and transcript revision', async () => {
    const candidate = await segment()
    const result = analysis(candidate)
    for (const mutation of [{ audioSha256: 'b'.repeat(64) }, { startSeconds: 1 }, { endSeconds: 59 },
      { segmentId: 'another' }, { contentFingerprint: 'b'.repeat(64) }, { timingFingerprint: 'b'.repeat(64) }]) {
      expect(() => bindAnalysis(candidate, artifact(candidate), { ...result, ...mutation }, now)).toThrow('analysis-provenance')
    }
    expect(() => createAnalysisRequest(candidate, { ...artifact(candidate), durationSeconds: 59 })).toThrow('audio-artifact')
  })
  it('does not accept acoustic or third-party clearance claims from a text-only model', async () => {
    const candidate = await segment()
    const report = assessSegment(candidate, context(candidate, inspectionFacts('machine-text-analysis')))
    expect(report.status).toBe('quarantined')
    expect(report.unknownFacts).toContain('humanSpeech')
    expect(report.unknownFacts).toContain('accent')
    expect(report.unknownFacts).toContain('thirdPartyClear')
    expect(report.unknownFacts).not.toContain('coherent')
  })
  it('invalidates stale in-flight analysis and approval when content changes without updating its ID', async () => {
    const candidate = await segment()
    const response = analysis(candidate)
    const ctx = context(candidate)
    const changed = { ...candidate, transcript: 'A different transcript with unchanged identifiers.' }
    expect(() => bindAnalysis(changed, artifact(changed), response, now)).toThrow('analysis-provenance')
    expect(assessSegment(changed, ctx).status).toBe('quarantined')
    const changedSentence = structuredClone(candidate)
    changedSentence.sentences[0]!.endSeconds = 9
    expect(assessSegment(changedSentence, ctx).status).toBe('quarantined')
  })
  it('separates automatic screening from actual human review and keeps source metadata unchanged', async () => {
    const candidate = await segment()
    expect(assessSegment(candidate, context(candidate)).status).toBe('eligible-machine-screened')
    expect(assessSegment(candidate, context(candidate, inspectionFacts('human-audio-review'))).status).toBe('eligible-human-reviewed')
    expect(candidate.episode.explicit).toBeNull()
  })
  it('leaves low confidence, out-of-range values, missing evidence and future evidence unknown', async () => {
    const candidate = await segment()
    for (const mutation of [{ confidence: 0.79 }, { confidence: 2 }, { assessedAt: now + 1 }, { id: '' }]) {
      const facts = inspectionFacts()
      if (facts.clarity.status === 'observed') Object.assign(facts.clarity.evidence, mutation)
      expect(assessSegment(candidate, context(candidate, facts)).unknownFacts).toContain('clarity')
    }
    const facts = inspectionFacts()
    if (facts.noiseFraction.status === 'observed') facts.noiseFraction.value = -1
    expect(assessSegment(candidate, context(candidate, facts)).unknownFacts).toContain('noiseFraction')
  })
  it.each([
    ['clarity', 0.5, 'low-clarity'], ['noiseFraction', 0.5, 'excess-noise'], ['musicFraction', 0.5, 'excess-music'],
    ['transcriptAlignment', 0.7, 'poor-transcript-alignment'], ['speakerCount', 5, 'too-many-speakers'],
    ['humanSpeech', false, 'failed-humanSpeech'], ['thirdPartyClear', false, 'failed-thirdPartyClear'],
    ['coherent', false, 'failed-coherent'], ['safe', false, 'failed-safe'], ['learningValue', false, 'failed-learningValue'],
    ['accent', 'other-english', 'accent-mismatch'],
  ])('quarantines observed unsuitable %s', async (key, value, reason) => {
    const candidate = await segment()
    const facts = inspectionFacts()
    Object.assign(facts, { [key]: { ...facts.clarity, value } })
    expect(assessSegment(candidate, context(candidate, facts)).reasons).toContain(reason)
  })
  it('allows unknown accent only for broader listening and never grants a US accent label', async () => {
    const candidate = await segment()
    const facts = inspectionFacts()
    facts.accent = unknownInspection().accent
    const ctx = context(candidate, facts)
    expect(assessSegment(candidate, ctx).status).toBe('quarantined')
    const report = assessSegment(candidate, { ...ctx, profile: { ...profile, requireGeneralAmerican: false } })
    expect(report.status).toBe('eligible-machine-screened')
    expect(report.unknownFacts).toContain('accent')
  })
  it('rejects disabled sources, stale rights, conflicting episode licenses and missing obligations', async () => {
    const candidate = await segment()
    expect(() => parseRssFeed(rss(), { ...source(), enabled: false }, { now })).toThrow('source-disabled')
    expect(rightsReasons(source(), { ...episode(), licenseNotice: 'All rights reserved' }, use, now)).toContain('conflicting-episode-license')
    expect(rightsReasons(source(), { ...episode(), licenseNotice: 'CC BY-NC-ND 4.0' }, use, now)).toContain('conflicting-episode-license')
    expect(rightsReasons(source(), { ...episode(), licenseNotice: 'CC BY-SA 3.0' }, use, now)).toContain('conflicting-episode-license')
    expect(rightsReasons(source(), { ...episode(), licenseNotice: 'Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) License' }, use, now)).toEqual([])
    expect(rightsReasons(source(), episode(), { ...use, shareAlikeAccepted: false }, now)).toContain('rights-obligations-missing')
    expect(assessSegment(candidate, { ...context(candidate), now: now + 91 * 86_400_000 }).reasons).toContain('rights-recheck-due')
  })
  it('makes fatigue, interest, topic diversity and duplicate exposure affect actual fit', async () => {
    const candidate = await segment()
    const ctx = context(candidate)
    const baseline = assessSegment(candidate, ctx)
    expect(baseline.metrics.topics).toContain('Everyday life')
    expect(assessSegment(candidate, { ...ctx, profile: { ...profile, interests: [] } }).fit).toBeLessThan(baseline.fit!)
    expect(assessSegment(candidate, { ...ctx, profile: { ...profile, recentSourceIds: [source().id, source().id] } }).fit).toBeLessThan(baseline.fit!)
    expect(assessSegment(candidate, { ...ctx, profile: { ...profile, fatigue: 1 } }).fit).not.toBe(baseline.fit)
    expect(assessSegment(candidate, { ...ctx, profile: { ...profile, recentContentFingerprints: [candidate.contentFingerprint] } }).fit).toBeNull()
    expect(textMetrics(candidate, []).lexicalCoverage).toBe(0)
    expect(textMetrics(candidate, candidate.transcript.split(/\s+/)).lexicalCoverage).toBe(1)
  })
})

describe('Material boundary and recurring supply policy', () => {
  const lesson = { question: 'What did the friends decide to do?', answer: 'They cooked dinner together.', keywords: ['dinner', 'friends'],
    chunks: [{ text: 'come over', meaningEn: 'visit someone at home', meaningZh: '来做客', example: 'Can you come over on Saturday?' }], evidenceId: 'fixture-lesson-check' }
  it('requires eligible audio AND lesson enrichment, returning relative sentence timings alongside unchanged Material shape', async () => {
    const candidate = await segment(40)
    const converted = toMaterial(candidate, context(candidate), lesson, now)
    expect(converted.material).toMatchObject({ approved: true, synthetic: false, duration: 60, sourceKind: 'discovery' })
    expect(converted.material.audioPath).toBeUndefined()
    expect(converted.playback).toMatchObject({ startSeconds: 40, endSeconds: 100, audioSha256: artifact(candidate).sha256 })
    expect(converted.timedSentences[0]).toMatchObject({ startSeconds: 0, endSeconds: 10 })
    expect(converted.material.sourceLabel).toContain('machine screened')
    expect(() => toMaterial(candidate, { source: source(), now, use, profile }, lesson, now)).toThrow('candidate-not-approved')
    expect(() => toMaterial(candidate, context(candidate), { ...lesson, evidenceId: '' }, now)).toThrow('lesson-enrichment-required')
  })
  it('backs off continuing feed polls, capped at one week', () => {
    expect(nextSourcePoll(source(), now)).toBe(now + 24 * 3_600_000)
    expect(nextSourcePoll(source(), now, 1)).toBe(now + 48 * 3_600_000)
    expect(nextSourcePoll(source(), now, 100)).toBe(now + 168 * 3_600_000)
  })
  it('ships enabled sources only with checked rights and bounded feed URLs; Changelog stays disabled', () => {
    expect(ALLOWLISTED_CONTENT_SOURCES).toHaveLength(5)
    for (const approved of ALLOWLISTED_CONTENT_SOURCES) {
      expect(approved.rights).toMatchObject({ status: 'verified', license: approved.id === 'voa-everyday-grammar' ? 'VOA-public-domain' : approved.id === 'open-yap-sample' ? 'CC-BY-4.0' : 'CC-BY-SA-4.0' })
      expect(validateSourceUrl(approved.feedUrl, approved.urls.feed)).toBe(approved.feedUrl)
      for (const example of approved.examples) expect(validateSourceUrl(example.transcriptUrl, approved.urls.transcript)).toBe(example.transcriptUrl)
    }
    expect(CONTENT_SOURCES.find(s => s.id === 'changelog-friends-disabled')?.enabled).toBe(false)
  })
})

describe.runIf(process.env.LIVE_CONTENT_PIPELINE === '1')('live allowlisted publisher contracts (no paid calls or audio downloads)', () => {
  async function fetchText(url: string, rules: ContentSource['urls']['feed'], maxBytes: number) {
    let current = url
    for (let redirects = 0; redirects <= 5; redirects++) {
      validateSourceUrl(current, rules)
      const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location) throw new Error('Redirect without a location')
        current = new URL(location, current).href
        continue
      }
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const parts: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > maxBytes) throw new Error('Publisher response exceeded byte limit')
          parts.push(part.value)
        }
      } finally { await reader.cancel() }
      const combined = new Uint8Array(bytes)
      let offset = 0
      for (const part of parts) { combined.set(part, offset); offset += part.length }
      return new TextDecoder('utf-8', { fatal: true }).decode(combined)
    }
    throw new Error('Publisher redirect limit exceeded')
  }
  it.each(ALLOWLISTED_CONTENT_SOURCES.filter(source => source.supply !== 'archive-supplement'))('$id continues to expose a safe feed and at least one parseable recent timed transcript', async source => {
    const checkedAt = Date.now()
    const xml = await fetchText(source.feedUrl, source.urls.feed, PIPELINE_LIMITS.feedBytes)
    const batch = parseRssFeed(xml, source, { now: checkedAt, maxItems: 3 })
    expect(batch.episodes.length).toBeGreaterThan(0)
    expect(batch.episodes.some(item => item.publishedAt !== null && checkedAt - item.publishedAt < 30 * 86_400_000)).toBe(true)
    const held: { guid: string; reason: string }[] = []
    for (const item of batch.episodes) {
      const ref = item.transcripts[0]
      if (!ref) continue
      const text = await fetchText(ref.url, source.urls.transcript, PIPELINE_LIMITS.transcriptBytes)
      try {
        // Feed duration is a publisher claim: the audio container must later supply the actual duration.
        const transcript = parseTimedTranscript(text, ref)
        const sliced = await sliceTranscript(item, transcript, source, { retrievedAt: checkedAt, maxSegments: 3 })
        expect(sliced.segments.length).toBeGreaterThan(0)
        for (const candidate of sliced.segments) {
          expect(assessSegment(candidate, { source, now: checkedAt, profile, use }).status).toBe('quarantined')
        }
        console.info(JSON.stringify({ source: source.id, episode: item.guid, cues: transcript.cues.length,
          candidateSegments: sliced.segments.length, held, audioInspected: false }))
        return
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'invalid-or-overlapping-timing') throw error
        held.push({ guid: item.guid, reason: error.message })
      }
    }
    throw new Error(`No parseable recent transcript: ${JSON.stringify(held)}`)
  }, 60_000)
})
