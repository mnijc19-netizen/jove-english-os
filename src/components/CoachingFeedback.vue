<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Evaluation } from '../domain/types'

const props = defineProps<{ evaluation: Evaluation; answer: string; language: 'en' | 'ja' }>()
const shown = ref(false)
const correction = computed(() => props.evaluation.errors[0])
// Only quote a fragment actually present in the saved learner answer. AI may
// otherwise put a correction in any field, including "original" or "hint".
const original = computed(() => correction.value && props.answer.includes(correction.value.original) ? correction.value.original : '')
watch(() => JSON.stringify([props.evaluation, props.answer, props.language]), () => { shown.value = false }, { flush: 'sync' })
</script>

<template>
  <section class="coaching-feedback" aria-label="已保存的文字反馈">
    <template v-if="correction">
      <p>先回想自己的回答，尝试调整一处，再完整重说；需要帮助时随时查看参考，不必硬猜。</p>
      <blockquote v-if="original" :lang="language">{{ original }}</blockquote>
    </template>
    <p v-else>文字反馈已保存，可以查看后继续练习。</p>
    <button class="text-button" :aria-expanded="shown" @click="shown = !shown">{{ shown ? '收起文字反馈' : '查看 AI 提示与参考表达' }}</button>
    <div v-if="shown" class="coaching-details">
      <p class="help-text">这里只分析已保存文字，不代表发音、听力或真实沟通结果；参考表达不是唯一答案。</p>
      <p>{{ evaluation.summary }}</p>
      <p v-for="strength in evaluation.strengths" :key="strength" class="success-note">{{ strength }}</p>
      <template v-if="correction">
        <p>{{ correction.hint }}</p>
        <p :lang="language">{{ correction.corrected }}</p>
        <p>{{ correction.explanation }}</p>
      </template>
      <p>{{ evaluation.nextPrompt }}</p>
    </div>
  </section>
</template>

<style scoped>
.coaching-feedback { overflow-wrap: anywhere; }
.coaching-details { margin-top: 12px; }
</style>
