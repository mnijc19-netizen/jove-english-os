import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ALLOWLISTED_CONTENT_SOURCES, CONTENT_LIFE_TASKS, OPEN_YAP_SAMPLE_SOURCE, VOA_LESSON_CANDIDATES } from '../src/content/sources'
import type { ContentSource, FeedEpisode, Inspection, ObservationEvidence, TimedTranscript } from '../src/content/pipeline-types'
import { createContentFetcher, fetchContentResource, isPublicContentAddress, type ContentFetcher } from '../src/server/content-network'
import { parseRssFeed, parseOpenYapPreviewManifest, resolveEpisodeAudioUrl, validateSourceUrl } from '../src/content/pipeline'
import { CONTENT_POLICY_EVIDENCE, extractContentPolicy, revalidateContentRights } from '../src/server/content-rights'
import { contentAudioDuration, contentAudioWindow, contentMp3PrefixWindow, contentStoredAudioWindow, createContentAudioServices, prepareContentMp3Prefix } from '../src/server/content-audio'
import { auditVoaLessonCandidates, type VoaCandidateAudit } from '../src/server/content-voa'
import { contentPublicOrigin, contentSignedPlaybackUrl, createContentBudget, createContentHandler } from '../src/server/content'
import { GatewayError, type OwnerContext } from '../src/server/gateway'
import {
  buildContentTaskInventory, planContentSourceRefresh, readOwnerContentTaskInventory, reviewVoaLifeTaskDialogue,
  recordContentLearningUse, runContentRefresh, runVoaCandidatePilot, selectAndPersistContentLessons,
  type ContentAdminClient, type ContentAudioAnalyzer, type ContentAudioInput, type ContentAudioStore, type ContentBudget,
  type ContentRefreshOptions, type ContentLifeTaskReview, type EligibleContentLesson, type PersistedContentSegment,
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
  const window = contentStoredAudioWindow(request.audio, request.interval.startSeconds, request.interval.endSeconds)
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
  saved_segments: PersistedContentSegment[]; object_path: string | null; audio_sha256: string | null; audio_mime: string | null;
  audio_acquisition_version?: 'complete-v1' | 'mpeg-prefix-v1'; audio_coverage?: ContentAudioInput['audio']['coverage'] }
class MemoryRpc implements ContentAdminClient {
  items = new Map<string, DbItem>()
  records = new Map<string, PersistedContentSegment>()
  recommendations: { id: string; request_id: string; segment_id: string; lesson: EligibleContentLesson }[] = []
  calls: { action: string; args: Record<string, unknown> }[] = []
  intents = new Map<string, string>()
  audioWork = new Map<string, number>()
  etag: string | null = null
  config = testSource()
  locked = false
  rightsStatus = 'unchecked'
  rightsDue = true
  rightsCheckedAt: string | null = null
  from(table: string) {
    expect(table).toBe('content_items')
    return { select: (columns: string) => {
      expect(columns).toBe('guid,episode')
      return { eq: (column: string, value: string) => {
        expect([column, value]).toEqual(['source_id', 'voa-everyday-grammar'])
        return { in: (key: string, guids: string[]) => {
          expect(key).toBe('guid')
          return { limit: async (count: number) => ({ error: null, data: [...this.items.values()]
            .map(item => ({ episode: item.episode as { guid: string }, guid: (item.episode as { guid: string }).guid }))
            .filter(row => guids.includes(row.guid)).slice(0, count) }) }
        } }
      } }
    } }
  }
  async rpc(_name: string, input?: Record<string, unknown>): Promise<Awaited<ReturnType<ContentAdminClient['rpc']>>> {
    const action = input!.action as string, args = input!.args as Record<string, unknown>
    if (_name === 'content_audio_work') {
      this.calls.push({ action: `audio-work-${action}`, args: structuredClone(args) })
      if (action === 'order') return { data: [...args.sourceIds as string[]].sort((a, b) => (this.audioWork.get(a) ?? 0) - (this.audioWork.get(b) ?? 0)), error: null }
      this.audioWork.set(args.sourceId as string, this.calls.length)
      return { data: {}, error: null }
    }
    if (_name === 'content_request_intent') {
      const scope = JSON.stringify([args.itemId, args.revision, args.purpose, args.scope])
      const binding = JSON.stringify([args.requestId, args.fingerprint, args.audioSha256])
      const previous = this.intents.get(scope)
      if (!previous) this.intents.set(scope, binding)
      this.calls.push({ action: 'request-intent', args: structuredClone(args) })
      return { data: { allowed: !previous || previous === binding }, error: null }
    }
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
        else if (this.items.get(row.id)!.revision !== row.revision) {
          const prior = this.items.get(row.id)!
          for (const [id, record] of this.records) if (record.segment.episode.guid === (prior.episode as { guid: string }).guid) {
            this.records.delete(id)
            this.recommendations = this.recommendations.filter(recommendation => recommendation.segment_id !== id)
          }
          this.items.set(row.id, { ...row, attempts: 0, status: 'pending', transcript: null, saved_segments: [], object_path: null, audio_sha256: null, audio_mime: null })
          changed++
        }
      }
      data = { changed }
    } else if (action === 'poll') this.etag = args.etag as string | null
    else if (action === 'pending') data = [...this.items.values()].filter(item => (item.episode as FeedEpisode).sourceId === args.sourceId &&
      (['pending', 'retry'].includes(item.status) || args.canAnalyze && item.status === 'awaiting-analysis'))
      .map(item => ({ ...item, saved_segments: [...this.records.values()].filter(record => record.segment.sourceId === args.sourceId) }))
    else if (action === 'checkpoint') item!.transcript = args.transcript as TimedTranscript
    else if (action === 'asset') { item!.object_path = args.objectPath as string; item!.audio_sha256 = args.sha256 as string; item!.audio_mime = args.mimeType as string
      item!.audio_acquisition_version = args.acquisitionVersion as 'complete-v1' | 'mpeg-prefix-v1' | undefined
      item!.audio_coverage = args.coverage as ContentAudioInput['audio']['coverage'] }
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

const voaSource = ALLOWLISTED_CONTENT_SOURCES.find(source => source.id === 'voa-everyday-grammar')!
const voaTestPolicies = [{ ...rightsPolicies[0]!, url: voaSource.rights.evidenceUrls[0]! }]
function voaTestFetcher(extraChrome = ''): ContentFetcher {
  return async request => {
    const contract = VOA_LESSON_CANDIDATES.find(candidate => candidate.pageUrl === request.url)
    const html = contract ? `<html><h2>Conversation</h2><div data-media-id="${contract.mediaId}" title="VOA - Voice of America English News">
      <audio src="${contract.audioUrl}"></audio></div><p>Anna: This is original test dialogue, not publisher evidence.</p>
      <p>Worker: This fixture has no human audio inspection.</p><p>Anna: No task has been approved.</p>
      <p>Worker: Keep all times unknown.</p><h2>Quiz</h2>${extraChrome}</html>` : policyHtml
    return { status: 200, finalUrl: request.url, body: new TextEncoder().encode(html), etag: null, lastModified: null,
      retryAfter: null, contentType: 'text/html', dnsPinning: 'injected' }
  }
}
async function screenedTaskFixture(source: ContentSource, lines: string[], candidateId?: string) {
  const contract = VOA_LESSON_CANDIDATES.find(candidate => candidate.id === candidateId)
  const opts = options(), audioUrl = contract?.audioUrl ?? `${origin}/audio/one.mp3`, pageUrl = contract?.pageUrl ?? `${origin}/episode/one`
  // Synthetic trusted-backend snapshot for the semantic binding unit test, NOT a publisher audit.
  if (contract) {
    const persist = opts.adminClient.rpc.bind(opts.adminClient)
    opts.adminClient.rpc = async (name, input) => {
      if (input?.action === 'ingest') for (const item of (input.args as { items: { episode: Record<string, unknown> }[] }).items)
        item.episode.candidateAudit = { transcriptSha256: contract.dialogueScriptSha256, candidate: { thirdPartyNotices: [] } }
      return persist(name, input)
    }
  }
  const transport: ContentFetcher = async request => {
    const isFeed = request.role === 'feed', isAudio = request.role === 'audio'
    const body = isAudio ? fixtureAudio : new TextEncoder().encode(isFeed ? `<rss version="2.0"><channel><title>TEST ONLY</title><item>
      <title>Synthetic task test</title><guid>${contract ? `voa-pilot:${contract.id}` : 'one'}</guid><link>${pageUrl}</link>
      <enclosure url="${audioUrl}" type="audio/mpeg" length="10"/></item></channel></rss>` : policyHtml)
    return { status: 200, finalUrl: request.url, body, etag: null, lastModified: null, retryAfter: null,
      contentType: isAudio ? 'audio/wav' : isFeed ? 'application/rss+xml' : 'text/html', dnsPinning: 'injected' }
  }
  const result = await runContentRefresh({ ...opts, sources: [source], fetcher: transport, voaPilot: 'disabled',
    rightsPolicies: source.id === voaSource.id ? voaTestPolicies : rightsPolicies,
    transcribe: async input => ({ audioSha256: input.audio.sha256, requestFingerprint: input.requestFingerprint,
      audioDurationSeconds: 70, provider: 'SYNTHETIC-TEST-ONLY', evidenceId: 'SYNTHETIC-TEST-ONLY', usage,
      transcriptJson: JSON.stringify({ version: '1.0.0', segments: lines.map((body, i) => ({ startTime: i * 10, endTime: (i + 1) * 10, body })) }) }),
    analyzeAudio: async input => {
      const checked = await analyzer(input)
      checked.audioEvidence!.heard = input.segment.sentences.map(sentence => ({ startTime: sentence.startSeconds, endTime: sentence.endSeconds, body: sentence.text }))
      return checked
    } })
  expect(result.eligibleSegments).toBe(1)
  return { id: [...opts.adminClient.records.keys()][0]!, record: [...opts.adminClient.records.values()][0]!, config: opts.adminClient.config }
}
describe('six-scene no-paid pilot and owner task inventory', () => {
  it('audits only six exact contracts, keeps timestamps/coverage unknown and rejects extra URLs before network', async () => {
    const transport = vi.fn(voaTestFetcher())
    const audits = await auditVoaLessonCandidates({ fetcher: transport, rightsPolicies: voaTestPolicies, now: () => now })
    expect(audits.map(audit => audit.candidate.id)).toEqual(VOA_LESSON_CANDIDATES.map(candidate => candidate.id))
    expect(transport).toHaveBeenCalledTimes(7)
    for (const audit of audits) expect(audit).toMatchObject({ taskCoverage: 'unknown', audioProbe: null,
      candidate: { status: 'candidate', eligible: false, publisherTranscript: { timing: 'unknown', alignment: 'unverified' } } })
    transport.mockClear()
    await expect(auditVoaLessonCandidates({ ids: ['https://unapproved.example/a'], fetcher: transport })).rejects.toThrow('unapproved-voa-candidate')
    expect(transport).not.toHaveBeenCalled()
  })
  it('persists actual audit snapshots through existing lease/ingest RPC without spending, retention or approvals', async () => {
    const db = new MemoryRpc(), transport = vi.fn(voaTestFetcher())
    const result = await runVoaCandidatePilot({ adminClient: db, ownerId, fetcher: transport, rightsPolicies: voaTestPolicies, now: () => now })
    expect(result.voaPilot).toHaveLength(6)
    expect(result.itemsDiscovered).toBe(6)
    expect(result.inventory?.candidateAuditStatus).toBe('observed')
    expect(result.inventory?.tasks).toHaveLength(17)
    expect(result.inventory?.tasks.every(task => task.reviewedUsableCount === 0 && task.state === 'gap')).toBe(true)
    expect(result.inventory?.tasks.find(task => task.task === 'restaurant')?.auditedCandidateCount).toBe(1)
    expect(result.inventory?.tasks.find(task => task.task === 'bank')).toMatchObject({ configuredCandidateIds: [], auditedCandidateCount: 0 })
    expect(result.inventory).toMatchObject({ nextExpectedSupplyAt: null, estimatedDaysRemaining: null })
    expect(db.items.size).toBe(6)
    expect(db.records.size).toBe(0)
    expect(db.calls.some(call => ['usage', 'asset', 'clip', 'retention', 'pending', 'recommend', 'poll'].includes(call.action))).toBe(false)
    expect(transport.mock.calls.every(([request]) => request.role === 'page')).toBe(true)
    expect(db.locked).toBe(false)
    const first = db.calls.find(call => call.action === 'ingest')!.args.items as { revision: string; episode: { transcripts: unknown[]; candidateAudit: unknown } }[]
    expect(first.every(item => item.episode.transcripts.length === 0 && item.episode.candidateAudit)).toBe(true)
    const again = await runVoaCandidatePilot({ adminClient: db, ownerId, fetcher: voaTestFetcher('<footer>changed chrome</footer>'),
      rightsPolicies: voaTestPolicies, now: () => now + 1000 })
    const second = db.calls.filter(call => call.action === 'ingest').at(-1)!.args.items as { revision: string }[]
    expect(second.map(item => item.revision)).toEqual(first.map(item => item.revision))
    expect(again.itemsDiscovered).toBe(0)
  })
  it('refuses a different or ambiguous owner before pilot writes or private inventory reads', async () => {
    const db = new MemoryRpc()
    await expect(runVoaCandidatePilot({ adminClient: db, ownerId: crypto.randomUUID() })).rejects.toThrow('content-single-owner-required')
    expect(db.calls.map(call => call.action)).toEqual(['owner'])
    const absent: ContentAdminClient = { rpc: vi.fn(async () => ({ data: { ownerId: null }, error: null })) }
    await expect(readOwnerContentTaskInventory({ adminClient: absent, ownerId })).rejects.toThrow('content-single-owner-required')
    expect(absent.rpc).toHaveBeenCalledTimes(1)
  })
  it('does not proceed to six page reads when publisher rights change', async () => {
    const db = new MemoryRpc(), transport = vi.fn(voaTestFetcher())
    const result = await runVoaCandidatePilot({ adminClient: db, fetcher: transport,
      rightsPolicies: [{ ...voaTestPolicies[0]!, sha256: '0'.repeat(64) }], now: () => now })
    expect(db.items.size).toBe(0)
    expect(result.voaPilot).toEqual([])
    expect(result.nextGates).toContain('publisher-license-evidence-changed')
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])('quarantines known third-party declarations before audio and withdraws an old revision (previously eligible=%s)', async previouslyEligible => {
    const db = new MemoryRpc(), opts = options(db)
    const analyze = vi.fn(analyzer)
    const transcribe = vi.fn(async (input: Parameters<NonNullable<ContentRefreshOptions['transcribe']>>[0]) => ({
      audioSha256: input.audio.sha256, requestFingerprint: input.requestFingerprint, audioDurationSeconds: 70,
      provider: 'SYNTHETIC-TEST-ONLY', evidenceId: 'SYNTHETIC-TEST-ONLY', usage,
      transcriptJson: JSON.stringify({ version: '1.0.0', segments: phrases.map((body, i) => ({ startTime: i * 10, endTime: (i + 1) * 10, body })) }),
    }))
    const transport: ContentFetcher = async request => {
      if (request.role === 'page') return voaTestFetcher()(request)
      return { status: 200, finalUrl: request.url, etag: null, lastModified: null, retryAfter: null, dnsPinning: 'injected',
        contentType: request.role === 'audio' ? 'audio/wav' : 'application/rss+xml',
        body: request.role === 'audio' ? fixtureAudio : new TextEncoder().encode('<rss version="2.0"><channel><title>TEST</title></channel></rss>') }
    }
    const resume = () => runContentRefresh({ ...opts, sources: [voaSource], fetcher: transport, rightsPolicies: voaTestPolicies,
      voaPilot: 'disabled', analyzeAudio: analyze, transcribe })
    let oldRevision: string | undefined
    if (previouslyEligible) {
      await runVoaCandidatePilot({ adminClient: db, fetcher: voaTestFetcher(), rightsPolicies: voaTestPolicies, now: () => now })
      oldRevision = [...db.items.values()][0]!.revision
      expect((await resume()).eligibleSegments).toBe(1)
      expect(db.recommendations).toHaveLength(1)
    }
    const noticeFetcher: ContentFetcher = async request => {
      const response = await voaTestFetcher()(request)
      return { ...response, body: new TextEncoder().encode(new TextDecoder().decode(response.body)
        .replace('<h2>Quiz', '<p>This dialogue recording copyright Another Author.</p><h2>Quiz')) }
    }
    const changed = await runVoaCandidatePilot({ adminClient: db, fetcher: noticeFetcher, rightsPolicies: voaTestPolicies, now: () => now + 1000 })
    expect(changed.itemsDiscovered).toBe(6)
    const stored = [...db.items.values()][0]!
    expect((stored.episode as { licenseNotice: string }).licenseNotice).toContain('copyright Another Author')
    if (previouslyEligible) expect(stored.revision).not.toBe(oldRevision)
    expect(db.records.size).toBe(0)
    expect(db.recommendations).toEqual([])
    analyze.mockClear(); transcribe.mockClear()
    const result = await resume()
    expect(result.nextGates).toContain('publisher-third-party-rights-review-required')
    expect(result.eligibleSegments).toBe(0)
    expect(analyze).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
  })
  it('retains unknown when the client cannot read candidate snapshots, rather than claiming no candidates exist', async () => {
    const db = new MemoryRpc()
    const result = await readOwnerContentTaskInventory({ adminClient: { rpc: db.rpc.bind(db) }, ownerId, now: () => now })
    expect(result.candidateAuditStatus).toBe('unknown')
    expect(result.tasks.every(task => task.auditedCandidateCount === null)).toBe(true)
    expect(result.notices).toContain('candidate-audit-readback-unavailable')
  })
  it('counts only bound reviewed task exchanges, deduplicates clips and distinguishes low stock from unknown', async () => {
    const opts = options()
    await runContentRefresh({ ...opts, analyzeAudio: analyzer })
    const saved = [...opts.adminClient.records.values()][0]!
    const profile = { targetDifficulty: 0.45, fatigue: 0, interests: ['Technology'] }
    const project = (record: PersistedContentSegment & { lifeTaskReview?: ContentLifeTaskReview }, copies = 1, lowWater = 2) => buildContentTaskInventory({
      ownerId, profile, sources: opts.sources, now, lowWater, auditedCandidateIds: VOA_LESSON_CANDIDATES.map(candidate => candidate.id),
      rows: { candidates: Array.from({ length: copies }, () => ({ id: record.segment.id, record, config: opts.adminClient.config })), recent: [] } })
    expect(project(saved).tasks.every(task => task.state === 'unknown' && task.reviewedUsableCount === 0)).toBe(true)
    expect(project({ ...saved, status: 'quarantined' }).tasks.every(task => task.state === 'gap')).toBe(true)
    saved.audioEvidence!.heard = saved.segment.sentences.map(sentence => ({ startTime: sentence.startSeconds, endTime: sentence.endSeconds, body: sentence.text }))
    const review: ContentLifeTaskReview = { evidenceId: 'TEST-ONLY', reviewer: 'TEST-ONLY', version: '1', reviewedAt: now,
      segmentId: saved.segment.id, contentFingerprint: saved.segment.contentFingerprint, timingFingerprint: saved.segment.timingFingerprint,
      audioSha256: saved.artifact!.sha256, sourcePolicyHash: saved.rightsRecord!.sourcePolicyHash,
      assessments: CONTENT_LIFE_TASKS.map(task => ({ task, outcome: task === 'social' ? 'supported' : 'not-supported',
        reason: 'Synthetic fixture semantic assessment; not real publisher or audio evidence.',
        quotes: task === 'social' ? [{ sentenceIndex: 0, text: phrases[0]! }, { sentenceIndex: 4, text: phrases[4]! }] : [] })) }
    const reviewed = { ...saved, lifeTaskReview: review }
    expect(project(reviewed, 2).tasks.find(task => task.task === 'social')).toMatchObject({ reviewedUsableCount: 1, state: 'low' })
    expect(project(reviewed, 2, 1).tasks.find(task => task.task === 'social')?.state).toBe('sufficient')
    expect(project(reviewed, 100).tasks.find(task => task.task === 'bank')).toMatchObject({ reviewedUsableCount: 0, state: 'unknown', countBasis: 'lower-bound' })
    const withoutHeard = structuredClone(reviewed)
    withoutHeard.audioEvidence!.heard = []
    expect(project(withoutHeard).tasks.find(task => task.task === 'social')).toMatchObject({ reviewedUsableCount: 0, state: 'unknown' })
    const wrongTime = structuredClone(reviewed)
    wrongTime.audioEvidence!.heard[0]!.startTime = 40
    wrongTime.audioEvidence!.heard[0]!.endTime = 45
    expect(project(wrongTime).tasks.find(task => task.task === 'social')).toMatchObject({ reviewedUsableCount: 0, state: 'unknown' })
    for (const corrupted of [
      { ...review, audioSha256: '0'.repeat(64) }, { ...review, timingFingerprint: 'wrong' }, { ...review, reviewedAt: now + 1 },
      { ...review, sourcePolicyHash: 'wrong' }, { ...review, assessments: [...review.assessments, review.assessments[0]!] },
      { ...review, assessments: [{ task: 'bank' as const, outcome: 'supported' as const, reason: 'A keyword is not a task exchange.', quotes: [{ sentenceIndex: 0, text: 'made up bank transaction' }] }] },
    ]) expect(project({ ...saved, lifeTaskReview: corrupted }).tasks.every(task => task.reviewedUsableCount === 0 && task.state === 'unknown')).toBe(true)
    expect(() => project(reviewed, 1, 0)).toThrow('invalid-content-inventory')
  })
  it('routes small refresh budgets to everyday inventory work, rotates it, and never claims archive expiry or new releases', () => {
    const selected = [0, 1].map(day => planContentSourceRefresh({ sources: [...ALLOWLISTED_CONTENT_SOURCES].reverse(), limit: 1, now: now + day * 86_400_000 }))
    expect(new Set(selected.flatMap(row => row.sourceIds))).toEqual(new Set(['open-yap-sample', 'voa-everyday-grammar']))
    const all = planContentSourceRefresh({ sources: ALLOWLISTED_CONTENT_SOURCES, limit: 5, now })
    expect(all.sourceIds).toHaveLength(5)
    expect(all.sourceIds.indexOf('jb-linux-unplugged')).toBeGreaterThan(all.sourceIds.indexOf('open-yap-sample'))
    expect(all.notices).toContain('nontechnical-continuing-supply-not-established')
    expect(planContentSourceRefresh({ sources: [ALLOWLISTED_CONTENT_SOURCES.find(source => source.id === 'jb-linux-unplugged')!], limit: 1, now }).notices)
      .toContain('everyday-source-dispatch-unavailable')
  })
  it('binds editorial dialogue rules to independently heard aligned audio, not intent labels or a page-only match', async () => {
    const contract = VOA_LESSON_CANDIDATES.find(candidate => candidate.id === 'voa-lle-food-trucks')!
    const turns = contract.dialogueRules![0]!.turns
    const row = await screenedTaskFixture(voaSource, phrases.map((text, i) => i < 2 ? `${text} ${turns[i]}` : text), contract.id)
    const result = reviewVoaLifeTaskDialogue(row.record, row.config, now)
    expect(result?.assessments.map(assessment => assessment.task)).toEqual(['restaurant'])
    const inventory = buildContentTaskInventory({ ownerId, rows: { candidates: [row], recent: [] }, sources: [voaSource],
      profile: { targetDifficulty: 0.45, fatigue: 0, interests: ['Technology'] }, now })
    expect(inventory.tasks.find(task => task.task === 'restaurant')).toMatchObject({ reviewedUsableCount: 1, state: 'low' })
    expect(inventory.tasks.find(task => task.task === 'shopping')).toMatchObject({ reviewedUsableCount: 0, state: 'unknown' })
    for (const change of ['heard', 'heard-time', 'hash', 'interval', 'clip', 'music', 'page', 'provider', 'script']) {
      const invalid = structuredClone(row.record)
      if (change === 'heard') invalid.audioEvidence!.heard = []
      if (change === 'heard-time') {
        invalid.audioEvidence!.heard[0]!.startTime = 40; invalid.audioEvidence!.heard[0]!.endTime = 45
        invalid.audioEvidence!.heard[1]!.startTime = 45; invalid.audioEvidence!.heard[1]!.endTime = 50
      }
      if (change === 'hash') invalid.artifact!.sha256 = '0'.repeat(64)
      if (change === 'interval') invalid.audioEvidence!.inspectedEndSeconds++
      if (change === 'clip') invalid.clip!.audioSha256 = '0'.repeat(64)
      if (change === 'music') invalid.inspection!.facts.musicFraction = { status: 'unknown', reason: 'Not inspected' }
      if (change === 'page') invalid.segment.episode.pageUrl = VOA_LESSON_CANDIDATES[0]!.pageUrl
      if (change === 'provider') invalid.audioEvidence!.heard[0]!.body = 'A page-only match cannot supply heard audio.'
      if (change === 'script') (invalid.segment.episode as unknown as { candidateAudit: { transcriptSha256: string } }).candidateAudit.transcriptSha256 = '0'.repeat(64)
      expect(reviewVoaLifeTaskDialogue(invalid, row.config, now), change).toBeNull()
    }
  })
  it('prefers an eligible everyday clip despite technology interest and does not fill the remaining batch with technical-only clips', async () => {
    const rows = [await screenedTaskFixture(testSource('everyday-test'), phrases)]
    for (const label of ['alpha', 'beta', 'gamma']) rows.push(await screenedTaskFixture(testSource(`tech-${label}`), Array.from({ length: 6 }, (_, i) =>
      `At work our meeting covers software code running a linux model on a computer and the app will test each change in ${label} step ${i}.`)))
    const db = new MemoryRpc(), client: ContentAdminClient = { rpc: async (name, input) => input?.action === 'candidates'
      ? { data: { candidates: rows, recent: [] }, error: null } : db.rpc(name, input) }
    const selected = await selectAndPersistContentLessons({ adminClient: client, ownerId, sources: rows.map(row => row.config), now: () => now,
      requestId: 'test-variety', profile: { targetDifficulty: 0.45, fatigue: 0, interests: ['Technology'] }, limit: 3 })
    expect(selected[0]?.segmentId).toBe(rows[0]!.id)
    expect(selected).toHaveLength(2)
    expect(db.recommendations).toHaveLength(2)
    expect(selected.every(lesson => lesson.reason.includes('life-task coverage unknown'))).toBe(true)
  })
})

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
  it('normalizes a validated publisher audio/mp3 alias before storage and STT', async () => {
    const opts = options(), base = fetcher(rss(false))
    const frame = new Uint8Array(417); frame.set([255,251,144,0])
    const mp3 = new Uint8Array(frame.length * 4000)
    for (let i = 0; i < 4000; i++) mp3.set(frame, i * frame.length)
    opts.fetcher = async request => request.role === 'audio' ? { ...await base(request), body: mp3, contentType: 'audio/mp3' } : base(request)
    opts.transcribe = vi.fn(async request => ({ audioSha256: request.audio.sha256, requestFingerprint: request.requestFingerprint,
      audioDurationSeconds: contentAudioDuration(request.audio.bytes, request.audio.mimeType), provider: 'fixture-stt', evidenceId: 'TEST-STT', usage,
      transcriptJson: JSON.stringify({ version: '1.0.0', segments: phrases.map((body, i) => ({ startTime: i * 10, endTime: (i + 1) * 10, body })) }) }))
    const result = await runContentRefresh(opts)
    expect(result.errors).toEqual([])
    expect(opts.transcribe).toHaveBeenCalledOnce()
    const audio = vi.mocked(opts.transcribe).mock.calls[0]![0].audio
    expect(audio.mimeType).toBe('audio/mpeg')
    expect(Buffer.compare(Buffer.from(audio.bytes), Buffer.from(mp3))).toBe(0)
    expect(audio.sha256).toBe(createHash('sha256').update(mp3).digest('hex'))
    expect(Buffer.compare(Buffer.from(await opts.audioStore!.get(audio.objectPath)), Buffer.from(mp3))).toBe(0)
    expect(opts.adminClient.calls.find(call => call.action === 'asset')?.args.mimeType).toBe('audio/mpeg')
    expect(result.eligibleSegments).toBe(0) // No actual acoustic approval in this transport fixture.
  })
  it('fetches the same HPR episode through its registered CDN while retaining the original enclosure', async () => {
    const opts = options(), source = ALLOWLISTED_CONTENT_SOURCES.find(row => row.id === 'hacker-public-radio')!
    const original = 'https://hub.hackerpublicradio.org/ccdn.php?filename=/eps/hpr4721/hpr4721.mp3'
    const cdn = 'https://hpr.nyc3.cdn.digitaloceanspaces.com/eps/hpr4721/hpr4721.mp3'
    const feed = rss().replace(`${origin}/episode/one`, 'https://hackerpublicradio.org/eps/hpr4721/index.html')
      .replace(`${origin}/audio/one.mp3`, original).replace(`${origin}/transcript/one.vtt`, 'https://hpr.nyc3.cdn.digitaloceanspaces.com/eps/hpr4721/hpr4721.srt')
    opts.sources = [source]
    opts.rightsPolicies = source.rights.evidenceUrls.map(url => ({ ...rightsPolicies[0]!, url }))
    opts.analyzeAudio = analyzer
    const base = fetcher(feed), audioRequests: string[] = []
    opts.fetcher = async request => {
      if (request.role === 'audio') {
        audioRequests.push(request.url)
        if (request.url !== cdn) throw new Error('Rotating mirror route must not be used')
      }
      return base(request)
    }
    const result = await runContentRefresh(opts)
    expect(result.errors).toEqual([])
    expect(audioRequests).toEqual([cdn])
    expect([...opts.adminClient.items.values()][0]?.episode).toMatchObject({ audioUrl: original })
  })
  it.each(['audio/mp3', 'text/html', 'application/octet-stream'])('never accepts HTML as publisher audio (%s)', async contentType => {
    const opts = options(), base = fetcher(rss(false))
    opts.fetcher = async request => request.role === 'audio'
      ? { ...await base(request), body: new TextEncoder().encode('<html>This is not MP3 audio.</html>'), contentType } : base(request)
    opts.transcribe = vi.fn(async () => { throw new Error('No provider dispatch expected') })
    const result = await runContentRefresh(opts)
    expect(result.nextGates).toContain('invalid-audio-response')
    expect(opts.transcribe).not.toHaveBeenCalled()
    expect(opts.adminClient.calls.some(call => call.action === 'asset')).toBe(false)
    expect(events).not.toContain('budget-reserved')
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
  it.each([true, false])('checks available budget before downloading or reading audio (publisher transcript: %s)', async hasTranscript => {
    const opts = options()
    opts.fetcher = fetcher(rss(hasTranscript))
    const network = vi.fn(opts.fetcher)
    opts.fetcher = network
    opts.analyzeAudio = vi.fn(analyzer)
    opts.transcribe = vi.fn(async () => { throw new Error('No STT dispatch expected') })
    const checkAvailable = vi.fn(async () => false)
    const reserve = vi.fn(opts.budget!.reserve)
    opts.budget = Object.assign({ ...opts.budget!, reserve }, { checkAvailable })
    const result = await runContentRefresh(opts)
    expect(checkAvailable).toHaveBeenCalled()
    expect(network.mock.calls.some(([request]) => request.role === 'audio')).toBe(false)
    expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(0)
    expect(opts.analyzeAudio).not.toHaveBeenCalled()
    expect(opts.transcribe).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(opts.adminClient.items.size).toBeGreaterThan(0)
    expect(result.eligibleSegments).toBe(0)
    expect(result.nextGates).toContain('content-budget-denied-before-audio')
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
  it('fails closed before media I/O when the budget preflight is unavailable', async () => {
    const opts = options(), network = vi.fn(opts.fetcher!)
    opts.fetcher = network; opts.analyzeAudio = vi.fn(analyzer)
    opts.budget!.checkAvailable = async () => { throw new GatewayError(503, 'CONTENT_BUDGET', 'Unavailable') }
    const result = await runContentRefresh(opts)
    expect(network.mock.calls.some(([request]) => request.role === 'audio')).toBe(false)
    expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(0)
    expect(opts.analyzeAudio).not.toHaveBeenCalled()
    expect(result.eligibleSegments).toBe(0)
  })
  it('still reserves atomically after a successful advisory preflight', async () => {
    const opts = options(), checkAvailable = vi.fn(async () => true)
    const reserve = vi.fn(async () => ({ allowed: false, acquired: false, reservationId: 'competing-call' }))
    opts.budget = { ...budget(), checkAvailable, reserve }; opts.analyzeAudio = vi.fn(analyzer)
    await runContentRefresh(opts)
    expect(checkAvailable).toHaveBeenCalledOnce(); expect(reserve).toHaveBeenCalledOnce()
    expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(1)
    expect(opts.analyzeAudio).not.toHaveBeenCalled()
  })
  it('does not read retained private audio when the next run has a paused budget', async () => {
    const opts = options(), store = opts.audioStore as ReturnType<typeof makeStore>
    opts.analyzeAudio = vi.fn(analyzer)
    const reserve = vi.fn(async () => ({ allowed: false, acquired: false, reservationId: 'no-dispatch' }))
    opts.budget = { ...budget(), reserve }
    await runContentRefresh(opts)
    expect(store.blobs.size).toBe(1)
    const retained = [...store.blobs.entries()].map(([path, bytes]) => [path, createHash('sha256').update(bytes).digest('hex')])
    const get = vi.spyOn(store, 'get'), put = vi.spyOn(store, 'put'), network = vi.fn(opts.fetcher!)
    const checkAvailable = vi.fn(async () => false)
    opts.fetcher = network; opts.budget.checkAvailable = checkAvailable; reserve.mockClear()
    const result = await runContentRefresh(opts)
    expect(checkAvailable).toHaveBeenCalledOnce()
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled()
    expect(network.mock.calls.some(([request]) => request.role === 'audio')).toBe(false)
    expect(reserve).not.toHaveBeenCalled(); expect(opts.analyzeAudio).not.toHaveBeenCalled()
    expect([...store.blobs.entries()].map(([path, bytes]) => [path, createHash('sha256').update(bytes).digest('hex')])).toEqual(retained)
    expect(result.nextGates).toContain('content-budget-denied-before-audio')
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
  it.each(['CONTENT_AUDIO_SCHEMA', 'CONTENT_AUDIO_CATALOG', 'CONTENT_STT_TIMING', 'CONTENT_AUDIO_PROVIDER_FAILURE',
    'CONTENT_AUDIO_PREFIX_COVERAGE', 'CONTENT_AUDIO_PREFIX_RESERVOIR'])(
    'retains the trusted %s code without persisting raw provider details or clearing its hold', async code => {
      const opts = options()
      opts.fetcher = fetcher(rss(false))
      opts.transcribe = async () => { throw new GatewayError(503, code, 'PRIVATE provider response and credential') }
      const result = await runContentRefresh(opts)
      expect(result.errors).toContainEqual({ sourceId: testSource().id, code })
      expect(opts.adminClient.calls.find(call => call.action === 'finish-item')?.args.reasons).toEqual([code])
      expect(events.filter(event => event.startsWith('budget-'))).toEqual(['budget-reserved', 'budget-uncertain'])
      expect(result.eligibleSegments).toBe(0)
      expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(1)
      expect(JSON.stringify([result, opts.adminClient.calls])).not.toContain('PRIVATE')
    })
  it.each(['unknown-code', 'lookalike'])(
    'redacts %s even when it resembles a typed content service failure', async kind => {
      const opts = options()
      opts.analyzeAudio = async () => {
        if (kind === 'unknown-code') throw new GatewayError(503, 'CONTENT_AUDIO_PRIVATE_VALUE', 'PRIVATE message')
        throw Object.assign(new Error('PRIVATE message'), { code: 'CONTENT_AUDIO_SCHEMA' })
      }
      const result = await runContentRefresh(opts)
      expect(result.errors).toContainEqual({ sourceId: testSource().id, code: 'content-operation-failed' })
      expect(events).toContain('budget-uncertain')
      expect(JSON.stringify([result, opts.adminClient.calls])).not.toContain('PRIVATE')
    })
  it.each(['unsupported-analysis', 'out-of-range-analysis', 'unsupported-stt'])('rejects %s before reserving provider spend and retains saved work', async kind => {
    const opts = options(), base = fetcher(rss(kind !== 'unsupported-stt'))
    opts.fetcher = async request => request.role === 'audio' ? { ...await base(request),
      body: kind === 'out-of-range-analysis' ? pcmFixture(10) : fixtureAudio.slice(),
      contentType: kind === 'out-of-range-analysis' ? 'audio/wav' : 'audio/mp4' } : base(request)
    opts.analyzeAudio = vi.fn(async () => { throw new Error('Unsupported media must not reach analysis') })
    opts.transcribe = vi.fn(async () => { throw new Error('Unsupported media must not reach STT') })
    const result = await runContentRefresh(opts)
    expect(result.eligibleSegments).toBe(0)
    expect(opts.analyzeAudio).not.toHaveBeenCalled()
    expect(opts.transcribe).not.toHaveBeenCalled()
    expect(events.filter(event => event.startsWith('budget-'))).toEqual([])
    expect(opts.adminClient.calls.some(call => call.action === 'usage')).toBe(false)
    expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(1)
    if (kind !== 'unsupported-stt') expect(opts.adminClient.records.size).toBe(1)
    expect(result.nextGates).toContain(kind === 'unsupported-stt' ? 'content-transcription-decoder-required' : 'content-clip-decoder-required')
  })
  it('preflights the real routed STT media limit without a provider request or spending hold', async () => {
    const opts = options(), base = fetcher(rss(false)), bytes = pcmFixture(700)
    // Valid 350-second PCM container whose routed first-window payload exceeds10MiB.
    const header = new DataView(bytes.buffer)
    header.setUint32(24, 16000, true); header.setUint32(28, 32000, true)
    const network = vi.fn(async () => { throw new Error('No network request is permitted in media preflight') })
    const services = createContentAudioServices({ env: name => name === 'OPENROUTER_API_KEY' ? 'fixture-only' : undefined, fetcher: network })
    opts.prepareTranscription = services.prepareTranscription
    opts.transcribe = vi.fn(services.transcribe)
    opts.fetcher = async request => request.role === 'audio' ? { ...await base(request), body: bytes } : base(request)
    const result = await runContentRefresh(opts)
    expect(result.nextGates).toContain('content-transcription-decoder-required')
    expect(opts.transcribe).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(events.filter(event => event.startsWith('budget-'))).toEqual([])
    expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(1)
    // A direct upload provider is not incorrectly constrained to routed inline limits.
    const direct = createContentAudioServices({ env: name => name === 'GEMINI_API_KEY' ? 'fixture-only' : undefined, fetcher: network })
    const audio = { bytes, mimeType: 'audio/wav', sha256: createHash('sha256').update(bytes).digest('hex'), objectPath: 'fixture' }
    expect(() => direct.prepareTranscription(audio)).not.toThrow()
    expect(network).not.toHaveBeenCalled()
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
  it('preserves encoded spaces in the exact signed ART19 filename without decoding the URL', () => {
    const rules = ALLOWLISTED_CONTENT_SOURCES.find(s => s.id === 'jb-linux-unplugged')!.urls.audio
    const base = `https://content.production.cdn.art19.com/validation=1788941300,d5179406-df6b-56e1-98ee-b124b1df8de2,abcdefghijklmnopqrstuvw/episodes/d12d00dc-a590-4ec0-8446-7c2136304bae/${'a'.repeat(128)}/`
    const url = `${base}Linux%20Unplugged%20666%20Ads.mp3`
    expect(validateSourceUrl(url, rules)).toBe(url)
    expect(validateSourceUrl(`${base}${'%20'.repeat(512)}.mp3`, rules)).toBe(`${base}${'%20'.repeat(512)}.mp3`)
    for (const name of ['Linux Unplugged', 'Linux%09Unplugged', 'Linux%0aUnplugged', 'Linux%0dUnplugged', 'Linux%00Unplugged',
      'Linux%2520Unplugged', 'Linux%2fUnplugged', 'Linux%5cUnplugged', '%2e%2e', '../audio', 'Linux%20../audio',
      'Linux%20%252fsecret', 'Linux%20%41udio', '%20'.repeat(513), 'Linux%20Unplugged.html']) {
      expect(() => validateSourceUrl(`${base}${name}.mp3`, rules), name).toThrow()
    }
    expect(() => validateSourceUrl(url.replace('content.production.cdn.art19.com', 'other.art19.com'), rules)).toThrow()
    expect(() => validateSourceUrl(url + '?token=fixture', rules)).toThrow()
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
  it.each(['jb-the-launch', 'jb-linux-unplugged', 'open-yap-sample'])(
    '%s supports verified byte-zero prefix acquisition without downloading the full episode', async id => {
      const source = ALLOWLISTED_CONTENT_SOURCES.find(row => row.id === id)!
      expect((await revalidateContentRights({ source })).status).toBe('verified')
      const feed = await fetchContentResource({ source, role: 'feed', url: source.feedUrl, maxBytes: 12 * 1024 * 1024 })
      expect(feed.status).toBe(200)
      const batch = (source.feedFormat === 'open-yap-preview-jsonl' ? parseOpenYapPreviewManifest : parseRssFeed)(
        new TextDecoder().decode(feed.body), source, { now: Date.now(), maxItems: 3 })
      const episode = (id === 'open-yap-sample' ? batch.episodes.find(item => item.guid === 'conv_d4005da6db98.mp3') : batch.episodes[0])!
      expect(episode).toBeDefined()
      const response = await fetchContentResource({ source, role: 'audio', url: episode.audioUrl, maxBytes: 4096, audioPrefixBytes: 4096 })
      expect(response.status).toBe(206)
      expect(response.body.length).toBe(4096)
      expect(response.byteCoverage).toMatchObject({ kind: 'prefix', start: 0, endExclusive: 4096 })
      expect(response.byteCoverage!.totalBytes).toBeGreaterThan(4096)
      expect(['audio/mpeg', 'audio/mp3']).toContain(response.contentType)
      console.info(JSON.stringify({ actualPrefixProbe: id, receivedBytes: response.body.length, sourceBytes: response.byteCoverage!.totalBytes,
        acquiredSha256: createHash('sha256').update(response.body).digest('hex'), timingVerified: false, acousticallyReviewed: false }))
    }, 60000)
  it('fetches an exact HPR MP3 enclosure from the registered stable CDN and extracts measured frames', async () => {
    const source = ALLOWLISTED_CONTENT_SOURCES.find(row => row.id === 'hacker-public-radio')!
    const feed = await fetchContentResource({ source, role: 'feed', url: source.feedUrl, maxBytes: 12 * 1024 * 1024, timeoutMs: 20000 })
    expect(feed.status).toBe(200)
    const episode = parseRssFeed(new TextDecoder().decode(feed.body), source, { now: Date.now() }).episodes.find(row => row.pageUrl === 'https://hackerpublicradio.org/eps/hpr4725/index.html')!
    expect(episode).toBeDefined()
    const url = resolveEpisodeAudioUrl(episode, source)
    expect(url).toBe('https://hpr.nyc3.cdn.digitaloceanspaces.com/eps/hpr4725/hpr4725.mp3')
    const audio = await fetchContentResource({ source, role: 'audio', url, exactUrls: [url], maxBytes: 32 * 1024 * 1024, timeoutMs: 20000 })
    expect(audio.status).toBe(200)
    expect(audio.contentType).toBe('audio/mpeg')
    expect(audio.dnsPinning).toBe('pinned-node-lookup')
    expect(contentAudioDuration(audio.body, audio.contentType)).toBeGreaterThan(30)
    const clip = contentAudioWindow(audio.body, audio.contentType, 30, 90)
    expect(clip.mimeType).toBe('audio/mpeg')
    expect(clip.originSeconds).toBeLessThanOrEqual(30)
    expect(clip.endSeconds).toBeGreaterThanOrEqual(90)
    expect(clip.bytes.length).toBeLessThan(10 * 1024 * 1024)
    expect(clip.endSeconds - clip.originSeconds).toBeLessThan(63)
    expect(episode.audioUrl).toContain('https://hub.hackerpublicradio.org/ccdn.php?filename=')
  }, 45000)
  it('validates the exact VOA Plan B publisher MP3 alias and measured clip', async () => {
    const source = ALLOWLISTED_CONTENT_SOURCES.find(row => row.id === 'voa-everyday-grammar')!
    const candidate = VOA_LESSON_CANDIDATES.find(row => row.id === 'voa-lle-plan-b')!
    const response = await fetchContentResource({ source, role: 'audio', url: candidate.audioUrl,
      exactUrls: [candidate.audioUrl], maxBytes: 8 * 1024 * 1024, timeoutMs: 20000 })
    expect(response.status).toBe(200)
    expect(['audio/mp3', 'audio/mpeg']).toContain(response.contentType)
    const duration = contentAudioDuration(response.body, 'audio/mpeg')
    expect(duration).toBeGreaterThan(90)
    const clip = contentAudioWindow(response.body, 'audio/mpeg', 30, 90)
    expect(clip.originSeconds).toBeLessThanOrEqual(30)
    expect(clip.endSeconds).toBeGreaterThanOrEqual(90)
    console.info(JSON.stringify({ actualVoaAliasProbe: true, sourceBytes: response.body.length,
      receivedMime: response.contentType, containerDurationSeconds: duration, clipBytes: clip.bytes.length,
      sourceSha256: createHash('sha256').update(response.body).digest('hex'), acousticallyReviewed: false }))
  }, 30000)
  it('binds six exact VOA everyday scene pages to their real audio and frame clips without promoting candidates', async () => {
    const results = await auditVoaLessonCandidates({ probeAudio: true })
    expect(results).toHaveLength(6)
    for (const row of results) {
      expect(row.rights.status).toBe('verified')
      expect(row.candidate.eligible).toBe(false)
      expect(row.candidate.publisherTranscript.text.length).toBeGreaterThan(500)
      expect(row.candidate.publisherTranscript.timing).toBe('unknown')
      expect(row.taskCoverage).toBe('unknown')
      expect(row.audioProbe?.acousticallyReviewed).toBe(false)
      expect(row.audioProbe!.clipBytes).toBeLessThan(row.audioProbe!.sourceBytes)
      console.info(JSON.stringify({ actualVoaCandidate: row.candidate.id, mediaId: row.candidate.mediaId,
        transcriptSha256: row.transcriptSha256, dialogueLines: row.candidate.publisherTranscript.text.split('\n').length,
        thirdPartyNotices: row.candidate.thirdPartyNotices, ...row.audioProbe }))
    }
  }, 120_000)
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
function mp3PrefixFixture(seconds = 90) {
  // Header/transport fixture with zero data, NOT actual human speech.
  const frames = Math.ceil(seconds * 44100 / 1152), bytes = new Uint8Array(frames * 417)
  for (let i = 0; i < frames; i++) bytes.set([255, 251, 144, 0], i * 417)
  return prepareContentMp3Prefix(bytes, 'audio/mpeg', { kind: 'prefix', start: 0,
    endExclusive: bytes.length, totalBytes: bytes.length + 100000 })
}
describe.runIf(process.env.JOVE_CONTENT_PREFIX_DECODE_PROBE === '1')('actual bounded prefix browser decoding (no paid service or lesson approval)', () => {
  it.each(['jb-the-launch', 'jb-linux-unplugged', 'open-yap-sample'])('%s decodes and reaches ended in Chromium and WebKit', async id => {
    const source = ALLOWLISTED_CONTENT_SOURCES.find(row => row.id === id)!
    expect((await revalidateContentRights({ source })).status).toBe('verified')
    const feed = await fetchContentResource({ source, role: 'feed', url: source.feedUrl, maxBytes: 12 * 1024 * 1024 })
    expect(feed.status).toBe(200)
    const batch = (source.feedFormat === 'open-yap-preview-jsonl' ? parseOpenYapPreviewManifest : parseRssFeed)(
      new TextDecoder().decode(feed.body), source, { now: Date.now(), maxItems: 3 })
    const episode = (id === 'open-yap-sample' ? batch.episodes.find(item => item.guid === 'conv_d4005da6db98.mp3') : batch.episodes[0])!
    expect(episode).toBeDefined()
    const cap = 2 * 1024 * 1024
    const response = await fetchContentResource({ source, role: 'audio', url: episode.audioUrl, maxBytes: cap, audioPrefixBytes: cap })
    expect(response.status).toBe(206)
    const prefix = prepareContentMp3Prefix(response.body, response.contentType, response.byteCoverage, 90)
    expect(prefix.coverage.endSeconds).toBeGreaterThan(30)
    expect(prefix.coverage.sourceBytes).toBeGreaterThan(prefix.coverage.receivedBytes)
    const clip = contentMp3PrefixWindow(prefix, 5, 25)
    const { chromium, webkit } = await import('@playwright/test')
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: true })
      try {
        const page = await browser.newPage()
        // Use an isolated trustworthy loopback document, never the owner's
        // app/session. Windows WebKit's missing Web Audio remains a failed gate.
        await page.route('http://127.0.0.1/jove-prefix-probe/', route => route.fulfill({
          contentType: 'text/html', body: '<!doctype html><title>Isolated audio decoder probe</title>',
        }))
        await page.goto('http://127.0.0.1/jove-prefix-probe/')
        const observed = await page.evaluate(async encoded => {
          const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
          const context = new AudioContext(), player = new Audio(), url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            return await Promise.race([(async () => {
              const audio = await context.decodeAudioData(bytes.buffer.slice(0)), samples = audio.getChannelData(0)
              let peak = 0
              for (const sample of samples) { if (!Number.isFinite(sample)) throw new Error('nonfinite-decoded-sample'); peak = Math.max(peak, Math.abs(sample)) }
              const metadata = new Promise<void>((resolve, reject) => {
                player.onloadedmetadata = () => resolve(); player.onerror = () => reject(new Error('native-mp3-playback-failed'))
              })
              player.muted = true; player.src = url; player.load(); await metadata
              const declaredDuration = player.duration
              const ended = new Promise<void>((resolve, reject) => {
                player.onended = () => resolve(); player.onerror = () => reject(new Error('native-mp3-playback-failed'))
              })
              await player.play()
              player.currentTime = Math.max(0, Math.min(audio.duration, declaredDuration) - 0.2)
              await ended
              return { decodedDuration: audio.duration, channels: audio.numberOfChannels, sampleRate: audio.sampleRate,
                peak, declaredDuration, ended: player.ended }
            })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('native-mp3-decode-timeout')), 15000) })])
          } finally {
            clearTimeout(timer); player.pause(); player.removeAttribute('src'); player.load(); URL.revokeObjectURL(url); await context.close()
          }
        }, Buffer.from(clip.bytes).toString('base64'))
        expect(observed.ended).toBe(true)
        expect(observed.channels).toBeGreaterThan(0)
        expect(observed.peak).toBeGreaterThan(0.00001)
        expect(Math.abs(observed.decodedDuration - (clip.endSeconds - clip.originSeconds))).toBeLessThan(0.1)
        expect(Math.abs(observed.declaredDuration - observed.decodedDuration)).toBeLessThan(0.2)
        console.info(JSON.stringify({ actualPrefixDecode: id, engine: engine.name(), coverage: prefix.coverage,
          artifactSha256: createHash('sha256').update(prefix.bytes).digest('hex'), clipSha256: createHash('sha256').update(clip.bytes).digest('hex'),
          ...observed, acousticallyReviewed: false }))
      } finally { await browser.close() }
    }
  }, 90000)
})

describe('versioned prefix acquisition and recovery (synthetic media, not human approval)', () => {
  function setup(seconds = 90, withTranscript = true) {
    const opts = options(), prefix = mp3PrefixFixture(seconds), base = fetcher(rss(withTranscript))
    opts.audioAcquisition = 'mpeg-prefix-v1'
    opts.limits = { ...opts.limits, audioBytes: prefix.bytes.length }
    opts.fetcher = async request => {
      if (request.role !== 'audio') return base(request)
      expect(request.audioPrefixBytes).toBe(prefix.bytes.length)
      return { ...(await base(request)), body: prefix.bytes, status: 206, contentType: 'audio/mpeg',
        byteCoverage: { kind: 'prefix', start: 0, endExclusive: prefix.bytes.length, totalBytes: prefix.bytes.length + 100000 } }
    }
    return { opts, prefix }
  }
  it('stores the exact prefix and covered clip without treating 45 seconds as a full episode', async () => {
    const { opts } = setup(45)
    opts.analyzeAudio = analyzer
    const result = await runContentRefresh(opts)
    expect(result.errors).toEqual([])
    expect(result.eligibleSegments).toBe(1)
    const record = [...opts.adminClient.records.values()][0]!
    expect(record.segment.endSeconds).toBe(40)
    expect(record.segment.episode.durationSeconds).toBeNull()
    expect(record.artifact!.coverage).toMatchObject({ version: 'mpeg-prefix-v1', startSeconds: 0 })
    expect(record.artifact!.durationSeconds).toBeCloseTo(record.artifact!.coverage!.endSeconds, 8)
    expect(record.clip!.timingBasis).toBe('mpeg-frame-count-with-xing-v1')
    expect([...((opts.audioStore as ReturnType<typeof makeStore>).blobs.keys())].sort().map(path => path.split('/')[0])).toEqual(['clips', 'prefixes'])
    expect(opts.adminClient.calls.find(call => call.action === 'clip')!.args.acquisitionVersion).toBe('mpeg-prefix-v1')
    expect(opts.adminClient.intents.size).toBe(1)
  })
  it('restores bound prefix STT and its original source duration without another STT dispatch', async () => {
    const { opts } = setup(90, false)
    const transcribe = vi.fn(async (request: Parameters<NonNullable<ContentRefreshOptions['transcribe']>>[0]) => ({
      requestFingerprint: request.requestFingerprint, audioSha256: request.audio.sha256,
      audioDurationSeconds: contentAudioDuration(request.audio.bytes, request.audio.mimeType),
      transcriptJson: JSON.stringify({ version: '1.0.0', segments: phrases.map((body, i) => ({ startTime: i * 10, endTime: (i + 1) * 10, body })) }),
      provider: 'fixture-only', evidenceId: 'synthetic-prefix-stt', usage,
    }))
    opts.transcribe = transcribe
    expect((await runContentRefresh(opts)).errors).toEqual([])
    expect(transcribe).toHaveBeenCalledOnce()
    const item = [...opts.adminClient.items.values()][0]!
    expect(item.transcript!.reference.derivation!.audioCoverage!.version).toBe('mpeg-prefix-v1')
    expect((item.episode as FeedEpisode).durationSeconds).toBeNull()
    opts.analyzeAudio = analyzer
    expect((await runContentRefresh(opts)).errors).toEqual([])
    expect(transcribe).toHaveBeenCalledOnce()
    expect([...opts.adminClient.records.values()][0]!.status).toBe('eligible')
    expect([...opts.adminClient.records.values()][0]!.segment.episode.durationSeconds).toBeNull()
  })
  it('rejects inconsistent restored coverage before another spending reservation', async () => {
    const { opts } = setup()
    opts.analyzeAudio = async () => { throw new Error('Synthetic interrupted analysis') }
    await runContentRefresh(opts)
    const item = [...opts.adminClient.items.values()][0]!
    item.audio_coverage!.frameCount++
    const reserved = events.filter(event => event === 'budget-reserved').length
    const result = await runContentRefresh(opts)
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'CONTENT_AUDIO_PREFIX_COVERAGE' }))
    expect(events.filter(event => event === 'budget-reserved')).toHaveLength(reserved)
  })
  it('refuses a changed model fingerprint for the same interrupted analysis before spending', async () => {
    const { opts } = setup()
    const analyze = vi.fn(async () => { throw new Error('Synthetic interrupted analysis') })
    opts.analyzeAudio = analyze
    await runContentRefresh(opts)
    const reserved = events.filter(event => event === 'budget-reserved').length
    opts.analyzerVersion = 'fixture-updated-model'
    const result = await runContentRefresh(opts)
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'content-provider-reconciliation-required' }))
    expect(events.filter(event => event === 'budget-reserved')).toHaveLength(reserved)
    expect(analyze).toHaveBeenCalledOnce()
  })
  it.each(['non-mpeg-partial', 'missing-coverage', 'storage-failure'] as const)('does not reserve or dispatch when prefix preparation fails: %s', async failure => {
    const { opts } = setup()
    const fetch = opts.fetcher!
    opts.fetcher = async request => {
      const response = await fetch(request)
      if (request.role !== 'audio') return response
      return { ...response, ...(failure === 'non-mpeg-partial' ? { contentType: 'audio/ogg' } : {}),
        ...(failure === 'missing-coverage' ? { byteCoverage: undefined } : {}) }
    }
    if (failure === 'storage-failure') opts.audioStore!.put = async () => { throw new Error('Synthetic prefix persistence failure') }
    const analyze = vi.fn(analyzer)
    opts.analyzeAudio = analyze
    const result = await runContentRefresh(opts)
    expect(result.errors).toHaveLength(1)
    expect(result.eligibleSegments).toBe(0)
    expect(events).not.toContain('budget-reserved')
    expect(opts.adminClient.intents.size).toBe(0)
    expect(analyze).not.toHaveBeenCalled()
    expect(opts.adminClient.calls.filter(call => call.action === 'asset-ready')).toHaveLength(0)
  })
  it('preserves a small complete WAV acquisition when prefix mode receives a complete representation', async () => {
    const opts = options()
    opts.audioAcquisition = 'mpeg-prefix-v1'
    opts.analyzeAudio = analyzer
    const result = await runContentRefresh(opts)
    expect(result.errors).toEqual([])
    expect(result.eligibleSegments).toBe(1)
    const record = [...opts.adminClient.records.values()][0]!
    expect(record.artifact!.coverage).toBeUndefined()
    expect(record.artifact!.sha256).toBe(createHash('sha256').update(fixtureAudio).digest('hex'))
    expect([...((opts.audioStore as ReturnType<typeof makeStore>).blobs.keys())].sort().map(path => path.split('/')[0])).toEqual(['clips', 'episodes'])
  })
  it('lets the atomic budget gate refuse the same unresolved prefix intent without another dispatch', async () => {
    const { opts } = setup()
    const reserve = vi.spyOn(opts.budget!, 'reserve')
    const analyze = vi.fn(async () => { throw new Error('Synthetic unknown provider outcome') })
    opts.analyzeAudio = analyze
    await runContentRefresh(opts)
    expect(analyze).toHaveBeenCalledOnce()
    reserve.mockResolvedValue({ allowed: true, acquired: false, replay: true, reservationId: 'existing-synthetic-hold' })
    const result = await runContentRefresh(opts)
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'content-provider-reconciliation-required' }))
    expect(reserve).toHaveBeenCalledTimes(2)
    expect(reserve.mock.calls[1]![0]).toEqual(reserve.mock.calls[0]![0])
    expect(opts.adminClient.intents.size).toBe(1)
    expect(analyze).toHaveBeenCalledOnce()
  })
  it('does not reserve or dispatch when an interrupted legacy service ledger has no item mapping', async () => {
    const { opts } = setup()
    const original = opts.adminClient.rpc.bind(opts.adminClient)
    opts.adminClient.rpc = async (name, input) => name === 'content_request_intent'
      ? { data: { allowed: false, reason: 'legacy-ledger-reconciliation-required' }, error: null }
      : original(name, input)
    const reserve = vi.spyOn(opts.budget!, 'reserve')
    const analyze = vi.fn(analyzer)
    opts.analyzeAudio = analyze
    const result = await runContentRefresh(opts)
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'content-provider-reconciliation-required' }))
    expect(reserve).not.toHaveBeenCalled()
    expect(analyze).not.toHaveBeenCalled()
    expect(opts.adminClient.intents.size).toBe(0)
    expect(opts.adminClient.calls.some(call => call.action === 'usage')).toBe(false)
  })
  it('cancels a stalled intent lookup without reserving a paid request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const observed = new Promise<void>(resolve => { started = resolve })
    const { opts } = setup()
    opts.limits = { ...opts.limits, runMs: 20 }
    const original = opts.adminClient.rpc.bind(opts.adminClient)
    opts.adminClient.rpc = async (name, input) => {
      if (name === 'content_request_intent') { started(); await waiting }
      return original(name, input)
    }
    const analyze = vi.fn(analyzer)
    opts.analyzeAudio = analyze
    let finished = false
    const running = runContentRefresh(opts).then(result => { finished = true; return result })
    try {
      await observed
      await vi.advanceTimersByTimeAsync(20)
      expect(finished).toBe(true)
      expect((await running).nextGates).toContain('content-run-timeout-or-cancelled')
      expect(analyze).not.toHaveBeenCalled()
      expect(events).not.toContain('budget-reserved')
    } finally { release(); await running; vi.useRealTimers() }
  })
  it('bounds each prefix job to one audio item and resumes different sources at the same clock time', async () => {
    const { opts } = setup()
    opts.sources = [testSource('batch-a'), testSource('batch-b'), testSource('batch-c')]
    opts.analyzeAudio = analyzer
    const original = opts.fetcher!
    opts.fetcher = request => original({ ...request, etag: null })
    for (let count = 1; count <= 3; count++) {
      const result = await runContentRefresh(opts)
      expect(result.errors).toEqual([])
      expect(result.itemsProcessed).toBe(1)
      expect(result.sourcesClaimed).toBe(1)
      expect(opts.adminClient.audioWork.size).toBe(count)
    }
    expect([...opts.adminClient.audioWork.keys()]).toEqual(planContentSourceRefresh({ sources: opts.sources, limit: 3, now }).sourceIds)
    expect(opts.adminClient.calls.filter(call => call.action === 'finish-item')).toHaveLength(3)
    expect([...opts.adminClient.items.values()].every(item => item.attempts === 1)).toBe(true)
  })
  it('moves past a failed source without counting unstarted sources as failed attempts', async () => {
    const { opts } = setup()
    opts.sources = [testSource('batch-failure-a'), testSource('batch-failure-b')]
    opts.analyzeAudio = analyzer
    const original = opts.fetcher!
    let failedSource = ''
    opts.fetcher = async request => {
      if (request.role === 'audio' && !failedSource) { failedSource = request.source.id; throw Error('Synthetic source unavailable') }
      return original({ ...request, etag: null })
    }
    expect((await runContentRefresh(opts)).errors).toHaveLength(1)
    expect(opts.adminClient.items.size).toBe(1)
    const next = await runContentRefresh(opts)
    expect(next.errors).toEqual([])
    expect(next.sourcesClaimed).toBe(1)
    expect(next.refreshSelection.sourceIds[0]).not.toBe(failedSource)
    expect([...opts.adminClient.items.values()].every(item => item.attempts === 1)).toBe(true)
  })
})

describe('bounded MP3 prefix frame preparation (not acoustic or decoder certification)', () => {
  function frame(version = 3, br = 9, mono = false, crc = false) {
    const rate = 44100 / (version === 3 ? 1 : version === 2 ? 2 : 4)
    const bitrate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[br]! * 1000
    const bytes = new Uint8Array(Math.floor((version === 3 ? 144 : 72) * bitrate / rate))
    bytes.set([255, 224 | version << 3 | 2 | Number(!crc), br << 4, mono ? 192 : 0])
    return bytes
  }
  function join(...parts: Uint8Array[]) {
    const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.length }
    return bytes
  }
  function prepare(bytes: Uint8Array, complete = false, seconds = 600) {
    return prepareContentMp3Prefix(bytes, 'audio/mpeg', { kind: complete ? 'complete' : 'prefix', start: 0,
      endExclusive: bytes.length, totalBytes: bytes.length + Number(!complete) * 100000 }, seconds)
  }
  it.each([3, 2, 0])('counts MPEG version %i samples and trims only the final incomplete frame', version => {
    const first = frame(version), bytes = join(first, first, first.subarray(0, 33)), result = prepare(bytes)
    const expected = 2 * (version === 3 ? 1152 : 576) / (44100 / (version === 3 ? 1 : version === 2 ? 2 : 4))
    expect(result.bytes).toEqual(join(first, first))
    expect(result.coverage).toMatchObject({ version: 'mpeg-prefix-v1', startSeconds: 0, endSeconds: expected,
      sourceByteStart: 0, sourceByteEndExclusive: first.length * 2, receivedBytes: bytes.length, frameCount: 2,
      discardedTrailingBytes: 33, removedMetadataFrame: null, gaplessAdjustment: 'not-applied' })
    expect(contentAudioDuration(result.bytes, 'audio/mpeg')).toBeCloseTo(expected, 9)
    expect(() => prepare(bytes, true)).toThrow()
  })
  it('preserves all retained frame bytes and accepts VBR without bitrate-derived timing', () => {
    const bytes = join(frame(3, 5), frame(3, 14), frame(3, 9)), result = prepare(bytes, true)
    expect(result.bytes).toEqual(bytes)
    expect(result.bytes).not.toBe(bytes)
    expect(result.coverage.endSeconds).toBe(3456 / 44100)
    expect(result.coverage.networkKind).toBe('complete')
  })
  it.each([[3, 14], [3, 9], [0, 1]])('preserves exact full-prefix coverage at the 8MiB boundary for MPEG %i bitrate %i', (version, bitrate) => {
    const single = frame(version, bitrate), bytes = new Uint8Array(8 * 1024 * 1024)
    for (let offset = 0; offset < bytes.length; offset += single.length)
      bytes.set(single.subarray(0, Math.min(single.length, bytes.length - offset)), offset)
    const prefix = prepare(bytes), end = prefix.coverage.endSeconds
    const clip = contentMp3PrefixWindow(prefix, 0, end)
    expect(clip.originalDurationSeconds).toBe(end)
    expect(clip.endSeconds).toBeCloseTo(end, 8)
    expect(Buffer.compare(Buffer.from(clip.bytes.subarray(clip.bytes.length - prefix.bytes.length)), Buffer.from(prefix.bytes))).toBe(0)
    const audio = { ...prefix, sha256: createHash('sha256').update(prefix.bytes).digest('hex'), objectPath: 'synthetic-only' }
    const services = createContentAudioServices({ env: name => name === 'OPENROUTER_API_KEY' ? 'fixture-only' : undefined })
    const stt = services.prepareTranscription(audio)
    expect(stt.duration).toBe(end); expect(stt.end).toBe(end)
    expect(stt.window!.originalDurationSeconds).toBe(end)
    expect(() => contentMp3PrefixWindow(prefix, 0, end + 0.000000001)).toThrow()
  })
  it.each([3, 2, 0])('creates a clip-specific Xing header and seek table without rewriting MPEG %i speech frames', version => {
    const first = frame(version), bytes = join(...Array.from({ length: 3000 }, (_, i) => frame(version, i % 2 ? 9 : 5)))
    const prefix = prepare(bytes), before = prefix.bytes.slice(), raw = contentAudioWindow(prefix.bytes, prefix.mimeType, 5, 25)
    const clip = contentMp3PrefixWindow(prefix, 5, 25), head = frame(version)
    const marker = 4 + (version === 3 ? 32 : 17), view = new DataView(clip.bytes.buffer)
    expect(Buffer.compare(Buffer.from(prefix.bytes), Buffer.from(before))).toBe(0)
    expect(Buffer.compare(Buffer.from(clip.bytes.subarray(head.length)), Buffer.from(raw.bytes))).toBe(0)
    expect(new TextDecoder().decode(clip.bytes.subarray(marker, marker + 4))).toBe('Xing')
    expect(view.getUint32(marker + 4)).toBe(7)
    expect(view.getUint32(marker + 8)).toBe(Math.round((raw.endSeconds - raw.originSeconds) * prefix.coverage.sampleRate / prefix.coverage.samplesPerFrame))
    expect(view.getUint32(marker + 12)).toBe(clip.bytes.length)
    const toc = clip.bytes.subarray(marker + 16, marker + 116)
    expect(toc.length).toBe(100); expect(toc[0]).toBe(0)
    expect(Array.from(toc).every((entry, i) => !i || entry >= toc[i - 1]!)).toBe(true)
    expect(toc[99]).toBeGreaterThan(240)
    expect(clip.timingBasis).toBe('mpeg-frame-count-with-xing-v1')
    expect(clip.originalDurationSeconds).toBeCloseTo(prefix.coverage.endSeconds, 8)
    expect(clip.originSeconds).toBe(raw.originSeconds); expect(clip.endSeconds).toBe(raw.endSeconds)
    expect(clip.bytes.length - raw.bytes.length).toBe(first.length)
  })
  it('uses a large enough metadata frame for very low bitrate mono and CRC speech without altering those frames', () => {
    const first = frame(2, 1, true, true), prefix = prepare(join(...Array.from({ length: 1500 }, () => first)))
    const raw = contentAudioWindow(prefix.bytes, prefix.mimeType, 0, 20), clip = contentMp3PrefixWindow(prefix, 0, 20)
    const overhead = clip.bytes.length - raw.bytes.length
    expect(overhead).toBeGreaterThan(4 + 9 + 116)
    expect(clip.bytes[1]! & 1).toBe(1)
    expect(clip.bytes[2]! >> 4).toBe(9)
    expect(Buffer.compare(Buffer.from(clip.bytes.subarray(overhead)), Buffer.from(raw.bytes))).toBe(0)
  })
  it('builds the seek table from actual variable-bitrate frame offsets', () => {
    const prefix = prepare(join(...Array.from({ length: 3000 }, (_, i) => frame(3, i < 1500 ? 5 : 14))))
    const clip = contentMp3PrefixWindow(prefix, 0, prefix.coverage.endSeconds)
    const marker = 36, metadataLength = frame().length
    // Midpoint in time falls on frame 1500, not the midpoint of bytes.
    expect(clip.bytes[marker + 16 + 50]).toBe(Math.floor(256 * (metadataLength + frame(3, 5).length * 1500) / clip.bytes.length))
    expect(clip.bytes[marker + 16 + 50]).toBeLessThan(64)
  })
  it('rejects forged prefix time/frame/byte metadata before returning a playable clip', () => {
    const prefix = prepare(join(...Array.from({ length: 1500 }, () => frame())))
    for (const patch of [{ endSeconds: 500 }, { frameCount: 999 }, { sampleRate: 48000 }, { sourceByteStart: 1 },
      { version: 'unknown' }, { samplesPerFrame: 576 }, { networkKind: 'complete' }, { gaplessAdjustment: 'invented' },
      { discardedTrailingBytes: 100 }, { sourceByteStart: -1 }, { receivedBytes: 10 * 1024 * 1024 },
      { stopReason: 'complete' }, { removedMetadataFrame: 'unknown' }]) expect(() => contentMp3PrefixWindow({ ...prefix,
        coverage: { ...prefix.coverage, ...patch } } as typeof prefix, 5, 20)).toThrow()
    expect(() => contentMp3PrefixWindow(prefix, 0, prefix.coverage.endSeconds + 1)).toThrow()
    expect(() => contentMp3PrefixWindow(prefix, -1, 20)).toThrow()
  })
  it('selects the versioned stored artifact window without changing the legacy clip bytes', () => {
    const prefix = prepare(join(...Array.from({ length: 3000 }, () => frame())))
    const audio = { ...prefix, sha256: createHash('sha256').update(prefix.bytes).digest('hex'), objectPath: 'fixture' }
    const bounded = contentStoredAudioWindow(audio, 5, 65), expected = contentMp3PrefixWindow(prefix, 5, 65)
    expect({ ...bounded, bytes: undefined }).toEqual({ ...expected, bytes: undefined })
    expect(Buffer.compare(Buffer.from(bounded.bytes), Buffer.from(expected.bytes))).toBe(0)
    const legacy = { bytes: audio.bytes, mimeType: audio.mimeType, sha256: audio.sha256, objectPath: audio.objectPath }
    const preserved = contentStoredAudioWindow(legacy, 5, 65), original = contentAudioWindow(legacy.bytes, legacy.mimeType, 5, 65)
    expect({ ...preserved, bytes: undefined }).toEqual({ ...original, bytes: undefined })
    expect(Buffer.compare(Buffer.from(preserved.bytes), Buffer.from(original.bytes))).toBe(0)
  })
  it('rechecks the source reservoir after restoring a prepared prefix', () => {
    const prefix = mp3PrefixFixture()
    prefix.bytes[4] = 1
    expect(() => contentMp3PrefixWindow(prefix, 5, 65)).toThrowError(expect.objectContaining({ code: 'CONTENT_AUDIO_PREFIX_RESERVOIR' }))
  })
  it.each([false, true])('submits a self-contained prefix for STT, for routed provider=%s (synthetic transport)', async routed => {
    const prefix = prepare(join(...Array.from({ length: 3000 }, () => frame())))
    const hash = createHash('sha256').update(prefix.bytes).digest('hex')
    const episode = parseRssFeed(rss(false), testSource(), { now }).episodes[0]!
    const cues = phrases.map((body, i) => ({ startTime: i * 10, endTime: (i + 1) * 10, body }))
    const requests: Record<string, unknown>[] = []
    const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'google/gemini-2.5-flash',
        architecture: { input_modalities: ['audio', 'text'] }, supported_parameters: ['structured_outputs'] }] }))
      requests.push(JSON.parse(init!.body as string))
      return new Response(JSON.stringify(routed ? { id: 'test-prefix-stt', model: 'google/gemini-2.5-flash',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ segments: cues }) } }], usage: { total_tokens: 100, cost: 0.001 } } :
        { responseId: 'test-prefix-stt', modelVersion: 'gemini-2.5-flash', candidates: [{ finishReason: 'STOP',
          content: { parts: [{ text: JSON.stringify({ segments: cues }) }] } }], usageMetadata: { totalTokenCount: 100 } }))
    }) as typeof fetch
    const services = createContentAudioServices({ env: key => key === (routed ? 'OPENROUTER_API_KEY' : 'GEMINI_API_KEY') ? 'synthetic-test-only' : undefined, fetcher: network })
    const audio = { ...prefix, sha256: hash, objectPath: 'fixture' }
    const request = { requestId: 'test-prefix', requestFingerprint: hash, episode, audio,
      sourcePolicy: testSource().rights, sourcePolicyHash: hash, signal: new AbortController().signal }
    const result = await services.transcribe(request)
    expect(result.audioDurationSeconds).toBeCloseTo(prefix.coverage.endSeconds, 9)
    expect(result.audioSha256).toBe(hash)
    const submitted = routed ? (requests[0]!.messages as { content: { input_audio: { data: string } }[] }[])[1]!.content[0]!.input_audio.data :
      (requests[0]!.contents as { parts: { inlineData: { data: string } }[] }[])[0]!.parts[0]!.inlineData.data
    const expected = contentMp3PrefixWindow(prefix, 0, prefix.coverage.endSeconds)
    expect(Buffer.compare(Buffer.from(submitted, 'base64'), Buffer.from(expected.bytes))).toBe(0)
    expect(createHash('sha256').update(Buffer.from(submitted, 'base64')).digest('hex')).not.toBe(hash)
    const calls = vi.mocked(network).mock.calls.length
    await expect(services.transcribe({ ...request, audio: { ...audio, coverage: { ...audio.coverage, frameCount: 999 } } }))
      .rejects.toMatchObject({ code: 'CONTENT_AUDIO_PREFIX_COVERAGE' })
    expect(network).toHaveBeenCalledTimes(calls)
    await services.dispose()
  })
  it('enforces the 600 second cap at a complete frame boundary, not a proportional byte position', () => {
    const one = frame(2, 1), bytes = join(...Array.from({ length: 23000 }, () => one)), result = prepare(bytes)
    expect(result.coverage.frameCount).toBe(Math.floor(600 * 22050 / 576))
    expect(result.coverage.endSeconds).toBeLessThanOrEqual(600)
    expect(result.coverage.endSeconds).toBeGreaterThan(599.97)
    expect(result.bytes.length).toBe(result.coverage.frameCount * one.length)
    expect(result.coverage.stopReason).toBe('duration-limit')
  })
  it.each(['Xing', 'Info', 'VBRI'])('excludes the original %s duration tag frame, records the transformation and never rewrites it', tag => {
    const metadata = frame(), original = frame(), position = 36
    metadata.set(new TextEncoder().encode(tag), position)
    metadata.fill(255, position + 8, position + 16) // Untrusted full-episode totals must not determine prefix timing.
    const bytes = join(metadata, original, original), snapshot = bytes.slice(), result = prepare(bytes)
    expect(bytes).toEqual(snapshot)
    expect(result.bytes).toEqual(join(original, original))
    expect(result.coverage).toMatchObject({ sourceByteStart: metadata.length, removedMetadataFrame: tag, frameCount: 2 })
    expect(result.coverage.endSeconds).toBe(2304 / 44100)
  })
  it.each([[3, true, false], [2, false, true], [0, true, true]] as const)(
    'recognizes the standard info offset for version %i mono %s CRC %s', (version, mono, crc) => {
      const metadata = frame(version, 9, mono, crc), first = frame(version, 9, mono, crc)
      metadata.set(new TextEncoder().encode('Info'), 4 + (version === 3 ? mono ? 17 : 32 : mono ? 9 : 17))
      expect(prepare(join(metadata, first, first)).coverage.removedMetadataFrame).toBe('Info')
    })
  it('rejects a first retained frame requiring a missing reservoir and a second metadata frame', () => {
    const first = frame(), dependent = frame(); dependent[4] = 1
    const info = frame(); info.set(new TextEncoder().encode('Info'), 36)
    expect(() => prepare(join(dependent, first))).toThrow()
    expect(() => prepare(join(info, dependent, first))).toThrow()
    expect(() => prepare(join(first, info, first))).toThrow()
  })
  it.each([1, 2, 3])('accepts only a matching %i-byte partial header at the range boundary', tailLength => {
    const first = frame(), good = join(first, first, first.subarray(0, tailLength))
    expect(prepare(good).coverage.discardedTrailingBytes).toBe(tailLength)
    const bad = good.slice(); bad[bad.length - 1] = 0
    expect(() => prepare(bad)).toThrow()
    expect(() => prepare(good, true)).toThrow()
  })
  it('refuses corrupt/interior junk, concatenated formats and even corruption after the retained duration cap', () => {
    const first = frame(), bad = first.slice(); bad[0] = 0
    for (const bytes of [join(first, bad, first), join(first, frame(2), first), join(first, frame(3, 9, true), first),
      join(first, first, new Uint8Array([0])), join(first, first, bad)]) expect(() => prepare(bytes, false, 0.06)).toThrow()
  })
  it('strips a complete bounded ID3v2 tag and validates a present v2.4 footer', () => {
    const first = frame(), tag = new Uint8Array(32)
    tag.set([73,68,51,4,0,16,0,0,0,12]); tag.set([51,68,73,4,0,16,0,0,0,12], 22)
    const result = prepare(join(tag, first, first))
    expect(result.coverage.sourceByteStart).toBe(32)
    expect(result.bytes).toEqual(join(first, first))
    tag[24] = 0; expect(() => prepare(join(tag, first, first))).toThrow()
  })
  it.each([
    [73,68,51,4,0,0,0,127,127,127], // Incomplete tag, not evidence of a complete frame.
    [73,68,51,4,0,0,1,0,0,0], // Over the 1MiB metadata bound.
    [73,68,51,3,0,16,0,0,0,0], // Footer flag does not exist in ID3v2.3.
    [73,68,51,4,0,1,0,0,0,0], // Unknown flag.
    [73,68,51,4,255,0,0,0,0,0],
    [73,68,51,4,0,0,0,0,0,128],
  ])('rejects malformed or oversized ID3 metadata %j', header => {
    expect(() => prepare(join(new Uint8Array(header), frame(), frame()))).toThrow()
  })
  it('accepts a complete trailing ID3v1 tag only when the source representation is complete', () => {
    const first = frame(), tag = new Uint8Array(128); tag.set([84,65,71])
    const bytes = join(first, first, tag)
    expect(prepare(bytes, true).bytes).toEqual(join(first, first))
    expect(() => prepare(bytes)).toThrow()
  })
  it('requires consistent explicit byte coverage, an MP3 MIME and a bounded duration before parsing', () => {
    const bytes = join(frame(), frame()), valid = { kind: 'prefix' as const, start: 0 as const, endExclusive: bytes.length, totalBytes: 9000 }
    for (const coverage of [undefined, { ...valid, start: 1 }, { ...valid, endExclusive: 800 },
      { ...valid, totalBytes: bytes.length }, { ...valid, totalBytes: Infinity }, { ...valid, kind: 'complete' }, { ...valid, kind: 'unknown' }])
      expect(() => prepareContentMp3Prefix(bytes, 'audio/mpeg', coverage as typeof valid)).toThrow()
    for (const seconds of [0, -1, NaN, Infinity, 601]) expect(() => prepare(bytes, false, seconds)).toThrow()
    expect(() => prepareContentMp3Prefix(bytes, 'audio/aac', valid)).toThrow()
    expect(() => prepare(new Uint8Array(8 * 1024 * 1024 + 1))).toThrow()
    expect(() => prepare(frame())).toThrow()
  })
})

describe('real audio service contract (synthetic transport tests, not acoustic validation)', () => {
  it.each(['openrouter', 'gemini'].flatMap(provider => [400, 401, 402, 403, 408, 413, 429, 500, 502, 503]
    .map(status => ({ provider, status }))))(
    'retains bounded $provider HTTP $status diagnostics without body data, retries or a settled charge', async ({ provider, status }) => {
      const opts = options()
      opts.fetcher = fetcher(rss(false))
      const cancel = vi.fn(() => {
        if (status === 502) throw new Error('PRIVATE cancellation failure')
        if (status === 503) return new Promise<void>(() => {})
      })
      const failure = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('PRIVATE response and credential')) }, cancel,
      }), { status, headers: { 'x-private': 'PRIVATE header' } })
      const network = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'google/gemini-2.5-flash',
          architecture: { input_modalities: ['audio'] }, supported_parameters: ['structured_outputs'] }] }))
        return failure
      }) as typeof fetch
      opts.transcribe = createContentAudioServices({ env: name => name ===
        (provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'GEMINI_API_KEY') ? 'synthetic-only' : undefined,
      fetcher: network }).transcribe
      const settle = vi.fn(opts.budget!.settle)
      opts.budget = { ...opts.budget!, settle }
      const result = await runContentRefresh(opts)
      const code = status === 429 ? 'CONTENT_AUDIO_RATE_LIMIT' : 'CONTENT_AUDIO_PROVIDER_FAILURE'
      expect(opts.adminClient.calls.find(call => call.action === 'usage')?.args.usage).toEqual({
        costUsd: null, errorCode: code, httpDiagnostic: { provider, stage: 'generate', status },
      })
      expect(settle).toHaveBeenCalledExactlyOnceWith({ reservationId: 'test-budget', status: 'uncertain', usage: null })
      expect(network).toHaveBeenCalledTimes(provider === 'openrouter' ? 2 : 1)
      expect(cancel).toHaveBeenCalledOnce()
      expect(result.errors).toContainEqual({ sourceId: testSource().id, code })
      expect(result.eligibleSegments).toBe(0)
      expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(1)
      expect(JSON.stringify([result, opts.adminClient.calls])).not.toContain('PRIVATE')
    })
  it('distinguishes a public catalog HTTP failure from a generation attempt', async () => {
    const opts = options()
    opts.fetcher = fetcher(rss(false))
    const cancel = vi.fn()
    const network = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 503 }))
    opts.transcribe = createContentAudioServices({ env: name => name === 'OPENROUTER_API_KEY' ? 'synthetic-only' : undefined,
      fetcher: network }).transcribe
    const result = await runContentRefresh(opts)
    expect(opts.adminClient.calls.find(call => call.action === 'usage')?.args.usage).toEqual({
      costUsd: null, errorCode: 'CONTENT_AUDIO_CATALOG', httpDiagnostic: { provider: 'openrouter', stage: 'catalog', status: 503 },
    })
    expect(network).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce()
    expect(events.filter(event => event.startsWith('budget-'))).toEqual(['budget-reserved', 'budget-uncertain'])
    expect(result.eligibleSegments).toBe(0)
  })
  it.each(['schema', 'timing', 'incomplete', 'unknown-cost', 'zero-cost'])(
    'keeps the provider receipt for rejected %s without approving a lesson or replaying', async kind => {
      const opts = options()
      opts.fetcher = fetcher(rss(false))
      const costUsd = kind === 'unknown-cost' ? null : kind === 'zero-cost' ? 0 : 0.008
      const network = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'google/gemini-2.5-flash',
          architecture: { input_modalities: ['audio'] }, supported_parameters: ['structured_outputs'] }] }))
        return new Response(JSON.stringify({ id: 'gen-synthetic-rejected-content', model: 'google/gemini-2.5-flash',
          choices: [{ finish_reason: kind === 'incomplete' ? 'length' : 'stop', message: { content: JSON.stringify(
            kind === 'timing' ? { segments: [{ startTime: 10, endTime: 5, body: 'PRIVATE invalid cue' }] } : { segments: 'PRIVATE invalid response' }) } }],
          usage: { total_tokens: 123, cost: costUsd } }))
      }) as typeof fetch
      const services = createContentAudioServices({ env: name => name === 'OPENROUTER_API_KEY' ? 'synthetic-only' : undefined, fetcher: network })
      opts.transcribe = services.transcribe
      const settle = vi.fn(opts.budget!.settle)
      opts.budget = { ...opts.budget!, settle }
      const result = await runContentRefresh(opts)
      expect(network).toHaveBeenCalledTimes(2)
      expect(result.eligibleSegments).toBe(0)
      expect(settle).toHaveBeenCalledExactlyOnceWith({ reservationId: 'test-budget', status: 'uncertain',
        usage: { provider: 'openrouter-native-audio', model: 'google/gemini-2.5-flash', units: 123, unitName: 'tokens', costUsd } })
      const recorded = opts.adminClient.calls.find(call => call.action === 'usage')?.args
      expect(recorded).toMatchObject({ status: 'uncertain', usage: { costUsd, units: 123, providerRequestId: 'gen-synthetic-rejected-content' } })
      expect((opts.audioStore as ReturnType<typeof makeStore>).blobs.size).toBe(1)
      expect(JSON.stringify([result, opts.adminClient.calls])).not.toContain('PRIVATE')
    })
  it.each(['id', 'model', 'units', 'lookalike-error', 'lookalike-http'])(
    'keeps an unknown charge when %s cannot establish a valid receipt', async kind => {
      const opts = options()
      opts.fetcher = fetcher(rss(false))
      const network = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'google/gemini-2.5-flash',
          architecture: { input_modalities: ['audio'] }, supported_parameters: ['structured_outputs'] }] }))
        if (kind === 'lookalike-error') throw Object.assign(new Error('PRIVATE provider transport detail'), {
          receipt: { id: 'gen-false', usage: { costUsd: 0, units: 0, unitName: 'tokens', provider: 'openrouter-native-audio', model: 'google/gemini-2.5-flash' } },
        })
        if (kind === 'lookalike-http') throw Object.assign(new GatewayError(503, 'CONTENT_AUDIO_PROVIDER_FAILURE', 'PRIVATE response'), {
          diagnostic: { provider: 'openrouter', stage: 'generate', status: 402, extra: 'PRIVATE' },
        })
        return new Response(JSON.stringify({ id: kind === 'id' ? 'PRIVATE invalid id' : 'gen-synthetic-invalid-receipt',
          model: kind === 'model' ? 'PRIVATE invalid model' : 'google/gemini-2.5-flash',
          choices: [{ finish_reason: 'stop', message: { content: '{"segments":"PRIVATE"}' } }],
          usage: { total_tokens: kind === 'units' ? -1 : 123, cost: 0.008 } }))
      }) as typeof fetch
      opts.transcribe = createContentAudioServices({ env: name => name === 'OPENROUTER_API_KEY' ? 'synthetic-only' : undefined, fetcher: network }).transcribe
      const settle = vi.fn(opts.budget!.settle)
      opts.budget = { ...opts.budget!, settle }
      const result = await runContentRefresh(opts)
      expect(settle).toHaveBeenCalledExactlyOnceWith({ reservationId: 'test-budget', status: 'uncertain', usage: null })
      expect(opts.adminClient.calls.find(call => call.action === 'usage')?.args.usage).not.toHaveProperty('httpDiagnostic')
      expect(result.eligibleSegments).toBe(0)
      expect(JSON.stringify([result, opts.adminClient.calls])).not.toContain('PRIVATE')
    })
  it('retains a validated charge when persistence fails after the provider response', async () => {
    const opts = options(), rpc = opts.adminClient.rpc.bind(opts.adminClient)
    opts.analyzeAudio = analyzer
    let firstUsage = true
    opts.adminClient.rpc = async (name, input) => {
      if (input?.action === 'usage' && firstUsage) { firstUsage = false; return { data: null, error: { code: 'fixture-failure' } } }
      return rpc(name, input)
    }
    const settle = vi.fn(opts.budget!.settle)
    opts.budget = { ...opts.budget!, settle }
    const result = await runContentRefresh(opts)
    expect(settle).toHaveBeenNthCalledWith(1, { reservationId: 'test-budget', status: 'completed', usage })
    expect(settle).toHaveBeenNthCalledWith(2, { reservationId: 'test-budget', status: 'uncertain', usage })
    expect(opts.adminClient.calls.find(call => call.action === 'usage')?.args).toMatchObject({ status: 'uncertain', usage })
    expect(result.eligibleSegments).toBe(0)
  })
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
  it.each(['pcm', 'mpeg-prefix'])('validates capabilities, %s clip bytes and reported costs with synthetic OpenRouter transport', async format => {
    const prefix = format === 'mpeg-prefix' ? mp3PrefixFixture() : null
    const bytes=prefix?.bytes ?? pcmFixture(90),hash=createHash('sha256').update(bytes).digest('hex')
    const audio = { bytes, sha256: hash, mimeType: prefix?.mimeType ?? 'audio/wav', objectPath: 'fixture',
      ...(prefix ? { coverage: prefix.coverage } : {}) }
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
    const request = {requestId:'test',requestFingerprint:hash,segment,audio,interval:{startSeconds:0,endSeconds:60},sourcePolicy:testSource().rights,sourcePolicyHash:hash,signal:new AbortController().signal}
    const result=await services.analyzeAudio(request)
    expect(calls.map(c=>c.url)).toEqual(['https://openrouter.ai/api/v1/models','https://openrouter.ai/api/v1/chat/completions'])
    const requestBody=calls[1]!.body as {messages:{content:unknown}[]}
    const audioPart=(requestBody.messages[1]!.content as {type:string;input_audio:{data:string;format:string}}[])[0]!
    expect(audioPart.type).toBe('input_audio')
    const submitted=new Uint8Array(Buffer.from(audioPart.input_audio.data,'base64'))
    const expected = contentStoredAudioWindow(audio, 0, 60)
    expect(Buffer.compare(Buffer.from(submitted), Buffer.from(expected.bytes))).toBe(0)
    if (format === 'pcm') expect(contentAudioDuration(submitted,'audio/wav')).toBe(60)
    expect(result.audioEvidence).toMatchObject({originalAudioSha256:hash,submittedStartSeconds:expected.originSeconds,submittedEndSeconds:expected.endSeconds,timingBasis:expected.timingBasis})
    expect(result.audioEvidence?.submittedAudioSha256).not.toBe(hash)
    expect(result.facts.transcriptAlignment).toMatchObject({status:'observed',value:1})
    expect(result.usage.costUsd).toBe(0.008)
    await expect(services.analyzeAudio({ ...request, interval: { startSeconds: 61, endSeconds: 150 } }))
      .rejects.toMatchObject({ code: 'CONTENT_AUDIO_INTERVAL' })
    expect(calls).toHaveLength(2)
  })
  it.each([
    ...[
    ['humanSpeech', 1], ['englishSpeech', 'general-american'], ['accent', true], ['accent', 0.9],
    ['clarity', true], ['clarity', 1.01], ['clarity', -0.01],
    ['noiseFraction', false], ['noiseFraction', -1], ['noiseFraction', 2],
    ['musicFraction', 'mixed'], ['musicFraction', -1], ['musicFraction', 2],
    ['speakerCount', true], ['speakerCount', 1.5], ['speakerCount', 0], ['speakerCount', 21],
    ['coherent', 1], ['safe', 'mixed'], ['thirdPartyClear', 0.95], ['learningValue', 1],
    ].map(([name, value]) => ({ name: String(name), value, valid: false })),
    ...['humanSpeech', 'englishSpeech', 'accent', 'clarity', 'noiseFraction', 'musicFraction', 'speakerCount',
      'coherent', 'safe', 'thirdPartyClear', 'learningValue'].map(name => ({ name, value: null, valid: true })),
    ...[
      ['humanSpeech', false], ['englishSpeech', false], ['coherent', false], ['safe', false], ['thirdPartyClear', false], ['learningValue', false],
      ['accent', 'other-english'], ['accent', 'mixed'], ['clarity', 0], ['clarity', 1],
      ['noiseFraction', 0], ['noiseFraction', 1], ['musicFraction', 0], ['musicFraction', 1], ['speakerCount', 1], ['speakerCount', 20],
    ].map(([name, value]) => ({ name: String(name), value, valid: true })),
  ])('enforces field-specific $name fact semantics for $value without losing receipts', async ({ name, value, valid }) => {
    const opts = options(); await runContentRefresh(opts)
    const segment = [...opts.adminClient.records.values()][0]!.segment
    const bytes = pcmFixture(60), hash = createHash('sha256').update(bytes).digest('hex')
    const selected: Record<string, { value: unknown; confidence: number; reason: string }> = Object.fromEntries(Object.entries(facts()).filter(([key]) => key !== 'transcriptAlignment')
      .map(([key, fact]) => [key, { value: fact.status === 'observed' ? fact.value : null, confidence: 0.95, reason: 'Synthetic contract fixture only' }]))
    selected[name]!.value = value
    const network = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'google/gemini-2.5-flash',
        architecture: { input_modalities: ['audio'] }, supported_parameters: ['structured_outputs'] }] }))
      return new Response(JSON.stringify({ id: 'gen-synthetic-fact-contract', model: 'google/gemini-2.5-flash',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ inspectedStartSeconds: 0, inspectedEndSeconds: 60,
          wholeIntervalInspected: true, heard: phrases.map((body, i) => ({ startTime: i * 10, endTime: (i + 1) * 10, body })),
          facts: selected, thirdParty: 'none-detected', lesson: { question: 'What did they cook?', answer: 'Dinner.', keywords: ['dinner'],
            chunks: [{ text: 'come over', meaningEn: 'visit', meaningZh: '来做客', example: 'Come over tomorrow.' }] } }) } }],
        usage: { total_tokens: 1234, cost: 0.008 } }))
    }) as typeof fetch
    const services = createContentAudioServices({ env: key => key === 'OPENROUTER_API_KEY' ? 'synthetic-contract-only' : undefined, fetcher: network })
    const pending = services.analyzeAudio({ requestId: 'fact-contract', requestFingerprint: hash, segment,
      audio: { bytes, sha256: hash, mimeType: 'audio/wav', objectPath: 'fixture' }, interval: { startSeconds: 0, endSeconds: 60 },
      sourcePolicy: testSource().rights, sourcePolicyHash: hash, signal: new AbortController().signal })
    if (valid) {
      const result = await pending
      expect(result.usage.costUsd).toBe(0.008)
      expect(result.facts[name as keyof Inspection]).toMatchObject(value === null ? { status: 'unknown' } : { status: 'observed', value })
    } else await expect(pending).rejects.toMatchObject({ code: 'CONTENT_AUDIO_SCHEMA',
      receipt: { id: 'gen-synthetic-fact-contract', usage: { costUsd: 0.008 } } })
    expect(network).toHaveBeenCalledTimes(2)
  })
})

describe('authenticated content API and budget adapter', () => {
  it.each([true, false])('uses an owner-pinned, cancellable read-only budget preflight: %s', async available => {
    const abortSignal = vi.fn(async () => ({ data: available, error: null }))
    const rpc = vi.fn(() => ({ abortSignal }))
    const adapter = createContentBudget({ ownerId, admin: { rpc } } as unknown as OwnerContext)
    const signal = new AbortController().signal
    expect(await adapter.checkAvailable!({ ownerId, maxCostUsd: 0.5, signal })).toBe(available)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('service_budget_available', { owner_id: ownerId, estimated_usd: 0.5 })
    expect(abortSignal).toHaveBeenCalledWith(signal)
    await expect(adapter.checkAvailable!({ ownerId: 'different-owner', maxCostUsd: 0.5, signal })).rejects.toMatchObject({ status: 403 })
    expect(rpc).toHaveBeenCalledOnce()
  })
  it.each([{ data: null, error: null }, { data: 'true', error: null }, { data: true, error: { code: 'PGRST202' } }])(
    'refuses malformed or unavailable budget checks without assuming allowance', async result => {
      const adapter = createContentBudget({ ownerId, admin: { rpc: () => ({ abortSignal: async () => result }) } } as unknown as OwnerContext)
      await expect(adapter.checkAvailable!({ ownerId, maxCostUsd: 0.5, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'CONTENT_BUDGET' })
    })
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
  it.each([false, true])('checks provider access read-only after owner/job auth without starting the worker: job=%s', async scheduled => {
    const db = new MemoryRpc(), context = { ownerId, admin: db, user: db } as unknown as OwnerContext
    const authenticate = vi.fn(async () => context), authenticateJob = vi.fn(async () => context)
    const workerOptions = vi.fn(() => { throw new Error('The worker must not start') })
    const providerFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/key')
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' })
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-only')
      expect(init?.body).toBeUndefined()
      return new Response(JSON.stringify({ data: { limit: 3, limit_remaining: 2.9, usage: 0.1, is_free_tier: false,
        label: 'PRIVATE label', creator_user_id: 'PRIVATE user', error: 'PRIVATE raw data' } }))
    }) as typeof fetch
    const handler = createContentHandler(name => name === 'OPENROUTER_API_KEY' ? 'synthetic-only' : undefined,
      { authenticate, authenticateJob, workerOptions, providerFetch, now: () => now })
    const response = await handler(request({ action: 'provider-status' }, scheduled ? { 'X-Jove-Content-Job': 'synthetic-job' } : {}))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ provider: 'openrouter', state: 'accepted', httpStatus: 200,
      key: { limitUsd: 3, remainingUsd: 2.9, usageUsd: 0.1, isFreeTier: false }, generationVerified: false, observedAt: now })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(scheduled ? authenticateJob : authenticate).toHaveBeenCalledOnce()
    expect(scheduled ? authenticate : authenticateJob).not.toHaveBeenCalled()
    expect(providerFetch).toHaveBeenCalledOnce(); expect(workerOptions).not.toHaveBeenCalled()
    expect(db.calls).toEqual([])
  })
  it.each([400, 401, 402, 403, 429, 500, 503])('returns bounded provider-status HTTP %s without provider body or billing writes', async status => {
    const db = new MemoryRpc(), context = { ownerId, admin: db, user: db } as unknown as OwnerContext
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const providerFetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status }))
    const handler = createContentHandler(name => name === 'OPENROUTER_API_KEY' ? 'synthetic-only' : undefined,
      { authenticate: async () => context, providerFetch, now: () => now })
    const response = await handler(request({ action: 'provider-status' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ provider: 'openrouter', state: [401, 403].includes(status) ? 'rejected' : 'unverified',
      httpStatus: status, key: null, generationVerified: false, observedAt: now })
    expect(providerFetch).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce(); expect(db.calls).toEqual([])
  })
  it.each([false, true])('rejects provider-status overrides before reading credentials: job=%s', async scheduled => {
    const read: string[] = [], db = new MemoryRpc(), context = { ownerId, admin: db, user: db } as unknown as OwnerContext
    const providerFetch = vi.fn(async () => { throw new Error('No provider request allowed') })
    const handler = createContentHandler(name => { read.push(name); return undefined },
      { authenticate: async () => context, authenticateJob: async () => context, providerFetch })
    for (const extra of [{ url: 'https://example.invalid' }, { ownerId: 'other' }, { key: 'PRIVATE' }, { refresh: true }]) {
      const response = await handler(request({ action: 'provider-status', ...extra }, scheduled ? { 'X-Jove-Content-Job': 'synthetic-job' } : {}))
      expect(response.status).toBe(400)
    }
    expect(providerFetch).not.toHaveBeenCalled(); expect(read).not.toContain('OPENROUTER_API_KEY'); expect(db.calls).toEqual([])
  })
  it('keeps the job payload union separate from owner actions and the legacy probe', async () => {
    const db = new MemoryRpc(), context = { ownerId, admin: db, user: db } as unknown as OwnerContext
    const providerFetch = vi.fn(async () => { throw new Error('No provider request allowed') })
    const workerOptions = vi.fn(() => { throw new Error('Synthetic refresh-entry marker') })
    const handler = createContentHandler(() => undefined, { authenticateJob: async () => context, providerFetch, workerOptions })
    for (const body of [null, [], { probe: true }, { action: 'refresh' }, { action: 'status' }, { action: 'history' },
      { action: 'audio' }, { action: 'lessons' }, { action: 'provider-status', profile: {} }]) {
      const response = await handler(request(body, { 'X-Jove-Content-Job': 'synthetic-job' }))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'CONTENT_JOB_REQUEST' } })
    }
    expect(db.calls).toEqual([]); expect(workerOptions).not.toHaveBeenCalled()
    expect((await handler(request({}, { 'X-Jove-Content-Job': 'synthetic-job' }))).status).toBe(503)
    expect(workerOptions).toHaveBeenCalledOnce()
    expect(db.calls.map(call => call.action)).toEqual(['profile'])
    expect(providerFetch).not.toHaveBeenCalled()
  })
  it.each(['malformed', 'missing', 'coercion', 'negative-usage', 'infinite', 'oversized', 'boolean'])(
    'keeps provider-status unverified for %s metadata without reflecting it', async kind => {
      const db = new MemoryRpc(), context = { ownerId, admin: db, user: db } as unknown as OwnerContext
      const data: Record<string, unknown> = { limit: 3, limit_remaining: 2.9, usage: 0.1, is_free_tier: false, label: 'PRIVATE' }
      if (kind === 'missing') delete data.limit_remaining
      if (kind === 'coercion') data.usage = '0.1'
      if (kind === 'negative-usage') data.usage = -1
      if (kind === 'boolean') data.is_free_tier = 'false'
      const body = kind === 'malformed' ? 'PRIVATE invalid JSON' : kind === 'infinite' ? '{"data":{"usage":1e999}}' :
        JSON.stringify({ data, extra: kind === 'oversized' ? 'PRIVATE'.repeat(3000) : null })
      const providerFetch = vi.fn(async () => new Response(body))
      const handler = createContentHandler(name => name === 'OPENROUTER_API_KEY' ? 'synthetic-only' : undefined,
        { authenticate: async () => context, providerFetch, now: () => now })
      const response = await handler(request({ action: 'provider-status' }))
      expect(await response.json()).toEqual({ provider: 'openrouter', state: 'unverified', httpStatus: 200,
        key: null, generationVerified: false, observedAt: now })
      expect(providerFetch).toHaveBeenCalledOnce(); expect(db.calls).toEqual([])
    })
  it.each([[null, null], [0, 0], [3, -0.1]])('preserves unknown/zero/exhausted provider-status cap %s / %s', async (limit, remaining) => {
    const db = new MemoryRpc(), context = { ownerId, admin: db, user: db } as unknown as OwnerContext
    const handler = createContentHandler(name => name === 'OPENROUTER_API_KEY' ? 'synthetic-only' : undefined, {
      authenticate: async () => context, providerFetch: async () => new Response(JSON.stringify({ data: {
        limit, limit_remaining: remaining, usage: 0, is_free_tier: true,
      } })), now: () => now,
    })
    const response = await handler(request({ action: 'provider-status' }))
    expect(await response.json()).toMatchObject({ state: 'accepted', key: { limitUsd: limit, remainingUsd: remaining, usageUsd: 0 }, generationVerified: false })
    expect(db.calls).toEqual([])
  })
  it.each(['missing', 'direct-gemini', 'direct-with-unused-router'])(
    'does not probe an absent or inactive router key: %s', async kind => {
      const db = new MemoryRpc(), context = { ownerId, admin: db, user: db } as unknown as OwnerContext
      const providerFetch = vi.fn(async () => { throw new Error('No provider request allowed') })
      const config: Record<string, string> = kind === 'missing' ? {} : { JOVE_CONTENT_AUDIO_PROVIDER: 'gemini', GEMINI_API_KEY: 'synthetic-only' }
      if (kind === 'direct-with-unused-router') config.OPENROUTER_API_KEY = 'synthetic-unused'
      const handler = createContentHandler(name => config[name], { authenticate: async () => context, providerFetch, now: () => now })
      const response = await handler(request({ action: 'provider-status' }))
      expect(await response.json()).toEqual({ provider: 'gemini', state: kind === 'missing' ? 'not-configured' : 'unsupported',
        httpStatus: null, key: null, generationVerified: false, observedAt: now })
      expect(providerFetch).not.toHaveBeenCalled(); expect(db.calls).toEqual([])
    })
  it.each(['fetch', 'body', 'redirect'])(
    'bounds provider-status %s failure without retries or raw transport details', async kind => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const db = new MemoryRpc(), context = { ownerId, admin: db, user: db } as unknown as OwnerContext
        const providerFetch = vi.fn(async () => {
          if (kind === 'redirect') throw new Error('PRIVATE redirect refused')
          if (kind === 'fetch') return new Promise<Response>(() => {})
          return new Response(new ReadableStream())
        })
        const handler = createContentHandler(name => name === 'OPENROUTER_API_KEY' ? 'synthetic-only' : undefined,
          { authenticate: async () => context, providerFetch, now: () => now })
        const pending = handler(request({ action: 'provider-status' }))
        await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledOnce())
        await vi.advanceTimersByTimeAsync(8001)
        const response = await pending
        expect(await response.json()).toEqual({ provider: 'openrouter', state: 'unverified', httpStatus: kind === 'body' ? 200 : null,
          key: null, generationVerified: false, observedAt: now })
        expect(providerFetch).toHaveBeenCalledOnce(); expect(db.calls).toEqual([])
      } finally { vi.useRealTimers() }
    })
  it('rejects invalid sessions, forged scheduler credentials and browser scheduler requests before reading service credentials', async () => {
    const read: string[]=[]
    const handler = createContentHandler(name=>{read.push(name);return undefined})
    expect((await handler(request({action:'status'}))).status).toBe(401)
    expect((await handler(request({}, {'X-Jove-Content-Job':'fake'}))).status).toBe(401)
    expect((await handler(request({}, {'X-Jove-Content-Job':'fake',Origin:'https://mnijc19-netizen.github.io'}))).status).toBe(403)
    expect((await handler(request({action:'provider-status'}))).status).toBe(401)
    expect((await handler(request({action:'provider-status'}, {'X-Jove-Content-Job':'fake'}))).status).toBe(401)
    expect((await handler(request({action:'provider-status'}, {'X-Jove-Content-Job':'fake',Origin:'https://mnijc19-netizen.github.io'}))).status).toBe(403)
    expect(read).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(read).not.toContain('OPENROUTER_API_KEY')
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
    if (!['content_worker', 'content_request_intent', 'content_audio_work'].includes(name)) throw new Error('Unexpected RPC')
    try {
      const args = sqlLiteral(JSON.stringify(input!.args))
      const output = sql(name === 'content_request_intent' ? `select public.content_request_intent(${args}::jsonb);` :
        name === 'content_audio_work' ? `select public.content_audio_work(${sqlLiteral(input!.action as string)},${args}::jsonb);` :
          `select public.content_worker(${sqlLiteral(input!.action as string)},${args}::jsonb);`)
      return { data: JSON.parse(output), error: null }
    } catch { return { data: null, error: { code: 'SQL_TEST_ERROR' } } }
  } }
}
// Separate opt-in: real publisher metadata + real PostgreSQL, never synthetic audio approval.
const voaPersistenceSource = ALLOWLISTED_CONTENT_SOURCES.find(source => source.id === 'voa-everyday-grammar')!
const voaPersistenceGuids = VOA_LESSON_CANDIDATES.map(candidate => `voa-pilot:${candidate.id}`)
const voaPersistenceConfigHash = createHash('sha256')
  .update(JSON.stringify([voaPersistenceSource, CONTENT_POLICY_EVIDENCE, VOA_LESSON_CANDIDATES])).digest('hex')
// Main explicitly approved this one observed local baseline transition; this is not a general override.
const voaPreviousLocalConfigHash = 'f473de49e3819a90413333278d13599143b95a894e6d5de7cc879db4765b8cbf'
const voaExistingRssGuids = ['7987362', '7979758', '8008295'].map(id => `https://learningenglish.voanews.com/a/${id}.html`)
interface VoaExistingRssRow {
  id: string; guid: string; status: string; attempts: number; nextAttemptAt: string; metadata: Record<string, unknown>
}
interface VoaPersistencePreflight {
  members: number; activeLeases: number; eligibleItems: number; eligibleSegments: number; otherVoaItems: number
  voaSegments: number; voaRecommendations: number; otherVoaRows: VoaExistingRssRow[]
  source: { id: string; configId: string; feedUrl: string; configHash: string } | null
  pilots: { guid: string; pageUrl: string; audioUrl: string; status: string }[]
}
function assertVoaPersistencePreflight(state: VoaPersistencePreflight) {
  if (state.members !== 0 || state.activeLeases !== 0 || state.eligibleItems !== 0 || state.eligibleSegments !== 0 ||
      state.voaSegments !== 0 || state.voaRecommendations !== 0)
    throw new Error('voa-local-fixture-lease-unsafe')
  if (!Number.isInteger(state.otherVoaItems) || state.otherVoaItems < 0 || !Array.isArray(state.pilots) ||
      !Array.isArray(state.otherVoaRows) || state.otherVoaRows.length !== state.otherVoaItems)
    throw new Error('voa-local-preflight-incomplete')
  if (state.source !== null && (!state.source || state.source.id !== voaPersistenceSource.id ||
      state.source.configId !== voaPersistenceSource.id || state.source.feedUrl !== voaPersistenceSource.feedUrl ||
      !/^[a-f0-9]{64}$/u.test(state.source.configHash))) throw new Error('voa-local-source-identity-unsafe')
  if (state.otherVoaRows.some(row => !voaExistingRssGuids.includes(row.guid)) ||
      new Set(state.otherVoaRows.map(row => row.guid)).size !== state.otherVoaRows.length)
    throw new Error('voa-local-unknown-rss-item')
  // Existing004 resets queue state when config changes. Only this exact authorized three-row baseline is safe.
  if (state.otherVoaItems > 0 && state.source?.configHash !== voaPersistenceConfigHash &&
      !(state.source?.configHash === voaPreviousLocalConfigHash && state.otherVoaRows.length === 3 &&
        state.otherVoaRows.every(row => row.status === 'awaiting-analysis')))
    throw new Error('voa-local-config-would-reset-other-items')
  if (state.pilots.length > 6 || new Set(state.pilots.map(row => row.guid)).size !== state.pilots.length)
    throw new Error('voa-local-candidate-identity-unsafe')
  for (const row of state.pilots) {
    const candidate = VOA_LESSON_CANDIDATES.find(candidate => `voa-pilot:${candidate.id}` === row.guid)
    if (!candidate || row.pageUrl !== candidate.pageUrl || row.audioUrl !== candidate.audioUrl ||
        !['pending', 'awaiting-analysis', 'quarantined', 'retry'].includes(row.status))
      throw new Error('voa-local-candidate-identity-unsafe')
  }
}
describe('actual VOA persistence preflight guards (no database)', () => {
  const empty: VoaPersistencePreflight = { members: 0, activeLeases: 0, eligibleItems: 0, eligibleSegments: 0,
    otherVoaItems: 0, otherVoaRows: [], voaSegments: 0, voaRecommendations: 0, source: null, pilots: [] }
  it('rejects occupied/missing/null safety counts before creating any owner', () => {
    expect(() => assertVoaPersistencePreflight(empty)).not.toThrow()
    for (const field of ['members', 'activeLeases', 'eligibleItems', 'eligibleSegments', 'voaSegments', 'voaRecommendations', 'otherVoaItems'] as const) {
      for (const absent of [null, undefined]) expect(() => assertVoaPersistencePreflight({ ...empty, [field]: absent } as unknown as VoaPersistencePreflight)).toThrow()
      if (field !== 'otherVoaItems') expect(() => assertVoaPersistencePreflight({ ...empty, [field]: 1 })).toThrow('lease-unsafe')
    }
  })
  it('rejects unbound pilot rows and config changes that would reset unrelated RSS items', () => {
    const source = { id: voaPersistenceSource.id, configId: voaPersistenceSource.id,
      feedUrl: voaPersistenceSource.feedUrl, configHash: voaPersistenceConfigHash }
    const otherVoaRows = voaExistingRssGuids.map(guid => ({ id: 'test-only', guid, status: 'awaiting-analysis', attempts: 0, nextAttemptAt: '', metadata: {} }))
    const baseline = { ...empty, source, otherVoaItems: 3, otherVoaRows }
    expect(() => assertVoaPersistencePreflight(baseline)).not.toThrow()
    expect(() => assertVoaPersistencePreflight({ ...baseline, source: { ...source, configHash: '0'.repeat(64) } })).toThrow('reset-other-items')
    const permitted = { ...baseline, source: { ...source, configHash: voaPreviousLocalConfigHash } }
    expect(() => assertVoaPersistencePreflight(permitted)).not.toThrow()
    expect(() => assertVoaPersistencePreflight({ ...permitted, otherVoaRows: otherVoaRows.map(row => ({ ...row, status: 'pending' })) })).toThrow('reset-other-items')
    expect(() => assertVoaPersistencePreflight({ ...permitted, otherVoaRows: otherVoaRows.map(row => ({ ...row, guid: 'unknown' })) })).toThrow('unknown-rss-item')
    const candidate = VOA_LESSON_CANDIDATES[0]!
    const row = { guid: voaPersistenceGuids[0]!, pageUrl: candidate.pageUrl, audioUrl: candidate.audioUrl, status: 'pending' }
    expect(() => assertVoaPersistencePreflight({ ...empty, source, pilots: [row] })).not.toThrow()
    for (const changed of [{ guid: 'voa-pilot:unknown' }, { audioUrl: 'https://unapproved.example/audio' }, { status: 'eligible' }])
      expect(() => assertVoaPersistencePreflight({ ...empty, source, pilots: [{ ...row, ...changed }] })).toThrow('identity-unsafe')
  })
})

describe.runIf(localEnabled && liveEnabled && process.env.JOVE_CONTENT_VOA_PERSISTENCE === '1')('leased actual six VOA metadata persistence', () => {
  it('persists and reads back exactly six real VOA candidates without paid services or audio approval', async () => {
    // Requires an explicit exclusive fixture lease, not just a running DB. Never inspect env/keys/raw stderr.
    const localSql = (statement: string): string => {
      try {
        return execFileSync('docker', ['exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=10000 -c lock_timeout=3000',
          localContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1'],
        { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }).trim()
      } catch { throw new Error('voa-local-sql-failed-cli-output-suppressed') }
    }
    let ports: Record<string, { HostPort: string }[]>
    try {
      ports = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', localContainer],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }))
    } catch { throw new Error('voa-dedicated-local-container-unavailable') }
    expect(ports['5432/tcp']?.some(port => port.HostPort === '55322')).toBe(true)
    const sourceId = sqlLiteral(voaPersistenceSource.id)
    const guids = voaPersistenceGuids.map(sqlLiteral).join(',')
    const selected = `source_id=${sourceId} and guid in (${guids})`
    const readOtherVoaRows = () => JSON.parse(localSql(`select coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'guid',guid,'status',status,'attempts',attempts,'nextAttemptAt',next_attempt_at,
      'metadata',to_jsonb(i)-array['status','attempts','next_attempt_at']) order by guid),'[]')
      from public.content_items i where source_id=${sourceId} and guid not in (${guids});`)) as VoaExistingRssRow[]
    const before = JSON.parse(localSql(`select jsonb_build_object(
      'members',(select count(*) from public.app_members),
      'activeLeases',(select count(*) from public.content_sources where lease_until>clock_timestamp()),
      'eligibleItems',(select count(*) from public.content_items where status='eligible'),
      'eligibleSegments',(select count(*) from public.content_segments where status='eligible'),
      'voaSegments',(select count(*) from public.content_segments s join public.content_items i on i.id=s.item_id where i.source_id=${sourceId}),
      'voaRecommendations',(select count(*) from public.content_recommendations r join public.content_segments s on s.id=r.segment_id
        join public.content_items i on i.id=s.item_id where i.source_id=${sourceId}),
      'otherVoaItems',(select count(*) from public.content_items where source_id=${sourceId} and guid not in (${guids})),
      'source',(select jsonb_build_object('id',id,'configId',config->>'id','feedUrl',config->>'feedUrl','configHash',config_hash)
        from public.content_sources where id=${sourceId}),
      'pilots',(select coalesce(jsonb_agg(jsonb_build_object('guid',guid,'pageUrl',episode->>'pageUrl','audioUrl',episode->>'audioUrl','status',status)),'[]')
        from public.content_items where source_id=${sourceId} and guid like 'voa-pilot:%'));`)) as VoaPersistencePreflight
    before.otherVoaRows = readOtherVoaRows()
    assertVoaPersistencePreflight(before)
    const upgrading = before.otherVoaItems > 0 && before.source?.configHash !== voaPersistenceConfigHash
    const unchangedState = () => localSql(`select jsonb_build_object(
      'otherItems',(select md5(coalesce(jsonb_agg(case when ${upgrading} and source_id=${sourceId}
        then to_jsonb(t)-array['status','attempts','next_attempt_at'] else to_jsonb(t) end order by id),'[]')::text)
        from public.content_items t where not (${selected})),
      'otherSources',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id),'[]')::text) from public.content_sources t where id<>${sourceId}),
      ${['content_transcripts', 'content_audio_assets', 'content_segments', 'content_segment_audio', 'content_speakers', 'content_scores',
        'content_usage', 'content_recommendations', 'content_history', 'content_profiles'].map(table =>
        `${sqlLiteral(table)},(select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]')::text) from public.${table} t)`).join(',')});`)
    const preserved = unchangedState()
    const fixtureOwner = crypto.randomUUID(), fixtureMarker = crypto.randomUUID()
    const actions: string[] = [], pages = new Map<string, string>(), policies = new Map<string, string>()
    const readRows = () => JSON.parse(localSql(`select coalesce(jsonb_agg(jsonb_build_object('id',id,'guid',guid,'revision',revision,'status',status,'episode',episode) order by guid),'[]')
      from public.content_items where ${selected};`)) as { id: string; guid: string; revision: string; status: string;
        episode: FeedEpisode & { candidateAudit: Omit<VoaCandidateAudit, 'rights'> } }[]
    const admin = {
      async rpc(name: string, input?: Record<string, unknown>): Promise<Awaited<ReturnType<ContentAdminClient['rpc']>>> {
        const action = input?.action as string
        if (name !== 'content_worker' || !['owner', 'candidates', 'claim', 'rights-check', 'ingest', 'release'].includes(action))
          throw new Error('voa-metadata-only-rpc-required')
        actions.push(action)
        const args = input?.args as Record<string, unknown>
        if (!['owner', 'candidates'].includes(action) && args.sourceId !== voaPersistenceSource.id) throw new Error('voa-source-only-required')
        return { data: JSON.parse(localSql(`select public.content_worker(${sqlLiteral(action)},${sqlLiteral(JSON.stringify(args))}::jsonb);`)), error: null }
      },
      from(table: string) {
        if (table !== 'content_items') throw new Error('voa-pilot-read-only-query-required')
        return { select(columns: string) {
          if (columns !== 'guid,episode') throw new Error('voa-pilot-read-only-query-required')
          let hasSource = false, hasGuids = false
          return {
            eq(column: string, value: string) { hasSource = column === 'source_id' && value === voaPersistenceSource.id; return this },
            in(column: string, values: readonly string[]) { hasGuids = column === 'guid' && JSON.stringify(values) === JSON.stringify(voaPersistenceGuids); return this },
            async limit(count: number) {
              if (!hasSource || !hasGuids || count !== 6) throw new Error('voa-pilot-read-only-query-required')
              return { data: readRows().map(row => ({ guid: row.guid, episode: row.episode })), error: null }
            },
          }
        } }
      },
    }
    const allowedPages = new Set([...VOA_LESSON_CANDIDATES.map(candidate => candidate.pageUrl), ...voaPersistenceSource.rights.evidenceUrls])
    const transport: ContentFetcher = async request => {
      if (request.role !== 'page' || !allowedPages.has(request.url)) throw new Error('voa-metadata-only-network-required')
      const response = await fetchContentResource(request) // Real bounded, allowlisted, DNS-pinned Node transport, not a fixture.
      pages.set(request.url, createHash('sha256').update(response.body).digest('hex'))
      const policy = CONTENT_POLICY_EVIDENCE.find(policy => policy.url === request.url)
      if (policy) policies.set(policy.url, createHash('sha256')
        .update(extractContentPolicy(new TextDecoder().decode(response.body), policy.extractor)).digest('hex'))
      return response
    }
    const startedAt = new Date().toISOString()
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 120_000)
    try {
      localSql(`begin; lock table public.app_members in exclusive mode;
        do $$ begin if exists(select 1 from public.app_members) then raise exception 'Fixture lease not empty'; end if;
          insert into auth.users(id,raw_app_meta_data) values(${sqlLiteral(fixtureOwner)}::uuid,jsonb_build_object('joveContentPilotFixture',${sqlLiteral(fixtureMarker)}));
          insert into public.app_members(user_id) values(${sqlLiteral(fixtureOwner)}::uuid); end $$; commit;`)
      const trial = await runVoaCandidatePilot({ adminClient: admin, ownerId: fixtureOwner, probeAudio: false, fetcher: transport, signal: controller.signal })
      expect(trial.errors).toEqual([])
      expect(trial.sourcesClaimed).toBe(1)
      expect(trial.voaPilot.map(candidate => candidate.id)).toEqual(VOA_LESSON_CANDIDATES.map(candidate => candidate.id))
      expect(trial).toMatchObject({ itemsProcessed: 0, segmentsSaved: 0, eligibleSegments: 0, feedsFetched: 0, recommendations: [] })
      const rows = readRows()
      expect(rows.map(row => row.guid)).toEqual([...voaPersistenceGuids].sort())
      for (const row of rows) {
        const candidate = VOA_LESSON_CANDIDATES.find(candidate => `voa-pilot:${candidate.id}` === row.guid)!
        expect(row.status).toBe('pending')
        expect(row.episode).toMatchObject({ sourceId: voaPersistenceSource.id, pageUrl: candidate.pageUrl, audioUrl: candidate.audioUrl,
          publishedAt: null, audioBytes: null, durationSeconds: null, transcripts: [],
          candidateAudit: { taskCoverage: 'unknown', audioProbe: null, candidate: { id: candidate.id, status: 'candidate', eligible: false,
            humanAudio: 'unknown', thirdPartyAudio: 'unknown', publisherTranscript: { timing: 'unknown', alignment: 'unverified' } } } })
        const audit = row.episode.candidateAudit
        expect(audit.transcriptSha256).toBe(createHash('sha256').update(audit.candidate.publisherTranscript.text).digest('hex'))
        expect(audit.pageSha256).toMatch(/^[a-f0-9]{64}$/u)
        // An unchanged revision retains its earlier snapshot, not a fabricated latest audit date/body hash.
        if (!before.pilots.some(prior => prior.guid === row.guid)) expect(audit.pageSha256).toBe(pages.get(candidate.pageUrl))
        expect(row.episode.attribution).toBe(audit.candidate.attribution)
        expect(row.episode.licenseNotice).toBe(audit.candidate.thirdPartyNotices.length ? audit.candidate.thirdPartyNotices.join('\n') : null)
        const policyHashes = voaPersistenceSource.rights.evidenceUrls.map(url => {
          const observed = policies.get(url)
          expect(observed).toBe(CONTENT_POLICY_EVIDENCE.find(policy => policy.url === url)?.sha256)
          expect(observed).toMatch(/^[a-f0-9]{64}$/u)
          return observed
        })
        const notices = [...new Set(audit.candidate.thirdPartyNotices.map(notice => notice.normalize('NFKC')
          .replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').trim().toLowerCase()))].sort()
        expect(row.revision).toBe(createHash('sha256')
          .update(JSON.stringify([row.guid, candidate.audioUrl, audit.transcriptSha256, notices, policyHashes])).digest('hex'))
      }
      const inventory = await readOwnerContentTaskInventory({ adminClient: admin, ownerId: fixtureOwner })
      expect(inventory.candidateAuditStatus).toBe('observed')
      expect(inventory.tasks.map(task => task.task)).toEqual(CONTENT_LIFE_TASKS)
      expect(inventory.tasks.every(task => task.reviewedUsableCount === 0)).toBe(true)
      expect(new Set(inventory.tasks.flatMap(task => task.configuredCandidateIds)).size).toBe(6)
      for (const task of inventory.tasks) expect(task.auditedCandidateCount).toBe(task.configuredCandidateIds.length)
      expect(inventory).toMatchObject({ nextExpectedSupplyAt: null, estimatedDaysRemaining: null })
      expect(unchangedState()).toBe(preserved)
      const afterOtherVoaRows = readOtherVoaRows()
      expect(afterOtherVoaRows.map(row => row.guid)).toEqual(before.otherVoaRows.map(row => row.guid))
      const originalMetadataHash = (row: VoaExistingRssRow) => createHash('sha256').update(JSON.stringify(row.metadata)).digest('hex')
      for (const prior of before.otherVoaRows) {
        const current = afterOtherVoaRows.find(row => row.guid === prior.guid)!
        expect(originalMetadataHash(current)).toBe(originalMetadataHash(prior))
        if (upgrading) {
          expect(current).toMatchObject({ status: 'pending', attempts: 0 })
          expect(Date.parse(current.nextAttemptAt)).toBeGreaterThanOrEqual(Date.parse(startedAt))
        } else expect(current).toEqual(prior)
      }
      expect(localSql(`select config_hash from public.content_sources where id=${sourceId};`)).toBe(voaPersistenceConfigHash)
      expect(localSql(`select (lease_id is null and lease_until is null)::text from public.content_sources where id=${sourceId};`)).toBe('true')
      expect(VOA_LESSON_CANDIDATES.every(candidate => pages.has(candidate.pageUrl))).toBe(true)
      console.info(JSON.stringify({ actualVoaMetadataPersistence: true, startedAt, completedAt: new Date().toISOString(), runId: trial.runId,
        rows: rows.length, newlyDiscovered: trial.itemsDiscovered, retainedOtherVoaItems: before.otherVoaItems,
        eligible: 0, tasks: inventory.tasks.length, reviewedUsable: 0, leaseReleased: true, unrelatedStateUnchanged: true,
        configurationUpgrade: upgrading, oldConfigHash: before.source?.configHash ?? null, configHash: voaPersistenceConfigHash,
        existingRss: before.otherVoaRows.map(prior => { const current = afterOtherVoaRows.find(row => row.guid === prior.guid)!; return {
          guid: prior.guid, beforeStatus: prior.status, afterStatus: current.status, beforeAttempts: prior.attempts, afterAttempts: current.attempts,
          beforeMetadataSha256: originalMetadataHash(prior), afterMetadataSha256: originalMetadataHash(current) } }),
        rpcActions: [...new Set(actions)], fetchedPages: pages.size, observedPolicyHashes: [...policies.values()],
        candidates: rows.map(row => ({ guid: row.guid, itemId: row.id, revision: row.revision,
          scriptSha256: row.episode.candidateAudit.transcriptSha256, pageSha256: row.episode.candidateAudit.pageSha256 })) }))
    } finally {
      clearTimeout(deadline)
      // Only our random ID carrying our exact marker. Never clean sources/candidates or any other auth user.
      localSql(`delete from auth.users where id=${sqlLiteral(fixtureOwner)}::uuid and raw_app_meta_data->>'joveContentPilotFixture'=${sqlLiteral(fixtureMarker)};`)
      expect(localSql(`select count(*) from auth.users where id=${sqlLiteral(fixtureOwner)}::uuid;`)).toBe('0')
      expect(localSql('select count(*) from public.app_members;')).toBe('0')
      console.info(JSON.stringify({ actualVoaMetadataFixtureCleanup: true, fixtureOwnerRemaining: 0, membersRemaining: 0,
        retainedCandidateCount: Number(localSql(`select count(*) from public.content_items where ${selected};`)) }))
    }
  }, 150_000)
})

describe.runIf(localEnabled)('content SQL acceptance assertions fail closed on absent RPC values', () => {
  const acceptance = readFileSync(new URL('../supabase/tests/content.test.sql', import.meta.url), 'utf8')
  it('rolls back a real publisher-notice revision withdrawal through unchanged SQL004', async () => {
    const db = new MemoryRpc()
    await runVoaCandidatePilot({ adminClient: db, fetcher: voaTestFetcher(), rightsPolicies: voaTestPolicies, now: () => now })
    const original = structuredClone([...db.items.values()][0]!)
    await runVoaCandidatePilot({ adminClient: db, rightsPolicies: voaTestPolicies, now: () => now + 1000,
      fetcher: async request => {
        const response = await voaTestFetcher()(request)
        return { ...response, body: new TextEncoder().encode(new TextDecoder().decode(response.body)
          .replace('<h2>Quiz', '<p>This dialogue recording copyright Another Author.</p><h2>Quiz')) }
      } })
    const revised = db.items.get(original.id)!
    expect(revised.revision).not.toBe(original.revision)
    const sourceId = `test-content-notice-${crypto.randomUUID()}`, syntheticOwner = crypto.randomUUID()
    const itemId = createHash('sha256').update(sourceId).digest('hex'), segmentDigest = createHash('sha256').update(`${sourceId}:clip`).digest('hex')
    const marker = acceptance.indexOf('  -- Full episode deletion')
    expect(marker).toBeGreaterThan(0)
    const beforeWithdrawal = acceptance.slice(0, marker)
      .replace("'test-content-sql-'||replace(gen_random_uuid()::text,'-','')", sqlLiteral(sourceId))
      .replace('owner_key uuid := gen_random_uuid()', `owner_key uuid := ${sqlLiteral(syntheticOwner)}::uuid`)
      .replaceAll("repeat('d',64)", sqlLiteral(original.revision))
      .replace(`item_key text:=${sqlLiteral(original.revision)}`, `item_key text:=${sqlLiteral(itemId)}`)
      .replaceAll("repeat('e',64)", sqlLiteral(segmentDigest))
      .replace("jsonb_build_object('guid','SYNTHETIC SQL TEST ONLY','sourceId',source_key)",
        `jsonb_set(${sqlLiteral(JSON.stringify(original.episode))}::jsonb,'{sourceId}',to_jsonb(source_key))`)
    expect(beforeWithdrawal).toContain(sourceId)
    const statement = `begin; ${beforeWithdrawal}
      if (select status from public.content_segments where id=segment_key) is distinct from 'eligible' then raise exception 'Missing synthetic baseline'; end if;
      if (select count(*) from public.content_recommendations where segment_id=segment_key and user_id=owner_key and active) is distinct from 1 then raise exception 'Missing active synthetic recommendation'; end if;
      response:=public.content_worker('ingest',base_args||jsonb_build_object('items',jsonb_build_array(jsonb_build_object(
        'id',item_key,'revision',${sqlLiteral(revised.revision)},
        'episode',jsonb_set(${sqlLiteral(JSON.stringify(revised.episode))}::jsonb,'{sourceId}',to_jsonb(source_key))))));
      if (response->>'changed')::integer is distinct from 1 then raise exception 'Notice revision not ingested'; end if;
      if (select status from public.content_items where id=item_key) is distinct from 'pending' then raise exception 'Notice item not pending'; end if;
      if (select revision from public.content_items where id=item_key) is distinct from ${sqlLiteral(revised.revision)} then raise exception 'Notice revision missing'; end if;
      if (select episode->>'licenseNotice' from public.content_items where id=item_key) is distinct from 'This dialogue recording copyright Another Author.' then raise exception 'Publisher declaration lost'; end if;
      if (select status from public.content_segments where id=segment_key) is distinct from 'stale' then raise exception 'Old clip not withdrawn'; end if;
      if exists(select 1 from public.content_recommendations where segment_id=segment_key and active) then raise exception 'Old recommendation still active'; end if;
      begin
        perform public.content_worker('playback',jsonb_build_object('ownerId',owner_key,'segmentId',segment_key));
        raise exception 'Withdrawn clip still served';
      exception when insufficient_privilege then null; end;
    end $$; rollback;`
    expect(() => sql(statement)).not.toThrow()
    expect(sql(`select count(*) from public.content_sources where id=${sqlLiteral(sourceId)};`)).toBe('0')
    expect(sql(`select count(*) from auth.users where id=${sqlLiteral(syntheticOwner)}::uuid;`)).toBe('0')
  }, 30_000)
  it('passes the unchanged real RPC acceptance in a rollback-only transaction', () => {
    expect(() => sql(`begin; ${acceptance} rollback;`)).not.toThrow()
  })
  it.each([
    ["response->>'acquired' is distinct from 'true'", "Initial rights check not required"],
    ["response->>'rightsDue' is distinct from 'true'", "Initial rights check not required"],
    ["response->>'acquired' is distinct from 'false'", "Lease allowed concurrent worker"],
    ["(public.content_worker('profile',jsonb_build_object('ownerId',owner_key))->>'targetDifficulty')::numeric", "Profile did not persist"],
    ['jsonb_array_length(pending_response)', 'Long-lived awaiting content could not resume'],
    ["pending_response->0->>'id'", 'Long-lived awaiting content could not resume'],
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
  it('recovers a prefix STT checkpoint and binds a versioned clip through real PostgreSQL JSONB', async () => {
    const prefix = mp3PrefixFixture(90)
    const feed = fetcher(rss(false).replace('<guid>one</guid>', '<guid>stored-prefix-stt</guid>'))
    const store = makeStore()
    const transcribe = vi.fn<NonNullable<ContentRefreshOptions['transcribe']>>(async request => ({
      audioSha256: request.audio.sha256, requestFingerprint: request.requestFingerprint,
      audioDurationSeconds: contentAudioDuration(request.audio.bytes, request.audio.mimeType),
      provider: 'fixture-prefix-stt', evidenceId: 'SYNTHETIC-PREFIX-STT-ONLY', usage,
      transcriptJson: JSON.stringify({ version: '1.0.0', segments: phrases.map((body, i) => ({ startTime: i * 10, endTime: (i + 1) * 10, body })) }),
    }))
    const opts: ContentRefreshOptions = { ...options(), adminClient: admin, sources: [source], ownerId: localOwner, now: Date.now,
      audioAcquisition: 'mpeg-prefix-v1', audioStore: store, limits: { audioBytes: prefix.bytes.length },
      transcribe, transcriptOrigin: undefined, forcePoll: true,
      fetcher: async request => {
        const response = await feed({ ...request, etag: null })
        if (request.role !== 'audio') return response
        expect(request.audioPrefixBytes).toBe(prefix.bytes.length)
        return { ...response, status: 206, body: prefix.bytes, contentType: 'audio/mpeg',
          byteCoverage: { kind: 'prefix', start: 0, endExclusive: prefix.bytes.length, totalBytes: prefix.bytes.length + 100000 } }
      } }
    const first = await runContentRefresh(opts)
    expect(first.errors).toEqual([])
    expect(first.eligibleSegments).toBe(0)
    expect(transcribe).toHaveBeenCalledOnce()
    const itemId = createHash('sha256').update(JSON.stringify([source.id, 'stored-prefix-stt'])).digest('hex')
    const saved = JSON.parse(sql(`select transcript from public.content_transcripts where item_id='${itemId}';`)) as TimedTranscript
    expect(saved.reference.derivation!.audioCoverage!.version).toBe('mpeg-prefix-v1')
    expect(sql(`select count(*) from public.content_audio_assets where item_id='${itemId}' and acquisition_version='mpeg-prefix-v1' and state='ready';`)).toBe('1')
    expect([...store.blobs.keys()]).toHaveLength(1)
    opts.analyzeAudio = analyzer
    const second = await runContentRefresh(opts)
    expect(second.errors).toEqual([])
    expect(second.eligibleSegments).toBe(1)
    expect(transcribe).toHaveBeenCalledOnce()
    const rows = JSON.parse(sql(`select jsonb_agg(jsonb_build_object('record',s.record,'acquisition',a.source_acquisition_version,'timing',a.timing_basis))
      from public.content_segments s join public.content_segment_audio a on a.segment_id=s.id where s.item_id='${itemId}' and s.status='eligible';`))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ acquisition: 'mpeg-prefix-v1', timing: 'mpeg-frame-count-with-xing-v1',
      record: { artifact: { coverage: saved.reference.derivation!.audioCoverage }, segment: { episode: { durationSeconds: null } } } })
    expect(sql(`select count(*) from public.content_request_intents where item_id='${itemId}';`)).toBe('2')
    expect(sql(`select count(*) from public.content_usage u join public.content_request_intents i on i.request_id=u.request_id where u.item_id='${itemId}';`)).toBe('2')
    expect([...store.blobs.keys()].sort().map(path => path.split('/')[0])).toEqual(['clips', 'prefixes'])
  }, 30_000)
  it('persists HTTP failure metadata through real JSONB and owner RLS without inventing usage', async () => {
    const feed = fetcher(rss(false).replace('<guid>one</guid>', '<guid>stored-http-failure</guid>'))
    const network = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/models')
      ? new Response(JSON.stringify({ data: [{ id: 'google/gemini-2.5-flash', architecture: { input_modalities: ['audio'] },
        supported_parameters: ['structured_outputs'] }] })) : new Response('PRIVATE response', { status: 402 })) as typeof fetch
    const services = createContentAudioServices({ env: name => name === 'OPENROUTER_API_KEY' ? 'synthetic-only' : undefined, fetcher: network })
    const store = makeStore(), settle = vi.fn(budget().settle)
    const opts: ContentRefreshOptions = { ...options(), adminClient: admin, sources: [source], ownerId: localOwner, now: Date.now,
      fetcher: request => feed({ ...request, etag: null }), transcribe: services.transcribe, audioStore: store,
      budget: { ...budget(), settle }, transcriptOrigin: undefined, forcePoll: true }
    const result = await runContentRefresh(opts)
    const itemId = createHash('sha256').update(JSON.stringify([source.id, 'stored-http-failure'])).digest('hex')
    const row = JSON.parse(sql(`select jsonb_build_object('status',status,'cost',cost_usd,'usage',usage)
      from public.content_usage where item_id='${itemId}';`))
    expect(row).toEqual({ status: 'uncertain', cost: null, usage: { costUsd: null, errorCode: 'CONTENT_AUDIO_PROVIDER_FAILURE',
      httpDiagnostic: { provider: 'openrouter', stage: 'generate', status: 402 } } })
    expect(settle).toHaveBeenCalledExactlyOnceWith({ reservationId: 'test-budget', status: 'uncertain', usage: null })
    expect(network).toHaveBeenCalledTimes(2)
    expect(result.eligibleSegments).toBe(0); expect(store.blobs.size).toBe(1)
    for (const [user, expected] of [[localOwner, '1'], [outsider, '0']]) {
      const count = sql(`begin; set local role authenticated; set local request.jwt.claim.sub='${user}';
        select count(*) from public.content_usage where item_id='${itemId}'; rollback;`)
        .split('\n').filter(value => !['BEGIN', 'SET', 'ROLLBACK'].includes(value))
      expect(count).toEqual([expected])
    }
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
