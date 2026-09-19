import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JoveDatabase } from '../src/db/db'
import { createLearningRepository } from '../src/db/repository'
import { createJapaneseWorkspace } from '../src/db/japanese'
import { japaneseReviewDraft } from '../src/db/japanese-review'
import { japanesePlacementItems } from '../src/domain/japanese'
import { japaneseStarterMaterials } from '../src/content/japanese'
import { demoMaterials } from '../src/content/materials'
import type { Modality } from '../src/domain/types'
import { readLanguageDay } from '../src/db/language-day'

const databases: JoveDatabase[] = [], now = Date.UTC(2026, 8, 20, 4)
afterEach(async () => { vi.useRealTimers(); for (const db of databases.splice(0)) await db.delete() })
async function setup(modality: Modality = 'recall') {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now)
  const en = new JoveDatabase(`ja-review-en-${crypto.randomUUID()}`, 'en'), ja = new JoveDatabase(`ja-review-ja-${crypto.randomUUID()}`, 'ja')
  databases.push(en, ja)
  await createLearningRepository(en).initialize(demoMaterials)
  const learning = createJapaneseWorkspace(ja, en)
  await learning.open(); await learning.saveDiagnostic(Object.fromEntries(japanesePlacementItems.map(item => [item.id, '跳过'])), true, now)
  const material = japaneseStarterMaterials()[0]!, chunk = await learning.repository.addChunk(material.chunks[0]!, material.id)
  await ja.chunks.update(chunk.id, { createdAt: now - 86400000 })
  for (const card of await ja.cards.toArray()) if (card.modality !== modality) await ja.cards.put({ ...card, card: { ...card.card, due: new Date(now + 86400000) } })
  const plan = (await learning.today(now))!, task = plan.tasks.find(task => task.kind === 'review')!
  const session = await learning.start(task.id, now)
  return { en, ja, learning, plan, task, session }
}

describe('Japanese delayed review with separate recall evidence', () => {
  it('automatically reserves a small review block without duplicating the daily allowance', async () => {
    const { learning, en, ja, task, plan } = await setup()
    expect(task.minutes).toBe(1)
    expect(plan.tasks.some(task => task.kind === 'listen')).toBe(true)
    const day = await readLanguageDay(en, now, ja)
    expect(plan.minutes).toBeLessThanOrEqual(day!.allowances.ja.planCap)
    expect((await learning.today(now))?.tasks[0]?.id).toBe(task.id)
  })
  it('does not prime sibling modalities with the same answer inside one block', async () => {
    const { learning, ja, session } = await setup()
    const chunk = (await ja.chunks.toArray())[0]!
    for (const card of await ja.cards.toArray()) await ja.cards.put({ ...card, card: { ...card.card, due: new Date(now) } })
    const draft = japaneseReviewDraft.parse(session.draft)
    expect(draft.items).toHaveLength(1)
    expect((await ja.cards.get(draft.items[0]!.cardId))?.chunkId).toBe(chunk.id)
    const nextDay = now + 86400000
    const next = (await learning.today(nextDay))!.tasks.find(task => task.kind === 'review')!
    const block = await learning.review.start(next, nextDay)
    expect(japaneseReviewDraft.parse(block.draft).items).toHaveLength(1)
  })
  it('locks the actual first response before revealing and schedules only its own modality', async () => {
    const { learning, ja, en, session, task } = await setup()
    const initial = japaneseReviewDraft.parse(session.draft), target = initial.items[0]!
    const saved = await learning.review.save(session.id, 0, { response: 'おはようございます。', audioId: '', heard: false }, true, now)
    expect(japaneseReviewDraft.parse(saved.draft).items[0]?.hintUsed).toBe(false)
    await expect(learning.review.save(session.id, 1, { response: '看到参考后修改', audioId: '', heard: false })).rejects.toThrow('首答已锁定')
    await learning.review.rate(session.id, 1, 3, now)
    await learning.review.rate(session.id, 1, 3, now)
    expect((await ja.cards.get(target.cardId))?.card.reps).toBe(1)
    expect((await ja.cards.toArray()).filter(card => card.id !== target.cardId).every(card => card.card.reps === 0)).toBe(true)
    expect((await ja.events.toArray()).filter(event => event.type === 'REVIEW_RESPONSE')).toHaveLength(1)
    expect((await ja.events.toArray()).filter(event => event.type === 'TASK_COMPLETED')).toHaveLength(1)
    expect((await ja.skills.toArray()).every(skill => skill.evidenceCount === 0)).toBe(true)
    expect((await learning.today(now))?.tasks.find(candidate => candidate.id === task.id)?.done).toBe(true)
    expect(await en.cards.count()).toBe(0); expect(await en.sessions.count()).toBe(0)
  })
  it('schedules an early retry after hints even when the learner rates it easy', async () => {
    const { learning, session, ja } = await setup()
    await learning.review.save(session.id, 0, { response: '', audioId: '', heard: false }, true, now)
    await learning.review.rate(session.id, 1, 4, now)
    const review = (await ja.events.toArray()).find(event => event.type === 'review')!
    expect(review.prompted).toBe(true); expect(review.data?.scheduledRating).toBe(1)
  })
  it.each(['json-backup', 'still-referenced'])('keeps oral first answers frozen and schedules a conservative retry when audio is absent (%s)', async mode => {
    const { learning, session, ja } = await setup('speaking')
    await ja.audio.put({ id: 'spoken', blob: new Blob(['test-only-recording']), kind: 'recording', processed: false,
      mimeType: 'audio/wav', createdAt: now, duration: 2, label: 'Japanese response' })
    await learning.review.save(session.id, 0, { response: '原始首答', audioId: 'spoken', heard: false }, true, now)
    const backup = await learning.repository.exportBackup()
    // Isolated fixture represents restoring a JSON-only backup on a new device.
    await ja.audio.clear()
    if (mode === 'json-backup') await learning.repository.restoreBackup(backup)
    expect((await learning.review.read(session.id)).draft.items[0]).toMatchObject({ response: '原始首答', audioId: mode === 'json-backup' ? '' : 'spoken', revealed: true })
    await expect(learning.review.save(session.id, 1, { response: '看过答案后', audioId: '', heard: false })).rejects.toThrow('首答已锁定')
    await learning.review.rate(session.id, 1, 4, now)
    const rating = (await ja.events.toArray()).find(event => event.type === 'review')!
    expect(rating.prompted).toBe(true); expect(rating.data?.scheduledRating).toBe(1)
    expect((await ja.skills.toArray()).every(skill => skill.evidenceCount === 0)).toBe(true)
  })
  it('does not turn typed Japanese into independent speaking or a publisher click into hearing evidence', async () => {
    const { learning, session, ja } = await setup('speaking')
    const saved = await learning.review.save(session.id, 0, { response: 'おはようございます', audioId: '', heard: false }, true, now)
    expect(japaneseReviewDraft.parse(saved.draft).items[0]?.hintUsed).toBe(true)
    await learning.review.rate(session.id, 1, 3, now)
    expect((await ja.skills.toArray()).every(skill => skill.evidenceCount === 0)).toBe(true)
  })
  it('preserves a stale-tab response and refuses to overwrite or apply a second schedule', async () => {
    const { learning, session, ja, en } = await setup()
    await learning.review.save(session.id, 0, { response: '独立首答', audioId: '', heard: false }, false, now)
    await expect(learning.review.save(session.id, 0, { response: '另一个标签页的旧内容', audioId: '', heard: false })).rejects.toThrow('其他页面')
    const saved = await learning.review.read(session.id)
    expect(saved.draft.items[0]?.response).toBe('独立首答')
    const target = (await ja.cards.get(saved.draft.items[0]!.cardId))!
    await learning.repository.reviewCard(target.id, 3, { source: 'self-report' })
    await expect(learning.review.save(session.id, 1, { response: '独立首答', audioId: '', heard: false }, true, now)).rejects.toThrow('卡片已更新')
    const resolved = await learning.review.recover(session.id, 1, { response: '保留尚未调度的首答', audioId: '', heard: false }, now)
    expect(resolved.completedAt).toBe(now)
    expect(japaneseReviewDraft.parse(resolved.draft).items[0]).toMatchObject({ response: '保留尚未调度的首答', skipped: 'schedule-changed' })
    expect((await ja.cards.get(target.id))?.card.reps).toBe(1)
    expect((await ja.events.toArray()).filter(event => event.type === 'TASK_COMPLETED')).toHaveLength(0)
    expect((await learning.today(now))?.tasks.find(task => task.kind === 'review')).toMatchObject({ done: false, optional: true })
    const day = await readLanguageDay(en, now, ja)
    expect(day?.allowances.ja.completed).toBe(0)
    expect(day?.remaining).toBe(45)
  })
})
