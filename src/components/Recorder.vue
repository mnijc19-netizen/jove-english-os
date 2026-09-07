<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { useApp } from "../stores/app";
import { db } from "../db/db";
import type { AudioAsset } from "../domain/types";
import { AudioError, startRecording } from "../audio/recorder";
import { attachRecording, recordingDrafts, retainRecording, saveRecording } from "../audio/recovery";
import { registerRecorderShortcut } from "../audio/shortcuts";
import { useRequest } from "../composables/useRequest";
import Icon from "./Icon.vue";
const props = defineProps<{ label?: string; savedAudioId?: string; disabled?: boolean }>();
const emit = defineEmits<{
  recorded: [data: { audioId: string; duration: number }];
  transcribed: [text: string];
  active: [value: boolean];
}>();
const app = useApp();
const root = ref<HTMLElement>(), recording = ref(false), starting = ref(false), saving = ref(false);
const audioId = ref(""), seconds = ref(0), statusError = ref(""), playback = ref(""), transcript = ref("");
const savedAsset = shallowRef<AudioAsset>();
const transcribing = ref(false);
const { busy, error, run, cancel } = useRequest();
// A draft survives a component remount on this route, including a failed background save.
const scope = (typeof location === "undefined" ? "" : location.hash) + "|" + (props.label || "Speaking practice");
const pending = computed(() => [...recordingDrafts.values()].find(draft => draft.scope === scope));
const existing = computed(() => savedAsset.value?.id === audioId.value ? savedAsset.value : app.audio.find(asset => asset.id === audioId.value));
const playable = computed(() => pending.value?.asset ?? existing.value);
const active = computed(() => starting.value || recording.value || saving.value || Boolean(pending.value) || transcribing.value);
const locked = computed(() => props.disabled || busy.value || transcribing.value || starting.value || saving.value || Boolean(pending.value));
// Parent finish/mode guards must engage before the first await, without handoff gaps.
watch(active, value => emit("active", value), { immediate: true, flush: "sync" });
let handle: Awaited<ReturnType<typeof startRecording>> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let stopping: Promise<void> | undefined, disposed = false;
let unregisterShortcut: (() => void) | undefined;

class AudioCapacityError extends Error {
  constructor() { super("The configured audio storage limit would be exceeded. Increase the audio limit in Settings to save more audio."); }
}
function checkCapacity(assets: AudioAsset[], incomingBytes: number, replacingId?: string): void {
  const limit = app.settings.audioLimitMB * 1024 * 1024;
  const used = assets.reduce((bytes, asset) => bytes + (asset.id === replacingId ? 0 : asset.blob.size), 0);
  if (!Number.isFinite(limit) || limit <= 0 || used + incomingBytes > limit) throw new AudioCapacityError();
}

watch(() => props.savedAudioId, value => {
  if (recording.value || starting.value || saving.value || pending.value) return;
  cancel();
  audioId.value = value || "";
  savedAsset.value = undefined;
  transcript.value = "";
}, { immediate: true });
watch(playable, asset => {
  const old = playback.value;
  playback.value = asset ? URL.createObjectURL(asset.blob) : "";
  if (old) URL.revokeObjectURL(old);
}, { immediate: true });

async function savePending(): Promise<boolean> {
  const draft = pending.value;
  if (!draft) return true;
  saving.value = true;
  statusError.value = "";
  try {
    await saveRecording(draft, asset => db.transaction("rw", db.audio, async () => {
      // Count persisted recordings, imports and generated audio in the same write transaction.
      // Overlapping saves cannot both spend the same remaining capacity.
      checkCapacity(await db.audio.toArray(), asset.blob.size, asset.id);
      return db.audio.put(asset);
    }));
    if (!disposed && recordingDrafts.has(draft.asset.id)) {
      savedAsset.value = draft.asset;
      audioId.value = draft.asset.id;
      emit("recorded", { audioId: draft.asset.id, duration: draft.asset.duration });
      attachRecording(draft);
    }
    try { await app.refresh(); }
    catch { statusError.value = "Recording saved. The library could not refresh yet; your audio remains available."; }
    return true;
  } catch (failure) {
    statusError.value = (failure instanceof AudioCapacityError ? failure.message + " " : "Recording has not been saved. ")
      + "Your audio is retained here: retry saving or download it before closing this tab.";
    return false;
  } finally { saving.value = false; }
}

async function start(): Promise<void> {
  if (locked.value || recording.value || disposed) return;
  starting.value = true;
  statusError.value = "";
  try {
    try {
      // Recording size is unknown until capture ends; require some room before opening the mic.
      checkCapacity(await db.audio.toArray(), 1);
    } catch (failure) {
      statusError.value = failure instanceof AudioCapacityError ? failure.message
        : "Audio storage could not be checked. Retry before recording; your existing audio is unchanged.";
      return;
    }
    if (disposed || props.disabled) return;
    handle = await startRecording();
    recording.value = true;
    seconds.value = 0;
    if (disposed) { await stop(); return; }
    timer = setInterval(() => {
      seconds.value++;
      if (seconds.value >= 180) void stop();
    }, 1000);
  } catch (failure) {
    statusError.value = failure instanceof AudioError ? failure.message : "Microphone unavailable. Allow microphone access, or keep your typed response.";
  } finally { starting.value = false; }
}

function stop(): Promise<void> {
  if (stopping) return stopping;
  const capture = handle;
  if (!capture) return Promise.resolve();
  handle = undefined;
  clearInterval(timer);
  saving.value = true;
  recording.value = false;
  stopping = (async () => {
    try {
      const data = await capture.stop();
      retainRecording(scope, data, props.label || "Speaking practice");
      await savePending();
    } catch (failure) {
      if (failure instanceof AudioError && failure.recovery) {
        retainRecording(scope, failure.recovery, (props.label || "Speaking practice") + " · recovered partial audio");
        const saved = await savePending();
        if (saved) statusError.value = "Capture stopped early. The available audio was retained; replay it before using it.";
      } else statusError.value = failure instanceof AudioError ? failure.message : "Capture could not finish. Your previous recording and text are unchanged.";
    } finally { stopping = undefined; saving.value = false; }
  })();
  return stopping;
}

async function transcribe(): Promise<void> {
  if (locked.value || recording.value || !existing.value || disposed) return;
  const id = existing.value.id;
  transcribing.value = true;
  try {
    const result = await run(async signal => {
      // Read back the successfully committed original; an in-memory draft never goes to STT.
      const stored = await db.audio.get(id);
      if (!stored) throw new Error("Save this recording successfully before transcribing it.");
      if (signal.aborted || props.disabled) return undefined;
      return app.provider.transcribe(stored.blob, signal);
    });
    if (result === undefined || disposed || id !== audioId.value) return;
    transcript.value = result;
    emit("transcribed", result);
    try { await db.audio.update(id, { processed: true }); await app.refresh(); }
    catch { statusError.value = "The transcript is ready below. Its recording status could not be updated; your original audio is still retained."; }
  } finally { transcribing.value = false; }
}

function toggle() { return recording.value ? stop() : start(); }
function beforeUnload(event: BeforeUnloadEvent) {
  if (recording.value || saving.value || (pending.value && !pending.value.saved)) {
    event.preventDefault(); event.returnValue = "";
  }
}
function salvage() { void stop(); }
onMounted(() => {
  unregisterShortcut = registerRecorderShortcut({ element: () => root.value, enabled: () => recording.value || !locked.value, recording: () => recording.value, toggle: () => { void toggle(); } });
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("pagehide", salvage);
});
onBeforeRouteLeave(async () => {
  cancel();
  if (handle || stopping) await stop();
  else if (pending.value) await savePending();
  return !pending.value || pending.value.saved;
});
onBeforeUnmount(() => {
  disposed = true;
  clearInterval(timer);
  unregisterShortcut?.();
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("pagehide", salvage);
  // Async teardown cannot block a forced unmount. The retained draft outlives this component.
  if (handle) void stop();
  if (playback.value) URL.revokeObjectURL(playback.value);
});
defineExpose({ toggle });
</script>
<template>
  <div ref="root" class="recorder">
    <div class="record-controls">
      <button class="record-button" :class="{ recording }" :disabled="locked && !recording" aria-keyshortcuts="R" @click="toggle">
        <Icon :name="recording ? 'pause' : 'speak'" />{{ starting ? "Waiting for microphone…" : saving ? "Saving recording…" : recording ? "Stop & save" : existing ? "Record again" : "Record response" }}
      </button>
      <span v-if="recording" class="record-status" role="status"><i></i>{{ seconds }}s / 180s</span>
      <small v-else class="muted">{{ label || "Speak naturally. R starts or stops recording outside text fields." }}</small>
    </div>
    <audio v-if="playback" :src="playback" controls class="recording-playback" :aria-label="pending && !pending.saved ? 'Your unsaved recording' : 'Your saved recording'"></audio>
    <div v-if="pending" class="row wrap">
      <span role="status">{{ pending.saved ? "Recovered recording saved on this device" : "Recording retained in this tab; not yet saved" }}</span>
      <button class="text-button" :disabled="saving" @click="savePending">{{ pending.saved ? "Use recovered recording" : "Retry saving recording" }}</button>
      <a v-if="playback" class="text-button" :href="playback" :download="'recording-' + pending.asset.id + '.' + (pending.asset.mimeType.includes('mp4') ? 'm4a' : pending.asset.mimeType.includes('ogg') ? 'ogg' : pending.asset.mimeType.includes('wav') ? 'wav' : 'webm')">Download recording</a>
    </div>
    <div v-if="existing && !pending" class="row wrap">
      <span class="pill"><Icon name="check" :size="14" />Saved on this device</span>
      <button class="text-button" :disabled="locked || recording || !app.keySet || !app.online" @click="transcribe">{{ transcribing ? "Transcribing…" : "Transcribe recording" }}</button>
      <button v-if="busy" class="text-button" @click="cancel">Cancel</button>
    </div>
    <p v-if="existing && !app.keySet" class="help-text">Your recording is saved. <RouterLink to="/settings">Connect AI in Settings</RouterLink> for transcription and feedback, or type your response.</p>
    <p v-if="transcript" class="help-text" aria-live="polite">Transcript: {{ transcript }}</p>
    <p v-if="statusError || error" class="error" role="alert">{{ statusError || error }}</p>
    <button v-if="error && !busy && !pending" class="text-button" :disabled="locked || recording || !app.keySet || !app.online" @click="transcribe">Retry transcription</button>
  </div>
</template>
