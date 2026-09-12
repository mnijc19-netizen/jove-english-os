import type { Material } from '../domain/types'

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
