import { parseVoaLessonPage } from '../content/pipeline'
import { ALLOWLISTED_CONTENT_SOURCES, VOA_LESSON_CANDIDATES } from '../content/sources'
import { contentAudioWindow } from './content-audio'
import { ContentNetworkError, fetchContentResource, type ContentFetcher } from './content-network'
import { contentEvidenceHash, revalidateContentRights } from './content-rights'

/** Bounded candidate research, NOT an eligible-lesson publisher or a general crawler.
 * No paid call, database approval, synthesized captions, or external writes occur here.
 */
export async function auditVoaLessonCandidates(options: {
  ids?: readonly string[]; fetcher?: ContentFetcher; probeAudio?: boolean; now?: () => number; signal?: AbortSignal
} = {}) {
  const ids = options.ids ?? VOA_LESSON_CANDIDATES.map(row => row.id)
  if (!ids.length || ids.length > 3 || new Set(ids).size !== ids.length || ids.some(id => !VOA_LESSON_CANDIDATES.some(row => row.id === id)))
    throw new ContentNetworkError('unapproved-voa-candidate')
  const source = ALLOWLISTED_CONTENT_SOURCES.find(row => row.id === 'voa-everyday-grammar')!
  const rights = await revalidateContentRights({ source, fetcher: options.fetcher, now: options.now, signal: options.signal })
  if (rights.status !== 'verified') throw new ContentNetworkError('voa-publisher-policy-not-verified')
  const fetcher = options.fetcher ?? fetchContentResource
  const results = []
  for (const id of ids) {
    const contract = VOA_LESSON_CANDIDATES.find(row => row.id === id)!
    const response = await fetcher({ source, url: contract.pageUrl, role: 'page', exactUrls: [contract.pageUrl], maxBytes: 1_048_576, signal: options.signal })
    if (response.status !== 200 || response.finalUrl !== contract.pageUrl || response.body.length > 1_048_576 || response.contentType !== 'text/html')
      throw new ContentNetworkError('voa-page-response-invalid')
    const candidate = parseVoaLessonPage(new TextDecoder('utf-8', { fatal: true }).decode(response.body), contract)
    let audioProbe = null
    if (options.probeAudio) {
      const audio = await fetcher({ source, url: contract.audioUrl, role: 'audio', exactUrls: [contract.audioUrl], maxBytes: 8 * 1024 * 1024, signal: options.signal })
      if (audio.status !== 200 || audio.finalUrl !== contract.audioUrl || audio.body.length > 8 * 1024 * 1024 || !['audio/mpeg', 'audio/mp3'].includes(audio.contentType))
        throw new ContentNetworkError('voa-audio-response-invalid')
      const clip = contentAudioWindow(audio.body, audio.contentType, 30, 90)
      audioProbe = { originalSha256: await contentEvidenceHash(audio.body), sourceBytes: audio.body.length,
        originalDurationSeconds: clip.originalDurationSeconds, clipSha256: await contentEvidenceHash(clip.bytes), clipBytes: clip.bytes.length,
        requestedStartSeconds: 30, requestedEndSeconds: 90, clipOriginSeconds: clip.originSeconds, clipEndSeconds: clip.endSeconds,
        timingBasis: clip.timingBasis, acousticallyReviewed: false as const,
        networkConstraint: audio.dnsPinning === 'deno-preflight-only' ? 'DNS preflight only, not pinned' : null }
    }
    results.push({ candidate, checkedAt: (options.now ?? Date.now)(), rights,
      pageSha256: await contentEvidenceHash(response.body), transcriptSha256: await contentEvidenceHash(candidate.publisherTranscript.text), audioProbe,
      nextGates: ['item-third-party-rights-review-required', 'actual-audio-timed-alignment-required', 'actual-human-audio-screen-required'],
      networkConstraint: response.dnsPinning === 'deno-preflight-only' ? 'DNS preflight only, not pinned' : null })
  }
  return results
}
