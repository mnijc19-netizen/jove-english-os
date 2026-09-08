<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import Icon from "./Icon.vue";
import { pauseSpeech, resumeSpeech, speakLocalText, stopSpeech } from "../audio/speech";
import { speechCacheId, speechIdentity } from "../audio/cache";
import { useRequest } from "../composables/useRequest";
import { useApp } from "../stores/app";
import { db } from "../db/db";
import { updateAudioMetadata } from "../db/audio";
const props = defineProps<{ src?: string; text?: string; label?: string; compact?: boolean; synthetic?: boolean; startSeconds?: number; endSeconds?: number }>();
const emit = defineEmits<{ played: []; ended: [] }>();
const app = useApp();
const generated = ref(""), generatedId = ref(""), generatedBlob = shallowRef<Blob>();
const { busy: loading, error: requestError, run, cancel } = useRequest();
const player = ref<HTMLAudioElement>(), playing = ref(false), rate = ref(1), time = ref(0), duration = ref(0), error = ref("");
const measuredDuration = ref(0)
const localActive = ref(false), localPaused = ref(false), localStarting = ref(false);
let operation = 0, disposed = false, mediaStarted = false;
let rangeEligible = false, buffering = false;
let boundaryTimer: ReturnType<typeof setTimeout> | undefined
const ranged = computed(() => props.startSeconds !== undefined || props.endSeconds !== undefined)
const rangeStart = computed(() => props.startSeconds ?? 0)
const rangeEnd = computed(() => props.endSeconds ?? measuredDuration.value)
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
      const media = player.value
      if (ranged.value && media.readyState < 1) await new Promise<void>((resolve, reject) => {
        const ready = () => { cleanup(); resolve() }
        const failed = () => { cleanup(); reject(new Error('Audio metadata unavailable')) }
        const timer = setTimeout(failed, 15000)
        const cleanup = () => { clearTimeout(timer); media.removeEventListener('loadedmetadata', ready); media.removeEventListener('error', failed) }
        media.addEventListener('loadedmetadata', ready, { once: true }); media.addEventListener('error', failed, { once: true })
      })
      if (token !== operation || disposed) return
      if (ranged.value) {
        if (!validRange()) throw new Error('Audio range does not match the saved source')
        if (media.currentTime < rangeStart.value || media.currentTime >= rangeEnd.value - 0.01) media.currentTime = rangeStart.value
      }
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
  clearTimeout(boundaryTimer)
  operation++;
  mediaStarted = false;
  rangeEligible = false; buffering = false;
  cancel();
  player.value?.pause();
  if (localActive.value) stopSpeech();
  localActive.value = false; localStarting.value = false; localPaused.value = false;
  playing.value = false;
}
function mediaPlayed(): void {
  if (disposed) return;
  if (ranged.value && Math.abs((player.value?.currentTime ?? 0) - rangeStart.value) <= 0.05) rangeEligible = true
  buffering = false
  mediaStarted = true; playing.value = true; emit("played");
  armBoundary()
}
function mediaPaused(): void { playing.value = false; clearTimeout(boundaryTimer) }
function mediaEnded(nativeEnd = false): void {
  const effectiveEnd = nativeEnd ? Math.min(rangeEnd.value, player.value?.duration ?? rangeEnd.value) : rangeEnd.value
  const observed = mediaStarted && !disposed && !localActive.value && (!ranged.value || (rangeEligible && validRange() && !buffering
    && !player.value?.seeking && (player.value?.currentTime ?? 0) >= effectiveEnd))
  mediaStarted = false; playing.value = false;
  if (observed) emit("ended");
  clearTimeout(boundaryTimer)
}
function validRange(): boolean {
  return Number.isFinite(rangeStart.value) && Number.isFinite(rangeEnd.value) && rangeStart.value >= 0
    && rangeEnd.value > rangeStart.value && Number.isFinite(player.value?.duration) && rangeEnd.value <= player.value!.duration + 0.05
}
function armBoundary(): void {
  clearTimeout(boundaryTimer)
  if (!ranged.value || !playing.value || !player.value || buffering || player.value.seeking || !validRange()) return
  boundaryTimer = setTimeout(() => {
    if (!player.value || !playing.value || buffering || player.value.seeking) return
    // Wall time is only a wake-up hint. Never advance media time or award a play
    // because a buffer/seek took as long as the reviewed recording.
    mediaTime()
    if (playing.value) armBoundary()
  }, Math.max(25, Math.min(250, (rangeEnd.value - player.value.currentTime) / player.value.playbackRate * 1000)))
}
function mediaTime(): void {
  const media = player.value
  if (!media) return
  if (ranged.value && validRange()) {
    if (media.currentTime < rangeStart.value) media.currentTime = rangeStart.value
    if (media.currentTime >= rangeEnd.value) {
      const audible = playing.value && !buffering && !media.seeking
      media.pause(); time.value = duration.value;
      if (audible) mediaEnded()
      return
    }
  }
  time.value = Math.max(0, media.currentTime - rangeStart.value)
}
function seek(event: Event): void {
  if (!player.value) return
  if (ranged.value) rangeEligible = false
  player.value.currentTime = rangeStart.value + Math.max(0, Math.min(duration.value, Number((event.target as HTMLInputElement).value)))
  mediaSeeked()
}
function mediaWaiting(): void { buffering = true; clearTimeout(boundaryTimer) }
function mediaPlaying(): void { buffering = false; armBoundary() }
function mediaSeeking(): void {
  if (ranged.value && (player.value?.currentTime ?? 0) > rangeStart.value + 0.05) rangeEligible = false
  mediaWaiting()
}
function mediaSeeked(): void {
  buffering = false
  const media = player.value
  if (!media) return
  time.value = Math.max(0, Math.min(duration.value, media.currentTime - rangeStart.value))
  if (ranged.value && media.currentTime >= rangeEnd.value) {
    rangeEligible = false; media.pause(); clearTimeout(boundaryTimer); return
  }
  armBoundary()
}
function visibilityChanged(): void { if (document.visibilityState === 'hidden' && ranged.value) stop() }
document.addEventListener('visibilitychange', visibilityChanged)
function reset(): void {
  stop();
  if (generated.value) URL.revokeObjectURL(generated.value);
  generated.value = ""; generatedId.value = ""; generatedBlob.value = undefined;
  time.value = 0; duration.value = 0; error.value = ""; requestError.value = "";
}
async function loadedMetadata(): Promise<void> {
  const measured = player.value?.duration;
  if (measured === undefined || !Number.isFinite(measured) || measured <= 0) return;
  measuredDuration.value = measured
  if (ranged.value && !validRange()) { error.value = 'This audio does not match its reviewed playback range. Retry downloading the source.'; return }
  duration.value = ranged.value ? rangeEnd.value - rangeStart.value : measured;
  if (ranged.value && player.value) player.value.currentTime = rangeStart.value
  const id = generatedId.value, blob = generatedBlob.value;
  if (!id || !blob) return;
  try {
    const stored = await db.audio.get(id);
    if (stored?.kind === "generated" && stored.blob.size === blob.size && stored.blob.type === blob.type) {
      await updateAudioMetadata(db, id, { duration: measured });
    }
  } catch {
    if (!disposed) error.value = "Audio is available, but its measured duration could not be saved yet.";
  }
}
watch([() => props.src, () => props.text, identity], reset, { flush: "sync" });
watch([() => props.startSeconds, () => props.endSeconds], () => { reset(); void loadedMetadata() }, { flush: 'sync' })
watch(rate, value => { if (player.value) player.value.playbackRate = value; armBoundary() });
onBeforeUnmount(() => { disposed = true; document.removeEventListener('visibilitychange', visibilityChanged); reset(); });
defineExpose({ toggle, stop });
</script>
<template>
  <div class="audio-player" :class="{ compact }">
    <audio
      v-if="source" ref="player" :src="source" preload="metadata"
      @play="mediaPlayed"
      @pause="mediaPaused"
      @ended="mediaEnded(true)"
      @timeupdate="mediaTime"
      @waiting="mediaWaiting"
      @playing="mediaPlaying"
      @seeking="mediaSeeking"
      @seeked="mediaSeeked"
      @ratechange="armBoundary"
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
      @input="seek"
    />
    <small v-if="synthetic || generated || localActive" class="muted">{{ localActive ? "Local device voice · synthetic speech" : "Synthetic speech · listening practice" }}</small>
    <p v-if="error || requestError" class="error" role="alert">{{ error || requestError }}</p>
    <div v-if="showFallback" class="row wrap">
      <button class="text-button" :disabled="localActive" @click="useLocalVoice">Play with a local device voice</button>
      <small class="muted">Optional synthetic fallback. Uses only an installed local English voice; no text is sent to a browser voice service.</small>
    </div>
  </div>
</template>
