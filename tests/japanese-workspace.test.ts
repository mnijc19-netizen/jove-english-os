import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JoveDatabase } from '../src/db/db'
import { createLearningRepository } from '../src/db/repository'
import { createJapaneseWorkspace, japanesePracticeDraft } from '../src/db/japanese'
import { japanesePlacementItems, japaneseBeginnerStartId, japaneseStartingPoint } from '../src/domain/japanese'
import { demoMaterials } from '../src/content/materials'
import type { AudioAsset } from '../src/domain/types'
import { readLanguageDay } from '../src/db/language-day'
import { japaneseMaterials } from '../src/content/japanese'
import { japaneseWrittenExercises } from '../src/content/japanese-reading'
import { tadokuStarterMaterials } from '../src/content/tadoku-catalog'
import { japaneseReadingDraft } from '../src/domain/japanese-reading'
import { extensiveDraftSchema } from '../src/domain/japanese-extensive'

const databases: JoveDatabase[] = [], now = Date.UTC(2026, 8, 20, 4)
afterEach(async () => { vi.useRealTimers(); for (const database of databases.splice(0)) await database.delete() })
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
  it.each(['input', 'application', 'delayed-transfer', 'legacy'] as const)('enforces the frozen %s move/lock contract without new draft fields', async phase => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now)
    const { learning, ja } = await setup()
    await learning.confirmBeginnerStart(now)
    const plan = (await learning.today(now))!, task = plan.tasks.find(task => task.kind === 'listen')!
    let session = await learning.start(task.id, now)
    const assignmentId = `${session.id}:course-assignment`
    if (phase === 'legacy') await ja.events.delete(assignmentId)
    else {
      const assignment = (await ja.events.get(assignmentId))!
      await ja.events.put({ ...assignment, data: { ...assignment.data, coursePhase: phase } })
    }
    const independent = phase === 'application' || phase === 'delayed-transfer'
    expect((await learning.practiceGuide(session.id))?.independentFirst ?? false).toBe(independent)
    session = await learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), response: '私は学生です。', example: '私は学生です。' }, 'listen')
    if (!independent) {
      await expect(learning.save(session.id, japanesePracticeDraft.parse(session.draft), 'notice')).rejects.toThrow('先听')
      await expect(learning.lockIndependentAttempt(session.id, now)).rejects.toThrow('应用或延迟')
      session = await learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), listened: true }, 'notice')
    } else {
      if (phase === 'delayed-transfer') {
        await expect(learning.lockIndependentAttempt(session.id, now)).rejects.toThrow('新的首答录音')
        await ja.audio.put({ ...recording('old-audio'), createdAt: now - 1 })
        session = await learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), audioId: 'old-audio' }, 'listen')
        await expect(learning.lockIndependentAttempt(session.id, now)).rejects.toThrow('新的首答录音')
        await ja.audio.put(recording('fresh-audio'))
        session = await learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), audioId: 'fresh-audio' }, 'listen')
        await expect(learning.save(session.id, japanesePracticeDraft.parse(session.draft), 'notice')).rejects.toThrow('先保存独立')
        const beforeLock = session
        const locked = await learning.lockIndependentAttempt(session.id, now)
        expect(locked?.data).toMatchObject({ response: '私は学生です。', audioId: 'fresh-audio', recordingBeforeHelp: true })
        expect(await learning.lockIndependentAttempt(session.id, now + 1)).toEqual(locked)
        expect(await ja.sessions.get(session.id)).toEqual(beforeLock)
      }
      session = await learning.save(session.id, japanesePracticeDraft.parse(session.draft), 'notice')
      expect(japanesePracticeDraft.parse(session.draft).listened).toBe(false)
      await expect(learning.save(session.id, japanesePracticeDraft.parse(session.draft), 'speak')).rejects.toThrow('实际听过')
      await expect(learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), response: '看参考后重写' }, 'notice')).rejects.toThrow('首答已锁定')
      expect((await learning.practiceGuide(session.id))?.firstAttemptSaved).toBe(true)
    }
    session = await learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), listened: true, expression: '私は学生です。', example: '私は会社員です。' }, 'speak')
    expect(japanesePracticeDraft.parse(session.draft)).toMatchObject({ response: '私は学生です。', example: '私は会社員です。' })
    if (phase === 'legacy') {
      expect(await learning.practiceGuide(session.id)).toBeNull()
      expect(await ja.events.get(`${session.id}:independent-attempt`)).toBeUndefined()
    }
    await expect(learning.repository.exportBackup()).resolves.toContain(session.id)
  })
  it.each([45, 15])('keeps reading and dialogue reachable with a shared %i-minute budget, persistent due cards and durable phases', async dailyMinutes => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now)
    const { en, ja, learning } = await setup()
    await en.profiles.update('main', { dailyMinutes, onboarded: true })
    await learning.confirmBeginnerStart(now)
    if (dailyMinutes === 15) {
      for (const material of japaneseMaterials().slice(0, 5)) {
        const chunk = await learning.repository.addChunk(material.chunks[0]!, material.id)
        await ja.chunks.update(chunk.id, { createdAt: now - 86400000 })
        const englishChunk = await createLearningRepository(en).addChunk({ ...demoMaterials[0]!.chunks[0]!, text: `Existing English expression ${material.id}` }, demoMaterials[0]!.id)
        await en.chunks.update(englishChunk.id, { createdAt: now - 86400000 })
      }
    }
    const kinds = new Set<string>(), phases: string[] = [], materials: string[] = []
    let daysWithDue = 0
    for (let index = 0; index < 8; index++) {
      const at = now + index * (86400000 + 10000); vi.setSystemTime(at)
      const shared = (await readLanguageDay(en, at, ja))!
      const englishMinutes = dailyMinutes === 45 ? 30 : shared.allowances.en.remaining
      await en.events.add({ id: `en-day-${index}`, type: 'TASK_COMPLETED', source: 'objective', timestamp: at,
        data: { taskId: `en-day-${index}`, minutes: englishMinutes } })
      const plan = (await learning.today(at))!
      const allowance = (await readLanguageDay(en, at, ja))!
      expect(plan.minutes).toBeLessThanOrEqual(allowance.allowances.ja.planCap)
      expect(plan.minutes + englishMinutes).toBeLessThanOrEqual(dailyMinutes)
      if (dailyMinutes === 45) expect(plan.minutes).toBe(15)
      else {
        expect(allowance.allowances.ja.remaining).toBeGreaterThanOrEqual(7)
        expect(allowance.allowances.ja.remaining).toBeLessThanOrEqual(8)
        expect(plan.tasks.filter(task => task.kind !== 'review').every(task => task.minutes >= 5)).toBe(true)
      }
      if (index || dailyMinutes === 15) { expect(plan.tasks.some(task => task.kind === 'review')).toBe(true); daysWithDue++ }
      for (const task of plan.tasks) {
        let session = await learning.start(task.id, at)
        if (session.kind === 'japanese-review') {
          while (!session.completedAt) {
            const state = await learning.review.read(session.id), item = state.draft.items.find(item => !item.rating && !item.skipped)!
            const card = (await ja.cards.get(item.cardId))!, oral = ['speaking', 'transfer'].includes(card.modality)
            const audioId = oral ? `review-${index}-${item.cardId}` : ''
            if (oral) await ja.audio.put({ ...recording(audioId), createdAt: at })
            const saved = await learning.review.save(session.id, state.draft.revision, { response: 'おはようございます。', audioId, heard: false }, true, at + 1)
            session = await learning.review.rate(session.id, Number(saved.draft.revision), 3, at + 2)
          }
        } else if (session.kind === 'japanese-practice') {
          const guide = (await learning.practiceGuide(session.id))!
          phases.push(guide.phase); materials.push(session.materialId!)
          expect((await learning.practiceGuide(session.id))?.contextPrompt).toBe(guide.contextPrompt)
          await ja.audio.bulkPut([{ ...recording(`first-${index}`), createdAt: at }, { ...recording(`retry-${index}`), createdAt: at + 1 }])
          const written = await learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), listened: true, response: '问候的情境',
            expression: 'おはようございます。', example: 'おはようございます。', audioId: `first-${index}`, retryAudioId: `retry-${index}`,
            comparison: '换成自己的情境，再完整说一次。', effort: 'okay' }, guide.independentFirst ? 'listen' : 'compare')
          if (guide.phase === 'delayed-transfer') {
            await expect(learning.finish(session.id, at + 100)).rejects.toThrow('先保存独立')
            await expect(learning.save(session.id, japanesePracticeDraft.parse(written.draft), 'notice')).rejects.toThrow('先保存独立')
            const locked = await learning.lockIndependentAttempt(session.id, at + 101)
            expect(await learning.lockIndependentAttempt(session.id, at + 102)).toEqual(locked)
            expect((await learning.practiceGuide(session.id))?.firstAttemptSaved).toBe(true)
            await learning.save(session.id, japanesePracticeDraft.parse(written.draft), 'compare')
          } else if (guide.phase === 'application') {
            await learning.save(session.id, japanesePracticeDraft.parse(written.draft), 'compare')
          }
          await learning.finish(session.id, at + 1000)
        } else if (session.kind === 'japanese-reading') {
          const state = await learning.reading.read(session.id), draft = japaneseReadingDraft.parse(session.draft)
          if (!state.reading.kana) kinds.add('reading')
          const saved = await learning.reading.save(session.id, { ...draft,
            meaning: state.reading.questions.map(q => q.answer) as [string, string], kana: state.reading.words.map(w => w.reading) as [string, string],
            sourcePractice: 'heard', note: '保留首答后写一句新的意思。' }, 'lock', at + 1)
          await learning.reading.finish(session.id, Number(saved.draft.revision), at + 2)
        } else if (session.kind === 'japanese-extensive') {
          kinds.add('reading')
          const draft = extensiveDraftSchema.parse(session.draft)
          const saved = await learning.books.save(session.id, { ...draft, outcome: 'finished', minutesRead: task.minutes })
          await learning.books.finish(session.id, extensiveDraftSchema.parse(saved.draft), at + 1000)
        } else if (session.kind === 'japanese-dialogue') {
          kinds.add('dialogue')
          for (let turn = 0; turn < 3; turn++) {
            const state = await learning.dialogue.read(session.id)
            const answer = { text: 'はじめまして。よろしくお願いします。', audioId: '', confirmed: true }
            const saved = await learning.dialogue.save(session.id, state.draft.revision, answer, '')
            await learning.dialogue.send(session.id, { revision: saved.draft.revision, answer }, undefined, new AbortController().signal)
          }
          const state = await learning.dialogue.read(session.id), audioId = `dialogue-retry-${index}`
          await ja.audio.put({ ...recording(audioId), createdAt: at })
          const attached = await learning.dialogue.attach(session.id, state.draft.revision, audioId, true)
          await learning.dialogue.save(session.id, attached.draft.revision, attached.draft.answer, '写明一处调整，再完整重说。')
          await learning.dialogue.finish(session.id, at + 1000)
        }
      }
      expect((await learning.today(at + 2000))?.tasks.every(task => task.done || task.optional)).toBe(true)
      expect((await readLanguageDay(en, at + 2000, ja))!.credited).toBeLessThanOrEqual(dailyMinutes)
    }
    expect(daysWithDue).toBe(dailyMinutes === 15 ? 8 : 7); expect(kinds).toEqual(new Set(['reading', 'dialogue']))
    expect(phases.slice(0, 3)).toEqual(['input', 'application', 'delayed-transfer'])
    expect(new Set(materials.slice(0, 3)).size).toBe(1); expect(materials[3]).not.toBe(materials[0])
    expect((await ja.skills.toArray()).every(skill => skill.evidenceCount === 0)).toBe(true)
    expect((await ja.events.toArray()).filter(event => event.type === 'EXTERNAL_LISTEN_REFLECTION')
      .every(event => event.data?.publisherCoverageVerified === false)).toBe(true)
  })
  it('starts from a declared beginner preference without fabricated diagnostic answers or scores', async () => {
    const { learning, ja, en } = await setup()
    const beforeEnglish = await en.profiles.toArray()
    const confirmation = await learning.confirmBeginnerStart(now)
    expect(confirmation).toMatchObject({ stage: 'self-reported-beginner', responses: { startingPoint: 'beginner' },
      scores: { scriptRecognition: null, sentenceMeaning: null, listening: null, speaking: null } })
    expect(await ja.assessments.get(learning.diagnosticId)).toBeUndefined()
    expect(await learning.startingPoint(now)).toMatchObject({ basis: 'self-report', conversationProbe: 1, kanaSupport: true, furigana: 'full', scriptCorrect: null })
    const plan = (await learning.today(now))!
    expect(plan.tasks.find(task => task.kind === 'listen')?.materialId).toBe('ja-irodori-starter-1')
    expect(plan.tasks.some(task => task.materialId?.startsWith('ja-kana-'))).toBe(true)
    expect(await learning.confirmBeginnerStart(now + 1000)).toEqual(confirmation)
    expect(await ja.assessments.count()).toBe(1)
    expect(await ja.events.count()).toBe(0)
    expect(await ja.cards.count()).toBe(0)
    expect(await en.profiles.toArray()).toEqual(beforeEnglish)
    expect(await en.assessments.count()).toBe(0)
  })
  it('supersedes an unreliable quiz without replacing its answers, and replans only untouched work', async () => {
    const { learning, ja, en } = await setup()
    const original = await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map(item => [item.id, item.answer])), true, now)
    const before = (await learning.today(now))!
    expect(before.tasks.find(task => task.kind === 'listen')?.materialId).toBe('ja-irodori-starter-9')
    await learning.confirmBeginnerStart(now + 1000)
    const after = (await learning.today(now + 1000))!
    expect(after.tasks.find(task => task.kind === 'listen')?.materialId).toBe('ja-irodori-starter-1')
    expect(after.tasks.some(task => task.materialId?.startsWith('ja-kana-'))).toBe(true)
    expect(after.minutes).toBeLessThanOrEqual(before.minutes)
    expect(await ja.assessments.get(learning.diagnosticId)).toEqual(original)
    expect(await ja.sessions.count()).toBe(0)
    expect(await ja.events.count()).toBe(0)
    expect(await learning.today(now + 2000)).toEqual(after)
    const reopened = createJapaneseWorkspace(ja, en)
    await reopened.open()
    expect(await reopened.startingPoint(now + 2000)).toMatchObject({ basis: 'self-report', conversationProbe: 1 })
  })
  it('keeps already started work and recording originals when the learner corrects their starting preference', async () => {
    const { learning, ja } = await setup()
    await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map(item => [item.id, item.answer])), true, now)
    const before = (await learning.today(now))!
    const attempt = await learning.start(before.tasks[0]!.id, now)
    await ja.audio.add(recording('beginner-original'))
    const saved = await learning.save(attempt.id, { ...japanesePracticeDraft.parse(attempt.draft), response: '保留已写的内容', audioId: 'beginner-original' }, 'listen')
    const events = await ja.events.toArray()
    await learning.confirmBeginnerStart(now + 1000)
    const after = (await learning.today(now + 1000))!
    expect(after.tasks).toEqual(before.tasks)
    expect(await ja.sessions.get(saved.id)).toEqual(saved)
    expect((await ja.audio.get('beginner-original'))?.blob.size).toBeGreaterThan(0)
    expect(await ja.events.toArray()).toEqual(events)
  })
  it.each(['en', 'ja'] as const)('rejects a changed %s owner before saving a beginner confirmation', async language => {
    const { learning, ja, en } = await setup()
    await (language === 'en' ? en : ja).syncMeta.put({ id: 'owner', value: 'other-owner' })
    await expect(learning.confirmBeginnerStart(now)).rejects.toThrow('账号')
    expect(await ja.assessments.get(japaneseBeginnerStartId)).toBeUndefined()
    expect((await ja.profiles.get('main'))?.onboarded).toBe(false)
  })
  it('does not treat an incomplete, future, or scored record as a beginner declaration', async () => {
    const { learning } = await setup()
    const confirmation = await learning.confirmBeginnerStart(now)
    expect(japaneseStartingPoint(undefined, { ...confirmation, completedAt: undefined }, now)).toBeUndefined()
    expect(japaneseStartingPoint(undefined, confirmation, now - 1)).toBeUndefined()
    expect(japaneseStartingPoint(undefined, { ...confirmation, scores: { ...confirmation.scores, scriptRecognition: 1 } }, now)).toBeUndefined()
    expect(japaneseStartingPoint(undefined, { ...confirmation, stage: 'completed' }, now)).toBeUndefined()
  })
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
    expect((await ja.events.toArray()).filter(event => event.type === 'TASK_STARTED')).toHaveLength(1)
    expect((await ja.events.toArray()).filter(event => event.type === 'JAPANESE_COURSE_ASSIGNED')).toHaveLength(1)
    expect((await learning.today(now))?.tasks[0]?.minutes).toBe(task.minutes)
  })
  it('rejects skipped stages, stale writes, foreign recordings and incomplete finish atomically', async () => {
    const { learning, en, ja } = await setup()
    await learning.saveDiagnostic(skipped, true, now)
    const session = await learning.start((await learning.today(now))!.tasks[0]!.id, now)
    const original = japanesePracticeDraft.parse(session.draft)
    await expect(learning.save(session.id, original, 'notice')).rejects.toThrow('首答')
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
    expect((await learning.today(now + 86400000))?.tasks.find(task => task.kind === 'listen')?.materialId).toBe('ja-irodori-starter-1')
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
    expect(await ja.materials.count()).toBe(japaneseMaterials().length + japaneseWrittenExercises.length + tadokuStarterMaterials().length)
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
