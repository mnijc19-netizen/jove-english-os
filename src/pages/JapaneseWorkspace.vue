<script setup lang="ts">
import StarterCourseEntry from '../components/StarterCourseEntry.vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router'
import { db as english, createLanguageDatabase } from '../db/db'
import { createJapaneseWorkspace } from '../db/japanese'
import { useJapaneseSpace } from '../stores/japanese-space'
import type { DailyPlan, Material, PlanTask, StudySession } from '../domain/types'
import { japaneseCourseNames, japaneseLessons, japaneseSource } from '../content/japanese'
import { japaneseKana, kanaSource } from '../content/japanese-kana'
import { TADOKU_GUIDE } from '../content/tadoku-catalog'

type WorkspaceMode = 'practice' | 'literacy' | 'reviews' | 'library' | 'progress'
const props = defineProps<{ mode: WorkspaceMode }>()
const headings = {
  practice: ['听说练习', '听懂一点，再说出自己的意思。', '系统把真人原声、回应和重说连成练习；不需要自己选择课程。'],
  literacy: ['假名与阅读', '先认识几个字，再慢慢读懂。', '假名是日语的基础字母。零基础先听读音、看字形，不要求一上来写日语句子。'],
  reviews: ['间隔复习', '学过以后，隔一段时间再想起来。', '这里只复习已经接触的内容。没有安排时不用加练，也不需要把所有旧内容重做一遍。'],
  library: ['学习材料', '知道在学什么，不必自己排课。', '这里只展示日语资源。每天打开「今日安排」，系统会按起点和已保存的练习选择下一步。'],
  progress: ['学习进度', '看见真实练过的内容。', '记录用于安排下次练习；完成次数不是语言水平，也不代表已经会听、会说或会写。'],
} as const
const heading = computed(() => headings[props.mode])
const router = useRouter(), space = useJapaneseSpace()
const database = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(database, english)
const ready = ref(false), busy = ref(false), error = ref(''), notice = ref('')
const plan = shallowRef<DailyPlan | null>(null), materials = shallowRef<Material[]>([]), sessions = shallowRef<StudySession[]>([])
const startingPoint = shallowRef<Awaited<ReturnType<typeof learning.startingPoint>>>()
const completedIds = shallowRef(new Set<string>())
let disposed = false, generation = 0, allowedNavigation = ''
let pending: Promise<void> = Promise.resolve()
const practiceKinds = new Set(['starter-classroom', 'japanese-practice', 'japanese-dialogue', 'japanese-reading', 'japanese-extensive', 'japanese-review'])
const firstTask = computed(() => plan.value?.tasks.find(task => !task.done && !task.optional))
const assigned = computed(() => (plan.value?.tasks ?? []).filter(task => !task.done && !task.optional && matchesTask(task)))
const unfinished = computed(() => sessions.value.filter(session => !session.completedAt && session.stage !== 'unavailable' && matchesSession(session)))
const finished = computed(() => sessions.value.filter(session => completedIds.value.has(session.id)))
const allUnfinished = computed(() => sessions.value.filter(session => !session.completedAt && session.stage !== 'unavailable'))
const materialCategory = ref('foundation')
const categories = [
  { id: 'foundation', label: '假名基础' }, { id: 'course', label: '生活听说课程' },
  { id: 'short', label: '原创短篇' }, { id: 'books', label: '原版多读' },
]
const catalog = computed(() => materials.value.filter(material => materialCategory.value === 'foundation' ? material.id.startsWith('ja-kana-')
  : materialCategory.value === 'course' ? material.id.startsWith('ja-irodori-') || material.id.startsWith('ja-starter-')
    : materialCategory.value === 'short' ? material.id.startsWith('ja-reading-') : material.id.startsWith('ja-tadoku-')))
const records = computed(() => sessions.value.slice(0, 30))
function matchesTask(task: PlanTask) {
  return props.mode === 'practice' ? ['listen', 'speak', 'retell', 'shadow'].includes(task.kind)
    : props.mode === 'literacy' ? task.kind === 'learn' : props.mode === 'reviews' ? task.kind === 'review' : true
}
function matchesSession(session: StudySession) {
  return props.mode === 'practice' ? ['starter-classroom', 'japanese-practice', 'japanese-dialogue'].includes(session.kind)
    : props.mode === 'literacy' ? ['japanese-reading', 'japanese-extensive'].includes(session.kind)
      : props.mode === 'reviews' ? session.kind === 'japanese-review' || session.kind === 'starter-classroom' && session.draft.purpose === 'review' : true
}
function sessionPath(session: StudySession) {
  return session.kind === 'starter-classroom' ? '/course/ja' : session.kind === 'japanese-dialogue' ? '/ja/talk' : session.kind === 'japanese-reading' ? '/ja/read'
    : session.kind === 'japanese-extensive' ? '/ja/books' : session.kind === 'japanese-review' ? '/ja/review' : '/ja'
}
function sessionDestination(session: StudySession) { return { path: sessionPath(session), query: { session: session.id } } }
function sessionLabel(session: StudySession) {
  return materials.value.find(material => material.id === session.materialId)?.title
    ?? ({ 'japanese-review': '学过表达的延迟回忆', 'japanese-dialogue': '生活情境对话' } as Record<string, string>)[session.kind] ?? '日语练习'
}
function activityLabel(session: StudySession) {
  return session.materialId?.startsWith('ja-kana-') ? '假名基础'
    : ({ 'starter-classroom': '示范、帮助与表达小课', 'japanese-practice': '真人听力与表达', 'japanese-dialogue': '情境对话', 'japanese-reading': '短篇理解与读法',
      'japanese-extensive': '原版多读（自报）', 'japanese-review': '间隔复习' } as Record<string, string>)[session.kind] ?? '日语练习'
}
function sourceLink(material: Material) {
  const lesson = japaneseLessons.find(lesson => lesson.id === material.id)
  if (lesson) return material.sourceUrl?.startsWith('https://www.irodori.jpf.go.jp/') ? material.sourceUrl : ''
  if (material.id.startsWith('ja-kana-')) return japaneseKana.find(exercise => exercise.id === material.id)?.kana?.sourceUrl ?? ''
  if (!material.id.startsWith('ja-tadoku-') || !material.sourceUrl) return ''
  try {
    const url = new URL(material.sourceUrl)
    return url.protocol === 'https:' && url.hostname === 'tadoku.org' && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}
function materialDetail(material: Material) {
  const lesson = japaneseLessons.find(lesson => lesson.id === material.id)
  return lesson ? `${japaneseCourseNames[lesson.course]} · ${lesson.canDo}`
    : material.id.startsWith('ja-starter-') ? '先听补充示范与中文讲解，再有帮助地表达；尚未测到的能力保持未知。'
    : material.externalReading ? `原站分级 ${material.externalReading.level} · 先选轻松读懂的内容，不强制写读后答案。`
      : material.id.startsWith('ja-kana-') ? '本站原创分组；真人读音在原站。先学字形与声音，不把看懂罗马字当作听懂日语。'
        : '本站原创日语短篇；认识基础假名后逐步安排，不是原版读物的改编测试。'
}
function dateLabel(value: number) { return new Date(value).toLocaleDateString('zh-CN') }
function clearSnapshot() { ready.value = false; plan.value = null; sessions.value = []; materials.value = []; completedIds.value = new Set(); startingPoint.value = undefined }
async function refresh() {
  const epoch = ++generation
  await learning.checkOwner()
  const [nextPlan, point, savedMaterials, savedSessions, events] = await Promise.all([
    learning.today(), learning.startingPoint(), database.materials.toArray(), database.sessions.toArray(), database.events.toArray(),
  ])
  await learning.checkOwner()
  if (disposed || epoch !== generation) return
  plan.value = nextPlan; startingPoint.value = point
  materials.value = savedMaterials.filter(material => material.language === 'ja' && material.approved)
  sessions.value = savedSessions.filter(session => practiceKinds.has(session.kind) && !session.id.startsWith('reading-conflict:')).sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt))
  completedIds.value = new Set(events.filter(event => event.type === 'TASK_COMPLETED' && event.sessionId).map(event => event.sessionId!))
  ready.value = true
}
async function openPage() { await space.ensure(); await learning.open(); await refresh() }
function act(action: () => Promise<void>) {
  if (busy.value || disposed) return
  busy.value = true; error.value = ''; notice.value = ''
  pending = action().catch(failure => {
    if (!disposed) { clearSnapshot(); error.value = failure instanceof Error ? failure.message : '日语区暂未打开；已有练习没有被清空。' }
  }).finally(() => { busy.value = false })
}
async function startNext() {
  const task = firstTask.value
  if (!task || !matchesTask(task)) return
  const saved = await learning.start(task.id)
  await learning.checkOwner()
  if (disposed) return
  const destination = sessionDestination(saved)
  allowedNavigation = router.resolve(destination).fullPath
  try { await router.push(destination) } finally { allowedNavigation = '' }
}
async function continueFromZero() {
  // Explicit self-report, not an ability score inferred from finishing lessons.
  await learning.confirmBeginnerStart()
  await refresh()
  if (!disposed && firstTask.value && matchesTask(firstTask.value)) await startNext()
  else if (!disposed) notice.value = firstTask.value ? '零基础起点已保存。今天先接续下面系统选好的当前任务；已有草稿仍然保留。'
    : '零基础起点已保存。今天的共用时间已安排完，或正在等到期复习；不用加做。已有草稿仍可继续，下次会接着安排基础教学。'
}
function safeLeave(to: { fullPath: string }) {
  if (busy.value && to.fullPath !== allowedNavigation) { notice.value = '正在打开或保存安排，请稍后再切换。'; return false }
}
onBeforeRouteLeave(safeLeave)
onBeforeRouteUpdate(safeLeave)
watch(() => space.revision, () => { if (ready.value && !busy.value) act(refresh) })
onMounted(() => act(openPage))
onBeforeUnmount(() => { disposed = true; generation++; void pending.finally(() => database.close()) })
</script>

<template>
  <div class="page japanese-workspace" :data-workspace-mode="mode">
    <div class="page-heading">
      <div><p class="eyebrow">日语学习 · {{ heading[0] }}</p><h1 tabindex="-1">{{ heading[1] }}</h1><p class="lede">{{ heading[2] }}</p></div>
      <RouterLink to="/ja" class="button secondary">返回今日安排</RouterLink>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }} <button class="text-button" :disabled="busy" @click="act(openPage)">重试打开日语区</button></p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="!ready && !error" role="status">正在读取日语安排和本机记录…</p>
    <template v-if="ready">
      <section v-if="!startingPoint" class="panel workspace-next">
        <h2>先告诉系统：我从零开始</h2><p>不懂五十音也没关系。回到今日安排确认零基础，系统会从假名的字形和声音带你入门，不必猜日语诊断题。</p>
        <template v-if="mode === 'literacy'"><p>如果你还不会假名，确认后就接着学五个字的字形和真人声音。不会做诊断也能继续；已有课和录音不删除，也不记成能力分数。</p><button class="button primary" :disabled="busy" @click="act(continueFromZero)">我还是零基础，接着学假名</button><RouterLink to="/ja" class="text-button">已有基础？查看可选起点了解</RouterLink></template>
        <RouterLink v-else to="/ja" class="button primary">从零基础开始</RouterLink>
      </section>
      <section v-else class="panel workspace-next">
        <p class="eyebrow">系统选好的下一步</p>
        <template v-if="firstTask">
          <h2>{{ firstTask.title }} · 约 {{ firstTask.minutes }} 分钟</h2><p>{{ firstTask.reason }}</p>
          <button v-if="matchesTask(firstTask) && ['practice', 'literacy', 'reviews'].includes(mode)" class="button primary" :disabled="busy" @click="act(startNext)">开始下一步</button>
          <RouterLink v-else to="/ja" class="button primary">回到今日安排，按顺序开始</RouterLink>
        </template>
        <template v-else><h2>今天没有新的必做安排</h2><p>可能已经学够今天的时间，或内容正在等待延迟复习。不用为了填满这个页面额外做题；已有草稿仍能继续。</p><RouterLink to="/ja" class="button secondary">查看今日安排</RouterLink></template>
      </section>

      <template v-if="['practice', 'literacy', 'reviews'].includes(mode)">
        <section v-if="unfinished.length" class="panel workspace-section">
          <h2>继续已保存的练习</h2><p>从原来的步骤恢复，草稿与录音不重新开始。</p>
          <ul class="workspace-list"><li v-for="session in unfinished" :key="session.id"><div><strong>{{ sessionLabel(session) }}</strong><small>{{ activityLabel(session) }} · {{ dateLabel(session.startedAt) }}</small></div><RouterLink :to="sessionDestination(session)" class="button secondary">继续练习</RouterLink></li></ul>
        </section>
        <section class="panel workspace-section">
          <h2>{{ mode === 'reviews' ? '今天的复习' : '今天已安排的内容' }}</h2>
          <p v-if="!assigned.length">{{ mode === 'reviews' ? '暂时没有必做复习。先学会一点新内容，系统会在之后安排回忆，不会要求零基础回忆还没教过的知识。' : mode === 'practice' ? '今天尚未安排这里的新练习。零基础先把当前假名基础学完；听说会随学习进程加入，不要求先背完整个五十音。' : '今天没有这里的新任务。系统按起点、已学内容和时间轮换安排，不要求每天全部练一遍。' }}</p>
          <ul v-else class="workspace-list"><li v-for="task in assigned" :key="task.id"><div><strong>{{ task.title }}</strong><small>约 {{ task.minutes }} 分钟 · {{ task.id === firstTask?.id ? '下一步' : '先完成前面的安排' }}</small></div></li></ul>
        </section>
        <section class="panel workspace-section"><h2>{{ mode === 'literacy' ? '零基础怎么学' : mode === 'practice' ? '这不是看完视频填表' : '复习不等于重新看一遍' }}</h2>
          <p>{{ mode === 'literacy' ? '先听可靠原声，认识少量字形，学过再辨认。逐步练平假名、片假名、节拍和词里的读法，然后过渡到短篇与轻松原版阅读。认识汉字不等于已经会日语读音。' : mode === 'practice' ? '先有能听懂的短输入，再用自己的意思回应；保存首答，获得提示后重说，隔天换场景再用。AI 是可选的文字指导，不会把语音识别或看过视频当成发音分数。' : '先独立想起学过的表达，再看参考、调整下次提醒。听、读、说的证据分开；还没听过的声音不会因为认出文字就算会了。' }}</p>
        </section>
      </template>

      <template v-else-if="mode === 'library'">
        <section class="panel workspace-section">
          <h2>已收录的日语材料</h2><p>资源按难度逐步使用。目录是供了解的，不是让你自己编课程；打开原站也不会自动记成学会或完成。</p>
          <label for="japanese-material-category">查看哪类材料</label><select id="japanese-material-category" v-model="materialCategory"><option v-for="category in categories" :key="category.id" :value="category.id">{{ category.label }}</option></select>
          <p role="status">{{ catalog.length }} 项已收录材料 · 不代表已经学过</p>
          <p v-if="!catalog.length">这类材料暂未收录，已有练习和今天的安排仍保留。</p>
          <ul v-else class="workspace-list"><li v-for="material in catalog" :key="material.id"><div><strong :lang="material.externalReading ? 'ja' : 'zh-CN'">{{ material.title }}</strong><p>{{ materialDetail(material) }}</p><small>{{ material.sourceLabel }} · {{ material.id.startsWith('ja-kana-') || material.id.startsWith('ja-reading-') || material.id.startsWith('ja-starter-') ? '本站原创练习' : '原站资源，未复制音视频' }}</small></div><RouterLink v-if="material.id.startsWith('ja-starter-')" :to="{ path: '/course/ja', query: { lesson: material.id } }" class="button secondary">查看课堂</RouterLink><a v-else-if="sourceLink(material)" :href="sourceLink(material)" target="_blank" rel="noopener noreferrer" class="button secondary">查看原站资源 ↗</a></li></ul>
        </section>
        <section class="panel workspace-section"><h2>原声与阅读来源</h2><p>假名真人读音：MARUGOTO Plus；生活对话：いろどり；原版多读：Tadoku。音视频留在原站，不大量占用网站存储，也不复制或改编原站读物做题。</p><div class="source-links"><a :href="kanaSource.hiragana" target="_blank" rel="noopener noreferrer">假名原声 ↗</a><a :href="japaneseSource.credits" target="_blank" rel="noopener noreferrer">生活课程与来源说明 ↗</a><a :href="TADOKU_GUIDE" target="_blank" rel="noopener noreferrer">原版多读指南 ↗</a></div></section>
      </template>

      <template v-else-if="mode === 'progress'">
        <StarterCourseEntry language="ja" view="progress" />
        <section class="panel workspace-section"><h2>日语已保存的学习活动</h2><dl class="workspace-counts"><div><dt>已保存练习</dt><dd>{{ sessions.length }}</dd></div><div><dt>已完成任务记录</dt><dd>{{ finished.length }}</dd></div><div><dt>可继续的练习</dt><dd>{{ allUnfinished.length }}</dd></div></dl><p>这些是实际保存的活动与完成事件，不是能力分数。假名字形、理解、表达和发音不能混为一谈；尚未测到的能力仍未知。</p></section>
        <section class="panel workspace-section"><h2>最近的日语练习</h2><p v-if="!records.length">还没有保存的日语练习。先从今日安排开始，学完或中途保存后，这里会显示真实记录。</p><ul v-else class="workspace-list"><li v-for="session in records" :key="session.id"><div><strong>{{ sessionLabel(session) }}</strong><small>{{ activityLabel(session) }} · {{ dateLabel(session.completedAt ?? session.startedAt) }} · {{ completedIds.has(session.id) ? '已完成任务，非掌握认证' : session.completedAt || session.stage === 'unavailable' ? '已结束或暂停，非完成证明' : '进行中，草稿保留' }}</small></div><RouterLink v-if="!session.completedAt && session.stage !== 'unavailable'" :to="sessionDestination(session)" class="button secondary">继续练习</RouterLink><RouterLink v-else-if="completedIds.has(session.id)" :to="sessionDestination(session)" class="text-button">查看已保存练习</RouterLink></li></ul><p v-if="sessions.length > records.length">这里只显示最近 {{ records.length }} 次；历史记录没有被删除。</p></section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.japanese-workspace h1 { font-size: clamp(28px, 4vw, 44px); }
.lede { max-width: 720px; line-height: 1.8; }
.workspace-next, .workspace-section { margin-bottom: 22px; padding: 26px; }
.workspace-next h2, .workspace-section h2 { font-size: 21px; line-height: 1.5; margin: 0 0 12px; }
.workspace-next p, .workspace-section p { line-height: 1.8; color: var(--muted); }
.workspace-list { list-style: none; margin: 16px 0 0; padding: 0; }
.workspace-list li { display: flex; align-items: center; justify-content: space-between; gap: 20px; border-top: 1px solid var(--line); padding: 18px 0; }
.workspace-list li > div { min-width: 0; }
.workspace-list strong { overflow-wrap: anywhere; line-height: 1.6; }
.workspace-list small { display: block; color: var(--muted); line-height: 1.7; margin-top: 5px; }
.workspace-list p { margin: 6px 0; }
.workspace-list .button { flex-shrink: 0; }
.workspace-counts { display: flex; flex-wrap: wrap; gap: 32px; margin: 24px 0; }
.workspace-counts dt { color: var(--muted); font-size: 13px; }
.workspace-counts dd { margin: 8px 0 0; font-size: 28px; }
.source-links { display: flex; flex-wrap: wrap; gap: 10px 24px; }
.source-links a { display: inline-flex; align-items: center; min-height: 44px; color: var(--accent); }
select { margin: 10px 0; max-width: 100%; }
@media (max-width: 600px) {
  .page-heading { flex-direction: column; gap: 12px; }
  .page-heading > .button { margin-top: 0; }
  .workspace-next, .workspace-section { padding: 20px; }
  .workspace-list li { align-items: flex-start; flex-direction: column; gap: 10px; }
}
</style>
