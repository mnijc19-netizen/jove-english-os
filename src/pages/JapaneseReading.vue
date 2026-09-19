<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router'
import { db as english, createLanguageDatabase } from '../db/db'
import { createJapaneseWorkspace } from '../db/japanese'
import { japaneseReadingDraft, japaneseReadingResult, type JapaneseReadingDraft } from '../domain/japanese-reading'
import { japaneseExtensiveReading, tadokuGuide } from '../content/japanese-reading'
import { useJapaneseSpace } from '../stores/japanese-space'
import type { StudySession } from '../domain/types'

const route = useRoute(), space = useJapaneseSpace(), database = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(database, english)
const state = shallowRef<Awaited<ReturnType<typeof learning.reading.read>>>(), draft = ref<JapaneseReadingDraft>()
const busy = ref(false), dirty = ref(false), error = ref(''), notice = ref(''), retained = ref('')
const reading = computed(() => state.value?.reading), locked = computed(() => draft.value?.lockedAt !== undefined)
const results = computed(() => reading.value && draft.value ? japaneseReadingResult(reading.value, draft.value) : undefined)
const recommendation = computed(() => japaneseExtensiveReading[reading.value?.band ? 1 : 0]!)
let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, generation = 0, saves: Promise<void> = Promise.resolve()
function restore(saved: StudySession) {
  if (!state.value) return
  state.value = { ...state.value, session: saved, draft: japaneseReadingDraft.parse(saved.draft) }
  draft.value = japaneseReadingDraft.parse(saved.draft); dirty.value = false
}
async function load(id: unknown) {
  if (typeof id !== 'string') throw new Error('请从日语今日安排进入阅读。')
  const current = ++generation, saved = await learning.reading.read(id)
  if (disposed || current !== generation) return
  state.value = saved; restore(saved.session)
}
async function act(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await action() } catch (failure) { error.value = failure instanceof Error ? failure.message : '保存未成功，请保留本页后重试。' }
  finally { busy.value = false }
}
function changed() {
  dirty.value = true; notice.value = '正在保存…'; clearTimeout(timer)
  timer = setTimeout(() => { void flush().catch(failure => { error.value = failure.message }) }, 400)
}
function flush(): Promise<void> {
  clearTimeout(timer)
  saves = saves.catch(() => {}).then(async () => {
    if (!dirty.value || !draft.value || !state.value || state.value.session.completedAt) return
    const before = JSON.stringify(draft.value), id = state.value.session.id
    const saved = await learning.reading.save(id, JSON.parse(before) as JapaneseReadingDraft)
    if (disposed || id !== state.value?.session.id) return
    const unchanged = JSON.stringify(draft.value) === before
    state.value = { ...state.value, session: saved, draft: japaneseReadingDraft.parse(saved.draft) }
    draft.value!.revision = Number(saved.draft.revision)
    if (!unchanged) { changed(); return }
    dirty.value = false; notice.value = '首答与笔记已保存在本机'
  })
  return saves
}
async function transition(action: 'help' | 'lock' | 'finish') {
  await flush()
  if (!state.value || !draft.value) return
  const id = state.value.session.id
  const saved = action === 'finish' ? await learning.reading.finish(id, draft.value.revision)
    : await learning.reading.save(id, draft.value, action)
  if (!disposed && state.value?.session.id === id) restore(saved)
}
async function recover() {
  clearTimeout(timer); await saves.catch(() => {})
  if (draft.value) retained.value = JSON.stringify({ meaning: draft.value.meaning, kana: draft.value.kana, note: draft.value.note }, null, 2)
  await load(route.query.session); notice.value = '已重新载入，原文字副本保留在下方。'
}
async function safeLeave() {
  if (busy.value) return false
  busy.value = true
  try { await flush(); if (dirty.value) await flush(); return !dirty.value }
  catch { error.value = '还有未保存的回答，请重试或保留副本后重新载入。'; return false }
  finally { busy.value = false }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = '' } }
async function open() { await space.ensure(); await learning.open(); await load(route.query.session) }
onBeforeRouteLeave(safeLeave)
onBeforeRouteUpdate(async to => {
  if (!await safeLeave()) return false
  busy.value = true
  try { await load(to.query.session); return true }
  catch (failure) { error.value = failure instanceof Error ? failure.message : '无法打开阅读'; return false }
  finally { busy.value = false }
})
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); void act(open) })
onBeforeUnmount(() => {
  disposed = true; generation++; clearTimeout(timer); window.removeEventListener('beforeunload', beforeUnload)
  void saves.finally(() => database.close()).catch(() => {})
})
</script>

<template>
  <div class="page ja-reading">
    <div class="page-heading"><div><p class="eyebrow">JAPANESE · 理解与读法</p><h1 tabindex="-1">先读懂，再试着读出来。</h1></div><RouterLink to="/ja" class="text-button">返回日语今日安排</RouterLink></div>
    <p class="help-text">约 5 分钟 · 中文解释任务，日语承载内容。这里检查文字理解和假名拼写，不测听力、发音或口语水平。</p>
    <p class="help-text" role="status">{{ notice || `日语：${space.status}` }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="error" class="row wrap"><button class="text-button" :disabled="busy" @click="act(state ? recover : open)">{{ state ? '重新载入（保留本页文字副本）' : '重试打开阅读' }}</button><button v-if="dirty" class="text-button" :disabled="busy" @click="act(flush)">重试保存</button></div>
    <details v-if="retained"><summary>重新载入前的文字副本</summary><pre>{{ retained }}</pre></details>
    <section v-if="state?.conflicts.length" class="panel reading-panel"><h2>另一台设备的回答也保留了</h2><p>首答按整份提交保存，没有把两个版本拼成更高成绩。以下副本只供对照，不重复计分；可复制文字留作下次练习。</p><details v-for="copy in state.conflicts" :key="copy.id"><summary>查看保留的答案与笔记</summary><pre>{{ JSON.stringify({ meaning: copy.draft.meaning, kana: copy.draft.kana, note: copy.draft.note }, null, 2) }}</pre></details></section>
    <section v-if="reading && draft && state" class="panel reading-panel">
      <p class="eyebrow">{{ ['短句与信息', '顺序与条件', '原因与转折'][reading.band] }} · 本站原创</p>
      <p class="help-text">这是材料分档，不是你的语言等级。系统也会安排新难度的短篇试读；觉得吃力可反馈，下次会减轻难度。</p>
      <h2>{{ reading.title }}</h2>
      <p class="passage" lang="ja">{{ reading.passage }}</p>
      <template v-if="!state.session.completedAt">
        <p v-if="draft.seen" class="help-text">这是一次间隔后的重读，重复答对不会冒充新材料上的独立理解。</p>
        <template v-if="!locked">
          <p class="help-text">先抓大意，不必逐字翻译。不会的题可以留空再对照。</p>
          <button v-if="!draft.helped" class="text-button" :disabled="busy" @click="act(() => transition('help'))">需要帮助：展开中文与假名</button>
          <div v-if="draft.helped" class="support"><p>{{ reading.meaningZh }}</p><p v-for="word in reading.words" :key="word.text"><span lang="ja">{{ word.text }}（{{ word.reading }}）</span> · {{ word.meaning }}</p><p class="help-text">借助提示学习很正常；这次不会记录为独立答对。</p></div>
          <fieldset v-for="(q, index) in reading.questions" :key="q.prompt" :disabled="busy"><legend>{{ index + 1 }}. {{ q.prompt }}</legend><label v-for="choice in q.choices" :key="choice" class="choice"><input v-model="draft.meaning[index]" type="radio" :name="`meaning-${index}`" :value="choice" @change="changed">{{ choice }}</label></fieldset>
          <h3>单独试读法：不按中文读音猜汉字</h3>
          <p class="help-text">写出这两个词在文中的假名读法，可用平假名或片假名。想不起来可以留空，不要求罗马字。</p>
          <label v-for="(word, index) in reading.words" :key="word.text" class="word-label"><span lang="ja">{{ word.text }} 的假名读法</span><input v-model="draft.kana[index]" lang="ja" maxlength="200" :disabled="busy" autocomplete="off" @input="changed"></label>
          <button class="button primary" :disabled="busy" @click="act(() => transition('lock'))">保存首答，再看解析</button>
        </template>
        <template v-else-if="results">
          <h3>理解和读法分开看</h3>
          <p>本篇理解参考匹配 {{ results.meaning.filter(Boolean).length }}/2 · 假名参考匹配 {{ results.kana.filter(Boolean).length }}/2{{ draft.helped ? '（使用过帮助）' : '' }}</p>
          <p>{{ reading.meaningZh }}</p>
          <p v-for="(q, index) in reading.questions" :key="q.prompt">{{ q.prompt }}<br>首答：{{ draft.meaning[index] || '暂时跳过' }} · 参考：{{ q.answer }}</p>
          <p v-for="(word, index) in reading.words" :key="word.text"><span lang="ja">{{ word.text }} → {{ word.reading }}</span> · {{ word.meaning }}<br>首答：{{ draft.kana[index] || '暂时跳过' }}{{ results.kana[index] ? '（匹配一种参考读法）' : '（未匹配参考，请对照）' }}</p>
          <p class="help-text">同一个汉字可能有不同读法；这里只对照当前词语的书面读法，不判断声调或发音。</p>
          <label class="word-label">换一个情境用一用（也可先用中文记下调整）<textarea v-model="draft.note" rows="3" maxlength="2000" :disabled="busy" @input="changed" /></label>
          <p>{{ reading.transfer }}</p>
          <label class="word-label">这篇读起来怎么样？<select v-model="draft.effort" :disabled="busy" @change="changed"><option value="hard">有些吃力，下次轻一点</option><option value="okay">难度合适</option><option value="easy">比较轻松</option></select></label>
          <button class="button primary" :disabled="busy || !draft.note.trim()" @click="act(() => transition('finish'))">保存阅读，安排下次回顾</button>
        </template>
      </template>
      <template v-else><h3>这次阅读已保存</h3><p>下次回顾不早于 {{ new Date(draft.dueAt!).toLocaleDateString() }}，会结合当天总时间安排，不会把复习堆成欠债。</p><RouterLink to="/ja" class="button primary">继续今日安排</RouterLink></template>
    </section>
    <section v-if="state?.session.completedAt" class="panel reading-panel">
      <h2>有余力时，轻松多读一点</h2>
      <p>推荐从《{{ recommendation.title }}》（出版社 Level {{ recommendation.level }}）开始。只看原版，不必翻译每一句，也没有读后测验；太难或没兴趣就换一本。</p>
      <div class="row wrap"><a :href="recommendation.url" target="_blank" rel="noopener noreferrer" class="button secondary">打开推荐原版</a><a href="https://tadoku.org/japanese/en/free-books-en/" target="_blank" rel="noopener noreferrer" class="text-button">不合适？换一本免费读物</a></div>
      <p class="help-text">来源：NPO 多言語多読 · 外链，不下载托管；打开链接不算完成阅读或听力证据。<a :href="tadokuGuide" target="_blank" rel="noopener noreferrer">出版社使用说明</a></p>
    </section>
  </div>
</template>

<style scoped>
.reading-panel { padding: clamp(20px, 4vw, 36px); margin-top: 24px; }
.passage { font-size: 1.2rem; line-height: 2.1; overflow-wrap: anywhere; }
fieldset { border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin: 24px 0; }
.choice { display: flex; align-items: center; gap: 10px; min-height: 44px; }
input[type=radio] { width: auto; }
.word-label { display: grid; gap: 8px; margin: 20px 0; }
.support { border-left: 3px solid var(--border); padding-left: 16px; }
textarea { resize: vertical; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
</style>
