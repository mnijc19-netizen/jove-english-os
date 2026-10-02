import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { compileScript, parse } from '@vue/compiler-sfc'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import * as Vue from 'vue'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import * as repository from '../src/db/repository'
import * as longitudinal from '../src/domain/longitudinal'
import { missions } from '../src/content/materials'
import { useRequest } from '../src/composables/useRequest'
import { defaultProfile, defaultSettings, type Conversation, type Evaluation, type StudyEvent, type ErrorPattern } from '../src/domain/types'

// Execute the actual page setup and handlers, with real local repository/event
// projection. Only network/speech/child controls are fixtures; no paid requests.
const renderer = Vue.createRenderer<object, object>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  setText() {}, setElementText() {}, patchProp() {}, insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null })
let component: { setup: (props: object, context: object) => Record<string, unknown> }, mounted: Vue.App | undefined
let api: Record<string, unknown>
const query: Record<string, string> = { mode: 'repair' }
const evaluation: Evaluation = { summary: 'Saved language feedback', strengths: [], errors: [], comprehension: null, accuracy: 0.7,
  fluency: null, successfulChunks: [], nextPrompt: 'Try another situation', provenance: { provider: 'fixture', model: 'same-model' } }
function makeState() {
  return Vue.reactive({ profile: defaultProfile(), settings: defaultSettings, materials: [], skills: [], cards: [], chunks: [],
    events: [] as StudyEvent[], errors: [] as ErrorPattern[], keySet: true,
    provider: { evaluate: vi.fn(async () => evaluation) }, completeTask: vi.fn(async () => {}),
    refresh: async () => { state.events = await db.events.toArray(); state.errors = await db.errors.toArray() },
    evidence: async (event: StudyEvent) => { await repository.recordEvent(event); await state.refresh() },
  })
}
let state: ReturnType<typeof makeState>
async function settle() { for (let i = 0; i < 20; i++) { await setImmediate(); await Vue.nextTick() } }
async function mount() {
  mounted = renderer.createApp({ setup(props, context) { api = component.setup(props, context); return () => null } })
  mounted.mount({}); await settle()
}
beforeAll(() => {
  const descriptor = parse(readFileSync(new URL('../src/pages/Speak.vue', import.meta.url), 'utf8'), { filename: 'Speak.vue' }).descriptor
  const script = compileScript(descriptor, { id: 'actual-speak-setup' })
  const dependencies: Record<string, unknown> = {
    vue: Vue, 'vue-router': { useRoute: () => ({ query }), onBeforeRouteLeave() {}, onBeforeRouteUpdate() {} },
    '../stores/app': { useApp: () => state }, '../db/db': { db }, '../db/repository': repository,
    '../domain/longitudinal': longitudinal, '../content/materials': { missions }, '../composables/useRequest': { useRequest },
    '../speech/practice': { usePronunciationSession: () => Object.fromEntries(['reference', 'savedAudioId', 'savedReferenceId', 'pendingAttempt', 'active', 'loading', 'problem', 'disabled', 'recoveredResults'].map(key => [key, Vue.ref(null)])) },
    ...Object.fromEntries(['AudioPlayer', 'SavedRecording', 'Recorder', 'PronunciationPractice', 'Icon', 'CoachingFeedback'].map(name => [`../components/${name}.vue`, { default: {} }])),
  }
  const exports: { default?: typeof component } = {}
  const code = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  new Function('require', 'exports', code)((id: string) => { if (!(id in dependencies)) throw new Error(id); return dependencies[id] }, exports)
  component = exports.default!
})
beforeEach(async () => { await db.delete(); await db.open(); state = makeState(); query.mode = 'repair' })
afterEach(async () => { mounted?.unmount(); mounted = undefined; await settle(); vi.restoreAllMocks(); await db.delete() })

describe('English actual Speak collector and repair behavior', () => {
  it('records alternative repairs as unknown while preserving references, scores and FSRS', async () => {
    const error = await repository.saveError({ category: 'grammar', original: 'I student.', corrected: "I'm a student.", hint: 'Use a verb.', explanation: 'A subject needs a verb.' })
    await state.refresh(); const cards = await db.cards.toArray(); await mount()
    const answers = api.repairAnswers as Vue.Ref<Record<string, string>>
    answers.value[error.id] = 'I am a student.'
    await (api.repair as (id: string) => Promise<void>)(error.id)
    const saved = (await db.events.where('type').equals('SPEAK_RETRY').first())!
    expect(saved).toMatchObject({ source: 'self-report', data: { response: 'I am a student.', verification: 'unverified-alternative' } })
    expect(saved.score).toBeUndefined()
    expect((await db.errors.get(error.id))!.failures).toBe(1)
    expect((await db.skills.get('grammarProduction'))!.evidenceCount).toBe(0)
    expect(await db.cards.toArray()).toEqual(cards)
    expect((await db.sessions.get('speak-draft'))?.draft.repairAnswers).toMatchObject({ [error.id]: 'I am a student.' })
    expect(state.provider.evaluate).not.toHaveBeenCalled()
    answers.value[error.id] = error.corrected
    await (api.repair as (id: string) => Promise<void>)(error.id)
    expect((await db.events.where('type').equals('SPEAK_RETRY').toArray()).some(e => e.score === 1 && e.prompted)).toBe(true)
  })
  it('emits eight fresh real collector events that form a cautious cohort, and excludes exposed repeats', async () => {
    const day = 86_400_000, now = Date.parse('2026-10-03T12:00:00Z')
    const clock = vi.spyOn(Date, 'now'); query.mode = 'free'
    const timestamps = [1, 3, 8, 10, 15, 17, 22, 24].map(offset => now - (28 - offset) * day)
    for (const [i, timestamp] of timestamps.entries()) {
      clock.mockReturnValue(timestamp)
      const id = `conversation-${i}`, audioId = `audio-${i}`, responseId = `response-${i}`
      const conversation: Conversation = { id, mode: 'free', scenario: `A different fresh situation ${i}`, startedAt: timestamp,
        messages: [{ id: `prompt-${i}`, role: 'assistant', text: `Tell me about your plan for place ${i}.`, timestamp },
          { id: responseId, role: 'user', text: `My plan is to visit place ${i}.`, timestamp, audioId },
          { id: `reply-${i}`, role: 'assistant', text: `Thank you for explaining your plan for place ${i}.`, timestamp }] }
      await db.audio.put({ id: audioId, blob: new Blob(['original']), mimeType: 'audio/webm', createdAt: timestamp, duration: 1, kind: 'recording', processed: false, label: 'Original' })
      await db.conversations.put(conversation)
      await repository.recordEvent({ id: responseId, type: 'SPEAKING_RESPONSE', timestamp, source: 'text', sessionId: id,
        data: { audioId, transcriptVerified: true } })
      await db.sessions.put({ id: 'speak-draft', kind: 'speak', startedAt: timestamp, stage: 'free', draft: { conversationId: id,
        observation: { sessionId: id, priorExposure: false, difficulty: 0.35, mode: 'free', level: 'beginner' } } })
      await state.refresh(); await mount(); await (api.finish as () => Promise<void>)()
      mounted!.unmount(); mounted = undefined; await settle()
    }
    const emitted = await db.events.where('type').equals('CONVERSATION_EVALUATION').toArray()
    expect(emitted).toHaveLength(8)
    expect(new Set(emitted.map(e => e.data!.comparisonKey)).size).toBe(1)
    expect(longitudinal.analyzeLongitudinal(emitted, now).trends.find(t => t.skill === 'speakingAccuracy')).toMatchObject({ status: 'plateau', comparableDays: 8 })
    expect(longitudinal.analyzeLongitudinal(emitted.map(e => ({ ...e, data: { ...e.data, priorExposure: true } })), now).trends.find(t => t.skill === 'speakingAccuracy')!.status).toBe('unknown')
    expect(await db.audio.count()).toBe(8)
  })
})
