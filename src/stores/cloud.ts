import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { cloudClient, publicCloudConfig, type PublicCloudConfig } from '../cloud/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { db, type JoveDatabase } from '../db/db'
import { SyncJournal } from '../sync/journal'
import { SupabaseSyncRemote, synchronize } from '../sync/remote'
import { readRecordingRetention, synchronizeAudio } from '../sync/audio'
import { accountRequest, bindSyncAccess } from '../sync/access'
import { protectedLocalChange } from '../sync/local-change'

/** Exported to exercise the real store against isolated databases and SDK clients. */
export function createCloudState(database: JoveDatabase = db, client: SupabaseClient | null = cloudClient, config: PublicCloudConfig = publicCloudConfig) {
  const configured = !!client, userId = ref(''), email = ref(''), syncing = ref(false), problem = ref(''), lastSynced = ref(0)
  const online = ref(typeof navigator === 'undefined' || navigator.onLine !== false), pending = ref(0), accountBusy = ref(false), paused = ref(false)
  const hasMore = ref(false), deferred = ref(0), conflicts = ref(0), audioPending = ref(false), audioBlocked = ref(0)
  const cardAliases = ref<Record<string, string>>({}), journal = new SyncJournal(database)
  let started = false, epoch = 0, running: Promise<void> | undefined, adoption: Promise<void> | undefined
  let afterDownload: () => Promise<void> = async () => {}, cleanup: (() => void) | undefined
  let localChange: Promise<unknown> | undefined
  let pauseRevision = 0
  const status = computed(() => !configured ? 'Saved on this device' : paused.value ? 'Sync paused' : !online.value ? 'Offline'
    : problem.value ? 'Sync problem' : !userId.value ? 'Sign in to sync' : deferred.value || audioBlocked.value ? 'Some saved work needs attention'
      : syncing.value || pending.value || hasMore.value || audioPending.value ? 'Syncing' : lastSynced.value ? 'Synced' : 'Waiting to sync')
  function check(generation: number, id: string) {
    if (paused.value || generation !== epoch || userId.value !== id) throw new Error('Sync paused or account changed')
  }
  async function syncNow(): Promise<void> {
    if (!client || !userId.value || !online.value || paused.value) return
    if (running) return running
    const id = userId.value, generation = epoch
    syncing.value = true
    // Set the shared promise before executing any asynchronous implementation.
    running = Promise.resolve().then(async () => {
      let refresh = false
      try {
        const access = await bindSyncAccess(client, id, config, async () => {
          check(generation, id)
          if (await journal.owner() !== id) throw new Error('Sync owner changed')
        })
        const result = await synchronize(journal, new SupabaseSyncRemote(access.client, access))
        check(generation, id)
        refresh = result.downloaded > 0
        pending.value = result.pending; hasMore.value = result.hasMore; deferred.value = result.deferred; conflicts.value = result.conflicts
        cardAliases.value = ((await database.syncMeta.get('cardAliases'))?.value ?? {}) as Record<string, string>
        const policy = await readRecordingRetention(access)
        await access.assertCurrent()
        await database.transaction('rw', database.settings, database.syncMeta, async () => {
          check(generation, id)
          const setting = await database.settings.get('main')
          if (setting) {
            if (!await database.syncMeta.get('legacyRecordingRetention')) await database.syncMeta.put({
              id: 'legacyRecordingRetention', value: setting.value.recordingRetention ?? null,
            })
            await database.settings.put({ ...setting, value: { ...setting.value, recordingRetention: policy } })
          }
        })
        audioPending.value = true
        if (!result.pending && !result.hasMore && !result.deferred) {
          const audio = await synchronizeAudio(database, access, policy)
          check(generation, id)
          audioPending.value = audio.hasMore || audio.retentionPending
          audioBlocked.value = audio.blocked
          refresh ||= audio.downloaded > 0
        }
        await journal.capture()
        check(generation, id)
        pending.value = await journal.pendingCount()
        problem.value = ''
        if (!pending.value && !hasMore.value && !deferred.value && !audioPending.value && !audioBlocked.value) lastSynced.value = Date.now()
        else lastSynced.value = 0
      } catch {
        if (generation === epoch && !paused.value) {
          problem.value = 'Sync could not finish. Your work is saved on this device and will retry automatically.'
          lastSynced.value = 0
        }
      } finally {
        try { if (refresh && generation === epoch && !paused.value) await afterDownload() }
        finally { syncing.value = false; running = undefined }
      }
    })
    return running
  }
  async function adoptCurrentSession(): Promise<void> {
    if (!client || paused.value) return
    if (adoption) return adoption
    const generation = epoch
    adoption = Promise.resolve().then(async () => {
      try {
        if (running) await running
        const session = await client.auth.getSession(), id = session.data.session?.user.id
        if (session.error || !id) { if (generation === epoch) { userId.value = ''; email.value = ''; lastSynced.value = 0 } return }
        const access = await bindSyncAccess(client, id, config, async () => {
          if (generation !== epoch || paused.value) throw new Error('Account changed')
          const bound = (await database.syncMeta.get('owner'))?.value
          if (bound && bound !== id) throw new Error('This browser belongs to another account')
        })
        // Validate actual membership BEFORE binding an unowned legacy database.
        const member = await accountRequest(access, () => access.client.from('app_members').select('user_id').eq('user_id', id).maybeSingle())
        if (member.error || member.data?.user_id !== id) throw new Error('This account is not enabled for learning sync')
        await access.assertCurrent()
        await journal.bindOwner(id)
        if (generation !== epoch || paused.value) return
        userId.value = id; email.value = session.data.session?.user.email ?? ''; lastSynced.value = 0; problem.value = ''
        await syncNow()
      } catch {
        if (generation === epoch && !paused.value) {
          userId.value = ''; email.value = ''; lastSynced.value = 0
          problem.value = 'This account could not open this browser’s learning history. Sign in to its enabled owner account; local work has not been changed.'
        }
      } finally { adoption = undefined }
    })
    return adoption
  }
  async function start(refresh: () => Promise<void>) {
    afterDownload = refresh
    if (started || !client) return
    started = true
    const subscription = client.auth.onAuthStateChange(() => {
      epoch++; userId.value = ''; email.value = ''; lastSynced.value = 0
      // Never await SDK auth from its locked callback. Read current, not stale callback session.
      setTimeout(() => { void (async () => { if (adoption) await adoption; await adoptCurrentSession() })() }, 0)
    }).data.subscription
    const onOnline = () => { online.value = true; void adoptCurrentSession() }
    const onOffline = () => { online.value = false }
    const onFocus = () => { void (userId.value ? syncNow() : adoptCurrentSession()) }
    const onVisibility = () => { if (document.visibilityState === 'visible') onFocus() }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline); window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onVisibility)
    }
    const timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') onFocus() }, 15000)
    cleanup = () => {
      clearInterval(timer); subscription.unsubscribe()
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); window.removeEventListener('focus', onFocus)
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
    await adoptCurrentSession()
  }
  /** Immediately invalidate in-flight access, then wait for its local transactions to settle. */
  async function pause(): Promise<void> { paused.value = true; epoch++; pauseRevision++; lastSynced.value = 0; await running; await adoption }
  async function beforeLocalReset(): Promise<void> {
    await pause()
    if ((await database.syncMeta.get('owner'))?.value) await journal.capture()
  }
  async function resume(): Promise<void> {
    if (localChange) throw new Error('A local data change is still in progress')
    paused.value = false; await adoptCurrentSession()
  }
  async function withLocalDataChange<T>(change: () => Promise<T>): Promise<T> {
    if (localChange) throw new Error('Another local data change is still in progress')
    const wasPaused = paused.value
    // pause() fences synchronously, before another click/focus/auth callback.
    const settled = pause(), ownPauseRevision = pauseRevision
    const operation = Promise.resolve().then(async () => {
      await settled
      return protectedLocalChange(database, change)
    })
    localChange = operation
    try { return await operation }
    finally { localChange = undefined; if (!wasPaused && pauseRevision === ownPauseRevision) await resume() }
  }
  async function stop(): Promise<void> { cleanup?.(); cleanup = undefined; started = false; await pause() }
  async function requestCode(address: string): Promise<boolean> {
    if (!client || accountBusy.value || !online.value) return false
    accountBusy.value = true; problem.value = ''
    try {
      const { error } = await client.auth.signInWithOtp({ email: address.trim(), options: { shouldCreateUser: false } })
      if (error) throw new Error('Sign-in request failed')
      return true
    } catch { problem.value = 'Could not send a code. Check the address and connection, then try again.'; return false }
    finally { accountBusy.value = false }
  }
  async function verifyCode(address: string, code: string): Promise<boolean> {
    if (!client || accountBusy.value || !online.value) return false
    accountBusy.value = true; problem.value = ''
    try {
      const { data, error } = await client.auth.verifyOtp({ email: address.trim(), token: code.trim(), type: 'email' })
      if (error || !data.session) throw new Error('Invalid sign-in')
      if (adoption) await adoption
      await adoptCurrentSession()
      return userId.value === data.session.user.id
    } catch { problem.value = 'That code could not be verified. Try again or request a new code.'; return false }
    finally { accountBusy.value = false }
  }
  async function signOut() {
    if (!client) return
    await pause()
    if (localChange) await localChange.catch(() => {})
    try { await client.auth.signOut({ scope: 'local' }) }
    finally { userId.value = ''; email.value = ''; lastSynced.value = 0; paused.value = false }
  }
  return { configured, userId, email, syncing, problem, lastSynced, pending, online, accountBusy, status, paused,
    hasMore, deferred, conflicts, audioPending, audioBlocked, cardAliases, start, syncNow, requestCode, verifyCode, signOut,
    pause, resume, beforeLocalReset, withLocalDataChange, stop }
}
export const useCloud = defineStore('cloud', () => createCloudState())
