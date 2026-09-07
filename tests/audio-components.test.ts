import { readFileSync } from 'node:fs'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import Dexie from 'dexie'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'
import * as Vue from 'vue'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRequest } from '../src/composables/useRequest'
import * as recovery from '../src/audio/recovery'
import * as shortcuts from '../src/audio/shortcuts'
import * as cache from '../src/audio/cache'
import { AudioError } from '../src/audio/recorder'
import { defaultSettings, type AudioAsset } from '../src/domain/types'

// Exercise the actual compiled SFCs and Vue lifecycle without adding jsdom/test-utils.
class HostNode {
  parent: HostNode | null = null
  children: HostNode[] = []
  props: Record<string, unknown> = {}
  text = ''
  duration = 0; currentTime = 0; playbackRate = 1
  play = vi.fn(async () => { invoke(this, 'onPlay') })
  pause = vi.fn(() => { invoke(this, 'onPause') })
  constructor(readonly type: string) {}
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)) }
  getClientRects() { return this.parent ? [{}] : [] }
  closest(selector: string): HostNode | null {
    const matches = selector.split(',').some(value => {
      const part = value.trim()
      return part === this.type || (part === '[contenteditable]' && 'contenteditable' in this.props)
        || part === '[role="' + this.props.role + '"]'
    })
    return matches ? this : this.parent?.closest(selector) ?? null
  }
}
function invoke(node: HostNode, name: string, event?: unknown): unknown {
  const action = node.props[name]
  if (typeof action === 'function') return action(event)
}
function content(node: HostNode): string { return node.text + node.children.map(content).join('') }
function find(node: HostNode, predicate: (node: HostNode) => boolean): HostNode | undefined {
  if (predicate(node)) return node
  for (const child of node.children) { const match = find(child, predicate); if (match) return match }
}
function button(root: HostNode, label: string): HostNode {
  const found = find(root, node => node.type === 'button' && (content(node).includes(label) || node.props['aria-label'] === label))
  if (!found) throw new Error('Missing button: ' + label + '; rendered: ' + content(root))
  return found
}
const renderer = Vue.createRenderer<HostNode, HostNode>({
  createElement: type => new HostNode(type), createText: text => Object.assign(new HostNode('#text'), { text }),
  createComment: text => Object.assign(new HostNode('#comment'), { text }),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text; node.children = [] },
  patchProp: (node, key, _old, value) => { node.props[key] = value },
  insert: (node, parent, anchor = null) => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node)
  },
  remove: node => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
})
const mounted: Vue.App[] = []
const guards: (() => Promise<boolean>)[] = []
function mount(component: Vue.Component, initial: Record<string, unknown> = {}) {
  const props = Vue.reactive(initial), root = new HostNode('root')
  const played = vi.fn(), ended = vi.fn(), recorded = vi.fn(), transcribed = vi.fn(), active = vi.fn()
  const child = Vue.shallowRef<{ toggle: () => Promise<void>; stop: () => void }>()
  const app = renderer.createApp({ setup: () => () => Vue.h(component, { ...props, ref: child, onPlayed: played, onEnded: ended, onRecorded: recorded, onTranscribed: transcribed, onActive: active }) })
  app.component('RouterLink', { setup: (_props: Record<string, unknown>, { slots }: Vue.SetupContext) => () => Vue.h('a', slots.default?.()) })
  app.mount(root); mounted.push(app)
  return { root, props, child, played, ended, recorded, transcribed, active, unmount: () => { app.unmount(); mounted.splice(mounted.indexOf(app), 1) } }
}
async function flush() { for (let i = 0; i < 4; i++) { await yieldImmediate(); await Vue.nextTick() } }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const makeAsset = (id: string): AudioAsset => ({ id, blob: new Blob(['original-' + id], { type: 'audio/webm' }), duration: 2, mimeType: 'audio/webm', createdAt: 1, kind: 'recording', processed: false, label: 'Saved response' })
let rows: Map<string, AudioAsset>
let appState: ReturnType<typeof makeState>
let capture: { stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
const startRecording = vi.fn()
const db = { audio: { put: vi.fn(), get: vi.fn(), update: vi.fn(), toArray: vi.fn() }, transaction: vi.fn() }
const localSpeech = { speakLocalText: vi.fn(), stopSpeech: vi.fn(), pauseSpeech: vi.fn(), resumeSpeech: vi.fn() }
let Recorder: Vue.Component, AudioPlayer: Vue.Component
function makeState() {
  return Vue.reactive({ audio: [] as AudioAsset[], settings: { ...defaultSettings, ttsModel: 'test/tts', voice: 'a' }, keySet: true, online: true,
    refresh: vi.fn(async () => { appState.audio = [...rows.values()] }),
    provider: { transcribe: vi.fn(async () => 'My original words.') }, generatedSpeech: vi.fn<(text: string, signal?: AbortSignal) => Promise<Blob>>() })
}
function loadSfc(name: string): Vue.Component {
  const source = readFileSync(new URL('../src/components/' + name, import.meta.url), 'utf8').replaceAll('import.meta.env.BASE_URL', '"/jove-english-os/"')
  const { descriptor } = parse(source, { filename: name })
  const script = compileScript(descriptor, { id: name, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const code = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const dependencies: Record<string, unknown> = {
    vue: Vue, 'vue-router': { onBeforeRouteLeave: (guard: () => Promise<boolean>) => guards.push(guard) },
    '../stores/app': { useApp: () => appState }, '../db/db': { db }, '../audio/recorder': { AudioError, startRecording },
    '../audio/recovery': recovery, '../audio/shortcuts': shortcuts, '../audio/cache': cache,
    '../composables/useRequest': { useRequest }, '../audio/speech': localSpeech,
    './Icon.vue': { default: { setup: () => () => Vue.h('i') } },
  }
  const exports: { default?: Vue.Component } = {}
  // Evaluate only our local compiler output; runtime application code never evaluates imported text.
  new Function('require', 'exports', code)((id: string) => {
    if (!(id in dependencies)) throw new Error('Unmapped test module: ' + id)
    return dependencies[id]
  }, exports)
  return exports.default!
}
beforeAll(() => { Recorder = loadSfc('Recorder.vue'); AudioPlayer = loadSfc('AudioPlayer.vue') })
beforeEach(() => {
  rows = new Map(); guards.length = 0; recovery.recordingDrafts.clear()
  appState = makeState()
  capture = { stop: vi.fn(async () => ({ blob: new Blob(['captured'], { type: 'audio/webm' }), duration: 4 })), cancel: vi.fn() }
  startRecording.mockReset().mockResolvedValue(capture)
  db.audio.put.mockReset().mockImplementation(async (asset: AudioAsset) => { rows.set(asset.id, asset); return asset.id })
  db.audio.toArray.mockReset().mockImplementation(async () => [...rows.values()])
  db.transaction.mockReset().mockImplementation((_mode: string, _table: unknown, work: () => Promise<unknown>) => work())
  db.audio.get.mockReset().mockImplementation(async (id: string) => rows.get(id))
  db.audio.update.mockReset().mockImplementation(async (id: string, changes: Partial<AudioAsset>) => { const row = rows.get(id); if (row) rows.set(id, { ...row, ...changes }); return row ? 1 : 0 })
  for (const mock of Object.values(localSpeech)) mock.mockReset()
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('Element', HostNode)
  vi.stubGlobal('location', { hash: '#/speak' })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:test/' + crypto.randomUUID())
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})
afterEach(async () => {
  for (const app of mounted.splice(0)) app.unmount()
  await flush()
  recovery.recordingDrafts.clear()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('Recorder component recovery lifecycle', () => {
  it('synchronizes a saved ID delivered after mount and subsequent replacement', async () => {
    appState.audio = [makeAsset('one'), makeAsset('two')]
    const view = mount(Recorder)
    expect(find(view.root, node => node.type === 'audio')).toBeUndefined()
    view.props.savedAudioId = 'one'; await flush()
    expect(content(view.root)).toContain('Saved on this device')
    expect(URL.createObjectURL).toHaveBeenLastCalledWith(appState.audio[0]!.blob)
    view.props.savedAudioId = 'two'; await flush()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).toHaveBeenLastCalledWith(appState.audio[1]!.blob)
  })
  it('retains the original Blob on save failure and retries the same asset before allowing STT', async () => {
    db.audio.put.mockRejectedValueOnce(new Error('QuotaExceeded'))
    const view = mount(Recorder)
    await view.child.value!.toggle(); await view.child.value!.toggle(); await flush()
    const draft = [...recovery.recordingDrafts.values()][0]!
    expect(draft.asset.blob.size).toBeGreaterThan(0)
    expect(content(view.root)).toContain('not yet saved')
    expect(find(view.root, node => node.type === 'a' && content(node).includes('Download recording'))).toBeDefined()
    expect(view.recorded).not.toHaveBeenCalled(); expect(appState.provider.transcribe).not.toHaveBeenCalled()
    await invoke(button(view.root, 'Retry saving recording'), 'onClick'); await flush()
    expect(db.audio.put.mock.calls[1]![0]).toBe(draft.asset)
    expect(view.recorded).toHaveBeenCalledWith({ audioId: draft.asset.id, duration: 4 })
    await invoke(button(view.root, 'Transcribe recording'), 'onClick'); await flush()
    expect(db.audio.get).toHaveBeenCalledWith(draft.asset.id)
    expect(appState.provider.transcribe).toHaveBeenCalledWith(draft.asset.blob, expect.any(AbortSignal))
    expect(view.transcribed).toHaveBeenCalledWith('My original words.')
  })
  it('keeps a committed recording usable when library refresh fails', async () => {
    appState.refresh.mockRejectedValue(new Error('refresh failed'))
    const view = mount(Recorder)
    await view.child.value!.toggle(); await view.child.value!.toggle(); await flush()
    expect(rows.size).toBe(1); expect(view.recorded).toHaveBeenCalledTimes(1)
    expect(content(view.root)).toContain('Saved on this device')
    expect(recovery.recordingDrafts.size).toBe(0)
  })
  it('blocks navigation on save failure and permits it after retry commits', async () => {
    const view = mount(Recorder)
    await view.child.value!.toggle()
    db.audio.put.mockRejectedValueOnce(new Error('disk full'))
    await expect(guards[0]!()).resolves.toBe(false)
    expect(capture.cancel).not.toHaveBeenCalled()
    await expect(guards[0]!()).resolves.toBe(true)
    expect(rows.size).toBe(1)
  })
  it('awaits the final audio and commit before leaving', async () => {
    const storage = deferred<string>()
    db.audio.put.mockReturnValue(storage.promise)
    const view = mount(Recorder)
    await view.child.value!.toggle()
    let left = false
    const leaving = guards[0]!().then(result => { left = result })
    await flush(); expect(left).toBe(false)
    storage.resolve('stored'); await leaving
    expect(left).toBe(true); expect(view.recorded).toHaveBeenCalledTimes(1)
  })
  it('salvages forced-unmount recording and can recover it after a remount', async () => {
    db.audio.put.mockRejectedValueOnce(new Error('disk full'))
    const first = mount(Recorder)
    await first.child.value!.toggle(); first.unmount(); await flush()
    expect(capture.stop).toHaveBeenCalledTimes(1); expect(capture.cancel).not.toHaveBeenCalled()
    expect(recovery.recordingDrafts.size).toBe(1)
    const closeTab = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(closeTab); expect(closeTab.defaultPrevented).toBe(true)
    const second = mount(Recorder); await flush()
    expect(content(second.root)).toContain('not yet saved')
    await invoke(button(second.root, 'Retry saving recording'), 'onClick'); await flush()
    expect(second.recorded).toHaveBeenCalledTimes(1); expect(recovery.recordingDrafts.size).toBe(0)
  })
  it('concurrent save and route leave share the write and attach only once', async () => {
    const storage = deferred<string>()
    db.audio.put.mockReturnValue(storage.promise)
    const view = mount(Recorder)
    await view.child.value!.toggle()
    const stopping = view.child.value!.toggle(); await flush()
    const leaving = guards[0]!()
    storage.resolve('saved'); await stopping; await leaving
    expect(db.audio.put).toHaveBeenCalledTimes(1)
    expect(view.recorded).toHaveBeenCalledTimes(1)
  })
  it('stops and retains a microphone handle that arrives after unmount', async () => {
    const permission = deferred<typeof capture>()
    startRecording.mockReturnValue(permission.promise)
    const view = mount(Recorder)
    const starting = view.child.value!.toggle(); await flush(); view.unmount()
    permission.resolve(capture); await starting; await flush()
    expect(capture.stop).toHaveBeenCalledTimes(1); expect(capture.cancel).not.toHaveBeenCalled()
    expect(rows.size).toBe(1)
  })
  it('keeps the transcript when recording metadata update fails', async () => {
    const asset = makeAsset('existing'); rows.set(asset.id, asset); appState.audio = [asset]
    db.audio.update.mockRejectedValue(new Error('metadata'))
    const view = mount(Recorder, { savedAudioId: asset.id })
    await invoke(button(view.root, 'Transcribe recording'), 'onClick'); await flush()
    expect(view.transcribed).toHaveBeenCalledWith('My original words.')
    expect(content(view.root)).toContain('Transcript: My original words.')
    expect(rows.get(asset.id)?.blob).toBe(asset.blob)
  })
  it('R starts only one visible recorder and ignores form editing/repeat/modifiers', async () => {
    const first = mount(Recorder), second = mount(Recorder, { label: 'Another' })
    const key = (extra: object = {}) => { const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'r', ...extra }); window.dispatchEvent(event); return event }
    const doc = document as unknown as { activeElement: HostNode | null }
    for (const type of ['input', 'textarea', 'select', 'button']) { doc.activeElement = new HostNode(type); expect(key().defaultPrevented).toBe(false) }
    doc.activeElement = Object.assign(new HostNode('div'), { props: { contenteditable: 'true' } })
    expect(key().defaultPrevented).toBe(false)
    doc.activeElement = null
    expect(key({ repeat: true }).defaultPrevented).toBe(false)
    expect(key({ ctrlKey: true }).defaultPrevented).toBe(false)
    expect(startRecording).not.toHaveBeenCalled()
    expect(key().defaultPrevented).toBe(true); await flush()
    expect(startRecording).toHaveBeenCalledTimes(1)
    expect(content(first.root)).toContain('Stop & save'); expect(content(second.root)).toContain('Record response')
    key(); await flush(); expect(rows.size).toBe(1)
  })
})

describe('Recorder parent activity guard', () => {
  it('stays active from startup through capture, failed save and disabled recovery retry without a handoff gap', async () => {
    const permission = deferred<typeof capture>(), finalAudio = deferred<{ blob: Blob; duration: number }>(), storage = deferred<string>()
    startRecording.mockReturnValue(permission.promise)
    capture.stop.mockReturnValue(finalAudio.promise)
    db.audio.put.mockReturnValueOnce(storage.promise)
    const view = mount(Recorder)
    expect(view.active.mock.calls).toEqual([[false]])
    const starting = view.child.value!.toggle()
    expect(view.active.mock.calls).toEqual([[false], [true]]) // Before the first await.
    await flush(); permission.resolve(capture); await starting
    const stopping = view.child.value!.toggle()
    expect(view.active.mock.calls).toEqual([[false], [true]])
    finalAudio.resolve({ blob: new Blob(['retained']), duration: 4 }); await flush()
    expect(view.active.mock.calls).toEqual([[false], [true]])
    storage.reject(new Error('QuotaExceeded')); await stopping; await flush()
    expect(view.active.mock.calls).toEqual([[false], [true]])
    expect(recovery.recordingDrafts.size).toBe(1)
    view.props.disabled = true; await flush()
    expect(button(view.root, 'Retry saving recording').props.disabled).toBe(false)
    await invoke(button(view.root, 'Retry saving recording'), 'onClick'); await flush()
    expect(view.active.mock.calls).toEqual([[false], [true], [false]])
    expect(view.recorded.mock.invocationCallOrder[0]!).toBeLessThan(view.active.mock.invocationCallOrder[2]!)
    expect(rows.size).toBe(1); expect(recovery.recordingDrafts.size).toBe(0)
  })

  it.each(['button', 'R'])('disabled blocks start and STT but still permits %s to stop and save', async control => {
    const asset = makeAsset('saved'); rows.set(asset.id, asset); appState.audio = [asset]
    const view = mount(Recorder, { savedAudioId: asset.id, disabled: true })
    expect(view.active.mock.calls).toEqual([[false]]) // Saved playback does not lock the parent.
    expect(button(view.root, 'Record again').props.disabled).toBe(true)
    expect(button(view.root, 'Transcribe recording').props.disabled).toBe(true)
    await view.child.value!.toggle()
    await invoke(button(view.root, 'Transcribe recording'), 'onClick')
    const key = () => { const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'r' }); window.dispatchEvent(event); return event }
    expect(key().defaultPrevented).toBe(false)
    expect(startRecording).not.toHaveBeenCalled(); expect(appState.provider.transcribe).not.toHaveBeenCalled()
    view.props.disabled = false; await flush(); await view.child.value!.toggle()
    view.props.disabled = true; await flush()
    expect(button(view.root, 'Stop & save').props.disabled).toBe(false)
    if (control === 'button') await invoke(button(view.root, 'Stop & save'), 'onClick')
    else expect(key().defaultPrevented).toBe(true)
    await flush()
    expect(capture.stop).toHaveBeenCalledTimes(1); expect(capture.cancel).not.toHaveBeenCalled()
    expect(view.recorded).toHaveBeenCalledTimes(1); expect(view.active.mock.calls).toEqual([[false], [true], [false]])
  })

  it('rechecks disabled after awaited storage preparation before opening the microphone or sending STT', async () => {
    const preflight = deferred<AudioAsset[]>()
    db.audio.toArray.mockReturnValueOnce(preflight.promise)
    const asset = makeAsset('saved'); rows.set(asset.id, asset); appState.audio = [asset]
    const view = mount(Recorder, { savedAudioId: asset.id })
    const starting = view.child.value!.toggle()
    view.props.disabled = true; await flush(); preflight.resolve([asset]); await starting
    expect(startRecording).not.toHaveBeenCalled(); expect(view.active).toHaveBeenLastCalledWith(false)
    view.props.disabled = false; await flush()
    const readback = deferred<AudioAsset>()
    db.audio.get.mockReturnValueOnce(readback.promise)
    const transcribing = invoke(button(view.root, 'Transcribe recording'), 'onClick')
    expect(view.active).toHaveBeenLastCalledWith(true)
    view.props.disabled = true; await flush(); readback.resolve(asset); await transcribing
    expect(appState.provider.transcribe).not.toHaveBeenCalled(); expect(view.active).toHaveBeenLastCalledWith(false)
    expect(rows.get(asset.id)?.blob).toBe(asset.blob)
  })

  it('keeps the parent active through STT result delivery and metadata completion', async () => {
    const asset = makeAsset('saved'); rows.set(asset.id, asset); appState.audio = [asset]
    const response = deferred<string>(), metadata = deferred<number>()
    appState.provider.transcribe.mockReturnValueOnce(response.promise)
    db.audio.update.mockReturnValueOnce(metadata.promise)
    const view = mount(Recorder, { savedAudioId: asset.id })
    const transcribing = invoke(button(view.root, 'Transcribe recording'), 'onClick')
    expect(view.active.mock.calls).toEqual([[false], [true]])
    await flush(); response.resolve('The current transcript.'); await flush()
    expect(view.transcribed).toHaveBeenCalledWith('The current transcript.')
    expect(view.active.mock.calls).toEqual([[false], [true]])
    metadata.resolve(1); await transcribing
    expect(view.active.mock.calls).toEqual([[false], [true], [false]])
    expect(view.transcribed.mock.invocationCallOrder[0]!).toBeLessThan(view.active.mock.invocationCallOrder[2]!)
  })

  it.each(['failure', 'cancel'])('releases STT activity after %s without replacing input or losing saved audio', async outcome => {
    const asset = makeAsset('saved'); rows.set(asset.id, asset); appState.audio = [asset]
    const response = deferred<string>()
    appState.provider.transcribe.mockReturnValueOnce(response.promise)
    const view = mount(Recorder, { savedAudioId: asset.id })
    const transcribing = invoke(button(view.root, 'Transcribe recording'), 'onClick'); await flush()
    if (outcome === 'cancel') { invoke(button(view.root, 'Cancel'), 'onClick'); response.resolve('Ignored late transcript.') }
    else response.reject(new Error('Transcription unavailable'))
    await transcribing; await flush()
    expect(view.active.mock.calls).toEqual([[false], [true], [false]])
    expect(view.transcribed).not.toHaveBeenCalled(); expect(rows.get(asset.id)?.blob).toBe(asset.blob)
  })
})

describe('Recorder configured audio capacity', () => {
  const limitBytes = 25 * 1024 * 1024
  const fullBlob = new Blob([new Uint8Array(limitBytes)], { type: 'audio/webm' })
  const storedAudio = (id: string, blob = fullBlob, kind: AudioAsset['kind'] = 'recording'): AudioAsset => ({ ...makeAsset(id), blob, kind })

  it('does not open the microphone when persisted audio already fills the configured 25 MiB', async () => {
    appState.settings.audioLimitMB = 25
    const original = storedAudio('original')
    rows.set(original.id, original)
    appState.audio = [] // A stale store projection must not bypass the persisted capacity check.
    const view = mount(Recorder)
    await view.child.value!.toggle(); await flush()
    expect(startRecording).not.toHaveBeenCalled()
    expect(content(view.root)).toContain('audio storage limit')
    expect(db.audio.put).not.toHaveBeenCalled()
    expect(rows.size).toBe(1); expect(rows.get(original.id)?.blob).toBe(fullBlob)
  })
  it('counts generated and imported audio along with original recordings', async () => {
    appState.settings.audioLimitMB = 25
    rows.set('original', storedAudio('original', fullBlob.slice(0, 10 * 1024 * 1024)))
    rows.set('generated', storedAudio('generated', fullBlob.slice(0, 10 * 1024 * 1024), 'generated'))
    rows.set('imported', storedAudio('imported', fullBlob.slice(0, 5 * 1024 * 1024), 'import'))
    const view = mount(Recorder)
    await view.child.value!.toggle()
    expect(startRecording).not.toHaveBeenCalled()
    expect(rows.size).toBe(3); expect(db.audio.put).not.toHaveBeenCalled()
  })
  it('retains a captured Blob when concurrent storage consumes room, then retries without deleting originals', async () => {
    appState.settings.audioLimitMB = 25
    const view = mount(Recorder)
    await view.child.value!.toggle()
    const concurrent = storedAudio('concurrent')
    rows.set(concurrent.id, concurrent)
    await view.child.value!.toggle(); await flush()
    const draft = [...recovery.recordingDrafts.values()][0]!
    expect(draft.saved).toBe(false)
    expect(await draft.asset.blob.text()).toBe('captured')
    expect(content(view.root)).toContain('audio storage limit')
    expect(content(view.root)).toContain('not yet saved')
    expect(find(view.root, node => node.type === 'a' && content(node).includes('Download recording'))).toBeDefined()
    expect(db.transaction).toHaveBeenCalledWith('rw', db.audio, expect.any(Function))
    expect(db.audio.put).not.toHaveBeenCalled()
    expect(view.recorded).not.toHaveBeenCalled(); expect(appState.provider.transcribe).not.toHaveBeenCalled()
    expect(rows.get(concurrent.id)?.blob).toBe(fullBlob)
    appState.settings.audioLimitMB = 26
    await invoke(button(view.root, 'Retry saving recording'), 'onClick'); await flush()
    expect(db.audio.put).toHaveBeenCalledWith(draft.asset)
    expect(view.recorded).toHaveBeenCalledWith({ audioId: draft.asset.id, duration: 4 })
    expect(rows.size).toBe(2); expect(rows.get(concurrent.id)?.blob).toBe(fullBlob)
    expect(recovery.recordingDrafts.size).toBe(0)
  })
  it('uses the latest limit at save time if Settings changed during capture', async () => {
    appState.settings.audioLimitMB = 26
    rows.set('original', storedAudio('original'))
    const view = mount(Recorder)
    await view.child.value!.toggle()
    appState.settings.audioLimitMB = 25
    await view.child.value!.toggle(); await flush()
    expect(db.audio.put).not.toHaveBeenCalled()
    expect(recovery.recordingDrafts.size).toBe(1)
    await expect(guards[0]!()).resolves.toBe(false)
    expect(rows.get('original')?.blob).toBe(fullBlob)
  })
  it('allows a recording that fits the byte limit exactly', async () => {
    appState.settings.audioLimitMB = 25
    rows.set('original', storedAudio('original', fullBlob.slice(0, limitBytes - 8)))
    const view = mount(Recorder)
    await view.child.value!.toggle(); await view.child.value!.toggle()
    expect([...rows.values()].reduce((bytes, asset) => bytes + asset.blob.size, 0)).toBe(limitBytes)
    expect(view.recorded).toHaveBeenCalledTimes(1)
    expect(recovery.recordingDrafts.size).toBe(0)
  })
  it('fails before microphone permission when storage cannot be read', async () => {
    db.audio.toArray.mockRejectedValueOnce(new Error('IndexedDB unavailable'))
    const view = mount(Recorder)
    await view.child.value!.toggle(); await flush()
    expect(startRecording).not.toHaveBeenCalled()
    expect(content(view.root)).toContain('Audio storage could not be checked')
  })
  it('does not ask for microphone permission if unmounted during capacity preflight', async () => {
    const capacity = deferred<AudioAsset[]>()
    db.audio.toArray.mockReturnValueOnce(capacity.promise)
    const view = mount(Recorder)
    const starting = view.child.value!.toggle(); view.unmount()
    capacity.resolve([]); await starting
    expect(startRecording).not.toHaveBeenCalled()
  })
  it('serializes two real Dexie read/write transactions so only one capture fits', async () => {
    const liveDb = new Dexie('audio-capacity-test-' + crypto.randomUUID(), { indexedDB, IDBKeyRange })
    liveDb.version(1).stores({ audio: 'id' })
    const table = liveDb.table<AudioAsset>('audio')
    try {
      appState.settings.audioLimitMB = 25
      await table.put(storedAudio('original', fullBlob.slice(0, limitBytes - 8)))
      db.audio.toArray.mockImplementation(() => table.toArray())
      db.audio.put.mockImplementation((asset: AudioAsset) => table.put(asset))
      db.transaction.mockImplementation((_mode: string, _table: unknown, work: () => Promise<unknown>) => liveDb.transaction('rw', table, work))
      const first = mount(Recorder, { label: 'First concurrent recording' })
      const second = mount(Recorder, { label: 'Second concurrent recording' })
      await Promise.all([first.child.value!.toggle(), second.child.value!.toggle()])
      expect(startRecording).toHaveBeenCalledTimes(2)
      await Promise.all([first.child.value!.toggle(), second.child.value!.toggle()]); await flush()
      const stored = await table.toArray()
      expect(stored).toHaveLength(2)
      expect(stored.reduce((bytes, asset) => bytes + asset.blob.size, 0)).toBe(limitBytes)
      expect(first.recorded.mock.calls.length + second.recorded.mock.calls.length).toBe(1)
      const pending = [...recovery.recordingDrafts.values()]
      expect(pending).toHaveLength(1); expect(pending[0]?.saved).toBe(false)
      expect(await pending[0]!.asset.blob.text()).toBe('captured')
      expect((await table.get('original'))?.blob.size).toBe(limitBytes - 8)
      first.unmount(); second.unmount()
    } finally { await liveDb.delete() }
  })
})

describe('AudioPlayer completion, fallback and request identity', () => {
  it('emits played separately and ended only on actual bundled audio completion', async () => {
    const view = mount(AudioPlayer, { src: 'audio/demo.wav', text: 'Hello.' })
    await view.child.value!.toggle(); await flush()
    const audio = find(view.root, node => node.type === 'audio')!
    expect(audio.props.src).toBe('/jove-english-os/audio/demo.wav')
    expect(view.played).toHaveBeenCalledTimes(1); expect(view.ended).not.toHaveBeenCalled()
    invoke(audio, 'onEnded'); expect(view.ended).toHaveBeenCalledTimes(1)
    await view.child.value!.toggle(); view.child.value!.stop()
    invoke(audio, 'onEnded'); expect(view.ended).toHaveBeenCalledTimes(1)
  })
  it('uses the configured generated cache and saves measured duration against its identity', async () => {
    const blob = new Blob(['mp3'], { type: 'audio/mpeg' })
    const id = await cache.speechCacheId(cache.speechIdentity('Hello.', appState.settings))
    rows.set(id, { ...makeAsset(id), kind: 'generated', blob, mimeType: blob.type, duration: 0 })
    appState.generatedSpeech.mockResolvedValue(blob)
    const view = mount(AudioPlayer, { text: 'Hello.' })
    await view.child.value!.toggle(); await flush()
    expect(appState.generatedSpeech).toHaveBeenCalledWith('Hello.', expect.any(AbortSignal))
    const audio = find(view.root, node => node.type === 'audio')!
    audio.duration = 3.25; await invoke(audio, 'onLoadedmetadata')
    expect(db.audio.update).toHaveBeenCalledWith(id, { duration: 3.25 })
    invoke(audio, 'onEnded'); expect(view.ended).toHaveBeenCalledTimes(1)
    expect(localSpeech.speakLocalText).not.toHaveBeenCalled()
  })
  it('can play cached generated audio offline without silently using a browser voice', async () => {
    appState.online = false
    appState.generatedSpeech.mockResolvedValue(new Blob(['cache'], { type: 'audio/mpeg' }))
    const view = mount(AudioPlayer, { text: 'Hello.' })
    await view.child.value!.toggle(); await flush()
    expect(view.played).toHaveBeenCalledTimes(1)
    expect(localSpeech.speakLocalText).not.toHaveBeenCalled()
  })
  it('offers explicit local fallback after failure; actual local end and pause are separate', async () => {
    appState.online = false
    appState.generatedSpeech.mockRejectedValue(new Error('No cached audio'))
    const local = deferred<void>()
    localSpeech.speakLocalText.mockReturnValue(local.promise)
    const view = mount(AudioPlayer, { text: 'Hello.' })
    await view.child.value!.toggle(); await flush()
    expect(localSpeech.speakLocalText).not.toHaveBeenCalled()
    const pending = invoke(button(view.root, 'Play with a local device voice'), 'onClick')
    const events = localSpeech.speakLocalText.mock.calls[0]![2] as { onStart: () => void; onEnd: () => void }
    expect(view.played).not.toHaveBeenCalled(); expect(view.ended).not.toHaveBeenCalled()
    events.onStart(); await view.child.value!.toggle(); expect(localSpeech.pauseSpeech).toHaveBeenCalled()
    await view.child.value!.toggle(); expect(localSpeech.resumeSpeech).toHaveBeenCalled()
    expect(view.ended).not.toHaveBeenCalled()
    events.onEnd(); local.resolve(); await pending
    expect(view.played).toHaveBeenCalledTimes(1); expect(view.ended).toHaveBeenCalledTimes(1)
  })
  it('does not emit completed audio when local playback is cancelled', async () => {
    appState.keySet = false
    const local = deferred<void>(); localSpeech.speakLocalText.mockReturnValue(local.promise)
    const view = mount(AudioPlayer, { text: 'Hello.' })
    const pending = invoke(button(view.root, 'Play with a local device voice'), 'onClick')
    view.child.value!.stop(); local.resolve(); await pending
    expect(view.ended).not.toHaveBeenCalled()
  })
  it('rejects stale generated audio after text or voice changes and accepts a fresh request', async () => {
    const old = deferred<Blob>(); appState.generatedSpeech.mockReturnValueOnce(old.promise)
    const view = mount(AudioPlayer, { text: 'Old text.' })
    const original = view.child.value!.toggle(); await flush()
    view.props.text = 'New text.'; appState.settings.voice = 'b'; await flush()
    appState.generatedSpeech.mockResolvedValue(new Blob(['new'], { type: 'audio/mpeg' }))
    await view.child.value!.toggle()
    old.resolve(new Blob(['old'], { type: 'audio/mpeg' })); await original; await flush()
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(view.played).toHaveBeenCalledTimes(1)
    expect(appState.generatedSpeech.mock.calls[0]![1]?.aborted).toBe(true)
  })
  it('unmount cancels synthesis and does not allocate a late object URL', async () => {
    const synthesis = deferred<Blob>(); appState.generatedSpeech.mockReturnValue(synthesis.promise)
    const view = mount(AudioPlayer, { text: 'Hello.' })
    const pending = view.child.value!.toggle(); await flush(); view.unmount()
    synthesis.resolve(new Blob(['late'], { type: 'audio/mpeg' })); await pending
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(view.ended).not.toHaveBeenCalled()
  })
})

describe('useRequest cancellation identity', () => {
  function setup() {
    let request!: ReturnType<typeof useRequest>
    const view = mount({ setup() { request = useRequest(); return () => Vue.h('div') } })
    return { request, view }
  }
  it('old finally cannot clear a new request and late old success returns undefined', async () => {
    const { request } = setup(), first = deferred<string>(), second = deferred<string>()
    const old = request.run(() => first.promise)
    request.cancel(); const fresh = request.run(() => second.promise)
    first.resolve('stale'); await expect(old).resolves.toBeUndefined()
    expect(request.busy.value).toBe(true)
    second.resolve('current'); await expect(fresh).resolves.toBe('current')
    expect(request.busy.value).toBe(false)
  })
  it('ignores a cancelled old failure and keeps the current error state', async () => {
    const { request } = setup(), first = deferred<string>(), second = deferred<string>()
    const old = request.run(() => first.promise); request.cancel()
    const fresh = request.run(() => second.promise)
    first.reject(new Error('old failure')); await old
    expect(request.error.value).toBe(''); expect(request.busy.value).toBe(true)
    second.reject(new Error('current failure')); await fresh
    expect(request.error.value).toBe('current failure')
  })
  it('unmount suppresses late results and prevents future requests', async () => {
    const { request, view } = setup(), pending = deferred<string>()
    const result = request.run(() => pending.promise); view.unmount()
    pending.resolve('late'); await expect(result).resolves.toBeUndefined()
    const callback = vi.fn(async () => 'must not run')
    await request.run(callback); expect(callback).not.toHaveBeenCalled()
  })
})
