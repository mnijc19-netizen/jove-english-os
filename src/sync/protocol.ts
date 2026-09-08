import { z } from 'zod'
import { createEmptyCard, fsrs, type Grade } from 'ts-fsrs'
import { aggregateSkills, taskActivity } from '../domain/engine'
import { projectChunks, projectErrors } from '../db/projections'
import { assessmentSchema, audioMetadataSchema, chunkSchema, conversationSchema, errorSchema, eventSchema, materialSchema, planSchema, profileSchema, reviewCardSchema, sessionSchema, settingsSchema, usageSchema } from '../db/schema'
import type { Chunk, DailyPlan, ErrorPattern, PlanTask, ReviewCard } from '../domain/types'
import { canonicalReviewCard, hasReviewAttemptIdentity, restoreReviewAttempt } from './review'

export const entitySchemas = {
  settings: z.strictObject({ id: z.literal('main'), value: settingsSchema }), profiles: profileSchema,
  events: eventSchema, chunks: chunkSchema, cards: reviewCardSchema, errors: errorSchema,
  materials: materialSchema, sessions: sessionSchema, plans: planSchema, conversations: conversationSchema,
  assessments: assessmentSchema, usage: usageSchema, audioMetadata: audioMetadataSchema,
} as const
export type EntityType = keyof typeof entitySchemas
export const entityTypes = Object.keys(entitySchemas) as EntityType[]
export type RecordValue = Record<string, unknown> & { id: string }
export const isPrivateAudio = (kind: unknown): boolean => kind === 'recording' || kind === 'import'

/** Cache handles are device-local, not private recording references. Playback
 * provenance remains intact and is validated by the shared material schema. */
export function withoutCacheAudioReferences(record: RecordValue, cacheIds: Set<string>): RecordValue {
  const result = structuredClone(record)
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      const object = value as Record<string, unknown>
      if (/audio(?:id)?$/i.test(key) && typeof child === 'string' && cacheIds.has(child)) delete object[key]
      else if (key === 'audioIds' && Array.isArray(child)) object[key] = child.filter(id => !cacheIds.has(id))
      else if (key === 'repairAudio' && child && typeof child === 'object') object[key] = Object.fromEntries(Object.entries(child).filter(([, id]) => typeof id !== 'string' || !cacheIds.has(id)))
      else visit(child)
    }
  }
  visit(result)
  if (result.authenticPlayback) delete result.audioId
  return result
}
export interface SyncOperation {
  id: string; deviceId: string; logicalClock: number; entityType: EntityType; entityId: string;
  kind: 'put' | 'delete'; schemaVersion: 1;
  payload: { record?: RecordValue; changed?: string[]; baseEventIds?: string[]; baseEventKeys?: string[] };
}
export interface StoredOperation extends SyncOperation { cursor?: number; receivedAt?: number }
const operationSchema = z.strictObject({
  id: z.uuid(), deviceId: z.uuid(), logicalClock: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  entityType: z.enum(entityTypes as [EntityType, ...EntityType[]]), entityId: z.string().min(1).max(1000),
  kind: z.enum(['put', 'delete']), schemaVersion: z.literal(1),
  payload: z.strictObject({ record: z.record(z.string(), z.unknown()).optional(), changed: z.array(z.string().max(4000)).max(10000).optional(), baseEventIds: z.array(z.string().max(1000)).max(100000).optional(), baseEventKeys: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100000).optional() }),
})
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
export function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}
function leaves(value: unknown, path: string[] = [], output = new Map<string, unknown>()): Map<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) throw new Error('Unsafe record field')
      if (child !== undefined) leaves(child, [...path, key], output)
    }
  } else output.set(JSON.stringify(path), value)
  return output
}
export function changedFields(previous: RecordValue | undefined, next: RecordValue): string[] {
  const before = previous ? leaves(previous) : new Map<string, unknown>(), after = leaves(next)
  return [...new Set([...before.keys(), ...after.keys()])].filter(key => {
    // An empty-object leaf becoming a branch is a shape transition, not deletion.
    if (!after.has(key) && hasPath(next, JSON.parse(key))) return false
    return canonical(before.get(key)) !== canonical(after.get(key)) || before.has(key) !== after.has(key)
  }).sort()
}
function hasPath(value: unknown, path: string[]): boolean {
  for (const part of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return false
    value = (value as Record<string, unknown>)[part]
  }
  return true
}
export function parseOperation(input: unknown): SyncOperation {
  const op = operationSchema.parse(input)
  if (new TextEncoder().encode(JSON.stringify(op)).length > 1_048_576) throw new Error('Sync record too large')
  if (op.kind === 'delete') {
    if (op.entityType === 'events' || Object.keys(op.payload).length) throw new Error('Invalid evidence deletion')
    return op as SyncOperation
  }
  const record = entitySchemas[op.entityType].parse(op.payload.record) as RecordValue
  if (record.id !== op.entityId || !op.payload.changed?.length) throw new Error('Invalid sync identity or patch')
  for (const path of op.payload.changed) {
    const parts: unknown = JSON.parse(path)
    if (!Array.isArray(parts) || !parts.length || parts.length > 15 || parts.some(key => typeof key !== 'string' || forbidden.has(key))) throw new Error('Unsafe sync patch')
    if (parts[0] === 'id' && parts.length !== 1) throw new Error('Invalid identity path')
  }
  if ((op.payload.baseEventIds || op.payload.baseEventKeys) && op.entityType !== 'cards') throw new Error('Unexpected review baseline')
  return { ...op, payload: { ...op.payload, record } } as SyncOperation
}
export function compare(a: SyncOperation, b: SyncOperation): number {
  return a.logicalClock - b.logicalClock || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
function assign(target: Record<string, unknown>, path: string[], value: unknown, exists: boolean) {
  let current = target
  for (const part of path.slice(0, -1)) {
    if (!exists && (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part]))) return
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {}
    current = current[part] as Record<string, unknown>
  }
  if (exists) current[path.at(-1)!] = structuredClone(value)
  else delete current[path.at(-1)!]
}
function mergeMessages(previous: unknown, next: unknown): unknown {
  const messages = new Map<string, RecordValue>()
  for (const row of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(next) ? next : [])] as RecordValue[]) messages.set(row.id, row)
  return [...messages.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || a.id.localeCompare(b.id, 'en'))
}
export interface Projection {
  records: Record<EntityType, RecordValue[]>;
  skills: ReturnType<typeof aggregateSkills>;
  conflicts: { entityType: EntityType; entityId: string; operationIds: string[] }[];
  eventKeys: Record<string, string>;
  eventAliases: Record<string, string[]>;
  cardAliases: Record<string, string>;
  tombstones: { entityType: EntityType; entityId: string; retained: boolean }[];
  deferred: { entityType: EntityType; entityId: string; reason: string }[];
}

/** Stable identity of an occurrence, independent of upload order/receipt and aliases. */
export async function eventOccurrenceKey(record: RecordValue): Promise<string> {
  const value = structuredClone(record)
  if (value.data && typeof value.data === 'object') {
    delete (value.data as Record<string, unknown>).audioAvailable
    if (!Object.keys(value.data).length) delete value.data
  }
  const bytes = new TextEncoder().encode(canonical(value))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function validateReceipt(op: StoredOperation): void {
  if (op.cursor === undefined && op.receivedAt === undefined) return
  if (!Number.isSafeInteger(op.cursor) || op.cursor! < 1 || op.logicalClock > op.cursor!
    || !Number.isSafeInteger(op.receivedAt) || op.receivedAt! < 0 || op.receivedAt! > 253_402_300_799_999) throw new Error('Invalid sync receipt or logical clock')
}

function completePut(op: SyncOperation): boolean {
  return op.kind === 'put' && changedFields(undefined, op.payload.record!).every(path => op.payload.changed!.includes(path))
}

/** Recommendations may be replaced; an assignment with work attached may not.
 * Read the complete operation set, not the previous page's materialized array. */
function mergePlanAssignments(plan: DailyPlan, history: StoredOperation[], evidence: Map<string, StoredOperation[]>): DailyPlan {
  const versions = new Map<string, { task: PlanTask; op: StoredOperation }[]>()
  for (const op of history) if (op.kind === 'put' && op.payload.record!.date === plan.date) {
    for (const task of (op.payload.record as unknown as DailyPlan).tasks) {
      versions.set(task.id, [...(versions.get(task.id) ?? []), { task, op }])
    }
  }
  const retained = new Map<string, PlanTask>()
  const commitment = new Map<string, StoredOperation>()
  for (const [id, copies] of versions) {
    const related = evidence.get(id) ?? []
    const facts = related.filter(op => op.entityType === 'events')
    const matches = (task: PlanTask, op: StoredOperation) => {
      const data = op.payload.record!.data as Record<string, unknown>
      return (data.materialId === undefined || data.materialId === task.materialId)
        && (data.kind === undefined || data.kind === task.kind || data.kind === taskActivity(task))
    }
    const completed = facts.find(op => op.payload.record!.type === 'TASK_COMPLETED' && op.payload.record!.source === 'objective' && copies.some(copy => matches(copy.task, op)))
    const began = facts.find(op => ['TASK_STARTED', 'READING_STARTED', 'READING_RESPONSE', 'REVIEW_RESPONSE', 'ASSESSMENT_RESPONSE', 'LISTENING_RESPONSE', 'SPEAKING_RESPONSE', 'WRITTEN_RESPONSE', 'CHUNK_RECALL'].includes(String(op.payload.record!.type)) && copies.some(copy => matches(copy.task, op)))
    const legacy = copies.filter(({ task }) => task.kind === 'learn' && task.id === `${plan.date}:learn:${task.materialId}`)
      .flatMap(({ task }) => evidence.get(`legacy-learn:${task.materialId}`) ?? [])
    const session = [...related, ...legacy].find(op => op.entityType === 'sessions' && copies.some(({ task }) => {
      const row = op.payload.record!, draft = row.draft as Record<string, unknown>
      return row.materialId === task.materialId && (draft.taskId === id || row.kind === 'reading' && row.id === `reading:${id}`
        || row.kind === 'learn' && (row.id === `learn-draft-${id}`
          || id === `${plan.date}:learn:${task.materialId}` && row.id === `learn-draft-${task.materialId}`))
    }))
    const committed = copies.find(copy => copy.task.done)
    const proof = completed ?? began ?? session
    if (!committed && !proof) continue
    const eligible = proof && proof.entityType === 'events' ? copies.filter(copy => matches(copy.task, proof)) : copies
    const own = proof ? eligible.filter(copy => copy.op.deviceId === proof.deviceId) : []
    // A journal capture can serialize its event before its plan. Use that device's
    // adjacent snapshot, not a different device's later unstarted recommendation.
    const selected = committed ?? (proof && (own.filter(copy => compare(copy.op, proof) <= 0).at(-1) ?? own[0])) ?? eligible[0]!
    const task = { ...selected.task, done: !!committed || !!completed }
    const minutes = (completed?.payload.record?.data as Record<string, unknown> | undefined)?.minutes
    if (task.done && Number.isInteger(minutes) && Number(minutes) >= 1 && Number(minutes) <= 1440) task.minutes = Number(minutes)
    if (copies.some(copy => copy.task.optional)) task.optional = true
    retained.set(id, task)
    commitment.set(id, committed?.op ?? completed ?? proof ?? selected.op)
  }
  const tasks = plan.tasks.flatMap(task => retained.has(task.id) ? [{ ...retained.get(task.id)! }]
    : [...retained.values()].some(old => taskActivity(old) === taskActivity(task)) ? [] : [{ ...task }])
  for (const task of retained.values()) if (!tasks.some(old => old.id === task.id)) tasks.push({ ...task })
  const position = (task: PlanTask) => {
    const exact = plan.tasks.findIndex(old => old.id === task.id)
    const activity = plan.tasks.findIndex(old => taskActivity(old) === taskActivity(task))
    return exact >= 0 ? exact : activity >= 0 ? activity : plan.tasks.length
  }
  tasks.sort((a, b) => position(a) - position(b) || a.id.localeCompare(b.id, 'en'))
  // Completed/started durations belong to their actual assignment. Work which
  // cannot fit is explicitly optional, never a fabricated one-minute obligation.
  // A lower future target cannot erase time already completed as required.
  // Only unfinished overflow becomes optional; required history is a floor.
  const budget = Math.max(plan.minutes, tasks.filter(task => task.done && !task.optional).reduce((sum, task) => sum + task.minutes, 0))
  let available = budget
  const committedTasks = tasks.filter(task => retained.has(task.id)).sort((a, b) => Number(b.done) - Number(a.done)
    || compare(commitment.get(a.id)!, commitment.get(b.id)!) || a.id.localeCompare(b.id, 'en'))
  for (const task of committedTasks) {
    if (task.optional || task.minutes > available) task.optional = true
    else available -= task.minutes
  }
  let excess = tasks.reduce((sum, task) => sum + (task.optional ? 0 : task.minutes), 0) - budget
  const trimmable = tasks.filter(task => !task.done && !task.optional && !retained.has(task.id)).sort((a, b) => position(b) - position(a))
  for (const task of trimmable) {
    if (excess <= 0) break
    const reduction = Math.min(excess, task.minutes)
    task.minutes -= reduction; excess -= reduction
  }
  const result = tasks.filter(task => task.minutes > 0)
  return { ...plan, tasks: result, minutes: result.reduce((sum, task) => sum + (task.optional ? 0 : task.minutes), 0) }
}

const readingKind = (kind: unknown) => kind === 'reading' || kind === 'reading-recovery'
function readingSnapshot(row: RecordValue): RecordValue {
  const copy = structuredClone(row)
  delete (copy.draft as Record<string, unknown>).syncReadingConflicts
  return copy
}
function readingSubmission(row: RecordValue): string {
  const draft = row.draft as Record<string, unknown>
  return canonical([row.materialId, row.startedAt, draft.passage ?? '', draft.submittedResponse ?? '',
    draft.retell ?? '', draft.audioId ?? '', draft.audioSeconds ?? 0, draft.observationAt ?? 0, draft.activeMs ?? 0,
    draft.readSections ?? [], draft.sectionMs ?? [], draft.priorExposure !== false])
}
function readingWork(row: RecordValue): string {
  const draft = row.draft as Record<string, unknown>
  return canonical([readingSubmission(row), draft.response ?? '', draft.checkedSections ?? [], draft.unknownTokens ?? [], draft.lookupTokens ?? []])
}
/** Positive preservation proof, not an inference from Lamport order alone.
 * Adding a retell to a synced response subsumes that earlier partial draft;
 * replacing a different nonempty response does not. */
function includesReadingWork(earlier: RecordValue, later: RecordValue): boolean {
  if (earlier.materialId !== later.materialId || earlier.startedAt !== later.startedAt) return false
  if (earlier.stage === 'saved') return later.stage === 'saved' && readingSubmission(earlier) === readingSubmission(later)
  const a = earlier.draft as Record<string, unknown>, b = later.draft as Record<string, unknown>
  for (const key of ['passage', 'response', 'submittedResponse', 'retell', 'audioId'] as const)
    if (a[key] && a[key] !== b[key]) return false
  if (a.observationAt && a.observationAt !== b.observationAt || a.audioId && a.audioSeconds !== b.audioSeconds) return false
  if (Number(a.activeMs ?? 0) > Number(b.activeMs ?? 0)) return false
  for (const key of ['readSections', 'checkedSections', 'unknownTokens', 'lookupTokens'] as const) {
    const before = Array.isArray(a[key]) ? a[key] : [], after = Array.isArray(b[key]) ? b[key] : []
    if (before.some(value => !after.includes(value))) return false
  }
  const before = Array.isArray(a.sectionMs) ? a.sectionMs : [], after = Array.isArray(b.sectionMs) ? b.sectionMs : []
  return before.every((value, i) => Number(value) <= Number(after[i] ?? 0))
}

/** A committed reading is one attempt, not an independently mergeable saved
 * marker and response/audio leaves. Conflict frontiers are bounded per device;
 * continuing one creates a separate, explicitly chosen recovery session. */
async function mergeReadingSession(history: StoredOperation[], all: StoredOperation[]) {
  const puts = history.filter(op => op.kind === 'put' && readingKind(op.payload.record?.kind))
  const attested = (op: StoredOperation) => {
    const row = op.payload.record!, draft = row.draft as Record<string, unknown>
    if (typeof draft.observationAt !== 'number' || !Number.isFinite(draft.observationAt) || draft.observationAt <= 0) return false
    const evidence = all.filter(e => e.entityType === 'events' && e.payload.record?.sessionId === row.id
      && e.payload.record.timestamp === draft.observationAt
      && (e.payload.record.data as Record<string, unknown> | undefined)?.materialId === row.materialId)
    return evidence.some(e => e.payload.record!.type === 'READING_RESPONSE' && (e.payload.record!.data as Record<string, unknown>).response === draft.submittedResponse)
      && evidence.some(e => e.payload.record!.type === 'READING_RETELL'
        && ((e.payload.record!.data as Record<string, unknown>).response ?? '') === String(draft.retell ?? '').trim()
        && ((e.payload.record!.data as Record<string, unknown>).audioId ?? '') === (draft.audioId ?? ''))
  }
  const saved = puts.filter(op => op.payload.record!.stage === 'saved')
  const firstSaved = saved.find(attested) ?? saved[0]
  const selected = firstSaved ? puts.filter(op => op.payload.record!.stage === 'saved'
    && readingSubmission(op.payload.record!) === readingSubmission(firstSaved.payload.record!)).at(-1)! : puts.at(-1)!
  const primary = readingSnapshot(selected.payload.record!)
  const copies: RecordValue[] = [], ids: string[] = [], conflicted: string[] = [], inactive: string[] = []
  for (const device of new Set(puts.map(op => op.deviceId))) {
    const key = await eventOccurrenceKey({ id: primary.id, device, purpose: 'reading-conflict-v1' })
    const id = `reading-conflict:${key}`
    // Reading the projected winner on B and normalizing it on mount is not a
    // new B submission, nor permission to erase B's preceding unsent frontier.
    const latest = puts.filter(op => op.deviceId === device && readingWork(op.payload.record!) !== readingWork(primary)
      && (device !== (firstSaved ?? selected).deviceId || compare(op, firstSaved ?? selected) > 0)).at(-1)
    if (!latest || puts.some(op => compare(op, latest) > 0 && includesReadingWork(latest.payload.record!, op.payload.record!))) { inactive.push(id); continue }
    const row = readingSnapshot(latest.payload.record!)
    const draft = row.draft as Record<string, unknown>
    const changedWork = !!draft.response || !!draft.retell || !!draft.audioId || Number(draft.activeMs) > 0
    if (!changedWork) { inactive.push(id); continue }
    const sourceVersion = await eventOccurrenceKey(row)
    const root = (primary.draft as Record<string, unknown>).syncRecovery as Record<string, unknown> | undefined
    const copy = { ...row, id, kind: 'reading-conflict', draft: { ...draft,
      syncRecovery: { sourceSessionId: primary.id, rootSessionId: root?.rootSessionId ?? primary.id, sourceDeviceId: device, sourceVersion } } }
    // Explicit operations for a copy (including a tombstone) always outrank a
    // generated seed. User continuations normally use another stable session ID.
    if (!all.some(op => op.entityType === 'sessions' && op.entityId === id)) copies.push(copy)
    ids.push(id); conflicted.push(latest.id)
  }
  if (ids.length) (primary.draft as Record<string, unknown>).syncReadingConflicts = ids.sort()
  return { primary, copies, conflicted, inactive: inactive.filter(id => !all.some(op => op.entityType === 'sessions' && op.entityId === id)) }
}

type Reference = { types: EntityType[]; id: string }
function references(type: EntityType, row: RecordValue): Reference[] {
  const result: Reference[] = []
  const add = (types: EntityType[], id: unknown) => { if (typeof id === 'string' && id) result.push({ types, id }) }
  const draft = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(draft); return }
    for (const [key, child] of Object.entries(value)) {
      const table = ({ materialId: 'materials', conversationId: 'conversations', chunkId: 'chunks', errorId: 'errors', cardId: 'cards', audioId: 'audioMetadata', assessmentId: 'assessments' } as Record<string, EntityType>)[key]
      if (table) add([table], child)
      if (key === 'audioIds' && Array.isArray(child)) child.forEach(id => add(['audioMetadata'], id))
      draft(child)
    }
  }
  if (['cards', 'errors', 'events'].includes(type)) add(['chunks'], row.chunkId)
  if (type === 'cards') add(['errors'], row.errorId)
  if (type === 'chunks' && Array.isArray(row.sourceIds)) row.sourceIds.forEach(id => add(['materials'], id))
  if (type === 'materials') add(['audioMetadata'], row.audioId)
  if (type === 'sessions') { add(['materials'], row.materialId); draft(row.draft) }
  if (type === 'plans') draft(row.tasks)
  if (type === 'conversations') draft(row.messages)
  if (type === 'events') {
    add(['sessions', 'conversations', 'assessments'], row.sessionId)
    const data = row.data as Record<string, unknown> | undefined
    for (const [field, target] of [['materialId', 'materials'], ['errorId', 'errors'], ['cardId', 'cards'], ['audioId', 'audioMetadata']] as const) {
      if (field !== 'audioId' || data?.audioAvailable !== false) add([target], data?.[field])
    }
  }
  return result
}

/** All replicas fold the same immutable operation set; wall clocks never arbitrate edits. */
export async function projectOperations(input: StoredOperation[]): Promise<Projection> {
  const operations = new Map<string, StoredOperation>()
  for (const raw of input) {
    const op = parseOperation(stripReceipt(raw))
    validateReceipt(raw)
    const existing = operations.get(op.id)
    if (existing && canonical(stripReceipt(existing)) !== canonical(op)) throw new Error('Operation identity collision')
    if (existing?.cursor !== undefined && raw.cursor !== undefined && (existing.cursor !== raw.cursor || existing.receivedAt !== raw.receivedAt)) throw new Error('Receipt identity collision')
    operations.set(op.id, existing?.cursor !== undefined ? existing : { ...op, cursor: raw.cursor, receivedAt: raw.receivedAt })
  }
  const privateIds = new Set([...operations.values()].filter(op => op.entityType === 'audioMetadata' && op.kind === 'put' && isPrivateAudio(op.payload.record?.kind)).map(op => op.entityId))
  const sortedOperations = [...operations.values()].sort(compare)
  const planEvidence = new Map<string, StoredOperation[]>()
  for (const op of sortedOperations) if (op.kind === 'put' && ['events', 'sessions'].includes(op.entityType)) {
    const row = op.payload.record!, data = (op.entityType === 'events' ? row.data : row.draft) as Record<string, unknown> | undefined
    const keys = new Set<string>()
    if (typeof data?.taskId === 'string') keys.add(data.taskId)
    if (op.entityType === 'sessions' && row.kind === 'reading' && row.id.startsWith('reading:')) keys.add(row.id.slice(8))
    if (op.entityType === 'sessions' && row.kind === 'learn' && row.id.startsWith('learn-draft-')) {
      keys.add(row.id.slice(12)); if (row.id === `learn-draft-${row.materialId}`) keys.add(`legacy-learn:${row.materialId}`)
    }
    for (const key of keys) planEvidence.set(key, [...(planEvidence.get(key) ?? []), op])
  }
  const cacheIds = new Set([...operations.values()].filter(op => op.entityType === 'audioMetadata' && op.kind === 'put' && !isPrivateAudio(op.payload.record?.kind) && !privateIds.has(op.entityId)).map(op => op.entityId))
  const grouped = new Map<string, StoredOperation[]>()
  // V1 allowed arbitrary card IDs. Two restored devices must not violate Dexie's
  // unique chunk/modality index or strand events pointing at the other old ID.
  const pairs = new Map<string, { chunkId: string; modality: string; ids: Set<string> }>()
  const identityPairs = new Map<string, string>()
  for (const op of operations.values()) if (op.entityType === 'cards' && op.kind === 'put') {
    const card = reviewCardSchema.parse(op.payload.record), key = canonical([card.chunkId, card.modality])
    if (identityPairs.has(card.id) && identityPairs.get(card.id) !== key) throw new Error('Card identity cannot change chunk or modality')
    identityPairs.set(card.id, key)
    const pair = pairs.get(key) ?? { chunkId: card.chunkId, modality: card.modality, ids: new Set<string>() }
    pair.ids.add(card.id); pairs.set(key, pair)
  }
  const cardAliases: Record<string, string> = {}
  for (const pair of pairs.values()) {
    const natural = `${pair.chunkId}:${pair.modality}`
    const id = natural.length <= 1000 ? natural : `card:${await eventOccurrenceKey({ id: pair.chunkId, modality: pair.modality })}`
    for (const source of pair.ids) cardAliases[source] = id
  }
  for (const raw of sortedOperations) {
    if (raw.entityType === 'audioMetadata' && (cacheIds.has(raw.entityId) || raw.kind === 'put' && !isPrivateAudio(raw.payload.record?.kind))) continue
    const alias = raw.entityType === 'cards' ? cardAliases[raw.entityId] : undefined
    const op = alias ? { ...raw, entityId: alias, payload: raw.payload.record ? { ...raw.payload, record: { ...raw.payload.record, id: alias } } : raw.payload } : raw
    const key = JSON.stringify([op.entityType, op.entityId])
    const group = grouped.get(key) ?? []
    group.push(op); grouped.set(key, group)
  }
  const remapReferences = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(remapReferences); return }
    const object = value as Record<string, unknown>
    if (typeof object.cardId === 'string' && cardAliases[object.cardId]) object.cardId = cardAliases[object.cardId]
    Object.values(object).forEach(remapReferences)
  }
  const records = Object.fromEntries(entityTypes.map(type => [type, []])) as unknown as Projection['records']
  const conflicts: Projection['conflicts'] = []
  const cardBases = new Map<string, StoredOperation[]>()
  const eventKeys: Record<string, string> = {}, eventAliases: Record<string, string[]> = {}, deferred: Projection['deferred'] = [], tombstones: Projection['tombstones'] = []
  const deletedRecords = new Map<string, RecordValue>()
  const readingCopies: RecordValue[] = []
  const eventOps = [...operations.values()].filter(op => op.entityType === 'events')
  const occurrenceByOp = new Map(await Promise.all(eventOps.map(async op => [op.id, await eventOccurrenceKey(op.payload.record!)] as const)))
  const eventByKey = new Map<string, RecordValue>()
  for (const ops of grouped.values()) {
    const first = ops[0]!, type = first.entityType
    if (type === 'events') {
      const variants = new Map<string, StoredOperation[]>()
      for (const op of ops) {
        const key = occurrenceByOp.get(op.id)!
        variants.set(key, [...(variants.get(key) ?? []), op])
      }
      for (const [key, copies] of [...variants.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
        const op = copies[0]!
        const event = structuredClone(op.payload.record!)
        if (variants.size > 1) event.id = `${first.entityId.slice(0, 900)}~${key}`
        eventKeys[event.id] = key
        ;(eventAliases[first.entityId] ??= []).push(event.id)
        const receipt = copies.filter(copy => copy.receivedAt !== undefined).reduce<number | undefined>((time, copy) => Math.min(time ?? Infinity, copy.receivedAt!), undefined)
        // Preserve original time as evidence, but a future device clock cannot poison the planner.
        if (receipt !== undefined && Number(event.timestamp) > receipt) {
          event.data = { ...(event.data as object), clientTimestamp: event.timestamp }
          event.timestamp = receipt
        }
        remapReferences(event)
        records.events.push(event)
        eventByKey.set(key, event)
      }
      if (variants.size > 1) conflicts.push({ entityType: type, entityId: first.entityId, operationIds: ops.map(op => op.id) })
      continue
    }
    let current: Record<string, unknown> = {}, deleted = false
    for (const op of ops) {
      if (op.kind === 'delete') { deleted = true; continue }
      if (deleted && !completePut(op)) {
        conflicts.push({ entityType: type, entityId: op.entityId, operationIds: [op.id] })
        continue
      }
      if (deleted && type === 'cards') cardBases.delete(op.entityId)
      if (deleted || !Object.keys(current).length) { current = structuredClone(op.payload.record!); deleted = false }
      const flat = leaves(op.payload.record)
      if (type === 'cards' && (op.payload.baseEventKeys || op.payload.baseEventIds || !cardBases.has(op.entityId))) cardBases.set(op.entityId, [...(cardBases.get(op.entityId) ?? []), op])
      // Old logs may contain parent marker deletions: remove actual absent paths first.
      const paths = [...op.payload.changed!].sort((a, b) => Number(flat.has(a)) - Number(flat.has(b)) || JSON.parse(a).length - JSON.parse(b).length || a.localeCompare(b, 'en'))
      for (const key of paths) {
        const path = JSON.parse(key) as string[]
        if (!flat.has(key) && hasPath(op.payload.record, path)) continue
        // FSRS is replayed below; merging individual fields can create impossible states.
        if (type === 'cards' && path[0] === 'card') { current.card = structuredClone(op.payload.record!.card); continue }
        // Hash/range/segment provenance is one playback identity, not independently
        // mergeable fields from different clips. Shared schema owns its validation.
        if (type === 'materials' && path[0] === 'authenticPlayback') {
          if (op.payload.record!.authenticPlayback === undefined) delete current.authenticPlayback
          else current.authenticPlayback = structuredClone(op.payload.record!.authenticPlayback)
          continue
        }
        let value = flat.get(key)
        if (type === 'conversations' && key === '["messages"]') value = mergeMessages(current.messages, value)
        assign(current, path, value, flat.has(key))
      }
      if (type === 'plans' && Array.isArray(current.tasks)) current.minutes = current.tasks.reduce((sum, task) => sum + (task.optional ? 0 : Number(task.minutes)), 0)
    }
    if (type === 'plans' && Object.keys(current).length) current = mergePlanAssignments(planSchema.parse(current), ops, planEvidence) as unknown as RecordValue
    if (type === 'sessions' && !deleted && readingKind(current.kind)) {
      const merged = await mergeReadingSession(ops, [...operations.values()])
      current = merged.primary
      readingCopies.push(...merged.copies)
      tombstones.push(...merged.inactive.map(entityId => ({ entityType: 'sessions' as const, entityId, retained: false })))
      if (merged.conflicted.length) conflicts.push({ entityType: type, entityId: first.entityId, operationIds: merged.conflicted })
    }
    if (!deleted) records[type].push(entitySchemas[type].parse(current) as RecordValue)
    else {
      tombstones.push({ entityType: type, entityId: first.entityId, retained: false })
      if (Object.keys(current).length) deletedRecords.set(JSON.stringify([type, first.entityId]), entitySchemas[type].parse(current) as RecordValue)
    }
  }
  records.sessions.push(...readingCopies.map(row => sessionSchema.parse(row) as unknown as RecordValue))
  for (const type of entityTypes) {
    records[type] = records[type].map(row => withoutCacheAudioReferences(row, cacheIds))
    for (const row of records[type]) {
      if (type === 'sessions' && row.kind === 'review-block') {
        const draft = row.draft as Record<string, unknown>
        if (Array.isArray(draft.items)) draft.items = draft.items.map(value => {
          const item = restoreReviewAttempt(value)
          if (!item) return value
          const ambiguous = !hasReviewAttemptIdentity(value) && canonicalReviewCard(item.cardId, cardAliases) === item.cardId
            && Object.keys(cardAliases).some(id => id !== item.cardId && canonicalReviewCard(id, cardAliases) === item.cardId)
          // A canonicalized raw source is not proof of which old attempt won.
          // Keep it unresolved rather than manufacturing a durable identity.
          return ambiguous ? value : item
        })
      }
      remapReferences(row)
    }
  }
  for (const row of deletedRecords.values()) remapReferences(row)
  // Restore deleted dependencies (history remains referentially intact). Incomplete pages
  // stage dependents in the operation log until their prerequisites arrive.
  const indexed = new Map(entityTypes.flatMap(type => records[type].map(row => [JSON.stringify([type, row.id]), row] as const)))
  let expanded = true
  while (expanded) {
    expanded = false
    for (const type of entityTypes) for (const row of records[type]) for (const reference of references(type, row)) {
      if (reference.types.some(target => indexed.has(JSON.stringify([target, reference.id])))) continue
      for (const target of reference.types) {
        const key = JSON.stringify([target, reference.id]), old = deletedRecords.get(key)
        if (!old) continue
        records[target].push(old); indexed.set(key, old)
        tombstones.find(t => t.entityType === target && t.entityId === reference.id)!.retained = true
        expanded = true; break
      }
    }
  }
  let removed = true
  while (removed) {
    removed = false
    for (const type of entityTypes) records[type] = records[type].filter(row => {
      const missing = references(type, row).some(ref => !ref.types.some(target => indexed.has(JSON.stringify([target, ref.id]))))
      const linked = type === 'events' ? indexed.get(JSON.stringify(['cards', (row.data as Record<string, unknown> | undefined)?.cardId])) : undefined
      const mismatch = linked && (linked.chunkId !== row.chunkId || linked.modality !== row.modality)
      if (!missing && !mismatch) return true
      deferred.push({ entityType: type, entityId: row.id, reason: mismatch ? 'Event/card identity mismatch' : 'Waiting for referenced records' })
      indexed.delete(JSON.stringify([type, row.id])); removed = true; return false
    })
  }
  const events = records.events.map(event => eventSchema.parse(event))
  const acceptedEventKeys = new Set(events.map(event => eventKeys[event.id]!))
  const scheduler = fsrs({ enable_fuzz: false })
  const projectedCards: ReviewCard[] = records.cards.map(raw => {
    const card = reviewCardSchema.parse(raw)
    const candidates = (cardBases.get(card.id) ?? []).map(op => {
      const seed = reviewCardSchema.parse(op.payload.record), included = new Set(op.payload.baseEventKeys ?? [])
      let missing = false
      if (!op.payload.baseEventKeys) for (const id of op.payload.baseEventIds ?? []) {
        const own = eventOps.filter(e => e.entityId === id && e.deviceId === op.deviceId && compare(e, op) <= 0).sort(compare).at(-1)
        const matches = new Set(eventOps.filter(e => e.entityId === id || `${e.entityId.slice(0, 950)}~${e.id}` === id).map(e => occurrenceByOp.get(e.id)!))
        const key = own ? occurrenceByOp.get(own.id) : matches.size === 1 ? [...matches][0] : undefined
        if (key) included.add(key); else missing = true
      }
      for (const key of included) if (!eventByKey.has(key) || !acceptedEventKeys.has(key)) missing = true
      const known = [...included].filter(key => { const event = eventByKey.get(key); return event?.type === 'review' && (event.data as Record<string, unknown>)?.cardId === card.id && [1, 2, 3, 4].includes(Number((event.data as Record<string, unknown>)?.scheduledRating)) }).length
      return { op, seed, included, missing, opaque: Math.max(0, seed.card.reps - known) }
    }).sort((a, b) => b.opaque - a.opaque || compare(a.op, b.op))
    const baseline = candidates[0]
    const opaqueConflict = baseline && baseline.opaque > 0 && candidates.some(candidate => candidate !== baseline && candidate.opaque > 0
      && canonical(candidate.seed.card) !== canonical(baseline.seed.card)
      && (candidate.included.size === 0 || baseline.included.size === 0
        || (![...candidate.included].every(key => baseline.included.has(key)) && ![...baseline.included].every(key => candidate.included.has(key)))))
    let state = baseline?.seed.card ?? card.card
    const relevant = events.filter(event => event.data?.cardId === card.id && event.type === 'review')
      .sort((a, b) => a.timestamp - b.timestamp || eventKeys[a.id]!.localeCompare(eventKeys[b.id]!, 'en'))
    let included = baseline?.included ?? new Set<string>()
    if (baseline && !baseline.missing && baseline.opaque === 0) {
      state = createEmptyCard(new Date(Math.min(state.due.getTime(), relevant[0]?.timestamp ?? state.due.getTime())))
      included = new Set()
    }
    if (baseline?.op.receivedAt !== undefined && state.last_review && state.last_review.getTime() > baseline.op.receivedAt) {
      const delta = state.last_review.getTime() - baseline.op.receivedAt
      state = { ...state, last_review: new Date(baseline.op.receivedAt), due: new Date(Math.max(baseline.op.receivedAt, state.due.getTime() - delta)) }
    }
    if (baseline?.op.receivedAt !== undefined && state.reps === 0 && state.due.getTime() > baseline.op.receivedAt) state = { ...state, due: new Date(baseline.op.receivedAt) }
    const earlierUnknown = baseline && baseline.opaque > 0 && relevant.some(event => !included.has(eventKeys[event.id]!) && event.timestamp < (state.last_review?.getTime() ?? 0))
    if (baseline?.missing) deferred.push({ entityType: 'cards', entityId: card.id, reason: 'Waiting for baseline occurrences' })
    else if (opaqueConflict) deferred.push({ entityType: 'cards', entityId: card.id, reason: 'Legacy baseline needs recovery: incomparable source snapshots' })
    else if (earlierUnknown) deferred.push({ entityType: 'cards', entityId: card.id, reason: 'Legacy baseline needs recovery: earlier occurrence outside its known history' })
    for (const event of relevant) {
      if (baseline?.missing || earlierUnknown || opaqueConflict || included.has(eventKeys[event.id]!)) continue
      const rating = event.data?.scheduledRating
      if (typeof rating !== 'number' || ![1, 2, 3, 4].includes(rating)) continue
      state = scheduler.next(state, new Date(Math.max(event.timestamp, state.last_review?.getTime() ?? 0)), rating as Grade).card
    }
    const contexts = [...new Set([...card.contextIds, ...events.filter(e => e.data?.cardId === card.id && e.contextId).map(e => e.contextId!)])]
    const repairs = events.filter(e => ['repair-attempt', 'SPEAK_RETRY'].includes(e.type) && e.chunkId === card.chunkId && e.data?.errorId === card.errorId && card.errorId && e.prompted && e.score === 1 && e.data?.fullSentence === true && e.timestamp >= (state.last_review?.getTime() ?? 0))
    const latest = repairs.sort((a, b) => b.timestamp - a.timestamp)[0]
    if (latest && ['cloze', 'speaking', 'transfer'].includes(card.modality)) state = { ...state, due: new Date(latest.timestamp + (card.modality === 'transfer' ? 172800000 : 600000)) }
    return { ...card, card: state, contextIds: contexts }
  })
  records.cards = projectedCards as unknown as RecordValue[]
  records.chunks = projectChunks(records.chunks as unknown as Chunk[], events) as unknown as RecordValue[]
  records.errors = projectErrors(records.errors as unknown as ErrorPattern[], events, projectedCards) as unknown as RecordValue[]
  for (const type of entityTypes) records[type].sort((a, b) => a.id.localeCompare(b.id, 'en'))
  return { records, skills: aggregateSkills(events), conflicts, eventKeys, eventAliases, cardAliases, tombstones, deferred }
}
export function stripReceipt(value: StoredOperation): SyncOperation {
  const op = { ...value }
  delete op.cursor
  delete op.receivedAt
  return op
}
