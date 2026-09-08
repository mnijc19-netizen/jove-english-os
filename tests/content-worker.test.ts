import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ALLOWLISTED_CONTENT_SOURCES, OPEN_YAP_SAMPLE_SOURCE } from '../src/content/sources'
import type { ContentSource, Inspection, ObservationEvidence, TimedTranscript } from '../src/content/pipeline-types'
import { createContentFetcher, fetchContentResource, isPublicContentAddress, type ContentFetcher } from '../src/server/content-network'
import { parseRssFeed, parseOpenYapPreviewManifest, validateSourceUrl } from '../src/content/pipeline'
import { extractContentPolicy, revalidateContentRights } from '../src/server/content-rights'
import { contentAudioDuration, contentAudioWindow, createContentAudioServices } from '../src/server/content-audio'
import { auditVoaLessonCandidates } from '../src/server/content-voa'
import { contentPublicOrigin, contentSignedPlaybackUrl, createContentBudget, createContentHandler } from '../src/server/content'
import { GatewayError, type OwnerContext } from '../src/server/gateway'
import {
  recordContentLearningUse, runContentRefresh, selectAndPersistContentLessons,
  type ContentAdminClient, type ContentAudioAnalyzer, type ContentAudioStore, type ContentBudget,
  type ContentRefreshOptions, type EligibleContentLesson, type PersistedContentSegment,
} from '../src/server/content-worker'

const origin = 'https://publisher.example.org'
const ownerId = 'a982f59e-e181-414c-8073-07eac47e12d2'
const now = Date.now()
const policyHtml = '<footer>Our shows are licensed under Creative Commons BY-SA 4.0</footer>'
const rightsPolicies = [{ url: `${origin}/policy`, extractor: 'jb-footer' as const,
  sha256: createHash('sha256').update(policyHtml).digest('hex') }]
function testSource(id = 'test-content-unit'): ContentSource {
  return { ...structuredClone(ALLOWLISTED_CONTENT_SOURCES[0]!), id, name: 'Original test content', verifiedAt: now,
    rights: { ...structuredClone(ALLOWLISTED_CONTENT_SOURCES[0]!.rights), evidenceUrls: [`${origin}/policy`] },
    feedUrl: `${origin}/feed`, homepage: origin,
    urls: { feed: [{ origin, pathPrefix: '/feed' }], page: [{ origin, pathPrefix: '/episode/' }],
      audio: [{ origin, pathPrefix: '/audio/' }], transcript: [{ origin, pathPrefix: '/transcript/' }] }, examples: [] }
}
// Original fixture prose; the fake audio and analyzer below exist ONLY in tests, never in a production module.
const phrases = [
  'My friends came to our home last weekend and we decided to cook dinner together before watching a new movie.',
  'I went shopping early in the morning because we needed fresh vegetables and some bread from the little local shop.',
  'When everyone arrived, I asked each friend to choose a simple job so that we could prepare the meal together.',
  'One friend brought a book about camping, which gave us an idea for another trip when the weather gets warmer.',
  'We talked about the music we liked and the hobbies we wanted to try while the food was slowly cooking.',
  'After dinner we cleaned the kitchen, made some tea, and agreed to meet again at the same time next month.',
]
const vtt = `WEBVTT\n\n${phrases.map((text, i) => `00:00:${String(i * 10).padStart(2, '0')}.000 --> ${i === 5 ? '00:01:00' : `00:00:${String((i + 1) * 10).padStart(2, '0')}`}.000\n<v Alice>${text}</v>`).join('\n\n')}\n`
function rss(withTranscript = true) { return `<?xml version="1.0"?><rss version="2.0" xmlns:p="https://podcastindex.org/namespace/1.0"><channel><title>Test</title>
<item><title>A weekend at home</title><guid>one</guid><link>${origin}/episode/one</link>
<enclosure url="${origin}/audio/one.mp3" type="audio/mpeg" length="10"/>
${withTranscript ? `<p:transcript url="${origin}/transcript/one.vtt" type="text/vtt"/>` : ''}</item></channel></rss>` }
const fixtureAudio = pcmFixture(70)
const events: string[] = []
function makeStore(): ContentAudioStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>()
  return { blobs, async put(path, bytes) { events.push('audio-saved'); blobs.set(path, bytes.slice()) },
    async get(path) { const value = blobs.get(path); if (!value) throw new Error('Missing fixture'); return value.slice() },
    async remove(paths) { for (const path of paths) blobs.delete(path) } }
}
function facts(): Inspection {
  const evidence: ObservationEvidence = { id: 'SYNTHETIC-TEST-ONLY', method: 'machine-audio-analysis', analyzer: 'test-only', version: 'v1', assessedAt: now, confidence: 0.95 }
  return Object.fromEntries(Object.entries({ humanSpeech: true, englishSpeech: true, accent: 'general-american', clarity: 0.9,
    noiseFraction: 0.01, musicFraction: 0, speakerCount: 2, transcriptAlignment: 0.96, coherent: true, safe: true, thirdPartyClear: true, learningValue: true })
    .map(([key, value]) => [key, { status: 'observed', value, evidence: { ...evidence } }])) as Inspection
}
const usage = { costUsd: null, units: 1, unitName: 'test-request', provider: 'fixture-only', model: 'fixture-only' }
const analyzer: ContentAudioAnalyzer = async request => {
  events.push('analyze')
  expect(events.indexOf('audio-saved')).toBeLessThan(events.indexOf('budget-reserved'))
  expect(events.indexOf('budget-reserved')).toBeLessThan(events.indexOf('analyze'))
  const window = contentAudioWindow(request.audio.bytes, request.audio.mimeType, request.interval.startSeconds, request.interval.endSeconds)
  return { requestFingerprint: request.requestFingerprint, audioSha256: request.audio.sha256,
    audioDurationSeconds: window.originalDurationSeconds, inspectedStartSeconds: request.interval.startSeconds, inspectedEndSeconds: request.interval.endSeconds,
    audioEvidence: { providerRequestId: 'SYNTHETIC-TEST-ONLY', originalAudioSha256: request.audio.sha256,
      submittedAudioSha256: createHash('sha256').update(window.bytes).digest('hex'), submittedStartSeconds: window.originSeconds,
      submittedEndSeconds: window.endSeconds, inspectedStartSeconds: request.interval.startSeconds, inspectedEndSeconds: request.interval.endSeconds,
      timingBasis: window.timingBasis, heard: [] },
    facts: facts(), rightsRecord: { sourceId: request.segment.sourceId, sourcePolicyHash: request.sourcePolicyHash,
      evidenceId: 'SYNTHETIC-TEST-ONLY', checkedAt: now, method: 'trusted-source-policy-and-audio-screen', thirdParty: 'none-detected',
      evidenceUrls: [...request.sourcePolicy.evidenceUrls] },
    lesson: { question: 'What did the friends decide to do?', answer: 'They cooked dinner together.', keywords: ['friends', 'dinner'],
      chunks: [{ text: 'come over', meaningEn: 'visit someone at home', meaningZh: '来做客', example: 'Can you come over this weekend?' }], evidenceId: 'TEST-LESSON' }, usage }
}
function budget(allowed = true): ContentBudget {
  return { async reserve() { events.push('budget-reserved'); return { allowed, acquired: true, reservationId: 'test-budget' } },
    async settle(input) { events.push(`budget-${input.status}`) } }
}
function fetcher(feed = rss()): ContentFetcher {
  return async request => {
    if (request.role === 'page') return { status: 200, finalUrl: request.url, body: new TextEncoder().encode(policyHtml),
      etag: null, lastModified: null, retryAfter: null, contentType: 'text/html', dnsPinning: 'injected' }
    const isFeed = request.role === 'feed'
    return { status: isFeed && request.etag ? 304 : 200, finalUrl: request.url,
      body: isFeed && request.etag ? new Uint8Array() : request.role === 'audio' ? fixtureAudio.slice() : new TextEncoder().encode(isFeed ? feed : vtt),
      etag: isFeed ? '"test-feed-v1"' : null, lastModified: null, retryAfter: null,
      contentType: isFeed ? 'application/rss+xml' : request.role === 'audio' ? 'audio/wav' : 'text/vtt', dnsPinning: 'injected' }
  }
}

type DbItem = { id: string; revision: string; episode: unknown; status: string; attempts: number; transcript: TimedTranscript | null;
  saved_segments: PersistedContentSegment[]; object_path: string | null; audio_sha256: string | null; audio_mime: string | null }
class MemoryRpc implements ContentAdminClient {
  items = new Map<string, DbItem>()
  records = new Map<string, PersistedContentSegment>()
  recommendations: { id: string; request_id: string; segment_id: string; lesson: EligibleContentLesson }[] = []
  calls: { action: string; args: Record<string, unknown> }[] = []
  etag: string | null = null
  config = testSource()
  locked = false
  rightsStatus = 'unchecked'
  rightsDue = true
  rightsCheckedAt: string | null = null
  async rpc(_name: string, input?: Record<string, unknown>) {
    const action = input!.action as string, args = input!.args as Record<string, unknown>
    this.calls.push({ action, args: structuredClone(args) })
    let data: unknown = {}
    const item = this.items.get(args.itemId as string)
    if (action === 'owner') data = { ownerId }
    else if (action === 'retention') data = []
    else if (action === 'claim') { this.config = args.source as ContentSource; data = { acquired: !this.locked, feedDue: true, etag: this.etag,
      rightsDue: this.rightsDue, rights_status: this.rightsStatus, rights_checked_at: this.rightsCheckedAt }; this.locked = true }
    else if (action === 'rights-check') {
      const check = args.check as { status: string; checkedAt: number }
      if (check.status !== 'unavailable') this.rightsStatus = check.status
      if (check.status === 'verified') { this.rightsCheckedAt = new Date(check.checkedAt).toISOString(); this.config.verifiedAt = check.checkedAt }
    }
    else if (action === 'release') this.locked = false
    else if (action === 'ingest') {
      let changed = 0
      for (const row of args.items as { id: string; revision: string; episode: unknown }[]) {
        if (!this.items.has(row.id)) { this.items.set(row.id, { ...row, attempts: 0, status: 'pending', transcript: null, saved_segments: [], object_path: null, audio_sha256: null, audio_mime: null }); changed++ }
      }
      data = { changed }
    } else if (action === 'poll') this.etag = args.etag as string | null
    else if (action === 'pending') data = [...this.items.values()].filter(item => ['pending', 'retry'].includes(item.status) || args.canAnalyze && item.status === 'awaiting-analysis')
      .map(item => ({ ...item, saved_segments: [...this.records.values()] }))
    else if (action === 'checkpoint') item!.transcript = args.transcript as TimedTranscript
    else if (action === 'asset') { item!.object_path = args.objectPath as string; item!.audio_sha256 = args.sha256 as string; item!.audio_mime = args.mimeType as string }
    else if (action === 'save-segment') { const record = args.record as PersistedContentSegment; this.records.set(record.segment.id, structuredClone(record)) }
    else if (action === 'finish-item') { item!.status = args.status as string; item!.attempts++ }
    else if (action === 'candidates') data = { candidates: [...this.records.values()].filter(record => record.status === 'eligible').map(record => ({ id: record.segment.id, record, config: this.config })), recent: this.recommendations }
    else if (action === 'recommend') {
      for (const lesson of args.lessons as EligibleContentLesson[]) if (!this.recommendations.some(row => row.request_id === args.requestId && row.segment_id === lesson.segmentId))
        this.recommendations.push({ id: crypto.randomUUID(), request_id: args.requestId as string, segment_id: lesson.segmentId, lesson })
      data = this.recommendations.filter(row => row.request_id === args.requestId)
    }
    return { data: structuredClone(data), error: null }
  }
}
function options(db = new MemoryRpc()): ContentRefreshOptions & { adminClient: MemoryRpc } {
  events.length = 0
  return { adminClient: db, sources: [testSource()], rightsPolicies, ownerId, now: () => now, fetcher: fetcher(), audioStore: makeStore(),
    analyzerVersion: 'fixture-v1', transcriberVersion: 'fixture-v1', budget: budget(), costCeilings: { analysisUsd: 0.1, transcriptionUsd: 0.1 },
    limits: { episodesPerSource: 1, segmentsPerEpisode: 1 }, transcriptOrigin: 'https://owner-backend.example.org' }
}

describe('content worker state transitions and inspection boundary', () => {
  it('persists source metadata, transcripts, timed segments and unknown scores without downloading audio', async () => {
    const opts = options()
    const requests: string[] = []
    const original = opts.fetcher!
    opts.fetcher = async request => { requests.push(request.role); return original(request) }
    const result = await runContentRefresh(opts)
    expect(result).toMatchObject({ itemsDiscovered: 1, itemsProcessed: 1, segmentsSaved: 1, eligibleSegments: 0, recommendations: [] })
    expect(result.nextGates).toContain('audio-analyzer-unconfigured')
    expect(requests).toEqual(['page', 'feed', 'transcript'])
    expect([...opts.adminClient.items.values()][0]?.status).toBe('awaiting-analysis')
    expect([...opts.adminClient.records.values()][0]?.quality).toMatchObject({ status: 'quarantined', quality: null })
  })
  it('resumes quarantined metadata on 304 when the real analyzer contract becomes available and persists a lesson', async () => {
    const opts = options()
    await runContentRefresh(opts)
    opts.analyzeAudio = analyzer
    const result = await runContentRefresh(opts)
    expect(result.errors).toEqual([])
    expect(result).toMatchObject({ feedsUnchanged: 1, itemsDiscovered: 0, eligibleSegments: 1 })
    expect(result.recommendations).toHaveLength(1)
    expect(result.recommendations[0]?.playback).toMatchObject({ bucket: 'jove-content-audio', startSeconds: 0, endSeconds: 60 })
    expect(result.recommendations[0]?.material.audioPath).toBeUndefined()
    const playback = result.recommendations[0]!.playback
    expect(playback.objectPath).toMatch(/^clips\/[a-f0-9]{64}\/[a-f0-9]{64}$/u)
    const saved = await opts.audioStore!.get(playback.objectPath)
    expect(createHash('sha256').update(saved).digest('hex')).toBe(playback.audioSha256)
    expect(playback.sourceAudioSha256).toBe(createHash('sha256').update(fixtureAudio).digest('hex'))
    expect(playback.audioSha256).not.toBe(playback.sourceAudioSha256)
    expect(contentAudioDuration(saved, playback.mimeType)).toBe(60)
    expect(saved.length).toBeLessThan(fixtureAudio.length)
    expect(opts.adminClient.calls.some(call => call.action === 'usage')).toBe(true)
  })
  it('rejects analysis that does not bind the actual persisted clip bytes', async () => {
    const opts = options()
    opts.analyzeAudio = async input => { const result = await analyzer(input); result.audioEvidence!.submittedAudioSha256 = 'f'.repeat(64); return result }
    const result = await runContentRefresh(opts)
    expect(result.recommendations).toEqual([])
    expect(result.nextGates).toContain('content-clip-analysis-binding-mismatch')
    expect([...opts.adminClient.records.values()].every(row => row.status === 'quarantined')).toBe(true)
    expect(opts.adminClient.calls.some(call => call.action === 'clip')).toBe(false)
  })
  it('records bounded clip capacity before upload and ready before eligible publication', async () => {
    const opts=options();opts.analyzeAudio=analyzer
    await runContentRefresh(opts)
    const calls=opts.adminClient.calls
    expect(calls.findIndex(c=>c.action==='clip')).toBeLessThan(calls.findIndex(c=>c.action==='clip-ready'))
    expect(calls.findIndex(c=>c.action==='clip-ready')).toBeLessThan(calls.findIndex(c=>c.action==='save-segment'&&(c.args.record as PersistedContentSegment).status==='eligible'))
  })
  it('deduplicates accepted work and never invokes a paid callback twice', async () => {
    const opts = options()
    opts.analyzeAudio = vi.fn(analyzer)
    await runContentRefresh(opts)
    await runContentRefresh(opts)
    expect(opts.adminClient.items.size).toBe(1)
    expect(opts.adminClient.records.size).toBe(1)
    expect(opts.analyzeAudio).toHaveBeenCalledTimes(1)
  })
  it('requires budget, storage, version and explicit cost ceilings before calling an analyzer', async () => {
    for (const field of ['budget', 'audioStore', 'analyzerVersion', 'costCeilings'] as const) {
      const opts = options()
      opts.analyzeAudio = vi.fn(analyzer)
      delete opts[field]
      const result = await runContentRefresh(opts)
      expect(opts.analyzeAudio).not.toHaveBeenCalled()
      expect(result.eligibleSegments).toBe(0)
      expect(result.nextGates.length).toBeGreaterThan(0)
    }
  })
  it('saves work but does not call the provider when the budget is denied or needs reconciliation', async () => {
    for (const replay of [false, true]) {
      const opts = options()
      opts.analyzeAudio = vi.fn(analyzer)
      opts.budget = { ...budget(), reserve: async () => ({ allowed: replay, acquired: false, reservationId: 'old', replay }) }
      const result = await runContentRefresh(opts)
      expect(opts.analyzeAudio).not.toHaveBeenCalled()
      expect(result.eligibleSegments).toBe(0)
      expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(1)
    }
  })
  it.each(['hash', 'interval', 'rights', 'text-only', 'no-lesson', 'unknown-rights'])('does not approve %s evidence', async kind => {
    const opts = options()
    opts.analyzeAudio = async request => {
      const output = await analyzer(request)
      if (kind === 'hash') output.audioSha256 = 'b'.repeat(64)
      if (kind === 'interval') output.inspectedEndSeconds--
      if (kind === 'rights') output.rightsRecord.sourcePolicyHash = 'b'.repeat(64)
      if (kind === 'no-lesson') delete output.lesson
      if (kind === 'unknown-rights') output.rightsRecord.thirdParty = 'uncertain'
      if (kind === 'text-only') for (const value of Object.values(output.facts)) if (value.status === 'observed') value.evidence.method = 'machine-text-analysis'
      return output
    }
    const result = await runContentRefresh(opts)
    expect(result.eligibleSegments).toBe(0)
    expect(result.recommendations).toEqual([])
    expect([...opts.adminClient.records.values()].every(row => row.status === 'quarantined')).toBe(true)
  })
  it('preserves an unknown provider outcome and saved audio on timeout/failure', async () => {
    const opts = options()
    opts.analyzeAudio = async () => { throw new Error('Raw provider error must not enter history') }
    const result = await runContentRefresh(opts)
    expect(events).toContain('budget-uncertain')
    expect(JSON.stringify(result)).not.toContain('Raw provider')
    expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(1)
  })
  it('keeps spending at zero when the worker deadline expires before provider dispatch', async () => {
    // Keep real I/O/microtasks running, but advance the deadline only at an observed boundary.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let releaseFeed!: () => void
    const feedBlocked = new Promise<void>(resolve => { releaseFeed = resolve })
    try {
      const opts = options(), originalFetch = opts.fetcher!
      opts.limits = { ...opts.limits, runMs: 20 }
      let observeFeed!: () => void
      const feedStarted = new Promise<void>(resolve => { observeFeed = resolve })
      opts.fetcher = async request => {
        if (request.role === 'feed') { observeFeed(); await feedBlocked }
        return originalFetch(request)
      }
      const inspect = vi.fn(analyzer), reserve = vi.fn(opts.budget!.reserve), settle = vi.fn(opts.budget!.settle)
      opts.analyzeAudio = inspect; opts.budget = { reserve, settle }
      const running = runContentRefresh(opts)
      await feedStarted
      await vi.advanceTimersByTimeAsync(20)
      releaseFeed()
      const result = await running
      expect(result.nextGates).toContain('content-run-timeout-or-cancelled')
      expect(inspect).not.toHaveBeenCalled()
      expect(reserve).not.toHaveBeenCalled()
      expect(settle).not.toHaveBeenCalled()
      expect(opts.adminClient.calls.filter(call => call.action === 'usage')).toEqual([])
      expect(events.filter(event => event.startsWith('budget-'))).toEqual([])
      expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(0)
      expect(result.eligibleSegments).toBe(0)
    } finally { releaseFeed(); vi.useRealTimers() }
  })
  it('keeps a dispatched provider outcome uncertain when the worker deadline expires despite ignored cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const opts = options()
      opts.limits = { ...opts.limits, runMs: 20 }
      let observeDispatch!: () => void
      const dispatched = new Promise<void>(resolve => { observeDispatch = resolve })
      const inspect = vi.fn<ContentAudioAnalyzer>(() => {
        observeDispatch()
        return new Promise(() => {}) // An actually invoked provider that never acknowledges cancellation.
      })
      const reserve = vi.fn(opts.budget!.reserve), settle = vi.fn(opts.budget!.settle)
      opts.analyzeAudio = inspect; opts.budget = { reserve, settle }
      const running = runContentRefresh(opts)
      // Do not poll with vi.waitFor here: it automatically advances fake timers before dispatch.
      await dispatched
      expect(inspect).toHaveBeenCalledOnce()
      expect(reserve).toHaveBeenCalledOnce()
      expect(settle).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(20)
      const result = await running
      expect(result.nextGates).toContain('content-run-timeout-or-cancelled')
      expect(settle).toHaveBeenCalledExactlyOnceWith({ reservationId: 'test-budget', status: 'uncertain', usage: null })
      expect(events.filter(event => event.startsWith('budget-'))).toEqual(['budget-reserved', 'budget-uncertain'])
      expect(opts.adminClient.calls.filter(call => call.action === 'usage').map(call => call.args.status)).toEqual(['uncertain'])
      expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(1)
      expect(result.eligibleSegments).toBe(0)
      expect(result.recommendations).toEqual([])
    } finally { vi.useRealTimers() }
  })
  it('does not checkpoint ETag after a malformed or malicious feed; honors Retry-After', async () => {
    const opts = options()
    opts.fetcher = fetcher('<!DOCTYPE rss><rss/>')
    await runContentRefresh(opts)
    expect(opts.adminClient.etag).toBeNull()
    const rate = options()
    rate.fetcher = async request => request.role === 'page' ? fetcher()(request) : ({ ...(await fetcher()(request)), status: 429, retryAfter: '7200' })
    await runContentRefresh(rate)
    expect(rate.adminClient.calls.find(call => call.action === 'release')?.args.retrySeconds).toBe(7200)
  })
  it('skips competing leases but actually revalidates expired registry evidence rather than stopping supply', async () => {
    const opts = options(); opts.adminClient.locked = true; opts.fetcher = vi.fn(fetcher())
    expect((await runContentRefresh(opts)).sourcesSkipped).toBe(1)
    expect(opts.fetcher).not.toHaveBeenCalled()
    const expired = options(); expired.now = () => now + 91 * 86_400_000; expired.fetcher = vi.fn(fetcher())
    expect((await runContentRefresh(expired)).nextGates).not.toContain('source-rights-recheck-required')
    expect(expired.fetcher).toHaveBeenCalled()
  })
  it.each([undefined, 'http://127.0.0.1:55321', 'http://kong:8000'])('processes and resumes stored STT without a fetchable transcript origin (%s)', async transcriptOrigin => {
    const opts = options(); opts.fetcher = fetcher(rss(false)); opts.transcriptOrigin = transcriptOrigin
    opts.transcribe = async request => ({ audioSha256: request.audio.sha256, requestFingerprint: request.requestFingerprint, audioDurationSeconds: 70,
      provider: 'fixture-stt', evidenceId: 'TEST-STT', usage, transcriptJson: JSON.stringify({ version: '1.0.0', segments: phrases.map((body, i) => ({ startTime: i * 10, endTime: (i + 1) * 10, body })) }) })
    const first = await runContentRefresh(opts)
    expect(first.errors).toEqual([])
    expect(first.eligibleSegments).toBe(0)
    const stored = [...opts.adminClient.items.values()][0]!
    expect(stored.transcript?.reference).toMatchObject({ origin: 'authorized-stt', url: `urn:jove:content-transcript:${stored.id}`,
      derivation: { audioDurationSeconds: 70 } })
    // The publisher's original duration cannot override the actual saved media duration on resume.
    ;(stored.episode as { durationSeconds: number | null }).durationSeconds = 1
    opts.analyzeAudio = analyzer
    const transcribe = vi.fn(opts.transcribe); opts.transcribe = transcribe
    const result = await runContentRefresh(opts)
    expect(result.errors).toEqual([])
    expect(result.eligibleSegments).toBe(1)
    expect(transcribe).not.toHaveBeenCalled()
    expect(result.recommendations[0]?.material.license).toContain('machine-transcribed')
  })
  it('writes recommendation and usage history idempotently; fit still requires observed General American when requested', async () => {
    const opts = options(); opts.analyzeAudio = analyzer
    await runContentRefresh(opts)
    const selection = { adminClient: opts.adminClient, ownerId, sources: [testSource()], profile: { targetDifficulty: 0.4, fatigue: 0, interests: ['Everyday life'], requireGeneralAmerican: true }, requestId: 'same-plan', now: () => now }
    const first = await selectAndPersistContentLessons(selection)
    expect(await selectAndPersistContentLessons(selection)).toEqual(first)
    await recordContentLearningUse({ adminClient: opts.adminClient, ownerId, segmentId: first[0]!.segmentId, eventId: 'attempt-one', event: 'started' })
    expect(opts.adminClient.calls.at(-1)?.action).toBe('learning-use')
  })
})

describe('real default network policy', () => {
  it('allows only the public sample MP3 paths and its observed dataset-specific signed CDN hop', () => {
    const source = OPEN_YAP_SAMPLE_SOURCE
    const path = 'https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k/resolve/main/preview/conv_d4005da6db98.mp3'
    expect(validateSourceUrl(path, source.urls.audio)).toBe(path)
    const cdn = new URL('https://us.aws.cdn.hf.co/xet-bridge-us/6a97e8aabe471b1b359f7cd6/' + 'a'.repeat(64))
    cdn.search = new URLSearchParams({ 'response-content-disposition': 'inline; filename="conv_d4005da6db98.mp3"',
      user_id: 'synthetic', 'X-Xet-Cas-Uid': 'synthetic', 'response-content-type': 'audio/mpeg', Expires: '1999999999',
      Policy: 'SYNTHETIC', Signature: 'SYNTHETIC', 'Key-Pair-Id': 'SYNTHETIC' }).toString()
    expect(validateSourceUrl(cdn.href, source.urls.audio)).toBe(cdn.href)
    for (const invalid of [path.replace('/preview/conv_d4005da6db98.mp3', '/shard-00000.tar'), path.replace('open-yap-1k', 'unreviewed'),
      cdn.href.replace('6a97e8aabe471b1b359f7cd6', '000000000000000000000000'), cdn.href + '&target=https://localhost', cdn.href + '&Expires=1999999999']) {
      expect(() => validateSourceUrl(invalid, source.urls.audio)).toThrow('url-not-allowlisted')
    }
  })
  it.each(['0.0.0.0','10.2.3.4','127.0.0.1','169.254.169.254','172.31.0.1','192.168.1.1','100.64.0.1','192.0.2.1',
    '198.51.100.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2001::453f:b08f','2002:7f00::1','3fff::1','64:ff9b::1'])(
    'rejects non-public DNS answer %s', address => expect(isPublicContentAddress(address)).toBe(false))
  it.each(['1.1.1.1','8.8.8.8','93.184.215.14','2606:4700::1111','2001:4860:4860::8888'])(
    'accepts publicly routable address %s', address => expect(isPublicContentAddress(address)).toBe(true))
  it('rejects mixed public/private DNS answers before opening a socket', async () => {
    const transport = vi.fn()
    const safe = createContentFetcher({ resolve: async () => ['1.1.1.1','127.0.0.1'], transport })
    await expect(safe({ url: `${origin}/feed`, source: testSource(), role: 'feed', maxBytes: 1000 })).rejects.toThrow('non-public-dns-answer')
    expect(transport).not.toHaveBeenCalled()
  })
  it('validates each manual redirect and never forwards secrets or arbitrary headers', async () => {
    const capturedHeaders: Record<string, string>[] = []
    const transport = vi.fn(async (_url: string, _addresses: string[], headers: Record<string, string>) => {
      capturedHeaders.push(headers)
      return { status: 302, body: new Uint8Array(), headers: new Headers({ location: 'https://127.0.0.1/private' }) }
    })
    const safe = createContentFetcher({ resolve: async () => ['1.1.1.1'], transport })
    await expect(safe({ url: `${origin}/feed`, source: testSource(), role: 'feed', maxBytes: 1000 })).rejects.toThrow('unsafe-url')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(Object.keys(capturedHeaders[0]!)).not.toContain('authorization')
  })
  it('caps redirects and reports the exact injected transport boundary', async () => {
    const transport = vi.fn(async () => ({ status: 302, body: new Uint8Array(), headers: new Headers({ location: `${origin}/feed` }) }))
    const safe = createContentFetcher({ resolve: async () => ['1.1.1.1'], transport })
    await expect(safe({ url: `${origin}/feed`, source: testSource(), role: 'feed', maxBytes: 1000 })).rejects.toThrow('too-many-redirects')
    expect(transport).toHaveBeenCalledTimes(6)
  })
})

describe('scheduled rights revalidation', () => {
  it('binds the complete sample license and privacy rider, not merely the CC label', async () => {
    const text = 'Open Yap 1K — sample dataset\nSYNTHETIC TEST ONLY CC-BY-4.0\nRIDER: no speaker identification.\nSection 8 -- Interpretation.'
    const url = OPEN_YAP_SAMPLE_SOURCE.rights.evidenceUrls[0]!
    const evidence = [{ url, extractor: 'open-yap-license' as const,
      sha256: createHash('sha256').update(extractContentPolicy(text, 'open-yap-license')).digest('hex') }]
    for (const variation of ['unchanged', 'rider', 'scope', 'html']) {
      const body = variation === 'rider' ? text.replace('no speaker identification', 'additional publication restriction') :
        variation === 'scope' ? text.replace('sample dataset', 'separate full corpus') : text
      const result = await revalidateContentRights({ source: OPEN_YAP_SAMPLE_SOURCE, evidence,
        fetcher: async () => ({ status: 200, finalUrl: url, body: new TextEncoder().encode(body), etag: null,
          lastModified: null, retryAfter: null, contentType: variation === 'html' ? 'text/html' : 'text/plain', dnsPinning: 'injected' }) })
      expect(result.status).toBe(variation === 'unchanged' ? 'verified' : variation === 'html' ? 'unavailable' : 'changed')
    }
  })
  it.each(['unchanged', 'changed', 'unavailable'])('explicitly retries an unverified policy during backoff without approving %s evidence blindly', async state => {
    const opts = options()
    opts.adminClient.rightsDue = false
    const original = opts.fetcher!
    const requests: string[] = []
    opts.fetcher = async request => {
      requests.push(request.role)
      const response = await original(request)
      if (request.role !== 'page' || state === 'unchanged') return response
      return state === 'unavailable' ? { ...response, status: 503 } :
        { ...response, body: new TextEncoder().encode(policyHtml.replace('</footer>', 'Except this show.</footer>')) }
    }
    await runContentRefresh(opts)
    expect(requests).toEqual([])
    expect(opts.adminClient.rightsStatus).toBe('unchecked')
    opts.forcePoll = true
    const result = await runContentRefresh(opts)
    expect(requests[0]).toBe('page')
    expect(opts.adminClient.calls.filter(call => call.action === 'rights-check')).toHaveLength(1)
    if (state === 'unchanged') {
      expect(opts.adminClient.rightsStatus).toBe('verified')
      expect(result.itemsDiscovered).toBe(1)
      expect(requests).toEqual(['page', 'feed', 'transcript'])
    } else {
      expect(opts.adminClient.rightsStatus).not.toBe('verified')
      expect(opts.adminClient.rightsCheckedAt).toBeNull()
      expect(result.itemsDiscovered).toBe(0)
      expect(requests).toEqual(['page'])
      expect(result.nextGates).toContain('source-rights-recheck-required')
    }
  })
  it('allows only the observed signed ART19 audio shape, not a wildcard CDN or query', () => {
    const rules=ALLOWLISTED_CONTENT_SOURCES.find(s=>s.id==='jb-linux-unplugged')!.urls.audio
    const path=`https://content.production.cdn.art19.com/validation=1788941300,d5179406-df6b-56e1-98ee-b124b1df8de2,abcdefghijklmnopqrstuvw/episodes/d12d00dc-a590-4ec0-8446-7c2136304bae/${'a'.repeat(128)}/20260906-example.mp3`
    expect(validateSourceUrl(path,rules)).toBe(path)
    for(const url of [path+'?redirect=https://private.invalid',path.replace('/validation=','/other='),path.replace('.mp3','.html'),path.replace('/episodes/','/account/')]) expect(()=>validateSourceUrl(url,rules)).toThrow()
  })
  it('permits only the two reviewed VOA feed query values, never arbitrary search/count URLs', () => {
    const source=ALLOWLISTED_CONTENT_SOURCES.find(source=>source.id==='voa-everyday-grammar')!
    expect(validateSourceUrl(source.feedUrl,source.urls.feed)).toBe(source.feedUrl)
    for(const query of ['zoneId=1','zoneId=4456&count=9999','zoneId=4456&zoneId=987','url=https://localhost']) {
      expect(()=>validateSourceUrl(`https://learningenglish.voanews.com/podcast/?${query}`,source.urls.feed)).toThrow()
    }
  })
  it('renews only unchanged applicable policy evidence and preserves the actual body hash', async () => {
    const result = await revalidateContentRights({ source: testSource(), evidence: rightsPolicies, fetcher: fetcher(), now: () => now + 200 * 86_400_000 })
    expect(result.status).toBe('verified')
    expect(result.evidence[0]?.observedHash).toBe(rightsPolicies[0]!.sha256)
    expect(result.evidence[0]?.bodyHash).toBe(rightsPolicies[0]!.sha256)
    expect(result.checkedAt).toBe(now + 200 * 86_400_000)
  })
  it('holds changed policy blocks, scripts inside evidence, unknown baselines and unexpected redirects', async () => {
    for (const change of ['changed','script','redirect','baseline'] as const) {
      const result = await revalidateContentRights({ source: testSource(), evidence: change === 'baseline' ? [] : rightsPolicies,
        fetcher: async request => ({ ...(await fetcher()(request)), finalUrl: change === 'redirect' ? `${origin}/elsewhere` : request.url,
          body: new TextEncoder().encode(change === 'script' ? policyHtml.replace('</footer>','<script>doBadThings()</script></footer>') :
            change === 'changed' ? policyHtml.replace('</footer>','Except this show.</footer>') : policyHtml) }) })
      expect(result.status).toBe('changed')
    }
    expect(() => extractContentPolicy('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]>', 'jb-footer')).toThrow()
  })
  it('does not renew on 304 or network failure and checks the policy before feed ingestion', async () => {
    const result = await revalidateContentRights({ source: testSource(), evidence: rightsPolicies,
      fetcher: async request => ({ ...(await fetcher()(request)), status: 304 }) })
    expect(result.status).toBe('unavailable')
    const opts = options(); opts.fetcher = async request => ({ ...(await fetcher()(request)), body: new TextEncoder().encode(policyHtml.replace('4.0','NO')) })
    expect((await runContentRefresh(opts)).itemsDiscovered).toBe(0)
    expect(opts.adminClient.calls.some(call => call.action === 'ingest')).toBe(false)
  })
  it('enforces exact policy URLs on every redirect before a second socket', async () => {
    const transport = vi.fn(async () => ({ status: 302, body: new Uint8Array(), headers: new Headers({ location: `${origin}/feed/other` }) }))
    const safe = createContentFetcher({ resolve: async () => ['1.1.1.1'], transport })
    const source = testSource(); source.urls.feed = [{ origin, pathPrefix: '/' }]
    await expect(safe({ url: `${origin}/feed`, exactUrls: [`${origin}/feed`], source, role: 'feed', maxBytes: 1000 })).rejects.toThrow('unapproved-exact-url')
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

describe.runIf(process.env.JOVE_CONTENT_AUDIO_PROBE==='1')('actual public audio bytes and current policy evidence (no paid analysis)',()=>{
  it('binds three exact VOA everyday scene pages to their real audio and frame clips without promoting candidates', async () => {
    const results = await auditVoaLessonCandidates({ probeAudio: true })
    expect(results).toHaveLength(3)
    for (const row of results) {
      expect(row.rights.status).toBe('verified')
      expect(row.candidate.eligible).toBe(false)
      expect(row.candidate.publisherTranscript.text.length).toBeGreaterThan(500)
      expect(row.candidate.publisherTranscript.timing).toBe('unknown')
      expect(row.audioProbe?.acousticallyReviewed).toBe(false)
      expect(row.audioProbe!.clipBytes).toBeLessThan(row.audioProbe!.sourceBytes)
      console.info(JSON.stringify({ actualVoaCandidate: row.candidate.id, mediaId: row.candidate.mediaId,
        transcriptSha256: row.transcriptSha256, dialogueLines: row.candidate.publisherTranscript.text.split('\n').length,
        thirdPartyNotices: row.candidate.thirdPartyNotices, ...row.audioProbe }))
    }
  }, 90_000)
  it.each(['voa-everyday-grammar','jb-linux-unplugged','open-yap-sample'])('%s supplies real bounded media with a measured, hashable clip',async id=>{
    const source=ALLOWLISTED_CONTENT_SOURCES.find(source=>source.id===id)!
    const checked=await revalidateContentRights({source})
    expect(checked.status).toBe('verified')
    const feed=await fetchContentResource({source,role:'feed',url:source.feedUrl,maxBytes:12*1024*1024})
    const batch=(source.feedFormat==='open-yap-preview-jsonl'?parseOpenYapPreviewManifest:parseRssFeed)(new TextDecoder().decode(feed.body),source,{now:Date.now(),maxItems:3})
    expect(batch.episodes.length).toBeGreaterThan(0)
    const episode=(id==='open-yap-sample'?batch.episodes.find(item=>item.guid==='conv_d4005da6db98.mp3'):batch.episodes[0])!
    const response=await fetchContentResource({source,role:'audio',url:episode.audioUrl,maxBytes:64*1024*1024,timeoutMs:60000})
    expect(response.status).toBe(200)
    const duration=contentAudioDuration(response.body,response.contentType)
    const clip=contentAudioWindow(response.body,response.contentType,30,Math.min(duration,90))
    expect(clip.originSeconds).toBeLessThanOrEqual(30)
    expect(clip.endSeconds).toBeGreaterThanOrEqual(Math.min(duration,90))
    console.info(JSON.stringify({actualAudioProbe:true,source:id,sourceBytes:response.body.length,containerDurationSeconds:duration,
      clipBytes:clip.bytes.length,clipOrigin:clip.originSeconds,clipEnd:clip.endSeconds,
      sourceSha256:createHash('sha256').update(response.body).digest('hex'),clipSha256:createHash('sha256').update(clip.bytes).digest('hex'),acousticallyReviewed:false}))
  },90000)
})

function pcmFixture(seconds = 60): Uint8Array {
  const bytes = new Uint8Array(44 + seconds * 8000 * 2), view = new DataView(bytes.buffer)
  const setText = (p: number, value: string) => bytes.set(new TextEncoder().encode(value), p)
  setText(0,'RIFF'); view.setUint32(4,bytes.length-8,true); setText(8,'WAVE'); setText(12,'fmt ')
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,8000,true)
  view.setUint32(28,16000,true); view.setUint16(32,2,true); view.setUint16(34,16,true); setText(36,'data'); view.setUint32(40,bytes.length-44,true)
  return bytes // Explicit silence fixture, never a human audio sample.
}
describe('real audio service contract (synthetic transport tests, not acoustic validation)', () => {
  it('extracts actual PCM samples and MPEG frames with a measured origin instead of proportional byte offsets', () => {
    const whole=pcmFixture(90), wav=contentAudioWindow(whole,'audio/wav',20,65)
    expect(contentAudioDuration(wav.bytes,'audio/wav')).toBe(45)
    expect(wav).toMatchObject({originSeconds:20,endSeconds:65,originalDurationSeconds:90,timingBasis:'pcm-sample-count'})
    const frame=new Uint8Array(417);frame.set([255,251,144,0]);const mp3=new Uint8Array(frame.length*4000)
    for(let i=0;i<4000;i++)mp3.set(frame,i*frame.length)
    const cut=contentAudioWindow(mp3,'audio/mpeg',40,85)
    expect(cut.originSeconds).toBeLessThanOrEqual(38)
    expect(cut.originSeconds).toBeGreaterThan(37.97)
    expect(cut.endSeconds).toBeGreaterThanOrEqual(85)
    expect(contentAudioDuration(cut.bytes,'audio/mpeg')).toBeCloseTo(cut.endSeconds-cut.originSeconds,6)
  })
  it('measures actual PCM and MP3 frame duration, rejects malformed/unsupported container timing', () => {
    expect(contentAudioDuration(pcmFixture(),'audio/wav')).toBe(60)
    const frame = new Uint8Array(417); frame.set([255,251,144,0])
    const mp3 = new Uint8Array(834); mp3.set(frame); mp3.set(frame,417)
    expect(contentAudioDuration(mp3,'audio/mpeg')).toBeCloseTo(2304/44100,8)
    expect(() => contentAudioDuration(mp3.subarray(0,800),'audio/mpeg')).toThrow()
    expect(() => contentAudioDuration(pcmFixture(),'audio/mp4')).toThrow()
    const broken = pcmFixture(); broken[20] = 3
    expect(() => contentAudioDuration(broken,'audio/wav')).toThrow()
  })
  it('sends actual audio bytes, validates timed STT and keeps provider costs unknown', async () => {
    const bytes = pcmFixture(), hash = createHash('sha256').update(bytes).digest('hex')
    let body: Record<string, unknown> | undefined
    const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
      expect(init?.redirect).toBe('error')
      body = JSON.parse(init!.body as string) as Record<string, unknown>
      return new Response(JSON.stringify({ responseId:'test-only-provider-id',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({segments:phrases.map((body,i)=>({startTime:i*10,endTime:(i+1)*10,body}))})}]}}],usageMetadata:{totalTokenCount:2000} }),{headers:{'Content-Type':'application/json'}})
    }) as typeof fetch
    const services = createContentAudioServices({ env: name => name==='GEMINI_API_KEY'?'synthetic-test-credential':undefined, fetcher: network })
    const opts = options(); await runContentRefresh(opts)
    const episode = [...opts.adminClient.items.values()][0]!.episode as Parameters<typeof services.transcribe>[0]['episode']
    const result = await services.transcribe({ requestId:'test',requestFingerprint:hash,episode,audio:{bytes,sha256:hash,mimeType:'audio/wav',objectPath:'fixture'},sourcePolicy:testSource().rights,sourcePolicyHash:hash,signal:new AbortController().signal })
    const parts = (body!.contents as {parts:{inlineData?:{data:string}}[]}[])[0]!.parts
    expect(parts[0]?.inlineData?.data).toBe(Buffer.from(bytes).toString('base64'))
    expect(result.audioDurationSeconds).toBe(60)
    expect(JSON.parse(result.transcriptJson).segments).toHaveLength(6)
    expect(result.usage.costUsd).toBeNull()
    await services.dispose()
  })
  it('does not convert missing credentials or text-only responses into audio evidence', async () => {
    const opts = options(); await runContentRefresh(opts)
    const episode = [...opts.adminClient.items.values()][0]!.episode as Parameters<ReturnType<typeof createContentAudioServices>['transcribe']>[0]['episode']
    const bytes = pcmFixture(), hash = createHash('sha256').update(bytes).digest('hex')
    const network = vi.fn()
    const services = createContentAudioServices({env:()=>undefined,fetcher:network})
    await expect(services.transcribe({requestId:'test',requestFingerprint:hash,episode,audio:{bytes,sha256:hash,mimeType:'audio/wav',objectPath:'fixture'},sourcePolicy:testSource().rights,sourcePolicyHash:hash,signal:new AbortController().signal})).rejects.toMatchObject({code:'CONTENT_AUDIO_CREDENTIAL_REQUIRED'})
    expect(network).not.toHaveBeenCalled()
  })
  it('uses the existing OpenRouter key with a live-capability-checked audio model, actual clipped bytes and reported costs', async () => {
    const bytes=pcmFixture(90),hash=createHash('sha256').update(bytes).digest('hex')
    const opts=options();await runContentRefresh(opts)
    const segment=[...opts.adminClient.records.values()][0]!.segment
    const calls:{url:string;body:unknown}[]=[]
    const network=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
      calls.push({url:String(url),body:init?.body?JSON.parse(init.body as string):null})
      if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'google/gemini-2.5-flash',architecture:{input_modalities:['audio','text']},supported_parameters:['structured_outputs']}]}))
      const observations=facts()
      const selected=Object.fromEntries(Object.entries(observations).filter(([key])=>key!=='transcriptAlignment').map(([key,fact])=>[key,{value:fact.status==='observed'?fact.value:null,confidence:0.95,reason:'Synthetic fixture observation only'}]))
      return new Response(JSON.stringify({id:'test-router-audio',model:'google/gemini-2.5-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify({inspectedStartSeconds:0,inspectedEndSeconds:60,wholeIntervalInspected:true,heard:phrases.map((body,i)=>({startTime:i*10,endTime:(i+1)*10,body})),facts:selected,thirdParty:'none-detected',lesson:{question:'What did they cook?',answer:'Dinner.',keywords:['dinner'],chunks:[{text:'come over',meaningEn:'visit',meaningZh:'来做客',example:'Come over tomorrow.'}]}})}}],usage:{total_tokens:1234,cost:0.008}}))
    }) as typeof fetch
    const services=createContentAudioServices({env:name=>name==='OPENROUTER_API_KEY'?'synthetic-router-credential':undefined,fetcher:network,now:()=>now})
    const result=await services.analyzeAudio({requestId:'test',requestFingerprint:hash,segment,audio:{bytes,sha256:hash,mimeType:'audio/wav',objectPath:'fixture'},interval:{startSeconds:0,endSeconds:60},sourcePolicy:testSource().rights,sourcePolicyHash:hash,signal:new AbortController().signal})
    expect(calls.map(c=>c.url)).toEqual(['https://openrouter.ai/api/v1/models','https://openrouter.ai/api/v1/chat/completions'])
    const requestBody=calls[1]!.body as {messages:{content:unknown}[]}
    const audioPart=(requestBody.messages[1]!.content as {type:string;input_audio:{data:string;format:string}}[])[0]!
    expect(audioPart.type).toBe('input_audio')
    const submitted=new Uint8Array(Buffer.from(audioPart.input_audio.data,'base64'))
    expect(contentAudioDuration(submitted,'audio/wav')).toBe(60)
    expect(result.audioEvidence).toMatchObject({originalAudioSha256:hash,submittedStartSeconds:0,submittedEndSeconds:60,timingBasis:'pcm-sample-count'})
    expect(result.audioEvidence?.submittedAudioSha256).not.toBe(hash)
    expect(result.facts.transcriptAlignment).toMatchObject({status:'observed',value:1})
    expect(result.usage.costUsd).toBe(0.008)
  })
})

describe('authenticated content API and budget adapter', () => {
  it('rebases only the exact private clip signature from internal Kong to the configured browser origin', () => {
    const config:Record<string,string>={SUPABASE_URL:'http://kong:8000',JOVE_PUBLIC_SUPABASE_URL:'http://127.0.0.1:55321'}
    const env=(key:string)=>config[key], path=`clips/${'a'.repeat(64)}/${'b'.repeat(64)}`
    const internal=`http://kong:8000/storage/v1/object/sign/jove-content-audio/${path}?token=synthetic-test-only`
    expect(contentSignedPlaybackUrl(internal,path,env)).toBe(internal.replace('http://kong:8000','http://127.0.0.1:55321'))
    for(const value of [internal.replace('kong:8000','evil.example.org'),internal+'&download=true',internal+'&token=duplicate',internal.replace('/clips/','/episodes/')]) expect(()=>contentSignedPlaybackUrl(value,path,env)).toThrow()
    expect(()=>contentPublicOrigin(key=>key==='SUPABASE_URL'?'http://kong:8000':undefined)).toThrow()
    expect(()=>contentPublicOrigin(()=>'http://127.0.0.1:54321')).toThrow()
    expect(contentPublicOrigin(key=>key==='SUPABASE_PUBLIC_URL'?'https://jove-owner.example.org':undefined)).toBe('https://jove-owner.example.org')
  })
  it('returns only persisted clip metadata and an expiring URL after the owner playback RPC', async()=>{
    const opts=options();opts.analyzeAudio=analyzer;await runContentRefresh(opts)
    const record=[...opts.adminClient.records.values()][0]!,clip=record.clip!
    const createSignedUrl=vi.fn(async(path:string,expiry:number)=>({data:{signedUrl:`http://kong:8000/storage/v1/object/sign/jove-content-audio/${path}?token=synthetic-only-${expiry}`},error:null}))
    const context={ownerId,admin:{rpc:async(_name:string,body:{action:string;args:Record<string,unknown>})=>{
      expect(body.action).toBe('playback');expect(body.args.ownerId).toBe(ownerId);return{data:record,error:null}
    },storage:{from:(bucket:string)=>{expect(bucket).toBe('jove-content-audio');return{createSignedUrl}}}}}as unknown as OwnerContext
    const handler=createContentHandler(key=>({SUPABASE_URL:'http://kong:8000',JOVE_PUBLIC_SUPABASE_URL:'http://127.0.0.1:55321'}[key]),{authenticate:async()=>context,now:()=>now})
    const response=await handler(request({action:'audio',segmentId:record.segment.id})),body=await response.json()
    expect(response.status).toBe(200);expect(body).toMatchObject({...clip,segmentId:record.segment.id,sourceId:record.segment.sourceId,expiresAt:now+300000})
    expect(body.url).toContain('http://127.0.0.1:55321/storage/v1/object/sign/jove-content-audio/clips/')
    expect(createSignedUrl).toHaveBeenCalledWith(clip.objectPath,300)
    expect(JSON.stringify(record)).not.toContain('synthetic-only-300')
  })
  const api = 'http://127.0.0.1:55321/functions/v1/content'
  const request = (body: unknown, headers: Record<string,string> = {}) => new Request(api,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
  it('rejects invalid sessions, forged scheduler credentials and browser scheduler requests before reading service credentials', async () => {
    const read: string[]=[]
    const handler = createContentHandler(name=>{read.push(name);return undefined})
    expect((await handler(request({action:'status'}))).status).toBe(401)
    expect((await handler(request({}, {'X-Jove-Content-Job':'fake'}))).status).toBe(401)
    expect((await handler(request({}, {'X-Jove-Content-Job':'fake',Origin:'https://mnijc19-netizen.github.io'}))).status).toBe(403)
    expect(read).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
  })
  it('accepts persisted lesson/profile API only after auth and rejects arbitrary source URLs', async () => {
    const db = new MemoryRpc(), context={ownerId,admin:db,user:db} as unknown as OwnerContext
    const authenticate = vi.fn(async()=>context)
    const handler=createContentHandler(()=>undefined,{authenticate,now:()=>now})
    const response=await handler(request({action:'lessons',profile:{targetDifficulty:0.4,fatigue:0,interests:['Everyday life']}}))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({lessons:[]})
    expect(db.calls.some(call=>call.action==='profile')).toBe(true)
    expect((await handler(request({action:'refresh',sourceUrl:'http://localhost/private'}))).status).toBe(400)
    expect(authenticate).toHaveBeenCalledTimes(2)
  })
  it('requires the budget single-dispatch nonce and refuses to settle a reservation it did not acquire', async () => {
    const admin={rpc:async()=>({data:{id:'already-owned',dispatch_nonce:'different'},error:null})}
    const adapter=createContentBudget({ownerId,admin} as unknown as OwnerContext)
    const result=await adapter.reserve({ownerId,requestId:'test',fingerprint:'f'.repeat(64),purpose:'content-analysis',maxCostUsd:0.1})
    expect(result).toMatchObject({allowed:true,acquired:false,replay:true})
    await expect(adapter.settle({reservationId:result.reservationId,status:'completed',usage})).rejects.toBeInstanceOf(GatewayError)
  })
})

const localEnabled = process.env.JOVE_CONTENT_LOCAL_TEST === '1'
const liveEnabled = process.env.JOVE_CONTENT_PUBLIC_INGEST === '1'
const localContainer = 'supabase_db_jove-english-os'
function sql(statement: string): string {
  // Fixed dedicated local container. Never read service keys or connect to another project's DB.
  return execFileSync('docker', ['exec','-i',localContainer,'psql','-U','postgres','-d','postgres','-At','-v','ON_ERROR_STOP=1'],
    { input: statement, encoding: 'utf8', stdio: ['pipe','pipe','pipe'], maxBuffer: 16 * 1024 * 1024 }).trim()
}
function sqlLiteral(value: string): string { return `'${value.replace(/'/gu, "''")}'` }
function postgresAdmin(): ContentAdminClient {
  return { async rpc(name, input) {
    if (name !== 'content_worker') throw new Error('Unexpected RPC')
    try {
      const output = sql(`select public.content_worker(${sqlLiteral(input!.action as string)},${sqlLiteral(JSON.stringify(input!.args))}::jsonb);`)
      return { data: JSON.parse(output), error: null }
    } catch { return { data: null, error: { code: 'SQL_TEST_ERROR' } } }
  } }
}
describe.runIf(localEnabled)('content SQL acceptance assertions fail closed on absent RPC values', () => {
  const acceptance = readFileSync(new URL('../supabase/tests/content.test.sql', import.meta.url), 'utf8')
  it('passes the unchanged real RPC acceptance in a rollback-only transaction', () => {
    expect(() => sql(`begin; ${acceptance} rollback;`)).not.toThrow()
  })
  it.each([
    ["response->>'acquired' is distinct from 'true'", "Initial rights check not required"],
    ["response->>'rightsDue' is distinct from 'true'", "Initial rights check not required"],
    ["response->>'acquired' is distinct from 'false'", "Lease allowed concurrent worker"],
    ["(public.content_worker('profile',jsonb_build_object('ownerId',owner_key))->>'targetDifficulty')::numeric", "Profile did not persist"],
    ['jsonb_array_length(response)', 'Finished episode not scheduled for deletion'],
    ["(public.content_worker('playback',jsonb_build_object('ownerId',owner_key,'segmentId',segment_key))->'clip'->>'audioSha256')", 'Clip depended on deleted episode'],
  ])('rejects missing and JSON-null output at %s', (expression, expected) => {
    // Mutate only the assertion's observed return value in memory, never the RPC/schema/file.
    for (const output of ["'{}'::jsonb", "'{\"value\":null}'::jsonb"]) {
      const absent = `(${output}->>'value')`
      const suffix = expression.includes(' is distinct from ') ? expression.slice(expression.indexOf(' is distinct from ')) : ''
      const replacement = expression.includes('::numeric') ? `${absent}::numeric` : expression.startsWith('jsonb_array_length') ? `${absent}::integer` : absent
      expect(acceptance.includes(expression)).toBe(true)
      const mutant = acceptance.replace(expression, replacement + suffix)
      let error = ''
      try { sql(`begin; ${mutant} rollback;`) } catch (failure) {
        error = String((failure as { stderr?: unknown }).stderr ?? failure)
      }
      expect(error).toContain(expected)
    }
  }, 30_000)
})

describe.runIf(localEnabled)('dedicated local PostgreSQL persistence and RLS (no secrets)', () => {
  const source = testSource(`test-content-${crypto.randomUUID()}`)
  const localOwner = crypto.randomUUID()
  const outsider = crypto.randomUUID()
  const admin = postgresAdmin()
  let approvedId = ''
  beforeAll(() => {
    const exists = sql("select coalesce(to_regclass('public.content_sources')::text,'');")
    if (!exists) {
      throw new Error('Main must apply the stable 004 content migration to the dedicated local backend before this test.')
    }
    sql(`insert into auth.users(id) values('${localOwner}'),('${outsider}'); insert into public.app_members(user_id) values('${localOwner}');`)
  }, 30_000)
  afterAll(() => {
    // Only this randomized fixture source and its synthetic users. Public-source ingest evidence remains available to main.
    sql(`begin;
      delete from public.content_recommendations where user_id='${localOwner}';
      delete from public.content_history where source_id='${source.id}' or user_id='${localOwner}';
      delete from public.content_usage where user_id='${localOwner}';
      delete from public.content_items where source_id='${source.id}';
      delete from public.content_sources where id='${source.id}';
      delete from auth.users where id in('${localOwner}','${outsider}'); commit;`)
  })
  it('stores actual relational rows and resumes them into an eligible private recommendation through the executable worker', async () => {
    events.length = 0
    const opts: ContentRefreshOptions = { ...options(), adminClient: admin, sources: [source], ownerId: localOwner, now: Date.now }
    const first = await runContentRefresh(opts)
    expect(first.errors).toEqual([])
    expect(sql(`select count(*) from public.content_items where source_id='${source.id}';`)).toBe('1')
    expect(sql(`select count(*) from public.content_transcripts t join public.content_items i on i.id=t.item_id where i.source_id='${source.id}';`)).toBe('1')
    opts.analyzeAudio = analyzer
    const second = await runContentRefresh(opts)
    expect(second.errors).toEqual([])
    expect(second.recommendations, JSON.stringify({summary:second,states:sql(`select jsonb_agg(jsonb_build_object('status',s.status,'quality',s.record->'quality'->'reasons','clip',s.record->'clip'->>'audioSha256')) from public.content_segments s join public.content_items i on i.id=s.item_id where i.source_id='${source.id}';`)})).toHaveLength(1)
    approvedId = second.recommendations[0]!.segmentId
    expect(sql(`select count(*) from public.content_scores where segment_id='${approvedId}';`)).toBe('1')
    expect(sql(`select count(*) from public.content_speakers where segment_id='${approvedId}';`)).toBe('1')
    expect(sql(`select count(*) from public.content_usage where user_id='${localOwner}' and cost_usd is null;`)).toBe('1')
  }, 30_000)
  it('enforces RLS and service-only mutations in real PostgreSQL roles', () => {
    const asUser = (id: string, query: string) => sql(`begin; set local role authenticated; set local request.jwt.claim.sub='${id}'; ${query}; rollback;`).split('\n').filter(row => !['BEGIN','SET','ROLLBACK'].includes(row))
    expect(asUser(localOwner,'select count(*) from public.content_recommendations')).toEqual(['1'])
    expect(asUser(outsider,'select count(*) from public.content_recommendations')).toEqual(['0'])
    expect(() => asUser(localOwner,"select public.content_worker('claim','{}')")).toThrow()
    expect(() => asUser(localOwner,'select count(*) from public.content_transcripts')).toThrow()
    expect(() => sql("begin; set local role anon; select count(*) from public.content_recommendations; rollback;")).toThrow()
  })
  it('round-trips non-network STT provenance and measured duration through actual JSONB without another provider dispatch', async () => {
    const feed = fetcher(rss(false).replace('<guid>one</guid>', '<guid>stored-stt</guid>'))
    const transcribe = vi.fn<NonNullable<ContentRefreshOptions['transcribe']>>(async request => ({
      audioSha256: request.audio.sha256, requestFingerprint: request.requestFingerprint, audioDurationSeconds: 70,
      provider: 'fixture-stt', evidenceId: 'SYNTHETIC-STT-ONLY', usage,
      transcriptJson: JSON.stringify({ version: '1.0.0', segments: phrases.map((body, i) => ({ startTime: i * 10, endTime: (i + 1) * 10, body })) }),
    }))
    const opts: ContentRefreshOptions = { ...options(), adminClient: admin, sources: [source], ownerId: localOwner, now: Date.now,
      fetcher: request => feed({ ...request, etag: null }), transcribe, transcriptOrigin: undefined, forcePoll: true }
    const first = await runContentRefresh(opts)
    expect(first.errors).toEqual([])
    expect(first.eligibleSegments).toBe(0)
    const itemId = createHash('sha256').update(JSON.stringify([source.id, 'stored-stt'])).digest('hex')
    const saved = JSON.parse(sql(`select transcript from public.content_transcripts where item_id='${itemId}';`)) as TimedTranscript
    expect(saved.reference).toMatchObject({ url: `urn:jove:content-transcript:${itemId}`, derivation: { audioDurationSeconds: 70 } })
    opts.analyzeAudio = analyzer
    const second = await runContentRefresh(opts)
    expect(second.errors).toEqual([])
    expect(second.eligibleSegments).toBe(1)
    expect(transcribe).toHaveBeenCalledOnce()
    expect(sql(`select count(*) from public.content_segments where item_id='${itemId}' and status='eligible';`)).toBe('1')
  }, 30_000)
  it('fences expired workers and prevents two overlapping claims', async () => {
    const args = { sourceId: source.id, runId: crypto.randomUUID(), source, configHash: 'a'.repeat(64), forcePoll: true, canAnalyze: false }
    expect((await admin.rpc('content_worker',{ action:'claim',args })).data).toMatchObject({ acquired:true })
    expect((await admin.rpc('content_worker',{ action:'claim',args:{...args,runId:crypto.randomUUID()} })).data).toMatchObject({ acquired:false,reason:'leased' })
    sql(`update public.content_sources set lease_until=clock_timestamp()-interval '1 second' where id='${source.id}';`)
    expect((await admin.rpc('content_worker',{ action:'heartbeat',args })).error).not.toBeNull()
  })
  it.runIf(liveEnabled)('fetches real continuing feeds and persists their transcripts and quarantine scores in this backend', async () => {
    const rssSources = ALLOWLISTED_CONTENT_SOURCES.filter(source => source.feedFormat !== 'open-yap-preview-jsonl')
    const result = await runContentRefresh({ adminClient: admin, ownerId: localOwner, forcePoll: true,
      sourceIds: rssSources.map(source => source.id),
      limits: { sources: 4, episodesPerSource: 2, segmentsPerEpisode: 2, feedItems: 3, runMs: 120_000 } })
    console.info(JSON.stringify({ actualBackendIngest: true, ...result, recommendations: result.recommendations.length }))
    expect(result.feedsFetched + result.feedsUnchanged).toBeGreaterThanOrEqual(2)
    expect(result.eligibleSegments).toBe(0)
    // Repeated polls may correctly write nothing. Check persisted evidence, not duplicate writes.
    const sourceIds = rssSources.map(source => sqlLiteral(source.id)).join(',')
    expect(Number(sql(`select count(*) from public.content_segments g join public.content_items i on i.id=g.item_id where i.source_id in (${sourceIds}) and g.status='quarantined';`))).toBeGreaterThanOrEqual(4)
    expect(Number(sql(`select count(*) from public.content_transcripts t join public.content_items i on i.id=t.item_id where i.source_id in (${sourceIds});`))).toBeGreaterThanOrEqual(4)
    expect(sql(`select count(*) from public.content_segments g join public.content_items i on i.id=g.item_id where i.source_id in (${sourceIds}) and g.status='eligible';`)).toBe('0')
    for (const source of rssSources) expect(Number(sql(`select count(*) from public.content_items where source_id='${source.id}';`))).toBeGreaterThan(0)
  }, 120_000)
  it.runIf(liveEnabled)('persists the actual first-party everyday manifest with verified sample-only rights and no invented audio approval', async () => {
    const result = await runContentRefresh({ adminClient: admin, ownerId: localOwner, sourceIds: ['open-yap-sample'], forcePoll: true,
      limits: { feedItems: 25, episodesPerSource: 2, runMs: 60_000 } })
    expect(result.eligibleSegments).toBe(0)
    expect(sql("select rights_status from public.content_sources where id='open-yap-sample';")).toBe('verified')
    expect(Number(sql("select count(*) from public.content_items where source_id='open-yap-sample';"))).toBeGreaterThanOrEqual(16)
    expect(sql("select count(*) from public.content_segments g join public.content_items i on i.id=g.item_id where i.source_id='open-yap-sample' and g.status='eligible';")).toBe('0')
  }, 90_000)
})
