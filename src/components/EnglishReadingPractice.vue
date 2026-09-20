<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router'
import { useApp } from '../stores/app'
import { useCloud } from '../stores/cloud'
import { db } from '../db/db'
import { createEnglishReading } from '../db/english-reading'
import { englishReadingDraftSchema, type EnglishReadingDraft } from '../domain/english-reading'
import type { Material, StudySession } from '../domain/types'

const props = defineProps<{ material: Material; taskId?: string }>()
const app = useApp(), cloud = useCloud(), router = useRouter()
const material = JSON.parse(JSON.stringify(props.material)) as Material, taskId = props.taskId
const id = `en-reader:${taskId ?? `${new Date().toLocaleDateString('en-CA')}:learn:${material.id}:free:reading`}`
const session = ref<StudySession>(), draft = ref<EnglishReadingDraft>(), conflicts = ref<StudySession[]>([])
const error = ref(''), busy = ref(false), loaded = ref(false), dirty = ref(false)
let owner: unknown, user = '', disposed = false, identityReady = false, identityChanged = false, timer: ReturnType<typeof setTimeout> | undefined
let baseline: EnglishReadingDraft, writes: Promise<boolean> = Promise.resolve(true)
async function checkOwner() {
  if (disposed || identityChanged || cloud.userId !== user || (await db.syncMeta.get('owner'))?.value !== owner) throw new Error('账号或页面已变化，请复制保留本页内容后重新进入。')
}
watch(() => cloud.userId, () => { if (identityReady) identityChanged = true }, { flush: 'sync' })
const reading = createEnglishReading(db, checkOwner)
const closed = computed(() => !!session.value?.completedAt)
const recall = computed(() => draft.value?.mode === 'recall')
const revealed = computed(() => !!draft.value?.revealedAt)
function saveMessage(e: unknown, fallback: string) {
  return e instanceof Error ? e.name === 'ZodError' ? '请填写有效的分钟数，不超过本次安排；文字不超过2000字。已有输入仍然保留。' : e.message : fallback
}
function restore(row: StudySession) {
  session.value = row; baseline = englishReadingDraftSchema.parse(row.draft); draft.value = structuredClone(baseline); dirty.value = false
}
function persist() {
  if (!loaded.value || !draft.value || closed.value) return Promise.resolve(true)
  const input = structuredClone({ response: draft.value.response, application: draft.value.application, effort: draft.value.effort,
    minutesRead: draft.value.minutesRead, ...(draft.value.rating ? { rating: draft.value.rating } : {}) })
  dirty.value = true
  const write = writes.then(async () => {
    try {
      const row = await reading.save(id, { ...baseline, ...input })
      baseline = englishReadingDraftSchema.parse(row.draft); session.value = row; error.value = ''
      if (draft.value && JSON.stringify(input) === JSON.stringify({ response: draft.value.response, application: draft.value.application,
        effort: draft.value.effort, minutesRead: draft.value.minutesRead, ...(draft.value.rating ? { rating: draft.value.rating } : {}) })) dirty.value = false
      return true
    } catch (e) { error.value = saveMessage(e, '暂未保存，请保留页面并重试。'); return false }
  })
  writes = write; return write
}
function changed() { dirty.value = true; clearTimeout(timer); timer = setTimeout(() => { void persist() }, 350) }
async function flush() { clearTimeout(timer); return dirty.value ? persist() : writes }
async function reveal() {
  if (busy.value) return
  busy.value = true
  try { if (await flush()) restore(await reading.reveal(id, baseline)) }
  catch (e) { error.value = saveMessage(e, '暂时无法核对，请重试。') }
  finally { busy.value = false }
}
async function finish(outcome: NonNullable<EnglishReadingDraft['outcome']> = 'finished') {
  if (busy.value) return
  busy.value = true
  try {
    if (!await flush()) return
    restore(await reading.finish(id, baseline, outcome)); await app.refresh()
  } catch (e) { error.value = saveMessage(e, '保存失败，请保留页面并重试。') }
  finally { busy.value = false }
}
async function next() {
  if (!closed.value || busy.value) return
  busy.value = true
  try {
    await checkOwner()
    const nextTask = taskId && session.value?.stage === 'saved' ? await app.continueAssignment(taskId) : undefined
    await router.push(nextTask ?? '/')
  } catch { error.value = '记录已经保存，暂时无法打开下一项；可以返回今日安排。' }
  finally { busy.value = false }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(async () => closed.value || !busy.value && await flush())
onBeforeRouteUpdate(async () => closed.value || !busy.value && await flush())
onMounted(async () => {
  owner = (await db.syncMeta.get('owner'))?.value; user = cloud.userId
  identityReady = true
  window.addEventListener('beforeunload', beforeUnload)
  try {
    if (user && owner !== user) throw new Error('当前账号尚未连接这些阅读记录，请先完成账号同步。')
    const existing = await db.sessions.get(id)
    if (!existing) {
      if (taskId && app.plan.tasks.find(t => t.id === taskId)?.materialId !== material.id) throw new Error('任务与页面材料不一致，请返回今日安排。')
      if (taskId && !await app.beginTask(taskId)) throw new Error('今日安排已更新，请返回 Today 重新进入。')
      const task = taskId ? app.plan.tasks.find(t => t.id === taskId) : { id: id.slice(10), kind: 'learn' as const,
        materialId: material.id, minutes: 5, done: false, title: '原版阅读', reason: '自主补充阅读' }
      if (!task || task.materialId !== material.id) throw new Error('任务与页面材料不一致，请返回今日安排，避免把回答存到另一篇。')
      await reading.start(task, Date.now(), !taskId)
    }
    const value = await reading.read(id)
    if (value.material.id !== material.id || taskId && value.draft.taskId !== taskId) throw new Error('任务与已保存的材料不一致，请返回今日安排。')
    if (!disposed) { restore(value.session); conflicts.value = value.conflicts; loaded.value = true }
  } catch (e) { error.value = e instanceof Error ? e.message : '暂时无法恢复阅读，请保留已有记录。' }
})
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); window.removeEventListener('beforeunload', beforeUnload) })
</script>

<template>
  <section class="panel original-reading" lang="zh-CN" :aria-busy="busy">
    <span class="eyebrow">{{ recall ? '从记忆中取出来' : '原版英语 · 分级阅读' }}</span>
    <h2>{{ recall ? '还记得上次读到了什么吗？' : material.title }}</h2>
    <p class="help-text">British Council LearnEnglish · {{ material.externalReading?.level }} · 这是材料等级，不是对你能力的认证。</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}<button v-if="loaded && !closed" class="text-button" :disabled="busy" @click="persist">重试保存</button></p>
    <p v-if="!loaded && !error" role="status">正在恢复阅读记录…</p>
    <template v-if="draft && loaded">
      <template v-if="!closed">
        <div v-if="!recall" class="reading-step">
          <h3>1. 先读懂大意</h3>
          <p>打开原文，先通读一遍；不必逐词翻成中文。卡住的词先猜意思，只查真正影响理解的词。</p>
          <a class="button secondary" :href="material.sourceUrl" target="_blank" rel="noopener noreferrer">打开出版社原文 ↗</a>
          <p class="help-text">原文和原站练习留在出版社网站，不占用本网站的媒体存储。打开链接不会自动计为读完。本网站与出版社无隶属关系。</p>
        </div>
        <fieldset :disabled="busy" class="reading-fields">
          <legend>{{ recall ? '先不看笔记，自己回想' : '2. 离开原文，用自己的话说' }}</legend>
          <label>{{ recall ? '你记得哪些重点？想不起来也可以如实写下来。' : '作者想告诉你什么？用一两句话写出重点，中文也可以。' }}
            <textarea v-model="draft.response" rows="4" maxlength="2000" :readonly="revealed" @input="changed" /></label>
          <template v-if="!recall">
            <label>可选：用一句英语，把一个想法说给朋友听。先表达自己的意思，不照抄原文。
              <textarea v-model="draft.application" rows="3" maxlength="2000" @input="changed" /></label>
            <label>读起来怎么样？
              <select v-model="draft.effort" @change="changed"><option value="okay">大意能跟上</option><option value="easy">很轻松</option><option value="hard">有些吃力</option></select></label>
          </template>
          <template v-else>
            <button v-if="!revealed" class="button secondary" @click="reveal">保存这次回想，再核对旧笔记</button>
            <div v-else class="reading-step">
              <h3>你上次保存的内容</h3><p class="saved-note">{{ draft.source?.response }}</p><p class="saved-note">{{ draft.source?.application }}</p>
              <p class="help-text">这是你自己的旧笔记，不是原文标准答案。这里只练回忆，不自动判定理解正确。</p>
              <label>核对后，你觉得记住了多少？
                <select v-model="draft.rating" @change="changed"><option :value="undefined" disabled>请如实选择</option><option value="forgot">想不起来</option><option value="partial">记得一部分</option><option value="clear">重点还清楚</option></select></label>
            </div>
          </template>
          <label>{{ recall ? '这次回忆和核对' : '这次实际阅读和表达' }}用了几分钟？（自己记录）
            <input v-model.number="draft.minutesRead" type="number" min="0" :max="draft.minutes" step="1" inputmode="numeric" @input="changed" /></label>
          <p class="help-text">今天这段最多 {{ draft.minutes }} 分钟。只记录实际投入，不计算挂着页面的时间。</p>
        </fieldset>
        <div class="row wrap">
          <button class="button primary" :disabled="busy" @click="finish()">{{ recall ? '保存这次回忆' : '保存这次阅读' }}</button>
          <button class="text-button" :disabled="busy" @click="finish('later')">先保存，稍后再学</button>
        </div>
        <div v-if="!recall" class="row wrap">
          <button class="text-button" :disabled="busy" @click="finish('too-hard')">太难，换容易一点的</button>
          <button class="text-button" :disabled="busy" @click="finish('not-interesting')">内容不适合，换一篇</button>
          <button class="text-button" :disabled="busy" @click="finish('unavailable')">原站打不开</button>
        </div>
        <p class="help-text" role="status">{{ dirty ? '正在保留你的输入…' : '输入已保存在本设备；登录后随学习记录同步。' }}</p>
      </template>
      <div v-else>
        <h3>{{ session?.stage === 'saved' ? '这次练习已保存' : '已保存并暂停，没有算作读完' }}</h3>
        <p class="saved-note">{{ draft.response }}</p><p class="saved-note">{{ draft.application }}</p>
        <p>系统会根据阅读体验安排下一篇，并适时提醒你回想自己的笔记。无须自己规划课程。</p>
        <p class="help-text">阅读时长与体验是你的自报记录；未核验原文理解，不产生虚构分数。</p>
        <button class="button primary" :disabled="busy" @click="next">{{ session?.stage === 'saved' ? '继续下一项' : '返回今日安排' }}</button>
      </div>
      <section v-if="conflicts.length" class="reading-step"><h3>其他设备保留的版本</h3><p>没有拼接或覆盖两次作答。需要时可以复制这里的文字。</p>
        <div v-for="copy in conflicts" :key="copy.id"><p class="saved-note">{{ copy.draft.response }}</p><p class="saved-note">{{ copy.draft.application }}</p></div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.original-reading { display: grid; gap: 1rem; }
.reading-step, .reading-fields { display: grid; gap: .8rem; min-width: 0; }
.reading-fields { border: 0; padding: 0; margin: 0; }
.reading-fields label { display: grid; gap: .5rem; }
.reading-fields textarea, .reading-fields select, .reading-fields input { width: 100%; max-width: 100%; box-sizing: border-box; }
.reading-fields input { max-width: 10rem; }
.saved-note { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
