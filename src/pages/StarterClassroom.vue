<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { db as english, createLanguageDatabase } from '../db/db'
import { createStarterClassroom, type StarterDraft, type StarterState } from '../db/starter'
import { starterLessons } from '../content/starter-courses'
import { nextStarterLesson, starterGoalEvidence, starterDemonstrationPath, type StarterStage } from '../domain/starter'
import type { LearningLanguage } from '../domain/language'
import type { AudioAsset, StudyEvent, StudySession } from '../domain/types'
import { useApp } from '../stores/app'
import { useCloud } from '../stores/cloud'
import { useJapaneseSpace } from '../stores/japanese-space'
import { cloudClient, createAuthFence } from '../cloud/client'
import { japaneseProvider } from '../ai/workspace-provider'
import { useRequest } from '../composables/useRequest'
import Recorder from '../components/Recorder.vue'
import SavedRecording from '../components/SavedRecording.vue'

const props = defineProps<{ language: LearningLanguage }>()
const language = props.language, app = useApp(), account = useCloud(), space = useJapaneseSpace()
const route = useRoute(), router = useRouter(), database = language === 'en' ? english : createLanguageDatabase('ja')
const fence = cloudClient ? createAuthFence() : null
let boundOwner = '', disposed = false, tick: ReturnType<typeof setInterval> | undefined, saveTimer: ReturnType<typeof setTimeout> | undefined
let saves = Promise.resolve()
const learning = createStarterClassroom(database, english, () => !disposed && (!cloudClient
  || !fence!.signal.aborted && (boundOwner ? fence!.isCurrent() : !account.userId)))
const state = shallowRef<StarterState>(), sessions = shallowRef<StudySession[]>([]), events = shallowRef<StudyEvent[]>([]), audio = shallowRef<AudioAsset[]>([])
const ready = ref(false), busy = ref(false), error = ref(''), saveStatus = ref(''), dirty = ref(false), captureActive = ref(false)
const response = ref(''), mode = ref<StarterDraft['mode']>('text'), audioId = ref(''), romaji = ref(false), activeMs = ref(0)
const pieces = ref<number[]>([]), playbackRate = ref(1), audioError = ref(false), consent = ref(false), pendingTranscript = ref('')
const audioSource = ref(''), audioLoading = ref(false), audioRetry = ref(0)
const directAudioFallback = ref(false)
const { busy: aiBusy, error: aiError, run, cancel } = useRequest()
const provider = language === 'en' ? app.provider : japaneseProvider({ database, english, settings: () => app.settings,
  useAccount: () => account.configured && app.providerMode !== 'byok', assertCurrent: learning.assertCurrent })
const courseList = computed(() => starterLessons.filter(lesson => lesson.language === language))
const selected = computed(() => courseList.value.find(lesson => lesson.id === route.query.lesson))
const home = language === 'ja' ? '/ja' : '/today'
const continuation = language === 'ja' ? { path: '/ja/literacy' } : { path: '/today', query: { practice: '1' } }
const nextLesson = computed(() => nextStarterLesson(language, sessions.value, events.value, app.clock))
const stage = computed(() => state.value?.session.stage as StarterStage | undefined)
const currentContext = computed(() => state.value?.lesson.transfer.find(context => context.id === state.value?.draft.contextId))
const meaning = computed(() => stage.value === 'transfer' ? currentContext.value?.meaningZh : state.value?.lesson.model.meaningZh)
const explanation = computed(() => stage.value === 'transfer' ? currentContext.value?.explanationZh : state.value?.lesson.model.explanationZh)
const readingAid = computed(() => stage.value === 'transfer' ? currentContext.value?.romaji : state.value?.lesson.model.romaji)
const hasCurrentAttempt = computed(() => !!state.value?.draft.lastAttemptId)
const currentAnswerMatches = computed(() => {
  const attempt = state.value?.attempts.find(item => item.id === state.value?.draft.lastAttemptId)
  return !!attempt && attempt.response === response.value.trim() && attempt.mode === mode.value && (attempt.audioId ?? '') === audioId.value
})
const readyToContinue = computed(() => currentAnswerMatches.value && !!state.value?.feedback
  && ['valid', 'uncertain'].includes(state.value.feedback.verdict))
const helpVisible = computed(() => stage.value !== 'transfer' || !!state.value?.draft.helped || hasCurrentAttempt.value)
const demonstration = computed(() => {
  if (!state.value) return ''
  const path = starterDemonstrationPath(state.value.lesson, stage.value === 'transfer' ? currentContext.value?.reference ?? '' : state.value.lesson.model.text)
  return path ? import.meta.env.BASE_URL + path : ''
})
const prompt = computed(() => !state.value ? '' : stage.value === 'recognize' ? state.value.lesson.recognition.promptZh
  : stage.value === 'assemble' ? state.value.lesson.scaffold.promptZh : stage.value === 'transfer' ? currentContext.value?.promptZh : state.value.lesson.expression.promptZh)
const example = computed(() => stage.value === 'transfer' ? currentContext.value?.reference : state.value?.lesson.expression.reference)
const repeatedDifficulty = computed(() => {
  const current = state.value
  if (!current) return false
  return current.attempts.filter(attempt => attempt.stage === stage.value && events.value.some(event => event.type === 'STARTER_FEEDBACK'
    && event.data?.attemptId === attempt.id && ['invalid', 'partial'].includes(String(event.data.verdict)))).length >= 2
})
const stageName = computed(() => ({ teach: '先听示范', recognize: '听懂意思', assemble: '跟着组合', express: '试着表达', transfer: '换个场景', done: '这次学到什么' }[stage.value ?? 'teach']))
const recoveryCopies = computed(() => sessions.value.filter(row => row.kind === 'starter-classroom' && row.id.startsWith('reading-conflict:')
  && (!state.value || (row.draft.syncRecovery as Record<string, unknown> | undefined)?.rootSessionId === (state.value.draft.syncRecovery?.rootSessionId ?? state.value.session.id))))
watch([demonstration, helpVisible, computed(() => stage.value === 'done'), audioRetry], async ([path, visible, finished], _previous, cleanup) => {
  audioError.value = false; audioSource.value = ''; audioLoading.value = false
  directAudioFallback.value = false
  if (!path || !visible || finished) return
  const controller = new AbortController()
  let url = ''
  cleanup(() => { controller.abort(); if (url) URL.revokeObjectURL(url) })
  audioLoading.value = true
  try {
    // Fetch a complete precached asset before using a Blob URL. Safari media
    // range requests otherwise need a live origin even when the WAV is cached.
    const result = await fetch(path, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
    if (!result.ok) throw new Error('Audio unavailable')
    const blob = await result.blob()
    if (!blob.size || blob.size > 1_400_000) throw new Error('Invalid audio asset')
    if (controller.signal.aborted || disposed) return
    url = URL.createObjectURL(new Blob([blob], { type: 'audio/wav' })); audioSource.value = url
  } catch { if (!controller.signal.aborted && !disposed) audioError.value = true }
  finally { if (!controller.signal.aborted && !disposed) audioLoading.value = false }
}, { immediate: true })
function demonstrationError() {
  // Some WebKit ports reject Blob media despite loading HTTP WAVs. Try the
  // original same-origin asset once; never infer that a fallback was heard.
  if (!directAudioFallback.value && demonstration.value) {
    directAudioFallback.value = true; audioSource.value = demonstration.value
  } else audioError.value = true
}
const disputed = computed(() => events.value.some(event => event.id === `${state.value?.draft.lastAttemptId}:disputed`))
const firstAI = computed(() => events.value.find(event => event.id === `${state.value?.draft.lastAttemptId}:feedback:ai-v1`))
const secondAI = computed(() => events.value.find(event => event.id === `${state.value?.draft.lastAttemptId}:feedback:ai-v2`))

function restore(saved: StarterState) {
  state.value = saved; response.value = saved.draft.response; mode.value = saved.draft.mode; audioId.value = saved.draft.audioId
  romaji.value = saved.draft.romaji; activeMs.value = saved.draft.activeMs; pieces.value = []; dirty.value = false; saveStatus.value = '已保存在本机'
  pendingTranscript.value = saved.pendingTranscription ?? ''
  if (saved.session.stage === 'assemble') {
    let rest = saved.draft.response.trim()
    while (rest) {
      const index = saved.lesson.scaffold.pieces.findIndex((piece, i) => !pieces.value.includes(i) && rest.startsWith(piece))
      if (index < 0) break
      pieces.value.push(index); rest = rest.slice(saved.lesson.scaffold.pieces[index]!.length).trimStart()
    }
  }
}
async function refresh() {
  await learning.assertCurrent()
  const records = await Promise.all([database.sessions.toArray(), database.events.toArray(), database.audio.toArray()])
  await learning.assertCurrent()
  ;[sessions.value, events.value, audio.value] = records
  await app.refresh()
}
async function act(action: () => Promise<void>) {
  if (busy.value || aiBusy.value || captureActive.value) return
  busy.value = true; error.value = ''
  try { await action(); await refresh() }
  catch (failure) { error.value = failure instanceof Error ? failure.message : '未能保存，请保留此页重试。' }
  finally { busy.value = false }
}
function flush() {
  clearTimeout(saveTimer)
  const snapshot = { response: response.value, mode: mode.value, audioId: audioId.value, romaji: romaji.value, activeMs: activeMs.value }
  const id = state.value?.session.id
  if (!id || !dirty.value || state.value?.session.completedAt) return saves
  saveStatus.value = '保存中…'
  saves = saves.catch(() => {}).then(async () => {
    if (!state.value || state.value.session.id !== id || disposed) return
    const saved = await learning.save(id, state.value.draft.revision, snapshot)
    // Do not replace characters typed while the earlier save was running.
    state.value = saved
    if (response.value === snapshot.response && audioId.value === snapshot.audioId && mode.value === snapshot.mode && romaji.value === snapshot.romaji) dirty.value = false
    saveStatus.value = '已保存在本机'
  }).catch(failure => { saveStatus.value = '尚未保存'; error.value = failure instanceof Error ? failure.message : '保存失败，原文字仍在这里。'; throw failure })
  return saves
}
function changed() { dirty.value = true; clearTimeout(saveTimer); saveTimer = setTimeout(() => { void flush().catch(() => {}) }, 350) }
async function begin(lessonId: string, pace: 'quick' | 'standard', review = false) {
  const saved = await learning.start(lessonId, pace, Date.now(), review)
  restore(saved)
  await router.replace({ path: route.path, query: { session: saved.session.id } })
}
async function continueNext() {
  const next = await learning.next()
  if (next?.session) { restore(await learning.load(next.session.id)); await router.replace({ query: { session: next.session.id } }) }
  else if (next) await begin(next.lesson.id, 'quick', next.review)
  else await router.push(continuation)
}
async function submit() {
  await flush()
  if (!state.value) return
  restore(await learning.submit(state.value.session.id, state.value.draft.revision))
}
async function nextStep(unverified = false) {
  await flush()
  if (!state.value) return
  restore(await learning.advance(state.value.session.id, state.value.draft.revision, Date.now(), unverified))
}
async function help() {
  await flush()
  if (state.value) restore(await learning.help(state.value.session.id, state.value.draft.revision))
}
async function choosePractice() {
  await help()
  mode.value = 'choice'; response.value = ''; changed()
}
async function recoverBranch(id: string) {
  await flush()
  const saved = await learning.recover(id)
  restore(saved)
  await router.replace({ path: route.path, query: { session: saved.session.id } })
}
async function attachRecording(value: { audioId: string }) {
  audioId.value = value.audioId; changed(); await flush(); await refresh()
}
async function getAIFeedback(review = false) {
  if (!consent.value || !state.value || !app.keySet || !currentAnswerMatches.value) return
  try {
    await flush()
    // Saving can wait behind another local write while the learner keeps typing.
    if (!consent.value || !state.value || !app.keySet || !currentAnswerMatches.value) return
    const attempt = state.value.attempts.find(item => item.id === state.value?.draft.lastAttemptId)
    const sessionId = state.value.session.id
    if (!attempt) return
    const finished = await run(async signal => {
      await learning.assertCurrent()
      if (account.configured && app.providerMode !== 'byok') await (language === 'en' ? account.syncNow() : space.syncNow())
      if (!consent.value || state.value?.session.id !== sessionId || state.value.draft.lastAttemptId !== attempt.id || !currentAnswerMatches.value) return false
      const feedback = await provider.starterFeedback(attempt, signal, { review })
      await learning.assertCurrent()
      // Provider provenance is transport metadata, not part of the strict
      // teaching DTO. Keep the verified model separate from model-authored text.
      const { verdict, feedbackZh, correction, nextAction, evidence } = feedback
      await learning.saveAIFeedback(attempt.id, { verdict, feedbackZh, correction, nextAction, evidence }, feedback.model, Date.now(), review)
      return true
    })
    if (finished && !disposed && state.value?.session.id === sessionId) {
      // Serialize the state read with autosaves, but never restore older input
      // over a new unsent edit, mode change, transcript or recording reference.
      saves = saves.catch(() => {}).then(async () => {
        if (disposed || state.value?.session.id !== sessionId) return
        const latest = await learning.load(sessionId)
        if (!disposed && state.value?.session.id === sessionId) state.value = latest
      })
      await saves; await refresh()
    }
  } catch (failure) { error.value = failure instanceof Error ? failure.message : '反馈处理未完成，原回答和新草稿仍保留。' }
}
async function disputeCurrent() {
  await flush()
  if (!state.value) return
  const id = state.value.session.id
  await learning.dispute(state.value.draft.lastAttemptId)
  restore(await learning.load(id))
  saveStatus.value = '争议已保存，暂停用这次结果判断掌握'
}
async function transcribe() {
  if (!consent.value || !audioId.value || !app.keySet) return
  await flush()
  const id = audioId.value, asset = await database.audio.get(id)
  if (!asset) return
  const transcript = await run(signal => provider.transcribe(asset.blob, signal))
  if (transcript && !disposed && audioId.value === id && state.value) {
    await learning.recordTranscription(state.value.session.id, id, transcript.slice(0, 500))
    pendingTranscript.value = transcript.slice(0, 500)
  }
}
async function confirmTranscript() {
  // This editable confirmation is not an acoustic assessment. The raw result
  // is retained separately from the learner's eventual corrected response.
  await learning.assertCurrent()
  if (!state.value || !audioId.value || !pendingTranscript.value) return
  response.value = pendingTranscript.value; mode.value = 'audio-transcript'; pendingTranscript.value = ''; changed(); await flush()
}
async function leave() { await flush(); await router.push(home) }
function appendPiece(index: number) {
  if (!state.value || pieces.value.includes(index)) return
  pieces.value.push(index); mode.value = 'choice'
  response.value = pieces.value.map(i => state.value!.lesson.scaffold.pieces[i]).join(language === 'ja' ? '' : ' '); changed()
}
onMounted(async () => {
  try {
    await account.settle()
    if (language === 'ja') await space.ensure()
    boundOwner = account.userId
    if (boundOwner && !fence?.bind(boundOwner)) throw new Error('账号正在变化，请重新打开这节课。')
    await learning.open()
    if (typeof route.query.session === 'string') restore(await learning.load(route.query.session))
    await refresh(); ready.value = true
    tick = setInterval(() => {
      if (!document.hidden && state.value && !state.value.session.completedAt && !aiBusy.value && activeMs.value < 10_800_000) {
        activeMs.value += 1000; dirty.value = true
      }
    }, 1000)
  } catch (failure) { error.value = failure instanceof Error ? failure.message : '暂时无法打开课程，旧记录仍保留。' }
})
onBeforeRouteLeave(async () => {
  if (captureActive.value || aiBusy.value) { error.value = '请先结束录音或取消 AI 请求，原件保存后再离开。'; return false }
  try { await flush(); return true } catch { return false }
})
onBeforeRouteUpdate(async to => {
  if (to.query.session === state.value?.session.id || to.query.session === route.query.session) return true
  if (busy.value || captureActive.value || aiBusy.value) return false
  try {
    await flush()
    if (typeof to.query.session === 'string') restore(await learning.load(to.query.session))
    else state.value = undefined
    await refresh(); return true
  } catch (failure) { error.value = failure instanceof Error ? failure.message : '暂未切换，原草稿保留。'; return false }
})
onBeforeUnmount(() => {
  clearInterval(tick); clearTimeout(saveTimer); cancel()
  // Normal navigation is flushed above; on forced unmount keep the same owner
  // fence/DB until the last accepted save settles.
  void saves.catch(() => {}).finally(() => { disposed = true; fence?.dispose(); if (language === 'ja' && !captureActive.value) database.close() })
})
</script>

<template>
  <div class="page starter-page" lang="zh-CN">
    <div class="page-heading"><div><p class="eyebrow">{{ language === 'en' ? '英语' : '日语' }} · 跟老师学 · 试用版</p><h1 tabindex="-1">{{ state?.lesson.titleZh ?? '从能用的一句话开始。' }}</h1></div><button class="text-button" :disabled="busy || captureActive || aiBusy" @click="act(leave)">暂停，回到今日安排</button></div>
    <p class="help-text">新课堂试用版 · 教学、合成示范与 AI 反馈仍待人工复核。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!ready && !error" role="status">正在接续你的课堂…</p>
    <details v-if="recoveryCopies.length" class="panel" aria-label="恢复另一台设备的课堂草稿"><summary>另一台设备也保存了草稿，两份原件都保留</summary><p>选择一份接续，会建立新草稿；不会把不同答案、提示或录音拼在一起，也不会重复记为掌握。</p><div v-for="copy in recoveryCopies" :key="copy.id"><p>{{ starterLessons.find(lesson => lesson.id === copy.materialId)?.titleZh }} · {{ copy.completedAt ? '已完成原件' : '未完成草稿' }}</p><p :lang="language">{{ copy.draft.response || '还没有填写回应' }}</p><p class="help-text">{{ copy.draft.helped ? '已用帮助' : '尚未用帮助' }} · {{ copy.draft.audioId ? '保留了录音引用' : '没有关联录音' }}</p><RouterLink v-if="copy.completedAt" :to="{ path: route.path, query: { session: copy.id } }">回看已完成原件</RouterLink><button v-else class="button secondary" :disabled="busy" @click="act(() => recoverBranch(copy.id))">接着这份草稿学</button></div></details>
    <template v-if="ready && !state">
      <section class="panel starter-focus"><h2>先示范，再练习；完全不会也可以。</h2><p v-if="selected">你正在查看“{{ selected.titleZh }}”。如果还没学过前面的基础，系统会先接续起步课。</p><p>不需要先测验、看完整视频或填写感想。每次只学一个小目标，不会就用中文帮助。</p><button v-if="nextLesson" class="button primary" :disabled="busy" @click="act(continueNext)">开始或接着上次学 · 约 3–5 分钟</button><template v-else><p>三节入口课已经练过，延迟回顾还没到时间。不重复开课填满今天；下面可以回看，也可以接着已有基础与分级练习。</p><RouterLink :to="continuation" class="button primary">接续系统安排</RouterLink></template></section>
      <ol class="course-list"><li v-for="lesson in courseList" :key="lesson.id"><h3>第 {{ lesson.position }} 课 · {{ lesson.titleZh }}</h3><p>{{ lesson.goalZh }}</p><p class="help-text">{{ starterGoalEvidence(lesson, events).retainedUse ? '已有后续时段换情境使用的证据' : starterGoalEvidence(lesson, events).independentUse ? '出现独立表达，下次再确认是否记住' : sessions.some(saved => saved.materialId === lesson.id && saved.completedAt) ? '已学习，独立使用仍待验证' : '从示范开始' }}</p><button class="button secondary" :disabled="busy" @click="act(() => begin(lesson.id, 'standard'))">{{ sessions.some(saved => saved.materialId === lesson.id && !saved.completedAt) ? '继续这节课' : '标准小课' }} · {{ lesson.minutes.standard }} 分钟</button></li></ol>
      <p v-if="language === 'ja'"><RouterLink to="/ja/literacy">另外每天认识几个假名，不要求先背完五十音。</RouterLink></p>
    </template>
    <section v-else-if="state" class="panel starter-focus" :aria-busy="busy || aiBusy">
      <div class="row between"><span class="pill">{{ stageName }}</span><span class="help-text" role="status">{{ saveStatus }}</span></div>
      <p class="learning-goal">这次要能用：{{ state.lesson.goalZh }}</p>
      <template v-if="stage === 'done'"><h2>这次的小目标已经练过。</h2><p>你的原回答、帮助和修正分别保存。学习结束不代表已经掌握；下次会换一个情境，再看看能否独立用出来。</p><p class="help-text">预计 {{ state.draft.minutes }} 分钟 · 本次前台练习记录 {{ Math.floor(state.draft.activeMs / 1000) }} 秒；没有计入后台停留。不是能力分数。</p><button class="button primary" @click="act(leave)">今天可以先到这里</button></template>
      <template v-else>
        <div v-if="helpVisible" class="starter-example">
          <p class="target-language" :lang="language">{{ stage === 'transfer' ? example : state.lesson.model.text }}</p><p>{{ meaning }}</p>
          <p class="help-text">补充合成示范{{ state.lesson.sound.status === 'pending-review' ? ' · 音质与自然度待人工试听核对' : '' }}；不是真人原声或发音评分。</p>
          <p v-if="audioLoading" class="help-text" role="status">正在接续这句的声音…</p>
          <audio v-if="audioSource && !audioError" :key="audioSource" controls preload="metadata" :src="audioSource" :playback-rate="playbackRate" :aria-label="language === 'ja' ? '日语短句合成示范' : '英语短句合成示范'" @error="demonstrationError" @play="($event.target as HTMLAudioElement).playbackRate = playbackRate" />
          <p v-if="audioError" class="help-text" role="status">示范暂未播放出来。可以先用中文讲解和选句继续，声音理解保持待验证。<button class="text-button" @click="audioRetry++">重试播放</button></p>
          <label v-if="demonstration" class="help-text">播放速度 <select v-model="playbackRate"><option :value="1">自然速度</option><option :value="0.85">稍慢一点</option></select></label>
          <p v-if="language === 'ja' && readingAid"><label class="help-text"><input v-model="romaji" type="checkbox" @change="changed">临时显示罗马字辅助（使用时会记录提示）</label><span v-if="romaji" class="romaji">{{ readingAid }}</span></p>
          <details :open="stage === 'teach'"><summary>中文讲解：这句话怎么组成、什么时候用</summary><p>{{ explanation }}</p></details>
          <details><summary>声音来源与使用说明</summary><p>{{ state.lesson.sound.sourceLabel }}。{{ state.lesson.sound.notesZh }}</p><a v-if="state.lesson.sound.sourceUrl" :href="state.lesson.sound.sourceUrl" target="_blank" rel="noopener noreferrer">可选：查看真人原站示范</a></details>
        </div>
        <template v-if="stage === 'teach'"><p>先听一次，看懂中文意思；不需要已经会读这些字。接下来只做一个简单选择。</p><button class="button primary" :disabled="busy" @click="act(() => nextStep())">我看过示范了，试一个小问题</button></template>
        <form v-else @submit.prevent="act(submit)">
          <h2>{{ prompt }}</h2>
          <fieldset v-if="stage === 'recognize'" :disabled="busy || aiBusy"><legend class="sr-only">选择意思</legend><label v-for="choice in state.lesson.recognition.choices" :key="choice.id" class="starter-choice"><input v-model="response" type="radio" :value="choice.id" @change="mode = 'choice'; changed()">{{ choice.textZh }}</label></fieldset>
          <div v-else-if="stage === 'assemble'" class="starter-pieces"><button v-for="(piece, index) in state.lesson.scaffold.pieces" :key="index" type="button" class="button secondary" :disabled="pieces.includes(index) || busy" :lang="language" @click="appendPiece(index)">{{ piece }}</button><p :lang="language">{{ response || '点词块，先不用自己打字。' }}</p><button type="button" class="text-button" @click="pieces = []; response = ''; changed()">重新组合</button></div>
          <template v-else>
            <template v-if="mode === 'choice'"><p>这是借助示范的选句练习，不是独立书写或口语。</p><button type="button" class="button secondary" :lang="language" @click="response = example ?? ''; changed()">用这句试着回应：{{ example }}</button><p :lang="language">{{ response }}</p></template>
            <label v-else class="starter-answer">{{ mode === 'audio-transcript' ? '核对后你实际说出的文字' : '试着用刚教的表达回应' }}<textarea v-model="response" maxlength="500" rows="3" :lang="language" :disabled="busy || aiBusy" @input="changed" /></label>
            <div class="starter-actions"><button type="button" class="text-button" :disabled="busy || aiBusy" @click="act(choosePractice)">不会打字 / 换成选句练习</button><button v-if="mode === 'choice'" type="button" class="text-button" @click="mode = 'text'; response = ''; changed()">我想试着自己写</button></div>
            <details class="recording-option"><summary>也可以开口练习、保存原录音</summary><p>录音先保存在本机。不能说话时继续文字或选句即可，口语保持待验证。</p><Recorder :key="state.session.id + ':' + stage" :label="language === 'ja' ? '录一句日语' : '录一句英语'" :saved-audio-id="audioId" transcription-disabled :workspace="{ database, audio: () => audio, refresh, assertCurrent: learning.assertCurrent, attach: attachRecording }" @active="captureActive = $event" @recorded="attachRecording" /><SavedRecording :audio-id="audioId" :assets="audio" label="这次的原录音" /><button v-if="audioId && consent && app.keySet" type="button" class="button secondary" :disabled="aiBusy || captureActive" @click="transcribe">将当前录音交给 AI 转成文字</button><template v-if="pendingTranscript"><p>请核对识别内容；识别错误不是你的语言错误。</p><textarea v-model="pendingTranscript" rows="2" maxlength="500" aria-label="核对识别结果" /><button type="button" class="button secondary" @click="act(confirmTranscript)">确认识别文字，再用它练习</button></template></details>
          </template>
          <button v-if="!readyToContinue" type="submit" class="button primary" :disabled="busy || aiBusy || captureActive || !response.trim()">看看这次表达</button>
        </form>
        <div v-if="state.feedback && hasCurrentAttempt" class="starter-feedback" aria-live="polite">
          <p v-if="!currentAnswerMatches" class="help-text">下面是上一份已提交回答的反馈。你修改后的答案还没核对，请先点“看看这次表达”；新草稿和旧反馈都保留。</p>
          <h3>{{ state.feedback.verdict === 'valid' ? '这次的意思成立' : state.feedback.verdict === 'uncertain' ? '这个回答还需要核对' : '先改这一处就好' }}</h3><p>{{ state.feedback.feedbackZh }}</p><p v-if="state.feedback.correction" :lang="language">可以试：{{ state.feedback.correction }}</p><p class="help-text">{{ state.feedback.source === 'ai' ? 'AI 辅助反馈' : '本课内容规则反馈' }} · 不评价发音与语调。</p>
          <button v-if="readyToContinue && state.feedback.verdict === 'valid'" class="button primary" :disabled="busy || aiBusy" @click="act(() => nextStep())">{{ stage === 'transfer' || stage === 'express' && state.draft.pace === 'quick' ? '保存，结束这个小课' : '继续下一小步' }}</button><button v-else-if="readyToContinue && state.feedback.verdict === 'uncertain'" class="button primary" :disabled="busy || aiBusy" @click="act(() => nextStep(true))">保留待核对回答，先继续教学</button><button class="text-button" :disabled="busy || aiBusy" @click="act(disputeCurrent)">我认为这也对</button>
        </div>
        <p v-if="repeatedDifficulty" class="help-text" role="status">连续尝试还卡住，我们换成示范和选句；这不是你不认真。<button class="button secondary" :disabled="busy" @click="act(choosePractice)">换一个更容易的小动作</button></p>
        <div class="starter-actions"><button v-if="stage !== 'teach'" class="text-button" :disabled="busy || aiBusy" @click="act(help)">给我帮助 / 再看示范</button><button class="text-button" :disabled="busy || captureActive" @click="act(leave)">暂停，下次从这里继续</button></div>
        <details class="ai-option"><summary>需要时请 AI 核对当前回答</summary>
          <p>AI 会收到当前回答、当前课目标和必要的练习内容；转写另需发送当前录音。不会发送全部历史。由已配置的 AI 服务处理；你也可以一直只用本地课程。</p>
          <label><input v-model="consent" type="checkbox">同意本次云端处理</label>
          <button class="button secondary" :disabled="!consent || !app.keySet || !currentAnswerMatches || !!firstAI || aiBusy || busy" @click="getAIFeedback(false)">{{ aiBusy ? '正在核对，原回答已经保存…' : firstAI ? '本次 AI 反馈已保存' : '请 AI 只核对这一处' }}</button>
          <template v-if="disputed && firstAI?.data?.model"><p>异议不会覆盖原判断。可以选择另一个模型独立核对一次，可能额外计费，同样受账号限额保护；判断仍不一致时保持待核对，不强行给分。</p><button class="button secondary" :disabled="!consent || !app.keySet || !currentAnswerMatches || !!secondAI || aiBusy || busy" @click="getAIFeedback(true)">{{ secondAI ? '独立核对已保存' : '换一个模型独立核对（最多一次）' }}</button></template>
          <details v-if="firstAI"><summary>保留的反馈版本</summary><p>第一次：{{ firstAI.data?.feedbackZh }} · {{ firstAI.data?.model ?? '来源待确认' }}</p><p v-if="secondAI">独立核对：{{ secondAI.data?.feedbackZh }} · {{ secondAI.data?.model }}</p></details>
          <button v-if="aiBusy" class="text-button" @click="cancel">取消等待，继续本地学习</button><p v-if="!app.keySet" class="help-text">未启用账号 AI；示范、练习和保存仍可使用。</p><p v-if="aiError" role="status">AI 暂未完成，本课备用解释仍可使用。</p><details v-if="aiError"><summary>诊断信息</summary><p>{{ aiError }}</p></details>
        </details>
      </template>
    </section>
  </div>
</template>

<style scoped>
.starter-page{max-width:850px}.starter-focus{padding:clamp(20px,4vw,36px);margin-bottom:24px}.starter-focus h2{font-size:1.25rem;line-height:1.6}.target-language{font-size:clamp(24px,4vw,34px);font-weight:600;line-height:1.5;overflow-wrap:anywhere}.starter-example audio{width:100%;display:block;margin:12px 0}.starter-example details,.recording-option,.ai-option{margin-top:14px}.romaji{display:block;color:var(--muted);margin:8px 0}.starter-choice{display:flex;gap:12px;align-items:center;min-height:52px;padding:10px;border:1px solid var(--line);border-radius:10px;margin:8px 0}.starter-answer{display:block}.starter-answer textarea{display:block;width:100%;margin:10px 0}.starter-actions,.starter-pieces{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.starter-pieces p{width:100%;min-height:36px}.starter-feedback{border-top:1px solid var(--line);padding-top:18px;margin-top:24px}.course-list{padding-left:24px}.course-list li{padding:12px 0 22px}.starter-focus>.button.primary,form>.button.primary{width:100%;margin-top:16px}fieldset{border:0;padding:0}button{min-height:44px}.ai-option .button{margin:12px 0;display:block}@media(max-width:600px){.starter-page .page-heading{display:block}.starter-focus{padding:18px}.starter-focus .learning-goal{font-size:1rem}.starter-actions{gap:4px}}
</style>
