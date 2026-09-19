import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JoveDatabase } from '../src/db/db'
import { createLearningRepository } from '../src/db/repository'
import { createJapaneseWorkspace } from '../src/db/japanese'
import { createJapaneseCoach } from '../src/db/japanese-coach'
import { demoMaterials } from '../src/content/materials'
import type { LearningProvider } from '../src/ai/cloud-provider'
import { localAICost } from '../src/ai/workspace-provider'

const databases: JoveDatabase[] = []
afterEach(async () => { for (const database of databases.splice(0)) await database.delete() })
async function setup() {
  const en = new JoveDatabase(`coach-en-${crypto.randomUUID()}`, 'en'), ja = new JoveDatabase(`coach-ja-${crypto.randomUUID()}`, 'ja')
  databases.push(en, ja); await createLearningRepository(en).initialize(demoMaterials)
  const learning = createJapaneseWorkspace(ja, en); await learning.open()
  await ja.sessions.put({ id: 'practice', kind: 'japanese-practice', stage: 'compare', startedAt: Date.now(), draft: {} })
  const result = { summary: '意思清楚。', strengths: ['礼貌表达'], errors: [{ category: 'grammar', original: '私日本人', corrected: '私は日本人です。', hint: '先想想主题助词', explanation: 'は标记话题。' }],
    comprehension: null, accuracy: 0.6, fluency: null, successfulChunks: [], nextPrompt: '换成自己的身份完整重说。' }
  const evaluate = vi.fn(async () => result), transcribe = vi.fn(async () => '私は学生です。')
  const provider = { learningLanguage: 'ja', evaluate, transcribe } as unknown as LearningProvider
  const coach = createJapaneseCoach(ja, 'practice', learning.checkOwner, provider)
  return { en, ja, learning, coach, provider, evaluate, transcribe, result }
}
const signal = () => new AbortController().signal
const checked = (revision: number, text: string) => ({ revision, text, confirmed: true })
describe('saved Japanese AI assistance, not proficiency evidence', () => {
  it('saves a checked answer before dispatch and reuses its saved feedback without another paid request', async () => {
    const { ja, en, coach, evaluate, result } = await setup()
    await coach.open(); await coach.save(0, '私は日本人です。', true)
    evaluate.mockImplementationOnce(async () => { expect((await coach.read())?.text).toBe('私は日本人です。'); return result })
    const saved = await coach.feedback('自己紹介', '日本人', signal(), checked(1, '私は日本人です。'))
    expect(saved.feedback[0]?.input).toBe('私は日本人です。')
    await coach.feedback('自己紹介', '日本人', signal(), checked(saved.revision, saved.text)); expect(evaluate).toHaveBeenCalledOnce()
    expect(await ja.events.count()).toBe(0); expect(await ja.cards.count()).toBe(0); expect(await en.sessions.count()).toBe(0)
  })
  it('retains the draft through provider failure and rejects unchecked transcription as feedback input', async () => {
    const { coach, evaluate } = await setup()
    await coach.open(); await coach.save(0, '私は学生です。', false)
    await expect(coach.feedback('自己紹介', '学生', signal(), { revision: 1, text: '私は学生です。', confirmed: false })).rejects.toThrow('核对')
    expect(evaluate).not.toHaveBeenCalled()
    await coach.save(1, '私は学生です。', true)
    evaluate.mockRejectedValueOnce(new Error('Fixture failure'))
    await expect(coach.feedback('自己紹介', '学生', signal(), checked(2, '私は学生です。'))).rejects.toThrow('Fixture failure')
    expect((await coach.read())?.text).toBe('私は学生です。'); expect((await coach.read())?.feedback).toHaveLength(0)
  })
  it('keeps newer text when feedback for an older answer arrives', async () => {
    const { coach, evaluate, result } = await setup()
    await coach.open(); await coach.save(0, '旧回答', true)
    let release!: (result: unknown) => void
    evaluate.mockImplementationOnce(() => new Promise(resolve => { release = resolve as typeof release }))
    const pending = coach.feedback('自己紹介', '学生', signal(), checked(1, '旧回答'))
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce())
    await coach.save(1, '后来保存的新回答', false)
    release(result); const saved = await pending
    expect(saved.text).toBe('后来保存的新回答'); expect(saved.feedback[0]?.input).toBe('旧回答')
  })
  it('transcribes only an original in this workspace, stores the candidate separately, and survives JSON-only restore', async () => {
    const { coach, ja, learning, en, transcribe } = await setup()
    await coach.open(); await coach.save(0, '我的手写答案', true)
    await en.audio.put({ id: 'foreign', kind: 'recording', blob: new Blob(['foreign']), mimeType: 'audio/wav', duration: 1, createdAt: Date.now(), processed: false, label: 'English' })
    await expect(coach.transcribe(1, 'foreign', signal())).rejects.toThrow('不属于当前练习'); expect(transcribe).not.toHaveBeenCalled()
    await ja.audio.put({ ...(await en.audio.get('foreign'))!, id: 'ja-original' })
    await ja.sessions.update('practice', { draft: { audioId: 'ja-original' } })
    const saved = await coach.transcribe(1, 'ja-original', signal())
    expect(saved).toMatchObject({ text: '我的手写答案', transcript: '私は学生です。', confirmed: false })
    const backup = await learning.repository.exportBackup()
    await ja.audio.clear(); await learning.repository.restoreBackup(backup)
    expect(await coach.read()).toMatchObject({ text: '我的手写答案', transcript: '私は学生です。', audioId: '', audioUnavailable: true })
  })
  it('fences a changed owner while AI is running and preserves existing work', async () => {
    const { coach, evaluate, result, en, ja } = await setup()
    await coach.open(); await coach.save(0, '原始回答', true)
    evaluate.mockImplementationOnce(async () => { await en.syncMeta.put({ id: 'owner', value: 'other-owner' }); return result })
    await expect(coach.feedback('自己紹介', '学生', signal(), checked(1, '原始回答'))).rejects.toThrow('账号已改变')
    expect((await ja.sessions.get('ja-coach:practice'))?.draft.feedback).toEqual([])
  })
  it('shares the advanced browser-key daily cost across the same owner only', async () => {
    const { en, ja } = await setup(), now = Date.now()
    const row = { id: 'usage', timestamp: now, model: 'fixture', purpose: 'evaluate', tokens: 10, cost: 0.2 }
    await en.usage.put(row); await ja.usage.put({ ...row, id: 'ja-usage', cost: 0.4 })
    await ja.usage.put({ ...row, id: 'account', purpose: 'account:evaluate', cost: 8 })
    expect(await localAICost(en, ja, now)).toBeCloseTo(0.6)
    await ja.syncMeta.put({ id: 'owner', value: 'foreign' })
    expect(await localAICost(en, ja, now)).toBeCloseTo(0.2)
  })
  it('rejects a different saved answer before dispatch, even if concurrent replicas have the same revision', async () => {
    const { coach, ja, evaluate } = await setup()
    await coach.open(); await coach.save(0, '本页回答A', true)
    await ja.sessions.update('ja-coach:practice', { 'draft.text': '另一设备回答B' })
    await expect(coach.feedback('自己紹介', '学生', signal(), checked(1, '本页回答A'))).rejects.toThrow('没有提交另一份回答')
    expect(evaluate).not.toHaveBeenCalled()
  })
  it('durably retains transcription through a concurrent edit and never redispatches it on recovery', async () => {
    const { coach, ja, transcribe } = await setup()
    await coach.open(); await coach.save(0, '原回答', true)
    await ja.sessions.update('practice', { draft: { audioId: 'original' } })
    await ja.audio.put({ id: 'original', kind: 'recording', blob: new Blob(['original']), mimeType: 'audio/wav', duration: 1, createdAt: Date.now(), processed: false, label: '原件' })
    let release!: (text: string) => void
    transcribe.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = coach.transcribe(1, 'original', signal())
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce())
    await coach.save(1, '另一设备的新回答', true)
    release('保存的转写候选')
    await expect(pending).rejects.toThrow('转写候选已保存')
    await expect(coach.transcribe(1, 'original', signal())).rejects.toThrow('没有再次调用转写')
    const stored = (await coach.open())!
    expect(stored).toMatchObject({ text: '另一设备的新回答', confirmed: true, transcript: '保存的转写候选' })
    await coach.transcribe(stored.revision, 'original', signal())
    expect(transcribe).toHaveBeenCalledOnce()
    expect((await ja.sessions.get('ja-stt:practice:original'))?.draft.transcript).toBe('保存的转写候选')
  })
})
