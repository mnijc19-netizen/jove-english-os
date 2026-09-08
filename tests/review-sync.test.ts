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
import { defaultProfile, type ReviewCard, type StudyEvent, type Chunk } from '../src/domain/types'

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
  const { descriptor } = parse(readFileSync(new URL('../src/pages/Review.vue', import.meta.url), 'utf8'), { filename: 'Review.vue' })
  const script = compileScript(descriptor, { id: 'review-sync-test', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const code = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const dependencies: Record<string, unknown> = {
    vue: Vue, dexie: DexieModule, 'vue-router': { useRoute: () => ({ query: { task: 'review-task' } }), useRouter: () => ({ push: vi.fn() }) },
    '../stores/app': { useApp: () => state }, '../db/db': { db }, '../db/repository': repository,
    '../sync/journal': journal, '../sync/review': attempts, '../domain/longitudinal': longitudinal,
    '../content/materials': { missions }, '../composables/useRequest': { useRequest },
    ...Object.fromEntries(['AudioPlayer', 'Recorder', 'Icon'].map(name => [`../components/${name}.vue`, { default: { setup: () => () => Vue.h('i') } }])),
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
