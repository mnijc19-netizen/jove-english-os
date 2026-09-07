import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assessmentPrompts, assessmentRubric, demoMaterials, missions } from '../src/content/materials'
import manifest from '../public/audio/manifest.json'

const audioRoot = new URL('../public/audio/', import.meta.url)
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const requiredMissions = ['stranger', 'flatmate', 'restaurant', 'shopping', 'airport', 'transport', 'bank', 'landlord', 'work', 'interview', 'clarification', 'social', 'living-abroad']

function readWave(file: string) {
  expect(file).toMatch(/^audio\/[a-z][a-z0-9-]*\.wav$/)
  const bytes = readFileSync(new URL(file.replace(/^audio\//, ''), audioRoot))
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE')
  expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length)
  let pcm: Buffer | undefined
  let validFormat = false
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    expect(start + size).toBeLessThanOrEqual(bytes.length)
    if (kind === 'fmt ') {
      expect(size).toBeGreaterThanOrEqual(16)
      expect(bytes.readUInt16LE(start)).toBe(1) // PCM, not a renamed compressed file.
      expect(bytes.readUInt16LE(start + 2)).toBe(1)
      expect(bytes.readUInt32LE(start + 4)).toBe(22050)
      expect(bytes.readUInt32LE(start + 8)).toBe(44100)
      expect(bytes.readUInt16LE(start + 12)).toBe(2)
      expect(bytes.readUInt16LE(start + 14)).toBe(16)
      validFormat = true
    }
    if (kind === 'data') {
      expect(pcm).toBeUndefined()
      pcm = bytes.subarray(start, start + size)
    }
    offset = start + size + size % 2
  }
  expect(validFormat).toBe(true)
  if (!pcm) throw new Error(`Missing PCM samples: ${file}`)
  expect(pcm.length % 2).toBe(0)
  expect(pcm.length).toBeGreaterThan(4410)
  let energy = 0
  let active = 0
  let clipped = 0
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset)
    energy += (sample / 32768) ** 2
    if (Math.abs(sample) > 100) active++
    if (Math.abs(sample) >= 32760) clipped++
  }
  const samples = pcm.length / 2
  expect(Math.sqrt(energy / samples)).toBeGreaterThan(0.005)
  expect(active / samples).toBeGreaterThan(0.1)
  expect(clipped / samples).toBeLessThan(0.01)
  return { bytes, pcm, duration: pcm.length / 44100 }
}

describe('reviewed original demo content', () => {
  it('contains six unique, balanced materials without runtime services', () => {
    expect(demoMaterials).toHaveLength(6)
    expect(new Set(demoMaterials.map(m => m.id)).size).toBe(demoMaterials.length)
    expect(new Set(demoMaterials.map(m => m.topic))).toEqual(new Set(['Everyday life', 'Technology', 'Living abroad']))
    expect(new Set(demoMaterials.flatMap(m => m.chunks.map(c => c.text))).size).toBe(18)
  })

  it.each(demoMaterials)('$id has complete, coherent Material fields and three reusable chunks', material => {
    expect(material.id).toMatch(/^[a-z][a-z0-9-]+$/)
    expect(material.title.trim().length).toBeGreaterThan(8)
    expect(material.difficulty).toBeGreaterThanOrEqual(0)
    expect(material.difficulty).toBeLessThanOrEqual(1)
    expect(material.duration).toBeGreaterThanOrEqual(15)
    expect(material.duration).toBeLessThanOrEqual(60)
    expect(material.createdAt).toBe(Date.UTC(2026, 8, 7))
    expect(material.sourceKind).toBe('curated')
    expect(material.sourceLabel).toBe('Original reviewed demo / synthetic speech')
    expect(material.synthetic).toBe(true)
    expect(material.approved).toBe(true)
    expect(material.sourceUrl).toBeUndefined()
    expect(material.audioId).toBeUndefined()
    expect(material.license).toContain('Original project text')
    expect(material.audioPath).toBe(`audio/${material.id}.wav`)
    expect(material.sentences.length).toBeGreaterThanOrEqual(3)
    expect(material.sentences.length).toBeLessThanOrEqual(6)
    expect(material.transcript).toBe(material.sentences.join(' '))
    expect(material.transcript).not.toMatch(/[<>]|https?:\/\//)
    expect(material.translation).toMatch(/[\u4e00-\u9fff]/)
    expect(material.question).toMatch(/\?$/)
    expect(material.answer.length).toBeGreaterThan(40)
    expect(material.answer).not.toMatch(/[\u4e00-\u9fff]/)
    expect(material.keywords.length).toBeGreaterThanOrEqual(3)
    expect(new Set(material.keywords).size).toBe(material.keywords.length)
    for (const keyword of material.keywords) {
      expect(material.transcript.toLowerCase()).toContain(keyword.toLowerCase())
      expect(material.answer.toLowerCase()).toContain(keyword.toLowerCase())
    }
    for (const sentence of material.sentences) {
      expect(sentence.trim()).toBe(sentence)
      expect(sentence.split(/\s+/).length).toBeGreaterThanOrEqual(6)
      expect(sentence).toMatch(/[.!?]$/)
    }
    expect(material.chunks).toHaveLength(3)
    for (const chunk of material.chunks) {
      expect(material.transcript.toLowerCase()).toContain(chunk.text.toLowerCase())
      expect(chunk.text.split(/\s+/).length).toBeGreaterThanOrEqual(2)
      expect(chunk.meaningEn.length).toBeGreaterThan(20)
      expect(chunk.meaningEn).toMatch(/neutral|informal|professional|everyday|friendly/)
      expect(chunk.meaningZh).toMatch(/[\u4e00-\u9fff]/)
      expect(chunk.example.toLowerCase()).toContain(chunk.text.toLowerCase())
      expect(material.sentences).not.toContain(chunk.example)
    }
  })
})

describe('playable, precisely aligned local audio', () => {
  it('ships exactly one full clip plus every zero-based sentence and declares PCM provenance', () => {
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.generator).toContain('synthetic speech')
    expect(manifest.sentenceIndexBase).toBe(0)
    expect(manifest.sampleRate).toBe(22050)
    expect(manifest.channels).toBe(1)
    expect(manifest.bitsPerSample).toBe(16)
    expect(manifest.materials.map(m => m.id)).toEqual(demoMaterials.map(m => m.id))
    const expectedFiles = demoMaterials.flatMap(m => [`${m.id}.wav`, ...m.sentences.map((_, i) => `${m.id}-${i}.wav`)])
    expect(readdirSync(fileURLToPath(audioRoot)).filter(f => f.endsWith('.wav')).sort()).toEqual(expectedFiles.sort())
  })

  it.each(demoMaterials)('$id matches its transcript, real duration, and sentence PCM', material => {
    const entry = manifest.materials.find(m => m.id === material.id)
    if (!entry) throw new Error(`Missing audio manifest entry: ${material.id}`)
    expect(entry.file).toBe(material.audioPath)
    expect(entry.transcriptSha256).toBe(hash(material.transcript))
    expect(entry.voice.trim().length).toBeGreaterThan(0)
    expect(Number.isInteger(entry.rate)).toBe(true)
    expect(entry.rate).toBeGreaterThanOrEqual(-3)
    expect(entry.rate).toBeLessThanOrEqual(3)
    expect(entry.sentences).toHaveLength(material.sentences.length)
    const full = readWave(entry.file)
    expect(full.duration).toBeGreaterThanOrEqual(15)
    expect(full.duration).toBeLessThanOrEqual(60)
    expect(full.duration).toBeCloseTo(entry.duration, 6)
    expect(Math.round(full.duration)).toBe(material.duration)
    expect(hash(full.bytes)).toBe(entry.sha256)
    const sentencePcm = entry.sentences.map((sentence, index) => {
      expect(sentence.index).toBe(index)
      expect(sentence.file).toBe(`audio/${material.id}-${index}.wav`)
      expect(sentence.textSha256).toBe(hash(material.sentences[index]!))
      const wave = readWave(sentence.file)
      expect(wave.duration).toBeCloseTo(sentence.duration, 6)
      expect(hash(wave.bytes)).toBe(sentence.sha256)
      return wave.pcm
    })
    expect(Buffer.concat(sentencePcm).equals(full.pcm)).toBe(true)
  })
})

describe('mission coverage and honest rotating assessments', () => {
  it('covers all thirteen real-life scenes with partner openings and three concrete goals', () => {
    expect(missions.map(m => m.id).sort()).toEqual([...requiredMissions].sort())
    for (const mission of missions) {
      expect(mission.title.length).toBeGreaterThan(10)
      expect(mission.scene.length).toBeGreaterThan(60)
      expect(mission.opening.length).toBeGreaterThan(30)
      expect(mission.goals).toHaveLength(3)
      expect(new Set(mission.goals).size).toBe(3)
      expect(mission.goals.every(goal => goal.length > 20)).toBe(true)
      expect(['Everyday life', 'Technology', 'Living abroad']).toContain(mission.topic)
    }
  })

  it('rotates actual material and mission references while retaining one rubric', () => {
    expect(assessmentPrompts).toHaveLength(3)
    expect(new Set(assessmentPrompts.map(p => p.id)).size).toBe(3)
    expect(new Set(assessmentPrompts.map(p => p.listeningMaterialId)).size).toBe(3)
    for (const prompt of assessmentPrompts) {
      expect(demoMaterials.some(m => m.id === prompt.listeningMaterialId)).toBe(true)
      expect(missions.some(m => m.id === prompt.missionId)).toBe(true)
      expect(prompt.listening).toContain('without the transcript')
      expect(prompt.retell).toContain('45–60 second')
      expect(prompt.conversation.length).toBeGreaterThan(80)
    }
    expect(assessmentRubric.dimensions).toHaveLength(5)
    expect(assessmentRubric.anchors).toHaveLength(3)
    expect(assessmentRubric.limits).toContain('null for unobserved')
    expect(assessmentRubric.limits).toContain('Intelligibility needs audio evidence')
    expect(assessmentRubric.limits).toContain('not psychometrically equated')
  })
})
