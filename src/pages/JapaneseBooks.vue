<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router'
import { db as english, createLanguageDatabase } from '../db/db'
import { createJapaneseWorkspace } from '../db/japanese'
import { extensiveDraftSchema, type ExtensiveDraft } from '../domain/japanese-extensive'
import { TADOKU_GUIDE } from '../content/tadoku-catalog'
import { useJapaneseSpace } from '../stores/japanese-space'

const route = useRoute(), space = useJapaneseSpace(), database = createLanguageDatabase('ja'), learning = createJapaneseWorkspace(database, english)
const state = shallowRef<Awaited<ReturnType<typeof learning.books.read>>>(), draft = ref<ExtensiveDraft>()
const busy = ref(false), dirty = ref(false), error = ref(''), notice = ref(''), retained = ref('')
let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, generation = 0, saves: Promise<void> = Promise.resolve()
async function load(id: unknown) {
  if (typeof id !== 'string') throw new Error('请从日语今日安排进入原版多读。')
  const current = ++generation, saved = await learning.books.read(id)
  if (disposed || current !== generation) return
  state.value = saved; draft.value = extensiveDraftSchema.parse(saved.draft); dirty.value = false
}
async function act(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await action() } catch (failure) { error.value = failure instanceof Error ? failure.message : '保存未成功，请保留本页重试。' }
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
    const saved = await learning.books.save(id, JSON.parse(before) as ExtensiveDraft)
    if (disposed || id !== state.value?.session.id) return
    const unchanged = JSON.stringify(draft.value) === before
    state.value = { ...state.value, session: saved, draft: extensiveDraftSchema.parse(saved.draft) }
    draft.value!.revision = Number(saved.draft.revision)
    draft.value!.stamp = String(saved.draft.stamp)
    if (!unchanged) { changed(); return }
    dirty.value = false; notice.value = '书签和读感已保存在本机'
  })
  return saves
}
async function transition(action: 'finish' | 'too-hard' | 'not-interesting' | 'unavailable') {
  await flush()
  if (!state.value || !draft.value) return
  const id = state.value.session.id
  if (action === 'finish') await learning.books.finish(id, draft.value)
  else await learning.books.switchBook(id, draft.value, action)
  await load(id); notice.value = action === 'finish' ? '阅读记录已保存' : '已换一本，之前的书签和读感仍保留在阅读记录中'
}
async function recover() {
  clearTimeout(timer); await saves.catch(() => {})
  if (draft.value) retained.value = JSON.stringify({ bookmark: draft.value.bookmark, note: draft.value.note }, null, 2)
  await load(route.query.session); notice.value = '已重新载入；原文字副本保留在下方。'
}
async function safeLeave() {
  if (busy.value) return false
  busy.value = true
  try { await flush(); if (dirty.value) await flush(); return !dirty.value }
  catch { error.value = '还有未保存的书签或读感，请重试保存。'; return false }
  finally { busy.value = false }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(safeLeave)
onBeforeRouteUpdate(async to => {
  if (!await safeLeave()) return false
  busy.value = true
  try { await load(to.query.session); return true }
  catch (failure) { error.value = failure instanceof Error ? failure.message : '无法恢复阅读'; return false }
  finally { busy.value = false }
})
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  void act(async () => { await space.ensure(); await learning.open(); await load(route.query.session) })
})
onBeforeUnmount(() => {
  disposed = true; generation++; clearTimeout(timer); window.removeEventListener('beforeunload', beforeUnload)
  void saves.finally(() => database.close()).catch(() => {})
})
</script>

<template>
  <div class="page">
    <div class="page-heading"><div><p class="eyebrow">JAPANESE · 原版多读</p><h1 tabindex="-1">轻松读懂一点，就很好。</h1></div><RouterLink to="/ja" class="text-button">返回今日安排</RouterLink></div>
    <p>只读原版，不必逐句翻译。跳过暂时不懂的词；太难或不感兴趣就换。时间到了就停，不必一次读完。</p>
    <p v-if="error" role="alert">{{ error }} <button class="text-button" :disabled="busy" @click="act(recover)">保留副本并重新载入</button></p>
    <p v-if="notice" class="help-text" role="status">{{ notice }}</p>
    <pre v-if="retained" class="copy">{{ retained }}</pre>
    <section v-if="state && draft" class="panel books-panel">
      <p class="eyebrow">出版社 Level {{ state.book.externalReading?.level }} · 今天约 {{ draft.minutes }} 分钟</p>
      <h2 lang="ja">{{ state.book.title }}</h2>
      <p class="help-text">来源：NPO 多言語多読。本站只保留原版链接和你的阅读记录，不下载托管书籍、不改编或添加测验。出版社等级不是你的能力评级。</p>
      <a :href="state.book.sourceUrl" target="_blank" rel="noopener noreferrer" class="button primary">打开原版读物</a>
      <p class="help-text">{{ state.book.externalReading && state.book.externalReading.checkedAt < Date.now() - 90 * 86400000 ? '这本书的目录核验已过期；当前书签仍保留，原站不通时可换书。' : '在原站阅读，回来存书签。系统看不到你是否读过，不会自动记为完成。' }}</p>
      <template v-if="!state.session.completedAt">
        <label>读到哪里了？（选填）<input v-model="draft.bookmark" maxlength="500" placeholder="例如：第 4 页，下次从这里继续" :disabled="busy" @input="changed" /></label>
        <label>这次实际阅读了几分钟？<input v-model.number="draft.minutesRead" type="number" min="0" :max="draft.minutes - draft.spentMinutes" step="1" :disabled="busy" @input="changed" /></label>
        <p v-if="draft.spentMinutes" class="help-text">今天换书前已记录 {{ draft.spentMinutes }} 分钟，剩余最多 {{ draft.minutes - draft.spentMinutes }} 分钟。</p>
        <label>读起来怎么样？<select v-model="draft.effort" :disabled="busy" @change="changed"><option value="okay">大意能跟上</option><option value="easy">轻松、读得下去</option><option value="hard">经常卡住，下次浅一点</option></select></label>
        <label>这本书的进度<select v-model="draft.outcome" :disabled="busy" @change="changed"><option value="continue">还没读完，下次接着读</option><option value="finished">已经读完，下次选新书</option></select></label>
        <details><summary>留一句自己的读感（选填）</summary><label>个人笔记，不是测验<textarea v-model="draft.note" maxlength="2000" rows="3" :disabled="busy" placeholder="例如：配图让我看懂了，很想知道后面发生什么。" @input="changed" /></label></details>
        <button class="button primary" :disabled="busy || draft.minutesRead < 1" @click="act(() => transition('finish'))">保存今天的阅读，下次自动接续</button>
        <details><summary>这本不合适？系统帮我换</summary><p>不是失败，不用勉强读完。当前书签和读感会先保存。</p><div class="row wrap"><button class="button secondary" :disabled="busy" @click="act(() => transition('too-hard'))">太难，换浅一点</button><button class="button secondary" :disabled="busy" @click="act(() => transition('not-interesting'))">没兴趣，换一本</button><button class="text-button" :disabled="busy" @click="act(() => transition('unavailable'))">原站无法打开</button></div></details>
      </template>
      <template v-else><h3>今天的阅读已保存</h3><p>{{ draft.outcome === 'continue' ? '书签已留下，下次会结合难度和你的读感安排续读。' : '下一次会自动挑选合适的新书，不必自己找材料。' }} 读完一本不等于掌握了全部词语；这里不增加听说或考试能力分数。</p><RouterLink to="/ja" class="button primary">继续今日安排</RouterLink></template>
      <p class="help-text"><a :href="TADOKU_GUIDE" target="_blank" rel="noopener noreferrer">出版社原版多读和使用说明</a></p>
      <details v-if="state.visits.length"><summary>查看这次已保存的书签和读感</summary><div v-for="visit in state.visits" :key="visit.event.id"><p>出版社 Level {{ visit.data.level }} · 自报 {{ visit.data.minutesRead }} 分钟</p><p>书签：{{ visit.data.bookmark || '未填写' }}</p><p>读感：{{ visit.data.note || '未填写' }}</p></div></details>
    </section>
    <section v-if="state?.conflicts.length" class="panel books-panel"><h2>另一台设备的阅读记录</h2><p>两份记录有差异，均已保留，不会拼成一份虚假的完成记录。请查看并保留需要的书签。</p><pre v-for="copy in state.conflicts" :key="copy.id" class="copy">{{ JSON.stringify({ book: copy.draft.book, bookmark: copy.draft.bookmark, note: copy.draft.note, minutesRead: copy.draft.minutesRead, outcome: copy.draft.outcome }, null, 2) }}</pre></section>
  </div>
</template>

<style scoped>
.books-panel { padding: clamp(20px, 4vw, 36px); margin-top: 24px; display: grid; gap: 16px; }
label { display: grid; gap: 8px; }
details { padding-block: 8px; }
summary { cursor: pointer; min-height: 44px; }
.copy { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
