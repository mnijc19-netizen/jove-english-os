import { z } from 'zod'
import { skillNames } from '../domain/types'

const text = z.string().max(1_000_000)
const short = z.string().max(10_000)
const id = z.string().min(1).max(1000).refine(s => !!s.trim() && !['__proto__', 'constructor', 'prototype'].includes(s))
const count = z.number().int().min(0).max(100_000_000)
// Four-digit ISO years round-trip through JSON and the browser date boundary.
const maxTimestamp = 253_402_300_799_999
export const timestampSchema = z.number().int().min(0).max(maxTimestamp)
const score = z.number().min(0).max(1)
const proportion = z.number().min(0).max(1)
const strings = z.array(short).max(10_000)
const ids = z.array(id).max(100_000).refine(a => new Set(a).size === a.length, 'Duplicate references')
export const modalities = ['recognition', 'listening', 'recall', 'cloze', 'speaking', 'transfer'] as const
export const sourceSchema = z.enum(['objective', 'self-report', 'ai', 'text', 'acoustic'])
export const reviewOptionsSchema = z.strictObject({
  responseEventId: id.optional(), sessionId: id.optional(),
  eventId: id.optional(), expectedReps: count.optional(), prompted: z.boolean().optional(), contextId: id.refine(value => value.trim().length > 0, 'Empty context').optional(),
  source: sourceSchema.optional(), score: score.optional(), audioObserved: z.boolean().optional(), transcriptVerified: z.boolean().optional(), audioId: id.optional(),
})
export type ReviewOptions = z.infer<typeof reviewOptionsSchema>
export const repairAttemptOptionsSchema = z.strictObject({
  eventId: id, response: z.string().trim().min(1).max(10_000), timestamp: timestampSchema.optional(),
  contextId: id.refine(value => value.trim().length > 0, 'Empty context').optional(),
})
export type RepairAttemptOptions = z.infer<typeof repairAttemptOptionsSchema>
const secretKey = /^(?:__proto__|prototype|constructor|secrets?|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|credentials?|headers)$/i
const safeKey = z.string().max(1000).refine(key => !secretKey.test(key), 'Forbidden field')
type Json = null | string | number | boolean | Json[] | { [key: string]: Json }
const json: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), text, z.number(), z.boolean(), z.array(json).max(100_000), z.record(safeKey, json),
]))
const httpUrl = z.string().max(10_000).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}, 'Expected an HTTP(S) URL without credentials')
const audioPath = z.string().min(1).max(10_000).refine(value => {
  if (/^https?:\/\//i.test(value)) return httpUrl.safeParse(value).success
  return !/[:\\]/.test(value) && ![...value].some(char => char.charCodeAt(0) <= 32) && !value.startsWith('//') && !value.split('/').includes('..')
}, 'Unsafe audio path')

export const settingsSchema = z.strictObject({
  theme: z.enum(['light', 'dark', 'system']), chineseHelp: z.boolean(), accent: short,
  correctionIntensity: z.number().int().min(0).max(5), fastModel: short, strongModel: short,
  sttModel: short, ttsModel: short, voice: short, dailyBudget: z.number().min(0).max(1_000_000),
  audioLimitMB: z.number().min(1).max(100_000),
  recordingRetention: z.enum(['minimal', 'assessment-only', 'more-history']).optional(),
})
export const profileSchema = z.strictObject({
  id, name: short, goal: short, interests: strings, dailyMinutes: z.number().int().min(1).max(1440),
  fatigue: proportion, onboarded: z.boolean(), createdAt: timestampSchema,
})
export const skillSchema = z.strictObject({ id: z.enum(skillNames), score, confidence: proportion, evidenceCount: count, updatedAt: timestampSchema })
export const eventSchema = z.strictObject({
  id, type: z.string().min(1).max(200), timestamp: timestampSchema, sessionId: id.optional(), skill: z.enum(skillNames).optional(),
  score: score.optional(), source: sourceSchema, chunkId: id.optional(), modality: z.enum(modalities).optional(),
  prompted: z.boolean().optional(), contextId: id.optional(),
  data: z.record(safeKey, z.union([text, z.number(), z.boolean(), strings])).optional(),
})
export const chunkSchema = z.strictObject({
  id, text: z.string().min(1).max(10_000), meaningEn: text, meaningZh: text, sourceSentence: text,
  examples: strings, register: short, sourceIds: ids, readingStrength: score, listeningStrength: score,
  recallStrength: score, productionStrength: score, spontaneousUses: count, createdAt: timestampSchema,
})
const dateSchema = z.union([z.date(), timestampSchema, z.iso.datetime()]).transform(value => new Date(value)).refine(value => Number.isFinite(value.getTime()) && value.getTime() >= 0 && value.getTime() <= maxTimestamp, 'Invalid FSRS date')
export const fsrsCardSchema = z.strictObject({
  due: dateSchema, stability: z.number().min(0).max(1e9), difficulty: z.number().min(0).max(10),
  elapsed_days: z.number().min(0).max(1e9), scheduled_days: z.number().min(0).max(1e9),
  reps: count, lapses: count, learning_steps: count, state: z.number().int().min(0).max(3), last_review: dateSchema.optional(),
}).refine(c => c.lapses <= c.reps && (c.state === 0 ? c.reps === 0 && !c.last_review : c.reps > 0 && !!c.last_review), 'Inconsistent FSRS state')
  .refine(c => !c.last_review || c.due.getTime() >= c.last_review.getTime(), 'Review due precedes last review')
export const reviewCardSchema = z.strictObject({ id, chunkId: id, modality: z.enum(modalities), card: fsrsCardSchema, contextIds: ids, errorId: id.optional() })
export const evaluationErrorSchema = z.strictObject({ category: z.string().min(1).max(1000), original: short, corrected: z.string().trim().min(1).max(10_000), hint: text, explanation: text })
export const errorSchema = z.strictObject({
  id, pattern: text, category: short, original: text, corrected: text, hint: text, explanation: text,
  attempts: count, failures: count, spontaneousSuccesses: count, nextReview: timestampSchema, chunkId: id.optional(),
}).refine(e => e.failures + e.spontaneousSuccesses <= e.attempts, 'Inconsistent error counts')
export const materialChunkSchema = z.strictObject({ text: z.string().trim().min(1).max(10_000), meaningEn: text, meaningZh: text, example: text })
export const authenticPlaybackSchema = z.strictObject({
  segmentId: z.string().regex(/^authentic-[a-f0-9]{64}$/), audioSha256: z.string().regex(/^[a-f0-9]{64}$/),
  startSeconds: z.number().finite().min(0), endSeconds: z.number().finite().positive(),
  sourceAudioSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceStartSeconds: z.number().finite().min(0), sourceEndSeconds: z.number().finite().positive(),
  clipOriginSeconds: z.number().finite().min(0), timingBasis: z.enum(['complete-container', 'mpeg-frame-count-with-preroll', 'pcm-sample-count']),
  mimeType: z.enum(['audio/mpeg', 'audio/wav', 'audio/ogg']), byteLength: z.number().int().min(1).max(10 * 1024 * 1024),
  durationSeconds: z.number().finite().positive().max(86400),
  sentenceRanges: z.array(z.strictObject({ startSeconds: z.number().finite().min(0), endSeconds: z.number().finite().positive() })).min(1).max(100),
}).superRefine((p, ctx) => {
  const duration = p.endSeconds - p.startSeconds
  if (duration < 30 || duration > 120.01 || p.endSeconds > p.durationSeconds + 0.05
    || Math.abs(p.sourceStartSeconds - p.clipOriginSeconds - p.startSeconds) > 0.05
    || Math.abs(p.sourceEndSeconds - p.clipOriginSeconds - p.endSeconds) > 0.05)
    ctx.addIssue({ code: 'custom', message: 'Inconsistent reviewed audio range' })
  p.sentenceRanges.forEach((range, index) => {
    if (range.endSeconds <= range.startSeconds || range.endSeconds > duration + 0.05
      || (index > 0 && range.startSeconds < p.sentenceRanges[index - 1]!.endSeconds - 0.001))
      ctx.addIssue({ code: 'custom', message: 'Inconsistent sentence timing', path: ['sentenceRanges', index] })
  })
})
export const materialSchema = z.strictObject({
  authenticPlayback: authenticPlaybackSchema.optional(),
  id, title: short, topic: short, difficulty: proportion, duration: z.number().min(0).max(1_000_000),
  transcript: text, translation: text.optional(), sentences: strings, audioPath: audioPath.optional(), audioId: id.optional(),
  sourceKind: z.enum(['curated', 'text', 'url', 'audio', 'discovery', 'generated']), sourceUrl: httpUrl.optional(),
  sourceLabel: short, license: short.optional(), synthetic: z.boolean(), approved: z.boolean(),
  question: text, answer: text, keywords: strings, chunks: z.array(materialChunkSchema).max(10_000), createdAt: timestampSchema,
})
export const sessionSchema = z.strictObject({
  id, kind: short, materialId: id.optional(), startedAt: timestampSchema, completedAt: timestampSchema.optional(), stage: short, draft: z.record(safeKey, json),
}).refine(s => s.completedAt === undefined || s.completedAt >= s.startedAt, 'Session ends before it starts')
const taskSchema = z.strictObject({
  id, kind: z.enum(['review', 'listen', 'learn', 'shadow', 'speak', 'repair', 'retell', 'assessment']), title: short,
  minutes: z.number().int().min(1).max(1440), reason: text, done: z.boolean(), materialId: id.optional(), optional: z.boolean().optional(),
})
export const planSchema = z.strictObject({
  // Zero required minutes is valid only when every positive-duration task is optional.
  id, date: z.iso.date(), minutes: z.number().int().min(0).max(10_000), focus: z.enum(skillNames),
  tasks: z.array(taskSchema).min(1).max(100), evidenceFingerprint: short, createdAt: timestampSchema,
}).refine(p => new Set(p.tasks.map(t => t.id)).size === p.tasks.length && p.tasks.reduce((n, t) => n + (t.optional ? 0 : t.minutes), 0) === p.minutes, 'Inconsistent plan tasks')
const evaluationSchema = z.strictObject({
  provenance: z.strictObject({ provider: z.string().min(1).max(100), model: z.string().min(1).max(200) }).optional(),
  summary: text, strengths: strings, errors: z.array(evaluationErrorSchema).max(100),
  comprehension: score.nullable(), accuracy: score.nullable(), fluency: score.nullable(), successfulChunks: strings, nextPrompt: text,
  rubricScores: z.strictObject({ vocabulary: score.nullable(), interaction: score.nullable(), taskCompletion: score.nullable() }).optional(),
})
const messageSchema = z.strictObject({ id, role: z.enum(['user', 'assistant']), text, timestamp: timestampSchema, audioId: id.optional() })
export const conversationSchema = z.strictObject({
  id, mode: short, scenario: text, messages: z.array(messageSchema).max(100_000), startedAt: timestampSchema,
  completedAt: timestampSchema.optional(), evaluation: evaluationSchema.optional(),
}).refine(c => new Set(c.messages.map(m => m.id)).size === c.messages.length && (c.completedAt === undefined || c.completedAt >= c.startedAt), 'Inconsistent conversation')
export const assessmentSchema = z.strictObject({
  id, timestamp: timestampSchema, variant: count, stage: short, responses: z.record(safeKey, text),
  scores: z.record(safeKey, score.nullable()), completedAt: timestampSchema.optional(),
}).refine(a => a.completedAt === undefined || a.completedAt >= a.timestamp, 'Assessment ends before it starts')
export const audioMetadataSchema = z.strictObject({
  id, mimeType: short, createdAt: timestampSchema, duration: z.number().min(0).max(1_000_000),
  kind: z.enum(['recording', 'generated', 'import', 'content-cache']), processed: z.boolean(), label: short,
})
export const usageSchema = z.strictObject({ id, timestamp: timestampSchema, model: short, purpose: short, tokens: count.nullable(), cost: z.number().min(0).max(1_000_000).nullable() })

export const backupTables = ['settings', 'profiles', 'skills', 'events', 'chunks', 'cards', 'errors', 'materials', 'sessions', 'plans', 'conversations', 'assessments', 'audio', 'usage'] as const
export const backupSchema = z.strictObject({
  format: z.literal('jove-english-os'), version: z.literal(1), schemaVersion: z.literal(2), exportedAt: timestampSchema,
  audioPolicy: z.literal('blobs-omitted'),
  tables: z.strictObject({
    settings: z.array(z.strictObject({ id, value: settingsSchema })).max(100), profiles: z.array(profileSchema).max(100),
    skills: z.array(skillSchema).max(skillNames.length), events: z.array(eventSchema).max(500_000),
    chunks: z.array(chunkSchema).max(100_000), cards: z.array(reviewCardSchema).max(600_000), errors: z.array(errorSchema).max(100_000),
    materials: z.array(materialSchema).max(100_000), sessions: z.array(sessionSchema).max(100_000), plans: z.array(planSchema).max(100_000),
    conversations: z.array(conversationSchema).max(100_000), assessments: z.array(assessmentSchema).max(100_000),
    audio: z.array(audioMetadataSchema).max(100_000), usage: z.array(usageSchema).max(500_000),
  }),
})
export type Backup = z.infer<typeof backupSchema>

/** Validate relationships against the incoming snapshot, never against records about to be replaced. */
export function validateRelationships(t: Backup['tables']): void {
  const keys = Object.fromEntries(backupTables.map(name => [name, new Set(t[name].map(row => row.id))])) as Record<typeof backupTables[number], Set<string>>
  for (const name of backupTables) if (keys[name].size !== t[name].length) throw new Error(`Duplicate IDs in ${name}`)
  const requireId = (table: keyof typeof keys, value?: string) => {
    if (value !== undefined && !keys[table].has(value)) throw new Error(`Missing ${table} reference`)
  }
  const validateDraft = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const child of value) validateDraft(child); return }
    const draft = value as Record<string, unknown>
    for (const [field, table] of [['materialId', 'materials'], ['conversationId', 'conversations'], ['chunkId', 'chunks'], ['errorId', 'errors'], ['cardId', 'cards'], ['audioId', 'audio'], ['assessmentId', 'assessments']] as const) {
      const reference = draft[field]
      // UI drafts may store an empty selection before the learner has recorded/chosen anything.
      if (reference !== undefined && reference !== '') {
        if (typeof reference !== 'string') throw new Error(`Invalid draft ${field}`)
        requireId(table, reference)
      }
    }
    if (draft.audioIds !== undefined) {
      if (!Array.isArray(draft.audioIds) || draft.audioIds.some(id => typeof id !== 'string')) throw new Error('Invalid draft audio references')
      for (const id of draft.audioIds as string[]) requireId('audio', id)
    }
    for (const child of Object.values(draft)) validateDraft(child)
  }
  const pairs = new Set<string>()
  const cardsById = new Map(t.cards.map(card => [card.id, card]))
  const errorsById = new Map(t.errors.map(error => [error.id, error]))
  for (const card of t.cards) {
    requireId('chunks', card.chunkId); requireId('errors', card.errorId)
    const pair = JSON.stringify([card.chunkId, card.modality])
    if (pairs.has(pair)) throw new Error('Duplicate chunk/modality card')
    pairs.add(pair)
    if (card.errorId && errorsById.get(card.errorId)?.chunkId !== card.chunkId) throw new Error('Card/error chunk mismatch')
  }
  for (const chunk of t.chunks) for (const sourceId of chunk.sourceIds) requireId('materials', sourceId)
  for (const error of t.errors) requireId('chunks', error.chunkId)
  for (const material of t.materials) requireId('audio', material.audioId)
  for (const session of t.sessions) { requireId('materials', session.materialId); validateDraft(session.draft) }
  for (const plan of t.plans) for (const task of plan.tasks) requireId('materials', task.materialId)
  for (const conversation of t.conversations) for (const message of conversation.messages) requireId('audio', message.audioId)
  for (const event of t.events) {
    requireId('chunks', event.chunkId)
    if (event.sessionId && !keys.sessions.has(event.sessionId) && !keys.conversations.has(event.sessionId) && !keys.assessments.has(event.sessionId)) throw new Error('Missing session reference')
    for (const [field, table] of [['materialId', 'materials'], ['errorId', 'errors'], ['cardId', 'cards'], ['audioId', 'audio']] as const) {
      const value = event.data?.[field]
      if (value !== undefined) {
        if (typeof value !== 'string') throw new Error(`Invalid ${field} reference`)
        // Historical evidence remains valid after explicit audio cleanup.
        if (field !== 'audioId' || event.data?.audioAvailable !== false) requireId(table, value)
      }
    }
    if (typeof event.data?.cardId === 'string') {
      const card = cardsById.get(event.data.cardId)!
      if (card.chunkId !== event.chunkId || card.modality !== event.modality) throw new Error('Event/card modality mismatch')
    }
  }
}

export function parseBackup(value: unknown): Backup {
  // Check depth/size before recursive schemas to avoid stack exhaustion on hostile draft JSON.
  const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let nodes = 0
  while (queue.length) {
    const current = queue.pop()!
    if (++nodes > 5_000_000 || current.depth > 40) throw new Error('Backup exceeds structural limits')
    if (current.value && typeof current.value === 'object' && !(current.value instanceof Date)) {
      for (const [key, child] of Object.entries(current.value)) {
        if (secretKey.test(key)) throw new Error('Backup contains a forbidden field')
        queue.push({ value: child, depth: current.depth + 1 })
      }
    }
  }
  const result = backupSchema.safeParse(value)
  if (!result.success) throw new Error(`Invalid backup schema at ${result.error.issues[0]?.path.join('.') || 'root'}`)
  validateRelationships(result.data.tables)
  return result.data
}
