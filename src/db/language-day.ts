import Dexie from 'dexie'
import { createLanguageDatabase, type JoveDatabase } from './db'
import { allocateLanguageDay, languageDatabases, type LanguageDay } from '../domain/language'
import { z } from 'zod'

export const languagePreferenceSchema = z.strictObject({ version: z.literal(1), primaryLanguage: z.enum(['en', 'ja', 'balanced']),
  primaryShare: z.number().min(0.5).max(0.9) })
export const languagePreferenceId = 'language-time-preference'

/** One account-level time preference remains in the legacy English profile, so
 * existing clients/settings never gain unknown wire fields. No hidden Japanese
 * database is created merely by opening the English app. */
export async function readLanguageDay(english: JoveDatabase, now: number, japanese?: JoveDatabase,
  options: { admitJapanese?: boolean } = {}) {
  if (english.language !== 'en' || japanese && japanese.language !== 'ja') throw new Error('Wrong daily-plan language partition')
  if (options.admitJapanese && !japanese) throw new Error('Japanese admission requires its own workspace')
  const read = (database: JoveDatabase) => database.transaction('r', [database.profiles, database.events, database.cards, database.plans, database.syncMeta, database.sessions], async () => {
      const [profile, events, cards, plan, owner] = await Promise.all([database.profiles.get('main'), database.events.toArray(), database.cards.toArray(),
        database.plans.get(new Date(now).toLocaleDateString('en-CA')), database.syncMeta.get('owner')])
      const space: LanguageDay = { enabled: !!profile?.onboarded, events, plan, dueCards: cards.filter(card => new Date(card.card.due).getTime() <= now).length }
      const preference = database.language === 'en' ? languagePreferenceSchema.safeParse((await database.sessions.get(languagePreferenceId))?.draft) : null
      return { profile, space, owner: owner?.value, preference: preference?.success ? preference.data : undefined }
    })
  if (!japanese && !(await Dexie.getDatabaseNames()).includes(languageDatabases.ja)) {
    const en = await read(english)
    const hasStarterWork = en.space.events.some(event => ['TASK_STARTED', 'TASK_COMPLETED'].includes(event.type)
      && event.source === 'objective' && event.data?.kind === 'starter-classroom' && event.timestamp <= now
      && new Date(event.timestamp).toLocaleDateString('en-CA') === new Date(now).toLocaleDateString('en-CA'))
    if (!hasStarterWork) return null
    if ((await english.syncMeta.get('owner'))?.value !== en.owner) throw new Error('Learning account changed')
    return { ...allocateLanguageDay(en.profile?.dailyMinutes ?? 45, { en: { ...en.space, enabled: true },
      ja: { enabled: false, events: [], dueCards: 0 } }, now, en.preference), owner: en.owner }
  }
  const other = japanese ?? createLanguageDatabase('ja')
  try {
    const [en, ja] = await Promise.all([read(english), read(other)])
    if (en.owner !== ja.owner) {
      if (options.admitJapanese) throw new Error('Learning account changed')
      return null
    }
    if ((await english.syncMeta.get('owner'))?.value !== en.owner || (await other.syncMeta.get('owner'))?.value !== ja.owner) throw new Error('Learning account changed')
    // Explicit starter admission previews BOTH shares without persisting setup.
    // Ordinary reads still require Japanese's own setup, not opening a link.
    en.space.enabled = true
    if (options.admitJapanese) ja.space.enabled = true
    const day = allocateLanguageDay(en.profile?.dailyMinutes ?? 45, { en: en.space, ja: ja.space }, now, en.preference)
    const starterWork = en.space.events.some(event => event.data?.kind === 'starter-classroom')
    return !ja.space.enabled && !day.allowances.ja.completed && !starterWork ? null : { ...day, owner: en.owner }
  } finally { if (!japanese) other.close() }
}
