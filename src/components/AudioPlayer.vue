<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import Icon from "./Icon.vue";
import { pauseSpeech, resumeSpeech, speakLocalText, stopSpeech } from "../audio/speech";
import { speechCacheId, speechIdentity } from "../audio/cache";
import { useRequest } from "../composables/useRequest";
import { useApp } from "../stores/app";
import { db } from "../db/db";
const props = defineProps<{ src?: string; text?: string; label?: string; compact?: boolean; synthetic?: boolean }>();
const emit = defineEmits<{ played: []; ended: [] }>();
const app = useApp();
const generated = ref(""), generatedId = ref(""), generatedBlob = shallowRef<Blob>();
const { busy: loading, error: requestError, run, cancel } = useRequest();
const player = ref<HTMLAudioElement>(), playing = ref(false), rate = ref(1), time = ref(0), duration = ref(0), error = ref("");
const localActive = ref(false), localPaused = ref(false), localStarting = ref(false);
let operation = 0, disposed = false, mediaStarted = false;
const identity = computed(() => speechIdentity(props.text || "", app.settings));
const source = computed(() => {
  if (generated.value) return generated.value;
  if (!props.src) return "";
  if (/^(blob:|https?:\/\/)/.test(props.src)) return props.src;
  if (/^[a-z][a-z\d+.-]*:/i.test(props.src)) return "";
  return import.meta.env.BASE_URL + props.src.replace(/^\//, "");
});
const showFallback = computed(() => Boolean(props.text && (error.value || requestError.value || (!source.value && (!app.keySet || !app.online)))));
const fmt = (n: number) => Math.floor(n / 60) + ":" + String(Math.floor(n % 60)).padStart(2, "0");

async function toggle(): Promise<void> {
  if (loading.value || localStarting.value || disposed) return;
  if (localActive.value) {
    if (localPaused.value) { resumeSpeech(); localPaused.value = false; playing.value = true; }
    else { pauseSpeech(); localPaused.value = true; playing.value = false; }
    return;
  }
  if (playing.value) { player.value?.pause(); return; }
  error.value = "";
  const token = ++operation;
  try {
    if (!source.value && props.text) {
      const text = props.text, snapshot = identity.value;
      const result = await run(async signal => {
        const id = await speechCacheId(snapshot);
        if (signal.aborted || snapshot !== identity.value) return undefined;
        const blob = await app.generatedSpeech(text, signal);
        return { id, blob };
      });
      if (!result || token !== operation || snapshot !== identity.value || disposed) return;
      generatedBlob.value = result.blob;
      generatedId.value = result.id;
      generated.value = URL.createObjectURL(result.blob);
      await nextTick();
    }
    if (token !== operation || disposed) return;
    if (source.value && player.value) {
      player.value.playbackRate = rate.value;
      await player.value.play();
    } else error.value = "No saved audio is available. Choose a local device voice below, or configure speech in Settings.";
  } catch {
    if (token !== operation || disposed) return;
    playing.value = false;
    error.value = "Audio could not play. Retry, or explicitly choose a local device voice below.";
  }
}

async function useLocalVoice(): Promise<void> {
  if (!props.text || disposed) return;
  stop();
  error.value = ""; requestError.value = "";
  const token = operation;
  localActive.value = true; localStarting.value = true;
  try {
    await speakLocalText(props.text, rate.value, {
      onStart: () => {
        if (token !== operation || disposed) return;
        localStarting.value = false; playing.value = true; emit("played");
      },
      onEnd: () => {
        if (token !== operation || disposed) return;
        playing.value = false; emit("ended");
      },
    });
  } catch (failure) {
    if (token === operation && !disposed) error.value = failure instanceof Error ? failure.message : "A local device voice could not play.";
  } finally {
    if (token === operation) { localStarting.value = false; localActive.value = false; localPaused.value = false; playing.value = false; }
  }
}

function stop(): void {
  operation++;
  mediaStarted = false;
  cancel();
  player.value?.pause();
  if (localActive.value) stopSpeech();
  localActive.value = false; localStarting.value = false; localPaused.value = false;
  playing.value = false;
}
function mediaPlayed(): void {
  if (disposed) return;
  mediaStarted = true; playing.value = true; emit("played");
}
function mediaEnded(): void {
  if (!mediaStarted || disposed || localActive.value) return;
  mediaStarted = false; playing.value = false; emit("ended");
}
function reset(): void {
  stop();
  if (generated.value) URL.revokeObjectURL(generated.value);
  generated.value = ""; generatedId.value = ""; generatedBlob.value = undefined;
  time.value = 0; duration.value = 0; error.value = ""; requestError.value = "";
}
async function loadedMetadata(): Promise<void> {
  const measured = player.value?.duration;
  if (measured === undefined || !Number.isFinite(measured) || measured <= 0) return;
  duration.value = measured;
  const id = generatedId.value, blob = generatedBlob.value;
  if (!id || !blob) return;
  try {
    const stored = await db.audio.get(id);
    if (stored?.kind === "generated" && stored.blob.size === blob.size && stored.blob.type === blob.type) {
      await db.audio.update(id, { duration: measured });
    }
  } catch {
    if (!disposed) error.value = "Audio is available, but its measured duration could not be saved yet.";
  }
}
watch([() => props.src, () => props.text, identity], reset, { flush: "sync" });
watch(rate, value => { if (player.value) player.value.playbackRate = value; });
onBeforeUnmount(() => { disposed = true; reset(); });
defineExpose({ toggle, stop });
</script>
<template>
  <div class="audio-player" :class="{ compact }">
    <audio
      v-if="source" ref="player" :src="source" preload="metadata"
      @play="mediaPlayed"
      @pause="playing = false"
      @ended="mediaEnded"
      @timeupdate="time = player?.currentTime || 0"
      @loadedmetadata="loadedMetadata"
      @error="playing = false; error = 'This audio is unavailable. Your text is unchanged. Retry or choose a local device voice below.'"
    ></audio>
    <div class="audio-wave" :class="{ playing }" aria-hidden="true">
      <span v-for="n in 40" :key="n" :style="{ height: 10 + ((n * 17 + n * n) % 45) + 'px', animationDelay: (n % 7) * 0.13 + 's' }"></span>
    </div>
    <p v-if="label" class="audio-label">{{ label }}</p>
    <div class="player-controls">
      <span class="time-display">{{ fmt(time) }} <span>/ {{ duration ? fmt(duration) : "—" }}</span></span>
      <button class="play-button" :disabled="loading || localStarting" :aria-label="loading || localStarting ? 'Preparing audio' : playing ? 'Pause audio' : 'Play audio'" @click="toggle">
        <Icon :name="playing ? 'pause' : 'play'" :size="24" />
      </button>
      <button class="speed-button" :disabled="localActive" aria-label="Change playback speed" @click="rate = rate === 1 ? 0.85 : 1">{{ rate }}×</button>
      <button v-if="loading || localStarting" class="text-button" @click="stop">Cancel audio</button>
    </div>
    <input
      v-if="duration && !localActive" class="audio-seek" type="range" aria-label="Audio position" min="0" :max="duration" :value="time" step="0.1"
      @input="player && (player.currentTime = Number(($event.target as HTMLInputElement).value))"
    />
    <small v-if="synthetic || generated || localActive" class="muted">{{ localActive ? "Local device voice · synthetic speech" : "Synthetic speech · listening practice" }}</small>
    <p v-if="error || requestError" class="error" role="alert">{{ error || requestError }}</p>
    <div v-if="showFallback" class="row wrap">
      <button class="text-button" :disabled="localActive" @click="useLocalVoice">Play with a local device voice</button>
      <small class="muted">Optional synthetic fallback. Uses only an installed local English voice; no text is sent to a browser voice service.</small>
    </div>
  </div>
</template>
