import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { compileScript, parse } from '@vue/compiler-sfc'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import * as Vue from 'vue'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountPreferences, AccountUsage } from '../src/cloud/services'

// Actual component/lifecycle/events; only authenticated service IO is replaced.
class Host {
  parent: Host | null = null; children: Host[] = []; props: Record<string, unknown> = {}
  text = ''; value = ''; checked = false
  constructor(readonly type: string) {}
}
const renderer = Vue.createRenderer<Host, Host>({
  createElement: type => new Host(type), createText: text => Object.assign(new Host('#text'), { text }),
  createComment: text => Object.assign(new Host('#comment'), { text }),
  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
  patchProp: (node, key, _old, value) => {
    node.props[key] = value
    if (key === 'value') node.value = String(value)
    if (key === 'checked') node.checked = Boolean(value)
  },
  insert: (node, parent, anchor = null) => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node)
  },
  remove: node => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
})
const text = (node: Host): string => node.text + node.children.map(text).join('')
function find(node: Host, predicate: (node: Host) => boolean): Host | undefined {
  if (predicate(node)) return node
  for (const child of node.children) { const match = find(child, predicate); if (match) return match }
}
function field(root: Host, label: string): Host {
  const group = find(root, node => node.type === 'label' && text(node).includes(label))
  if (!group) throw new Error('Missing field: ' + label)
  return find(group, node => ['input', 'select'].includes(node.type))!
}
async function change(node: Host) { await (node.props.onChange as (event: unknown) => Promise<void>)({ target: node }); await Vue.nextTick() }
async function flush() { for (let i = 0; i < 4; i++) { await setImmediate(); await Vue.nextTick() } }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const preferences: AccountPreferences = { daily_budget_usd: 1, monthly_budget_usd: 30, recording_retention: 'minimal', prosody_enabled: true }
const period = { startsAt: '2026-09-08T00:00:00Z', reportedUsd: 0.04, heldUsd: 0.2, requests: 2, unknownCount: 1 }
const usage: AccountUsage = { today: period, week: period, month: period }
const result = () => ({ preferences: { ...preferences }, usage: structuredClone(usage) })
const read = vi.fn<(_access?: unknown, signal?: AbortSignal) => Promise<ReturnType<typeof result>>>()
const save = vi.fn<(patch: Partial<AccountPreferences>, _access?: unknown, signal?: AbortSignal) => Promise<AccountPreferences>>()
let cloud: { userId: string }, component: Vue.Component
const mounted: Vue.App[] = []
function mount() {
  const root = new Host('root'), app = renderer.createApp(component)
  app.mount(root); mounted.push(app)
  return { root, unmount() { app.unmount(); mounted.splice(mounted.indexOf(app), 1) } }
}
beforeAll(() => {
  const source = readFileSync(new URL('../src/components/AccountUsage.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename: 'AccountUsage.vue' })
  const script = compileScript(descriptor, { id: 'account-usage', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const code = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const dependencies: Record<string, unknown> = { vue: Vue, '../stores/cloud': { useCloud: () => cloud },
    '../cloud/services': { readAccountServices: read, saveAccountPreferences: save } }
  const exports: { default?: Vue.Component } = {}
  new Function('require', 'exports', code)((id: string) => {
    if (!(id in dependencies)) throw new Error('Unmapped local test import: ' + id)
    return dependencies[id]
  }, exports)
  component = exports.default!
})
beforeEach(() => {
  cloud = Vue.reactive({ userId: 'owner-a' })
  read.mockReset().mockImplementation(async () => result())
  save.mockReset().mockImplementation(async patch => ({ ...preferences, ...patch }))
})
afterEach(() => { for (const app of mounted.splice(0)) app.unmount(); vi.restoreAllMocks() })

describe('account service settings UX', () => {
  it('does not request account data while signed out and distinguishes held from known charges', async () => {
    cloud.userId = ''
    const view = mount(); await flush()
    expect(read).not.toHaveBeenCalled(); expect(text(view.root)).toContain('Sign in above')
    cloud.userId = 'owner-a'; await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(text(view.root)).toContain('Reported USDHeld USDUnconfirmed')
    expect(text(view.root)).toContain('0.0400'); expect(text(view.root)).toContain('0.2000')
    expect(text(view.root)).toContain('Hosting, storage and network bills are separate')
  })
  it('requires an explicit number instead of turning an empty budget into zero', async () => {
    const view = mount(); await flush()
    const input = field(view.root, 'Account daily limit')
    input.value = ''; await change(input)
    expect(save).not.toHaveBeenCalled(); expect(input.value).toBe('1')
    expect(text(view.root)).toContain('Nothing was changed')
    input.value = '0'; await change(input)
    expect(save.mock.calls[0]![0]).toEqual({ daily_budget_usd: 0 })
    expect(text(view.root)).toContain('Saved to your account')
  })
  it('saves only the selected preference and prevents concurrent changes while awaiting confirmation', async () => {
    const delayed = deferred<AccountPreferences>(); save.mockReturnValueOnce(delayed.promise)
    const view = mount(); await flush()
    const input = field(view.root, 'Keep cloud recordings'); input.value = 'assessment-only'
    const saving = change(input); await flush()
    expect(save.mock.calls[0]![0]).toEqual({ recording_retention: 'assessment-only' })
    expect(field(view.root, 'Account daily limit').props.disabled).toBe(true)
    expect(text(view.root)).toContain('Please wait')
    await change(field(view.root, 'Account monthly limit')); expect(save).toHaveBeenCalledTimes(1)
    delayed.resolve({ ...preferences, recording_retention: 'assessment-only' }); await saving
    expect(input.value).toBe('assessment-only')
    expect(input.props.disabled).toBe(false)
  })
  it('restores the last confirmed value after failure without claiming the update was saved', async () => {
    const view = mount(); await flush(); save.mockRejectedValueOnce(new Error('offline'))
    const input = field(view.root, 'Account daily limit'); input.value = '3'; await change(input)
    expect(input.value).toBe('1'); expect(text(view.root)).toContain('not confirmed')
    expect(text(view.root)).not.toContain('Saved to your account')
    const checkbox = field(view.root, 'Include available rhythm'); checkbox.checked = false
    save.mockRejectedValueOnce(new Error('offline')); await change(checkbox)
    expect(checkbox.checked).toBe(true)
  })
  it('aborts old account IO and ignores its late save result after another owner signs in', async () => {
    const delayed = deferred<AccountPreferences>(); save.mockReturnValueOnce(delayed.promise)
    const view = mount(); await flush()
    const input = field(view.root, 'Account daily limit'); input.value = '9'
    const saving = change(input); await flush()
    const signal = save.mock.calls[0]![2]!
    read.mockResolvedValueOnce({ ...result(), preferences: { ...preferences, daily_budget_usd: 2 } })
    cloud.userId = 'owner-b'; await flush()
    expect(signal.aborted).toBe(true)
    delayed.resolve({ ...preferences, daily_budget_usd: 9 }); await saving
    expect(field(view.root, 'Account daily limit').value).toBe('2')
    expect(text(view.root)).not.toContain('Saved to your account')
  })
  it('clears account data on logout and cancels pending refresh on unmount', async () => {
    const delayed = deferred<ReturnType<typeof result>>()
    read.mockReturnValueOnce(delayed.promise)
    const view = mount(); const signal = read.mock.calls[0]![1]!
    cloud.userId = ''; await flush(); expect(signal.aborted).toBe(true)
    delayed.resolve(result()); await flush()
    expect(find(view.root, node => node.type === 'table')).toBeUndefined()
    const next = deferred<ReturnType<typeof result>>(); read.mockReturnValueOnce(next.promise)
    cloud.userId = 'owner-a'; await flush()
    const pendingSignal = read.mock.calls[1]![1]!
    view.unmount(); expect(pendingSignal.aborted).toBe(true)
    next.resolve(result()); await flush()
    expect(view.root.children).toHaveLength(0)
  })
})
