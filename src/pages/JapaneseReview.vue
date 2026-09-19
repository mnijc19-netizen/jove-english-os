<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router'
import { db as english, createLanguageDatabase } from '../db/db'
import { createJapaneseWorkspace } from '../db/japanese'
import { japaneseReviewDraft } from '../db/japanese-review'
import { japaneseStarterLessons } from '../content/japanese'
import type { AudioAsset, Chunk, Material, ReviewCard, StudySession } from '../domain/types'
import Recorder from '../components/Recorder.vue'
import { useRecordingUrl } from '../composables/useRecordingUrl'

const route = useRoute(), database = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(database, english)
const session = shallowRef<StudySession>(), cards = shallowRef<ReviewCard[]>([]), chunks = shallowRef<Chunk[]>([]), materials = shallowRef<Material[]>([])
const audio = shallowRef<AudioAsset[]>([]), busy = ref(false), active = ref(false), dirty = ref(false), error = ref(''), notice = ref('')
const response = reactive({ response: '', audioId: '', heard: false })
const draft = computed(() => session.value ? japaneseReviewDraft.parse(session.value.draft) : undefined)
const item = computed(() => draft.value?.items.find(item => !item.rating && !item.skipped))
const card = computed(() => cards.value.find(card => card.id === item.value?.cardId))
const chunk = computed(() => chunks.value.find(chunk => chunk.id === card.value?.chunkId))
const lesson = computed(() => japaneseStarterLessons.find(lesson => chunk.value?.sourceIds.includes(lesson.id)))
const source = computed(() => materials.value.find(material => material.language === 'ja' && material.approved && chunk.value?.sourceIds.includes(material.id)))
const oral = computed(() => card.value?.modality === 'speaking' || card.value?.modality === 'transfer')
const modalityLabels = { recognition: '看表达，回忆意思', listening: '听原声，回忆意思', recall: '看意思，回忆日语', cloze: '完整表达一句话', speaking: '不看答案，开口表达', transfer: '换一个情境使用' }
const prompt = computed(() => card.value?.modality === 'recognition' ? chunk.value?.text
  : card.value?.modality === 'listening' ? '打开这一课的一段真人对话，先不看文字，听完说明意思。原站音频不一定逐字包含本站例句。'
    : card.value?.modality === 'transfer' ? lesson.value?.transferZh ?? '换成自己的生活场景，用这个意思回应对方。'
      : chunk.value?.meaningZh || chunk.value?.meaningEn)
const playback = useRecordingUrl(computed(() => audio.value.find(asset => asset.id === response.audioId)))
let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, saves: Promise<void> = Promise.resolve()
function restore(saved: StudySession) {
  session.value = saved
  const current = japaneseReviewDraft.parse(saved.draft).items.find(item => !item.rating && !item.skipped)
  Object.assign(response, { response: current?.response ?? '', audioId: current?.audioId ?? '', heard: current?.heard ?? false })
  dirty.value = false
}
async function refreshAudio() { audio.value = await database.audio.toArray() }
async function load(id: unknown) {
  if (typeof id !== 'string') throw new Error('请从日语今日安排进入复习。')
  const saved = await learning.review.read(id)
  ;[cards.value, chunks.value, materials.value] = await Promise.all([database.cards.toArray(), database.chunks.toArray(), database.materials.toArray()])
  await refreshAudio(); restore(saved.session)
}
async function act(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await action() } catch (failure) { error.value = failure instanceof Error ? failure.message : '没有保存成功，请保留此页重试。' }
  finally { busy.value = false }
}
function changed() {
  dirty.value = true; notice.value = '正在保存…'; clearTimeout(timer)
  timer = setTimeout(() => { void flush().catch(failure => { error.value = failure.message }) }, 500)
}
function flush(): Promise<void> {
  clearTimeout(timer)
  saves = saves.catch(() => {}).then(async () => {
    if (!dirty.value || !session.value || !draft.value || item.value?.revealed) return
    const before = JSON.stringify(response), saved = await learning.review.save(session.value.id, draft.value.revision, { ...response })
    session.value = saved
    if (JSON.stringify(response) !== before) { changed(); return }
    dirty.value = false; notice.value = '首答已保存在本机'
  })
  return saves
}
async function reveal() {
  if (!session.value || active.value) return
  await flush()
  restore(await learning.review.save(session.value.id, draft.value!.revision, { ...response }, true))
}
async function rate(rating: 1 | 2 | 3 | 4) {
  if (!session.value || active.value) return
  restore(await learning.review.rate(session.value.id, draft.value!.revision, rating))
  cards.value = await database.cards.toArray()
}
async function recover() {
  if (!session.value || active.value) return
  clearTimeout(timer); await saves.catch(() => {})
  restore(await learning.review.recover(session.value.id, draft.value!.revision, { ...response }))
  notice.value = '已保留首答并略过已变动卡片，没有再次修改它的复习时间。'
}
const recorderWorkspace = computed(() => {
  const id = session.value?.id, cardId = item.value?.cardId
  return { database, audio: () => audio.value, refresh: refreshAudio, assertCurrent: learning.checkOwner,
    attach: async (recorded: { audioId: string }) => {
      if (!id || !cardId) throw new Error('复习卡片不存在')
      await flush()
      const stored = await learning.review.read(id), current = stored.draft.items.find(item => !item.rating && !item.skipped)
      if (current?.cardId !== cardId || current.revealed) throw new Error('首答已锁定，录音原件仍保留在日语区。')
      const saved = await learning.review.save(id, stored.draft.revision, { response: current.response, heard: current.heard, audioId: recorded.audioId })
      if (!disposed && session.value?.id === id) restore(saved)
    } }
})
async function safeLeave() {
  if (busy.value || active.value) { notice.value = '请等待保存或先停止录音，再切换练习。'; return false }
  busy.value = true
  try { await flush(); if (dirty.value) await flush(); return !dirty.value }
  catch { error.value = '首答尚未保存，请重试后再离开。'; return false }
  finally { busy.value = false }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(safeLeave)
onBeforeRouteUpdate(async to => {
  if (!await safeLeave()) return false
  busy.value = true
  try { await load(to.query.session); return true }
  catch (failure) { error.value = failure instanceof Error ? failure.message : '无法打开复习'; return false }
  finally { busy.value = false }
})
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  void act(async () => { await learning.open(); await load(route.query.session) })
})
onBeforeUnmount(() => {
  disposed = true; clearTimeout(timer); window.removeEventListener('beforeunload', beforeUnload)
  void saves.finally(() => { if (!active.value) database.close() }).catch(() => {})
})
</script>

<template>
  <div class="page">
    <div class="page-heading"><div><p class="eyebrow">JAPANESE · 延迟复习</p><h1 tabindex="-1">先想起来，再对照。</h1></div><RouterLink to="/ja" class="text-button">返回日语今日安排</RouterLink></div>
    <p class="help-text">中文帮助理解任务；认得汉字、听懂声音和自己说出来分别练。这里只根据自评安排复习，不给能力或发音分数。</p>
    <p v-if="error" class="error" role="alert">{{ error }} <button class="text-button" :disabled="busy" @click="act(flush)">重试保存</button> <button v-if="session && item" class="text-button" :disabled="busy || active" @click="act(recover)">保留首答，略过已变动卡片</button></p>
    <p class="help-text" role="status">{{ notice }}</p>
    <section v-if="session?.completedAt" class="panel ja-review-panel">
      <h2>这一小组已保存</h2><p>已保存本次回答。只更新已评分卡片的复习时间；有进度冲突的卡片保留另一份记录，不重复计分。剩余学习时间交给系统安排。</p>
      <RouterLink to="/ja" class="button primary">继续今日安排</RouterLink>
    </section>
    <section v-else-if="card && chunk && item" class="panel ja-review-panel">
      <p class="eyebrow">{{ modalityLabels[card.modality] }} · {{ draft!.items.filter(item => item.rating || item.skipped).length + 1 }} / {{ draft!.items.length }}</p>
      <h2 :lang="card.modality === 'recognition' ? 'ja' : 'zh'">{{ prompt }}</h2>
      <template v-if="card.modality === 'listening'">
        <a v-if="source?.sourceUrl" :href="source.sourceUrl" target="_blank" rel="noopener noreferrer" class="button">打开原站真人音频 ↗</a>
        <label class="row"><input v-model="response.heard" type="checkbox" :disabled="busy || item.revealed" @change="changed">我实际听过原声，再回来作答</label>
      </template>
      <fieldset :disabled="busy || active || item.revealed">
        <label>先独立回答；想不起来也可以直接看提示<textarea v-model="response.response" :lang="card.modality === 'recognition' || card.modality === 'listening' ? 'zh' : 'ja'" rows="4" maxlength="10000" @input="changed" /></label>
      </fieldset>
      <Recorder v-if="oral && !item.revealed" :key="session!.id + item.cardId" :workspace="recorderWorkspace" :saved-audio-id="response.audioId" :disabled="busy" label="日语复习：不看参考答案开口" @active="active = $event" />
      <button v-if="!item.revealed" class="button primary" :disabled="busy || active" @click="act(reveal)">保存首答，查看参考</button>
      <div v-else>
        <p v-if="item.hintUsed" class="help-text">这次用了提示，系统会较早安排再练，不把对照后的答案算独立回忆。</p>
        <p v-if="card.modality === 'listening'">以下是本站表达参考，不是你刚才所听片段的逐字答案；请回到原站文字核对意思。</p>
        <p lang="ja" class="ja-reference">{{ chunk.text }}</p><p v-if="lesson" lang="ja">{{ lesson.reading }}</p>
        <p>{{ chunk.meaningZh || chunk.meaningEn }}</p><p v-if="lesson">{{ lesson.grammarZh }}</p>
        <audio v-if="playback" :src="playback" controls aria-label="日语复习首答录音" />
        <p>按看到参考之前的记忆情况选择，不必追求每次答对。意思相同的合理表达不必逐字一致。</p>
        <div class="row wrap">
          <button v-for="choice in [{ rating: 1, label: '没想起来' }, { rating: 2, label: '很费力' }, { rating: 3, label: '想起来了' }, { rating: 4, label: '很轻松' }]" :key="choice.rating" class="button" :disabled="busy || active" @click="act(() => rate(choice.rating as 1 | 2 | 3 | 4))">{{ choice.label }}</button>
        </div>
      </div>
    </section>
    <p v-else-if="!error" role="status">正在恢复日语复习…</p>
  </div>
</template>

<style scoped>
.ja-review-panel { padding: clamp(20px, 4vw, 36px); margin: 20px 0; }
fieldset { border: 0; padding: 0; margin: 20px 0; min-width: 0; }
label { display: grid; gap: 10px; }
input[type=checkbox] { width: auto; }
textarea { resize: vertical; }
.ja-reference { font-size: 1.5rem; }
</style>
