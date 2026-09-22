<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { JoveDatabase } from '../db/db'
import { db as english } from '../db/db'
import { createJapaneseCoach } from '../db/japanese-coach'
import { japaneseProvider } from '../ai/workspace-provider'
import { useApp } from '../stores/app'
import { useCloud } from '../stores/cloud'
import { useRequest } from '../composables/useRequest'
import CoachingFeedback from './CoachingFeedback.vue'

const props = defineProps<{ database: JoveDatabase; sessionId: string; audioId: string; reference: string; target: string; checkOwner: () => Promise<void> }>()
const emit = defineEmits<{ active: [value: boolean] }>()
const app = useApp(), cloud = useCloud()
const provider = japaneseProvider({ database: props.database, english, settings: () => app.settings,
  useAccount: () => cloud.configured && app.providerMode !== 'byok', assertCurrent: props.checkOwner })
// A keyed component binds to a single practice; no route-dependent DB/session pointer.
const coach = createJapaneseCoach(props.database, props.sessionId, props.checkOwner, provider)
const draft = shallowRef<Awaited<ReturnType<typeof coach.open>>>(), text = ref(''), confirmed = ref(false), dirty = ref(false), saving = ref(false)
const savedNotice = ref(''), saveError = ref('')
const retainedText = ref('')
const { busy, error, run, cancel } = useRequest()
const selected = computed(() => draft.value?.feedback.find(entry => entry.input === text.value))
const active = computed(() => busy.value || saving.value || dirty.value)
watch(active, value => emit('active', value), { immediate: true, flush: 'sync' })
let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, saves: Promise<void> = Promise.resolve()
function flush(): Promise<void> {
  clearTimeout(timer)
  saves = saves.catch(() => {}).then(async () => {
    if (!dirty.value || !draft.value) return
    const value = text.value, checked = confirmed.value
    saving.value = true; saveError.value = ''
    try {
      draft.value = await coach.save(draft.value.revision, value, checked)
      dirty.value = value !== text.value || checked !== confirmed.value
      savedNotice.value = '回答已保存；AI 未参与评分。'
      if (dirty.value) schedule()
    } catch (failure) { saveError.value = failure instanceof Error ? failure.message : '保存失败，输入仍在此页。'; throw failure }
    finally { saving.value = false }
  })
  return saves
}
function schedule() { clearTimeout(timer); timer = setTimeout(() => { void flush().catch(() => {}) }, 500) }
function changed() { dirty.value = true; schedule() }
async function transcribe() {
  await run(async signal => {
    await flush()
    signal.throwIfAborted()
    if (!draft.value) return
    const stored = await coach.transcribe(draft.value.revision, props.audioId, signal)
    signal.throwIfAborted(); if (disposed) return
    draft.value = stored
    confirmed.value = false
    savedNotice.value = '转写候选已保存。请回放核对，再放入回答；它不是发音评价。'
  })
}
function useTranscript() {
  if (!draft.value?.transcript) return
  text.value = draft.value.transcript; confirmed.value = false; changed()
}
async function feedback() {
  await run(async signal => {
    await flush()
    signal.throwIfAborted()
    if (!draft.value) return
    const stored = await coach.feedback(props.reference, props.target, signal, { revision: draft.value.revision, text: text.value, confirmed: confirmed.value })
    signal.throwIfAborted(); if (disposed) return
    draft.value = stored
    const notices = provider.takeNotices()
    savedNotice.value = notices.some(notice => notice.kind === 'result-cache-unconfirmed')
      ? '已收到反馈，服务端缓存尚未确认。请保留本页；再次点击会先恢复已收到的结果。' : '反馈已保存。先改一个地方，再完整重说。'
    if (notices.some(notice => notice.kind === 'schema-fallback' || notice.kind === 'model-fallback')) savedNotice.value += ' 本次采用了兼容格式或备用模型，原设置未改变。'
  })
}
async function reloadSaved() {
  await run(async signal => {
    clearTimeout(timer); await saves.catch(() => {})
    signal.throwIfAborted()
    const stored = await coach.open()
    signal.throwIfAborted(); if (disposed) return
    if (stored.text !== text.value) retainedText.value = text.value
    draft.value = stored; text.value = stored.text; confirmed.value = stored.confirmed; dirty.value = false; saveError.value = ''
  })
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || saving.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  await run(async signal => { const stored = await coach.open(); signal.throwIfAborted(); if (!disposed) { draft.value = stored; text.value = stored.text; confirmed.value = stored.confirmed } })
})
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); window.removeEventListener('beforeunload', beforeUnload); cancel() })
</script>

<template>
  <section class="ja-coach" aria-labelledby="ja-coach-title">
    <h3 id="ja-coach-title">AI 小教练 · 先独立表达，再改一处</h3>
    <p class="help-text">听力和模仿以真人原声为准。AI 只检查文字，不评发音；不用 AI 也能继续练习。</p>
    <p v-if="!app.keySet" class="help-text">账号 AI 暂未连接；回答照常保存在本机。需要时在设置中登录原学习账号。</p>
    <template v-if="draft">
      <button class="text-button" :disabled="busy || saving || !audioId || !app.online || !app.keySet" @click="transcribe">转写首答录音（可能收费）</button>
      <details v-if="draft.transcript"><summary>已保存的转写候选 · 需核对</summary><p lang="ja">{{ draft.transcript }}</p><button class="text-button" :disabled="busy || saving" @click="useTranscript">放入回答，再核对</button></details>
      <label class="coach-input">写下自己刚才说的日语，或核对转写后修改<textarea v-model="text" lang="ja" rows="3" maxlength="10000" :disabled="busy" @input="confirmed = false; changed()" /></label>
      <label class="row"><input v-model="confirmed" type="checkbox" :disabled="busy" @change="changed">我核对过这段文字；转写错误不当作自己的语言错误</label>
      <div class="row wrap">
        <button class="button secondary" :disabled="busy || saving || !confirmed || !text.trim() || !app.online || !app.keySet" @click="feedback">{{ selected ? '查看已保存的反馈' : '请 AI 帮我改进（可能收费）' }}</button>
        <button v-if="busy" class="text-button" @click="cancel">停止等待，保留回答</button>
      </div>
      <div v-if="selected" class="coach-feedback">
        <CoachingFeedback :evaluation="selected.result" :answer="selected.input" language="ja" />
        <p class="help-text">针对上面保存的回答给出；不要求逐字照抄，意思相同且合适的表达也可以。</p>
      </div>
    </template>
    <p v-if="savedNotice" class="help-text" role="status">{{ savedNotice }}</p>
    <p v-if="error || saveError" class="error" role="alert">AI 或保存暂未完成，原件和回答不会删除。{{ error || saveError }}</p>
    <button v-if="error || saveError" class="text-button" :disabled="busy || saving" @click="reloadSaved">重新载入已保存的辅导（保留本页文字副本）</button>
    <details v-if="retainedText"><summary>重新载入前的本页文字副本</summary><p lang="ja">{{ retainedText }}</p></details>
    <button v-if="saveError" class="text-button" :disabled="busy || saving" @click="flush().catch(() => {})">重试保存回答</button>
  </section>
</template>

<style scoped>
.ja-coach { border-top: 1px solid var(--border); margin-top: 24px; padding-top: 24px; }
.coach-input { display: grid; gap: 8px; margin: 16px 0; }
input[type=checkbox] { width: auto; }
textarea { resize: vertical; }
.coach-feedback { margin-top: 16px; }
</style>
