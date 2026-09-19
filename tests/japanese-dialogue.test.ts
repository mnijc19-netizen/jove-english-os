import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JoveDatabase } from '../src/db/db'
import { createLearningRepository, exportBackup, restoreBackup } from '../src/db/repository'
import { createJapaneseWorkspace } from '../src/db/japanese'
import { japanesePlacementItems } from '../src/domain/japanese'
import { demoMaterials } from '../src/content/materials'
import type { LearningProvider } from '../src/ai/cloud-provider'
import type { AudioAsset } from '../src/domain/types'

const databases: JoveDatabase[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const database of databases.splice(0)) await database.delete() })
const signal = () => new AbortController().signal
function audio(id: string): AudioAsset { return { id, blob: new Blob(['fixture-audio'], { type: 'audio/wav' }), mimeType: 'audio/wav',
  createdAt: Date.now(), duration: 3, kind: 'recording', processed: false, label: 'Fixture only' } }
async function setup() {
  const en = new JoveDatabase(`talk-en-${crypto.randomUUID()}`, 'en'), ja = new JoveDatabase(`talk-ja-${crypto.randomUUID()}`, 'ja')
  databases.push(en, ja); await createLearningRepository(en).initialize(demoMaterials)
  const learning = createJapaneseWorkspace(ja, en); await learning.open()
  const dialogue = learning.dialogue
  const session = await dialogue.start({ id: 'fixture-talk-task', kind: 'speak', title: 'Test', minutes: 5, reason: 'Test', materialId: 'ja-irodori-starter-1', done: false })
  const result = { summary: '回答清楚，先改主题助词。', strengths: ['愿意回应'], errors: [{ category: 'grammar', original: '私学生', corrected: '私は学生です。', hint: '主题后需要什么助词？', explanation: '这里用は标记话题。' }],
    comprehension: null, accuracy: 0.6, fluency: null, successfulChunks: [], nextPrompt: '换个身份介绍并完整重说。' }
  const chat = vi.fn<LearningProvider['chat']>(async () => 'そうですか。もう少し教えてください。'), transcribe = vi.fn(async () => '私は学生です。'), evaluate = vi.fn(async () => result)
  const provider = { learningLanguage: 'ja', chat, transcribe, evaluate } as unknown as LearningProvider
  async function answer(text = '私は学生です。', useAI = true) {
    const current = await dialogue.read(session.id), saved = await dialogue.save(session.id, current.draft.revision, { text, audioId: '', confirmed: true }, current.draft.comparison)
    return dialogue.send(session.id, { revision: saved.draft.revision, answer: saved.draft.answer }, useAI ? provider : undefined, signal())
  }
  return { en, ja, learning, dialogue, session, provider, chat, transcribe, evaluate, result, answer }
}

describe('durable bounded Japanese multi-turn interaction', () => {
  it('saves each checked first response before dispatch, bounds turns and reuses summary without skill credit', async () => {
    const { dialogue, session, ja, en, answer, chat, evaluate, provider } = await setup()
    chat.mockImplementationOnce(async () => {
      const current = await dialogue.read(session.id)
      expect(current.draft.turns[0]).toMatchObject({ text: '私は学生です。', attempts: 1 }); return '何を勉強していますか。'
    })
    await answer(); await answer('日本語を勉強しています。'); let current = await answer('あなたは何を勉強していますか。')
    expect(chat).toHaveBeenCalledTimes(3)
    expect(chat.mock.calls[2]?.[0]).toHaveLength(5)
    await expect(answer()).rejects.toThrow('上一轮')
    current = await dialogue.feedback(session.id, provider, signal())
    expect(current.draft.feedback?.errors[0]?.hint).toContain('助词')
    await dialogue.feedback(session.id, provider, signal()); expect(evaluate).toHaveBeenCalledOnce()
    await ja.audio.add(audio('retry'))
    current = await dialogue.attach(session.id, current.draft.revision, 'retry', true)
    current = await dialogue.save(session.id, current.draft.revision, current.draft.answer, '把话题助词补上。')
    await dialogue.finish(session.id); await dialogue.finish(session.id)
    expect((await ja.events.toArray()).filter(event => event.type === 'TASK_COMPLETED')).toHaveLength(1)
    expect((await ja.skills.toArray()).every(skill => skill.evidenceCount === 0)).toBe(true)
    expect(await ja.cards.count()).toBe(0); expect(await en.sessions.count()).toBe(0)
  })
  it('does not redispatch after reload; allows one explicit retry, then a labelled offline path', async () => {
    const { dialogue, session, answer, chat, provider } = await setup()
    chat.mockRejectedValue(new Error('Fixture terminal failure'))
    await expect(answer()).rejects.toThrow('terminal')
    let current = await dialogue.read(session.id)
    const turnId = current.draft.turns[0]!.id
    expect(current.draft.turns[0]?.text).toBe('私は学生です。')
    await expect(dialogue.reply(session.id, turnId, provider, signal())).rejects.toThrow('可能再次收费')
    expect(chat).toHaveBeenCalledOnce()
    await expect(dialogue.reply(session.id, turnId, provider, signal(), true)).rejects.toThrow('terminal')
    await expect(dialogue.reply(session.id, turnId, provider, signal(), true)).rejects.toThrow('两次')
    expect(chat).toHaveBeenCalledTimes(2)
    current = await dialogue.reply(session.id, turnId, undefined, signal())
    expect(current.draft.turns[0]?.replyKind).toBe('offline')
    await answer('ありがとうございます。', false)
    expect(chat).toHaveBeenCalledTimes(2)
  })
  it('cannot overwrite a frozen answer or dispatch another device’s text from a stale visible snapshot', async () => {
    const { dialogue, session, chat, provider } = await setup()
    const original = await dialogue.read(session.id)
    const saved = await dialogue.save(session.id, original.draft.revision, { text: '別の答えです。', audioId: '', confirmed: true }, '')
    await expect(dialogue.send(session.id, { revision: saved.draft.revision, answer: { ...saved.draft.answer, text: '古い答え' } }, provider, signal())).rejects.toThrow('本页回答')
    await expect(dialogue.save(session.id, original.draft.revision, original.draft.answer, '')).rejects.toThrow('其他页面')
    expect(chat).not.toHaveBeenCalled()
  })
  it('recovers a received reply after local receipt persistence fails without another model call', async () => {
    const { dialogue, session, answer, ja, provider, chat } = await setup()
    const add = ja.sessions.add.bind(ja.sessions)
    vi.spyOn(ja.sessions, 'add').mockImplementationOnce(value => {
      if (value.kind === 'japanese-dialogue-result') return JoveDatabase.Promise.reject(new Error('Fixture disk failure'))
      return add(value)
    })
    await expect(answer()).rejects.toThrow('disk failure')
    const current = await dialogue.read(session.id)
    await dialogue.reply(session.id, current.draft.turns[0]!.id, provider, signal(), true)
    expect(chat).toHaveBeenCalledOnce()
    expect((await dialogue.read(session.id)).draft.turns[0]?.replyKind).toBe('ai')
  })
  it('preserves an explicit offline continuation when an older AI reply arrives late', async () => {
    const { dialogue, session, answer, chat } = await setup()
    let release!: (text: string) => void
    chat.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const waiting = answer()
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce())
    const current = await dialogue.read(session.id)
    await dialogue.reply(session.id, current.draft.turns[0]!.id, undefined, signal())
    release('遅い AI の返事です。'); await waiting
    expect((await dialogue.read(session.id)).draft.turns[0]?.replyKind).toBe('offline')
  })
  it('accepts only saved Japanese originals, retains separate transcription candidates and survives text-only backup', async () => {
    const { dialogue, session, ja, en, transcribe, provider } = await setup()
    await en.audio.add(audio('english-only'))
    await expect(dialogue.attach(session.id, 0, 'english-only')).rejects.toThrow('日语区')
    await ja.audio.add(audio('first'))
    let current = await dialogue.attach(session.id, 0, 'first')
    current = await dialogue.save(session.id, current.draft.revision, { ...current.draft.answer, text: '我的文字', confirmed: false }, '')
    current = await dialogue.transcribe(session.id, current.draft.revision, provider, signal())
    expect(current.draft.answer.text).toBe('我的文字'); expect(current.draft.transcript).toBe('私は学生です。')
    await dialogue.transcribe(session.id, current.draft.revision, provider, signal()); expect(transcribe).toHaveBeenCalledOnce()
    const restored = new JoveDatabase(`talk-restored-${crypto.randomUUID()}`, 'ja'); databases.push(restored)
    await restoreBackup(await exportBackup(ja), restored)
    const restoredLearning = createJapaneseWorkspace(restored, en); await restoredLearning.open()
    const imported = await restoredLearning.dialogue.read(session.id)
    expect(imported.draft.answer.audioId).toBe(''); expect(imported.draft.answer.text).toBe('我的文字')
    expect(imported.draft.audioUnavailable).toBe(true)
  })
  it('fences owner changes and pre-cancelled requests before sending', async () => {
    const { dialogue, session, en, provider, chat } = await setup()
    const current = await dialogue.read(session.id), abort = new AbortController(); abort.abort()
    await expect(dialogue.send(session.id, { revision: 0, answer: current.draft.answer }, provider, abort.signal)).rejects.toThrow()
    expect(chat).not.toHaveBeenCalled()
    await en.syncMeta.put({ id: 'owner', value: 'changed' })
    await expect(dialogue.read(session.id)).rejects.toThrow('账号')
  })
  it('prevents a parallel reply claim and rejects late receipt writes after the owner changes', async () => {
    const { dialogue, session, provider, answer, chat, en, ja } = await setup()
    let release!: (value: string) => void
    chat.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = answer()
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce())
    const current = await dialogue.read(session.id)
    await expect(dialogue.reply(session.id, current.draft.turns[0]!.id, provider, signal(), true)).rejects.toThrow('仍在等待')
    expect(chat).toHaveBeenCalledOnce()
    await en.syncMeta.put({ id: 'owner', value: 'other-owner' })
    release('遅い返事です。')
    await expect(pending).rejects.toThrow('账号')
    expect(await ja.sessions.where('kind').equals('japanese-dialogue-result').count()).toBe(0)
  })
  it('automatically reserves dialogue after introductory practice without increasing the shared daily time', async () => {
    const { learning, ja } = await setup(), now = Date.now()
    await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map(item => [item.id, '跳过'])), true)
    for (const index of [1, 2]) await ja.events.add({ id: `history-${index}`, type: 'EXTERNAL_LISTEN_REFLECTION', source: 'self-report', sessionId: `past-${index}`, timestamp: now - 86400000 + index,
      data: { materialId: `ja-irodori-starter-${index}`, response: '过去的练习', expression: 'お願いします', example: 'お願いします。', audioId: 'past-audio', listened: true, playbackObserved: false, comprehensionVerified: false } })
    const plan = (await learning.today())!, talk = plan.tasks.find(task => task.kind === 'speak')!
    expect(talk.minutes).toBe(5); expect(plan.minutes).toBeLessThanOrEqual(23)
    expect(plan.tasks.find(task => task.kind === 'listen')!.minutes + talk.minutes + (plan.tasks.find(task => task.kind === 'learn')?.minutes ?? 0)).toBe(plan.minutes)
    expect((await learning.start(talk.id)).kind).toBe('japanese-dialogue')
    expect((await learning.today())!.tasks.filter(task => task.kind === 'speak')).toHaveLength(1)
  })
})
