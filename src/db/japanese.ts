import type { JoveDatabase } from './db'
import { createLearningRepository } from './repository'
import { japaneseStarterMaterials } from '../content/japanese'

/** Called only by an explicitly enabled Japanese workspace, never by English
 * bootstrap. Does not overwrite setup, learned content, cards or saved work. */
export async function initializeJapanese(database: JoveDatabase): Promise<void> {
  if (database.language !== 'ja') throw new Error('Japanese setup requires its own workspace')
  await createLearningRepository(database).initialize(japaneseStarterMaterials())
}
