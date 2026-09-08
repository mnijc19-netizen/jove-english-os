import { readFileSync } from 'node:fs'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import * as Vue from 'vue'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as longitudinal from '../src/domain/longitudinal'
import { aggregateSkills } from '../src/domain/engine'
import { useRequest } from '../src/composables/useRequest'
import { defaultSettings, type AudioAsset, type Evaluation, type Material, type StudyEvent, type StudySession } from '../src/domain/types'
import { chromium, type Page } from '@playwright/test'
import { createEmptyCard } from 'ts-fsrs'
import { OpenRouterProvider } from '../src/ai/provider'
import { aiRequestSchema } from '../src/server/ai'

// Render the actual compiled component with Vue lifecycle and event handlers.
// Browser acceptance below separately exercises the real IndexedDB/router/DOM.
class HostNode extends EventTarget {
  parent: HostNode | null = null; children: HostNode[] = []; props: Record<string, unknown> = {}; text = ''; value = ''; tagName: string
  constructor(readonly type: string) { super(); this.tagName = type.toUpperCase() }
  getAttribute(key: string) { return this.props[key] }
  getRootNode() { return document }
}
const renderer = Vue.createRenderer<HostNode, HostNode>({
  createElement: type => new HostNode(type), createText: text => Object.assign(new HostNode('#text'), { text }),
  createComment: text => Object.assign(new HostNode('#comment'), { text }), setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text; node.children = [] }, patchProp: (node, key, _old, value) => { node.props[key] = value },
  insert: (node, parent, anchor = null) => { node.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; if (i < 0) parent.children.push(node); else parent.children.splice(i, 0, node) },
  remove: node => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
})
const content = (node: HostNode): string => node.text + node.children.map(content).join('')
function find(node: HostNode, match: (n: HostNode) => boolean): HostNode | undefined {
  if (match(node)) return node
  for (const child of node.children) { const result = find(child, match); if (result) return result }
}
function button(root: HostNode, label: string) {
  const node = find(root, n => n.type === 'button' && (content(n).includes(label) || n.props['aria-label'] === label))
  if (!node) throw new Error(`Missing button ${label}: ${content(root)}`)
  return node
}
async function invoke(node: HostNode, action = 'onClick', value?: unknown) {
  if (typeof node.props[action] === 'function') await node.props[action](value)
  await flush()
}
async function flush() { for (let i = 0; i < 5; i++) { await yieldImmediate(); await Vue.nextTick() } }
const text = 'People share stories because they want to understand one another. A good friend listens carefully and asks a kind question. We can learn from ordinary moments and small surprises. Try to explain your idea using familiar words and a useful detail. Then ask your friend what they think about it.'
const material: Material = { id: 'reader', title: 'A story to share', topic: 'Everyday life', difficulty: 0.25, duration: 60, transcript: text,
  sentences: text.match(/[^.!?]+[.!?]*/g)!, sourceKind: 'curated', sourceLabel: 'Original fixture', synthetic: false, approved: true,
  question: 'What helps people understand?', answer: 'Sharing and listening', keywords: [], chunks: [], createdAt: Date.parse('2026-01-01T00:00:00Z') }
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
let rows: Map<string, StudySession>, audios: Map<string, AudioAsset>, state: ReturnType<typeof makeState>, Reading: Vue.Component
const guards: (() => Promise<boolean>)[] = [], mounted: Vue.App[] = []
const db = { sessions: { put: vi.fn(), get: vi.fn() }, audio: { get: vi.fn() } }
const router = { push: vi.fn() }
function makeState() {
  const events = Vue.reactive<StudyEvent[]>([])
  return Vue.reactive({ clock: Date.parse('2026-09-08T12:00:00Z'), profile: { id: 'main', name: 'Reader', goal: 'Speaking', interests: ['Everyday life'],
    dailyMinutes: 45, fatigue: 0, onboarded: true, createdAt: 0 }, settings: { ...defaultSettings, strongModel: 'fixture-evaluator' },
    events, materials: [material], chunks: [] as { text: string; meaningEn: string }[], keySet: false, online: false, beginTask: vi.fn(async () => {}),
    evidence: vi.fn(async (e: Omit<StudyEvent, 'timestamp'> & { timestamp?: number }): Promise<void> => {
      if (e.sessionId && !rows.has(e.sessionId)) throw new Error('Missing persisted session')
      if (!events.some(old => old.id === e.id)) events.push(copy({ ...e, timestamp: e.timestamp ?? Date.now() }))
    }), completeTask: vi.fn(async (kind: string, identity: { taskId?: string; materialId?: string }): Promise<void> => {
      events.push({ id: `completed:${identity.taskId}`, type: 'TASK_COMPLETED', source: 'objective', timestamp: Date.now(),
        data: { kind, ...identity } })
    }),
    provider: { lookup: vi.fn(async () => ({ text: 'People', meaningEn: 'Human beings.', meaningZh: '', example: 'People share stories.' })),
      evaluate: vi.fn<(...args: Parameters<OpenRouterProvider['evaluate']>) => Promise<Pick<Evaluation, 'summary' | 'comprehension' | 'provenance'>>>()
        .mockResolvedValue({ summary: 'Your main idea is clear.', comprehension: 0.8, provenance: { provider: 'fixture', model: 'actual-fixture-evaluator' } }) },
  })
}
function loadComponent() {
  const filename = 'ReadingPractice.vue', source = readFileSync(new URL('../src/components/' + filename, import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: filename, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const code = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const modules: Record<string, unknown> = {
    vue: Vue, 'vue-router': { useRouter: () => router, onBeforeRouteLeave: (guard: () => Promise<boolean>) => guards.push(guard), onBeforeRouteUpdate: (guard: () => Promise<boolean>) => guards.push(guard) },
    '../stores/app': { useApp: () => state }, '../db/db': { db }, '../composables/useRequest': { useRequest }, '../domain/longitudinal': longitudinal,
    './Recorder.vue': { default: Vue.defineComponent({ emits: ['recorded', 'active'], setup: (_props, { emit }) => () => Vue.h('button', {
      onClick: () => emit('recorded', { audioId: 'retell-audio', duration: 4 }),
    }, 'Record test retell') }) },
  }
  const exports: { default?: Vue.Component } = {}
  new Function('require', 'exports', code)((id: string) => { if (!(id in modules)) throw new Error(`Unknown test import ${id}`); return modules[id] }, exports)
  return exports.default!
}
function mount(props: { material?: Material; taskId?: string; assessmentId?: string; segmentWords?: number; onSaved?: (value: longitudinal.ReadingSavedEvidence) => void } = {}) {
  const root = new HostNode('root'), app = renderer.createApp(Reading, { material, taskId: 'today:reading', ...props })
  app.mount(root); mounted.push(app)
  return { root, unmount: () => { app.unmount(); mounted.splice(mounted.indexOf(app), 1) } }
}
async function advance(ms: number) { await vi.advanceTimersByTimeAsync(ms); await flush() }
async function readToResponse(root: HostNode) {
  await invoke(button(root, 'Start reading'))
  await advance(4000)
  await invoke(button(root, 'I read this section'))
}
async function answer(root: HostNode, id: string, text: string) {
  const field = find(root, n => n.props.id === id)!
  expect(field).toBeDefined(); await invoke(field, 'onUpdate:modelValue', text)
}
beforeAll(() => { Reading = loadComponent() })
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'performance'] })
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
  rows = new Map(); audios = new Map(); guards.length = 0; state = makeState()
  db.sessions.put.mockReset().mockImplementation(async (row: StudySession) => { rows.set(row.id, copy(row)); return row.id })
  db.sessions.get.mockReset().mockImplementation(async (id: string) => rows.get(id))
  db.audio.get.mockReset().mockImplementation(async (id: string) => audios.get(id))
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false, activeElement: null }))
  vi.stubGlobal('Document', EventTarget)
  vi.stubGlobal('ShadowRoot', class extends EventTarget {})
  vi.stubGlobal('window', new EventTarget())
  router.push.mockReset()
})
afterEach(async () => {
  for (const app of mounted.splice(0)) app.unmount()
  await flush(); vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('real ReadingPractice component behavior', () => {
  it('does not count page opening as reading or complete a task', async () => {
    const view = mount(); await flush(); await advance(10_000)
    expect(content(view.root)).toContain('Start reading')
    expect(state.events).toEqual([])
    expect([...rows.values()][0].draft.activeMs).toBe(0)
    expect(state.completeTask).not.toHaveBeenCalled()
  })
  it('times only explicitly active visible reading and persists a paused reload', async () => {
    const view = mount(); await flush(); await invoke(button(view.root, 'Start reading')); await advance(3000)
    await invoke(button(view.root, 'Pause reading')); await advance(5000)
    expect([...rows.values()][0].draft.activeMs).toBe(3000)
    view.unmount(); await flush(); const reloaded = mount(); await flush(); await advance(5000)
    expect(content(reloaded.root)).toContain('3 active seconds')
    expect(content(reloaded.root)).toContain('Resume reading')
    expect([...rows.values()][0].draft.activeMs).toBe(3000)
  })
  it('pauses on background/blur and does not silently resume', async () => {
    const view = mount(); await flush(); await invoke(button(view.root, 'Start reading')); await advance(3000)
    Object.assign(document, { hidden: true }); document.dispatchEvent(new Event('visibilitychange')); await advance(10_000)
    expect([...rows.values()][0].draft.activeMs).toBe(3000)
    Object.assign(document, { hidden: false }); document.dispatchEvent(new Event('visibilitychange')); await advance(5000)
    expect([...rows.values()][0].draft.activeMs).toBe(3000)
    await invoke(button(view.root, 'Resume reading')); await advance(2000); window.dispatchEvent(new Event('blur')); await flush()
    expect([...rows.values()][0].draft.activeMs).toBe(5000)
  })
  it('records explicit lookup attempts, pauses lookup time and leaves unmeasured coverage absent', async () => {
    const view = mount(); await flush(); await invoke(button(view.root, 'Start reading')); await advance(3000)
    await invoke(button(view.root, 'Look up People')); await advance(5000)
    expect(content(view.root)).toContain('No saved meaning yet')
    expect([...rows.values()][0].draft.activeMs).toBe(3000)
    await invoke(button(view.root, 'Return to reading')); await advance(1000); await invoke(button(view.root, 'I read this section'))
    await answer(view.root, 'reading-response', 'People understand each other when they listen.')
    await answer(view.root, 'reading-retell', 'A friend shares a story and asks a question.')
    await invoke(button(view.root, 'Save reading & retell'))
    const event = state.events.find(e => e.type === 'READING_OBSERVATION')!
    expect(event.data).toMatchObject({ lookupCount: 1, activeSeconds: 4 })
    expect(event.data).not.toHaveProperty('knownWordCount')
    expect(event).not.toHaveProperty('score')
  })
  it('requires a meaningful response and retell; text completion never manufactures ability', async () => {
    const view = mount(); await flush(); await readToResponse(view.root)
    expect(button(view.root, 'Save reading & retell').props.disabled).toBe(true)
    await answer(view.root, 'reading-response', 'People understand one another by listening.')
    expect(button(view.root, 'Save reading & retell').props.disabled).toBe(true)
    await answer(view.root, 'reading-retell', 'Good friends ask questions about meaningful stories.')
    await invoke(button(view.root, 'Save reading & retell'))
    expect(state.completeTask).toHaveBeenCalledWith('learn', { taskId: 'today:reading', materialId: 'reader' })
    expect(state.events.find(e => e.id === 'reading:today:reading:completed')).toMatchObject({ data: { kind: 'reading', taskId: 'today:reading' } })
    expect(state.events.find(e => e.type === 'READING_RETELL')).toMatchObject({ source: 'text', data: { textOnly: true } })
    expect(aggregateSkills(state.events).every(s => s.evidenceCount === 0)).toBe(true)
    expect(state.provider.evaluate).not.toHaveBeenCalled()
  })
  it('saves work from a stale task link without inventing current-plan completion', async () => {
    state.completeTask.mockImplementation(async () => {})
    const view = mount({ taskId: 'yesterday:reading' }); await flush(); await readToResponse(view.root)
    await answer(view.root, 'reading-response', 'People understand one another by listening.')
    await answer(view.root, 'reading-retell', 'Good friends ask questions about meaningful stories.')
    await invoke(button(view.root, 'Save reading & retell'))
    expect(state.events.some(e => e.type === 'READING_OBSERVATION')).toBe(true)
    expect(state.events.some(e => e.type === 'TASK_COMPLETED')).toBe(false)
    expect([...rows.values()][0].stage).toBe('saved')
  })
  it('only emits vocabulary counts after an explicit checked-word sample', async () => {
    const view = mount(); await flush(); await invoke(button(view.root, 'Start reading')); await advance(3000)
    await invoke(button(view.root, 'Look up People')); await invoke(button(view.root, 'I checked the words'))
    await invoke(button(view.root, 'I read this section'))
    await answer(view.root, 'reading-response', 'This story encourages us to listen carefully.')
    await answer(view.root, 'reading-retell', 'Friends listen and share stories to understand people.')
    await invoke(button(view.root, 'Save reading & retell'))
    const data = state.events.find(e => e.type === 'READING_OBSERVATION')!.data!
    expect(data.coverageSource).toBe('learner-checked-recognition')
    expect(data.knownWordCount).toBe((data.sampledWordCount as number) - 1)
    expect(aggregateSkills(state.events).find(s => s.id === 'reading')!.evidenceCount).toBe(0)
  })
  it('preserves prior exposure, including a previous listening session', async () => {
    state.events.push({ id: 'heard', timestamp: state.clock - 1000, type: 'LISTENING_RESPONSE', source: 'objective', data: { materialId: 'reader' } })
    const view = mount(); await flush(); await invoke(button(view.root, 'Start reading'))
    expect(state.events.find(e => e.type === 'READING_STARTED')?.data?.priorExposure).toBe(true)
  })
  it('records explicit deferral reasons without completing or discarding a reading', async () => {
    const view = mount(); await flush(); await readToResponse(view.root)
    await answer(view.root, 'reading-response', 'Keep this unfinished thought for another time.')
    await invoke(button(view.root, 'No time today'))
    expect(state.events.find(e => e.type === 'TASK_SKIPPED')).toMatchObject({ data: { kind: 'reading', reason: 'busy', taskId: 'today:reading' } })
    expect(state.completeTask).not.toHaveBeenCalled()
    expect([...rows.values()][0].draft.response).toContain('unfinished thought')
  })
  it('blocks unsaved route/query changes on storage failure and recovers without replacing work', async () => {
    const view = mount(); await flush(); await readToResponse(view.root)
    db.sessions.put.mockRejectedValue(new Error('disk full'))
    await answer(view.root, 'reading-response', 'My response remains available for another save attempt.')
    expect(await guards[0]()).toBe(false)
    expect(await guards[1]()).toBe(false)
    expect(content(view.root)).toContain('Could not save your reading')
    db.sessions.put.mockImplementation(async (row: StudySession) => { rows.set(row.id, copy(row)); return row.id })
    await invoke(button(view.root, 'Retry saving'))
    expect(await guards[0]()).toBe(true)
    expect([...rows.values()][0].draft.response).toBe('My response remains available for another save attempt.')
  })
  it('does not finish from an audio ID whose recording has not actually been saved', async () => {
    const view = mount(); await flush(); await readToResponse(view.root)
    await answer(view.root, 'reading-response', 'A good friend helps us explain an idea.')
    await invoke(button(view.root, 'Record test retell')); await invoke(button(view.root, 'Save reading & retell'))
    expect(state.completeTask).not.toHaveBeenCalled()
    expect(content(view.root)).toContain('recording is not saved yet')
    audios.set('retell-audio', { id: 'retell-audio', blob: new Blob(['original speech']), mimeType: 'audio/webm', duration: 4, createdAt: Date.now(), kind: 'recording', processed: false, label: 'Retell' })
    await invoke(button(view.root, 'Save reading & retell'))
    expect(state.events.find(e => e.type === 'READING_RETELL')).toMatchObject({ source: 'objective', prompted: true, data: { audioId: 'retell-audio', textOnly: false } })
    expect(aggregateSkills(state.events).every(s => s.evidenceCount === 0)).toBe(true)
  })
  it('saves first-attempt data before feedback, and provider failure preserves completion and work', async () => {
    state.keySet = true; state.online = true
    const view = mount(); await flush(); await readToResponse(view.root)
    await answer(view.root, 'reading-response', 'Sharing a story helps people understand each other.')
    await answer(view.root, 'reading-retell', 'Listen and ask questions when your friend tells a story.')
    await invoke(button(view.root, 'Save reading & retell'))
    state.provider.evaluate.mockRejectedValue(new Error('offline provider'))
    await invoke(button(view.root, 'Get feedback on the meaning'))
    expect(content(view.root)).toContain('offline provider')
    expect([...rows.values()][0].stage).toBe('saved')
    expect(state.events.filter(e => e.type === 'READING_RESPONSE')).toHaveLength(1)
    state.provider.evaluate.mockResolvedValue({ summary: 'Clear main idea.', comprehension: 0.8 })
    await invoke(button(view.root, 'Get feedback on the meaning'))
    expect(state.events.find(e => e.type === 'READING_EVALUATED')).toMatchObject({ source: 'ai', score: 0.8,
      data: { rubricVersion: 'reading-meaning-v2', firstPass: true, priorExposure: false } })
    expect(state.events.filter(e => e.type === 'READING_RESPONSE')).toHaveLength(1)
  })
  it('sends the actual component feedback through the real provider and server input contract', async () => {
    state.keySet = true; state.online = true
    const result = { summary: 'Clear meaning.', strengths: [], errors: [], comprehension: 0.8,
      accuracy: 0.8, fluency: null, successfulChunks: [], nextPrompt: 'Explain a detail.' }
    const model = { id: 'fixture/evaluator', name: 'Fixture', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs'] }
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/models?') ? { data: [model] }
      : { model: model.id, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    const adapter = new OpenRouterProvider({ getKey: async () => 'fixture-only-key',
      getSettings: () => ({ ...defaultSettings, strongModel: model.id, fastModel: model.id }) })
    state.provider.evaluate.mockImplementation(async (input, signal) => {
      expect(aiRequestSchema.safeParse({ action: 'evaluate', requestId: crypto.randomUUID(), input }).success).toBe(true)
      return adapter.evaluate(input, signal)
    })
    const view = mount(); await flush(); await readToResponse(view.root)
    await answer(view.root, 'reading-response', 'Sharing stories helps friends understand each other through listening.')
    await answer(view.root, 'reading-retell', 'Friends listen carefully, share ordinary moments and ask a kind question.')
    await invoke(button(view.root, 'Save reading & retell'))
    expect(aggregateSkills(state.events).every(skill => skill.evidenceCount === 0)).toBe(true)
    await invoke(button(view.root, 'Get feedback on the meaning'))
    const [input] = state.provider.evaluate.mock.calls[0]!
    expect(input.kind).toBe(longitudinal.readingRubric.version)
    expect(JSON.parse(input.rubric!)).toEqual(longitudinal.readingRubric)
    expect(state.events.find(event => event.type === 'READING_EVALUATED')).toMatchObject({ source: 'ai', score: 0.8 })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it('does not count a section from elapsed time accumulated on a different section', async () => {
    const long = { ...material, transcript: Array.from({ length: 5 }, () => text).join(' ') }
    const view = mount({ material: long }); await flush(); await invoke(button(view.root, 'Start reading')); await advance(3000)
    await invoke(button(view.root, 'I read this section'))
    expect(button(view.root, 'I read this section').props.disabled).toBe(true)
    await advance(2000)
    expect(button(view.root, 'I read this section').props.disabled).toBe(false)
  })
  it('emits saved assessment participation separately from actual evaluated meaning and provenance', async () => {
    const onSaved = vi.fn(); state.keySet = true; state.online = true
    const view = mount({ assessmentId: 'check-in', taskId: undefined, onSaved }); await flush(); await readToResponse(view.root)
    await answer(view.root, 'reading-response', 'Sharing stories helps people understand one another, and good friends ask questions.')
    await answer(view.root, 'reading-retell', 'Ask a friend what they think after explaining an idea clearly.')
    await invoke(button(view.root, 'Save reading & retell'))
    expect(onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'reading:check-in', score: null, evaluated: false }))
    expect(state.completeTask).not.toHaveBeenCalled()
    expect(aggregateSkills(state.events).every(s => s.evidenceCount === 0)).toBe(true)
    await invoke(button(view.root, 'Get feedback on the meaning'))
    expect(onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ score: 0.8, evaluated: true }))
    const event = state.events.find(e => e.type === 'READING_EVALUATED')!
    expect(event.data?.conditionsKey).toContain('actual-fixture-evaluator')
    expect(JSON.parse(String(event.data?.conditionsKey))[1]).toBe('["fixture","actual-fixture-evaluator"]')
    expect(event.data?.comparisonKey).toMatch(/^reading-main-idea-detail:/)
    expect(aggregateSkills(state.events).find(s => s.id === 'reading')!.evidenceCount).toBe(1)
    expect(aggregateSkills(state.events).filter(s => ['speakingFluency', 'realWorld', 'pronunciation'].includes(s.id)).every(s => s.evidenceCount === 0)).toBe(true)
  })
  it('leaves comparable conditions absent when the provider does not attest the evaluator', async () => {
    state.keySet = true; state.online = true
    state.provider.evaluate.mockResolvedValue({ summary: 'Meaning estimate only.', comprehension: 0.7 })
    const view = mount(); await flush(); await readToResponse(view.root)
    await answer(view.root, 'reading-response', 'Listening carefully helps us understand one another.')
    await answer(view.root, 'reading-retell', 'Friends listen carefully and ask questions about stories.')
    await invoke(button(view.root, 'Save reading & retell')); await invoke(button(view.root, 'Get feedback on the meaning'))
    expect(state.events.find(e => e.type === 'READING_EVALUATED')?.data).not.toHaveProperty('conditionsKey')
  })
})

async function browserRows<T>(page: Page, table: string): Promise<T[]> {
  return page.evaluate(name => new Promise<T[]>((resolve, reject) => {
    const request = indexedDB.open('jove-english-os'); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const database = request.result; const read = database.transaction(name).objectStore(name).getAll();
      read.onsuccess = () => { database.close(); resolve(read.result) }; read.onerror = () => reject(read.error) }
  }), table)
}
async function browserPut(page: Page, table: string, values: unknown[]) {
  await page.evaluate(({ table, values }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('jove-english-os'); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const database = request.result, tx = database.transaction(table, 'readwrite');
      tx.oncomplete = () => { database.close(); resolve() }; tx.onabort = () => reject(tx.error);
      for (const value of values) tx.objectStore(table).put(value) }
  }), { table, values })
}
async function clearBrowserFixture(page: Page) {
  // Only the freshly-created test context. Never connects to an owner's browser.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('jove-english-os'); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const database = request.result, tables = ['cards', 'chunks', 'events', 'plans'];
      const tx = database.transaction(tables, 'readwrite'); tx.oncomplete = () => { database.close(); resolve() }; tx.onabort = () => reject(tx.error);
      for (const table of tables) tx.objectStore(table).clear() }
  }))
}
describe.skipIf(!process.env.READING_BROWSER_URL)('actual browser reading/review integration', () => {
  it.each([{ name: 'desktop', width: 1365, height: 1000 }, { name: 'mobile', width: 390, height: 844 }])('saves reading, survives reload and preserves unknown mastery on $name', async viewport => {
    vi.useRealTimers()
    const browser = await chromium.launch(), page = await browser.newPage({ viewport })
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', dialog => void dialog.accept())
    try {
      const base = process.env.READING_BROWSER_URL!
      await page.clock.install({ time: new Date('2026-09-08T12:00:00Z') })
      await page.goto(base + '#/learn'); await page.locator('h1').waitFor()
      await browserPut(page, 'materials', [material])
      const date = await page.evaluate(() => new Date().toLocaleDateString('en-CA')), taskId = `${date}:learn:reader:reading`
      const profiles = await browserRows<Record<string, unknown>>(page, 'profiles')
      await browserPut(page, 'profiles', profiles.map(p => ({ ...p, onboarded: true })))
      await browserPut(page, 'plans', [{ id: date, date, minutes: 45, focus: 'reading', createdAt: Date.now(), evidenceFingerprint: 'browser-fixture',
        tasks: [{ id: taskId, kind: 'learn', title: 'Read something worth sharing', reason: 'Read for meaning', minutes: 45, done: false, materialId: material.id }] }])
      await page.goto(base + `#/learn?material=reader&mode=reading&task=${encodeURIComponent(taskId)}`)
      await page.reload()
      await page.getByRole('button', { name: 'Start reading', exact: true }).click()
      await page.clock.runFor(35_000)
      await page.screenshot({ path: `.work/reading-active-${viewport.name}.png`, fullPage: true })
      await page.getByRole('button', { name: 'Look up People', exact: true }).click()
      await page.getByRole('button', { name: 'Return to reading', exact: true }).click()
      await page.getByText('Optional word familiarity check', { exact: true }).click()
      await page.getByRole('button', { name: 'I checked the words in this section', exact: true }).click()
      await page.getByRole('button', { name: 'I read this section · share the meaning', exact: true }).click()
      await page.locator('#reading-response').fill('Friends understand one another by sharing stories and listening carefully.')
      await expect.poll(async () => (await browserRows<StudySession>(page, 'sessions')).find(s => s.id === `reading:${taskId}`)?.draft.response).toContain('Friends understand')
      await page.reload()
      expect(await page.locator('#reading-response').inputValue()).toContain('Friends understand')
      await page.locator('#reading-retell').fill('Share an idea, listen to your friend, and ask a kind question.')
      await page.getByRole('button', { name: 'Save reading & retell', exact: true }).click()
      await page.getByRole('heading', { name: 'Saved. Ready to reflect on the meaning.' }).waitFor()
      const events = await browserRows<StudyEvent>(page, 'events')
      expect(events.find(e => e.type === 'READING_OBSERVATION')).toMatchObject({ source: 'objective', data: { lookupCount: 1, coverageSource: 'learner-checked-recognition' } })
      expect(events.filter(e => e.type === 'READING_RESPONSE')).toHaveLength(1)
      expect(events.filter(e => e.type === 'READING_RETELL')).toHaveLength(1)
      expect(aggregateSkills(events).find(s => s.id === 'reading')!.evidenceCount).toBe(0)
      expect((await browserRows<{ tasks: { id: string; done: boolean }[] }>(page, 'plans')).some(p => p.tasks.some(t => t.id === taskId && t.done))).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await page.screenshot({ path: `.work/reading-${viewport.name}.png`, fullPage: true })
      expect(errors).toEqual([])
    } finally { await browser.close() }
  }, 60_000)
  it('finishes a bounded recovery review block while preserving the remaining due cards', async () => {
    vi.useRealTimers()
    const browser = await chromium.launch(), page = await browser.newPage()
    try {
      const base = process.env.READING_BROWSER_URL!
      await page.goto(base + '#/review'); await page.locator('h1').waitFor()
      await clearBrowserFixture(page)
      const now = await page.evaluate(() => Date.now())
      await browserPut(page, 'events', [{ id: 'prior-practice', timestamp: now - 14 * 86_400_000, type: 'TASK_COMPLETED', source: 'objective', data: { kind: 'listen' } }])
      const chunks = Array.from({ length: 60 }, (_, i) => ({ id: `bounded-${i}`, text: `Useful phrase ${i}`, meaningEn: 'A useful idea', meaningZh: '',
        sourceSentence: 'An original example.', examples: [], register: 'neutral', sourceIds: [], readingStrength: 0, listeningStrength: 0,
        recallStrength: 0, productionStrength: 0, spontaneousUses: 0, createdAt: now - 20 * 86_400_000 }))
      await browserPut(page, 'chunks', chunks)
      await browserPut(page, 'cards', chunks.map(c => ({ id: c.id, chunkId: c.id, modality: 'recognition', card: createEmptyCard(now - 1), contextIds: [] })))
      await page.reload()
      await page.locator('#review-answer').waitFor()
      await page.getByRole('combobox', { name: 'Practice type' }).selectOption('recognition')
      await expect.poll(async () => page.locator('.flashcard .pill').textContent()).toBe('recognition')
      const originalCards = await browserRows<{ card: { reps: number } }>(page, 'cards')
      expect(await page.locator('.count-badge').innerText()).toBe('6 in this selection')
      for (let i = 0; i < 6; i++) {
        await page.locator('#review-answer').fill('This expression communicates a useful idea.')
        await page.getByRole('button', { name: 'Check my answer', exact: false }).click()
        await page.getByRole('button', { name: 'Good Independent', exact: true }).click()
        await expect.poll(async () => (await browserRows<StudyEvent>(page, 'events')).filter(e => e.type === 'review').length).toBe(i + 1)
      }
      await expect.poll(async () => (await browserRows<StudyEvent>(page, 'events')).filter(e => e.type === 'REVIEW_BLOCK_COMPLETED').length).toBe(1)
      const cards = await browserRows<{ card: { reps: number } }>(page, 'cards')
      expect(cards).toHaveLength(originalCards.length)
      expect(cards.filter(c => c.card.reps === 0)).toHaveLength(originalCards.filter(c => c.card.reps === 0).length - 6)
      await page.reload(); await page.getByRole('combobox', { name: 'Practice type' }).selectOption('recognition')
      await page.getByRole('heading', { name: 'That’s enough for this moment.' }).waitFor()
      expect(await page.locator('#review-answer').count()).toBe(0)
    } finally { await browser.close() }
  }, 60_000)
  it('keeps a saved review selection pending when matching card history is missing', async () => {
    vi.useRealTimers()
    const browser = await chromium.launch(), page = await browser.newPage()
    try {
      const base = process.env.READING_BROWSER_URL!
      await page.goto(base + '#/review'); await page.locator('h1').waitFor()
      await clearBrowserFixture(page)
      await browserPut(page, 'sessions', [{ id: 'review-block:missing-selection:all', kind: 'review-block', startedAt: Date.now(),
        stage: 'selection', draft: { taskId: 'missing-selection', items: [{ cardId: 'not-yet-synced', reps: 2 }] } }])
      await page.goto(base + '#/review?task=missing-selection'); await page.reload()
      await page.getByRole('heading', { name: 'Your saved selection is waiting for card history.' }).waitFor()
      expect(await page.locator('.empty-state').getByRole('status').innerText()).toContain('has not been marked complete')
      expect(await page.locator('#review-answer').count()).toBe(0)
      expect((await browserRows<StudyEvent>(page, 'events')).some(e =>
        ['TASK_COMPLETED', 'REVIEW_BLOCK_COMPLETED'].includes(e.type) && e.data?.taskId === 'missing-selection')).toBe(false)
    } finally { await browser.close() }
  }, 60_000)
})
