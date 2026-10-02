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

/** Original Can-do prompts, not copied publisher exercises or unseen transcripts.
 * Early VOA topics were checked against the publisher's lessons1–5 review and
 * lesson6 overview; unspecified pages keep a concrete personal-use task. */
export function externalCanDo(materialId: string): string {
  const goals: Record<string, string> = {
    'external-voa-welcome': '认识新朋友：听懂自我介绍，再介绍自己并问对方的名字。',
    'external-voa-level1-2': '介绍自己和来处，说明住在哪里，再礼貌告别；写成一条给新朋友的消息。',
    'external-voa-im-here': '电话联系别人：说明自己在哪里、为何来电，再提出一个清楚的请求。',
    'external-voa-level1-4': '说明自己带了什么、缺什么，再询问对方有没有一件日常物品。',
    'external-voa-level1-5': '说明人在什么房间、那里能做什么，再问别人在哪里。',
    'external-voa-level1-6': '询问一个设施在哪里，听清相对位置，再用自己的话确认方向。',
    'external-voa-directions': '给别人指路：抓住地点和方向，再用自己的话讲清一条路线。',
    'external-esl-first-date': '说明一个出行计划：听出安排与担忧，再说清自己的计划。',
  }
  return goals[materialId] ?? '听懂一件事，用今天的有用表达给朋友写 1–3 句自己的真实情况，再不照着稿子说出来。'
}

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

const practiceDay = 86_400_000
export function validExternalReflection(event: StudyEvent, materialId: string, now: number) {
  const data = event.data
  return event.type === 'EXTERNAL_LISTEN_REFLECTION' && event.source === 'self-report' && !!event.sessionId
    && Number.isFinite(event.timestamp) && event.timestamp >= 0 && event.timestamp <= now && data?.materialId === materialId
    && data.listened === true && data.playbackObserved === false && data.comprehensionVerified === false
    && ['response', 'expression', 'example', 'audioId'].every(key => typeof data[key] === 'string' && String(data[key]).trim())
}
function guidedReflection(event: StudyEvent) {
  const data = event.data
  return data?.guidedVersion === 1 && typeof data.retryAudioId === 'string' && !!data.retryAudioId.trim()
    && data.retryAudioId !== data.audioId && typeof data.firstExample === 'string' && !!data.firstExample.trim()
}
/** A practice sequence, not coverage of an entire publisher lesson or a mastery verdict.
 * Legacy participation retains its original scheduling contract; new work needs a
 * separate, delayed application. Frozen context IDs survive device switching. */
export function externalCoursePractice(materialId: string, events: StudyEvent[], now: number) {
  const history = events.filter(event => validExternalReflection(event, materialId, now))
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  const input = history.find(event => guidedReflection(event) && event.data?.coursePhase === 'input-application'
    && event.data.contextId === `${materialId}:application:0`)
  const delayed = input && history.find(event => guidedReflection(event) && event.sessionId !== input.sessionId
    && event.timestamp >= input.timestamp + practiceDay && event.data?.coursePhase === 'delayed-application'
    && event.data.contextId === `${materialId}:application:1`)
  const availableAt = input ? input.timestamp + practiceDay : 0
  const phase = input && now >= availableAt ? 'delayed-application' as const : 'input-application' as const
  const contexts: Record<string, string> = {
    'external-voa-welcome': '换成在工作或学校第一次遇到新同事：介绍自己，并问对方的名字或工作。',
    'external-voa-level1-2': '换成写信给新同学：介绍你的来处和现在的住处，再欢迎对方与你联系。',
    'external-voa-im-here': '换成在外出时需要朋友帮忙：说清楚你在哪里、需要什么帮助，再礼貌提出请求。',
    'external-voa-directions': '换成给朋友发语音：从你熟悉的地点出发，说明怎样到另一处，并提醒一个地标。',
    'external-voa-level1-4': '换成准备出门：给朋友留言说明你带了什么、还缺什么，并问能否借一件物品。',
    'external-voa-level1-5': '换成在图书馆找朋友：用简短消息说明你在哪里，并问对方在哪里。',
    'external-voa-level1-6': '换成在车站询问洗手间：问在哪里，再确认它与另一个地点的相对位置。',
    'external-esl-first-date': '换成给朋友发消息：提出你自己的周末计划，说明时间地点，再询问对方是否方便。',
  }
  return { phase, contextId: `${materialId}:application:${phase === 'delayed-application' ? 1 : 0}`, availableAt,
    complete: !!delayed || !history.some(event => event.data?.guidedVersion === 1) && history.some(event => event.data?.guidedVersion === undefined),
    priorExpression: String(input?.data?.expression || ''), priorMeaning: String(input?.data?.meaning || ''),
    contextPrompt: phase === 'delayed-application' ? contexts[materialId]
      || '换一个收件人和目的：用上次的有用表达，给朋友写一条与你真实生活有关的简短消息，再录音说给他听。不要照抄上次的句子。'
      : '根据今天的用途，用一个听到的表达，说和写自己的情况，而不是抄写视频对白。' }
}

/** Participation history selects input/application; it never awards mastery or changes FSRS. */
export function externalLessonCandidates(materials: Material[], events: StudyEvent[], now: number): Material[] {
  const unavailable = unavailableExternalIds(events, now)
  const eligible = materials.filter(m => m.approved && m.externalStudy && !m.synthetic && !unavailable.has(m.id) && externalCatalogFresh(m, now))
  const ids = new Set(eligible.map(m => m.id))
  const lastPractice = new Map<string, number>()
  for (const event of events) {
    const data = event.data
    if (typeof data?.materialId !== 'string' || !ids.has(data.materialId) || !validExternalReflection(event, data.materialId, now)) continue
    lastPractice.set(data.materialId, Math.max(lastPractice.get(data.materialId) ?? 0, event.timestamp))
  }
  const pending = eligible.filter(m => lastPractice.has(m.id) && !externalCoursePractice(m.id, events, now).complete)
  const due = pending.filter(m => externalCoursePractice(m.id, events, now).availableAt <= now)
  if (due.length) return due.sort((a, b) => lastPractice.get(a.id)! - lastPractice.get(b.id)! || a.id.localeCompare(b.id))
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
  const completed = eligible.filter(m => !pending.includes(m))
  let oldest = Infinity
  for (const material of completed) oldest = Math.min(oldest, lastPractice.get(material.id)!)
  return completed.filter(m => lastPractice.get(m.id) === oldest)
}
