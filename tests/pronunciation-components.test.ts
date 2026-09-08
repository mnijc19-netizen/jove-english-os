import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import * as Vue from 'vue'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSpeechBrowserClient, pronunciationReferenceReady, SPEECH_CLIENT_TIMEOUT_MS } from '../src/speech/client'
import type { BrowserAssessmentResult, PronunciationReference, SpeechClientRequest, SpeechCloudConnection } from '../src/speech/client'
import { normalizeAzureAssessment } from '../src/speech/normalize'
import { compareAcousticAttempts } from '../src/speech/feedback'
import { encodeAssessmentWav } from '../src/speech/wav'
import { SpeechError } from '../src/speech/types'
import { acousticEvents, ObservedPracticeClock } from '../src/speech/events'
import * as longitudinal from '../src/domain/longitudinal'
import { defaultProfile, defaultSettings, type StudyEvent, type StudySession, type Conversation, type Material } from '../src/domain/types'
import { demoMaterials, missions } from '../src/content/materials'
import { useRecordingUrl } from '../src/composables/useRecordingUrl'

const identitySource = vi.hoisted(() => ({ auth: undefined as unknown }))
vi.mock('../src/cloud/client', async () => {
  const { createPrincipalFence } = await import('../src/cloud/auth-fence')
  return { cloudClient: null, createAuthFence: () => createPrincipalFence(identitySource.auth as Parameters<typeof createPrincipalFence>[0]) }
})
vi.mock('../src/db/db', () => ({ db: { syncMeta: { get: async () => ({ value: 'owner-a' }) } } }))
const reference = (): PronunciationReference => ({ id: 'greeting-v1', text: 'Good morning.', audioUrl: 'https://example.com/reviewed.wav', audioSha256: 'a'.repeat(64), voiceReview: { locale: 'en-US', kind: 'human', rightsApproved: true, transcriptChecked: true, clearSingleSpeaker: true, naturalStressAndRhythm: true, generalAmericanReviewed: true, clippingOrIntrusiveNoise: false, reviewId: 'review-1' } })
const makeWav = () => encodeAssessmentWav(new Float32Array(48000).fill(0.1))
const makeRequest = (): SpeechClientRequest => ({ attemptId: 'attempt-1', recordingId: 'recording-1', referenceId: 'greeting-v1', referenceText: 'Good morning.', audioWav: makeWav() })
async function success(request = makeRequest()): Promise<Extract<BrowserAssessmentResult, { ok: true }>> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.referenceText.trim()))
  const referenceSha256 = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
  const raw = { RecognitionStatus: 'Success', Offset: 0, Duration: 10000000, NBest: [{ Confidence: 0.98, AccuracyScore: 80, FluencyScore: 65, Words: [{ Word: 'morning', AccuracyScore: 55, ErrorType: 'Mispronunciation', Offset: 0, Duration: 10000000 }] }] }
  return { ok: true, assessmentId: 'evidence-' + request.attemptId, assessment: normalizeAzureAssessment(raw, { attemptId: request.attemptId, recordingId: request.recordingId, referenceId: request.referenceId, referenceSha256, audioSeconds: 3, prosodyRequested: false }), usage: [{ service: 'azure.speech.pronunciation', requests: 1, submittedAudioSeconds: 3, estimatedBillableSeconds: 3, actualCostUsd: null, billingStatus: 'unknown' }] }
}
function connection() {
  const cloud = { auth: { getSession: vi.fn(async () => ({ data: { session: { user: { id: 'owner-a' }, access_token: 'testheader.testpayload.testsignature' } }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) }, functions: { invoke: vi.fn<SpeechCloudConnection['functions']['invoke']>() } }
  identitySource.auth = cloud.auth
  return cloud
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}
function sessionFixture() {
  const controller = new AbortController()
  return { signal: controller.signal, assertCurrent: vi.fn(async () => ({ user: { id: 'owner-a' }, access_token: 'inert' })),
    isCurrent: () => !controller.signal.aborted, dispose: () => controller.abort() }
}
describe('speech learning observations', () => {
  it('derives only raw-supported pronunciation/prosody, never scripted fluency or mastery', async () => {
    const result = await success(), events = acousticEvents(result, 'session-1', 1000)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ skill: 'pronunciation', prompted: true, source: 'acoustic', score: 0.8,
      data: { assessmentId: result.assessmentId, scripted: true, calibrated: false, rawValue: 80 } })
    expect(events.some(e => e.skill === 'speakingFluency')).toBe(false)
    result.assessment.scores.accuracy = 90
    expect(acousticEvents(result, 'session-1', 1000)).toEqual([])
  })
  it('measures only active monotonic intervals and consumes each second once', () => {
    const clock = new ObservedPracticeClock()
    clock.sample(0, true); clock.sample(2000, true); clock.sample(3000, false); clock.sample(4000, true)
    clock.sample(5000, true); clock.sample(30000, true); clock.sample(31000, true)
    expect(clock.takeSeconds()).toBe(4); expect(clock.takeSeconds()).toBe(0)
    clock.sample(32000, false); clock.sample(33000, false); expect(clock.takeSeconds()).toBe(0)
  })
})

function compileInMemory(source: string, dependencies: Record<string, unknown>): Record<string, unknown> {
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, unknown> = {}
  new Function('require', 'exports', code)((id: string) => { if (!(id in dependencies)) throw new Error('Unmapped page dependency ' + id); return dependencies[id] }, exports)
  return exports
}
interface PageState {
  start: () => Promise<void>; send: () => Promise<void>; finish: () => Promise<void>; check: () => Promise<void>
  beforeNavigation: () => Promise<boolean | undefined>; savedSpokenRecording: (value: { audioId: string; duration: number }) => Promise<void>
  text: string; audioId: string; sttText: string; mode: string; sid: string; loaded: boolean
  pronunciationActive: boolean; error: string; draft: Record<string, unknown>; hydrating: boolean
  listeningMedia: { querySelector: () => unknown }; sampleListeningTime: () => void; flushListeningTime: () => Promise<void>
  pronunciation: { recorded: (value: { audioId: string; duration: number; referenceId: string }) => Promise<void>; persistAttempt: (value: { attemptId: string; recordingId: string; referenceId: string }) => Promise<void>; retry: () => Promise<void>;
    evaluated: (value: Extract<BrowserAssessmentResult, { ok: true }>) => Promise<void>; recoveredResults: Vue.Ref<Extract<BrowserAssessmentResult, { ok: true }>[]>; loading: Vue.Ref<boolean>; problem: Vue.Ref<string> }
  pronunciationReference: PronunciationReference | null
  materialId: string; sentence: number; audioSrc?: string; audioText?: string; syntheticPlayback: boolean
  playbackRange?: { startSeconds: number; endSeconds: number }; audioLoading: boolean; audioError: string; audioReady: boolean
  retryAudio: () => void; audioPlaybackFailed: () => void; selectSentence: (index: number) => void; selectPhrase: (index: number) => void
  heard: () => Promise<void>; ended: () => Promise<void>
  conversation?: Conversation; observation: { sessionId: string; priorExposure: boolean; difficulty: number; level: string; mode: string } | null
}
function mountPage(name: 'Listen' | 'Speak', evaluate: Record<string, unknown> = {}, options: { materials?: Material[]; renderTemplate?: boolean; prepareAudio?: (material: Material, signal?: AbortSignal) => Promise<Blob>; transientAudio?: WeakSet<Blob> } = {}) {
  const sessions = new Map<string, StudySession>(), conversations = new Map<string, Conversation>()
  const audios = new Map<string, { id: string; kind: string; blob: Blob; duration: number; createdAt?: number }>()
  const clone = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
  const storage = {
    sessions: { get: vi.fn(async (id: string) => clone(sessions.get(id))), put: vi.fn(async (row: StudySession) => { sessions.set(row.id, clone(row)) }),
      add: vi.fn(async (row: StudySession) => { sessions.set(row.id, clone(row)) }), where: () => ({ equals: (id: string) => ({ toArray: async () => [...sessions.values()].filter(row => row.materialId === id) }) }) },
    conversations: { get: async (id: string) => clone(conversations.get(id)), put: async (row: Conversation) => { conversations.set(row.id, clone(row)) },
      filter: (fn: (c: Conversation) => boolean) => ({ count: async () => [...conversations.values()].filter(fn).length }) },
    audio: { get: async (id: string) => audios.get(id) },
    transaction: async (...args: unknown[]) => (args.at(-1) as () => Promise<void>)(),
  }
  const result = { summary: 'Test language feedback', strengths: [], errors: [], comprehension: 0.8, accuracy: 0.8, fluency: null, successfulChunks: [], nextPrompt: 'Next', ...evaluate }
  const appState = {
    profile: defaultProfile(), settings: defaultSettings, skills: [], cards: [], materials: Vue.reactive(clone(options.materials ?? demoMaterials)), events: [] as StudyEvent[],
    chunks: [] as { id: string; text: string }[], errors: [], keySet: true, online: true, notice: '', plan: { tasks: [] },
    provider: { evaluate: vi.fn(async () => result), chat: vi.fn(async () => 'What happened next?') },
    evidence: vi.fn(async (event: StudyEvent) => { appState.events.push(clone(event)) }), beginTask: vi.fn(), completeTask: vi.fn(), refresh: vi.fn(),
  }
  const refs = { configured: true, session: vi.fn(sessionFixture), references: vi.fn(async () => []), assess: vi.fn(),
    recover: vi.fn<(input: { attemptId: string; referenceText: string }, signal?: AbortSignal) => Promise<Extract<BrowserAssessmentResult, { ok: true }> | null>>(async () => null) }
  const practice = compileInMemory(readFileSync(fileURLToPath(new URL('../src/speech/practice.ts', import.meta.url)), 'utf8'), {
    vue: Vue, '../db/db': { db: storage }, '../stores/app': { useApp: () => appState }, './client': { speechBrowserClient: refs }, './events': { acousticEvents }, './types': { SpeechError },
  })
  const route = Vue.reactive({ query: name === 'Listen' ? { material: appState.materials[0]!.id } : { mode: 'mission' } })
  const prepareAudio = vi.fn(options.prepareAudio ?? (async () => new Blob(['test clip'], { type: 'audio/wav' })))
  const guards: (() => Promise<boolean | undefined>)[] = []
  const dependencies: Record<string, unknown> = {
    vue: Vue, 'vue-router': { useRoute: () => route, useRouter: () => ({ push: vi.fn() }), onBeforeRouteLeave: (fn: () => Promise<boolean | undefined>) => guards.push(fn), onBeforeRouteUpdate: vi.fn() },
    '../stores/app': { useApp: () => appState }, '../db/db': { db: storage }, '../db/repository': { saveError: vi.fn(), addChunk: vi.fn() },
    '../composables/useRequest': { useRequest: () => ({ busy: Vue.ref(false), error: Vue.ref(''), cancel: vi.fn(), run: async (fn: (s: AbortSignal) => Promise<unknown>) => fn(new AbortController().signal) }) },
    '../content/materials': { demoMaterials, missions }, '../domain/longitudinal': longitudinal,
    '../speech/practice': practice, '../speech/events': { ObservedPracticeClock },
    '../cloud/content': { prepareContentAudio: prepareAudio, contentAudioIsTransient: (blob: Blob) => options.transientAudio?.has(blob) ?? false },
  }
  for (const component of ['AudioPlayer', 'SavedRecording', 'Recorder', 'Icon', 'PronunciationPractice']) dependencies[`../components/${component}.vue`] = { default: Vue.defineComponent({ render: () => Vue.h('div') }) }
  dependencies['../components/AudioPlayer.vue'] = { default: Vue.defineComponent({ props: ['src', 'text', 'startSeconds', 'endSeconds', 'synthetic', 'label'],
    setup: (props, { expose }) => { expose({ stop: vi.fn(), toggle: vi.fn() }); return () => Vue.h('div', { 'data-player': true, 'data-src': props.src, 'data-text': props.text, 'data-start': props.startSeconds, 'data-end': props.endSeconds, 'data-synthetic': props.synthetic }, props.label) } }) }
  const filename = fileURLToPath(new URL(`../src/pages/${name}.vue`, import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'page-contract', inlineTemplate: false })
  const compiled = compileInMemory(script.content, dependencies).default as Vue.Component
  const template = options.renderTemplate ? compileTemplate({ source: descriptor.template!.content, filename, id: 'page-contract', compilerOptions: { bindingMetadata: script.bindings, hoistStatic: false } }) : undefined
  if (template?.errors.length) throw new Error(String(template.errors))
  Object.assign(compiled, { render: template ? compileInMemory(template.code, dependencies).render : () => Vue.h('div') })
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true })
  vi.stubGlobal('Document', HostDocument)
  const root = new HostNode('page'), application = renderer.createApp(compiled)
  application.component('RouterLink', Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('a', slots.default?.()) }))
  const instance = application.mount(root)
  mounted.push(application)
  return { state: (instance.$ as unknown as { setupState: PageState }).setupState, app: appState, storage, sessions, conversations, audios, guards, route, refs, prepareAudio, root,
    unmount: () => { application.unmount(); mounted.splice(mounted.indexOf(application), 1) } }
}

function authenticMaterial(id = 'authentic-lesson', mimeType = 'audio/wav'): Material {
  return { ...demoMaterials[0]!, id, synthetic: false, audioPath: 'https://example.invalid/unverified-source.mp3', audioId: undefined,
    sentences: ['Good morning.', 'How are you?'], transcript: 'Good morning. How are you?',
    authenticPlayback: { segmentId: id + '-segment', audioSha256: 'a'.repeat(64), sourceAudioSha256: 'b'.repeat(64),
      startSeconds: 2, endSeconds: 10, durationSeconds: 12, clipOriginSeconds: 98, sourceStartSeconds: 100, sourceEndSeconds: 108,
      timingBasis: mimeType === 'audio/wav' ? 'pcm-sample-count' : 'mpeg-frame-count-with-preroll', mimeType, byteLength: 100,
      sentenceRanges: [{ startSeconds: 0, endSeconds: 3 }, { startSeconds: 3, endSeconds: 8 }] } }
}

describe('Listen authentic clip playback and lifecycle', () => {
  it('keeps verified transient audio playable and clears the offline warning during retry and cached recovery', async () => {
    const temporary = new Blob(['verified transient audio']), cached = new Blob(['verified cached audio'])
    const pending = deferred<Blob>(), hint = 'Ready to play now. This audio could not be saved offline; stay online or free browser storage.'
    const view = mountPage('Listen', {}, { materials: [authenticMaterial()], renderTemplate: true,
      prepareAudio: async () => temporary, transientAudio: new WeakSet([temporary]) }); await flush()
    expect(content(view.root)).toContain(hint)
    expect(find(view.root, n => n.props['data-player'] === true)).toBeDefined()
    expect(view.state.audioText).toBeUndefined(); expect(view.state.syntheticPlayback).toBe(false)
    view.state.selectSentence(1); await flush(); expect(content(view.root)).toContain(hint)
    view.state.selectPhrase(0); await flush(); expect(content(view.root)).not.toContain(hint)
    view.state.selectPhrase(-1); view.state.audioPlaybackFailed(); await flush()
    expect(content(view.root)).not.toContain(hint)
    view.prepareAudio.mockReturnValueOnce(pending.promise); view.state.retryAudio(); await flush()
    expect(view.state.audioLoading).toBe(true); expect(content(view.root)).not.toContain(hint)
    pending.resolve(cached); await flush()
    expect(view.state.audioReady).toBe(true); expect(content(view.root)).not.toContain(hint)
  })
  it('never transfers a late transient-audio warning onto the next lesson', async () => {
    const pending = deferred<Blob>(), temporary = new Blob(['late verified audio'])
    const view = mountPage('Listen', {}, { materials: [authenticMaterial('first'), authenticMaterial('second')], renderTemplate: true,
      prepareAudio: material => material.id === 'first' ? pending.promise : Promise.resolve(new Blob(['cached second'])), transientAudio: new WeakSet([temporary]) }); await flush()
    view.route.query.material = 'second'; await flush()
    pending.resolve(temporary); await flush()
    expect(view.prepareAudio.mock.calls[0]![1]!.aborted).toBe(true)
    expect(view.state.audioReady).toBe(true); expect(view.state.materialId).toBe('second')
    expect(content(view.root)).not.toContain('This audio could not be saved offline')
  })
  it.each(['audio/wav', 'audio/mpeg'])('uses only the verified %s Blob for full and exact sentence ranges without TTS', async mime => {
    const original = new Blob(['hash-verified fixture'], { type: mime })
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:verified-clip')
    const view = mountPage('Listen', {}, { materials: [authenticMaterial('authentic-lesson', mime)], renderTemplate: true, prepareAudio: async () => original }); await flush()
    expect(view.prepareAudio).toHaveBeenCalledWith(view.app.materials[0], expect.any(AbortSignal))
    expect(create).toHaveBeenCalledWith(original)
    const full = find(view.root, n => n.props['data-player'] === true)!
    expect(full.props).toMatchObject({ 'data-src': 'blob:verified-clip', 'data-text': undefined, 'data-start': 2, 'data-end': 10, 'data-synthetic': false })
    view.state.selectSentence(1); await flush()
    expect(find(view.root, n => n.props['data-player'] === true)?.props).toMatchObject({ 'data-src': 'blob:verified-clip', 'data-text': undefined, 'data-start': 5, 'data-end': 10, 'data-synthetic': false })
    expect(view.prepareAudio).toHaveBeenCalledTimes(1)
    expect(view.app.materials[0]!.audioId).toBeUndefined()
    view.state.selectPhrase(0); await flush()
    expect(find(view.root, n => n.props['data-player'] === true)?.props).toMatchObject({ 'data-src': undefined, 'data-text': 'How are you?', 'data-start': undefined, 'data-end': undefined, 'data-synthetic': true })
    expect(content(view.root)).toContain('Synthesized phrase demonstration')
    view.state.selectPhrase(-1); await flush()
    expect(view.state.audioText).toBeUndefined(); expect(view.state.playbackRange).toEqual({ startSeconds: 5, endSeconds: 10 })
  })
  it('shows loading/failure/retry and retains the first response draft without invented playback', async () => {
    const pendingAudio = deferred<Blob>()
    const view = mountPage('Listen', {}, { materials: [authenticMaterial()], renderTemplate: true, prepareAudio: () => pendingAudio.promise }); await flush()
    view.state.draft.answer = 'My unfinished answer'; await flush()
    expect(content(view.root)).toContain('Loading the original recording')
    expect(find(view.root, n => n.props['data-player'] === true)).toBeUndefined()
    await view.state.heard(); await view.state.ended()
    expect(view.state.draft.playCount).toBe(0); expect(view.state.draft.completedPlays).toBe(0)
    pendingAudio.resolve(new Blob()); await flush()
    expect(content(view.root)).toContain('could not be loaded or verified')
    expect(view.state.audioText).toBeUndefined(); expect(view.state.syntheticPlayback).toBe(false)
    view.prepareAudio.mockResolvedValue(new Blob(['verified']))
    await click(button(view.root, 'Retry original audio')); await flush()
    expect(view.state.audioReady).toBe(true); expect(view.state.audioError).toBe('')
    expect(view.sessions.get(view.state.sid)?.draft.answer).toBe('My unfinished answer')
    await view.state.heard(); await view.state.ended(); await flush()
    expect(view.state.draft.playCount).toBe(1); expect(view.state.draft.completedPlays).toBe(1)
    expect(view.app.events.find(e => e.type === 'AUDIO_PLAYED')?.data).toMatchObject({ synthetic: false, firstPass: true })
  })
  it('handles a rejected hash check and a native media error with only an original-audio retry', async () => {
    const view = mountPage('Listen', {}, { materials: [authenticMaterial()], renderTemplate: true, prepareAudio: async () => { throw new Error('upstream private response') } }); await flush()
    expect(content(view.root)).toContain('Retry original audio'); expect(content(view.root)).not.toContain('upstream private response')
    expect(find(view.root, n => n.props['data-player'] === true)).toBeUndefined()
    view.prepareAudio.mockResolvedValue(new Blob(['verified'])); view.state.retryAudio(); await flush()
    const mediaParent = find(view.root, n => typeof n.props.onErrorCapture === 'function')!
    ;(mediaParent.props.onErrorCapture as () => void)(); await flush()
    expect(view.state.audioText).toBeUndefined(); expect(view.state.audioReady).toBe(false)
    expect(content(view.root)).toContain('Retry loading the recording')
    expect(find(view.root, n => n.props['data-player'] === true)).toBeUndefined()
  })
  it('keeps the playing Blob through store refreshes but invalidates changed playback identity', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const view = mountPage('Listen', {}, { materials: [authenticMaterial()] }); await flush()
    const src = view.state.audioSrc, signal = view.prepareAudio.mock.calls[0]![1]!
    view.app.materials.splice(0, 1, JSON.parse(JSON.stringify(view.app.materials[0]))); await flush()
    expect(view.prepareAudio).toHaveBeenCalledTimes(1); expect(signal.aborted).toBe(false)
    expect(view.state.audioSrc).toBe(src); expect(revoke).not.toHaveBeenCalled()
    view.app.materials[0]!.authenticPlayback!.audioSha256 = 'c'.repeat(64); await flush()
    expect(signal.aborted).toBe(true); expect(revoke).toHaveBeenCalledWith(src)
    expect(view.prepareAudio).toHaveBeenCalledTimes(2)
  })
  it('fails closed on missing or out-of-lesson sentence times while preserving full playback', async () => {
    const lesson = authenticMaterial(); lesson.authenticPlayback!.sentenceRanges[1]!.endSeconds = 9
    const view = mountPage('Listen', {}, { materials: [lesson], renderTemplate: true }); await flush()
    view.state.selectSentence(1); await flush()
    expect(view.state.audioReady).toBe(false); expect(view.state.audioText).toBeUndefined()
    expect(find(view.root, n => n.props['data-player'] === true)).toBeUndefined()
    expect(content(view.root)).toContain('no valid timing')
    await click(button(view.root, 'Return to full passage')); await flush()
    expect(view.state.playbackRange).toEqual({ startSeconds: 2, endSeconds: 10 })
    view.state.selectSentence(3); await flush(); expect(view.state.audioReady).toBe(false)
    // Preserve the same 50 ms container/timestamp rounding tolerance as the verified helper.
    view.app.materials[0]!.authenticPlayback!.sentenceRanges[1]!.endSeconds = 8.02
    view.state.selectSentence(1); await flush()
    expect(view.state.playbackRange).toEqual({ startSeconds: 5, endSeconds: 10.02 })
    expect(view.state.audioReady).toBe(true)
  })
  it('aborts stale route and unmount requests, releases URLs and preserves saved recording associations', async () => {
    const first = deferred<Blob>(), last = deferred<Blob>()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:second-clip'), revoke = vi.spyOn(URL, 'revokeObjectURL')
    const view = mountPage('Listen', {}, { materials: [authenticMaterial('first'), authenticMaterial('second')],
      prepareAudio: material => material.id === 'first' ? first.promise : Promise.resolve(new Blob(['second'])) }); await flush()
    const firstSid = view.state.sid, firstSignal = view.prepareAudio.mock.calls[0]![1]!
    view.state.draft.audioId = 'saved-shadow-recording'; view.state.draft.answer = 'Keep this work'; await flush()
    view.route.query.material = 'second'; await flush()
    expect(firstSignal.aborted).toBe(true)
    first.resolve(new Blob(['late first'])); await flush()
    expect(create).toHaveBeenCalledTimes(1); expect(view.state.audioSrc).toBe('blob:second-clip')
    expect(view.sessions.get(firstSid)?.draft).toMatchObject({ audioId: 'saved-shadow-recording', answer: 'Keep this work' })
    view.prepareAudio.mockImplementation(() => last.promise); view.state.retryAudio(); await flush()
    expect(revoke).toHaveBeenCalledWith('blob:second-clip')
    const lastSignal = view.prepareAudio.mock.calls.at(-1)![1]!
    view.unmount(); expect(lastSignal.aborted).toBe(true)
    last.resolve(new Blob(['late unmount'])); await flush()
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('compiled Listen/Speak page contracts and actual pronunciation persistence', () => {
  it('allows practice reload after a read timeout but never rebinds a permanently invalidated practice lifetime', async () => {
    const view = mountPage('Speak'); await flush()
    view.refs.session.mockImplementationOnce(() => ({ ...sessionFixture(), assertCurrent: vi.fn(async () => { throw new SpeechError('TIMEOUT') }) }))
    await view.state.pronunciation.retry()
    expect(view.state.pronunciation.loading.value).toBe(false)
    expect(view.state.pronunciation.problem.value).toContain('timed out')
    await view.state.pronunciation.retry()
    expect(view.state.pronunciation.problem.value).toBe('')
    view.refs.session.mock.results.at(-1)!.value.dispose(); await flush()
    const calls = view.refs.session.mock.calls.length, writes = view.storage.sessions.put.mock.calls.length
    await view.state.pronunciation.retry()
    expect(view.refs.session).toHaveBeenCalledTimes(calls)
    expect(view.storage.sessions.put).toHaveBeenCalledTimes(writes)
    expect(view.state.pronunciation.problem.value).toContain('account changed')
  })
  it('Listen produces prospective comparable language evidence only with actual evaluator provenance', async () => {
    const view = mountPage('Listen', { provenance: { provider: 'inert-test', model: 'actual-model' } }); await flush()
    view.state.draft.answer = 'A relevant first answer.'; view.state.draft.listened = true
    view.state.draft.playCount = 1; view.state.draft.completedPlays = 1
    view.state.draft.playbackRates = [1]
    await view.state.check(); await flush()
    const event = view.app.events.find(e => e.id.endsWith('-meaning'))!
    expect(event).toMatchObject({ prompted: false, source: 'ai', skill: 'listeningSentences', data: { rubricVersion: 'listening-main-idea-detail-v1', firstPass: true, priorExposure: false } })
    expect(event.data?.conditionsKey).toContain('actual-model')
    expect(event.data?.comparisonKey).toContain(demoMaterials[0]!.id)
    expect(view.app.provider.evaluate.mock.calls[0]).toBeDefined()
    expect(view.sessions.get(event.sessionId!)?.draft.outbox).toEqual([])
  })
  it('Listen leaves comparison metadata unknown without provenance and guards active pronunciation navigation', async () => {
    const view = mountPage('Listen'); await flush()
    view.state.draft.answer = 'An answer'; view.state.draft.listened = true; view.state.draft.playCount = 1
    await view.state.check(); await flush()
    expect(view.app.events.find(e => e.id.endsWith('-meaning'))?.data?.conditionsKey).toBeUndefined()
    view.state.pronunciationActive = true
    expect(await view.guards[0]!()).toBe(false)
  })
  it('Speak logs original saved duration once and stores only verified prospective language comparison facts', async () => {
    const view = mountPage('Speak', { provenance: { provider: 'inert-test', model: 'actual-model' } }); await flush()
    await view.state.start(); await flush()
    view.audios.set('original-recording', { id: 'original-recording', kind: 'recording', blob: new Blob(['actual local fixture']), duration: 4 })
    await view.state.savedSpokenRecording({ audioId: 'original-recording', duration: 999 })
    await view.state.savedSpokenRecording({ audioId: 'original-recording', duration: 999 })
    expect(view.app.events.filter(e => e.type === 'PRACTICE_LOGGED')).toHaveLength(1)
    expect(view.app.events.find(e => e.type === 'PRACTICE_LOGGED')?.data).toMatchObject({ strand: 'output', activeSeconds: 4 })
    view.state.text = 'Could you show me the way?'; view.state.sttText = view.state.text
    await view.state.send(); await view.state.finish(); await flush()
    const event = view.app.events.find(e => e.id.endsWith('-accuracy'))!
    expect(event).toMatchObject({ prompted: false, source: 'ai', skill: 'speakingAccuracy', data: { rubricVersion: 'conversation-language-accuracy-v1', textOnlyEvaluation: true, firstPass: true, priorExposure: false } })
    expect(event.data?.conditionsKey).toContain('actual-model')
    expect(view.app.events.some(e => e.skill === 'speakingFluency' || e.skill === 'pronunciation')).toBe(false)
  })
  it('Speak preserves missing legacy conditions and never lets guided text become independent acoustics', async () => {
    const view = mountPage('Speak'); await flush(); view.state.mode = 'guided'
    await view.state.start(); view.state.text = 'Typed response'; await view.state.send(); await view.state.finish()
    const event = view.app.events.find(e => e.id.endsWith('-accuracy'))!
    expect(event).toMatchObject({ prompted: true, skill: 'grammarProduction', source: 'ai' })
    expect(event.data?.conditionsKey).toBeUndefined()
    view.state.pronunciationActive = true; expect(await view.guards[0]!()).toBe(false)
  })
  it('freezes slow playback separately and never counts stationary media buffering as listening time', async () => {
    const view = mountPage('Listen', { provenance: { provider: 'test', model: 'model' } }); await flush()
    view.state.draft.answer = 'Meaning'; view.state.draft.listened = true; view.state.draft.playCount = 1; view.state.draft.completedPlays = 1; view.state.draft.playbackRates = [0.85]
    await view.state.check()
    expect(view.app.events.find(e => e.id.endsWith('-meaning'))?.data?.conditionsKey).toContain('0.85')
    let time = 0
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    const audio = { currentTime: 1, playbackRate: 1, paused: false, ended: false, readyState: 2 }
    view.state.listeningMedia = { querySelector: () => audio }
    for (let i = 0; i <= 10; i++) { time = i * 1000; view.state.sampleListeningTime() }
    await view.state.flushListeningTime()
    expect(view.app.events.some(e => e.type === 'PRACTICE_LOGGED')).toBe(false)
    audio.readyState = 4
    for (let i = 11; i <= 16; i++) { time = i * 1000; audio.currentTime++; view.state.sampleListeningTime() }
    await view.state.flushListeningTime()
    expect(view.app.events.find(e => e.type === 'PRACTICE_LOGGED')?.data?.activeSeconds).toBeGreaterThan(0)
    vi.restoreAllMocks()
  })
  it('periodically persists measured listening intervals before finish or navigation', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const view = mountPage('Listen'); await flush()
    let time = 0
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    const audio = { currentTime: 0, playbackRate: 1, paused: false, ended: false, readyState: 4 }
    view.state.listeningMedia = { querySelector: () => audio }
    for (let i = 0; i <= 12; i++) { time = i * 1000; audio.currentTime = i; view.state.sampleListeningTime() }
    await vi.advanceTimersByTimeAsync(15000); await flush()
    expect(view.app.events.some(e => e.type === 'PRACTICE_LOGGED')).toBe(true)
    expect(view.sessions.get(view.state.sid)?.draft.outbox).toEqual([])
    vi.restoreAllMocks()
  })
  it('logs pronunciation original duration before any assessment and recovers a lost result after voice revocation', async () => {
    const view = mountPage('Speak'); await flush()
    view.state.pronunciationReference = reference()
    view.audios.set('recording-1', { id: 'recording-1', kind: 'recording', blob: new Blob(['original']), duration: 3, createdAt: 1000 })
    await view.state.pronunciation.recorded({ audioId: 'recording-1', duration: 900, referenceId: 'greeting-v1' })
    await view.state.pronunciation.persistAttempt({ attemptId: 'attempt-1', recordingId: 'recording-1', referenceId: 'greeting-v1' })
    expect(view.app.events.find(e => e.type === 'PRACTICE_LOGGED')).toMatchObject({ source: 'objective', data: { strand: 'language', activeSeconds: 3 } })
    view.refs.recover.mockResolvedValue(await success() as never)
    await view.state.pronunciation.retry(); await flush()
    expect(view.state.pronunciationReference).toBeNull()
    expect(view.refs.recover).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'attempt-1', referenceText: 'Good morning.' }), expect.any(AbortSignal))
    expect(view.app.events.some(e => e.type === 'PRONUNCIATION_EVALUATED')).toBe(true)
    expect(view.refs.assess).not.toHaveBeenCalled()
  })
  it('does not award independent chunk use when the guide supplied the expression', async () => {
    const view = mountPage('Speak', { successfulChunks: ['Can I help'] }); await flush(); view.state.mode = 'guided'
    view.app.chunks.push({ id: 'can-help', text: 'Can I help' })
    await view.state.start(); view.state.text = 'Can I help?'; view.state.sttText = view.state.text
    view.audios.set('guided-recording', { id: 'guided-recording', kind: 'recording', blob: new Blob(['fixture']), duration: 3 })
    await view.state.savedSpokenRecording({ audioId: 'guided-recording', duration: 3 }); await view.state.send(); await view.state.finish()
    expect(view.app.events.find(e => e.type === 'CHUNK_PRODUCTION')).toMatchObject({ prompted: true, data: { suppliedLanguage: true, novelContext: false } })
  })
  it('restores both persisted A/B attempt associations without a new assessment or audio upload', async () => {
    const view = mountPage('Speak'); await flush(); view.state.pronunciationReference = reference()
    const results: Extract<BrowserAssessmentResult, { ok: true }>[] = []
    for (const index of [1, 2]) {
      const input = { ...makeRequest(), recordingId: `recording-${index}`, attemptId: `attempt-${index}` }
      const result = await success(input); results.push(result)
      view.audios.set(input.recordingId, { id: input.recordingId, kind: 'recording', blob: new Blob(['original']), duration: 3, createdAt: 1000 })
      await view.state.pronunciation.recorded({ audioId: input.recordingId, duration: 3, referenceId: input.referenceId })
      await view.state.pronunciation.persistAttempt(input); await view.state.pronunciation.evaluated(result)
    }
    view.refs.recover.mockImplementation(async input => results.find(result => result.assessment.attemptId === input.attemptId) ?? null)
    await view.state.pronunciation.retry(); await flush()
    expect(view.refs.recover).toHaveBeenCalledTimes(2)
    expect(view.state.pronunciation.recoveredResults.value.map(result => result.assessment.recordingId)).toEqual(['recording-1', 'recording-2'])
    expect(view.refs.assess).not.toHaveBeenCalled()
  })
})

describe('authenticated pronunciation client', () => {
  it('preserves reference-audio HTTP 422 as a safe non-transient reference error', async () => {
    const cloud = connection()
    cloud.functions.invoke.mockResolvedValue({ data: null, error: new Error('PRIVATE SIGNED URL MUST NOT DISPLAY'),
      response: new Response(JSON.stringify({ ok: false, error: { code: 'REFERENCE', message: 'UNSAFE BACKEND DETAIL' } }), { status: 422, headers: { 'Content-Type': 'application/json' } }) })
    await expect(createSpeechBrowserClient(cloud).referenceAudio(reference())).rejects.toMatchObject({ code: 'REFERENCE', retryable: false,
      message: 'This reference is not currently approved. Your original recording remains saved.' })
  })
  it('recovers and normalizes saved evidence without uploading or converting audio', async () => {
    const cloud = connection(), result = await success()
    cloud.functions.invoke.mockResolvedValue({ data: result, error: null })
    expect(await createSpeechBrowserClient(cloud).recover({ attemptId: 'attempt-1', recordingId: 'recording-1', referenceId: 'greeting-v1', referenceText: 'Good morning.' })).toEqual(result)
    expect(cloud.functions.invoke.mock.calls[0][1].body).toEqual({ action: 'recover', attemptId: 'attempt-1', recordingId: 'recording-1', referenceId: 'greeting-v1' })
  })
  it('lists only strictly reviewed server references and honors cancellation', async () => {
    const cloud = connection(), ref = reference()
    const reviewed = { ...ref, materialId: null, audioSha256: 'a'.repeat(64), sourceUrl: 'https://example.invalid/source', rightsEvidence: 'TEST ONLY', reviewedAt: '2026-09-08T00:00:00Z', revokedAt: null }
    cloud.functions.invoke.mockResolvedValue({ data: { references: [reviewed] }, error: null })
    expect(await createSpeechBrowserClient(cloud).references()).toEqual([reviewed])
    expect(cloud.functions.invoke.mock.calls[0][1].body).toEqual({ action: 'references' })
    cloud.functions.invoke.mockResolvedValue({ data: { references: [{ ...reviewed, voiceReview: { ...reviewed.voiceReview, naturalStressAndRhythm: null } }] }, error: null })
    await expect(createSpeechBrowserClient(cloud).references()).rejects.toBeInstanceOf(SpeechError)
    const controller = new AbortController(); controller.abort()
    await expect(createSpeechBrowserClient(cloud).references(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  })
  it('preserves safe explicit new-service consent flags but never arbitrary messages', async () => {
    const cloud = connection()
    cloud.functions.invoke.mockResolvedValue({ data: { ok: false, error: { code: 'REQUEST_PENDING', message: 'private internal data' }, usage: [], retryAsNewAttempt: true }, error: null })
    const result = await createSpeechBrowserClient(cloud).assess(makeRequest())
    expect(result).toMatchObject({ ok: false, error: { code: 'REQUEST_PENDING' }, retryAsNewAttempt: true })
    expect(JSON.stringify(result)).not.toContain('private internal')
  })
  it('sends exactly four FormData fields with session JWT and no client reference policy', async () => {
    const cloud = connection(), request = makeRequest()
    cloud.functions.invoke.mockResolvedValue({ data: await success(request), error: null })
    const result = await createSpeechBrowserClient(cloud).assess(request)
    expect(result.ok).toBe(true)
    const [name, options] = cloud.functions.invoke.mock.calls[0]
    expect(name).toBe('speech-assess'); expect(options.method).toBe('POST')
    if (!(options.body instanceof FormData)) throw new Error('Expected acoustic FormData')
    expect([...options.body.keys()].sort()).toEqual(['attemptId', 'audioWav', 'recordingId', 'referenceId'])
    expect(options.body.get('referenceId')).toBe(request.referenceId)
    expect(options.body.get('audioWav')).toBeInstanceOf(Blob)
    expect(new Uint8Array(await (options.body.get('audioWav') as Blob).arrayBuffer())).toEqual(request.audioWav)
    expect(options.headers).toEqual({ Authorization: 'Bearer testheader.testpayload.testsignature' })
    expect(JSON.stringify(result)).not.toContain('testsignature')
  })
  it('returns no evidence when cloud is unconfigured or the learner is signed out', async () => {
    expect(await createSpeechBrowserClient(null).assess(makeRequest())).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } })
    const cloud = connection(); cloud.auth.getSession.mockResolvedValue({ data: { session: null }, error: null } as never)
    expect(await createSpeechBrowserClient(cloud).assess(makeRequest())).toMatchObject({ ok: false, error: { code: 'SIGN_IN_REQUIRED' } })
    expect(cloud.functions.invoke).not.toHaveBeenCalled()
  })
  it('rejects malformed IDs and WAV before session or upload', async () => {
    const cloud = connection()
    for (const patch of [{ referenceId: '../untrusted' }, { recordingId: '' }, { audioWav: new Uint8Array([1]) }]) expect((await createSpeechBrowserClient(cloud).assess({ ...makeRequest(), ...patch })).ok).toBe(false)
    expect(cloud.auth.getSession).not.toHaveBeenCalled(); expect(cloud.functions.invoke).not.toHaveBeenCalled()
  })
  it('requires server evidence ID and exact recording/reference correlation', async () => {
    for (const property of ['assessmentId', 'recordingId', 'referenceId', 'referenceSha256']) {
      const cloud = connection(), response = await success()
      if (property === 'assessmentId') response.assessmentId = ''
      else Object.assign(response.assessment, { [property]: 'other' })
      cloud.functions.invoke.mockResolvedValue({ data: response, error: null })
      expect(await createSpeechBrowserClient(cloud).assess(makeRequest())).toMatchObject({ ok: false, error: { code: 'MALFORMED_RESPONSE' } })
    }
  })
  it('rebuilds displayed issues from provider evidence and rejects credential-bearing responses', async () => {
    const cloud = connection(), response = await success()
    response.assessment.issues = [{ kind: 'phoneme', wordIndex: 0, cue: 'Invented LLM sound claim', provenance: { provider: 'azure-speech', path: 'made-up', value: 10 } }]
    cloud.functions.invoke.mockResolvedValue({ data: response, error: null })
    const result = await createSpeechBrowserClient(cloud).assess(makeRequest())
    expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain('Invented LLM')
    cloud.functions.invoke.mockResolvedValue({ data: { ...response, apiKey: 'must-not-escape' }, error: null })
    expect(await createSpeechBrowserClient(cloud).assess(makeRequest())).toMatchObject({ ok: false, error: { code: 'MALFORMED_RESPONSE' } })
  })
  it('sanitizes function failures and retains server usage on non-2xx', async () => {
    const cloud = connection(), usage = (await success()).usage
    cloud.functions.invoke.mockResolvedValue({ data: null, error: new Error('private provider response'), response: new Response(JSON.stringify({ ok: false, error: { code: 'RATE_LIMIT', message: 'private credentials' }, usage }), { status: 429, headers: { 'content-type': 'application/json' } }) })
    const result = await createSpeechBrowserClient(cloud).assess(makeRequest())
    expect(result).toMatchObject({ ok: false, error: { code: 'RATE_LIMIT' }, usage })
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it('cancels session lookup without a later upload, and cancels in-flight requests', async () => {
    const cloud = connection(), auth = deferred<Awaited<ReturnType<SpeechCloudConnection['auth']['getSession']>>>()
    cloud.auth.getSession.mockReturnValue(auth.promise as never)
    const abort = new AbortController(), pending = createSpeechBrowserClient(cloud).assess(makeRequest(), abort.signal)
    abort.abort(); expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    auth.resolve({ data: { session: { user: { id: 'owner-a' }, access_token: 'header.payload.signature' } }, error: null }); await Promise.resolve()
    expect(cloud.functions.invoke).not.toHaveBeenCalled()
    const next = connection(); next.functions.invoke.mockImplementation(() => new Promise(() => {}))
    const nextAbort = new AbortController(), active = createSpeechBrowserClient(next).assess(makeRequest(), nextAbort.signal)
    await vi.waitFor(() => expect(next.functions.invoke).toHaveBeenCalledOnce()); nextAbort.abort()
    expect(await active).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    expect(next.functions.invoke.mock.calls[0][1].signal.aborted).toBe(true)
  })
  it('requires explicit reviewed voice facts and safe audio before practice', () => {
    expect(pronunciationReferenceReady(reference())).toBe(true)
    expect(pronunciationReferenceReady({ ...reference(), voiceReview: null })).toBe(false)
    expect(pronunciationReferenceReady({ ...reference(), audioUrl: 'javascript:alert(1)' })).toBe(false)
    expect(pronunciationReferenceReady({ ...reference(), voiceReview: { ...reference().voiceReview!, generalAmericanReviewed: null } })).toBe(false)
  })
  it('times out a stalled session without allowing a later upload', async () => {
    vi.useFakeTimers()
    const cloud = connection(), auth = deferred<Awaited<ReturnType<SpeechCloudConnection['auth']['getSession']>>>()
    cloud.auth.getSession.mockReturnValue(auth.promise as never)
    const pending = createSpeechBrowserClient(cloud).assess(makeRequest())
    await vi.advanceTimersByTimeAsync(SPEECH_CLIENT_TIMEOUT_MS)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
    auth.resolve({ data: { session: { user: { id: 'owner-a' }, access_token: 'header.payload.signature' } }, error: null }); await Promise.resolve()
    expect(cloud.functions.invoke).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it('correlates against its request snapshot even if the caller later mutates its input', async () => {
    const cloud = connection(), request = makeRequest(), response = await success(request)
    const network = deferred<Awaited<ReturnType<SpeechCloudConnection['functions']['invoke']>>>()
    cloud.functions.invoke.mockReturnValue(network.promise)
    const pending = createSpeechBrowserClient(cloud).assess(request)
    await vi.waitFor(() => expect(cloud.functions.invoke).toHaveBeenCalledOnce())
    request.recordingId = 'different'; request.referenceText = 'Changed text.'
    network.resolve({ data: response, error: null })
    expect(await pending).toMatchObject({ ok: true, assessment: { recordingId: 'recording-1' } })
  })
})

// Real compiled parent SFC/lifecycle, using the same custom Vue renderer strategy as audio-components.
class HostDocument { activeElement = null }
class HostNode extends EventTarget {
  parent: HostNode | null = null
  children: HostNode[] = []
  props: Record<string, unknown> = {}
  text = ''
  constructor(readonly type: string) { super() }
  getRootNode() { return new HostDocument() }
  querySelector(selector: string): HostNode | null { return find(this, node => node !== this && node.type === selector) ?? null }
}
const renderer = Vue.createRenderer<HostNode, HostNode>({
  createElement: type => new HostNode(type), createText: text => Object.assign(new HostNode('#text'), { text }), createComment: () => new HostNode('#comment'),
  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] }, patchProp: (node, key, _old, value) => { node.props[key] = value },
  insert: (node, parent, anchor = null) => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; if (i < 0) parent.children.push(node); else parent.children.splice(i, 0, node) },
  remove: node => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
})
function content(node: HostNode): string { return node.text + node.children.map(content).join('') }
function find(node: HostNode, predicate: (n: HostNode) => boolean): HostNode | undefined { if (predicate(node)) return node; for (const child of node.children) { const found = find(child, predicate); if (found) return found } }
function button(root: HostNode, text: string): HostNode { const node = find(root, n => n.type === 'button' && content(n).includes(text)); if (!node) throw new Error('Missing button ' + text + ': ' + content(root)); return node }
function click(node: HostNode) { if (node.props.disabled) throw new Error('Cannot click disabled button'); return (node.props.onClick as () => unknown)() }
async function flush() { for (let i = 0; i < 4; i++) { await yieldImmediate(); await Vue.nextTick() } }
const db = { audio: { get: vi.fn() } }
const converter = vi.fn()
const browser = { configured: true, assess: vi.fn(), session: vi.fn(sessionFixture), referenceAudio: vi.fn() }
let recorderEmit: (event: 'recorded' | 'active', value: unknown) => void
let Component: Vue.Component
let ComponentWithSavedRecording: Vue.Component
const savedAudio = Vue.shallowReactive<{ id: string; blob: Blob; mimeType: string; createdAt: number }[]>([])
const mounted: Vue.App[] = []
function mount(initial: Record<string, unknown> = {}, savedPropFirst = false, realSavedRecording = false) {
  const props = Vue.reactive<Record<string, unknown>>({ reference: reference(), savedReferenceId: reference().id, ...initial }), root = new HostNode('root')
  const recorded = vi.fn(), pending = vi.fn(), evaluated = vi.fn(), active = vi.fn()
  const app = renderer.createApp({ setup: () => () => Vue.h(realSavedRecording ? ComponentWithSavedRecording : Component, { ...(savedPropFirst ? { savedAudioId: props.savedAudioId, ...props } : props), onRecorded: recorded, onPending: pending, onEvaluated: evaluated, onActive: active }) })
  app.mount(root); mounted.push(app)
  return { props, root, recorded, pending, evaluated, active, unmount: () => { app.unmount(); mounted.splice(mounted.indexOf(app), 1) } }
}
beforeAll(() => {
  const filename = fileURLToPath(new URL('../src/components/PronunciationPractice.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'pronunciation-test', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const code = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const dependencies: Record<string, unknown> = {
    vue: Vue, '../db/db': { db }, '../speech/client': { pronunciationReferenceReady, speechBrowserClient: browser }, '../speech/feedback': { compareAcousticAttempts }, '../speech/wav': { recordingToAssessmentWav: converter }, '../speech/types': { SpeechError },
    './Recorder.vue': { default: Vue.defineComponent({ props: ['disabled', 'savedAudioId', 'label'], emits: ['recorded', 'active'], setup: (props, { emit }) => { recorderEmit = emit; return () => Vue.h('div', { 'data-recorder': true, 'data-disabled': props.disabled }, 'Recorder') } }) },
    './SavedRecording.vue': { default: Vue.defineComponent({ props: ['audioId', 'label'], setup: props => () => Vue.h('audio', { 'data-recording': props.audioId, 'aria-label': props.label }) }) },
  }
  const exports: { default?: Vue.Component } = {}
  new Function('require', 'exports', code)((id: string) => { if (!(id in dependencies)) throw new Error('Unmapped ' + id); return dependencies[id] }, exports)
  Component = exports.default!
  const savedFilename = fileURLToPath(new URL('../src/components/SavedRecording.vue', import.meta.url))
  const savedDescriptor = parse(readFileSync(savedFilename, 'utf8'), { filename: savedFilename }).descriptor
  const savedScript = compileScript(savedDescriptor, { id: 'saved-recording-test', inlineTemplate: true })
  const actualSaved = compileInMemory(savedScript.content, { vue: Vue, '../stores/app': { useApp: () => ({ audio: savedAudio }) }, '../composables/useRecordingUrl': { useRecordingUrl } })
  ComponentWithSavedRecording = compileInMemory(script.content, { ...dependencies, './SavedRecording.vue': actualSaved }).default as Vue.Component
})
beforeEach(() => {
  db.audio.get.mockReset().mockImplementation(async (id: string) => ({ id, kind: 'recording', blob: new Blob(['original recording'], { type: 'audio/webm' }) }))
  converter.mockReset().mockResolvedValue(makeWav())
  browser.configured = true; browser.assess.mockReset().mockImplementation(async (input: SpeechClientRequest) => success(input))
  browser.session.mockReset().mockImplementation(sessionFixture)
  browser.referenceAudio.mockReset().mockResolvedValue(new Blob([makeWav()], { type: 'audio/wav' }))
  savedAudio.splice(0, savedAudio.length, ...['recording-1', 'recording-2'].map(id => ({ id, blob: new Blob([makeWav()], { type: 'audio/wav' }), mimeType: 'audio/wav', createdAt: 1 })))
})
afterEach(() => { for (const app of mounted.splice(0)) app.unmount(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('PronunciationPractice compiled component', () => {
  it('shows and recovers from an initial identity timeout without unlocking a later account change', async () => {
    let timedOut = true
    browser.session.mockImplementation(() => ({ ...sessionFixture(), assertCurrent: vi.fn(async () => {
      if (timedOut) throw new SpeechError('TIMEOUT')
      return { user: { id: 'owner-a' }, access_token: 'inert' }
    }) }))
    const view = mount({ savedAudioId: 'recording-2' }); await flush()
    expect(content(view.root)).toContain('could not be verified or loaded')
    expect(content(view.root)).not.toContain('account changed')
    expect(button(view.root, 'Retry reviewed audio').props.disabled).toBe(false)
    expect(find(view.root, node => node.props['aria-label'] === 'Reviewed reference recording')).toBeUndefined()
    timedOut = false; click(button(view.root, 'Retry reviewed audio')); await flush()
    expect(find(view.root, node => node.props['aria-label'] === 'Reviewed reference recording')?.props.src).toMatch(/^blob:/)
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(false)
    browser.session.mock.results[0].value.dispose(); await flush()
    expect(content(view.root)).toContain('account changed')
    expect(find(view.root, node => node.type === 'button' && content(node).includes('Retry reviewed audio'))).toBeUndefined()
  })
  it('identifies an unavailable reviewed reference without hiding same-owner saved history or showing backend text', async () => {
    browser.referenceAudio.mockRejectedValueOnce(new SpeechError('REFERENCE'))
    const view = mount({ savedAudioId: 'recording-2', recoveredResults: [await success(), await success({ ...makeRequest(), attemptId: 'attempt-2', recordingId: 'recording-2' })] }); await flush()
    expect(content(view.root)).toContain('not currently approved')
    expect(content(view.root)).toContain('Listen A/B')
    expect(find(view.root, node => node.props['aria-label'] === 'Reviewed reference recording')).toBeUndefined()
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(true)
  })
  it('removes actual historical audio/downloads permanently after account invalidation, not on same-owner revocation', async () => {
    const first = await success(), second = await success({ ...makeRequest(), attemptId: 'attempt-2', recordingId: 'recording-2' })
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const view = mount({ savedAudioId: 'recording-2', recoveredResults: [first, second] }, false, true); await flush()
    view.props.reference = null; await flush()
    expect(content(view.root)).toContain('Listen A/B')
    const download = find(view.root, node => node.type === 'a' && !!node.props.download)!
    expect(download.props.href).toMatch(/^blob:/)
    const original = savedAudio[1]!.blob
    expect(await (await fetch(String(download.props.href))).blob()).toHaveProperty('size', original.size)
    for (const gate of browser.session.mock.results) gate.value.dispose()
    view.props.savedAudioId = ''; view.props.savedReferenceId = ''; view.props.recoveredResults = []; await flush()
    expect(find(view.root, node => node.type === 'a' && !!node.props.download)).toBeUndefined()
    expect(find(view.root, node => node.type === 'audio')).toBeUndefined()
    expect(revoke).toHaveBeenCalledWith(download.props.href)
    await expect(fetch(String(download.props.href))).rejects.toThrow()
    // Late props or A→B→A cannot reattach A's bytes to the invalidated component.
    view.props.reference = reference(); view.props.savedAudioId = 'recording-2'; view.props.savedReferenceId = reference().id
    view.props.recoveredResults = [first, second]; await flush()
    expect(find(view.root, node => node.type === 'a' && !!node.props.download)).toBeUndefined()
    expect(find(view.root, node => node.type === 'audio')).toBeUndefined()
    expect(savedAudio[1]!.blob).toBe(original)
    expect(savedAudio[1]!.blob.size).toBeGreaterThan(0)
    revoke.mockRestore()
  })
  it('does not mount private history while initial owner/journal binding is unresolved or rejected', async () => {
    const binding = deferred<Awaited<ReturnType<ReturnType<typeof sessionFixture>['assertCurrent']>>>()
    browser.session.mockImplementation(() => ({ ...sessionFixture(), assertCurrent: vi.fn(() => binding.promise) }))
    const view = mount({ reference: null, savedAudioId: 'recording-2', savedReferenceId: 'old-reference' }, false, true)
    await flush()
    expect(content(view.root)).toContain('Checking access to your saved practice')
    expect(find(view.root, node => node.type === 'a' && !!node.props.download)).toBeUndefined()
    expect(find(view.root, node => node.type === 'audio')).toBeUndefined()
    for (const gate of browser.session.mock.results) gate.value.dispose()
    binding.resolve({ user: { id: 'owner-a' }, access_token: 'inert' }); await flush()
    expect(find(view.root, node => node.type === 'a' && !!node.props.download)).toBeUndefined()
  })
  it('retains saved historical A/B when reviewed audio fails or the current reference is revoked', async () => {
    const first = await success(), second = await success({ ...makeRequest(), attemptId: 'attempt-2', recordingId: 'recording-2' })
    browser.referenceAudio.mockRejectedValueOnce(new SpeechError('MALFORMED_RESPONSE'))
    const view = mount({ savedAudioId: 'recording-2', recoveredResults: [first, second] }); await flush()
    expect(content(view.root)).toContain('Listen A/B'); expect(content(view.root)).toContain('could not be verified')
    expect(find(view.root, node => node.props['aria-label'] === 'Reviewed reference recording')).toBeUndefined()
    expect(find(view.root, node => node.props['data-recording'] === 'recording-2')).toBeDefined()
    view.props.reference = null; await flush()
    expect(content(view.root)).toContain('Listen A/B'); expect(view.evaluated).not.toHaveBeenCalled()
  })
  it('aborts stale reviewed audio and revokes only the current owned Blob on teardown', async () => {
    const first = deferred<Blob>(), second = deferred<Blob>(), revoke = vi.spyOn(URL, 'revokeObjectURL')
    browser.referenceAudio.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = mount(); await flush()
    expect(content(view.root)).toContain('Loading and verifying')
    view.props.reference = { ...reference(), id: 'replacement' }; await flush()
    expect(browser.referenceAudio.mock.calls[0][1].aborted).toBe(true)
    first.resolve(new Blob(['old bytes'])); await flush()
    expect(find(view.root, node => node.props['aria-label'] === 'Reviewed reference recording')).toBeUndefined()
    second.resolve(new Blob(['verified new bytes'])); await flush()
    const url = find(view.root, node => node.props['aria-label'] === 'Reviewed reference recording')!.props.src
    expect(url).toMatch(/^blob:/); view.unmount(); expect(revoke).toHaveBeenCalledWith(url)
    revoke.mockRestore()
  })
  it('blocks a late evaluated emission after the UI identity fence is invalidated', async () => {
    const response = deferred<BrowserAssessmentResult>(); browser.assess.mockReturnValueOnce(response.promise)
    const view = mount({ savedAudioId: 'recording-1' }); await flush()
    const analyzing = click(button(view.root, 'Analyze recording')); await flush()
    browser.session.mock.results[0].value.dispose(); await flush()
    response.resolve(await success()); await analyzing; await flush()
    expect(view.evaluated).not.toHaveBeenCalled()
    expect(find(view.root, node => node.props['aria-label'] === 'Reviewed reference recording')).toBeUndefined()
    expect(content(view.root)).toContain('account changed')
    expect(view.props.savedAudioId).toBe('recording-1')
  })
  it('never puts an unverified remote reference URL into the media element', async () => {
    const view = mount(); await flush()
    const media = find(view.root, node => node.props['aria-label'] === 'Reviewed reference recording')
    expect(media?.props.src).toMatch(/^blob:/)
  })
  it('keeps revoked-reference historical A/B visible when a replacement reference is available', async () => {
    const first = await success(), second = await success({ ...makeRequest(), attemptId: 'attempt-2', recordingId: 'recording-2' })
    const view = mount({ reference: { ...reference(), id: 'replacement-v2', text: 'A new reference.' }, savedAudioId: 'recording-2', savedReferenceId: 'greeting-v1', recoveredResults: [first, second] }); await flush()
    expect(content(view.root)).toContain('Listen A/B')
    expect(content(view.root)).toContain('Historical feedback for reference greeting-v1')
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(true)
    expect(browser.assess).not.toHaveBeenCalled()
  })
  it('restores A/B from two recovered server results, including revoked-reference historical playback', async () => {
    const first = await success(), second = await success({ ...makeRequest(), attemptId: 'attempt-2', recordingId: 'recording-2' })
    const view = mount({ reference: null, savedAudioId: 'recording-2', savedReferenceId: 'greeting-v1', recoveredResults: [first, second] }); await flush()
    expect(content(view.root)).toContain('Listen A/B')
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(true)
    expect(find(view.root, n => n.props['data-recording'] === 'recording-1')).toBeDefined()
    expect(find(view.root, n => n.props['data-recording'] === 'recording-2')).toBeDefined()
    expect(browser.assess).not.toHaveBeenCalled()
  })
  it('awaits durable pending-attempt persistence and never uploads after save failure', async () => {
    const saving = deferred<void>(), persistAttempt = vi.fn(() => saving.promise)
    const view = mount({ persistAttempt, savedAudioId: 'recording-1' }); await flush()
    const operation = click(button(view.root, 'Analyze recording')); await flush()
    expect(persistAttempt).toHaveBeenCalledOnce(); expect(browser.assess).not.toHaveBeenCalled()
    saving.resolve(); await operation; await flush(); expect(browser.assess).toHaveBeenCalledOnce()
    view.unmount(); browser.assess.mockClear()
    const next = mount({ savedAudioId: 'recording-1', persistAttempt: async () => { throw new Error('database failed') } }); await flush()
    await click(button(next.root, 'Analyze recording')); await flush()
    expect(browser.assess).not.toHaveBeenCalled(); expect(content(next.root)).toContain('original remains available')
  })
  it('uses a new dispatch ID only after explicit new-service-attempt action', async () => {
    const view = mount({ savedAudioId: 'recording-1' }); await flush()
    browser.assess.mockResolvedValueOnce({ ok: false, error: { code: 'UNAVAILABLE', message: 'Temporary issue.' }, usage: [], retryAsNewAttempt: true })
    await click(button(view.root, 'Analyze recording')); await flush()
    const first = browser.assess.mock.calls[0][0].attemptId
    expect(browser.assess).toHaveBeenCalledOnce()
    click(button(view.root, 'New service attempt')); await flush()
    expect(browser.assess).toHaveBeenCalledTimes(2); expect(browser.assess.mock.calls[1][0].attemptId).not.toBe(first)
  })
  it('does not allow unknown reference quality to play audio or earn acoustic evidence', async () => {
    const view = mount({ reference: { ...reference(), voiceReview: null }, savedAudioId: 'recording-1' })
    expect(content(view.root)).toContain('reviewed General American reference')
    expect(find(view.root, n => n.type === 'audio')).toBeUndefined()
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(true)
    expect(browser.assess).not.toHaveBeenCalled()
  })
  it('waits for saved event, reads persisted original, then converts and emits server evidence', async () => {
    const view = mount(); await flush()
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(true)
    recorderEmit('recorded', { audioId: 'recording-1', duration: 3 }); await flush()
    expect(view.recorded).toHaveBeenCalledWith({ audioId: 'recording-1', duration: 3, referenceId: 'greeting-v1' })
    await click(button(view.root, 'Analyze recording')); await flush()
    expect(db.audio.get).toHaveBeenCalledWith('recording-1')
    expect(db.audio.get.mock.invocationCallOrder[0]).toBeLessThan(converter.mock.invocationCallOrder[0])
    expect(converter.mock.invocationCallOrder[0]).toBeLessThan(browser.assess.mock.invocationCallOrder[0])
    expect(view.pending).toHaveBeenCalledOnce(); expect(view.evaluated).toHaveBeenCalledOnce()
    expect(view.evaluated.mock.calls[0][0].assessmentId).toMatch(/^evidence-/)
    expect(content(view.root)).toContain('Prosody was not assessed')
    expect(view.active.mock.calls.map(([active]) => active)).toContain(true)
    expect(view.active).toHaveBeenLastCalledWith(false)
  })
  it('refuses conversion when the saved event has no persisted original Blob', async () => {
    db.audio.get.mockResolvedValue(undefined)
    const view = mount({ savedAudioId: 'recording-1' }); await flush()
    await click(button(view.root, 'Analyze recording')); await flush()
    expect(content(view.root)).toContain('not saved on this device yet')
    expect(converter).not.toHaveBeenCalled(); expect(browser.assess).not.toHaveBeenCalled(); expect(view.evaluated).not.toHaveBeenCalled()
  })
  it('retains the original when conversion fails and permits explicit retry', async () => {
    converter.mockRejectedValueOnce(new SpeechError('INVALID_AUDIO'))
    const view = mount({ savedAudioId: 'recording-1' }); await flush()
    await click(button(view.root, 'Analyze recording')); await flush()
    expect(browser.assess).not.toHaveBeenCalled()
    await click(button(view.root, 'Retry saved recording')); await flush()
    expect(view.evaluated).toHaveBeenCalledOnce()
    expect(db.audio.get).toHaveBeenCalledTimes(2)
  })
  it('retains and reuses the same attempt ID after recoverable service failure', async () => {
    browser.assess.mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK', message: 'Retry the saved recording.' }, usage: [] })
    const view = mount({ savedAudioId: 'recording-1', pendingAttempt: { attemptId: 'restored-attempt', recordingId: 'recording-1', referenceId: reference().id } }); await flush()
    await click(button(view.root, 'Analyze recording')); await flush()
    expect(view.evaluated).not.toHaveBeenCalled()
    await click(button(view.root, 'Retry saved recording')); await flush()
    expect(browser.assess.mock.calls.map(([input]) => input.attemptId)).toEqual(['restored-attempt', 'restored-attempt'])
    expect(view.evaluated).toHaveBeenCalledOnce()
  })
  it('cancels without accepting a late success', async () => {
    const result = deferred<BrowserAssessmentResult>(); browser.assess.mockReturnValue(result.promise)
    const view = mount({ savedAudioId: 'recording-1' }); await flush()
    const analyzing = click(button(view.root, 'Analyze recording')); await flush()
    click(button(view.root, 'Cancel assessment')); await flush()
    expect(browser.assess.mock.calls[0][1].aborted).toBe(true)
    result.resolve(await success(browser.assess.mock.calls[0][0])); await analyzing; await flush()
    expect(view.evaluated).not.toHaveBeenCalled()
    expect(content(view.root)).toContain('original recording is still saved')
  })
  it('blocks simultaneous capture and assessment and cancels when disabled', async () => {
    const view = mount({ savedAudioId: 'recording-1' }); await flush()
    recorderEmit('active', true); await flush(); expect(button(view.root, 'Analyze recording').props.disabled).toBe(true)
    recorderEmit('active', false); await flush()
    const result = deferred<BrowserAssessmentResult>(); browser.assess.mockReturnValue(result.promise)
    const analyzing = click(button(view.root, 'Analyze recording')); await flush()
    view.props.disabled = true; await flush()
    result.resolve(await success(browser.assess.mock.calls[0][0])); await analyzing
    expect(view.evaluated).not.toHaveBeenCalled(); expect(view.active).toHaveBeenLastCalledWith(false)
  })
  it('detaches old audio and late results when the trusted reference changes', async () => {
    const result = deferred<BrowserAssessmentResult>(); browser.assess.mockReturnValue(result.promise)
    const view = mount({ savedAudioId: 'recording-1' }); await flush()
    const analyzing = click(button(view.root, 'Analyze recording')); await flush()
    view.props.reference = { ...reference(), id: 'another-reference', text: 'Hello.' }; await flush()
    result.resolve(await success(browser.assess.mock.calls[0][0])); await analyzing; await flush()
    expect(view.evaluated).not.toHaveBeenCalled()
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(true)
    expect(find(view.root, n => n.props['data-recording'] === 'recording-1')).toBeDefined()
  })
  it('rejects a late saved ID from a previous reference, including a misleading new reference prop', async () => {
    const view = mount(); await flush()
    recorderEmit('recorded', { audioId: 'recording-A', duration: 3 }); await flush()
    view.props.reference = { ...reference(), id: 'reference-B', text: 'Hello.' }; await flush()
    view.props.savedAudioId = 'recording-A'; view.props.savedReferenceId = 'reference-B'; await flush()
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(true)
    expect(browser.assess).not.toHaveBeenCalled()
    expect(find(view.root, n => n.props['data-recording'] === 'recording-A')).toBeDefined()
  })
  it.each([false, true])('atomically restores a new reference/recording pair regardless of prop order (%s)', async savedPropFirst => {
    const view = mount({ savedAudioId: 'recording-A' }, savedPropFirst)
    view.props.savedAudioId = 'recording-B'; view.props.savedReferenceId = 'reference-B'
    view.props.reference = { ...reference(), id: 'reference-B', text: 'Hello.' }; await flush()
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(false)
    await click(button(view.root, 'Analyze recording')); await flush()
    expect(browser.assess.mock.calls[0][0]).toMatchObject({ recordingId: 'recording-B', referenceId: 'reference-B' })
  })
  it('finishes the valid current assessment when an unrelated old recording prop is rejected', async () => {
    const view = mount(); await flush()
    recorderEmit('recorded', { audioId: 'recording-A', duration: 3 }); await flush()
    view.props.savedAudioId = 'recording-B'; view.props.savedReferenceId = 'reference-B'
    view.props.reference = { ...reference(), id: 'reference-B', text: 'Hello.' }; await flush()
    const result = deferred<BrowserAssessmentResult>(); browser.assess.mockReturnValue(result.promise)
    const analyzing = click(button(view.root, 'Analyze recording')); await flush()
    view.props.savedAudioId = 'recording-A'; await flush()
    result.resolve(await success(browser.assess.mock.calls[0][0])); await analyzing; await flush()
    expect(view.evaluated).toHaveBeenCalledOnce()
    expect(view.evaluated.mock.calls[0][0].assessment).toMatchObject({ recordingId: 'recording-B', referenceId: 'reference-B' })
    expect(view.active).toHaveBeenLastCalledWith(false)
    expect(content(view.root)).not.toContain('Analyzing…')
  })
  it('keeps a restored recording available but unassessed without its reference association', async () => {
    const view = mount({ savedAudioId: 'recording-A', savedReferenceId: undefined }); await flush()
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(true)
    expect(find(view.root, n => n.props['data-recording'] === 'recording-A')).toBeDefined()
    expect(browser.assess).not.toHaveBeenCalled()
  })
  it('reacts to an association restored by updating the pendingAttempt fields in place', async () => {
    const view = mount({ savedAudioId: 'recording-A', savedReferenceId: undefined, pendingAttempt: { attemptId: 'recovered-attempt', recordingId: 'recording-A', referenceId: 'unresolved' } })
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(true)
    ;(view.props.pendingAttempt as { referenceId: string }).referenceId = reference().id
    await flush()
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(false)
    await click(button(view.root, 'Analyze recording')); await flush()
    expect(browser.assess.mock.calls[0][0]).toMatchObject({ attemptId: 'recovered-attempt', recordingId: 'recording-A', referenceId: reference().id })
  })
  it('renders bounded issues and two distinct saved recordings for A/B comparison', async () => {
    const view = mount({ savedAudioId: 'recording-1' }); await flush()
    await click(button(view.root, 'Analyze recording')); await flush()
    recorderEmit('recorded', { audioId: 'recording-2', duration: 3 }); await flush()
    await click(button(view.root, 'Analyze recording')); await flush()
    expect(content(view.root)).toContain('Listen A/B')
    expect(find(view.root, n => n.props['data-recording'] === 'recording-1')).toBeDefined()
    expect(find(view.root, n => n.props['data-recording'] === 'recording-2')).toBeDefined()
    expect(view.evaluated).toHaveBeenCalledTimes(2)
    expect(view.evaluated.mock.calls[1][0].assessment.issues.length).toBeLessThanOrEqual(3)
  })
  it('unmounts safely while decoding without starting a later upload', async () => {
    const decoding = deferred<Uint8Array>(); converter.mockReturnValue(decoding.promise)
    const view = mount({ savedAudioId: 'recording-1' }); await flush()
    const analyzing = click(button(view.root, 'Analyze recording')); await flush(); view.unmount()
    decoding.resolve(makeWav()); await analyzing
    expect(browser.assess).not.toHaveBeenCalled(); expect(view.evaluated).not.toHaveBeenCalled()
  })
  it('does not call conversion or assessment when cloud configuration is absent', async () => {
    browser.configured = false
    const view = mount({ savedAudioId: 'recording-1' }); await flush()
    expect(button(view.root, 'Analyze recording').props.disabled).toBe(true)
    expect(browser.referenceAudio).not.toHaveBeenCalled()
    expect(converter).not.toHaveBeenCalled(); expect(view.evaluated).not.toHaveBeenCalled()
  })
})
