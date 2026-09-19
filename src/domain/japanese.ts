import type { Material, StudyEvent } from './types'
import { EXTERNAL_CATALOG_MAX_AGE, unavailableExternalIds } from '../content/external'

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

/** A finished practice selects the next lesson; it never certifies proficiency.
 * The caller supplies Japanese diagnostic difficulty, never English scores. */
export function nextJapaneseLesson(materials: Material[], events: StudyEvent[], targetDifficulty: number, now: number): Material | null {
  if (!Number.isFinite(targetDifficulty) || targetDifficulty < 0 || targetDifficulty > 1 || !Number.isFinite(now)) throw new Error('Invalid Japanese planning context')
  const unavailable = unavailableExternalIds(events, now)
  const eligible = materials.filter(material => material.language === 'ja' && material.approved && !material.synthetic && material.externalStudy
    && /^ja-irodori-starter-(?:[1-9]|1[0-8])$/u.test(material.id) && !unavailable.has(material.id)
    && material.externalStudy.checkedAt <= now + 300000 && now - material.externalStudy.checkedAt < EXTERNAL_CATALOG_MAX_AGE
    && material.difficulty <= Math.min(1, targetDifficulty + 0.15))
  const last = new Map<string, number>()
  for (const event of events) if (event.type === 'EXTERNAL_LISTEN_REFLECTION' && event.source === 'self-report' && event.sessionId
    && event.timestamp <= now && event.timestamp >= 0 && event.data?.listened === true && event.data.playbackObserved === false
    && event.data.comprehensionVerified === false && ['materialId', 'response', 'expression', 'example', 'audioId'].every(key => typeof event.data?.[key] === 'string' && String(event.data[key]).trim())) {
    const id = String(event.data.materialId)
    last.set(id, Math.max(last.get(id) ?? 0, event.timestamp))
  }
  const position = (material: Material) => Number(material.id.split('-').at(-1))
  const unseen = eligible.filter(material => !last.has(material.id)).sort((a, b) => position(a) - position(b))
  return unseen[0] ?? [...eligible].sort((a, b) => (last.get(a.id) ?? 0) - (last.get(b.id) ?? 0) || position(a) - position(b))[0] ?? null
}
