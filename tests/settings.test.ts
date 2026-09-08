import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { compileScript, parse } from '@vue/compiler-sfc'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import * as Vue from 'vue'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import * as repository from '../src/db/repository'
import * as localChange from '../src/sync/local-change'
import { SyncJournal } from '../src/sync/journal'
import { createCloudState } from '../src/stores/cloud'
import { audioHash } from '../src/sync/audio'
import { useRequest } from '../src/composables/useRequest'
import { defaultProfile, defaultSettings, type AudioAsset, type Usage } from '../src/domain/types'

// Actual Settings SFC events + real repository/Dexie/store, without a new DOM dependency.
class Node {
  parent: Node | null = null
  children: Node[] = []
  props: Record<string, unknown> = {}
  text = ''; value = ''; tagName: string
  constructor(readonly type: string) { this.tagName = type.toUpperCase() }
  addEventListener() {}
  removeEventListener() {}
  getRootNode() { return { activeElement: null } }
}
const renderer = Vue.createRenderer<Node, Node>({
  createElement: type => new Node(type), createText: text => Object.assign(new Node('#text'), { text }),
  createComment: text => Object.assign(new Node('#comment'), { text }),
  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
  patchProp: (node, key, _old, value) => { node.props[key] = value; if (key === 'value') node.value = value },
  insert: (node, parent, anchor = null) => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node)
  },
  remove: node => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
})
function content(node: Node): string { return node.text + node.children.map(content).join('') }
function find(node: Node, predicate: (node: Node) => boolean): Node | undefined {
  if (predicate(node)) return node
  for (const child of node.children) { const found = find(child, predicate); if (found) return found }
}
function input(root: Node, id: string): Node {
  const found = find(root, node => node.props.id === id)
  if (!found) throw new Error('Missing Settings input: ' + id)
  return found
}
async function invoke(node: Node, event: string, value?: unknown) {
  const handler = node.props[event]
  if (typeof handler !== 'function') throw new Error('Missing Settings handler: ' + event)
  await handler(value)
  await Vue.nextTick()
}
async function click(root: Node, label: string) {
  const node = find(root, node => node.type === 'button' && content(node).includes(label))
  if (!node) throw new Error('Missing Settings button: ' + label)
  expect(!!node.props.disabled).toBe(false)
  await invoke(node, 'onClick')
}
const owner = '00000000-0000-4000-8000-000000000010'
const original = (): AudioAsset => ({ id: 'original', blob: new Blob(['original recording']), mimeType: 'audio/wav',
  createdAt: 1788815000000, duration: 1, kind: 'recording', processed: false, label: 'Original' })
function makeApp() {
  return Vue.reactive({ settings: { ...defaultSettings }, profile: defaultProfile(), audio: [] as AudioAsset[], usage: [] as Usage[],
    providerMode: 'account', browserKeySet: true, cost: 0,
    refresh: async () => {
      appState.audio = await db.audio.toArray()
      appState.settings = (await db.settings.get('main'))?.value ?? { ...defaultSettings }
      appState.profile = (await db.profiles.get('main')) ?? defaultProfile()
      appState.browserKeySet = !!await db.secrets.get('openrouter')
    },
  })
}
function makeCloud() { return Vue.reactive({ ...createCloudState(db, null), configured: true }) }
let appState: ReturnType<typeof makeApp>, cloud: ReturnType<typeof makeCloud>, component: Vue.Component
const mounted: Vue.App[] = []
function mount() {
  const root = new Node('root'), app = renderer.createApp(component)
  app.component('RouterLink', { setup: (_props: Record<string, unknown>, { slots }: Vue.SetupContext) => () => Vue.h('a', slots.default?.()) })
  app.mount(root); mounted.push(app); return root
}
beforeAll(() => {
  const source = readFileSync(new URL('../src/pages/Settings.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename: 'Settings.vue' })
  const script = compileScript(descriptor, { id: 'settings-test', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const code = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const dependencies: Record<string, unknown> = {
    vue: Vue, '../db/db': { db }, '../db/repository': repository, '../sync/local-change': localChange,
    '../stores/app': { useApp: () => appState }, '../stores/cloud': { useCloud: () => cloud }, '../composables/useRequest': { useRequest },
    '../components/Icon.vue': { default: { setup: () => () => Vue.h('i') } },
    '../components/CloudAccount.vue': { default: { setup: () => () => Vue.h('section', 'Learning account') } },
    '../components/AccountUsage.vue': { default: { setup: () => () => Vue.h('section', 'Account service preferences') } },
  }
  const exports: { default?: Vue.Component } = {}
  new Function('require', 'exports', code)((id: string) => {
    if (!(id in dependencies)) throw new Error('Unmapped Settings test import: ' + id)
    return dependencies[id]
  }, exports)
  component = exports.default!
})
beforeEach(async () => {
  await db.delete(); await db.open()
  await db.profiles.put({ ...defaultProfile(), onboarded: true })
  await db.settings.put({ id: 'main', value: { ...defaultSettings } })
  await db.audio.bulkPut([original(), { ...original(), id: 'cached', kind: 'content-cache' }])
  await db.sessions.put({ id: 'unfinished', kind: 'listen', startedAt: 1788815000000, stage: 'draft', draft: { answer: 'Saved text', audioId: 'original' } })
  await db.secrets.put({ id: 'openrouter', value: 'fixture-only-local-marker' })
  await new SyncJournal(db).bindOwner(owner)
  appState = makeApp(); cloud = makeCloud(); await appState.refresh()
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('Document', class {})
  vi.stubGlobal('ShadowRoot', class {})
})
afterEach(async () => {
  for (const app of mounted.splice(0)) app.unmount()
  await cloud.stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.delete()
})

describe('Settings protected reset/restore wiring', () => {
  it('runs the real reset button through its guard, keeps account services UI, originals, drafts and owner journal', async () => {
    const root = mount(), guard = vi.spyOn(cloud, 'withLocalDataChange'), operations = await db.syncOperations.toArray()
    expect(content(root)).toContain('Account service preferences')
    expect(content(root)).toContain('Learning account')
    await invoke(input(root, 'reset-confirm'), 'onUpdate:modelValue', 'RESET')
    await click(root, 'Reset local key & caches')
    expect(guard).toHaveBeenCalledTimes(1)
    expect(await db.secrets.count()).toBe(0)
    expect(await db.audio.get('cached')).toBeUndefined()
    expect(await audioHash((await db.audio.get('original'))!.blob)).toBe(await audioHash(original().blob))
    expect((await db.sessions.get('unfinished'))?.draft.answer).toBe('Saved text')
    expect((await db.syncMeta.get('owner'))?.value).toBe(owner)
    expect(await db.syncOperations.toArray()).toEqual(operations)
    expect(content(root)).toContain('account sync history are retained')
  })
  it('rolls back a failed reset, displays failure rather than success, and permits a safe retry', async () => {
    const root = mount()
    const real = localChange.resetDeviceCacheAndKey
    vi.spyOn(localChange, 'resetDeviceCacheAndKey').mockImplementationOnce(async database => { await real(database); throw new Error('Injected reset failure') })
    await invoke(input(root, 'reset-confirm'), 'onUpdate:modelValue', 'RESET')
    await click(root, 'Reset local key & caches')
    expect(content(root)).toContain('Injected reset failure')
    expect(content(root)).not.toContain('Optional local API key and audio caches cleared.')
    expect(await db.audio.count()).toBe(2); expect(await db.secrets.count()).toBe(1)
    expect(cloud.paused).toBe(false)
    await click(root, 'Reset local key & caches')
    expect(await db.secrets.count()).toBe(0)
    expect(content(root)).toContain('account sync history are retained')
  })
  it('loads and merges a real older backup through the UI without deleting later drafts or emitting cloud tombstones', async () => {
    const backup = await repository.exportBackup()
    await db.sessions.put({ id: 'later', kind: 'listen', startedAt: 1788815000001, stage: 'draft', draft: { answer: 'Later work' } })
    const root = mount(), guard = vi.spyOn(cloud, 'withLocalDataChange')
    await invoke(input(root, 'restore-file'), 'onChange', { target: { files: [{ size: backup.length, name: 'older.json', text: async () => backup }] } })
    await click(root, 'Validate & merge backup')
    expect(guard).toHaveBeenCalledTimes(1)
    expect((await db.sessions.get('later'))?.draft.answer).toBe('Later work')
    expect((await new SyncJournal(db).pending()).some(row => row.kind === 'delete')).toBe(false)
    expect((await db.syncMeta.get('owner'))?.value).toBe(owner)
    expect(content(root)).toContain('Backup merged with retained learning history')
  })
  it('retains the selected invalid backup and original data for correction/retry', async () => {
    const root = mount(), before = await db.syncOperations.toArray()
    await invoke(input(root, 'restore-file'), 'onChange', { target: { files: [{ size: 7, name: 'invalid.json', text: async () => '{broken' }] } })
    await click(root, 'Validate & merge backup')
    expect(content(root)).toContain('Backup is not valid JSON')
    expect(content(root)).toContain('invalid.json')
    expect(await db.syncOperations.toArray()).toEqual(before)
    expect(await db.audio.count()).toBe(2)
    expect(cloud.paused).toBe(false)
    await setImmediate()
  })
})
