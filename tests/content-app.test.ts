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
    expect(app.materials.every(m => m.synthetic)).toBe(true)
    expect(services.audio).not.toHaveBeenCalled()
  })
  it('keeps saved work usable through a supply error and retries on reconnect', async () => {
    services.refresh.mockRejectedValueOnce(new Error('fixture disconnect'))
    await signIn(); await vi.waitFor(() => expect(app.contentState).toBe('error'))
    expect(app.materials).toHaveLength(6)
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
