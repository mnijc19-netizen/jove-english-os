import { createEmptyCard, fsrs, Rating } from 'ts-fsrs'
import { aggregateSkills, evidenceWeight } from '../domain/engine'
import { defaultProfile, defaultSettings, type AudioAsset, type Chunk, type ErrorPattern, type Evaluation, type Material, type MaterialChunk, type ReviewCard, type StudyEvent } from '../domain/types'
import { db, BACKUP_SCHEMA_VERSION } from './db'
import { audioMetadataSchema, backupTables, eventSchema, evaluationErrorSchema, materialChunkSchema, materialSchema, modalities, parseBackup, reviewCardSchema, reviewOptionsSchema, repairAttemptOptionsSchema, type Backup, type ReviewOptions, type RepairAttemptOptions } from './schema'
import { projectChunks, projectErrors } from './projections'
import { resolveCardAlias, resolveEventAliases } from '../sync/journal'

const scheduler = fsrs({ enable_fuzz: false })
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
const uuid = () => crypto.randomUUID()
const projectionTables = [db.events, db.skills, db.chunks, db.errors, db.cards]
const eventTables = [...projectionTables, db.sessions, db.materials, db.audio, db.conversations, db.assessments, db.syncMeta]
export type { ReviewOptions, RepairAttemptOptions } from './schema'
export const REPAIR_RETEST_DELAY = 10 * 60_000
export const REPAIR_TRANSFER_DELAY = 2 * 86_400_000

async function rebuildProjections(): Promise<void> {
  const events = await db.events.toArray()
  const chunks = projectChunks(await db.chunks.toArray(), events)
  const errors = projectErrors(await db.errors.toArray(), events, await db.cards.toArray())
  await db.skills.clear()
  await db.skills.bulkPut(aggregateSkills(events))
  if (chunks.length) await db.chunks.bulkPut(chunks)
  if (errors.length) await db.errors.bulkPut(errors)
}

async function ensureCards(chunk: Chunk, now: number): Promise<void> {
  const existing = await db.cards.where('chunkId').equals(chunk.id).toArray()
  const missing: ReviewCard[] = modalities.filter(modality => !existing.some(c => c.modality === modality)).map(modality => ({
    id: `${chunk.id}:${modality}`, chunkId: chunk.id, modality, card: createEmptyCard(new Date(now)), contextIds: [],
  }))
  if (missing.length) await db.cards.bulkAdd(missing)
}

export async function initialize(materials: Material[]): Promise<void> {
  const validated = materials.map(material => materialSchema.parse(material))
  if (new Set(validated.map(m => m.id)).size !== validated.length) throw new Error('Duplicate seed material IDs')
  await db.transaction('rw', [db.settings, db.profiles, db.materials, db.audio, ...projectionTables], async () => {
    if (!await db.settings.get('main')) await db.settings.add({ id: 'main', value: { ...defaultSettings } })
    if (!await db.profiles.get('main')) await db.profiles.add(defaultProfile())
    for (const material of validated) {
      if (await db.materials.get(material.id)) continue
      if (material.audioId && !await db.audio.get(material.audioId)) throw new Error('Missing seed audio')
      await db.materials.add(material)
    }
    for (const chunk of await db.chunks.toArray()) await ensureCards(chunk, chunk.createdAt)
    await rebuildProjections()
  })
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

async function insertEvent(event: StudyEvent): Promise<boolean> {
  const existing = await db.events.get(event.id)
  if (existing) {
    // Availability may change during a blob-free restore; it is not a change to historical evidence.
    const payload = (e: StudyEvent) => ({ ...e, data: e.data ? Object.fromEntries(Object.entries(e.data).filter(([key]) => key !== 'audioAvailable')) : undefined })
    if (canonical(payload(existing)) !== canonical(payload(event))) throw new Error('Event ID already belongs to different evidence')
    return false
  }
  if (event.chunkId && !await db.chunks.get(event.chunkId)) throw new Error('Missing event chunk')
  if (event.sessionId && !await db.sessions.get(event.sessionId) && !await db.conversations.get(event.sessionId) && !await db.assessments.get(event.sessionId)) throw new Error('Missing event session')
  for (const [field, table] of [['materialId', db.materials], ['errorId', db.errors], ['cardId', db.cards], ['audioId', db.audio]] as const) {
    const reference = event.data?.[field]
    if (reference !== undefined && (typeof reference !== 'string' || (!await table.get(reference) && !(field === 'audioId' && event.data?.audioAvailable === false)))) throw new Error(`Missing event ${field}`)
  }
  if (typeof event.data?.cardId === 'string') {
    const card = (await db.cards.get(event.data.cardId))!
    if (event.chunkId !== card.chunkId || event.modality !== card.modality) throw new Error('Event/card modality mismatch')
  }
  await db.events.add(event)
  return true
}

export async function recordEvent(event: StudyEvent): Promise<void> {
  const validated = eventSchema.parse(event)
  await db.transaction('rw', eventTables, async () => {
    if (await insertEvent(validated)) {
      await scheduleRepairRetests(validated)
      await rebuildProjections()
    }
  })
}

/** Prompted practice changes retest due dates, never fabricates an FSRS recall or new memory state. */
async function scheduleRepairRetests(event: StudyEvent): Promise<void> {
  if (!['repair-attempt', 'SPEAK_RETRY'].includes(event.type) || !event.prompted || event.score !== 1
    || event.data?.fullSentence !== true || event.source === 'self-report' || typeof event.data.errorId !== 'string') return
  const error = await db.errors.get(event.data.errorId)
  // Old corrections remain in history, but cannot reschedule a newer corrected phrase.
  if (!error?.chunkId || error.chunkId !== event.chunkId) return
  const linked = await db.cards.where('errorId').equals(error.id).toArray()
  const subsequent = await db.events.where('chunkId').equals(error.chunkId).filter(e => e.timestamp > event.timestamp).toArray()
  for (const review of linked) {
    if (!['cloze', 'speaking', 'transfer'].includes(review.modality)) continue
    if ((review.card.last_review?.getTime() ?? -1) > event.timestamp || subsequent.some(e => e.data?.cardId === review.id
      || (e.data?.errorId === error.id && e.data?.fullSentence === true && e.prompted && e.score === 1))) continue
    const delay = review.modality === 'transfer' ? REPAIR_TRANSFER_DELAY : REPAIR_RETEST_DELAY
    await db.cards.put(reviewCardSchema.parse({ ...review, card: { ...review.card, due: new Date(event.timestamp + delay) },
      contextIds: event.contextId && !review.contextIds.includes(event.contextId) ? [...review.contextIds, event.contextId] : review.contextIds }))
  }
}

/** Save an exact full-sentence text retry once, and atomically schedule its delayed retests. */
export async function recordRepairAttempt(errorId: string, input: RepairAttemptOptions): Promise<StudyEvent> {
  const options = repairAttemptOptionsSchema.parse(input)
  const timestamp = options.timestamp ?? Date.now()
  if (timestamp > Date.now()) throw new Error('Repair timestamp is in the future')
  return db.transaction('rw', eventTables, async () => {
    const previous = await db.events.get(options.eventId)
    if (previous) {
      if (previous.type !== 'repair-attempt' || previous.data?.errorId !== errorId || previous.data?.response !== options.response
        || previous.contextId !== options.contextId || (options.timestamp !== undefined && previous.timestamp !== options.timestamp)) throw new Error('Repair event ID already used')
      return previous
    }
    const error = await db.errors.get(errorId)
    if (!error?.chunkId) throw new Error('Missing repair error or chunk')
    const sentence = (value: string) => normalize(value).replace(/[‘’]/g, "'").replace(/[,;:“”"]/g, '').replace(/[.!?。！？]+$/u, '').replace(/\s+/g, ' ').trim()
    const correct = !!sentence(options.response) && sentence(options.response) === sentence(error.corrected)
    const event = eventSchema.parse({ id: options.eventId, type: 'repair-attempt', timestamp, source: 'text',
      skill: 'grammarProduction', modality: 'cloze', prompted: true, score: correct ? 1 : 0, chunkId: error.chunkId,
      contextId: options.contextId, data: { errorId, response: options.response, fullSentence: correct } })
    await insertEvent(event)
    await scheduleRepairRetests(event)
    await rebuildProjections()
    return event
  })
}

async function upsertChunk(input: MaterialChunk, materialId?: string): Promise<Chunk> {
  const existing = await db.chunks.filter(c => normalize(c.text) === normalize(input.text)).first()
  if (existing) {
    if (materialId && !existing.sourceIds.includes(materialId)) {
      existing.sourceIds = [...existing.sourceIds, materialId]
      await db.chunks.put(existing)
    }
    await ensureCards(existing, Date.now())
    return existing
  }
  const chunk: Chunk = { id: uuid(), text: input.text.trim(), meaningEn: input.meaningEn, meaningZh: input.meaningZh,
    sourceSentence: input.example, examples: input.example ? [input.example] : [], register: 'neutral', sourceIds: materialId ? [materialId] : [],
    readingStrength: 0, listeningStrength: 0, recallStrength: 0, productionStrength: 0, spontaneousUses: 0, createdAt: Date.now() }
  await db.chunks.add(chunk)
  await ensureCards(chunk, chunk.createdAt)
  return chunk
}

export async function addChunk(chunk: MaterialChunk, materialId: string): Promise<Chunk> {
  const validated = materialChunkSchema.parse(chunk)
  return db.transaction('rw', [db.chunks, db.cards, db.materials], async () => {
    if (!await db.materials.get(materialId)) throw new Error('Missing source material')
    return upsertChunk(validated, materialId)
  })
}

/** expectedReps is a compare-and-swap guard: equal schedules, already advanced is a no-op, behind rejects.
 * AI oral language evidence requires both recorded-audio/transcript attestations; neither is an acoustic score.
 * Supply audioId to retain a validated recording reference. Context novelty is computed here, never supplied.
 */
export async function reviewCard(cardId: string, rating: 1 | 2 | 3 | 4, input: ReviewOptions = {}): Promise<void> {
  if (![Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].includes(rating)) throw new Error('Invalid review rating')
  const options = reviewOptionsSchema.parse(input)
  const source = options.source ?? 'self-report'
  const score = options.score ?? ({ 1: 0, 2: 0.5, 3: 0.8, 4: 1 }[rating])
  const timestamp = Date.now()
  await db.transaction('rw', eventTables, async () => {
    cardId = await resolveCardAlias(db, cardId)
    const stored = await db.cards.get(cardId)
    if (!stored) throw new Error('Missing review card')
    const review = reviewCardSchema.parse(stored)
    if (options.eventId) {
      const previous = (await db.events.bulkGet(await resolveEventAliases(db, options.eventId))).filter((event): event is StudyEvent => !!event)
      for (const event of previous) {
        if (event.type === 'review' && typeof event.data?.cardId === 'string'
          && await resolveCardAlias(db, event.data.cardId) === cardId && event.data.rating === rating && event.source === source
          && event.score === score && event.contextId === options.contextId && event.prompted === (options.prompted ?? false)
          && event.data.audioObserved === (options.audioObserved ?? false) && event.data.transcriptVerified === (options.transcriptVerified ?? false)
          && event.data.audioId === options.audioId && event.sessionId === options.sessionId
          && event.data.responseEventId === options.responseEventId) return
      }
      if (previous.length) throw new Error('Review event ID already used')
    }
    if (options.expectedReps !== undefined) {
      if (review.card.reps > options.expectedReps) throw new Error('Review changed on another device; reload the saved attempt before scheduling')
      if (review.card.reps < options.expectedReps) throw new Error('Review repetitions are below the expected value')
    }
    if (review.card.last_review && timestamp < review.card.last_review.getTime()) throw new Error('Review clock precedes last review')
    if (options.audioId) {
      const audio = await db.audio.get(options.audioId)
      if (!audio || audio.kind !== 'recording' || !audio.blob.size) throw new Error('Review audio must be a saved recording')
    }
    const responseId = options.responseEventId ?? `review-response:${cardId}:${review.card.reps}`
    const responseAliases = await resolveEventAliases(db, responseId)
    const responses = (await db.events.bulkGet(responseAliases)).filter((event): event is StudyEvent => !!event)
    const ignoredResponses = new Set(responses.filter(event => event.type === 'REVIEW_RESPONSE'
      && event.chunkId === review.chunkId && event.modality === review.modality
      && (options.sessionId ? event.sessionId === options.sessionId : event.id === responseId)).map(event => event.id))
    const contextKey = options.contextId ? normalize(options.contextId) : undefined
    const history = contextKey ? await db.events.where('chunkId').equals(review.chunkId).filter(e => !!e.contextId && normalize(e.contextId) === contextKey && !ignoredResponses.has(e.id)).toArray() : []
    const siblingCards = options.contextId ? await db.cards.where('chunkId').equals(review.chunkId).toArray() : []
    const novelContext = !!contextKey && !history.length && !siblingCards.some(c => c.contextIds.some(context => normalize(context) === contextKey))
    const candidate: StudyEvent = { id: '', type: 'review', timestamp, source, chunkId: review.chunkId, modality: review.modality,
      score, prompted: options.prompted ?? false, contextId: options.contextId,
      data: { novelContext, audioObserved: options.audioObserved ?? false, transcriptVerified: options.transcriptVerified ?? false } }
    // Retrieval after revealing the answer is not a successful independent recall.
    // A linked transfer retest only graduates on independently observed success in a new context.
    const unprovenTransfer = review.errorId && review.modality === 'transfer' && score >= 0.6 && (!novelContext || !evidenceWeight(candidate))
    const scheduledRating = options.prompted || score === 0 || unprovenTransfer ? Rating.Again : rating
    const result = scheduler.next(review.card, new Date(timestamp), scheduledRating)
    const eventId = options.eventId ?? `review:${uuid()}`
    const event = eventSchema.parse({
      id: eventId, type: 'review', timestamp, source, sessionId: options.sessionId,
      chunkId: review.chunkId, modality: review.modality, prompted: options.prompted ?? false,
      contextId: options.contextId, score,
      data: { cardId, rating, scheduledRating, novelContext, nextDue: result.card.due.getTime(),
        attemptId: eventId, previousReps: review.card.reps,
        ...(options.responseEventId ? { responseEventId: options.responseEventId } : {}),
        audioObserved: options.audioObserved ?? false, transcriptVerified: options.transcriptVerified ?? false,
        ...(options.audioId ? { audioId: options.audioId } : {}),
        ...(review.errorId ? { errorId: review.errorId } : {}) },
    })
    await insertEvent(event)
    await db.cards.put({ ...review, card: result.card, contextIds: options.contextId && novelContext ? [...review.contextIds, options.contextId] : review.contextIds })
    await rebuildProjections()
  })
}

export async function saveError(error: Evaluation['errors'][number]): Promise<ErrorPattern> {
  const validated = evaluationErrorSchema.parse(error)
  return db.transaction('rw', eventTables, async () => {
    const pattern = `${normalize(validated.category)}: ${normalize(validated.original)}`
    let stored = await db.errors.filter(e => e.pattern === pattern).first()
    const chunk = await upsertChunk({ text: validated.corrected, meaningEn: validated.explanation, meaningZh: '', example: validated.corrected })
    if (!stored) stored = { ...validated, id: uuid(), pattern, chunkId: chunk.id, attempts: 0, failures: 0, spontaneousSuccesses: 0, nextReview: Date.now() + 600_000 }
    else stored = { ...stored, ...validated, chunkId: chunk.id }
    await db.errors.put(stored)
    // Detach an obsolete corrected phrase if the same error receives a revised correction.
    await db.cards.where('errorId').equals(stored.id).filter(c => c.chunkId !== chunk.id).modify(c => { delete c.errorId })
    await db.cards.where('chunkId').equals(chunk.id).filter(c => ['cloze', 'speaking', 'transfer'].includes(c.modality)).modify(c => { c.errorId = stored!.id })
    await insertEvent(eventSchema.parse({ id: uuid(), type: 'error-detected', timestamp: Date.now(), source: 'ai', chunkId: chunk.id, data: { errorId: stored.id } }))
    await rebuildProjections()
    return (await db.errors.get(stored.id))!
  })
}

export async function rebuildSkills(): Promise<void> {
  await db.transaction('rw', projectionTables, rebuildProjections)
}

function audioMetadata(asset: AudioAsset) {
  // Explicit allowlist: Blob and any injected fields never reach the serialized value.
  return audioMetadataSchema.parse({ id: asset.id, mimeType: asset.mimeType, createdAt: asset.createdAt, duration: asset.duration, kind: asset.kind, processed: asset.processed, label: asset.label })
}

export async function exportBackup(): Promise<string> {
  return db.transaction('r', backupTables.map(name => db.table(name)), async () => {
    const tables: Record<string, unknown[]> = {}
    for (const name of backupTables) tables[name] = name === 'audio' ? (await db.audio.toArray()).map(audioMetadata) : await db.table(name).toArray()
    const backup = parseBackup({ format: 'jove-english-os', version: 1, schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: Date.now(), audioPolicy: 'blobs-omitted', tables })
    return JSON.stringify(backup)
  })
}

function markMissingAudio(tables: Backup['tables'], available: Set<string>): void {
  for (const material of tables.materials) if (material.audioId && !available.has(material.audioId)) delete material.audioId
  for (const conversation of tables.conversations) for (const message of conversation.messages) if (message.audioId && !available.has(message.audioId)) delete message.audioId
  for (const event of tables.events) {
    const audioId = event.data?.audioId
    if (typeof audioId === 'string' && !available.has(audioId)) event.data = { ...event.data, audioAvailable: false }
  }
  // Drafts are intentionally extensible JSON. Mark missing audio without discarding saved text.
  const visit = (value: unknown, missing: Set<string>) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const child of value) visit(child, missing); return }
    const record = value as Record<string, unknown>
    if (typeof record.audioId === 'string' && !available.has(record.audioId)) { missing.add(record.audioId); delete record.audioId }
    if (Array.isArray(record.audioIds)) record.audioIds = record.audioIds.filter(audioId => {
      if (typeof audioId === 'string' && !available.has(audioId)) { missing.add(audioId); return false }
      return true
    })
    for (const child of Object.values(record)) visit(child, missing)
  }
  for (const session of tables.sessions) {
    const missing = new Set<string>()
    visit(session.draft, missing)
    if (missing.size) { session.draft.audioUnavailable = true; session.draft.missingAudioIds = [...missing] }
  }
}

export async function restoreBackup(text: string): Promise<void> {
  if (typeof text !== 'string' || text.length > 50_000_000) throw new Error('Backup exceeds 50 MB text limit')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('Backup is not valid JSON') }
  const backup = parseBackup(raw)
  await db.transaction('rw', backupTables.map(name => db.table(name)), async () => {
    const localAudio = await db.audio.toArray()
    const metadata = new Map(backup.tables.audio.map(a => [a.id, a]))
    const available = new Set(localAudio.filter(a => {
      const expected = metadata.get(a.id)
      return a.blob.size > 0 && !!expected && canonical(audioMetadata(a)) === canonical(expected)
    }).map(a => a.id))
    markMissingAudio(backup.tables, available)
    // Secrets and local audio are never cleared: unprocessed recordings survive restores.
    for (const name of backupTables) {
      if (name === 'audio') continue
      await db.table(name).clear()
      if (backup.tables[name].length) await db.table(name).bulkAdd(backup.tables[name])
    }
    // Do not trust imported, potentially inflated derived mastery values.
    await rebuildProjections()
  })
}
