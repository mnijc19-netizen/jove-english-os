import Dexie from 'dexie'
import { createLanguageDatabase, type JoveDatabase } from '../db/db'
import type { Settings, Usage } from '../domain/types'
import { OpenRouterProvider } from './provider'
import { CloudProvider, routeProvider } from './cloud-provider'

/** Advanced browser-key spending remains an estimate; the authoritative account
 * ceiling is reserved server-side for both languages under the same owner. */
export async function localAICost(english: JoveDatabase, japanese?: JoveDatabase, now = Date.now()): Promise<number> {
  const date = new Date(now).toLocaleDateString('en-CA')
  const rows = await english.usage.toArray(), other = japanese ?? createLanguageDatabase('ja')
  try {
    if ((await Dexie.getDatabaseNames()).includes(other.name)
      && (await other.syncMeta.get('owner'))?.value === (await english.syncMeta.get('owner'))?.value) rows.push(...await other.usage.toArray())
    return rows.filter(row => !row.purpose.startsWith('account:') && new Date(row.timestamp).toLocaleDateString('en-CA') === date)
      .reduce((sum, row) => sum + (row.cost ?? 0), 0)
  } finally { if (!japanese) other.close() }
}

export function japaneseProvider(options: { database: JoveDatabase; english: JoveDatabase;
  settings: () => Settings; useAccount: () => boolean; assertCurrent: () => Promise<void> }) {
  const { database, english, assertCurrent } = options
  if (database.language !== 'ja' || english.language !== 'en') throw new Error('Wrong AI learning workspace')
  const usage = async (row: Usage) => {
    await assertCurrent(); await database.usage.put(row)
  }
  const local = new OpenRouterProvider({ learningLanguage: 'ja',
    getKey: async () => { await assertCurrent(); return (await english.secrets.get('openrouter'))?.value ?? '' },
    getSettings: options.settings, onUsage: usage,
    beforeRequest: async () => {
      await assertCurrent()
      if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('Internet required')
      if (await localAICost(english, database) >= options.settings().dailyBudget) throw new Error('Shared daily budget reached')
    },
  })
  return routeProvider(local, new CloudProvider(local, usage, database), options.useAccount)
}
