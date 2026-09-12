import { describe, expect, it } from 'vitest'
import { externalMaterials, externalPracticeReady } from '../src/content/external'
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
