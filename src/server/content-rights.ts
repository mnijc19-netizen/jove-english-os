import type { ContentSource } from '../content/pipeline-types'
import { ContentNetworkError, fetchContentResource, type ContentFetcher } from './content-network'

export interface ContentPolicyEvidence {
  url: string
  extractor: 'jb-footer' | 'hpr-policy' | 'cc-deed' | 'voa-copyright' | 'open-yap-license'
  /** Reviewed, canonical evidence hash; NEVER learned from the first unattended HTTP response. */
  sha256: string
}
export interface ContentRightsCheck {
  status: 'verified' | 'changed' | 'unavailable'
  checkedAt: number
  evidence: { url: string; expectedHash: string; observedHash: string | null; bodyHash: string | null }[]
  reason: string | null
  networkConstraints: string[]
}
// Live publisher and CC evidence inspected 2026-09-08. Scope remains publisher-owned material only.
// Hash whole relevant blocks (including restrictions/links), not merely the string "CC".
export const CONTENT_POLICY_EVIDENCE: readonly ContentPolicyEvidence[] = [
  { url: 'https://www.jupiterbroadcasting.com/', extractor: 'jb-footer', sha256: '1d6fae2087efd155ab89ca2847f4d16cb9525001e5f6982426ddec6aeda3aca9' },
  { url: 'https://hackerpublicradio.org/contribute.html', extractor: 'hpr-policy', sha256: '48cbbf831c5e15060187209c1932d7e27a8ab10cf1bb262f8062beb53b3f0322' },
  { url: 'https://creativecommons.org/licenses/by-sa/4.0/', extractor: 'cc-deed', sha256: 'f29080019fc7178897b93ac0d9c15fd7dd498adc78d0d1626c8d18a18325d414' },
  { url: 'https://learningenglish.voanews.com/p/6021.html', extractor: 'voa-copyright', sha256: '108c9e0faf8523aecb90d79ab979f7f47c72a110fa3b2935208bfa99519a43f8' },
  { url: 'https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k/raw/main/LICENSE.txt', extractor: 'open-yap-license', sha256: '530dfabbdd3bb641c601b665c52aa94ecbeb7f513a170dc388ff59b77d4248ea' },
]
export async function contentEvidenceHash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
/** Inert, bounded extraction of reviewed HTML blocks. Nothing is rendered, executed, or followed. */
export function extractContentPolicy(html: string, extractor: ContentPolicyEvidence['extractor']): string {
  if (html.length > 1_048_576 || /<!ENTITY|<!DOCTYPE[^>]*\[/iu.test(html)) throw new ContentNetworkError('unsafe-policy-document')
  let blocks: string[]
  if (extractor === 'open-yap-license') {
    if (!html.startsWith('Open Yap 1K — sample dataset') || !html.includes('CC-BY-4.0') || !html.includes('RIDER') ||
        !html.includes('Section 8 -- Interpretation.') || /[<>]/u.test(html)) throw new ContentNetworkError('policy-scope-changed')
    blocks = [html] // Entire reviewed license INCLUDING speaker privacy/no-cloning rider; not a keyword match.
  } else if (extractor === 'jb-footer') {
    blocks = html.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/giu) ?? []
    if (blocks.length !== 1 || !blocks[0]!.includes('Our shows are licensed under Creative Commons BY-SA 4.0')) throw new ContentNetworkError('policy-scope-changed')
  } else if (extractor === 'hpr-policy') {
    blocks = [...html.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/giu)].map(match => match[0])
      .filter(block => /<summary\s+id="(?:license|permission|not_moderated)"/u.test(block))
    if (blocks.length !== 3) throw new ContentNetworkError('policy-scope-changed')
  } else if (extractor === 'voa-copyright') {
    const sections = html.split('<p><strong>Copyright Statement</strong></p>')
    const endMarker = '<p><strong>Digital Millennium'
    if (sections.length !== 2 || !sections[1]!.includes(endMarker)) throw new ContentNetworkError('policy-scope-changed')
    blocks = [sections[1]!.split(endMarker)[0]!]
  } else {
    const sections = html.split('<div id="deed-body">')
    blocks = sections.length === 2 ? [sections[1]!.split('<div class="notice-bottom"')[0]!] : []
    if (blocks.length !== 1 || !blocks[0]!.includes('id="terms"') || !blocks[0]!.includes('ShareAlike')) throw new ContentNetworkError('policy-scope-changed')
  }
  const evidence = blocks.join('\n')
  if (evidence.length > 65_536 || /<\s*(?:script|iframe|object|embed)\b|\bon\w+\s*=|javascript:/iu.test(evidence)) throw new ContentNetworkError('unsafe-policy-document')
  return evidence.replace(/>\s+</gu, '><').replace(/\s+/gu, ' ').trim()
}

/** Full-body GET on each due check: 304 alone never renews the legal verification clock. */
export async function revalidateContentRights(input: {
  source: ContentSource; fetcher?: ContentFetcher; evidence?: readonly ContentPolicyEvidence[]; now?: () => number; signal?: AbortSignal
}): Promise<ContentRightsCheck> {
  const result: ContentRightsCheck = { status: 'verified', checkedAt: (input.now ?? Date.now)(), evidence: [], reason: null, networkConstraints: [] }
  if (!input.source.enabled || input.source.rights.status !== 'verified' || !['CC-BY-SA-4.0','CC-BY-4.0','VOA-public-domain'].includes(input.source.rights.license)) {
    return { ...result, status: 'changed', reason: 'source-rights-not-verified' }
  }
  const policies = input.evidence ?? CONTENT_POLICY_EVIDENCE
  if (!input.source.rights.evidenceUrls.length || input.source.rights.evidenceUrls.length > 4) return { ...result, status: 'changed', reason: 'policy-baseline-required' }
  for (const url of input.source.rights.evidenceUrls) {
    const policy = policies.find(policy => policy.url === url)
    if (!policy || !/^[a-f0-9]{64}$/u.test(policy.sha256)) return { ...result, status: 'changed', reason: 'policy-baseline-required' }
    const evidence = { url, expectedHash: policy.sha256, observedHash: null as string | null, bodyHash: null as string | null }
    result.evidence.push(evidence)
    try {
      const parsed = new URL(url)
      const source = { ...input.source, urls: { ...input.source.urls, page: [{ origin: parsed.origin, pathPrefix: parsed.pathname }] } }
      const response = await (input.fetcher ?? fetchContentResource)({ source, role: 'page', url, exactUrls: [url], maxBytes: 1_048_576, signal: input.signal })
      if (response.finalUrl !== url || response.body.length > 1_048_576) throw new ContentNetworkError('unapproved-policy-response')
      const types = policy.extractor === 'open-yap-license' ? ['text/plain'] : ['text/html', 'application/xhtml+xml']
      if (response.status !== 200 || !types.includes(response.contentType)) throw new ContentNetworkError('policy-fetch-unavailable')
      if (response.dnsPinning === 'deno-preflight-only') result.networkConstraints.push('Policy DNS check is Deno preflight-only; public-only controlled egress or Node pinned transport is required.')
      evidence.bodyHash = await contentEvidenceHash(response.body)
      const html = new TextDecoder('utf-8', { fatal: true }).decode(response.body)
      evidence.observedHash = await contentEvidenceHash(extractContentPolicy(html, policy.extractor))
      if (evidence.observedHash !== policy.sha256) return { ...result, status: 'changed', reason: 'publisher-license-evidence-changed' }
    } catch (error) {
      const changed = error instanceof ContentNetworkError && ['unsafe-policy-document', 'policy-scope-changed', 'unapproved-policy-response'].includes(error.code)
      return { ...result, status: changed ? 'changed' : 'unavailable', reason: changed ? 'publisher-license-evidence-changed' : 'publisher-license-check-unavailable' }
    }
  }
  return result
}
