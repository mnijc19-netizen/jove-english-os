import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import { db } from '../db/db'
import { useApp } from '../stores/app'
import type { StudyEvent, StudySession } from '../domain/types'
import { acousticEvents } from './events'
import { speechBrowserClient, type EvaluatedPronunciation, type PronunciationAttempt } from './client'
import type { ReviewedReference } from './references'
import { SpeechError } from './types'

/** Own persisted session/outbox; pages retain their existing drafts and conversations. */
export function usePronunciationSession(scope: Ref<string>, materialId?: Ref<string>) {
  const app = useApp(), reference = shallowRef<ReviewedReference | null>(null)
  const savedAudioId = ref(''), savedReferenceId = ref(''), pendingAttempt = shallowRef<PronunciationAttempt>()
  const active = ref(false), loading = ref(true), problem = ref('')
  const recoveredResults = shallowRef<EvaluatedPronunciation[]>([])
  let row: StudySession | undefined, version = 0, stopped = false, accountChanged = false, controller: AbortController | undefined
  let session: ReturnType<typeof speechBrowserClient.session> | undefined, removeInvalidation: (() => void) | undefined
  let persistence: Promise<unknown> = Promise.resolve()
  let evidenceQueue: Promise<void> = Promise.resolve()
  const outbox: StudyEvent[] = []
  const current = (token: number) => token === version && !stopped && !accountChanged && (!speechBrowserClient.configured || session?.isCurrent())
  async function assertCurrent(token: number) {
    if (speechBrowserClient.configured) await session?.assertCurrent()
    if (!current(token)) throw new Error('Practice account or session changed')
  }
  function save(): Promise<unknown> {
    if (!row) return Promise.reject(new Error('Practice is not restored'))
    row.draft = { audioId: savedAudioId.value, referenceId: savedReferenceId.value, pendingAttempt: pendingAttempt.value,
      outbox: [...outbox], history: row.draft.history ?? [], pendingReferenceText: row.draft.pendingReferenceText ?? '',
      ...(row.draft.resultTimes ? { resultTimes: row.draft.resultTimes } : {}) }
    const snapshot = JSON.parse(JSON.stringify(row)) as StudySession
    const token = version
    const operation = persistence.catch(() => undefined).then(async () => {
      await assertCurrent(token)
      if (!current(token)) throw new Error('Practice account or session changed')
      await db.sessions.put(snapshot)
      if (!current(token)) throw new Error('Practice account or session changed')
    })
    persistence = operation; return operation
  }
  function flush(): Promise<void> {
    const token = version
    const operation = evidenceQueue.catch(() => undefined).then(async () => {
      if (!current(token)) return
      await save()
      while (outbox.length && token === version && !stopped) {
        const event = outbox[0]!
        await assertCurrent(token)
        if (!current(token)) return
        await app.evidence(event)
        if (token !== version || stopped) return
        outbox.shift(); await save()
      }
    })
    evidenceQueue = operation; return operation
  }
  async function load() {
    // Retry repairs transient IO, never an invalidated principal epoch. Only a
    // fresh mounted journal can bind again after sign-out or A→B→A.
    if (accountChanged || stopped) return
    const token = ++version; controller?.abort(); controller = new AbortController()
    removeInvalidation?.(); session?.dispose()
    const gate = speechBrowserClient.session(controller.signal); session = gate
    const invalidated = () => {
      if (token !== version || stopped) return
      accountChanged = true; version++; controller?.abort(); reference.value = null; recoveredResults.value = []; loading.value = false
      // Hide account-bound presentation, not the durable recordings/history.
      savedAudioId.value = ''; savedReferenceId.value = ''; pendingAttempt.value = undefined; row = undefined; outbox.splice(0)
      problem.value = 'The account changed. Sign in to this journal and reload to recover saved pronunciation work.'
    }
    gate.signal.addEventListener('abort', invalidated, { once: true })
    removeInvalidation = () => gate.signal.removeEventListener('abort', invalidated)
    const id = `speech-${scope.value}`
    loading.value = true; reference.value = null; problem.value = ''; recoveredResults.value = []
    try {
      await assertCurrent(token)
      if (!current(token)) return
      await persistence.catch(() => undefined)
      if (!current(token)) return
      const saved = await db.sessions.get(id)
      if (token !== version || stopped) return
      row = saved ?? { id, kind: 'pronunciation', startedAt: Date.now(), stage: 'saved', draft: {} }
      savedAudioId.value = typeof row.draft.audioId === 'string' ? row.draft.audioId : ''
      savedReferenceId.value = typeof row.draft.referenceId === 'string' ? row.draft.referenceId : ''
      pendingAttempt.value = row.draft.pendingAttempt as PronunciationAttempt | undefined
      outbox.splice(0, outbox.length, ...(Array.isArray(row.draft.outbox) ? row.draft.outbox as StudyEvent[] : []))
      await flush()
      const references = await speechBrowserClient.references(controller.signal, materialId?.value, savedReferenceId.value || undefined)
      if (token !== version || stopped) return
      const eligible = materialId ? references.filter(ref => ref.materialId === materialId.value) : references
      reference.value = eligible.find(ref => ref.id === savedReferenceId.value) ?? eligible[0] ?? null
      const history = Array.isArray(row.draft.history) ? row.draft.history.slice(-2) as (PronunciationAttempt & { referenceText: string })[] : []
      if (pendingAttempt.value && typeof row.draft.pendingReferenceText === 'string' && row.draft.pendingReferenceText &&
        !history.some(entry => entry.attemptId === pendingAttempt.value!.attemptId)) history.push({ ...pendingAttempt.value, referenceText: row.draft.pendingReferenceText })
      const results = await Promise.all(history.map(entry => speechBrowserClient.recover(entry, controller!.signal)))
      if (token !== version || stopped) return
      recoveredResults.value = results.filter((result): result is EvaluatedPronunciation => result !== null).slice(-2)
      const latest = recoveredResults.value.find(result => result.assessment.attemptId === pendingAttempt.value?.attemptId)
      if (latest) await evaluated(latest)
    } catch (cause) {
      if (token === version && !stopped) {
        if (cause instanceof SpeechError && cause.code === 'AUTH') invalidated()
        else problem.value = cause instanceof SpeechError && cause.code === 'TIMEOUT'
          ? 'Account access or saved practice loading timed out. Retry without deleting your recording.'
          : 'Could not restore the pronunciation reference or saved work. Retry without deleting your recording.'
      }
    }
    finally { if (token === version && !stopped) loading.value = false }
  }
  async function recorded(value: { audioId: string; duration: number; referenceId: string }) {
    const token = version
    if (!current(token)) return
    savedAudioId.value = value.audioId; savedReferenceId.value = value.referenceId; pendingAttempt.value = undefined
    try {
      await save()
      const original = await db.audio.get(value.audioId)
      if (!current(token)) return
      if (row && original?.kind === 'recording' && original.blob.size && Number.isFinite(original.duration) && original.duration > 0 && original.duration <= 30) {
        const id = value.audioId + '-language-time'
        if (!outbox.some(event => event.id === id) && !app.events.some(event => event.id === id)) outbox.push({ id,
          timestamp: original.createdAt, sessionId: row.id, type: 'PRACTICE_LOGGED', source: 'objective', prompted: true,
          data: { strand: 'language', activeSeconds: original.duration, audioId: value.audioId, referenceId: value.referenceId, scripted: true, measured: 'saved-recording-duration' } })
        await flush()
      }
    } catch { problem.value = 'The original recording is saved, but its practice draft needs saving before analysis.' }
  }
  async function persistAttempt(value: PronunciationAttempt) {
    const token = version
    await assertCurrent(token)
    if (!current(token)) throw new Error('Practice account or session changed')
    if (!row || value.recordingId !== savedAudioId.value || value.referenceId !== savedReferenceId.value) throw new Error('Practice input changed')
    pendingAttempt.value = { ...value }; row.draft.pendingReferenceText = reference.value?.text ?? row.draft.pendingReferenceText ?? ''; await flush()
  }
  async function evaluated(value: EvaluatedPronunciation) {
    const token = version
    await assertCurrent(token)
    if (!current(token)) return
    if (!row || value.assessment.referenceId !== savedReferenceId.value || value.assessment.recordingId !== savedAudioId.value) return
    const times = (row.draft.resultTimes ?? {}) as Record<string, number>
    const timestamp = times[value.assessmentId] ?? value.assessedAt ?? Date.now()
    times[value.assessmentId] = timestamp; row.draft.resultTimes = times
    const history = Array.isArray(row.draft.history) ? row.draft.history as (PronunciationAttempt & { referenceText: string })[] : []
    const referenceText = reference.value?.id === value.assessment.referenceId ? reference.value.text : row.draft.pendingReferenceText
    if (typeof referenceText === 'string' && referenceText) row.draft.history = [...history.filter(entry => entry.recordingId !== value.assessment.recordingId),
      { attemptId: value.assessment.attemptId, recordingId: value.assessment.recordingId, referenceId: value.assessment.referenceId, referenceText }].slice(-2)
    for (const event of acousticEvents(value, row.id, timestamp)) if (!outbox.some(item => item.id === event.id)) outbox.push(event)
    try { await flush() } catch { problem.value = 'Assessment is safely on the server. Its local evidence is pending; retry saving.' }
  }
  watch([scope, ...(materialId ? [materialId] : [])], () => { if (scope.value) void load() }, { immediate: true })
  onBeforeUnmount(() => { stopped = true; version++; removeInvalidation?.(); session?.dispose(); controller?.abort() })
  return { reference, savedAudioId, savedReferenceId, pendingAttempt, recoveredResults, active, loading, problem, recorded, persistAttempt, evaluated,
    disabled: computed(() => loading.value || !!problem.value), retry: load }
}
