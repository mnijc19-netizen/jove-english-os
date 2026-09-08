<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { db } from '../db/db'
import Recorder from './Recorder.vue'
import SavedRecording from './SavedRecording.vue'
import { pronunciationReferenceReady, speechBrowserClient } from '../speech/client'
import type { EvaluatedPronunciation, PronunciationAttempt, PronunciationReference } from '../speech/client'
import { compareAcousticAttempts } from '../speech/feedback'
import { recordingToAssessmentWav } from '../speech/wav'
import { SpeechError } from '../speech/types'

const props = defineProps<{
  reference: PronunciationReference | null
  savedAudioId?: string
  savedReferenceId?: string
  pendingAttempt?: PronunciationAttempt
  /** Parent must finish durable draft/outbox persistence before a paid request. */
  persistAttempt?: (attempt: PronunciationAttempt) => Promise<void>
  recoveredResults?: EvaluatedPronunciation[]
  disabled?: boolean
}>()
const emit = defineEmits<{
  recorded: [data: { audioId: string; duration: number; referenceId: string }]
  pending: [attempt: PronunciationAttempt]
  evaluated: [result: EvaluatedPronunciation]
  active: [value: boolean]
}>()
const recordingId = ref('')
const detachedRecordingId = ref('')
const recordingReferences = new Map<string, string>()
const recorderActive = ref(false), busy = ref(false), problem = ref(''), status = ref('')
const referenceAudioFailed = ref(false)
const referenceAudioSrc = ref(''), referenceAudioLoading = ref(false), referenceAudioProblem = ref(''), audioReload = ref(0), accountChanged = ref(false)
// Saved recordings/history belong to the journal, not to the current reference.
// Keep this shared fence for the whole mounted lifetime, including null/revoked
// references and retries. A new reference must never rebind old private UI.
const presentationReady = ref(false), presentationLoading = ref(false), presentationSession = speechBrowserClient.session()
let referenceSession: ReturnType<typeof speechBrowserClient.session> | undefined
const newServiceAttempt = ref(false)
const attempts = shallowRef<EvaluatedPronunciation[]>([])
let pending: PronunciationAttempt | undefined
let controller: AbortController | undefined
let revision = 0, disposed = false
const ready = computed(() => pronunciationReferenceReady(props.reference))
const referenceIdentity = computed(() => JSON.stringify(props.reference))
const latest = computed(() => attempts.value.at(-1))
const comparison = computed(() => attempts.value.length === 2 ? compareAcousticAttempts(attempts.value[0].assessment, attempts.value[1].assessment) : null)
const alreadyAssessed = computed(() => latest.value?.assessment.recordingId === recordingId.value)
const canAssess = computed(() => presentationReady.value && ready.value && !!referenceAudioSrc.value && !accountChanged.value && recordingReferences.get(recordingId.value) === referenceIdentity.value && !referenceAudioFailed.value && Boolean(recordingId.value) && !busy.value && !recorderActive.value && !props.disabled && !alreadyAssessed.value)
watch(() => busy.value || recorderActive.value, value => emit('active', value), { immediate: true, flush: 'sync' })

function cancel(message = 'Assessment cancelled. Your original recording is still saved.'): void {
  revision++; controller?.abort(); controller = undefined
  busy.value = false
  if (!disposed) status.value = message
}
function invalidatePresentation(): void {
  presentationReady.value = false; presentationLoading.value = false; accountChanged.value = true; cancel('')
  recordingId.value = ''; detachedRecordingId.value = ''; recordingReferences.clear()
  attempts.value = []; pending = undefined; problem.value = ''; newServiceAttempt.value = false
  referenceAudioProblem.value = 'The account changed. Sign in to this learning journal and reload the page; recordings remain saved.'
}
presentationSession.signal.addEventListener('abort', invalidatePresentation, { once: true })
if (presentationSession.signal.aborted) invalidatePresentation()
watch(audioReload, (_value, _old, onCleanup) => {
  if (!speechBrowserClient.configured || accountChanged.value) return
  let live = true
  onCleanup(() => { live = false })
  presentationLoading.value = true
  void (async () => {
    try {
      await presentationSession.assertCurrent()
      if (live && !disposed && !accountChanged.value && presentationSession.isCurrent()) presentationReady.value = true
    } catch (cause) {
      if (!live || disposed || accountChanged.value) return
      if (cause instanceof SpeechError && cause.code === 'AUTH') invalidatePresentation()
      else {
        presentationReady.value = false
        referenceAudioProblem.value = 'The reviewed audio could not be verified or loaded. Account access could not be checked; retry without deleting your recordings.'
      }
    } finally { if (live) presentationLoading.value = false }
  })()
}, { immediate: true, flush: 'sync' })
// Vue batches these props before this watcher runs. Never bind a bare/late audio ID to
// whichever reference happens to be current, or observe intermediate prop ordering.
watch([referenceIdentity, () => props.savedAudioId, () => props.savedReferenceId, () => props.pendingAttempt?.recordingId, () => props.pendingAttempt?.referenceId], ([identity, id], previous) => {
  if (accountChanged.value) return
  const referenceChanged = previous[0] !== undefined && previous[0] !== identity
  if (referenceChanged) {
    detachedRecordingId.value = recordingId.value || detachedRecordingId.value
    cancel(''); attempts.value = []; pending = undefined; problem.value = ''; newServiceAttempt.value = false; referenceAudioFailed.value = false; recordingId.value = ''
  }
  // A pending-ID persistence update must not reselect an older parent audio prop.
  if (!referenceChanged && previous[1] === id && recordingId.value && recordingId.value !== id) return
  if (!id) { if (previous[1] && recordingId.value) { cancel(''); recordingId.value = ''; pending = undefined }; return }
  const knownReference = recordingReferences.get(id)
  const declaredReference = props.savedReferenceId === props.reference?.id || (props.pendingAttempt?.recordingId === id && props.pendingAttempt.referenceId === props.reference?.id)
  if (!props.reference || (knownReference ? knownReference !== identity : !declaredReference)) {
    detachedRecordingId.value = id
    if (recordingId.value === id) { cancel(''); recordingId.value = '' }
    return
  }
  recordingReferences.set(id, identity)
  if (recordingId.value !== id) { cancel(''); recordingId.value = id; pending = undefined; problem.value = '' }
}, { immediate: true })
watch([() => props.recoveredResults, referenceIdentity, () => props.savedReferenceId, accountChanged], () => {
  if (accountChanged.value) { attempts.value = []; return }
  if (!props.recoveredResults) return
  // A replacement reference does not revoke access to the saved reference's historical A/B.
  const target = props.savedReferenceId || props.reference?.id
  attempts.value = props.recoveredResults.filter(result => result.assessment.referenceId === target).slice(-2)
}, { immediate: true })
watch([referenceIdentity, audioReload], (_value, _old, onCleanup) => {
  let live = true, ownedUrl = ''
  const selected = props.reference, gate = speechBrowserClient.session()
  referenceSession = gate; referenceAudioSrc.value = ''
  if (!accountChanged.value) referenceAudioProblem.value = ''
  referenceAudioLoading.value = ready.value && speechBrowserClient.configured
  const releaseUrl = () => { if (ownedUrl) URL.revokeObjectURL(ownedUrl); ownedUrl = ''; referenceAudioSrc.value = '' }
  const invalidated = () => {
    if (!live) return
    releaseUrl(); invalidatePresentation(); referenceAudioLoading.value = false
  }
  gate.signal.addEventListener('abort', invalidated, { once: true })
  presentationSession.signal.addEventListener('abort', invalidated, { once: true })
  onCleanup(() => { live = false; gate.signal.removeEventListener('abort', invalidated); presentationSession.signal.removeEventListener('abort', invalidated); gate.dispose(); releaseUrl(); if (referenceSession === gate) referenceSession = undefined })
  if (!speechBrowserClient.configured || accountChanged.value) { referenceAudioLoading.value = false; return }
  void (async () => {
    try {
      await gate.assertCurrent()
      if (!live || accountChanged.value || !gate.isCurrent() || !selected || !pronunciationReferenceReady(selected)) return
      const blob = await speechBrowserClient.referenceAudio(selected, gate.signal)
      await gate.assertCurrent()
      if (!live || accountChanged.value || !gate.isCurrent()) return
      ownedUrl = URL.createObjectURL(blob); referenceAudioSrc.value = ownedUrl; referenceAudioFailed.value = false
    } catch (cause) {
      if (live && cause instanceof SpeechError && cause.code === 'AUTH') invalidated()
      else if (live && !accountChanged.value) referenceAudioProblem.value = cause instanceof SpeechError && cause.code === 'REFERENCE'
        ? new SpeechError('REFERENCE').message : 'The reviewed audio could not be verified or loaded. Retry without deleting your recordings.'
    } finally { if (live) referenceAudioLoading.value = false }
  })()
}, { immediate: true, flush: 'sync' })
watch(() => props.disabled, disabled => { if (disabled && busy.value) cancel() }, { flush: 'sync' })
function recorded(data: { audioId: string; duration: number }): void {
  if (!props.reference || !ready.value || disposed || accountChanged.value || !presentationReady.value) return
  cancel('Original recording saved. Listen back, then analyze when ready.')
  recordingReferences.set(data.audioId, referenceIdentity.value)
  recordingId.value = data.audioId; pending = undefined; problem.value = ''; newServiceAttempt.value = false
  emit('recorded', { ...data, referenceId: props.reference.id })
}
async function assess(): Promise<void> {
  if (!canAssess.value || !props.reference || disposed) return
  const reference = props.reference, originalId = recordingId.value, referenceKey = referenceIdentity.value
  const gate = referenceSession
  if (!gate?.isCurrent()) return
  const currentRevision = ++revision
  const current = new AbortController(); controller = current; busy.value = true; problem.value = ''; status.value = 'Checking saved recording…'
  const ownsRequest = () => !disposed && revision === currentRevision && controller === current
  const stillCurrent = () => ownsRequest() && gate.isCurrent() && !current.signal.aborted && referenceIdentity.value === referenceKey && recordingId.value === originalId && !props.disabled
  try {
    await gate.assertCurrent()
    if (!stillCurrent()) return
    const original = await db.audio.get(originalId)
    if (!stillCurrent()) return
    if (!original || original.id !== originalId || original.kind !== 'recording' || !(original.blob instanceof Blob) || !original.blob.size) {
      problem.value = 'The original audio is not saved on this device yet. Finish saving or recover the recording before analysis.'
      status.value = ''
      return
    }
    if (!speechBrowserClient.configured) { problem.value = 'Pronunciation service is not connected yet. Your original recording stays saved.'; status.value = ''; return }
    status.value = 'Preparing your saved recording…'
    const audioWav = await recordingToAssessmentWav(original.blob, current.signal)
    if (!stillCurrent()) return
    const restored = props.pendingAttempt
    if (!pending || pending.recordingId !== originalId || pending.referenceId !== reference.id) {
      pending = { attemptId: restored?.recordingId === originalId && restored.referenceId === reference.id ? restored.attemptId : crypto.randomUUID(), recordingId: originalId, referenceId: reference.id }
    }
    emit('pending', { ...pending })
    await props.persistAttempt?.({ ...pending })
    if (!stillCurrent()) return
    status.value = 'Analyzing this recording…'
    const result = await speechBrowserClient.assess({ ...pending, referenceText: reference.text, audioWav }, current.signal)
    await gate.assertCurrent()
    if (!stillCurrent()) return
    if (!result.ok) { problem.value = result.error.message; newServiceAttempt.value = result.retryAsNewAttempt === true; status.value = 'Original recording retained. Checking this same attempt will not intentionally start another service call.'; return }
    newServiceAttempt.value = false
    attempts.value = [...attempts.value.filter(a => a.assessment.recordingId !== originalId), result].slice(-2)
    status.value = 'Assessment ready. Listen back, then retry the whole sentence.'
    emit('evaluated', result)
  } catch (cause) {
    if (stillCurrent()) { problem.value = cause instanceof SpeechError ? cause.message : 'Could not prepare the saved recording. Your original remains available; retry when ready.'; status.value = '' }
  } finally {
    if (ownsRequest()) { busy.value = false; controller = undefined }
  }
}
function startNewServiceAttempt(): void {
  if (!newServiceAttempt.value || !canAssess.value || !props.reference) return
  pending = { attemptId: crypto.randomUUID(), recordingId: recordingId.value, referenceId: props.reference.id }
  newServiceAttempt.value = false
  void assess()
}
function referenceAudioError(): void {
  referenceAudioFailed.value = true
  if (busy.value) cancel()
  problem.value = 'The reference audio could not play. Reload the reference before assessing pronunciation.'
}
onBeforeUnmount(() => { disposed = true; cancel(''); presentationSession.signal.removeEventListener('abort', invalidatePresentation); presentationSession.dispose() })
</script>

<template>
  <section class="panel section pronunciation-practice" aria-label="Pronunciation practice">
    <p class="eyebrow">General American · sentence practice</p>
    <h3>Listen, record, and try again</h3>
    <p v-if="!ready" class="help-text" role="status">A reviewed General American reference with checked audio, transcript, and usage rights is needed before pronunciation practice.</p>
    <p v-if="accountChanged" class="help-text" role="alert">{{ referenceAudioProblem }}</p>
    <p v-if="presentationLoading" class="help-text" role="status">Checking access to your saved practice…</p>
    <p v-if="referenceAudioLoading" class="help-text" role="status">Loading and verifying the reviewed recording…</p>
    <p v-if="!accountChanged && referenceAudioProblem" class="help-text" role="alert">{{ referenceAudioProblem }}</p>
    <button v-if="!accountChanged && (referenceAudioProblem || referenceAudioFailed)" class="text-button" type="button" :disabled="busy || recorderActive || referenceAudioLoading || presentationLoading" @click="audioReload++">Retry reviewed audio</button>
    <template v-if="!accountChanged && reference && presentationReady">
      <p>{{ reference.text }}</p>
      <p class="help-text">{{ reference.voiceReview?.kind === 'synthetic' ? 'Synthetic practice reference' : 'Human speech reference' }} · reviewed en-US</p>
      <audio v-if="referenceAudioSrc" :key="referenceAudioSrc" :src="referenceAudioSrc" controls preload="none" aria-label="Reviewed reference recording" @error="referenceAudioError" @canplay="referenceAudioFailed = false"></audio>
      <p class="help-text">Listen first, then record the complete sentence in 30 seconds or less. Feedback is an estimate for practice, not a calibrated intelligibility score.</p>
    </template>
    <Recorder v-if="presentationReady && !accountChanged" :key="referenceIdentity" :label="'Pronunciation practice · ' + (reference?.id || 'unavailable')" :saved-audio-id="recordingId" :disabled="disabled || busy || !ready || !referenceAudioSrc" @recorded="recorded" @active="recorderActive = $event" />
    <div v-if="presentationReady && !accountChanged && detachedRecordingId && detachedRecordingId !== recordingId" class="section"><p class="help-text">Your earlier recording is still saved. Record the new reference before assessing it.</p><SavedRecording :audio-id="detachedRecordingId" label="Saved earlier reference attempt" /></div>
    <div class="row wrap">
      <button class="button primary" type="button" :disabled="!canAssess" @click="assess">{{ busy ? 'Analyzing…' : problem ? 'Retry saved recording' : 'Analyze recording' }}</button>
      <button v-if="busy" class="text-button" type="button" @click="cancel()">Cancel assessment</button>
      <button v-if="newServiceAttempt" class="button secondary" type="button" :disabled="!canAssess" @click="startNewServiceAttempt">New service attempt · may be billed again</button>
    </div>
    <p v-if="status" class="help-text" role="status" aria-live="polite">{{ status }}</p>
    <p v-if="problem" class="error" role="alert">{{ problem }}</p>
    <div v-if="presentationReady && !accountChanged && latest" class="section" aria-label="Acoustic feedback">
      <h3>{{ alreadyAssessed ? 'Your practice feedback' : 'Previous attempt feedback' }}</h3>
      <p v-if="latest.assessment.referenceId !== reference?.id" class="help-text">Historical feedback for reference {{ latest.assessment.referenceId }}. It does not assess the reference currently available above.</p>
      <ol v-if="latest.assessment.issues.length">
        <li v-for="(issue, index) in latest.assessment.issues" :key="index">
          <span v-if="issue.wordIndex !== null">{{ latest.assessment.words[issue.wordIndex]?.label }}: </span>{{ issue.cue }}
          <details><summary>Assessment evidence</summary><p class="help-text">Azure Speech · {{ issue.kind }} · {{ issue.provenance.value }} (provider estimate)</p><p class="help-text">{{ issue.provenance.path }}</p></details>
        </li>
      </ol>
      <p v-else class="help-text">No priority correction was supported by this response. Listen back and compare; this does not establish mastery.</p>
      <p class="help-text">{{ latest.assessment.scores.prosody === null ? 'Prosody was not assessed in this response.' : 'Rhythm feedback is a provider estimate.' }} Text transcription is not pronunciation evidence.</p>
      <p v-if="ready && latest.assessment.referenceId === reference?.id">Use Record again above, then repeat the whole sentence comfortably.</p>
    </div>
    <div v-if="presentationReady && !accountChanged && comparison?.comparable && attempts.length === 2" class="section" aria-label="Compare attempts">
      <h3>Listen A/B</h3>
      <SavedRecording :audio-id="attempts[0].assessment.recordingId" label="Previous pronunciation attempt" />
      <SavedRecording :audio-id="attempts[1].assessment.recordingId" label="Latest pronunciation attempt" />
      <p class="help-text">Same reference, two recordings. Listen for the targeted change. This prompted retry does not prove spontaneous transfer.</p>
      <details><summary>Provider score changes</summary><ul><li v-for="(delta, dimension) in comparison.deltas" :key="dimension">{{ dimension }}: {{ delta === null ? 'unknown' : (delta > 0 ? '+' : '') + delta }}</li></ul></details>
    </div>
  </section>
</template>

<style scoped>
.pronunciation-practice > audio { width: 100%; max-width: 420px; }
.pronunciation-practice li { margin-block: 0.75rem; }
.pronunciation-practice details { overflow-wrap: anywhere; }
</style>
