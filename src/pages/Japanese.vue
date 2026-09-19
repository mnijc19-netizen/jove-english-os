<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { db as english, createLanguageDatabase } from '../db/db'
import { createJapaneseWorkspace, japanesePracticeDraft, type JapanesePracticeStep } from '../db/japanese'
import { japanesePlacement, japanesePlacementItems, kanaMorae } from '../domain/japanese'
import { japaneseStarterLessons, japaneseSource } from '../content/japanese'
import { readLanguageDay } from '../db/language-day'
import type { Assessment, AudioAsset, DailyPlan, StudySession } from '../domain/types'
import Recorder from '../components/Recorder.vue'
import { useRecordingUrl } from '../composables/useRecordingUrl'

const route = useRoute(), router = useRouter()
const database = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(database, english)
const ready = ref(false), busy = ref(false), navigating = ref(false), error = ref(''), notice = ref(''), captureActive = ref(false)
const assessment = shallowRef<Assessment>(), plan = shallowRef<DailyPlan | null>(null), session = shallowRef<StudySession>()
const audio = shallowRef<AudioAsset[]>([]), unfinished = shallowRef<StudySession[]>([])
const allowance = shallowRef<Awaited<ReturnType<typeof readLanguageDay>>>(null)
const responses = reactive<Record<string, string>>({})
const draft = reactive({ taskId: '', revision: 0, listened: false, response: '', expression: '', example: '', audioId: '', retryAudioId: '', comparison: '' })
const step = ref<JapanesePracticeStep>('listen'), showReading = ref(false), dirty = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined, disposed = false
let navigationGeneration = 0, allowedNavigation = ''
let saves: Promise<void> = Promise.resolve()
const lesson = computed(() => japaneseStarterLessons.find(lesson => lesson.id === session.value?.materialId))
const sourceUrl = computed(() => lesson.value ? `https://www.irodori.jpf.go.jp/en/starter/audio/lesson${String(lesson.value.position).padStart(2, '0')}.html` : '')
const placement = computed(() => assessment.value?.completedAt ? japanesePlacement(assessment.value.responses) : undefined)
const task = computed(() => plan.value?.tasks.find(task => !task.done && !task.optional))
const answerCount = computed(() => japanesePlacementItems.filter(item => responses[item.id]).length)
const originalPlayback = useRecordingUrl(computed(() => audio.value.find(asset => asset.id === draft.audioId)))
const nextEnabled = computed(() => step.value === 'listen' ? draft.listened && !!draft.response.trim()
  : step.value === 'notice' ? !!draft.expression.trim() && !!draft.example.trim()
    : step.value === 'speak' ? !!draft.audioId : !!draft.retryAudioId && !!draft.comparison.trim())

async function refreshAudio() { audio.value = await database.audio.toArray() }
function restore(saved: StudySession) {
  session.value = saved; Object.assign(draft, japanesePracticeDraft.parse(saved.draft))
  step.value = (saved.completedAt ? 'compare' : saved.stage) as JapanesePracticeStep
  dirty.value = false
}
async function refresh() {
  await learning.checkOwner()
  assessment.value = await database.assessments.get(learning.diagnosticId)
  if (assessment.value) Object.assign(responses, assessment.value.responses)
  plan.value = await learning.today()
  allowance.value = await readLanguageDay(english, Date.now(), database)
  unfinished.value = await database.sessions.filter(session => ['japanese-practice', 'japanese-review'].includes(session.kind) && !session.completedAt).toArray()
  await refreshAudio()
}
async function loadSession(id: unknown, generation = navigationGeneration) {
  if (typeof id !== 'string') { if (generation === navigationGeneration && !disposed) session.value = undefined; return }
  const saved = await database.sessions.get(id)
  if (generation !== navigationGeneration || disposed) return
  if (!saved || saved.kind !== 'japanese-practice') throw new Error('没有找到这次日语练习。请返回今日任务。')
  restore(saved)
}
async function act(action: () => Promise<void>) {
  if (busy.value || navigating.value) return
  busy.value = true; error.value = ''
  try { await action() } catch (failure) { error.value = failure instanceof Error ? failure.message : '未能保存，请保留此页并重试。' }
  finally { busy.value = false }
}
function flush(): Promise<void> {
  clearTimeout(timer)
  saves = saves.catch(() => {}).then(async () => {
    if (!dirty.value) return
    if (!session.value) {
      const before = JSON.stringify(responses)
      assessment.value = await learning.saveDiagnostic({ ...responses })
      if (JSON.stringify(responses) !== before) { changed(); return }
    } else if (!session.value.completedAt) {
      const before = JSON.stringify(draft), id = session.value.id
      const saved = await learning.save(id, { ...draft }, step.value)
      if (session.value?.id !== id) return
      session.value = saved
      // Typing while a write settles remains dirty and is saved next, never
      // replaced by the older snapshot returned from IndexedDB.
      const unchanged = JSON.stringify(draft) === before
      draft.revision = Number(saved.draft.revision)
      if (!unchanged) { changed(); return }
    }
    dirty.value = false; notice.value = '已保存在本机'
  })
  return saves
}
function changed() {
  dirty.value = true; notice.value = '正在保存…'; clearTimeout(timer)
  timer = setTimeout(() => { void flush().catch(failure => { error.value = failure.message }) }, 500)
}
async function finishDiagnostic() {
  await flush()
  assessment.value = await learning.saveDiagnostic({ ...responses }, true)
  await refresh()
}
async function start() {
  if (!task.value) return
  const saved = await learning.start(task.value.id)
  if (disposed) return
  const destination = { path: saved.kind === 'japanese-review' ? '/ja/review' : '/ja', query: { session: saved.id } }
  allowedNavigation = router.resolve(destination).fullPath
  try { await router.push(destination) } finally { allowedNavigation = '' }
}
async function move(next: JapanesePracticeStep) {
  if (captureActive.value || !session.value) return
  await flush()
  const saved = await learning.save(session.value.id, { ...draft }, next)
  restore(saved)
}
const recorderWorkspace = computed(() => {
  // Capture the session and recording role when Recorder mounts.
  const id = session.value?.id, field = step.value === 'compare' ? 'retryAudioId' : 'audioId'
  return { database, audio: () => audio.value, refresh: refreshAudio, assertCurrent: learning.checkOwner,
    attach: async (recorded: { audioId: string }) => {
      if (!id) throw new Error('请先开始练习')
      await flush()
      const stored = await database.sessions.get(id)
      if (!stored || stored.completedAt) throw new Error('练习已改变，录音原件仍保留在本机。')
      const frozen = japanesePracticeDraft.parse(stored.draft)
      const saved = await learning.save(id, { ...frozen, [field]: recorded.audioId }, stored.stage as JapanesePracticeStep)
      if (!disposed && session.value?.id === id) restore(saved)
    } }
})
async function complete() {
  if (!session.value || captureActive.value) return
  await flush(); restore(await learning.finish(session.value.id)); await refresh()
}
async function safeLeave(to: { fullPath: string }) {
  if (navigating.value) return false
  if (busy.value && to.fullPath !== allowedNavigation) { notice.value = '正在保存，请稍后再切换。'; return false }
  if (captureActive.value) { error.value = '请先停止录音，等待保存后再切换。'; return false }
  try {
    await flush()
    if (dirty.value) await flush()
    return !dirty.value
  } catch { error.value = '输入尚未保存，暂未离开此页。请重试保存。'; return false }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(safeLeave)
onBeforeRouteUpdate(async to => {
  if (!await safeLeave(to)) return false
  navigating.value = true
  const generation = ++navigationGeneration
  try { await refresh(); await loadSession(to.query.session, generation); return generation === navigationGeneration }
  catch (failure) { error.value = failure instanceof Error ? failure.message : '无法恢复练习'; return false }
  finally { if (generation === navigationGeneration) navigating.value = false }
})
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  void act(async () => { await learning.open(); await refresh(); await loadSession(route.query.session); ready.value = true })
})
onBeforeUnmount(() => {
  disposed = true; ++navigationGeneration; clearTimeout(timer); window.removeEventListener('beforeunload', beforeUnload)
  // Keep this immutable handle available to an in-flight recorder salvage.
  void saves.finally(() => { if (!captureActive.value) database.close() }).catch(() => {})
})
</script>

<template>
  <div class="page japanese-page">
    <div class="page-heading"><div><p class="eyebrow">JAPANESE · 日语学习</p><h1 tabindex="-1">每天一点，真的用得上。</h1></div><RouterLink to="/today" class="text-button">返回英语</RouterLink></div>
    <p class="help-text">开发预览：本页尚未开放到正式网站。日语云同步和 AI 反馈仍在接入。</p>
    <p v-if="error" class="error" role="alert">{{ error }} <button class="text-button" :disabled="busy" @click="act(flush)">重试保存</button></p>
    <p v-if="!ready" role="status">正在打开独立的日语学习记录…</p>
    <template v-else>
      <p class="help-text" role="status">{{ notice }}</p>
      <section v-if="!assessment?.completedAt" class="panel ja-panel">
        <h2>先了解你，不用提前准备</h2>
        <p>六个小问题，只调整假名提示和第一段练习。不知道就选“跳过”；这不是听说能力评分。</p>
        <form @submit.prevent="act(finishDiagnostic)">
          <fieldset v-for="item in japanesePlacementItems" :key="item.id" :disabled="busy || navigating">
            <legend>{{ item.prompt }}</legend>
            <label v-for="choice in [...item.choices, '跳过']" :key="choice" class="ja-choice">
              <input v-model="responses[item.id]" type="radio" :name="item.id" :value="choice" @change="changed">{{ choice }}
            </label>
          </fieldset>
          <button class="button primary" :disabled="busy || navigating || answerCount !== japanesePlacementItems.length">保存诊断，安排今天</button>
        </form>
      </section>
      <template v-else-if="!session">
        <section class="panel ja-panel">
          <p v-if="allowance" class="help-text">英日共用每天 {{ allowance.totalMinutes }} 分钟 · 日语当前安排 {{ allowance.allowances.ja.remaining }} 分钟。这是任务预算，不是计时成绩。</p>
          <h2>{{ task ? `今日练习：${task.title}` : '今天先到这里' }}</h2>
          <p v-if="task?.kind === 'review'">先做一小组到期复习：独立回答 → 对照参考 → 安排下次。之后再进行今日新情境练习。</p>
          <p v-else-if="task">① 听一段真人对话 → ② 回忆意思 → ③ 用自己的话回应 → ④ 对照后重说</p>
          <p v-else>已完成今天的安排，或当天时间已用完。已有草稿仍然保留，不需要补做堆积的任务。</p>
          <button v-if="task" class="button primary" :disabled="busy || navigating" @click="act(start)">开始学习 · 约 {{ task.minutes }} 分钟</button>
          <p class="help-text">听力、口语仍待实际练习观察；认字不等于会说。{{ placement?.kanaSupport ? '需要时会显示假名读法和拍数提示。' : '读法提示默认收起，需要时可以展开。' }}</p>
        </section>
        <section v-if="unfinished.length" class="section"><h2>接着上次的练习</h2><p v-for="saved in unfinished" :key="saved.id"><RouterLink :to="{ path: saved.kind === 'japanese-review' ? '/ja/review' : '/ja', query: { session: saved.id } }">{{ saved.kind === 'japanese-review' ? '日语延迟复习' : japaneseStarterLessons.find(lesson => lesson.id === saved.materialId)?.title }} · 继续草稿</RouterLink></p></section>
      </template>
      <section v-else-if="session.completedAt" class="panel ja-panel">
        <h2>这次练习已保存</h2><p>回答、原始录音和重说录音都已保留。参考词块已加入日语间隔复习；完成练习不等于已掌握。</p>
        <RouterLink to="/ja" class="button primary">返回日语今日安排</RouterLink>
      </section>
      <section v-else-if="lesson" class="panel ja-panel">
        <p class="eyebrow">{{ { listen: '1 / 4 · 先听懂意思', notice: '2 / 4 · 留意表达', speak: '3 / 4 · 换个情境说', compare: '4 / 4 · 对照后重说' }[step] }}</p>
        <h2>{{ lesson.title }}</h2><p>{{ lesson.canDo }}</p>
        <a :href="sourceUrl" target="_blank" rel="noopener noreferrer" class="button">打开原站真人音频 ↗</a>
        <p class="help-text">{{ japaneseSource.publisher }}。选这一课的一小段对话；先不看文字，必要时重复听。打开链接不会记为听懂或完成。</p>
        <fieldset :disabled="busy || navigating || captureActive" class="ja-response">
          <template v-if="step === 'listen'">
            <label class="ja-choice"><input v-model="draft.listened" type="checkbox" @change="changed">我已经实际听过一段原声</label>
            <label>他们在什么情境，说了什么？可用中文，也可以写下没听懂的地方。<textarea v-model="draft.response" maxlength="10000" rows="4" @input="changed" /></label>
          </template>
          <template v-else-if="step === 'notice'">
            <p>以下是本站练习例句，不是原站逐字字幕：</p><p class="ja-phrase" lang="ja">{{ lesson.phrase }}</p><p>{{ lesson.meaningZh }}</p>
            <button class="text-button" @click="showReading = !showReading">{{ showReading ? '收起读法' : '查看假名和拍数' }}</button>
            <p v-if="showReading || placement?.furigana === 'full'" lang="ja">{{ lesson.reading }} · {{ kanaMorae(lesson.reading).join('・') }}</p>
            <p>{{ lesson.grammarZh }}</p><p class="help-text">{{ lesson.soundZh }}</p>
            <label>选一个想用的日语表达<input v-model="draft.expression" lang="ja" maxlength="10000" @input="changed"></label>
            <label>换成自己的情况，说或写一句<textarea v-model="draft.example" lang="ja" maxlength="10000" rows="3" @input="changed" /></label>
          </template>
          <template v-if="step === 'speak' || step === 'compare'">
            <p>{{ lesson.transferZh }}</p>
            <p v-if="step === 'compare'">回放自己的录音，再听原声。一次只改一个地方，然后完整重说。这里只保存练习，不给自动发音或音高分数。</p>
            <label v-if="step === 'compare'">这次准备调整什么？<textarea v-model="draft.comparison" maxlength="10000" rows="3" @input="changed" /></label>
          </template>
        </fieldset>
        <audio v-if="step === 'compare' && originalPlayback" :src="originalPlayback" controls aria-label="日语首次回答录音" />
        <Recorder
          v-if="step === 'speak' || step === 'compare'" :key="session.id + step" :workspace="recorderWorkspace"
          :saved-audio-id="step === 'compare' ? draft.retryAudioId : draft.audioId" :disabled="busy || navigating"
          :label="step === 'compare' ? '日语：对照后完整重说' : '日语：新情境回答'" @active="captureActive = $event" />
        <div class="row wrap ja-actions">
          <button class="button primary" :disabled="busy || navigating || captureActive || !nextEnabled" @click="act(() => step === 'compare' ? complete() : move(step === 'listen' ? 'notice' : step === 'notice' ? 'speak' : 'compare'))">{{ step === 'compare' ? '保存这次完整练习' : '保存并继续' }}</button>
          <RouterLink to="/ja" class="text-button">保存后回到今日安排</RouterLink>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.ja-panel { padding: clamp(20px, 4vw, 36px); margin: 20px 0; }
fieldset { border: 0; padding: 0; margin: 24px 0; min-width: 0; }
legend { margin-bottom: 10px; font-weight: 600; }
.ja-choice { display: flex; gap: 10px; align-items: center; min-height: 44px; }
.ja-choice input { width: auto; }
.ja-response > label:not(.ja-choice) { display: grid; gap: 8px; margin: 20px 0; }
textarea { resize: vertical; }
.ja-phrase { font-size: 1.5rem; }
.ja-actions { margin-top: 24px; }
</style>
