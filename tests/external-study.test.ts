import { describe, expect, it } from 'vitest'
import { externalMaterials, externalPracticeReady, externalLessonCandidates } from '../src/content/external'
import { materialSchema } from '../src/db/schema'
import { aggregateSkills, makePlan } from '../src/domain/engine'
import { defaultProfile, type StudyEvent } from '../src/domain/types'
import { demoMaterials } from '../src/content/materials'

describe('publisher-linked guided lessons', () => {
  it('stores only validated page metadata and original prompts, never media or copied text', () => {
    expect(externalMaterials).toHaveLength(4)
    expect(new Set(externalMaterials.map(m => m.id)).size).toBe(4)
    for (const item of externalMaterials) {
      expect(materialSchema.parse(item)).toEqual(item)
      expect(item.transcript).toBe(''); expect(item.sentences).toEqual([])
      expect(item.authenticPlayback).toBeUndefined(); expect(item.audioPath).toBeUndefined(); expect(item.audioId).toBeUndefined()
    }
    expect(JSON.stringify(externalMaterials).length).toBeLessThan(6000)
  })
  it.each(['javascript:alert(1)','https://evil.example/course','https://www.esl-lab.com.evil.example/easy/first-date/',
    'https://user:pass@www.esl-lab.com/easy/first-date/','https://www.esl-lab.com/easy/first-date/?redirect=evil',
    'https://www.esl-lab.com/audio.mp3'])('rejects unsafe or non-page targets: %s', sourceUrl => {
    expect(materialSchema.safeParse({ ...externalMaterials[0], sourceUrl }).success).toBe(false)
  })
  it('cannot label a copied transcript or a stored audio file as external-only', () => {
    for (const patch of [{ transcript:'pretend captions' },{sentences:['pretend speech']},{audioPath:'audio/demo.wav'},{audioId:'recording'},{synthetic:true}])
      expect(materialSchema.safeParse({...externalMaterials[0],...patch}).success).toBe(false)
  })
  it('automatically selects an approachable external lesson without using it as a local reader/retell reference', () => {
    const profile={...defaultProfile(),onboarded:true,createdAt:Date.UTC(2026,8,12)}
    const plan=makePlan(profile,[],[],[],[...demoMaterials,...externalMaterials],undefined,Date.UTC(2026,8,13,12))
    expect(plan.tasks.find(t=>t.kind==='listen')?.materialId).toMatch(/^external-/u)
    expect(plan.tasks.filter(t=>['learn','shadow','retell'].includes(t.kind)).every(t=>!t.materialId?.startsWith('external-'))).toBe(true)
  })
  it('requires reflection, expression transfer and a recording, not just a link click', () => {
    const complete={listened:true,answer:'The main idea',expression:'come over',example:'Come over for lunch.',audioId:'saved-recording'}
    expect(externalPracticeReady(complete)).toBe(true)
    expect(externalPracticeReady({...complete,listened:false})).toBe(false)
    for(const field of ['answer','expression','example','audioId'] as const) expect(externalPracticeReady({...complete,[field]:''})).toBe(false)
  })
  it('does not turn external clicks, reflections or raw recordings into ability scores', () => {
    const events:StudyEvent[]=['EXTERNAL_LINK_OPENED','EXTERNAL_LISTEN_REFLECTION','EXTERNAL_RETELL_RECORDED'].map((type,i)=>({
      id:String(i),type,source:i===1?'self-report':'objective',timestamp:Date.now(),data:{materialId:externalMaterials[0]!.id,playbackObserved:false}}))
    expect(aggregateSkills(events).every(s=>s.evidenceCount===0)).toBe(true)
  })
})

describe('external course continuity across weeks', () => {
  const now = Date.UTC(2026, 8, 13, 12), day = 86_400_000
  const profile = { ...defaultProfile(), onboarded: true, createdAt: now - 60 * day }
  const pool = externalMaterials.map(m => ({ ...m, difficulty: 0.2 }))
  const reflection = (materialId: string, timestamp: number, extra: Partial<StudyEvent> = {}): StudyEvent => ({
    id: `reflection:${materialId}:${timestamp}`, type: 'EXTERNAL_LISTEN_REFLECTION', source: 'self-report',
    timestamp, sessionId: `session:${materialId}:${timestamp}`,
    data: { materialId, response: 'My summary', expression: 'An expression', example: 'My own example',
      audioId: 'saved-recording', listened: true, playbackObserved: false, comprehensionVerified: false }, ...extra,
  })
  const selected = (events: StudyEvent[], materials = pool) =>
    makePlan(profile, [], [], events, materials, undefined, now).tasks.find(t => t.kind === 'listen')?.materialId

  it('remembers a submitted lesson beyond seven days and selects eligible new input', () => {
    const first = selected([])!
    expect(selected([reflection(first, now - 30 * day)])).not.toBe(first)
    expect(externalLessonCandidates(pool, [reflection(first, now - 30 * day)], now).map(m => m.id)).not.toContain(first)
  })
  it('revisits the oldest practice when all eligible lessons have been used', () => {
    const history = pool.map((m, i) => reflection(m.id, now - (i + 1) * day))
    expect(selected(history)).toBe(pool.at(-1)!.id)
    const retry = reflection(pool.at(-1)!.id, now - 1000)
    expect(selected([...history, retry])).toBe(pool.at(-2)!.id)
  })
  it.each(['EXTERNAL_LINK_OPENED', 'TASK_OFFERED', 'TASK_STARTED', 'EXTERNAL_RETELL_RECORDED'])(
    '%s alone does not consume a lesson', type => {
      const first = selected([])!
      const history = Array.from({ length: 20 }, (_, i) => reflection(first, now - i, { id: String(i), type, source: 'objective' }))
      expect(selected(history)).toBe(first)
    })
  it('ignores incomplete, wrong-provenance and future reflections', () => {
    const first = selected([])!, valid = reflection(first, now - 1000)
    for (const invalid of [reflection(first, now + day), { ...valid, source: 'ai' as const },
      { ...valid, sessionId: undefined }, { ...valid, data: { ...valid.data, response: ' ' } },
      { ...valid, data: { ...valid.data, audioId: '' } }, { ...valid, data: { ...valid.data, listened: false } }]) {
      expect(selected([invalid])).toBe(first)
    }
  })
  it('is deterministic with shuffled/duplicate history and does not mutate it', () => {
    const history = pool.map((m, i) => reflection(m.id, now - (i + 1) * day))
    const snapshot = JSON.stringify(history)
    expect(selected([...history].reverse())).toBe(selected(history))
    expect(selected([...history, ...history])).toBe(selected(history))
    expect(JSON.stringify(history)).toBe(snapshot)
    expect(aggregateSkills(history).every(s => s.evidenceCount === 0)).toBe(true)
  })
  it('never chooses a too-hard unseen lesson just to avoid repetition', () => {
    const easy = pool[0]!, hard = { ...pool[1]!, difficulty: 1 }
    expect(selected([reflection(easy.id, now - day)], [easy, hard])).toBe(easy.id)
  })
  it('preserves an existing assigned listening task despite new participation history', () => {
    const plan = makePlan(profile, [], [], [], pool, undefined, now)
    const task = plan.tasks.find(t => t.kind === 'listen')!
    const updated = makePlan(profile, [], [], [reflection(task.materialId!, now - 1000)], pool, plan, now)
    expect(updated.tasks.find(t => t.id === task.id)?.materialId).toBe(task.materialId)
    expect(task.reason).toContain('publisher page')
    expect(task.reason).not.toContain('seconds of new input')
  })
  it('handles an empty reserve without inventing materials', () => {
    expect(externalLessonCandidates([], [], now)).toEqual([])
    expect(externalLessonCandidates(demoMaterials, [], now)).toEqual([])
  })
})
