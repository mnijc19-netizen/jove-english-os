import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { compileScript, parse } from '@vue/compiler-sfc'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import * as Vue from 'vue'
import * as DexieModule from 'dexie'
import { createEmptyCard } from 'ts-fsrs'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import * as repository from '../src/db/repository'
import * as journal from '../src/sync/journal'
import * as attempts from '../src/sync/review'
import * as longitudinal from '../src/domain/longitudinal'
import { missions } from '../src/content/materials'
import { useRequest } from '../src/composables/useRequest'
import * as schemas from '../src/ai/schemas'
import { defaultProfile, type ReviewCard, type StudyEvent, type Chunk, type Evaluation } from '../src/domain/types'

// Compile the actual SFC and dispatch its actual event handlers. Storage,
// scheduler, journal and alias projection are real; no mocked reviewCard success.
class Node {
  parent: Node | null = null; children: Node[] = []; props: Record<string, unknown> = {}
  text = ''; value = ''; tagName: string
  constructor(readonly type: string) { this.tagName = type.toUpperCase() }
  get options() { return this.children.filter(child => child.type === 'option') }
  addEventListener() {} removeEventListener() {} getRootNode() { return { activeElement: null } }
}
const renderer = Vue.createRenderer<Node, Node>({
  createElement: type => new Node(type), createText: text => Object.assign(new Node('#text'), { text }),
  createComment: text => Object.assign(new Node('#comment'), { text }),
  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
  patchProp: (node, key, _old, value) => { node.props[key] = value; if (key === 'value') node.value = value },
  insert: (node, parent, anchor = null) => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1
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
async function settle() { for (let index = 0; index < 30; index++) { await setImmediate(); await Vue.nextTick() } }
async function click(root: Node, label: string) {
  const node = find(root, node => node.type === 'button' && content(node).includes(label))
  if (!node) throw new Error('Missing Review button: ' + label)
  expect(!!node.props.disabled).toBe(false)
  await (node.props.onClick as () => Promise<void>)(); await settle()
}
const owner = '00000000-0000-4000-8000-000000000010', blockId = 'review-block:review-task:all'
let component: Vue.Component, mounted: Vue.App | undefined
function makeApp() {
  return Vue.reactive({ profile: { ...defaultProfile(), onboarded: true }, clock: Date.now(),
    plan: { tasks: [{ id: 'review-task', kind: 'review', minutes: 5, done: false }] },
    events: [] as StudyEvent[], cards: [] as ReviewCard[], chunks: [] as Chunk[], due: [] as ReviewCard[],
    keySet: false, provider: { evaluate: vi.fn<(...args: unknown[]) => Promise<Evaluation>>() },
    beginTask: async () => {}, completeTask: vi.fn(async () => {}),
    refresh: async () => { state.events = await db.events.toArray(); state.cards = await db.cards.toArray(); state.chunks = await db.chunks.toArray(); state.due = state.cards },
    evidence: async (event: Omit<StudyEvent, 'timestamp'>) => {
      if (!await db.events.get(event.id)) await repository.recordEvent({ ...event, timestamp: Date.now() })
      await state.refresh()
    },
  })
}
let state: ReturnType<typeof makeApp>
function mount() {
  const root = new Node('root'); mounted = renderer.createApp(component)
  mounted.component('RouterLink', { setup: (_: unknown, { slots }: Vue.SetupContext) => () => Vue.h('a', slots.default?.()) })
  mounted.mount(root); return root
}
beforeAll(() => {
  const feedbackDescriptor = parse(readFileSync(new URL('../src/components/CoachingFeedback.vue', import.meta.url), 'utf8'), { filename: 'CoachingFeedback.vue' }).descriptor
  const feedbackScript = compileScript(feedbackDescriptor, { id: 'actual-feedback', inlineTemplate: true })
  const feedbackExports: { default?: Vue.Component } = {}
  new Function('require', 'exports', transpileModule(feedbackScript.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText)((id: string) => { if (id === 'vue') return Vue; throw new Error(id) }, feedbackExports)
  const { descriptor } = parse(readFileSync(new URL('../src/pages/Review.vue', import.meta.url), 'utf8'), { filename: 'Review.vue' })
  const script = compileScript(descriptor, { id: 'review-sync-test', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const code = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const dependencies: Record<string, unknown> = {
    vue: Vue, dexie: DexieModule, 'vue-router': { useRoute: () => ({ query: { task: 'review-task' } }), useRouter: () => ({ push: vi.fn() }), onBeforeRouteUpdate: vi.fn() },
    '../stores/app': { useApp: () => state }, '../db/db': { db }, '../db/repository': repository,
    '../sync/journal': journal, '../sync/review': attempts, '../domain/longitudinal': longitudinal,
    '../content/materials': { missions }, '../composables/useRequest': { useRequest },
    '../ai/schemas': schemas, '../components/CoachingFeedback.vue': feedbackExports,
    ...Object.fromEntries(['AudioPlayer', 'Recorder', 'SavedRecording', 'Icon'].map(name => [`../components/${name}.vue`, { default: { setup: () => () => Vue.h('i') } }])),
  }
  const exports: { default?: Vue.Component } = {}
  new Function('require', 'exports', code)((id: string) => { if (!(id in dependencies)) throw new Error('Unmapped Review import: ' + id); return dependencies[id] }, exports)
  component = exports.default!
})
beforeEach(async () => {
  await db.delete(); await db.open(); state = makeApp()
  vi.stubGlobal('document', { activeElement: null }); vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {})
  const chunk: Chunk = { id: 'phrase', text: 'a phrase', meaningEn: 'meaning', meaningZh: '', sourceSentence: 'A phrase.', examples: [],
    register: 'neutral', sourceIds: [], readingStrength: 0, listeningStrength: 0, recallStrength: 0, productionStrength: 0, spontaneousUses: 0, createdAt: Date.now() - 1000 }
  await db.chunks.put(chunk)
  await db.cards.put({ id: 'old-card', chunkId: chunk.id, modality: 'recall', card: createEmptyCard(new Date(Date.now() - 1000)), contextIds: [] })
  await state.refresh()
})
afterEach(async () => { mounted?.unmount(); mounted = undefined; await settle(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.delete() })
async function legacyBlock() {
  await db.sessions.put({ id: blockId, kind: 'review-block', stage: 'selection', startedAt: Date.now(), draft: { taskId: 'review-task', items: [{ cardId: 'old-card', reps: 0 }] } })
}

describe('Review UI durable attempts with actual repository and sync projection', () => {
  const result = (accuracy: number | null): Evaluation => ({ summary: 'SUMMARY: a useful phrase.', strengths: [],
    errors: [{ category: 'grammar', original: 'a phrase', corrected: 'a useful phrase', hint: 'HINT: Add a useful detail.', explanation: 'EXPLANATION: Modify the noun.' }],
    comprehension: null, accuracy, fluency: null, successfulChunks: ['a phrase'], nextPrompt: 'NEXT: Try a different need.',
    provenance: { provider: 'fixture', model: 'fixture-model' } })
  async function spokenAttempt(modality: 'speaking' | 'transfer', accuracy: number | null, successful = true) {
    await db.cards.update('old-card', { modality })
    const selected = attempts.reviewAttempt('old-card', 0)
    await db.sessions.put({ id: blockId, kind: 'review-block', stage: 'selection', startedAt: Date.now(), draft: { taskId: 'review-task', items: [selected] } })
    await db.audio.put({ id: 'original-audio', blob: new Blob(['original']), mimeType: 'audio/webm', createdAt: Date.now(), duration: 1, kind: 'recording', processed: false, label: 'Original' })
    await db.sessions.put({ id: selected.draftId, kind: 'review', stage: 'answer', startedAt: Date.now(), draft: { response: 'a phrase', recording: 'original-audio', sttText: 'a phrase' } })
    state.keySet = true
    state.provider.evaluate.mockImplementation(async () => {
      expect((await db.sessions.get(selected.draftId))?.draft.response).toBe('a phrase')
      return { ...result(accuracy), successfulChunks: successful ? ['a phrase'] : [] }
    })
    await state.refresh()
    return selected
  }
  it.each(['speaking', 'transfer'] as const)('keeps null %s accuracy unknown and retains explicit feedback/retries without changing the first answer or FSRS', async modality => {
    const selected = await spokenAttempt(modality, null)
    let root = mount(); await settle(); await click(root, 'Check my answer')
    expect(content(root)).not.toContain('HINT:'); expect(content(root)).not.toContain('EXPLANATION:')
    expect(content(root)).toContain('准确度尚未评定')
    const original = (await db.sessions.get(selected.draftId))!.draft
    const cards = await db.cards.toArray()
    await click(root, '查看 AI 提示与参考表达')
    expect(content(root)).toContain('HINT:'); expect(content(root)).toContain('EXPLANATION:')
    const retry = find(root, node => node.props.id === 'review-retry')!
    ;(retry.props['onUpdate:modelValue'] as (s: string) => void)('This is a useful phrase.')
    await settle(); await click(root, '保存这次练习')
    const saved = (await db.sessions.get(selected.draftId))!.draft
    expect(saved).toMatchObject({ response: original.response, recording: original.recording, evaluated: null,
      retries: [{ response: 'This is a useful phrase.' }], feedback: { answer: 'a phrase', result: { accuracy: null } } })
    expect(await db.cards.toArray()).toEqual(cards)
    expect(await db.events.count()).toBe(0)
    mounted!.unmount(); mounted = undefined; await settle(); root = mount(); await settle()
    expect(content(root)).not.toContain('HINT:'); expect(content(root)).toContain('This is a useful phrase.')
    await click(root, 'Good')
    const recorded = (await db.events.get(selected.attemptId))!
    expect(recorded.source).toBe('self-report')
    const responseEvent = (await db.events.get(selected.responseEventId))!
    expect(responseEvent.data).toMatchObject({ response: 'a phrase', audioId: 'original-audio', accuracyKnown: false })
    expect(JSON.parse(responseEvent.data!.feedbackJson as string).accuracy).toBeNull()
    expect((await db.skills.get(modality === 'speaking' ? 'chunkProduction' : 'realWorld'))?.evidenceCount).toBe(0)
    expect((await db.audio.get('original-audio'))!.blob.size).toBe(8)
    expect(state.provider.evaluate).toHaveBeenCalledTimes(1)
  })
  it('does not turn missing chunk success plus null accuracy into a zero', async () => {
    const selected = await spokenAttempt('speaking', null, false)
    const root = mount(); await settle(); await click(root, 'Check my answer'); await click(root, 'Good')
    expect((await db.events.get(selected.attemptId))!).toMatchObject({ source: 'self-report', data: { rating: 3, scheduledRating: 3 } })
  })
  it('preserves a real numeric AI estimate with its saved response/provenance after reload', async () => {
    const selected = await spokenAttempt('speaking', 0.8)
    let root = mount(); await settle(); await click(root, 'Check my answer')
    mounted!.unmount(); mounted = undefined; await settle(); root = mount(); await settle(); await click(root, 'Good')
    expect((await db.events.get(selected.attemptId))!).toMatchObject({ source: 'ai', score: 0.8 })
    const responseEvent = (await db.events.get(selected.responseEventId))!
    expect(responseEvent.data?.accuracyKnown).toBe(true)
    expect(JSON.parse(responseEvent.data!.feedbackJson as string).provenance).toEqual({ provider: 'fixture', model: 'fixture-model' })
    expect((await db.skills.get('chunkProduction'))?.evidenceCount).toBe(1)
    expect(state.provider.evaluate).toHaveBeenCalledTimes(1)
  })
  it('does not revive numeric-only legacy or mismatched-answer feedback as AI evidence', async () => {
    const selected = await spokenAttempt('speaking', 0.8)
    const saved = (await db.sessions.get(selected.draftId))!
    await db.sessions.put({ ...saved, stage: 'checked', draft: { ...saved.draft, revealed: true, evaluated: 0.7,
      feedback: { answer: 'another answer', context: 'unrelated', result: result(0.8) } } })
    const root = mount(); await settle(); expect(content(root)).not.toContain('HINT:')
    await click(root, 'Good')
    expect((await db.events.get(selected.attemptId))!.source).toBe('self-report')
    expect(state.provider.evaluate).not.toHaveBeenCalled()
  })
  it('recovers the original block source among two alias drafts and never completes from the other old attempt', async () => {
    await legacyBlock()
    const sync = new journal.SyncJournal(db); await sync.bindOwner(owner)
    const original = (await db.syncOperations.toArray()).find(op => op.entityId === blockId)!
    const card = (await db.cards.get('old-card'))!
    await db.cards.delete(card.id); await db.cards.put({ ...card, id: 'phrase:recall' })
    for (const [id, response] of [['old-card', 'my original answer'], ['other-card', 'a different answer']]) {
      await db.sessions.put({ id: `review-draft:${id}:0`, kind: 'review', stage: 'answer', startedAt: Date.now(), draft: { response } })
    }
    await db.events.put({ id: 'review:other-card:1', type: 'review', timestamp: Date.now(), source: 'self-report', chunkId: 'phrase', modality: 'recall',
      data: { cardId: 'phrase:recall', rating: 3, scheduledRating: 3 } })
    for (const ids of [['other-card', 'old-card'], ['old-card', 'other-card']]) {
      await db.syncMeta.put({ id: 'cardAliases', value: Object.fromEntries(ids.map(id => [id, 'phrase:recall'])) })
      const saved = (await db.sessions.get(blockId))!
      await db.sessions.put({ ...saved, draft: { ...saved.draft, items: [{ cardId: 'phrase:recall', reps: 0 }] } })
      await state.refresh(); const root = mount(); await settle()
      await vi.waitFor(() => expect(find(root, node => node.props.id === 'review-answer')?.value).toBe('my original answer'))
      expect(content(root)).toContain('0 revisited this session')
      expect(state.completeTask).not.toHaveBeenCalled()
      expect((await db.sessions.get('review-draft:other-card:0'))?.draft.response).toBe('a different answer')
      expect((await db.sessions.get(blockId))?.draft.items).toMatchObject([{ attemptId: 'review:old-card:1', draftId: 'review-draft:old-card:0' }])
      mounted!.unmount(); mounted = undefined; await settle()
    }
    expect(await db.syncOperations.get(original.id)).toEqual(original)
  })
  it('retains both ambiguous old drafts without choosing one when original block history is unavailable', async () => {
    await legacyBlock()
    const card = (await db.cards.get('old-card'))!
    await db.cards.delete(card.id); await db.cards.put({ ...card, id: 'phrase:recall' })
    await db.syncMeta.put({ id: 'cardAliases', value: { 'old-card': 'phrase:recall', 'other-card': 'phrase:recall' } })
    const saved = (await db.sessions.get(blockId))!
    await db.sessions.put({ ...saved, draft: { ...saved.draft, items: [{ cardId: 'phrase:recall', reps: 0 }] } })
    for (const id of ['old-card', 'other-card']) await db.sessions.put({ id: `review-draft:${id}:0`, kind: 'review', stage: 'answer', startedAt: Date.now(), draft: { response: id } })
    const before = await db.sessions.toArray(); await state.refresh(); const root = mount(); await settle()
    expect(content(root)).toContain('ambiguous original attempts')
    expect(state.completeTask).not.toHaveBeenCalled()
    expect(await db.sessions.toArray()).toEqual(before)
    // An immutable row can itself already be canonicalized. Its mere existence
    // must not be interpreted as recovering the missing original binding.
    await new journal.SyncJournal(db).bindOwner(owner)
    await expect(journal.resolveReviewAttempts(db, blockId, [{ cardId: 'phrase:recall', reps: 0 }], { 'old-card': 'phrase:recall', 'other-card': 'phrase:recall' }))
      .rejects.toThrow('ambiguous original attempts')
  })
  it('finishes a legacy counter block from real aliased evidence after card canonicalization, not from the reps counter', async () => {
    await legacyBlock()
    await repository.reviewCard('old-card', 3, { eventId: 'review:old-card:1', expectedReps: 0 })
    const sync = new journal.SyncJournal(db); await sync.bindOwner(owner)
    const source = (await sync.pending()).find(op => op.entityType === 'events')!
    await sync.merge([{ ...source, id: crypto.randomUUID(), deviceId: crypto.randomUUID(),
      payload: { ...source.payload, record: { ...source.payload.record!, score: 0.5 } }, cursor: 100, receivedAt: Date.now() }], 100)
    await state.refresh(); const root = mount(); await settle()
    expect(await db.events.get('review:old-card:1')).toBeUndefined()
    expect(content(root)).toContain('1 revisited this session')
    expect(content(root)).not.toContain('waiting for card history')
    await vi.waitFor(() => expect(state.completeTask).toHaveBeenCalledWith('review', { taskId: 'review-task' }))
  })
  it('does not complete a missing card or an unrelated review without the selected attempt evidence', async () => {
    await legacyBlock(); await db.cards.clear(); await state.refresh()
    const root = mount(); await settle()
    expect(content(root)).toContain('waiting for card history')
    expect(state.completeTask).not.toHaveBeenCalled()
    expect(await db.events.where('type').equals('REVIEW_BLOCK_COMPLETED').count()).toBe(0)
  })
  it('reopens an old half-draft after alias/reps rebase and submits its original counter identity', async () => {
    await legacyBlock()
    await db.sessions.put({ id: 'review-draft:old-card:0', kind: 'review', stage: 'checked', startedAt: Date.now(), draft: { response: 'a phrase', revealed: true } })
    await repository.reviewCard('old-card', 3, { eventId: 'another-device-attempt', expectedReps: 0 })
    const sync = new journal.SyncJournal(db); await sync.bindOwner(owner); await sync.merge([], 0)
    await state.refresh(); const root = mount(); await settle()
    expect(find(root, node => node.props.id === 'review-answer')?.value).toBe('a phrase')
    expect(content(root)).not.toContain('waiting for card history')
    await click(root, 'Good')
    expect((await db.events.get('review:old-card:1'))?.data?.cardId).toBe('phrase:recall')
    expect((await db.sessions.get('review-draft:old-card:0'))?.draft.response).toBe('a phrase')
    expect((await db.cards.get('phrase:recall'))?.card.reps).toBe(2)
  })
  it('retains UUID draft/response IDs on failed scheduling, concurrent rebase, retry and reload', async () => {
    const selected = attempts.reviewAttempt('old-card', 0)
    await db.sessions.put({ id: blockId, kind: 'review-block', stage: 'selection', startedAt: Date.now(), draft: { taskId: 'review-task', items: [selected] } })
    await db.sessions.put({ id: selected.draftId, kind: 'review', stage: 'checked', startedAt: Date.now(), draft: { response: 'a phrase', revealed: true } })
    const root = mount(); await settle()
    const originalReview = repository.reviewCard
    vi.spyOn(repository, 'reviewCard').mockRejectedValueOnce(new Error('Injected schedule failure'))
    await click(root, 'Good')
    expect(await db.events.get(selected.attemptId)).toBeUndefined()
    const originalResponse = await db.events.get(selected.responseEventId)
    expect(originalResponse?.sessionId).toBe(selected.draftId)
    await originalReview('old-card', 3, { eventId: 'another-device-attempt', expectedReps: 0 })
    await state.refresh(); await settle()
    expect(find(root, node => node.props.id === 'review-answer')?.value).toBe('a phrase')
    await click(root, 'Good')
    expect(await db.events.get(selected.responseEventId)).toEqual(originalResponse)
    expect((await db.events.get(selected.attemptId))?.data?.previousReps).toBe(1)
    expect((await db.events.get(selected.attemptId))?.sessionId).toBe(selected.draftId)
    mounted!.unmount(); mounted = undefined; const reloaded = mount(); await settle()
    expect(content(reloaded)).toContain('1 revisited this session')
    expect(await db.events.where('type').equals('review').count()).toBe(2)
  })
})
