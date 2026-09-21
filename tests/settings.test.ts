import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { compileScript, parse } from '@vue/compiler-sfc'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import * as Vue from 'vue'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, JoveDatabase } from '../src/db/db'
import * as repository from '../src/db/repository'
import * as localChange from '../src/sync/local-change'
import { SyncJournal } from '../src/sync/journal'
import { createCloudState } from '../src/stores/cloud'
import { createJapaneseSpace } from '../src/stores/japanese-space'
import { audioHash } from '../src/sync/audio'
import { useRequest } from '../src/composables/useRequest'
import { defaultProfile, defaultSettings, type AudioAsset, type Usage } from '../src/domain/types'

// Actual Settings SFC events + real repository/Dexie/store, without a new DOM dependency.
class Node {
  parent: Node | null = null
  children: Node[] = []
  props: Record<string, unknown> = {}
  text = ''; value = ''; tagName: string
  get options() { return this.children.filter(child => child.type === 'option') }
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
let ja: JoveDatabase, japanese: ReturnType<typeof makeJapanese>
function makeJapanese() { return Vue.reactive(createJapaneseSpace(db, { settle: cloud.settle, signOut: cloud.signOut, ownerId: () => '' }, ja,
  database => createCloudState(database, null))) }
async function openJapanese() {
  await new SyncJournal(ja).bindOwner(owner); await japanese.ensure()
}
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
    vue: Vue, dexie: { default: Dexie }, '../db/db': { db }, '../db/repository': repository, '../sync/local-change': localChange,
    '../stores/japanese-space': { useJapaneseSpace: () => japanese },
    '../release-flags': { japaneseEnabled: true },
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
  ja = new JoveDatabase(`settings-ja-${crypto.randomUUID()}`, 'ja'); japanese = makeJapanese()
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('Document', class {})
  vi.stubGlobal('ShadowRoot', class {})
})
afterEach(async () => {
  for (const app of mounted.splice(0)) app.unmount()
  await cloud.stop(); await japanese.stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.delete(); await ja.delete()
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
  it('does not create Japanese from English Settings or exporting an unopened Japanese space', async () => {
    const root = mount()
    await invoke(input(root, 'data-language'), 'onUpdate:modelValue', 'ja')
    await click(root, 'Export backup')
    expect(content(root)).toContain('请先打开日语学习区')
    expect((await Dexie.getDatabaseNames()).includes(ja.name)).toBe(false)
  })
  it('merges a Japanese backup through its own guard and retains both languages and originals', async () => {
    await openJapanese()
    await ja.profiles.update('main', { goal: '日语目标' })
    const backup = await repository.exportBackup(ja)
    await ja.sessions.put({ id: 'later-ja', kind: 'listen', stage: 'draft', startedAt: 1788815000001, draft: { answer: '日语新草稿' } })
    await ja.audio.put({ ...original(), id: 'ja-original' })
    const root = mount(), enGuard = vi.spyOn(cloud, 'withLocalDataChange'), jaGuard = vi.spyOn(japanese, 'withLocalDataChange')
    await invoke(input(root, 'data-language'), 'onUpdate:modelValue', 'ja')
    await invoke(input(root, 'restore-file'), 'onChange', { target: { files: [{ size: backup.length, name: 'japanese.json', text: async () => backup }] } })
    await click(root, 'Validate & merge backup')
    expect(jaGuard).toHaveBeenCalledOnce(); expect(enGuard).not.toHaveBeenCalled()
    expect(content(root)).toContain('Backup merged with retained learning history')
    expect((await ja.profiles.get('main'))?.goal).toBe('日语目标')
    expect((await ja.sessions.get('later-ja'))?.draft.answer).toBe('日语新草稿')
    expect((await db.sessions.get('unfinished'))?.draft.answer).toBe('Saved text')
    expect((await db.profiles.get('main'))?.goal).not.toBe('日语目标')
    expect((await ja.audio.get('ja-original'))?.blob.size).toBe(original().blob.size)
    expect((await ja.syncMeta.get('owner'))?.value).toBe(owner)
    expect((await new SyncJournal(ja).pending()).some(row => row.kind === 'delete')).toBe(false)
  })
  it('rejects English content despite a Japanese filename and clears the pending import on language change', async () => {
    await openJapanese()
    const backup = await repository.exportBackup(), before = await ja.syncOperations.toArray(), root = mount()
    await invoke(input(root, 'data-language'), 'onUpdate:modelValue', 'ja')
    await invoke(input(root, 'restore-file'), 'onChange', { target: { files: [{ size: backup.length, name: 'japanese.json', text: async () => backup }] } })
    await click(root, 'Validate & merge backup')
    expect(content(root)).toContain('another learning language'); expect(content(root)).toContain('japanese.json')
    expect(await ja.syncOperations.toArray()).toEqual(before)
    await invoke(input(root, 'data-language'), 'onUpdate:modelValue', 'en')
    expect(content(root)).not.toContain('japanese.json')
  })
  it('clears only selected Japanese caches and keeps originals and English caches', async () => {
    await openJapanese()
    await ja.audio.bulkPut([original(), { ...original(), id: 'ja-cache', kind: 'content-cache' }])
    const root = mount()
    await invoke(input(root, 'data-language'), 'onUpdate:modelValue', 'ja')
    await click(root, 'Clear reusable audio caches')
    expect(content(root)).toContain('日语可重新下载的音频缓存已清理')
    expect(await ja.audio.get('ja-cache')).toBeUndefined(); expect(await ja.audio.get('original')).toBeDefined()
    expect(await db.audio.get('cached')).toBeDefined(); expect(await db.audio.get('original')).toBeDefined()
  })
  it('does not attach a cancelled slow file read to a different language', async () => {
    const root = mount(); let release!: (text: string) => void
    const loading = invoke(input(root, 'restore-file'), 'onChange', { target: { files: [{ size: 20, name: 'slow.json', text: () => new Promise<string>(resolve => { release = resolve }) }] } })
    await Vue.nextTick()
    expect(input(root, 'data-language').props.disabled).toBe(true)
    await click(root, 'Cancel current request')
    await invoke(input(root, 'data-language'), 'onUpdate:modelValue', 'ja')
    release('{}'); await loading
    expect(content(root)).not.toContain('slow.json')
    expect(find(root, node => node.type === 'button' && content(node).includes('Validate & merge backup'))).toBeUndefined()
  })
})
