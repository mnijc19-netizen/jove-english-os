import Dexie from 'dexie'
import { createLanguageDatabase, type JoveDatabase } from './db'
import { allocateLanguageDay, languageDatabases, type LanguageDay } from '../domain/language'

/** One account-level time preference remains in the legacy English profile, so
 * existing clients/settings never gain unknown wire fields. No hidden Japanese
 * database is created merely by opening the English app. */
export async function readLanguageDay(english: JoveDatabase, now: number, japanese?: JoveDatabase) {
  if (english.language !== 'en' || japanese && japanese.language !== 'ja') throw new Error('Wrong daily-plan language partition')
  if (!japanese && !await Dexie.exists(languageDatabases.ja)) return null
  const other = japanese ?? createLanguageDatabase('ja')
  try {
    const read = (database: JoveDatabase) => database.transaction('r', database.profiles, database.events, database.cards, database.plans, database.syncMeta, async () => {
      const [profile, events, cards, plan, owner] = await Promise.all([database.profiles.get('main'), database.events.toArray(), database.cards.toArray(),
        database.plans.get(new Date(now).toLocaleDateString('en-CA')), database.syncMeta.get('owner')])
      const space: LanguageDay = { enabled: !!profile?.onboarded, events, plan, dueCards: cards.filter(card => new Date(card.card.due).getTime() <= now).length }
      return { profile, space, owner: owner?.value }
    })
    const [en, ja] = await Promise.all([read(english), read(other)])
    if (en.owner !== ja.owner) return null
    if ((await english.syncMeta.get('owner'))?.value !== en.owner || (await other.syncMeta.get('owner'))?.value !== ja.owner) throw new Error('Learning account changed')
    // English is still available during diagnosis; Japanese is admitted only
    // after its own setup, not from recognizing a few kanji or opening a link.
    en.space.enabled = true
    const day = allocateLanguageDay(en.profile?.dailyMinutes ?? 45, { en: en.space, ja: ja.space }, now)
    return !ja.space.enabled && !day.allowances.ja.completed ? null : { ...day, owner: en.owner }
  } finally { if (!japanese) other.close() }
}
