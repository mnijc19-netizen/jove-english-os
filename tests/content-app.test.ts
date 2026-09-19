import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'
import { db, createLanguageDatabase } from '../src/db/db'
import { useApp } from '../src/stores/app'
import { defaultProfile } from '../src/domain/types'
import { demoMaterials } from '../src/content/materials'
import { makePlan } from '../src/domain/engine'
import { externalMaterials } from '../src/content/external'

const services = vi.hoisted(() => ({ refresh: vi.fn(), catalog: vi.fn(), intermediate: vi.fn(), audio: vi.fn(), history: vi.fn() }))
const state = vi.hoisted(() => ({ cloud: null as null | { configured: boolean; userId: string; start: () => Promise<void> } }))
vi.mock('../src/cloud/content', () => ({ refreshContentLessons: services.refresh,
  refreshExternalCourseCatalog: (signal?: AbortSignal, source?: string) => source === 'voa-level2' ? services.intermediate(signal) : services.catalog(signal),
  prepareContentAudio: services.audio, flushContentHistory: services.history }))
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
  services.catalog.mockReset().mockResolvedValue([])
  services.intermediate.mockReset().mockResolvedValue([])
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
  it('uses one daily allowance and refuses a stale start after Japanese used the remaining time', async () => {
    const japanese = createLanguageDatabase('ja')
    try {
      await japanese.profiles.put({ ...defaultProfile(), onboarded: true })
      await japanese.events.put({ id: 'ja-completed', type: 'TASK_COMPLETED', source: 'objective', timestamp: Date.now(), data: { taskId: 'ja-task', minutes: 25 } })
      await app.refresh()
      expect(app.sharedDay?.totalMinutes).toBe(45)
      expect(app.plan.minutes).toBe(20)
      const original = app.plan.tasks.find(task => !task.done && !task.optional)!
      await japanese.events.put({ id: 'ja-other-completed', type: 'TASK_COMPLETED', source: 'objective', timestamp: Date.now(), data: { taskId: 'ja-other', minutes: 20 } })
      expect(await app.beginTask(original.id)).toBe(false)
      expect(await db.events.get(`started:${original.id}`)).toBeUndefined()
      expect(app.plan.tasks.filter(task => !task.done && !task.optional)).toEqual([])
    } finally { await japanese.delete() }
  })
  async function assignedExternalDraft() {
    const original = app.plan.tasks.find(task => task.kind === 'listen')!
    await app.beginTask(original.id)
    const session = { id: 'unavailable-draft', kind: 'listen', materialId: original.materialId!, stage: '1', startedAt: Date.now(),
      draft: { taskId: original.id, answer: 'Keep my original answer', audioId: 'saved-original-audio', externalExpression: 'my expression' } }
    await db.sessions.add(session)
    return { original, session, before: (await db.plans.get(app.plan.id))! }
  }
  it('does not create a required replacement after the other language exhausts the shared day', async () => {
    const { original, session, before } = await assignedExternalDraft(), japanese = createLanguageDatabase('ja')
    try {
      await japanese.profiles.put({ ...defaultProfile(), onboarded: true })
      await japanese.events.put({ id: 'ja-full-day', type: 'TASK_COMPLETED', source: 'objective', timestamp: Date.now(), data: { taskId: 'ja-day', minutes: 45 } })
      const events = await db.events.toArray()
      expect(await app.replaceUnavailableExternalLesson(session.id, original.materialId!, original.id)).toEqual({ path: '/', query: {} })
      expect(await db.events.toArray()).toEqual(events)
      expect(await db.plans.get(before.id)).toEqual(before)
      expect(await db.sessions.get(session.id)).toEqual(session)
    } finally { await japanese.delete() }
  })
  it('reallocates a new offline day without reusing yesterday’s exhausted allowance', async () => {
    const japanese = createLanguageDatabase('ja')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 8, 20, 23, 59))
      await japanese.profiles.put({ ...defaultProfile(), onboarded: true })
      await japanese.events.put({ id: 'ja-yesterday', type: 'TASK_COMPLETED', source: 'objective', timestamp: Date.now(), data: { taskId: 'ja-day', minutes: 45 } })
      await app.refresh(); expect(app.plan.minutes).toBe(0)
      vi.setSystemTime(new Date(2026, 8, 21, 0, 1))
      window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('focus'))
      await vi.waitFor(() => expect(app.sharedDay?.date).toBe('2026-09-21'))
      expect(app.plan.minutes).toBeGreaterThan(0)
      expect(app.plan.minutes).toBeLessThanOrEqual(23)
    } finally { vi.useRealTimers(); await japanese.delete() }
  })
  it('keeps plan arithmetic valid when a replacement has only part of its old time allowance', async () => {
    const { original, session, before } = await assignedExternalDraft(), japanese = createLanguageDatabase('ja')
    try {
      await japanese.profiles.put({ ...defaultProfile(), onboarded: true })
      await japanese.events.put({ id: 'ja-most-day', type: 'TASK_COMPLETED', source: 'objective', timestamp: Date.now(), data: { taskId: 'ja-day', minutes: 40 } })
      const next = await app.replaceUnavailableExternalLesson(session.id, original.materialId!, original.id)
      expect(next?.path).toBe('/listen')
      const saved = (await db.plans.get(before.id))!, replacement = saved.tasks.find(task => task.id === next?.query.task)!
      expect(replacement.minutes).toBe(5)
      expect(saved.minutes).toBe(saved.tasks.filter(task => !task.optional).reduce((sum, task) => sum + task.minutes, 0))
      expect(await db.sessions.get(session.id)).toEqual(session)
    } finally { await japanese.delete() }
  })
  it('atomically replaces an inaccessible assignment without completing it, losing work or increasing daily time', async () => {
    const { original, session, before } = await assignedExternalDraft()
    const skills = await db.skills.toArray(), cards = await db.cards.toArray()
    const next = await app.replaceUnavailableExternalLesson(session.id, original.materialId!, original.id)
    expect(next?.path).toBe('/listen')
    expect(next?.query.material).not.toBe(original.materialId)
    const selected = await db.materials.get(next!.query.material!)
    expect(selected?.externalStudy).toBeDefined(); expect(selected?.synthetic).toBe(false)
    expect(selected?.externalStudy?.publisher).not.toBe((await db.materials.get(original.materialId!))?.externalStudy?.publisher)
    const saved = (await db.plans.get(before.id))!
    expect(saved.minutes).toBeLessThanOrEqual(before.minutes)
    expect(saved.tasks.find(task => task.id === original.id)).toMatchObject({ optional: true, done: false, materialId: original.materialId })
    expect(saved.tasks.find(task => task.id === next?.query.task)).toMatchObject({ done: false, materialId: next?.query.material })
    expect(saved.tasks.filter(task => task.id !== original.id && task.id !== next?.query.task)).toEqual(before.tasks.filter(task => task.id !== original.id))
    expect(await db.sessions.get(session.id)).toEqual(session)
    expect(await db.skills.toArray()).toEqual(skills); expect(await db.cards.toArray()).toEqual(cards)
    expect((await db.events.toArray()).filter(event => event.type === 'EXTERNAL_LINK_UNAVAILABLE')).toHaveLength(1)
    expect((await db.events.toArray()).some(event => event.type === 'TASK_COMPLETED')).toBe(false)
    await app.refresh()
    expect(await app.replaceUnavailableExternalLesson(session.id, original.materialId!, original.id)).toEqual(next)
    expect((await db.events.toArray()).filter(event => event.type === 'EXTERNAL_LINK_UNAVAILABLE')).toHaveLength(1)
  })
  it('rolls back access reports and assignment changes when saving the replacement fails', async () => {
    const { original, session, before } = await assignedExternalDraft()
    const events = await db.events.toArray()
    const put = vi.spyOn(db.plans, 'put').mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(app.replaceUnavailableExternalLesson(session.id, original.materialId!, original.id)).rejects.toThrow()
    put.mockRestore()
    expect(await db.plans.get(before.id)).toEqual(before)
    expect(await db.events.toArray()).toEqual(events)
    expect(await db.sessions.get(session.id)).toEqual(session)
  })
  it('rejects account changes during replacement without publishing the report or plan', async () => {
    const { original, session, before } = await assignedExternalDraft()
    const events = await db.events.toArray(), add = db.events.add.bind(db.events)
    const write = vi.spyOn(db.events, 'add').mockImplementation(event => add(event).then(id => {
      if (event.type === 'EXTERNAL_LINK_UNAVAILABLE') state.cloud!.userId = 'changed-owner'
      return id
    }))
    await expect(app.replaceUnavailableExternalLesson(session.id, original.materialId!, original.id)).rejects.toThrow()
    write.mockRestore()
    expect(await db.plans.get(before.id)).toEqual(before)
    expect(await db.events.toArray()).toEqual(events)
  })
  it('rolls back a replacement cancelled while its transaction is still committing', async () => {
    const { original, session, before } = await assignedExternalDraft()
    const events = await db.events.toArray(), put = db.plans.put.bind(db.plans), controller = new AbortController()
    const write = vi.spyOn(db.plans, 'put').mockImplementation(plan => put(plan).then(id => { controller.abort(); return id }))
    await expect(app.replaceUnavailableExternalLesson(session.id, original.materialId!, original.id, controller.signal)).rejects.toThrow()
    write.mockRestore()
    expect(await db.plans.get(before.id)).toEqual(before)
    expect(await db.events.toArray()).toEqual(events)
    expect(await db.sessions.get(session.id)).toEqual(session)
  })
  it('keeps the original work when the only alternatives are too hard or synthetic', async () => {
    const { original, session, before } = await assignedExternalDraft()
    const events = await db.events.toArray()
    await db.materials.bulkPut((await db.materials.toArray()).filter(m => m.id !== original.materialId && m.externalStudy).map(m => ({ ...m, difficulty: 1 })))
    expect(await app.replaceUnavailableExternalLesson(session.id, original.materialId!, original.id)).toBeNull()
    expect(await db.plans.get(before.id)).toEqual(before)
    expect(await db.events.toArray()).toEqual(events)
    expect(await db.sessions.get(session.id)).toEqual(session)
  })
  it('loads both courses concurrently and retains a successful course when the other is empty', async () => {
    let release!: () => void
    services.catalog.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]) }))
    const added = { ...structuredClone(externalMaterials[0]!), id: 'external-voa-level2-1',
      title: 'Intermediate course', sourceUrl: 'https://learningenglish.voanews.com/a/level-two/12345.html' }
    services.intermediate.mockImplementation(async () => { await db.materials.put(added); return [added] })
    await db.syncMeta.put({ id: 'owner', value: 'owner-a' })
    state.cloud!.userId = 'owner-a'; await nextTick()
    await vi.waitFor(() => expect(services.intermediate).toHaveBeenCalledOnce())
    expect(services.catalog).toHaveBeenCalledOnce()
    release(); await app.loadContent()
    expect(app.catalogState).toBe('partial'); expect(app.contentState).toBe('ready')
    expect(app.materials.some(m => m.id === added.id)).toBe(true)
    services.catalog.mockResolvedValueOnce([externalMaterials[0]!])
    await app.loadContent(true)
    expect(app.catalogState).toBe('ready')
    expect(await db.events.count()).toBe(0)
  })
  it('loads the course directory after login even while initial learning setup is unfinished', async () => {
    const added = { ...structuredClone(externalMaterials[0]!), id: 'external-voa-level1-2',
      title: 'Everyday English · Lesson 2', sourceUrl: 'https://learningenglish.voanews.com/a/lesson-two/12345.html' }
    services.catalog.mockImplementation(async () => { await db.materials.add(added); return [added] })
    await db.syncMeta.put({ id: 'owner', value: 'owner-a' })
    state.cloud!.userId = 'owner-a'; await nextTick(); await app.loadContent()
    expect(services.catalog).toHaveBeenCalledOnce()
    expect(app.catalogState).toBe('partial')
    expect(app.materials.some(m => m.id === added.id)).toBe(true)
    expect(app.profile.onboarded).toBe(false)
    expect(services.history).not.toHaveBeenCalled()
    expect(services.refresh).not.toHaveBeenCalled()
    expect(services.audio).not.toHaveBeenCalled()
    expect(await db.events.count()).toBe(0)
  })
  it('starts personalized selection when setup finishes inside the catalog refresh window', async () => {
    await db.syncMeta.put({ id: 'owner', value: 'owner-a' })
    state.cloud!.userId = 'owner-a'; await nextTick(); await app.loadContent()
    expect(services.catalog).toHaveBeenCalledOnce()
    expect(services.refresh).not.toHaveBeenCalled()
    await db.profiles.put({ ...defaultProfile(), onboarded: true }); await app.refresh(); await nextTick(); await app.loadContent()
    expect(services.refresh).toHaveBeenCalledOnce()
    expect(app.contentState).toBe('ready')
  })
  it('shows a catalog failure separately from successful legacy lessons and recovers on explicit retry', async () => {
    services.catalog.mockRejectedValueOnce(new Error('catalog unavailable')).mockResolvedValueOnce([externalMaterials[0]!])
    await signIn(); await vi.waitFor(() => expect(app.contentState).toBe('ready'))
    expect(app.catalogState).toBe('error')
    await app.loadContent(true)
    expect(app.catalogState).toBe('partial')
    expect(services.catalog).toHaveBeenCalledTimes(2)
  })
  it('keeps the background check loading after catalog failure until legacy work settles', async () => {
    let release!: () => void
    services.catalog.mockRejectedValueOnce(new Error('catalog unavailable'))
    services.history.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    await signIn(); await vi.waitFor(() => expect(services.history).toHaveBeenCalledOnce())
    expect(app.catalogState).toBe('error'); expect(app.contentState).toBe('loading')
    release(); await app.loadContent()
    expect(app.contentState).toBe('ready')
  })
  it('does not publish a stale catalog state when setup changes during loading', async () => {
    let release!: () => void
    services.catalog.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]) }))
      .mockResolvedValueOnce([externalMaterials[0]!])
    await db.syncMeta.put({ id: 'owner', value: 'owner-a' })
    state.cloud!.userId = 'owner-a'; await nextTick()
    await vi.waitFor(() => expect(services.catalog).toHaveBeenCalledOnce())
    await db.profiles.put({ ...defaultProfile(), onboarded: true }); await app.refresh()
    await vi.waitFor(() => expect(app.catalogState).toBe('partial'))
    release(); await app.loadContent()
    expect(app.catalogState).toBe('partial'); expect(services.refresh).toHaveBeenCalledOnce()
  })
  it('delivers page-only courses even when legacy audio-history synchronization fails', async () => {
    const added = { ...structuredClone(externalMaterials[0]!), id: 'external-voa-level1-2',
      title: 'New catalog course', sourceUrl: 'https://learningenglish.voanews.com/a/lesson-two/12345.html' }
    services.catalog.mockImplementation(async () => { await db.materials.add(added); return [added] })
    services.history.mockRejectedValue(new Error('legacy history unavailable'))
    await signIn(); await vi.waitFor(() => expect(app.contentState).toBe('ready'))
    expect(app.materials.some(m => m.id === added.id)).toBe(true)
    expect(services.refresh).not.toHaveBeenCalled(); expect(services.audio).not.toHaveBeenCalled()
    expect(await db.events.count()).toBe(0)
  })
  it('keeps legacy lesson delivery when the catalog endpoint is unavailable', async () => {
    services.catalog.mockRejectedValue(new Error('catalog unavailable'))
    await signIn(); await vi.waitFor(() => expect(app.contentState).toBe('ready'))
    expect(app.materials.some(m => m.id === segmentId)).toBe(true)
    expect(services.refresh).toHaveBeenCalledOnce()
  })
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
    expect(services.catalog).not.toHaveBeenCalled(); expect(app.catalogState).toBe('idle')
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
    expect(app.catalogState).toBe('idle')
  })
})
