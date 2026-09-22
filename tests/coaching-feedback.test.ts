import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import * as Vue from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { Evaluation } from '../src/domain/types'

class Host {
  parent: Host | null = null; children: Host[] = []; text = ''; props: Record<string, unknown> = {}
  constructor(readonly type: string) {}
}
const renderer = Vue.createRenderer<Host, Host>({
  createElement: type => new Host(type), createText: text => Object.assign(new Host('#text'), { text }),
  createComment: () => new Host('#comment'), setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text; node.children = [] },
  patchProp: (node, key, _old, value) => { node.props[key] = value },
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
function find(node: Host, type: string): Host | undefined {
  if (node.type === type) return node
  for (const child of node.children) { const match = find(child, type); if (match) return match }
}
const { descriptor } = parse(readFileSync(new URL('../src/components/CoachingFeedback.vue', import.meta.url), 'utf8'), { filename: 'CoachingFeedback.vue' })
const script = compileScript(descriptor, { id: 'coaching-feedback', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
const code = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
const exports: { default?: Vue.Component } = {}
new Function('require', 'exports', code)((id: string) => { if (id === 'vue') return Vue; throw new Error('Unexpected import: ' + id) }, exports)
const mounted: Vue.App[] = []
afterEach(() => { for (const app of mounted.splice(0)) app.unmount() })
function mount(language: 'en' | 'ja', original: string, corrected: string) {
  const evaluation: Evaluation = { summary: `SUMMARY ${corrected}`, strengths: [`STRENGTH ${corrected}`],
    errors: [{ category: 'grammar', original, corrected, hint: `HINT ${corrected}`, explanation: `EXPLANATION ${corrected}` }],
    comprehension: null, accuracy: null, fluency: null, successfulChunks: [], nextPrompt: `NEXT ${corrected}` }
  const props = Vue.reactive({ evaluation, answer: original, language })
  const root = new Host('root'), app = renderer.createApp({ setup: () => () => Vue.h(exports.default!, props) })
  app.mount(root); mounted.push(app)
  const click = async () => { (find(root, 'button')!.props.onClick as () => void)(); await Vue.nextTick() }
  return { props, root, click }
}

describe('learner-requested coaching reference disclosure', () => {
  it.each([['en', 'Yesterday I go.', 'Yesterday I went.'], ['ja', '駅を行きたいです。', '駅に行きたいです。']] as const)('keeps %s model answers out of every preview field until requested', async (language, original, corrected) => {
    const view = mount(language, original, corrected)
    expect(text(view.root)).toContain(original); expect(text(view.root)).not.toContain(corrected)
    expect(find(view.root, 'button')?.props['aria-expanded']).toBe(false)
    await view.click()
    for (const marker of ['SUMMARY', 'STRENGTH', 'HINT', 'EXPLANATION', 'NEXT']) expect(text(view.root)).toContain(marker)
    expect(text(view.root)).toContain(corrected); expect(text(view.root)).toContain('不代表发音')
    expect(find(view.root, 'button')?.props['aria-expanded']).toBe(true)
    await view.click(); expect(text(view.root)).not.toContain(corrected)
  })
  it('does not quote an invented original and resets disclosure for a different saved answer', async () => {
    const view = mount('ja', 'AI invented reference', 'CORRECTION')
    view.props.answer = '保存的真实回答'; await Vue.nextTick()
    expect(text(view.root)).not.toContain('AI invented reference')
    await view.click(); expect(text(view.root)).toContain('CORRECTION')
    view.props.answer = '另一份回答'; await Vue.nextTick()
    expect(text(view.root)).not.toContain('CORRECTION')
  })
  it('retains an explicit reveal across equivalent refreshes but closes it for changed feedback or language', async () => {
    const view = mount('en', 'Original', 'CORRECTION'); await view.click()
    view.props.evaluation = JSON.parse(JSON.stringify(view.props.evaluation)); await Vue.nextTick()
    expect(text(view.root)).toContain('CORRECTION')
    view.props.evaluation.summary = 'Different feedback'; await Vue.nextTick()
    expect(text(view.root)).not.toContain('Different feedback')
    await view.click(); view.props.language = 'ja'; await Vue.nextTick()
    expect(text(view.root)).not.toContain('CORRECTION')
  })
  it('can reveal feedback without corrections, without a forced retry or an invented original', async () => {
    const view = mount('en', 'Original', 'CORRECTION'); view.props.evaluation.errors = []; await Vue.nextTick()
    expect(find(view.root, 'blockquote')).toBeUndefined()
    expect(text(view.root)).toContain('文字反馈已保存')
    await view.click(); expect(text(view.root)).toContain('SUMMARY')
  })
})
