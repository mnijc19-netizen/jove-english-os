import Dexie from 'dexie'
import { computed, markRaw, ref } from 'vue'
import { defineStore } from 'pinia'
import { db as englishDatabase, createLanguageDatabase, type JoveDatabase } from '../db/db'
import { initializeJapanese } from '../db/japanese'
import { createCloudState, useCloud } from './cloud'
import { refreshJapaneseReadingCatalog } from '../cloud/content'

type CloudState = ReturnType<typeof createCloudState>
type SharedAccount = Pick<CloudState, 'settle' | 'signOut'> & { ownerId: () => string }

/** One auth client, two immutable database/sync contexts. A page owns its own
 * DB handle; leaving it cannot close this background synchronization handle. */
export function createJapaneseSpace(english: JoveDatabase, sharedAccount: SharedAccount,
  database = createLanguageDatabase('ja'), makeCloud: (database: JoveDatabase, guard: (owner: string) => Promise<void>) => CloudState
    = (database, guard) => createCloudState(database, undefined, undefined, guard), refreshCatalog = refreshJapaneseReadingCatalog) {
  if (english.language !== 'en' || database.language !== 'ja') throw new Error('Invalid language spaces')
  let epoch = 0
  const signingOut = ref(false)
  async function admitOwner(owner: string) {
    if (signingOut.value || !owner || sharedAccount.ownerId() !== owner || (await english.syncMeta.get('owner'))?.value !== owner)
      throw new Error('英语尚未接纳同一学习账号，日语没有上传任何记录。')
  }
  const cloud = makeCloud(database, admitOwner), ready = ref(false), opening = ref(false), initializationError = ref(''), revision = ref(0)
  let pending: Promise<void> | undefined, started = false, afterDownload: () => Promise<void> = async () => {}
  const catalogProblem = ref('')
  let catalogAbort: AbortController | undefined, catalogPending: Promise<void> | undefined, catalogAttempt = 0
  function refreshBooks() {
    if (!ready.value || !cloud.configured || !sharedAccount.ownerId() || catalogPending || Date.now() - catalogAttempt < 6 * 3600000) return
    catalogAttempt = Date.now(); catalogAbort = new AbortController()
    const generation = epoch
    catalogPending = refreshCatalog(database, catalogAbort.signal).then(async materials => {
      if (generation !== epoch) return
      catalogProblem.value = materials.length ? '' : '完整原版读物目录尚未就绪，先使用已核验的备用链接。'; revision.value++; await afterDownload()
    }).catch(() => {
      if (generation === epoch) catalogProblem.value = '原版读物目录暂未更新，已有读物和草稿仍保留。系统稍后再试。'
    }).finally(() => { catalogPending = undefined; catalogAbort = undefined })
  }
  const status = computed(() => initializationError.value ? 'Japanese setup needs attention' : opening.value ? 'Opening Japanese sync'
    : !started ? 'Japanese not opened' : cloud.status.value)
  async function sameOwner() {
    const enOwner = (await english.syncMeta.get('owner'))?.value, jaOwner = (await database.syncMeta.get('owner'))?.value
    if (enOwner !== jaOwner) {
      ready.value = false
      initializationError.value = '日语区尚未连接到同一学习账号。请联网并用原账号登录；两种语言的记录都没有被覆盖。'
      throw new Error(initializationError.value)
    }
  }
  async function ensure() {
    if (signingOut.value) throw new Error('正在登出，请稍后再打开日语区。')
    if (pending) return pending
    if (ready.value) { await sharedAccount.settle(); await sameOwner(); refreshBooks(); return }
    opening.value = true; initializationError.value = ''
    const generation = epoch
    const current = () => { if (generation !== epoch || signingOut.value) throw new Error('日语初始化已取消，本地记录仍保留。') }
    pending = Promise.resolve().then(async () => {
      await sharedAccount.settle()
      current()
      const bound = (await database.syncMeta.get('owner'))?.value
      if (bound !== undefined && bound !== (await english.syncMeta.get('owner'))?.value) await sameOwner()
      if (cloud.configured && sharedAccount.ownerId()) await admitOwner(sharedAccount.ownerId())
      current()
      await initializeJapanese(database)
      current()
      if (cloud.paused.value) { await cloud.resume(); current() }
      if (!started) {
        started = true
        await cloud.start(async () => { revision.value++; await afterDownload() })
      } else await cloud.resume()
      current()
      await sameOwner()
      ready.value = true; revision.value++
      await afterDownload()
      refreshBooks()
    }).catch(error => {
      initializationError.value = error instanceof Error ? error.message : '日语同步尚未连接，本地记录仍保留。'
      throw error
    }).finally(() => { opening.value = false; pending = undefined })
    return pending
  }
  async function startIfPresent(refresh: () => Promise<void>) {
    afterDownload = refresh
    // Merely opening English must not create or opt into Japanese.
    // Dexie.exists dynamically opens an absent name then deletes it; that can
    // race explicit first-open. Enumeration never opens/deletes this workspace.
    if (!(await Dexie.getDatabaseNames()).includes(database.name)) return
    await ensure()
  }
  async function signOut() {
    if (signingOut.value) return
    signingOut.value = true; epoch++
    catalogAbort?.abort(); await catalogPending; catalogAttempt = 0
    // Fence both contexts before the shared auth session changes. In-flight
    // Japanese metadata/recording commits must not continue under a new login.
    try {
      await cloud.pause()
      await pending?.catch(() => {})
      await sharedAccount.signOut()
    } finally {
      signingOut.value = false
      initializationError.value = ''
      if (started) await cloud.resume()
    }
  }
  async function stop() { epoch++; catalogAbort?.abort(); await catalogPending; await cloud.stop(); await pending?.catch(() => {}); started = false; ready.value = false; database.close() }
  return { database: markRaw(database), ready, opening, revision, status,
    problem: computed(() => initializationError.value || cloud.problem.value), catalogProblem, configured: cloud.configured,
    syncing: cloud.syncing, lastSynced: cloud.lastSynced, pending: cloud.pending, hasMore: cloud.hasMore,
    audioPending: cloud.audioPending, audioBlocked: cloud.audioBlocked, deferred: cloud.deferred,
    conflicts: cloud.conflicts, online: cloud.online, signingOut, ensure, startIfPresent, syncNow: cloud.syncNow,
    withLocalDataChange: cloud.withLocalDataChange, signOut, stop }
}
export const useJapaneseSpace = defineStore('japanese-space', () => {
  const account = useCloud()
  return createJapaneseSpace(englishDatabase, { settle: account.settle, signOut: account.signOut, ownerId: () => account.userId })
})
