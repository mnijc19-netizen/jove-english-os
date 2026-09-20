import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { JoveDatabase } from '../src/db/db'
import { createLearningRepository } from '../src/db/repository'
import { createJapaneseWorkspace, japanesePracticeDraft } from '../src/db/japanese'
import { japanesePlacementItems } from '../src/domain/japanese'
import { demoMaterials } from '../src/content/materials'
import type { AudioAsset } from '../src/domain/types'
import { readLanguageDay } from '../src/db/language-day'
import { japaneseMaterials } from '../src/content/japanese'
import { japaneseWrittenExercises } from '../src/content/japanese-reading'

const databases: JoveDatabase[] = [], now = Date.UTC(2026, 8, 20, 4)
afterEach(async () => { for (const database of databases.splice(0)) await database.delete() })
async function setup() {
  const en = new JoveDatabase(`ja-ui-en-${crypto.randomUUID()}`, 'en'), ja = new JoveDatabase(`ja-ui-ja-${crypto.randomUUID()}`, 'ja')
  databases.push(en, ja)
  await createLearningRepository(en).initialize(demoMaterials)
  const learning = createJapaneseWorkspace(ja, en)
  await learning.open()
  return { en, ja, learning }
}
const skipped = Object.fromEntries(japanesePlacementItems.map(item => [item.id, '跳过']))
function recording(id: string): AudioAsset { return { id, blob: new Blob(['native recording'], { type: 'audio/webm' }), mimeType: 'audio/webm',
  createdAt: now, duration: 3, kind: 'recording', processed: false, label: 'Japanese practice' } }

describe('Japanese usable practice persistence', () => {
  it('replaces an inaccessible lesson once, preserving its draft, original and total allowance', async () => {
    const { learning, ja, en } = await setup()
    await learning.saveDiagnostic(skipped, true, now)
    const before = (await learning.today(now))!, assigned = before.tasks.find(task => task.kind === 'listen')!
    const original = await learning.start(assigned.id, now)
    await ja.audio.add(recording('saved-original'))
    const saved = await learning.save(original.id, { ...japanesePracticeDraft.parse(original.draft), response: '链接暂时不通，先保留回答', audioId: 'saved-original' }, 'listen')
    const next = (await learning.replaceUnavailable(original.id, now + 1000))!
    expect(next.materialId).not.toBe(original.materialId)
    expect((await ja.materials.get(next.materialId!))!.difficulty).toBeLessThanOrEqual((await ja.materials.get(original.materialId!))!.difficulty + 0.15)
    expect(next.draft).toMatchObject({ listened: false, response: '', audioId: '' })
    expect(await ja.sessions.get(original.id)).toEqual(saved)
    expect((await ja.audio.get('saved-original'))?.blob.size).toBeGreaterThan(0)
    const after = (await learning.today(now + 1000))!
    expect(after.minutes).toBeLessThanOrEqual(before.minutes)
    expect(after.tasks.find(task => task.id === assigned.id)).toMatchObject({ optional: true, done: false })
    expect(after.tasks.find(task => task.materialId === next.materialId)?.minutes).toBeLessThanOrEqual(assigned.minutes)
    expect((await learning.replaceUnavailable(original.id, now + 2000))?.id).toBe(next.id)
    expect((await ja.events.toArray()).filter(event => event.type === 'EXTERNAL_LINK_UNAVAILABLE')).toHaveLength(1)
    expect((await ja.events.toArray()).every(event => event.score === undefined && event.type !== 'TASK_COMPLETED')).toBe(true)
    expect(await en.events.count()).toBe(0)
  })
  it('stops after two inaccessible publisher lessons and leaves other saved practice available', async () => {
    const { learning, ja } = await setup()
    await learning.saveDiagnostic(skipped, true, now)
    const plan = (await learning.today(now))!, first = await learning.start(plan.tasks.find(task => task.kind === 'listen')!.id, now)
    const next = (await learning.replaceUnavailable(first.id, now + 1000))!
    expect(await learning.replaceUnavailable(next.id, now + 2000)).toBeNull()
    const after = (await learning.today(now + 3000))!
    expect(after.tasks.filter(task => task.kind === 'listen' && !task.optional)).toEqual([])
    expect(after.tasks.some(task => task.kind === 'learn' && !task.optional)).toBe(true)
    expect((await ja.sessions.toArray()).every(session => !session.completedAt)).toBe(true)
    expect((await ja.events.toArray()).filter(event => event.type === 'EXTERNAL_LINK_UNAVAILABLE')).toHaveLength(2)
    expect(await learning.replaceUnavailable(next.id, now + 4000)).toBeNull()
  })
  it('retains the unavailable draft when no alternative within its difficulty band exists', async () => {
    const { learning, ja } = await setup()
    await learning.saveDiagnostic(skipped, true, now)
    const original = await learning.start((await learning.today(now))!.tasks[0]!.id, now)
    await ja.materials.filter(material => material.id !== original.materialId && material.externalStudy !== undefined).modify({ difficulty: 1 })
    expect(await learning.replaceUnavailable(original.id, now + 1000)).toBeNull()
    expect(await ja.sessions.get(original.id)).toEqual(original)
    expect((await learning.today(now + 2000))?.tasks.filter(task => task.kind === 'listen' && !task.optional)).toEqual([])
  })
  it('refuses a replacement after account change without a report, draft or plan mutation', async () => {
    const { learning, ja, en } = await setup()
    await learning.saveDiagnostic(skipped, true, now)
    const original = await learning.start((await learning.today(now))!.tasks[0]!.id, now)
    const plans = await ja.plans.toArray(), sessions = await ja.sessions.toArray(), events = await ja.events.toArray()
    await en.syncMeta.put({ id: 'owner', value: 'another-owner' })
    await expect(learning.replaceUnavailable(original.id, now + 1000)).rejects.toThrow('账号')
    expect(await ja.plans.toArray()).toEqual(plans)
    expect(await ja.sessions.toArray()).toEqual(sessions)
    expect(await ja.events.toArray()).toEqual(events)
  })
  it('resumes partial diagnosis and admits only complete answers without inventing oral ability', async () => {
    const { en, ja, learning } = await setup()
    await learning.saveDiagnostic({ hiragana: 'neko' }, false, now)
    expect((await ja.assessments.get(learning.diagnosticId))?.responses).toEqual({ hiragana: 'neko' })
    expect((await ja.profiles.get('main'))?.onboarded).toBe(false)
    await expect(learning.saveDiagnostic({}, true, now)).rejects.toThrow('Incomplete')
    const result = await learning.saveDiagnostic(skipped, true, now)
    expect(result.scores).toMatchObject({ listening: null, speaking: null })
    expect((await ja.profiles.get('main'))?.onboarded).toBe(true)
    expect((await en.profiles.get('main'))?.onboarded).toBe(false)
    expect(await ja.events.count()).toBe(0); expect(await en.assessments.count()).toBe(0)
  })
  it('offers a bounded Japanese task and resumes the same draft without resetting allowance', async () => {
    const { learning, ja } = await setup()
    await learning.saveDiagnostic(skipped, true, now)
    const plan = (await learning.today(now))!, task = plan.tasks[0]!
    expect(task.minutes).toBeGreaterThan(0); expect(task.minutes).toBeLessThan(45)
    expect(task.materialId).toBe('ja-irodori-starter-1')
    const session = await learning.start(task.id, now)
    const saved = await learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), response: '先保存未完成的回答' }, 'listen')
    expect((await learning.start(task.id, now)).draft).toEqual(saved.draft)
    expect(await ja.events.count()).toBe(1)
    expect((await learning.today(now))?.tasks[0]?.minutes).toBe(task.minutes)
  })
  it('rejects skipped stages, stale writes, foreign recordings and incomplete finish atomically', async () => {
    const { learning, en, ja } = await setup()
    await learning.saveDiagnostic(skipped, true, now)
    const session = await learning.start((await learning.today(now))!.tasks[0]!.id, now)
    const original = japanesePracticeDraft.parse(session.draft)
    await expect(learning.save(session.id, original, 'notice')).rejects.toThrow('先听')
    const saved = await learning.save(session.id, { ...original, listened: true, response: '问候' }, 'notice')
    await expect(learning.save(session.id, original, 'listen')).rejects.toThrow('其他页面')
    await en.audio.add(recording('foreign'))
    await expect(learning.save(session.id, { ...japanesePracticeDraft.parse(saved.draft), audioId: 'foreign' }, 'notice')).rejects.toThrow('日语区')
    await expect(learning.finish(session.id, now + 1000)).rejects.toThrow('两次录音')
    expect(await ja.cards.count()).toBe(0); expect((await ja.sessions.get(session.id))?.completedAt).toBeUndefined()
  })
  it('saves both originals, reflection and reference review cards once without mastery credit', async () => {
    const { learning, en, ja } = await setup()
    await learning.saveDiagnostic(skipped, true, now)
    const plan = (await learning.today(now))!, session = await learning.start(plan.tasks[0]!.id, now)
    await ja.audio.bulkAdd([recording('original'), recording('retry')])
    await learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), listened: true, response: '在早上问候同事',
      expression: 'おはようございます', example: 'おはようございます。', audioId: 'original', retryAudioId: 'retry', comparison: '留意长音后再说一次' }, 'compare')
    await learning.finish(session.id, now + 1000); await learning.finish(session.id, now + 2000)
    expect(await ja.audio.count()).toBe(2); expect(await ja.cards.count()).toBe(6)
    expect((await ja.events.toArray()).filter(event => event.type === 'TASK_COMPLETED')).toHaveLength(1)
    expect((await ja.events.toArray()).every(event => event.score === undefined)).toBe(true)
    expect((await ja.skills.toArray()).every(skill => skill.evidenceCount === 0)).toBe(true)
    const after = (await learning.today(now + 3000))!
    expect(after.tasks.filter(task => task.kind === 'listen')).toHaveLength(1)
    expect(after.tasks.find(task => task.kind === 'listen')?.done).toBe(true)
    expect(after.tasks.find(task => task.materialId?.startsWith('ja-kana-'))?.done).toBe(false)
    expect(await en.sessions.count()).toBe(0); expect(await en.audio.count()).toBe(0); expect(await en.cards.count()).toBe(0)
    expect((await learning.today(now + 86400000))?.tasks.find(task => task.kind === 'listen')?.materialId).toBe('ja-irodori-starter-2')
  })
  it('stops allocation when English used the account allowance and fences an owner change', async () => {
    const { learning, en, ja } = await setup()
    await learning.saveDiagnostic(skipped, true, now)
    await en.events.add({ id: 'en-done', type: 'TASK_COMPLETED', source: 'objective', timestamp: now, data: { taskId: 'en-task', minutes: 45 } })
    expect(await learning.today(now)).toBeNull()
    await en.syncMeta.put({ id: 'owner', value: 'different-owner' })
    await expect(learning.saveDiagnostic(skipped, true, now)).rejects.toThrow('账号')
    expect(await ja.events.count()).toBe(0)
  })
  it('keeps original material edits and learns task load without changing proficiency or English plans', async () => {
    const { learning, en, ja } = await setup()
    await ja.materials.update('ja-irodori-starter-1', { title: 'My retained title' })
    await learning.open()
    expect((await ja.materials.get('ja-irodori-starter-1'))?.title).toBe('My retained title')
    expect(await ja.materials.count()).toBe(japaneseMaterials().length + japaneseWrittenExercises.length)
    await learning.saveDiagnostic(skipped, true, now)
    const session = await learning.start((await learning.today(now))!.tasks[0]!.id, now)
    await ja.audio.bulkAdd([recording('original'), recording('retry')])
    await learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), listened: true, response: '问候', expression: 'おはよう',
      example: 'おはようございます。', audioId: 'original', retryAudioId: 'retry', comparison: '继续练习', effort: 'hard' }, 'compare')
    await learning.finish(session.id, now + 1000)
    const tomorrow = (await learning.today(now + 86400000))!
    expect(tomorrow.tasks.find(task => task.kind === 'listen')).toMatchObject({ materialId: 'ja-irodori-starter-1', reason: expect.stringContaining('吃力') })
    expect((await ja.events.toArray()).filter(event => event.type === 'EXTERNAL_LISTEN_REFLECTION')[0]?.data?.effort).toBe('hard')
    expect((await ja.skills.toArray()).every(skill => skill.evidenceCount === 0)).toBe(true)
    expect(await en.plans.count()).toBe(0)
  })
  it('counts a completed overnight draft once against the real completion day', async () => {
    const { learning, en, ja } = await setup()
    await learning.saveDiagnostic(skipped, true, now)
    const plan = (await learning.today(now))!, session = await learning.start(plan.tasks[0]!.id, now)
    await ja.audio.bulkAdd([recording('original'), recording('retry')])
    await learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), listened: true, response: '问候',
      expression: 'おはよう', example: 'おはようございます。', audioId: 'original', retryAudioId: 'retry', comparison: '重新说' }, 'compare')
    const tomorrow = now + 86400000
    await learning.finish(session.id, tomorrow); await learning.finish(session.id, tomorrow + 1000)
    const day = await readLanguageDay(en, tomorrow + 1000, ja)
    const completedMinutes = plan.tasks.find(task => task.kind === 'listen')!.minutes
    expect(day?.allowances.ja.completed).toBe(completedMinutes)
    expect(day?.remaining).toBe(45 - completedMinutes)
  })
})
