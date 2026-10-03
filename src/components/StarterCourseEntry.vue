<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { db as english, createLanguageDatabase } from '../db/db'
import { readLanguageDay } from '../db/language-day'
import { starterLessons } from '../content/starter-courses'
import { nextStarterLesson, starterGoalEvidence, starterRemainingMinutes } from '../domain/starter'
import type { StudyEvent, StudySession } from '../domain/types'
import type { LearningLanguage } from '../domain/language'
import { useApp } from '../stores/app'
import { useJapaneseSpace } from '../stores/japanese-space'
import { useCloud } from '../stores/cloud'

const props = defineProps<{ language: LearningLanguage; view?: 'entry' | 'progress'; continuation?: boolean }>()
const emit = defineEmits<{ attention: [pending: boolean] }>()
const account = useCloud()
let generation = 0, disposed = false
const app = useApp(), space = useJapaneseSpace(), records = shallowRef<StudySession[]>([]), events = shallowRef<StudyEvent[]>([]), ready = ref(false)
const availableMinutes = ref<number>()
const courses = computed(() => starterLessons.filter(lesson => lesson.language === props.language).sort((a, b) => a.position - b.position))
const next = computed(() => nextStarterLesson(props.language, records.value, events.value, app.clock, availableMinutes.value))
const needsAttention = computed(() => ready.value && !!(next.value?.review || next.value?.session
  || next.value && records.value.some(saved => saved.kind === 'starter-classroom' && saved.completedAt)))
watch(needsAttention, pending => emit('attention', pending), { immediate: true })
const label = computed(() => next.value?.session ? '继续上次的小课' : next.value?.review ? '先把学过的表达再用一次' : '跟着示范，开始学一句')
const destination = computed(() => next.value ? ({ path: `/course/${props.language}`, query: next.value.session ? { session: next.value.session.id }
  : { lesson: next.value.lesson.id } }) : props.language === 'en' ? { path: '/today', query: { practice: '1' } } : { path: '/ja/literacy' })
async function refresh() {
  const token = ++generation
  const database = props.language === 'en' ? english : createLanguageDatabase('ja')
  try {
    if (props.language === 'ja') await space.ensure()
    const owner = (await english.syncMeta.get('owner'))?.value
    if ((await database.syncMeta.get('owner'))?.value !== owner) return
    const data = await Promise.all([database.sessions.toArray(), database.events.toArray()])
    const day = await readLanguageDay(english, app.clock, props.language === 'ja' ? database : undefined,
      { admitJapanese: props.language === 'ja' })
    const fallback = day ? undefined : await Promise.all([english.profiles.get('main'), english.events.toArray()])
    if ((await database.syncMeta.get('owner'))?.value !== owner || (await english.syncMeta.get('owner'))?.value !== owner) return
    if (disposed || generation !== token) return
    ;[records.value, events.value] = data; ready.value = true
    availableMinutes.value = day ? Math.max(0, day.allowances[props.language].remaining - day.allowances[props.language].reserved)
      : starterRemainingMinutes(fallback![0]?.dailyMinutes ?? 45, fallback![1], app.clock)
  } finally { if (props.language === 'ja') database.close() }
}
onMounted(() => { void refresh().catch(() => {}) })
watch(() => props.language === 'en' ? app.events.length : space.revision, () => { void refresh().catch(() => {}) })
watch([() => new Date(app.clock).toLocaleDateString('en-CA'), () => app.profile.dailyMinutes,
  () => app.sharedDay?.allowances[props.language].remaining, () => app.sharedDay?.allowances[props.language].reserved], () => { void refresh().catch(() => {}) })
watch(() => account.userId, () => { generation++; ready.value = false; records.value = []; events.value = []; void refresh().catch(() => {}) })
onBeforeUnmount(() => { disposed = true; generation++ })
</script>
<template>
  <section v-if="ready && (!continuation || needsAttention)" class="panel starter-entry" aria-label="跟老师一步步学" lang="zh-CN">
    <p class="help-text">新课堂试用版 · 教学、合成示范与 AI 反馈仍待人工复核。</p>
    <template v-if="view === 'progress'"><h2>一句一句，看到自己能用什么</h2><p>学过、借助提示、独立表达、后续时段换情境使用分别记录，不把完成次数当掌握率。</p><ol><li v-for="course in courses" :key="course.id"><strong>{{ course.goalZh }}</strong><p>{{ starterGoalEvidence(course, events, app.clock).retainedUse ? '已有跨时段、不同情境的独立使用证据' : starterGoalEvidence(course, events, app.clock).independentUse ? '已有一次独立表达，后续记忆待验证' : starterGoalEvidence(course, events, app.clock).supportedUse ? '可以借助示范练习，独立使用待验证' : starterGoalEvidence(course, events, app.clock).understanding ? '已辨认意思，表达仍待练习' : '尚未取得这项学习证据' }}</p></li></ol><p>这些只代表当前小目标；听力、自然口语和整体水平不据此推定。</p><RouterLink :to="destination" class="button secondary">{{ next ? '回到当前小课' : '接续系统安排' }}</RouterLink></template>
    <template v-else>
    <p class="eyebrow">{{ next?.review ? '把以前的表达再用一次' : next ? '零基础也能跟上的小课' : '入门课之后的下一步' }}</p>
    <h2>{{ next?.lesson.goalZh ?? '基础小课已练过，接着系统安排学。' }}</h2>
    <p>{{ next?.review ? '先不看参考句，换个场景回应。卡住时仍有中文帮助；这不是补课债务。' : next ? '先听短句和中文示范，再练一个小动作。不会可以选句，不要求先读懂、写出未知的外语。' : '延迟回顾还没到时间，不用重复入门课填满今天。下一步接续已有的基础与分级练习；这不表示你已掌握一门语言。' }}</p>
    <RouterLink :to="destination" class="button primary">{{ next ? `${label} · 约 ${next.review ? 3 : next.lesson.minutes.quick} 分钟` : language === 'ja' ? '接着学假名与阅读' : '接着系统安排学下一步' }}</RouterLink>
    <details><summary>{{ courses.length }} 节基础小课：课程顺序和这次怎么练</summary><ol><li v-for="course in courses" :key="course.id">{{ course.titleZh }}<span v-if="course.foundation" class="help-text"> · {{ course.foundation.titleZh }}</span></li></ol><p>示范与中文解释 → 简单辨认 → 帮助下表达 → 换场景再用。短课可以先结束，下次接续；不是每课必须完成的作业清单。</p><p>基础小课按前置知识接续，字形与声音知识拆成可跳过的小步；到期时先做一个短回顾，再学新内容，不要求每天清空积压。完成这组以后接续已有分级真人课程、阅读、表达和复习；课数不代表流利度。教学文本与声音质量仍待人工复核。</p><RouterLink :to="{ path: `/course/${language}` }">查看小课讲解或回看已学内容</RouterLink><p>有基础或已有旧练习，可以继续下面原来的安排。旧回答、录音和复习都保留。</p></details>
    <p v-if="!next">现在可以接着下方的分级材料与表达练习；课堂会在后续时段安排换情境回顾。</p>
    </template>
  </section>
</template>
<style scoped>
.starter-entry{padding:clamp(20px,4vw,32px);margin-bottom:24px;max-width:950px}.starter-entry h2{font-size:clamp(20px,3vw,27px);line-height:1.5;margin:8px 0}.starter-entry details{margin-top:18px}.starter-entry .button{margin-top:8px;min-height:48px}@media(max-width:600px){.starter-entry .button{width:100%}}
</style>
