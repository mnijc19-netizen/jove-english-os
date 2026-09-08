<script setup lang="ts">
import { computed } from "vue";
import { useApp } from "../stores/app";
import { useRecordingUrl } from "../composables/useRecordingUrl";
const props = defineProps<{ audioId: string; label?: string }>();
const app = useApp();
const asset = computed(() => app.audio.find((a) => a.id === props.audioId));
const url = useRecordingUrl(asset);
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
