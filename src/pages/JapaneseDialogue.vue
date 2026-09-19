<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router'
import { db as english, createLanguageDatabase } from '../db/db'
import { createJapaneseWorkspace } from '../db/japanese'
import { japaneseLessons } from '../content/japanese'
import { japaneseProvider } from '../ai/workspace-provider'
import { useApp } from '../stores/app'
import { useCloud } from '../stores/cloud'
import { useJapaneseSpace } from '../stores/japanese-space'
import { useRequest } from '../composables/useRequest'
import type { AudioAsset } from '../domain/types'
import Recorder from '../components/Recorder.vue'
import SavedRecording from '../components/SavedRecording.vue'

const route = useRoute(), app = useApp(), cloud = useCloud(), space = useJapaneseSpace()
const database = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(database, english), dialogue = learning.dialogue
const provider = japaneseProvider({ database, english, settings: () => app.settings,
  useAccount: () => cloud.configured && app.providerMode !== 'byok', assertCurrent: learning.checkOwner })
const state = shallowRef<Awaited<ReturnType<typeof dialogue.read>>>(), audio = shallowRef<AudioAsset[]>([])
const answer = reactive({ text: '', audioId: '', confirmed: false }), comparison = ref('')
const dirty = ref(false), saving = ref(false), capture = ref(false), notice = ref(''), saveError = ref(''), retained = ref(''), showExample = ref(false)
const { busy, error, run, cancel } = useRequest()
const lesson = computed(() => japaneseLessons.find(item => item.id === state.value?.session.materialId))
const draft = computed(() => state.value?.draft), pending = computed(() => draft.value?.turns.find(item => !item.reply))
const repair = computed(() => draft.value?.turns.length === 3 && !pending.value)
const locked = computed(() => busy.value || saving.value || capture.value)
const canAI = computed(() => app.keySet && app.online)
const correction = computed(() => draft.value?.feedback?.errors[0])
let disposed = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined, saves: Promise<void> = Promise.resolve()
function restore(value: Awaited<ReturnType<typeof dialogue.read>>) {
  state.value = value; Object.assign(answer, value.draft.answer); comparison.value = value.draft.comparison; dirty.value = false
}
async function refreshAudio() { audio.value = await database.audio.toArray() }
async function load(id: unknown) {
  const epoch = ++generation
  if (typeof id !== 'string') throw new Error('请从日语今日安排进入对话。')
  const value = await dialogue.read(id); await refreshAudio(); await learning.checkOwner()
  if (!disposed && epoch === generation) restore(value)
}
function changed() { dirty.value = true; clearTimeout(timer); timer = setTimeout(() => { void flush().catch(() => {}) }, 500) }
function flush(): Promise<void> {
  clearTimeout(timer)
  saves = saves.catch(() => {}).then(async () => {
    if (!dirty.value || !state.value) return
    saving.value = true; saveError.value = ''
    const id = state.value.session.id, snapshot = JSON.stringify({ answer, comparison: comparison.value })
    try {
      const value = await dialogue.save(id, state.value.draft.revision, { ...answer }, comparison.value)
      if (state.value?.session.id !== id || disposed) return
      state.value = value
      dirty.value = snapshot !== JSON.stringify({ answer, comparison: comparison.value })
      notice.value = '本轮文字和录音关联已保存。'
      if (dirty.value) changed()
    } catch (failure) { saveError.value = failure instanceof Error ? failure.message : '保存失败，输入仍保留。'; throw failure }
    finally { saving.value = false }
  })
  return saves
}
async function action(work: (id: string, signal: AbortSignal) => Promise<Awaited<ReturnType<typeof dialogue.read>>>, save = true) {
  await run(async signal => {
    if (save) await flush()
    signal.throwIfAborted()
    if (!state.value) return
    const id = state.value.session.id, epoch = generation
    try {
      const value = await work(id, signal)
      signal.throwIfAborted()
      if (!disposed && epoch === generation && state.value?.session.id === id) restore(value)
    } catch (failure) {
      // A sent answer may already be durable even if its reply failed. Refresh
      // only the same stable, clean view; preserve any newer local typing.
      if (!disposed && !signal.aborted && !dirty.value && epoch === generation) {
        const value = await dialogue.read(id)
        signal.throwIfAborted()
        if (!disposed && !dirty.value && epoch === generation) restore(value)
      }
      throw failure
    }
  })
}
async function reloadSaved() {
  await run(async signal => {
    clearTimeout(timer); await saves.catch(() => {}); signal.throwIfAborted()
    if (!state.value) { await space.ensure(); await learning.open(); signal.throwIfAborted(); await load(route.query.session); return }
    const epoch = generation, value = await dialogue.read(state.value.session.id)
    signal.throwIfAborted(); if (disposed || epoch !== generation) return
    if (answer.text !== value.draft.answer.text || comparison.value !== value.draft.comparison) retained.value = `回答：${answer.text}\n对照笔记：${comparison.value}`
    restore(value); saveError.value = ''; await refreshAudio()
  })
}
function send(ai: boolean) {
  return action((id, signal) => dialogue.send(id, { revision: state.value!.draft.revision, answer: { ...answer } }, ai ? provider : undefined, signal))
}
function stopWaiting() { cancel(); void reloadSaved() }
function resume(ai: boolean) { return action((id, signal) => dialogue.reply(id, pending.value!.id, ai ? provider : undefined, signal, true)) }
function summarize() { return action((id, signal) => dialogue.feedback(id, provider, signal, true)) }
function transcribe() { return action((id, signal) => dialogue.transcribe(id, state.value!.draft.revision, provider, signal)) }
const recorderWorkspace = computed(() => {
  const id = state.value?.session.id, isRetry = repair.value
  return { database, audio: () => audio.value, refresh: refreshAudio, assertCurrent: learning.checkOwner,
    attach: async (recorded: { audioId: string }) => {
      if (!id || !state.value || state.value.session.id !== id) throw new Error('对话已切换，原录音仍保留。')
      await flush()
      const value = await dialogue.attach(id, state.value.draft.revision, recorded.audioId, isRetry)
      if (!disposed && state.value?.session.id === id) restore(value)
    } }
})
async function safeLeave() {
  if (busy.value || capture.value || saving.value) { notice.value = '请先结束录音或停止等待，再切换页面。'; return false }
  try { await flush(); return !dirty.value } catch { return false }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || saving.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(safeLeave)
onBeforeRouteUpdate(async to => { if (!await safeLeave()) return false; await load(to.query.session); return true })
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  void run(async signal => { await space.ensure(); await learning.open(); signal.throwIfAborted(); await load(route.query.session) })
})
onBeforeUnmount(() => {
  disposed = true; generation++; cancel(); clearTimeout(timer); window.removeEventListener('beforeunload', beforeUnload)
  void saves.finally(() => { if (!capture.value) database.close() }).catch(() => {})
})
</script>

<template>
  <div class="page ja-dialogue">
    <div class="page-heading"><div><p class="eyebrow">JAPANESE · 连续交流</p><h1 tabindex="-1">先把话接下去，再改一处。</h1></div><RouterLink to="/ja" class="text-button">返回日语今日安排</RouterLink></div>
    <p class="help-text">日语开发预览 · 今天预算内的三轮短练习。AI 是文字对话伙伴，不是标准发音示范，也不测听说水平。</p>
    <p v-if="notice" role="status" class="help-text">{{ notice }}</p>
    <p v-if="error || saveError" role="alert" class="error">{{ error || saveError }} 原回答与录音仍保留，不会自动重试付费请求。</p>
    <div v-if="error || saveError" class="row wrap"><button class="text-button" :disabled="locked" @click="reloadSaved">重新载入已保存的对话（保留本页文字副本）</button><button v-if="dirty" class="text-button" :disabled="locked" @click="flush().catch(() => {})">重试保存</button></div>
    <details v-if="retained"><summary>重新载入前的本页文字副本</summary><pre>{{ retained }}</pre></details>
    <button v-if="busy" class="text-button" @click="stopWaiting">停止等待，保留回答</button>
    <section v-if="state && draft && lesson" class="panel dialogue-panel">
      <h2>{{ lesson.title }}</h2><p>{{ lesson.transferZh }}</p>
      <p class="help-text">先录音表达，再把自己实际说的话核对成文字发出。暂时不方便出声也可打字，系统只保存文字练习，不冒充口语成绩。</p>
      <ol class="turn-list">
        <li v-for="(turn, index) in draft.turns" :key="turn.id">
          <p class="eyebrow">第 {{ index + 1 }} 轮 · 我的回答{{ turn.audioId ? '（保留录音）' : '（文字）' }}</p><p lang="ja">{{ turn.text }}</p>
          <SavedRecording :audio-id="turn.audioId" :assets="audio" :label="`日语第${index + 1}轮录音`" />
          <template v-if="turn.reply"><p class="help-text">{{ turn.replyKind === 'ai' ? 'AI 对话伙伴' : '离线固定应答提示 · 不是 AI 回复' }}</p><p lang="ja">{{ turn.reply }}</p></template>
          <p v-else role="status">回答已保存，正在等待或恢复对方回复。</p>
        </li>
      </ol>
      <template v-if="state.session.completedAt"><h2>三轮练习和重说已保存</h2><p>完成的是一次练习，不是已通过听说等级。</p><RouterLink to="/ja" class="button primary">继续今日安排</RouterLink></template>
      <template v-else-if="pending">
        <p class="help-text">刷新不会自动重发。恢复时先找已收到的结果；此前结果未确认时，重试可能再次收费。两次未成功后用离线提示继续。</p>
        <div class="row wrap"><button class="button primary" :disabled="locked || !canAI" @click="resume(true)">{{ pending.attempts >= 2 ? '恢复已收到的回复（不重新调用）' : '恢复／重试 AI 回复（可能再次收费）' }}</button><button class="text-button" :disabled="locked" @click="resume(false)">用离线应答继续</button></div>
      </template>
      <template v-else-if="!repair">
        <p class="eyebrow">第 {{ draft.turns.length + 1 }} / 3 轮</p>
        <Recorder :key="state.session.id + ':' + draft.turns.length" :workspace="recorderWorkspace" :saved-audio-id="answer.audioId" :disabled="busy || saving" label="日语对话本轮回答" @active="capture = $event" />
        <button class="text-button" :disabled="locked || !canAI || !answer.audioId" @click="transcribe">转写这轮录音（可能收费）</button>
        <details v-if="draft.transcript"><summary>转写候选 · 先核对</summary><p lang="ja">{{ draft.transcript }}</p><button class="text-button" :disabled="locked" @click="answer.text = draft.transcript; answer.confirmed = false; changed()">放入本轮回答</button></details>
        <label>本轮日语回答<textarea v-model="answer.text" lang="ja" maxlength="2000" rows="3" :disabled="locked" @input="answer.confirmed = false; changed()" /></label>
        <label class="row"><input v-model="answer.confirmed" type="checkbox" :disabled="locked" @change="changed">已核对本轮文字；不把转写错误当成自己的表达错误</label>
        <div class="row wrap"><button class="button primary" :disabled="locked || !canAI || !answer.confirmed || !answer.text.trim()" @click="send(true)">发送并继续交流（AI，可能收费）</button><button class="text-button" :disabled="locked || !answer.confirmed || !answer.text.trim()" @click="send(false)">保存回答，使用离线应答</button></div>
        <p v-if="!canAI" class="help-text">AI 暂不可用，可以继续标明的离线练习；已有输入照常保存。</p>
      </template>
      <template v-else>
        <h3>现在只改一处，然后完整重说</h3>
        <button v-if="!draft.feedback" class="button secondary" :disabled="locked || !canAI" @click="summarize">{{ draft.feedbackAttempts >= 2 ? '恢复已收到的反馈（不重新调用）' : draft.feedbackAttempts ? '恢复／重试文字反馈（可能再次收费）' : '请 AI 总结三轮表达（可能收费）' }}</button>
        <template v-if="draft.feedback"><p>{{ draft.feedback.summary }}</p><p v-if="correction">先想一想：{{ correction.hint }}</p><button v-if="correction" class="text-button" @click="showExample = !showExample">{{ showExample ? '收起参考' : '想过后，查看参考改法' }}</button><div v-if="showExample && correction"><p lang="ja">{{ correction.corrected }}</p><p>{{ correction.explanation }}</p></div><p>{{ draft.feedback.nextPrompt }}</p></template>
        <details v-else><summary>不用 AI：对照本站表达与中文提示</summary><p lang="ja">{{ lesson.phrase }}</p><p>{{ lesson.grammarZh }}</p><p>{{ lesson.soundZh }}</p></details>
        <label>准备调整的一处表达<textarea v-model="comparison" maxlength="2000" rows="2" :disabled="locked" @input="changed" /></label>
        <Recorder :key="state.session.id + ':retry'" :workspace="recorderWorkspace" :saved-audio-id="draft.retryAudioId" :disabled="busy || saving" label="日语对话：换情境后完整重说" @active="capture = $event" />
        <button class="button primary" :disabled="locked || !draft.retryAudioId || !comparison.trim()" @click="action(id => dialogue.finish(id))">保存三轮对话与完整重说</button>
      </template>
      <p v-if="draft.audioUnavailable" class="help-text">此备份缺少部分录音文件，文字与历史仍保留；需要时重新录制，缺失文件不算口语证据。</p>
    </section>
    <p v-else-if="!error" role="status">正在恢复保存的日语对话…</p>
  </div>
</template>

<style scoped>
.dialogue-panel { padding: clamp(20px, 4vw, 36px); margin-top: 24px; }
.turn-list { list-style: none; padding: 0; }
.turn-list li { border-bottom: 1px solid var(--border); padding: 12px 0; }
label:not(.row) { display: grid; gap: 8px; margin: 20px 0; }
input[type=checkbox] { width: auto; }
textarea { resize: vertical; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
</style>
