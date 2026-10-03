import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { japaneseKana, kanaSource } from '../src/content/japanese-kana'
import { japaneseReadingMaterials } from '../src/content/japanese-reading'
import { japaneseReadingDraft, japaneseReadingResult, japaneseReadingHistory, japaneseReadingDelay, nextJapaneseKana, nextJapaneseReading, type JapaneseReadingDraft } from '../src/domain/japanese-reading'
import { createJapaneseWorkspace, japanesePracticeDraft } from '../src/db/japanese'
import { japanesePlacementItems } from '../src/domain/japanese'
import { createLearningRepository } from '../src/db/repository'
import { JoveDatabase } from '../src/db/db'
import { materialSchema } from '../src/db/schema'
import { demoMaterials } from '../src/content/materials'
import type { StudySession } from '../src/domain/types'

const now = Date.UTC(2026, 8, 20, 4), day = 86400000, databases: JoveDatabase[] = []
afterEach(async () => { for (const database of databases.splice(0)) await database.delete() })
function correct(index = 0): JapaneseReadingDraft {
  const unit = japaneseKana[index]!
  return { version: 1, revision: 0, taskId: `kana-${index}`, minutes: 3, helped: false, seen: false, sourcePractice: 'heard',
    meaning: unit.questions.map(q => q.answer) as [string, string], kana: unit.words.map(w => w.reading) as [string, string], note: '下一次先听再看字形。', effort: 'okay' }
}
function completed(index: number, time: number, patch: Partial<JapaneseReadingDraft> = {}): StudySession {
  return { id: `foundation-${index}-${time}`, kind: 'japanese-reading', materialId: japaneseKana[index]!.id, startedAt: time - 1000,
    completedAt: time, stage: 'completed', draft: { ...correct(index), lockedAt: time - 10, dueAt: time + 3 * day, ...patch } }
}
async function setup() {
  const en = new JoveDatabase(`kana-en-${crypto.randomUUID()}`, 'en'), ja = new JoveDatabase(`kana-ja-${crypto.randomUUID()}`, 'ja')
  databases.push(en, ja); await createLearningRepository(en).initialize(demoMaterials)
  const learning = createJapaneseWorkspace(ja, en); await learning.open()
  return { en, ja, learning }
}

describe('small Japanese script-and-sound foundation alongside communication', () => {
  it('covers both basic 46-character inventories, small groups and original non-hosted contrasts', () => {
    expect(japaneseKana).toHaveLength(38)
    for (const script of ['hiragana', 'katakana']) {
      const basic = japaneseKana.filter(r => r.kana?.script === script).slice(0, 10)
      expect(new Set(basic.flatMap(r => r.kana!.targets)).size).toBe(46)
    }
    for (const [i, unit] of japaneseKana.entries()) {
      expect(unit.kana!.targets.length).toBeLessThanOrEqual(5)
      expect(new URL(unit.kana!.sourceUrl).hostname).toBe('a1.marugotoweb.jp')
      expect(japaneseReadingResult(unit, correct(i))).toEqual({ meaning: [true, true], kana: [true, true] })
      for (const question of unit.questions) { expect(new Set(question.choices).size).toBe(3); expect(question.choices).toContain(question.answer) }
      for (const word of unit.words) { expect(new Set(word.choices).size).toBe(3); expect(word.choices).toContain(word.reading) }
    }
    for (const material of japaneseReadingMaterials(japaneseKana)) {
      expect(materialSchema.safeParse(material).success).toBe(true)
      expect(material.audioPath).toBeUndefined(); expect(material.audioId).toBeUndefined(); expect(material.externalStudy).toBeUndefined()
    }
    expect(japaneseKana.find(r => r.id === 'ja-kana-rhythm-1')!.questions[0]!.answer).toBe('五拍')
    expect(kanaSource.policy).toBe('https://marugotoweb.jp/en/site_policy.php')
  })
  it('checks the assigned script, not just equivalent sounds, without converting kana drills into reading calibration', () => {
    const katakanaIndex = japaneseKana.findIndex(r => r.id === 'ja-kana-katakana-1')
    expect(japaneseReadingResult(japaneseKana[katakanaIndex]!, { ...correct(katakanaIndex), kana: ['あい', 'うえ'] }).kana).toEqual([false, false])
    const history = [completed(0, now - 2 * day), completed(1, now - day), completed(2, now)]
    expect(japaneseReadingHistory(history, now)).toHaveLength(0)
    expect(nextJapaneseReading(history, now)).toMatchObject({ id: 'ja-reading-0-1', trial: false })
    expect(nextJapaneseKana([], now, false)?.id).toBe('ja-kana-rhythm-1')
    expect(nextJapaneseKana([], now, true)?.id).toBe('ja-kana-hiragana-1')
  })
  it('requires an explicit original-listening self-report or script-only fallback and keeps it locked', async () => {
    const { learning, ja, en } = await setup()
    const session = await learning.reading.start({ id: 'foundation-task', kind: 'learn', title: 'Fixture', reason: 'Fixture', minutes: 3, done: false, materialId: japaneseKana[0]!.id }, now)
    const first = japaneseReadingDraft.parse(session.draft)
    expect(session.stage).toBe('teach'); expect(first.helped).toBe(true)
    await expect(learning.reading.save(session.id, first, 'lock', now + 10)).rejects.toThrow('教学')
    const taught = await learning.reading.save(session.id, first, 'help', now + 11)
    await expect(learning.reading.save(session.id, japaneseReadingDraft.parse(taught.draft), 'lock', now + 12)).rejects.toThrow('原站示范')
    const locked = await learning.reading.save(session.id, { ...japaneseReadingDraft.parse(taught.draft), ...correct(), helped: true, revision: Number(taught.draft.revision), sourcePractice: 'unavailable' }, 'lock', now + 20)
    const cannotRewrite = await learning.reading.save(session.id, { ...japaneseReadingDraft.parse(locked.draft), sourcePractice: 'heard' })
    expect(cannotRewrite.draft.sourcePractice).toBe('unavailable')
    const saved = await learning.reading.finish(session.id, Number(cannotRewrite.draft.revision), now + 30)
    expect(saved.draft.dueAt).toBe(now + 30 + day)
    const event = (await ja.events.toArray()).find(e => e.type === 'JAPANESE_KANA_CHECK')!
    expect(event.data).toMatchObject({ scriptRecognitionMatches: 2, kanaMatches: 2, publisherHeardSelfReport: false, playbackObserved: false, listeningAssessed: false, acousticAssessed: false })
    expect((await ja.events.toArray()).some(e => e.type === 'JAPANESE_READING_CHECK' || e.skill || e.modality)).toBe(false)
    expect(await ja.audio.count()).toBe(0); expect(await en.sessions.count()).toBe(0)
  })
  it('does not extend the first heard recheck on the basis of a previous silent-only success', () => {
    const unit = japaneseKana[0]!
    expect(japaneseReadingDelay(unit, { ...correct(), sourcePractice: 'unavailable' }, [], now)).toBe(day)
    expect(japaneseReadingDelay(unit, correct(), [completed(0, now - 4 * day, { sourcePractice: 'unavailable' })], now)).toBe(3 * day)
    expect(japaneseReadingDelay(unit, correct(), [completed(0, now - 4 * day)], now)).toBe(7 * day)
    expect(nextJapaneseKana([completed(0, now - 4 * day)], now, true)?.id).toBe(unit.id)
    expect(nextJapaneseKana([completed(0, now - 5 * day, { seen: true }), completed(1, now - 4 * day, { seen: true })], now, true)?.id).toBe(japaneseKana[2]!.id)
  })
  it.each([15, 45])('teaches a declared absolute beginner first within a shared %i-minute day and preserves that stopping point', async dailyMinutes => {
    const { learning, en, ja } = await setup()
    await en.profiles.update('main', { dailyMinutes })
    await learning.confirmBeginnerStart(now)
    const plan = (await learning.today(now))!
    expect(plan.tasks).toHaveLength(1)
    expect(plan.tasks[0]).toMatchObject({ materialId: 'ja-kana-hiragana-1', kind: 'learn', minutes: 5 })
    expect(plan.minutes).toBeLessThanOrEqual(dailyMinutes / 2 + 1)
    let session = await learning.start(plan.tasks[0]!.id, now)
    expect(session.stage).toBe('teach')
    session = await learning.reading.save(session.id, { ...japaneseReadingDraft.parse(session.draft), sourcePractice: 'unavailable' }, 'help', now + 1)
    session = await learning.reading.save(session.id, { ...japaneseReadingDraft.parse(session.draft), meaning: ['a', 'o'], kana: ['あい', 'うえ'] }, 'lock', now + 2)
    session = await learning.reading.finish(session.id, Number(session.draft.revision), now + 3)
    expect(session.draft.note).toBe('')
    expect((await ja.events.get(`${session.id}:result`))?.prompted).toBe(true)
    expect((await learning.today(now + 4))?.tasks.every(t => t.done)).toBe(true)
    expect(await en.sessions.count()).toBe(0); expect(await en.events.count()).toBe(0)
    const next = (await learning.today(now + day))!
    expect(next.minutes).toBeLessThanOrEqual(dailyMinutes / 2 + 1)
    expect(next.tasks.some(t => t.kind === 'listen')).toBe(true)
    if (dailyMinutes === 15) expect(next.tasks.filter(t => !t.done).every(t => t.minutes >= 5)).toBe(true)
    const repeat = await learning.reading.start({ ...plan.tasks[0]!, id: 'next-day-recall', done: false }, now + day)
    expect(repeat).toMatchObject({ stage: 'read', draft: { seen: true, helped: false } })
  })
  it('upgrades a pre-existing untouched zero-beginner plan without requiring another declaration or changing a saved diagnosis', async () => {
    const { learning, ja } = await setup()
    const diagnostic = await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map(i => [i.id, i.answer])), true, now - 100)
    await learning.confirmBeginnerStart(now - 50)
    const date = new Date(now).toLocaleDateString('en-CA')
    await ja.plans.put({ id: date, date, minutes: 20, focus: 'realWorld', createdAt: now - 10, evidenceFingerprint: 'old-client', tasks: [
      { id: `${date}:ja:old-course`, kind: 'listen', title: 'Old untouched course', minutes: 20, materialId: 'ja-irodori-starter-9', reason: 'old', done: false },
    ] })
    expect((await learning.today(now))?.tasks[0]?.materialId).toBe('ja-kana-hiragana-1')
    expect(await ja.assessments.get(learning.diagnosticId)).toEqual(diagnostic)
    expect(await ja.assessments.count()).toBe(2); expect(await ja.events.count()).toBe(0)
  })
  it('does not skip teaching after another day only opened a teach draft', async () => {
    const { learning } = await setup()
    const task = { id: 'opened-only', kind: 'learn' as const, title: 'kana', minutes: 3, reason: 'fixture', materialId: 'ja-kana-hiragana-1', done: false }
    const opened = await learning.reading.start(task, now)
    expect(opened.stage).toBe('teach')
    const again = await learning.reading.start({ ...task, id: 'different-day' }, now + day)
    expect(again).toMatchObject({ stage: 'teach', draft: { seen: false, helped: true } })
  })
  it('never removes the only short-day course when script support makes auxiliary reading and dialogue unavailable', async () => {
    const { learning, en, ja } = await setup()
    await en.profiles.update('main', { dailyMinutes: 15 })
    await learning.confirmBeginnerStart(now - day)
    await ja.sessions.put(completed(0, now - 100))
    for (let i = 0; i < 2; i++) await ja.events.add({ id: `supported-${i}`, type: 'EXTERNAL_LISTEN_REFLECTION', source: 'self-report', sessionId: `course-${i}`, timestamp: now - 1000 + i,
      data: { materialId: 'ja-irodori-starter-1', response: '问候', expression: 'こんにちは。', example: 'こんにちは。', audioId: 'fixture', listened: true, playbackObserved: false, comprehensionVerified: false } })
    const plan = (await learning.today(now))!
    expect(plan.tasks.some(t => t.kind === 'listen' && t.minutes >= 5)).toBe(true)
    expect(plan.tasks.some(t => t.kind === 'speak' || t.materialId?.startsWith('ja-reading-'))).toBe(false)
  })
  it('keeps new beginner course attempts scaffolded until script exposure, without rewriting old assignments or counting supported transfer', async () => {
    const { learning, ja } = await setup()
    await learning.confirmBeginnerStart(now - day)
    await ja.sessions.put(completed(0, now - 100))
    const plan = (await learning.today(now))!, course = plan.tasks.find(t => t.kind === 'listen')!
    const session = await learning.start(course.id, now)
    const id = `${session.id}:course-assignment`, assignment = (await ja.events.get(id))!
    expect(assignment.data?.beginnerScaffold).toBe(true)
    await ja.events.put({ ...assignment, data: { ...assignment.data, coursePhase: 'delayed-transfer' } })
    expect(await learning.practiceGuide(session.id)).toMatchObject({ independentFirst: false })
    const saved = await learning.save(session.id, { ...japanesePracticeDraft.parse(session.draft), response: '还不懂，先学问候', listened: true }, 'notice')
    expect(saved.stage).toBe('notice')
    expect((await ja.events.get(`${session.id}:independent-attempt`))?.prompted).toBe(true)
    for (let index = 1; index < 10; index++) await ja.sessions.put(completed(index, now - 10))
    expect((await ja.events.get(id))?.data?.beginnerScaffold).toBe(true)
    expect(await ja.skills.filter(s => s.evidenceCount > 0).count()).toBe(0)
  })
  it('reserves three minutes without gating the first conversation or refilling an existing day', async () => {
    const { learning } = await setup()
    await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map(item => [item.id, '跳过'])), true, now)
    const plan = (await learning.today(now))!, foundation = plan.tasks.find(t => t.materialId?.startsWith('ja-kana-'))!
    expect(plan.tasks[0]?.kind).toBe('listen'); expect(foundation.minutes).toBe(3)
    expect(plan.minutes).toBeLessThanOrEqual(23)
    const session = await learning.start(foundation.id, now)
    const taught = await learning.reading.save(session.id, japaneseReadingDraft.parse(session.draft), 'help', now + 1)
    const saved = await learning.reading.save(session.id, { ...japaneseReadingDraft.parse(taught.draft), ...correct(), revision: Number(taught.draft.revision), sourcePractice: 'unavailable' }, 'lock', now + 10)
    await learning.reading.finish(session.id, Number(saved.draft.revision), now + 20)
    const after = (await learning.today(now + 30))!
    expect(after.tasks.filter(t => t.materialId?.startsWith('ja-kana-'))).toHaveLength(1)
    expect(after.tasks.find(t => t.materialId?.startsWith('ja-kana-'))?.done).toBe(true)
    expect(after.tasks.find(t => t.kind === 'listen')?.done).toBe(false)
  })
  it('rotates limited fifteen-minute days instead of letting foundation consume every integrated-practice slot', async () => {
    const { learning, en, ja } = await setup()
    await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map(item => [item.id, '跳过'])), true, now)
    for (const i of [1, 2]) await ja.events.add({ id: `intro-${i}`, type: 'EXTERNAL_LISTEN_REFLECTION', source: 'self-report', sessionId: `history-${i}`, timestamp: now - day + i,
      data: { materialId: `ja-irodori-starter-${i}`, response: 'Fixture', expression: 'Fixture', example: 'Fixture', audioId: 'fixture', listened: true, playbackObserved: false, comprehensionVerified: false } })
    let foundationDays = 0, interactionDays = 0
    for (let i = 1; i <= 6; i++) {
      const at = now + i * day
      await en.events.add({ id: `english-${i}`, type: 'TASK_COMPLETED', source: 'objective', timestamp: at, data: { taskId: `english-${i}`, minutes: 30 } })
      const plan = (await learning.today(at))!
      expect(plan.minutes).toBe(15); expect(plan.tasks.find(t => t.kind === 'listen')!.minutes).toBeGreaterThanOrEqual(10)
      foundationDays += Number(plan.tasks.some(t => t.materialId?.startsWith('ja-kana-')))
      interactionDays += Number(plan.tasks.some(t => t.kind === 'speak' || t.materialId?.startsWith('ja-reading-')))
    }
    expect(foundationDays).toBe(2); expect(interactionDays).toBe(4)
  })
})
