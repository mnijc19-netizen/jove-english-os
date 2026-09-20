import type { Material, StudyEvent } from '../domain/types'

// Link-only editorial seed. No media, captions, answers or publisher exercises
// are copied. Difficulty is provisional, not CEFR or an acoustic quality score.
const checkedAt = Date.UTC(2026, 8, 12, 21)
type LinkLesson = { id: string; title: string; url: string; publisher: string;
  level: 'beginner' | 'intermediate' | 'advanced'; difficulty: number; duration: number; topic: string; mission: string }
export function externalMaterial(lesson: LinkLesson): Material {
  return { id: `external-${lesson.id}`, title: lesson.title, topic: lesson.topic, difficulty: lesson.difficulty,
    duration: lesson.duration, transcript: '', sentences: [], sourceKind: 'url', sourceUrl: lesson.url,
    sourceLabel: `${lesson.publisher} · publisher playback`, license: 'External page only; no media or transcript redistribution',
    synthetic: false, approved: true, question: lesson.mission, answer: '', keywords: [], chunks: [], createdAt: checkedAt,
    externalStudy: { publisher: lesson.publisher, level: lesson.level, mission: lesson.mission, checkedAt } }
}
export const externalMaterials: Material[] = [
  externalMaterial({ id: 'voa-welcome', title: 'Welcome: introduce yourself', publisher: 'VOA Learning English',
    url: 'https://learningenglish.voanews.com/a/lets-learn-english-lesson-one/3111026.html',
    level: 'beginner', difficulty: 0.15, duration: 0, topic: 'Everyday life · meeting people',
    mission: 'Listen to the first conversation without reading. Who meets whom? Then introduce yourself and ask someone their name.' }),
  externalMaterial({ id: 'voa-im-here', title: "I'm here: ask for help at home", publisher: 'VOA Learning English',
    url: 'https://learningenglish.voanews.com/a/lets-learn-english-lesson-3-i-am-here/3126527.html',
    level: 'beginner', difficulty: 0.25, duration: 0, topic: 'Living abroad · daily life',
    mission: 'Listen to the first conversation. What help does Anna need? Explain the situation, then practise asking a friend for help.' }),
  externalMaterial({ id: 'voa-directions', title: 'Give a visitor directions', publisher: 'VOA Learning English',
    url: 'https://learningenglish.voanews.com/a/lets-learn-english-lesson-10/3285228.html', level: 'beginner', difficulty: 0.35, duration: 90,
    topic: 'Living abroad · transportation', mission: 'Listen to the conversation before reading. Remember the route and landmarks, then give a visitor three directions in your own words.' }),
  externalMaterial({ id: 'esl-first-date', title: 'Explain your plans', publisher: "Randall's ESL Listening Lab",
    url: 'https://www.esl-lab.com/easy/first-date/', level: 'beginner', difficulty: 0.4, duration: 77,
    topic: 'Everyday life · social plans', mission: 'Play the conversation before opening the script. Explain the outing plan and the parent’s concerns, then describe your own plan reassuringly.' }),
]

/** Self-report is useful reflection, but no third-party playback is observable. */
export function externalPracticeReady(draft: { listened: boolean; answer: string; expression: string; example: string; audioId: string }) {
  return draft.listened && !!draft.answer.trim() && !!draft.expression.trim() && !!draft.example.trim() && !!draft.audioId
}

function voaCoursePosition(material: Material): { course: string; position: number } | undefined {
  const legacy: Record<string, number> = { 'external-voa-welcome': 1, 'external-voa-im-here': 3, 'external-voa-directions': 10 }
  if (legacy[material.id]) return { course: 'voa-level1', position: legacy[material.id]! }
  const match = /^external-(voa-level[12])-([1-9]|[1-4][0-9]|5[0-2])$/u.exec(material.id)
  return match && (match[1] === 'voa-level1' || Number(match[2]) <= 30)
    ? { course: match[1]!, position: Number(match[2]) } : undefined
}

export const EXTERNAL_CATALOG_MAX_AGE = 90 * 86_400_000
/** A learner's temporary access problem is not a publisher outage or skill result. */
export function unavailableExternalIds(events: StudyEvent[], now: number): Set<string> {
  return new Set(events.filter(event => event.type === 'EXTERNAL_LINK_UNAVAILABLE' && event.source === 'self-report'
    && !!event.sessionId && Number.isFinite(event.timestamp) && event.timestamp <= now && event.timestamp > now - 86_400_000
    && event.data?.issue === 'cannot-open' && event.data.playbackObserved === false
    && typeof event.data.materialId === 'string' && !!event.data.materialId.trim()).map(event => String(event.data!.materialId)))
}
/** Catalog-only links expire for new assignments, not for saved work or static seeds. */
export function externalCatalogFresh(material: Material, now: number): boolean {
  if (!/^external-(?:voa-level[12]|bbc-six-minute)-/u.test(material.id)) return true
  const checkedAt = material.externalStudy?.checkedAt
  return typeof checkedAt === 'number' && Number.isFinite(checkedAt)
    && checkedAt <= now + 300_000 && now - checkedAt < EXTERNAL_CATALOG_MAX_AGE
}

/** Participation history selects new input; it never awards mastery or changes FSRS. */
export function externalLessonCandidates(materials: Material[], events: StudyEvent[], now: number): Material[] {
  const unavailable = unavailableExternalIds(events, now)
  const eligible = materials.filter(m => m.approved && m.externalStudy && !m.synthetic && !unavailable.has(m.id) && externalCatalogFresh(m, now))
  const ids = new Set(eligible.map(m => m.id))
  const lastPractice = new Map<string, number>()
  for (const event of events) {
    const data = event.data
    if (event.type !== 'EXTERNAL_LISTEN_REFLECTION' || event.source !== 'self-report' || !event.sessionId
      || !Number.isFinite(event.timestamp) || event.timestamp < 0 || event.timestamp > now
      || typeof data?.materialId !== 'string' || !ids.has(data.materialId)
      || data.listened !== true || data.playbackObserved !== false || data.comprehensionVerified !== false
      || !['response', 'expression', 'example', 'audioId'].every(key => typeof data[key] === 'string' && String(data[key]).trim())) continue
    lastPractice.set(data.materialId, Math.max(lastPractice.get(data.materialId) ?? 0, event.timestamp))
  }
  const unseen = eligible.filter(m => !lastPractice.has(m.id))
  if (unseen.length) {
    const next = new Map<string, number>()
    for (const material of unseen) {
      const item = voaCoursePosition(material)
      if (item) next.set(item.course, Math.min(next.get(item.course) ?? Infinity, item.position))
    }
    // Independent editorial sequences. The planner still applies difficulty;
    // participation in either course never proves readiness for the other.
    return unseen.filter(m => { const item = voaCoursePosition(m); return !item || item.position === next.get(item.course) })
  }
  // Once the eligible reserve is exhausted, revisit the least recently practised
  // lesson. No new-content, verified-comprehension or proficiency claim is made.
  let oldest = Infinity
  for (const material of eligible) oldest = Math.min(oldest, lastPractice.get(material.id)!)
  return eligible.filter(m => lastPractice.get(m.id) === oldest)
}
