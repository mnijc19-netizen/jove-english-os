import Dexie, { type Table } from 'dexie'
import { createEmptyCard } from 'ts-fsrs'
import type { Assessment, AudioAsset, Chunk, Conversation, DailyPlan, ErrorPattern, Material, Profile, ReviewCard, Settings, Skill, StudyEvent, StudySession, Usage } from '../domain/types'
import { aggregateSkills } from '../domain/engine'
import { eventSchema, modalities, reviewCardSchema } from './schema'
import { projectChunks, projectErrors } from './projections'
import type { StoredOperation, EntityType, RecordValue } from '../sync/protocol'

export const DB_NAME = 'jove-english-os'
export const DB_VERSION = 3
// Sync journals are device/account state, not portable learning backup data.
export const BACKUP_SCHEMA_VERSION = 2
// V1 is deliberately retained as an executable migration baseline.
export const version1Stores = {
  settings: 'id', secrets: 'id', profiles: 'id', skills: 'id', events: 'id,timestamp,skill,chunkId',
  chunks: 'id,text', cards: 'id,chunkId,modality', errors: 'id,category,nextReview', materials: 'id,topic,createdAt',
  sessions: 'id,kind,startedAt', plans: 'id,date', conversations: 'id,startedAt', assessments: 'id,timestamp',
  audio: 'id,createdAt,kind', usage: 'id,timestamp',
}

export class JoveDatabase extends Dexie {
  settings!: Table<{ id: string; value: Settings }, string>
  secrets!: Table<{ id: string; value: string }, string>
  profiles!: Table<Profile, string>
  skills!: Table<Skill, string>
  events!: Table<StudyEvent, string>
  chunks!: Table<Chunk, string>
  cards!: Table<ReviewCard, string>
  errors!: Table<ErrorPattern, string>
  materials!: Table<Material, string>
  sessions!: Table<StudySession, string>
  plans!: Table<DailyPlan, string>
  conversations!: Table<Conversation, string>
  assessments!: Table<Assessment, string>
  audio!: Table<AudioAsset, string>
  usage!: Table<Usage, string>
  syncOperations!: Table<StoredOperation, string>
  syncMeta!: Table<{ id: string; value: unknown }, string>
  syncSnapshots!: Table<{ id: string; entityType: EntityType; entityId: string; record: RecordValue }, string>

  constructor(name = DB_NAME) {
    super(name)
    this.version(1).stores(version1Stores)
    this.version(2).stores({
      ...version1Stores,
      cards: 'id,chunkId,modality,&[chunkId+modality],card.due,errorId',
      events: 'id,timestamp,skill,chunkId,sessionId,type,[chunkId+modality]',
      chunks: 'id,text,*sourceIds',
      sessions: 'id,kind,startedAt,materialId',
    }).upgrade(async transaction => {
      const oldCards = await transaction.table('cards').toArray()
      const cards = oldCards.map(row => reviewCardSchema.parse({ ...row, contextIds: row.contextIds ?? [], card: { ...row.card, learning_steps: row.card.learning_steps ?? 0 } }))
      if (cards.length) await transaction.table('cards').bulkPut(cards)
      // Missing provenance in legacy rows is uncertainty, never objective evidence.
      const oldEvents = await transaction.table('events').toArray()
      const events = oldEvents.map(row => eventSchema.parse({ ...row, source: row.source ?? 'self-report', prompted: row.prompted ?? true }))
      if (events.length) await transaction.table('events').bulkPut(events)
      await transaction.table('skills').clear()
      await transaction.table('skills').bulkPut(aggregateSkills(events))
      const chunks = projectChunks(await transaction.table('chunks').toArray(), events)
      const errors = projectErrors(await transaction.table('errors').toArray(), events)
      for (const chunk of chunks) {
        const missing = modalities.filter(modality => !cards.some(card => card.chunkId === chunk.id && card.modality === modality))
        for (const modality of missing) await transaction.table('cards').add({ id: `${chunk.id}:${modality}`, chunkId: chunk.id, modality, card: createEmptyCard(chunk.createdAt), contextIds: [] })
      }
      if (chunks.length) await transaction.table('chunks').bulkPut(chunks)
      if (errors.length) await transaction.table('errors').bulkPut(errors)
    })
    this.version(DB_VERSION).stores({
      syncOperations: 'id,cursor,[entityType+entityId]',
      syncMeta: 'id', syncSnapshots: 'id,entityType,entityId',
    })
  }
}

export const db = new JoveDatabase()
