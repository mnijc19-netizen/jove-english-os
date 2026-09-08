import { readFileSync } from 'node:fs'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import * as Vue from 'vue'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as longitudinal from '../src/domain/longitudinal'
import { aggregateSkills } from '../src/domain/engine'
import { useRequest } from '../src/composables/useRequest'
import { defaultSettings, type AudioAsset, type Evaluation, type Material, type PlanTask, type StudyEvent, type StudySession } from '../src/domain/types'
import { chromium, type Page } from '@playwright/test'
import { createEmptyCard } from 'ts-fsrs'
import { OpenRouterProvider } from '../src/ai/provider'
import { aiRequestSchema } from '../src/server/ai'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { createPinia, setActivePinia } from 'pinia'
import { db as learningDb } from '../src/db/db'
import { addChunk, initialize } from '../src/db/repository'
import { useApp } from '../src/stores/app'
import * as engine from '../src/domain/engine'

// No auth, backend, provider, or media fixture: the assigned loop uses real
// Pinia/repository/IndexedDB and compiled Vue handlers, with offline services.
vi.mock('../src/stores/cloud', () => ({ useCloud: () => ({ configured: false, userId: '' }) }))
vi.mock('../src/cloud/client', () => ({ cloudClient: null, publicCloudConfig: { url: '', publishableKey: '' } }))

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
function loadComponent(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
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

describe('assigned learning loop with real local persistence', () => {
  let learning: ReturnType<typeof useApp>, Learn: Vue.Component
  const route = Vue.reactive({ query: {} as Record<string, string> })
  const chunkMaterial = { ...material, chunks: [{ text: 'give me a hand', meaningEn: 'help me', meaningZh: '', example: 'Could you give me a hand?' }] }
  beforeEach(async () => {
    await learningDb.delete(); await learningDb.open(); setActivePinia(createPinia())
    Object.assign(window, { setInterval: vi.fn(() => 1) })
    Object.assign(document, { visibilityState: 'visible', documentElement: { dataset: {} } })
    vi.stubGlobal('navigator', { onLine: false }); vi.stubGlobal('matchMedia', () => ({ matches: false }))
    await initialize([chunkMaterial]); await learningDb.profiles.update('main', { onboarded: true })
    learning = useApp(); await learning.refresh()
    const modules: Record<string, unknown> = {
      vue: Vue, 'vue-router': { useRoute: () => route, useRouter: () => router },
      '../stores/app': { useApp: () => learning }, '../db/db': { db: learningDb }, '../db/repository': { addChunk },
      '../domain/engine': engine, '../domain/longitudinal': longitudinal, '../composables/useRequest': { useRequest },
      '../components/ReadingPractice.vue': { default: loadComponent({ '../stores/app': { useApp: () => learning }, '../db/db': { db: learningDb } }) },
      '../components/AudioPlayer.vue': { default: Vue.defineComponent({ render: () => null }) },
      '../components/Icon.vue': { default: Vue.defineComponent({ render: () => null }) },
    }
    const filename = 'Learn.vue', { descriptor } = parse(readFileSync(new URL('../src/pages/Learn.vue', import.meta.url), 'utf8'), { filename })
    const script = compileScript(descriptor, { id: filename, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
    const code = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
    const exports: { default?: Vue.Component } = {}
    new Function('require', 'exports', code)((id: string) => { if (!(id in modules)) throw new Error(`Unknown learning import ${id}`); return modules[id] }, exports)
    Learn = exports.default!
  })
  afterEach(async () => { for (const app of mounted.splice(0)) app.unmount(); await flush(); vi.restoreAllMocks(); learning.$dispose(); await learningDb.delete() })
  async function mountTask(activity: 'chunks' | 'reading' | PlanTask) {
    const task = typeof activity === 'string' ? learning.plan.tasks.find(t => t.id.endsWith(':' + activity))! : activity
    await learning.beginTask(task.id); route.query = engine.taskPath(task).query
    const root = new HostNode('root'), app = renderer.createApp(Learn)
    app.component('RouterLink', { render: () => null }); app.mount(root); mounted.push(app); await flush()
    return { root, task, unmount: () => { app.unmount(); mounted.splice(mounted.indexOf(app), 1) } }
  }
  it('requires an actual chunk and writing, persists six cards, and continues the assigned material', async () => {
    const view = await mountTask('chunks')
    await answer(view.root, 'give me a hand', 'Could you give me a hand with dinner?')
    await invoke(button(view.root, 'Save my example & practice later'))
    expect(await learningDb.chunks.count()).toBe(1); expect(await learningDb.cards.count()).toBe(6)
    expect(button(view.root, 'Use these in conversation').props.disabled).toBe(true)
    await answer(view.root, 'rephrase', 'Sharing stories and asking kind questions helps people understand one another.')
    await invoke(button(view.root, 'Save & check my rephrasing'))
    expect((await learningDb.events.toArray()).filter(e => e.type === 'WRITTEN_RESPONSE')).toHaveLength(1)
    expect((await learningDb.events.toArray()).filter(e => e.type === 'WRITING_EVALUATED')).toHaveLength(0)
    await invoke(button(view.root, 'Use these in conversation'))
    const speak = learning.plan.tasks.find(t => t.kind === 'speak')!
    expect(router.push).toHaveBeenLastCalledWith(engine.taskPath(speak))
    expect(learning.plan.tasks.find(t => t.id === view.task.id)?.done).toBe(true)
    expect(learning.plan.tasks.find(t => t.id.endsWith(':reading'))?.done).toBe(false)
    expect(await learningDb.sessions.get('learn-draft-' + view.task.id)).toBeDefined()
  })
  it('keeps a saved reading task reachable through reload and explicitly continues to chunks', async () => {
    const view = await mountTask('reading')
    expect(content(view.root)).not.toContain('Reading is waiting for a suitable passage')
    await readToResponse(view.root)
    await answer(view.root, 'reading-response', 'Sharing stories helps us understand each other.')
    await answer(view.root, 'reading-retell', 'A good friend listens and asks a kind question.')
    await invoke(button(view.root, 'Save reading & retell'))
    expect(learning.plan.tasks.find(t => t.id === view.task.id)?.done).toBe(true)
    view.unmount(); await flush()
    const restored = await mountTask('reading')
    await learning.refresh(); await flush()
    expect(!!find(restored.root, n => n.type === 'button' && content(n).includes('Continue to next task'))).toBe(true)
    await invoke(button(restored.root, 'Continue to next task'))
    expect(router.push).toHaveBeenLastCalledWith(engine.taskPath(learning.plan.tasks.find(t => t.id.endsWith(':chunks'))!))
    expect(await learningDb.chunks.count()).toBe(0)
  })
  it('does not expose Continue until the reading session is durably saved and recovers an interrupted final write', async () => {
    const view = await mountTask('reading'); await readToResponse(view.root)
    await answer(view.root, 'reading-response', 'Sharing stories helps us understand each other.')
    await answer(view.root, 'reading-retell', 'A good friend listens and asks a kind question.')
    const putSession = learningDb.sessions.put.bind(learningDb.sessions)
    const failed = vi.spyOn(learningDb.sessions, 'put').mockImplementation((row, ...rest) => {
      if (row.kind === 'reading' && row.stage === 'saved') return Dexie.Promise.reject(new Error('interrupted final session commit'))
      return putSession(row, ...rest)
    })
    await invoke(button(view.root, 'Save reading & retell'))
    expect(learning.plan.tasks.find(t => t.id === view.task.id)?.done).toBe(true)
    expect(!!find(view.root, n => n.type === 'button' && content(n).includes('Continue to next task'))).toBe(false)
    const original = (await learningDb.events.toArray()).filter(e => ['READING_RESPONSE', 'READING_RETELL'].includes(e.type))
    expect(original).toHaveLength(2)
    expect((await learningDb.sessions.get('reading:' + view.task.id))?.stage).toBe('respond')
    // A fresh component after a crash reads the saved, immutable first response.
    view.unmount(); await flush(); failed.mockRestore()
    const restored = await mountTask('reading')
    expect(!!find(restored.root, n => n.type === 'button' && content(n).includes('Continue to next task'))).toBe(false)
    await invoke(button(restored.root, 'Save reading & retell'))
    expect((await learningDb.sessions.get('reading:' + view.task.id))?.stage).toBe('saved')
    expect((await learningDb.events.toArray()).filter(e => ['READING_RESPONSE', 'READING_RETELL'].includes(e.type))).toEqual(original)
    await invoke(button(restored.root, 'Continue to next task'))
    expect(router.push).toHaveBeenLastCalledWith(engine.taskPath(learning.plan.tasks.find(t => t.id.endsWith(':chunks'))!))
  })
  it('recovers same-page final-save retries without reload, duplicate evidence, or an early Continue', async () => {
    const view = await mountTask('reading'); await readToResponse(view.root)
    await answer(view.root, 'reading-response', 'Sharing stories helps us understand each other.')
    await answer(view.root, 'reading-retell', 'A good friend listens and asks a kind question.')
    const putSession = learningDb.sessions.put.bind(learningDb.sessions)
    let failFinal = true
    vi.spyOn(learningDb.sessions, 'put').mockImplementation((row, ...rest) => row.kind === 'reading' && row.stage === 'saved' && failFinal
      ? Dexie.Promise.reject(new Error('final session commit unavailable')) : putSession(row, ...rest))
    await invoke(button(view.root, 'Save reading & retell'))
    const original = await learningDb.events.toArray()
    expect(original.filter(e => ['READING_RESPONSE', 'READING_RETELL'].includes(e.type))).toHaveLength(2)
    expect(learning.plan.tasks.find(t => t.id === view.task.id)?.done).toBe(true)
    await invoke(button(view.root, 'Retry saving'))
    expect((await learningDb.sessions.get('reading:' + view.task.id))?.stage).toBe('respond')
    expect(!!find(view.root, n => n.type === 'button' && content(n).includes('Continue to next task'))).toBe(false)
    failFinal = false
    await invoke(button(view.root, 'Retry saving'))
    expect((await learningDb.sessions.get('reading:' + view.task.id))?.stage).toBe('saved')
    expect(content(view.root)).not.toContain('Could not save your reading')
    expect(await learningDb.events.toArray()).toEqual(original)
    await invoke(button(view.root, 'Continue to next task'))
    expect(router.push).toHaveBeenLastCalledWith(engine.taskPath(learning.plan.tasks.find(t => t.id.endsWith(':chunks'))!))
  })
  it.each((['task', 'material', 'unmount'] as const).flatMap(change => (['save', 'retry'] as const).map(action => ({ change, action }))))('fences a late $action receipt after $change changes', async ({ change, action }) => {
    const task = learning.plan.tasks.find(t => t.id.endsWith(':reading'))!
    await learning.beginTask(task.id)
    const props = Vue.reactive({ taskId: task.id, material: copy(chunkMaterial) }), onSaved = vi.fn()
    const ActualReading = loadComponent({ '../stores/app': { useApp: () => learning }, '../db/db': { db: learningDb } })
    const root = new HostNode('root'), component = renderer.createApp({ setup: () => () => Vue.h(ActualReading, { ...props, onSaved }) })
    component.mount(root); mounted.push(component); await flush(); await readToResponse(root)
    await answer(root, 'reading-response', 'My original response describes sharing stories.')
    await answer(root, 'reading-retell', 'My original retell describes a kind question.')
    const putSession = learningDb.sessions.put.bind(learningDb.sessions)
    let release: (() => void) | undefined
    let failFinal = action === 'retry'
    vi.spyOn(learningDb.sessions, 'put').mockImplementation((row, ...rest) => {
      if (row.kind === 'reading' && row.stage === 'saved') {
        if (failFinal) return Dexie.Promise.reject(new Error('final session commit unavailable'))
        if (!release) return new Dexie.Promise<string>((resolve, reject) => { release = () => { void putSession(row, ...rest).then(resolve, reject) } })
      }
      return putSession(row, ...rest)
    })
    if (action === 'retry') { await invoke(button(root, 'Save reading & retell')); failFinal = false }
    const save = (button(root, action === 'retry' ? 'Retry saving' : 'Save reading & retell').props.onClick as () => Promise<void>)()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const original = await learningDb.events.toArray()
    if (change === 'task') props.taskId = 'another-reading-task'
    else if (change === 'material') props.material = { ...copy(chunkMaterial), id: 'another-material' }
    else { component.unmount(); mounted.splice(mounted.indexOf(component), 1) }
    await flush(); release!(); await save; await flush()
    expect((await learningDb.sessions.get('reading:' + task.id))?.stage).toBe('saved')
    expect(onSaved).not.toHaveBeenCalled()
    expect(await learningDb.events.toArray()).toEqual(original)
  })
  it('does not let free writing or mismatched identity complete the reader', async () => {
    const reading = learning.plan.tasks.find(t => t.id.endsWith(':reading'))!
    await learning.beginTask(reading.id)
    expect(await learning.completeTask('learn', { taskId: reading.id, materialId: 'wrong' })).toBe(false)
    expect(await learning.completeTask('learn', { taskId: reading.id, materialId: material.id })).toBe(false)
    expect(await learning.completeTask('learn', { materialId: material.id })).toBe(false)
    expect(learning.plan.tasks.find(t => t.id === reading.id)?.done).toBe(false)
  })
  it('restores writing after a failed completion and retries without losing the original responses', async () => {
    const view = await mountTask('chunks')
    await answer(view.root, 'give me a hand', 'Can you give me a hand with the bags?')
    await invoke(button(view.root, 'Save my example & practice later'))
    await answer(view.root, 'rephrase', 'A useful detail and a kind question make sharing helpful.')
    await invoke(button(view.root, 'Save & check my rephrasing'))
    const before = (await learningDb.events.toArray()).filter(e => ['CHUNK_RECALL', 'WRITTEN_RESPONSE'].includes(e.type))
    const failure = vi.spyOn(learningDb.plans, 'put').mockRejectedValueOnce(new Error('disk temporarily unavailable'))
    await invoke(button(view.root, 'Use these in conversation'))
    expect(router.push).not.toHaveBeenCalled(); expect(content(view.root)).toContain('Could not finish')
    failure.mockRestore(); view.unmount(); await flush()
    const restored = await mountTask('chunks')
    expect(find(restored.root, n => n.props.id === 'rephrase')?.props['onUpdate:modelValue']).toBeTypeOf('function')
    expect(button(restored.root, 'Use these in conversation').props.disabled).toBe(false)
    await invoke(button(restored.root, 'Use these in conversation'))
    expect((await learningDb.events.toArray()).filter(e => ['CHUNK_RECALL', 'WRITTEN_RESPONSE'].includes(e.type))).toEqual(before)
    expect(learning.plan.tasks.find(t => t.id === view.task.id)?.done).toBe(true)
  })
  it('restores a legacy language assignment and draft without renaming work or reopening completed tasks', async () => {
    const plan = copy(learning.plan), language = plan.tasks.find(t => t.id.endsWith(':chunks'))!
    language.id = `${plan.date}:learn:${material.id}`
    const listening = plan.tasks.find(t => t.kind === 'listen')!; listening.done = true
    await learningDb.plans.put(plan)
    const originalText = 'My original saved rephrasing about sharing stories.'
    const session: StudySession = { id: 'learn-draft-' + material.id, kind: 'learn', materialId: material.id,
      startedAt: Date.now() - 3000, stage: 'practice', draft: { rephrase: originalText, recalled: {}, revealed: [] } }
    await learningDb.sessions.put(session)
    const original: StudyEvent = { id: 'legacy-writing', type: 'WRITTEN_RESPONSE', source: 'text', timestamp: Date.now() - 1000,
      sessionId: session.id, data: { materialId: material.id, taskId: language.id, response: originalText } }
    await learning.evidence(original)
    const view = await mountTask(language)
    expect((await learningDb.sessions.get(session.id))?.draft.rephrase).toBe(session.draft.rephrase)
    expect(button(view.root, 'Use these in conversation').props.disabled).toBe(false)
    await invoke(button(view.root, 'Use these in conversation'))
    const saved = (await learningDb.plans.get(plan.id))!
    expect(saved.tasks.find(t => t.id === listening.id)).toEqual(listening)
    expect(saved.tasks.find(t => t.id === language.id)?.done).toBe(true)
    expect(saved.tasks.some(t => t.id.endsWith(':chunks'))).toBe(false)
    expect(saved.tasks.find(t => t.id.endsWith(':reading'))?.done).toBe(false)
    expect(await learningDb.events.get(original.id)).toEqual(original)
    expect((await learningDb.sessions.toArray()).filter(s => s.kind === 'learn').map(s => s.id)).toEqual([session.id])
  })
  it('uses fresh daily drafts for sixty low-language-backlog days without initial cards or invented writing growth', async () => {
    expect(await learningDb.cards.count()).toBe(0)
    const start = Date.now(), ids = new Set<string>()
    for (let day = 0; day < 60; day++) {
      vi.setSystemTime(start + day * 86_400_000); await learning.refresh()
      const view = await mountTask('chunks'); ids.add(view.task.id)
      expect(learning.plan.tasks.some(t => t.id.endsWith(':reading') && t.minutes > 0)).toBe(true)
      expect(learning.plan.minutes).toBeLessThanOrEqual(learning.profile.dailyMinutes)
      expect(learning.plan.tasks.every(t => t.minutes > 0)).toBe(true)
      await answer(view.root, 'give me a hand', `Could you give me a hand with plan number ${day + 1}?`)
      expect(button(view.root, 'Save my example & practice later').props.disabled).toBe(false)
      await invoke(button(view.root, 'Save my example & practice later'))
      await answer(view.root, 'rephrase', `In attempt ${day + 1}, I explain that people understand each other through listening and sharing.`)
      await invoke(button(view.root, 'Save & check my rephrasing'))
      await invoke(button(view.root, 'Use these in conversation'))
      expect(learning.plan.tasks.find(t => t.id === view.task.id)?.done).toBe(true)
      if (day > 0) expect(learning.plan.tasks.some(t => t.kind === 'review')).toBe(true)
      view.unmount(); await flush()
    }
    const events = await learningDb.events.toArray()
    expect(ids.size).toBe(60)
    expect(events.filter(e => e.type === 'WRITTEN_RESPONSE')).toHaveLength(60)
    expect(events.filter(e => e.type === 'CHUNK_RECALL')).toHaveLength(60)
    expect(await learningDb.chunks.count()).toBe(1) // One actual source expression, not 60 fabricated acquisitions.
    expect(await learningDb.cards.count()).toBe(6)
    expect(events.filter(e => e.type === 'WRITING_EVALUATED')).toHaveLength(0)
    expect(learning.skills.find(s => s.id === 'writing')?.evidenceCount).toBe(0)
  }, 60000)
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
