<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useApp } from "../stores/app";
const props = defineProps<{ audioId: string; label?: string }>();
const app = useApp(),
  url = ref("");
const asset = computed(() => app.audio.find((a) => a.id === props.audioId));
watch(
  () => asset.value?.blob,
  (blob) => {
    if (url.value) URL.revokeObjectURL(url.value);
    url.value = blob ? URL.createObjectURL(blob) : "";
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (url.value) URL.revokeObjectURL(url.value);
});
</script>
<template>
  <div v-if="audioId" class="saved-recording">
    <template v-if="url">
      <audio
        :src="url"
        controls
        preload="metadata"
        :aria-label="label || 'Your saved recording'"
        style="width: 100%; max-width: 420px"
      />
      <a
        :href="url"
        :download="
          'jove-recording-' +
          asset?.createdAt +
          (asset?.mimeType.includes('wav')
            ? '.wav'
            : asset?.mimeType.includes('mp4')
              ? '.m4a'
              : '.webm')
        "
        class="text-button"
        >Download recording</a
      >
    </template>
    <p v-else class="help-text">
      Recording metadata is saved, but this device has no audio file. JSON
      backups exclude recordings; keep downloaded originals separately.
    </p>
  </div>
</template>
