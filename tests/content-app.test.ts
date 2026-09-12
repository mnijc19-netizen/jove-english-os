import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'
import { db } from '../src/db/db'
import { useApp } from '../src/stores/app'
import { defaultProfile } from '../src/domain/types'
import { demoMaterials } from '../src/content/materials'
import { makePlan } from '../src/domain/engine'

const services = vi.hoisted(() => ({ refresh: vi.fn(), audio: vi.fn(), history: vi.fn() }))
const state = vi.hoisted(() => ({ cloud: null as null | { configured: boolean; userId: string; start: () => Promise<void> } }))
vi.mock('../src/cloud/content', () => ({ refreshContentLessons: services.refresh, prepareContentAudio: services.audio, flushContentHistory: services.history }))
vi.mock('../src/stores/cloud', () => ({ useCloud: () => state.cloud }))
vi.mock('../src/cloud/client', () => ({ cloudClient: null, publicCloudConfig: { url: '', publishableKey: '' } }))
const segmentId = `authentic-${'a'.repeat(64)}`
const material = { ...structuredClone(demoMaterials[0]!), id: segmentId, title: 'Screened transport fixture', difficulty: 0.4,
  synthetic: false, audioPath: undefined, authenticPlayback: { segmentId, audioSha256: 'b'.repeat(64),
    startSeconds: 0, endSeconds: 40, sourceAudioSha256: 'c'.repeat(64), sourceStartSeconds: 100, sourceEndSeconds: 140,
    clipOriginSeconds: 100, timingBasis: 'pcm-sample-count' as const, mimeType: 'audio/wav', byteLength: 12, durationSeconds: 40,
    sentenceRanges: Array.from({ length: 5 }, (_, i) => ({ startSeconds: i * 8, endSeconds: (i + 1) * 8 })) } }
let app: ReturnType<typeof useApp>
beforeEach(async () => {
  await db.delete(); await db.open(); setActivePinia(createPinia())
  state.cloud = reactive({ configured: true, userId: '', start: async () => undefined })
  const browser = Object.assign(new EventTarget(), { setInterval: vi.fn(() => 1) })
  vi.stubGlobal('window', browser)
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible', documentElement: { dataset: {} } }))
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  services.history.mockReset().mockResolvedValue(undefined)
  services.audio.mockReset().mockResolvedValue(new Blob(['transport fixture']))
  services.refresh.mockReset().mockImplementation(async () => { await db.materials.put(structuredClone(material)); return [material] })
  app = useApp()
  await app.init()
})
afterEach(async () => { app.$dispose(); vi.unstubAllGlobals(); await db.delete() })
async function signIn() {
  await db.syncMeta.put({ id: 'owner', value: 'owner-a' })
  await db.profiles.put({ ...defaultProfile(), onboarded: true })
  await app.refresh(); state.cloud!.userId = 'owner-a'; await nextTick()
}
describe('Today automatic content coordination', () => {
  it('a delayed route start cannot overwrite newer completed work and optional saved assignments', async () => {
    await db.profiles.put({ ...defaultProfile(), onboarded: true, dailyMinutes: 45 }); await app.refresh()
    const initial = structuredClone(JSON.parse(JSON.stringify(app.plan))), first = initial.tasks.find((task: { done: boolean; optional?: boolean }) => !task.done && !task.optional)!
    await app.beginTask(first.id)
    const latest = { ...initial, tasks: [...initial.tasks.map((task: { done: boolean }) => ({ ...task, done: true })),
      { ...first, id: `${initial.date}:learn:other-device:reading`, kind: 'learn', title: 'Saved other-device response', optional: true, done: false, minutes: 9 }] }
    await db.plans.put(latest)
    // App state is intentionally stale, as when route hydration resumes after
    // another tab/sync commit. The database transaction must win, not old refs.
    await app.beginTask(first.id)
    expect(await db.plans.get(initial.id)).toEqual(latest)
    expect(app.plan.tasks.filter(task => !task.optional).every(task => task.done)).toBe(true)
    expect(app.plan.tasks.find(task => task.optional)?.minutes).toBe(9)
    expect(await db.events.where('id').equals(`started:${first.id}`).count()).toBe(1)
  })
  it('beginning a different task preserves a newer completion even before the store refreshes', async () => {
    const initial = structuredClone(JSON.parse(JSON.stringify(app.plan))), [first, next] = initial.tasks
    expect(next).toBeDefined()
    const latest = { ...initial, tasks: initial.tasks.map((task: { id: string }) => task.id === first.id ? { ...task, done: true } : task) }
    await db.plans.put(latest)
    await app.beginTask(next.id)
    expect((await db.plans.get(initial.id))?.tasks.find(task => task.id === first.id)?.done).toBe(true)
    expect(await db.events.get(`started:${next.id}`)).toBeDefined()
  })
  it('finishing one assignment cannot revert a newer completion from another tab', async () => {
    const initial = structuredClone(JSON.parse(JSON.stringify(app.plan))), first = initial.tasks.find((task: { kind: string }) => task.kind === 'listen')!
    const other = initial.tasks.find((task: { id: string }) => task.id !== first.id)!
    await db.plans.put({ ...initial, tasks: initial.tasks.map((task: { id: string }) => task.id === other.id ? { ...task, done: true } : task) })
    expect(await app.completeTask('listen', { taskId: first.id, materialId: first.materialId })).toBe(true)
    const stored = await db.plans.get(initial.id)
    expect(stored?.tasks.find(task => task.id === first.id)?.done).toBe(true)
    expect(stored?.tasks.find(task => task.id === other.id)?.done).toBe(true)
  })
  it('serializes two overlapping completions without losing either task or its evidence', async () => {
    const initial = structuredClone(JSON.parse(JSON.stringify(app.plan)))
    const tasks = initial.tasks.filter((task: { kind: string }) => ['listen', 'speak'].includes(task.kind))
    expect(tasks).toHaveLength(2); await db.plans.put(initial)
    expect(await Promise.all(tasks.map((task: { id: string; kind: string }) => app.completeTask(task.kind, { taskId: task.id })))).toEqual([true, true])
    const stored = await db.plans.get(initial.id)
    for (const task of tasks) {
      expect(stored?.tasks.find(row => row.id === task.id)?.done).toBe(true)
      expect(await db.events.get(`completed:${task.id}`)).toBeDefined()
    }
  })
  it.each(['start', 'complete'])('a failed %s plan commit emits no completed/started evidence and leaves the prior plan intact', async action => {
    const initial = structuredClone(JSON.parse(JSON.stringify(app.plan))), first = initial.tasks.find((task: { kind: string }) => task.kind === 'listen')!
    await db.plans.put(initial)
    const write = vi.spyOn(db.plans, 'put').mockRejectedValueOnce(new Error('fixture-plan-write-failed'))
    try {
      await expect(action === 'start' ? app.beginTask(first.id) : app.completeTask('listen', { taskId: first.id })).rejects.toThrow('fixture-plan-write-failed')
    } finally { write.mockRestore() }
    expect(await db.plans.get(initial.id)).toEqual(initial)
    expect(await db.events.get(`${action === 'start' ? 'started' : 'completed'}:${first.id}`)).toBeUndefined()
  })
  it('does not fetch before login and onboarding', async () => {
    await nextTick(); await app.loadContent()
    expect(services.refresh).not.toHaveBeenCalled(); expect(app.contentState).toBe('idle')
  })
  it('selects and preloads the planned human lesson after login without a Library action', async () => {
    await signIn()
    await vi.waitFor(() => expect(app.contentState).toBe('ready'))
    expect(services.refresh).toHaveBeenCalledOnce()
    expect(services.refresh.mock.calls[0]![0]).toMatchObject({ interests: defaultProfile().interests, requireGeneralAmerican: true })
    expect(app.plan.tasks.find(t => t.kind === 'listen')?.materialId).toBe(segmentId)
    expect(services.audio.mock.calls[0]![0].id).toBe(segmentId)
    expect(await db.events.count()).toBe(0); expect(app.skills.every(s => s.evidenceCount === 0)).toBe(true)
  })
  it('coalesces background refreshes, but permits an explicit retry', async () => {
    await signIn(); await vi.waitFor(() => expect(app.contentState).toBe('ready'))
    await Promise.all([app.loadContent(), app.loadContent(), app.refresh(), app.loadContent()])
    expect(services.refresh).toHaveBeenCalledOnce()
    await app.loadContent(true)
    expect(services.refresh).toHaveBeenCalledTimes(2)
  })
  it('never replaces an already assigned lesson when background content arrives', async () => {
    const oldPlan = makePlan({ ...defaultProfile(), onboarded: true }, [], [], [], demoMaterials)
    await db.plans.put(oldPlan)
    await signIn(); await vi.waitFor(() => expect(app.contentState).toBe('ready'))
    expect(app.plan.tasks.find(t => t.kind === 'listen')?.id).toBe(oldPlan.tasks.find(t => t.kind === 'listen')?.id)
    expect(await db.materials.get(segmentId)).toBeDefined()
    expect(services.audio).not.toHaveBeenCalled()
  })
  it('reports an empty quality-screened supply rather than presenting demos as human lessons', async () => {
    services.refresh.mockResolvedValue([])
    await signIn(); await vi.waitFor(() => expect(app.contentState).toBe('empty'))
    expect(app.materials.filter(m => !m.externalStudy).every(m => m.synthetic)).toBe(true)
    expect(app.materials.filter(m => m.externalStudy).every(m => !m.authenticPlayback && !m.audioId && !m.audioPath)).toBe(true)
    expect(services.audio).not.toHaveBeenCalled()
  })
  it('keeps saved work usable through a supply error and retries on reconnect', async () => {
    services.refresh.mockRejectedValueOnce(new Error('fixture disconnect'))
    await signIn(); await vi.waitFor(() => expect(app.contentState).toBe('error'))
    expect(app.materials.filter(m => !m.externalStudy)).toHaveLength(6)
    expect(app.materials.some(m => m.externalStudy)).toBe(true)
    window.dispatchEvent(new Event('offline')); await app.loadContent()
    expect(app.contentState).toBe('offline')
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(app.contentState).toBe('ready'))
    expect(app.plan.tasks.find(t => t.kind === 'listen')?.materialId).toBe(segmentId)
  })
  it('does not show late success after logout while preparation was pending', async () => {
    let release!: () => void
    services.refresh.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]) }))
    await signIn(); await vi.waitFor(() => expect(services.refresh).toHaveBeenCalledOnce())
    state.cloud!.userId = ''; await nextTick(); release(); await nextTick()
    expect(app.contentState).toBe('idle')
  })
})
