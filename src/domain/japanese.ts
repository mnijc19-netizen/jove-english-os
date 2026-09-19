import type { Material, StudyEvent } from './types'
import { unavailableExternalIds } from '../content/external'

export const japanesePlacementItems = [
  { id: 'hiragana', area: 'script', prompt: '「ねこ」对应哪一种罗马字读法？这只检查字形识别，不是听力。', choices: ['neko', 'reko', 'mero'], answer: 'neko' },
  { id: 'katakana', area: 'script', prompt: '「コーヒー」对应哪一种读法？', choices: ['koohii', 'kohitsu', 'goohi'], answer: 'koohii' },
  { id: 'small-kana', area: 'script', prompt: '「きゃ」通常如何划分拍数？', choices: ['一拍', '两拍', '不确定'], answer: '一拍' },
  { id: 'past', area: 'meaning', prompt: '「昨日、映画を見ました。」在说什么？', choices: ['昨天看了电影', '明天想看电影', '现在不看电影'], answer: '昨天看了电影' },
  { id: 'destination', area: 'meaning', prompt: '补全目的地表达：「駅＿＿行きます。」', choices: ['に', 'を', 'が'], answer: 'に' },
  { id: 'invitation', area: 'meaning', prompt: '「一緒に食べませんか。」通常在做什么？', choices: ['邀请一起吃饭', '要求对方不吃饭', '说明昨天没吃饭'], answer: '邀请一起吃饭' },
] as const
/** Limited diagnostic guides support and one conversation probe, not placement
 * into a certified level. Chinese kanji familiarity never establishes speech. */
export function japanesePlacement(answers: Record<string, string>) {
  if (Object.keys(answers).some(id => !japanesePlacementItems.some(item => item.id === id))
    || japanesePlacementItems.some(item => ![...item.choices, '跳过'].includes(answers[item.id] ?? ''))) throw new Error('Incomplete Japanese diagnostic')
  const correct = (area: 'script' | 'meaning') => japanesePlacementItems.filter(item => item.area === area && answers[item.id] === item.answer).length
  const script = correct('script'), meaning = correct('meaning')
  return { scriptCorrect: script, meaningCorrect: meaning, kanaSupport: script < 3,
    furigana: script < 2 ? 'full' as const : 'on-demand' as const,
    conversationProbe: script >= 2 && meaning >= 2 ? 9 : script >= 2 ? 3 : 1,
    listening: 'unknown' as const, speaking: 'unknown' as const, proficiency: 'unverified' as const }
}

/** Counts timing units in supplied kana, never guesses kanji readings or scores
 * a recording. Small contracted kana join the previous sound; っ/ん/ー each count. */
export function kanaMorae(reading: string): string[] {
  const normalized = reading.normalize('NFKC').replace(/[\s、。・！？!?]/gu, '')
    .replace(/[ァ-ヶ]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0x60))
  if (!normalized || !/^[ぁ-ゖー]+$/u.test(normalized)) throw new Error('Provide the word’s kana reading, not an inferred kanji pronunciation')
  const morae: string[] = []
  for (const character of normalized) {
    if (/[ぁぃぅぇぉゃゅょゎ]/u.test(character)) {
      if (!morae.length || /[っんーぁぃぅぇぉゃゅょゎ]$/u.test(morae.at(-1)!)) throw new Error('Invalid contracted kana reading')
      morae[morae.length - 1] += character
    } else morae.push(character)
  }
  return morae
}

/** Japanese has no whitespace word boundary. Segmenter output is a lookup aid,
 * not a calibrated vocabulary/reading-speed measure; fallback labels characters. */
export function japaneseTextUnits(text: string): { unit: 'word' | 'character'; units: string[] } {
  const normalized = text.normalize('NFKC').trim()
  if (typeof Intl.Segmenter === 'function') return { unit: 'word', units: [...new Intl.Segmenter('ja', { granularity: 'word' }).segment(normalized)]
    .filter(segment => segment.isWordLike).map(segment => segment.segment) }
  return { unit: 'character', units: [...normalized].filter(character => !/[\s\p{P}\p{S}]/u.test(character)) }
}

/** Fade help for THIS reference expression only. Kanji recognition, a rating
 * without a saved first response, and AI feedback cannot establish its reading.
 * Two separated unprompted kana recalls are an editorial support rule, not a
 * validated fluency/acoustic threshold. Alternative valid answers remain valid
 * language; a non-matching reading simply supplies no fading evidence here. */
export function japaneseReadingSupport(reading: string, chunkIds: string[], events: StudyEvent[], initialFull: boolean, now: number) {
  const normalizeKana = (value: string) => value.normalize('NFKC').replace(/[ァ-ヶ]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0x60))
    .replace(/[\s\p{P}]/gu, '')
  const expected = normalizeKana(reading), chunks = new Set(chunkIds), byId = new Map(events.map(event => [event.id, event]))
  const successes: number[] = [], responses = new Set<string>(), sessions = new Set<string>()
  let needsHelp = false
  const attempts = events.filter(event => event.type === 'review' && event.modality === 'recall' && event.source === 'self-report'
    && event.chunkId && chunks.has(event.chunkId) && event.sessionId && Number.isFinite(event.timestamp) && event.timestamp <= now
    && typeof event.data?.responseEventId === 'string').map(event => ({ event, response: byId.get(String(event.data!.responseEventId)) }))
    .sort((a, b) => (a.response?.timestamp ?? Infinity) - (b.response?.timestamp ?? Infinity) || a.event.id.localeCompare(b.event.id))
  for (const { event, response } of attempts) {
    if (!response || responses.has(response.id) || response.type !== 'REVIEW_RESPONSE' || response.source !== 'self-report'
      || response.sessionId !== event.sessionId || response.chunkId !== event.chunkId || response.modality !== 'recall'
      || !Number.isFinite(response.timestamp) || response.timestamp > event.timestamp || response.timestamp < 0
      || response.timestamp < now - 90 * 86400000) continue
    responses.add(response.id)
    if (event.prompted || response.prompted || event.data?.scheduledRating === 1 || event.data?.scheduledRating === 2) {
      successes.length = 0; needsHelp = true; continue
    }
    if (sessions.has(event.sessionId!) || ![3, 4].includes(Number(event.data?.scheduledRating)) || typeof response.data?.response !== 'string'
      || !/^[ぁ-ゖー]+$/u.test(expected) || normalizeKana(response.data.response) !== expected) continue
    const previous = successes.at(-1)
    if (previous !== undefined && (response.timestamp - previous < 20 * 3600000
      || new Date(response.timestamp).toISOString().slice(0, 10) === new Date(previous).toISOString().slice(0, 10))) continue
    successes.push(response.timestamp); sessions.add(event.sessionId!)
  }
  const faded = successes.length >= 2
  return { automatic: !faded && (initialFull || needsHelp), successfulDays: successes.length,
    reason: faded ? '这句参考表达已在两次隔天复习中独立写出假名，先收起读法；需要时随时展开。'
      : needsHelp ? '最近回忆这句表达有些吃力，先恢复读法帮助；不影响已有进度。'
        : '读法提示只辅助这句表达；认识汉字或完成课程不代表会听、会说。' }
}

/** A finished practice selects the next lesson; it never certifies proficiency.
 * The caller supplies Japanese diagnostic difficulty, never English scores. */
export function japaneseCoursePosition(id: string): number | null {
  const match = /^ja-irodori-(starter|elementary01|elementary02)-([1-9]|1[0-8])$/u.exec(id)
  return match ? ({ starter: 0, elementary01: 18, elementary02: 36 }[match[1]!] ?? 0) + Number(match[2]) : null
}
/** Same strict reflection contract for both curriculum ordering and its ceiling.
 * Unconfirmed clicks, malformed imports and future events cannot raise either. */
export function japanesePracticeHistory(events: StudyEvent[], now: number): StudyEvent[] {
  const valid = events.filter(event => event.type === 'EXTERNAL_LISTEN_REFLECTION' && event.source === 'self-report' && event.sessionId
    && Number.isFinite(event.timestamp) && event.timestamp <= now && event.timestamp >= 0 && event.data?.listened === true
    && event.data.playbackObserved === false && event.data.comprehensionVerified === false
    && ['materialId', 'response', 'expression', 'example', 'audioId'].every(key => typeof event.data?.[key] === 'string' && String(event.data[key]).trim())
    && japaneseCoursePosition(String(event.data.materialId)) !== null).sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  return [...new Map(valid.map(event => [event.sessionId!, event])).values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
}
export function nextJapaneseLesson(materials: Material[], events: StudyEvent[], targetDifficulty: number, now: number): Material | null {
  if (!Number.isFinite(targetDifficulty) || targetDifficulty < 0 || targetDifficulty > 1 || !Number.isFinite(now)) throw new Error('Invalid Japanese planning context')
  const unavailable = unavailableExternalIds(events, now)
  const eligible = materials.filter(material => material.language === 'ja' && material.approved && !material.synthetic && material.externalStudy
    && japaneseCoursePosition(material.id) !== null && !unavailable.has(material.id)
    // These are finite editorial seeds, like the English starter links, not a
    // fresh-discovery feed. Preserve the real screening date; don't shut down
    // all lessons on day 90 or pretend opening a link re-verifies its contents.
    && material.externalStudy.checkedAt <= now + 300000
    && material.difficulty <= Math.min(1, targetDifficulty + 0.15))
  const last = new Map<string, number>()
  const history = japanesePracticeHistory(events, now)
  for (const event of history) {
    const id = String(event.data!.materialId)
    last.set(id, Math.max(last.get(id) ?? 0, event.timestamp))
  }
  const position = (material: Material) => japaneseCoursePosition(material.id)!
  // Difficulty feedback is about task load, not mastery. After difficulty,
  // consolidate the same topic once; repeated difficulty selects an earlier
  // approachable topic instead of locking the learner in an endless retry.
  const latest = history.at(-1), earlier = history.at(-2)
  if (latest?.data?.effort === 'hard') {
    const previous = eligible.find(material => material.id === latest.data!.materialId)
    if (previous) {
      if (earlier?.data?.effort !== 'hard' || earlier.data.materialId !== previous.id) return previous
      const easier = eligible.filter(material => material.difficulty < previous.difficulty).sort((a, b) => b.difficulty - a.difficulty)
      return easier[0] ?? previous
    }
  }
  const unseen = eligible.filter(material => !last.has(material.id)).sort((a, b) => position(a) - position(b))
  return unseen[0] ?? [...eligible].sort((a, b) => (last.get(a.id) ?? 0) - (last.get(b.id) ?? 0) || position(a) - position(b))[0] ?? null
}
