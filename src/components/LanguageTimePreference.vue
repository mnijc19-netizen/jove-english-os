<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { db } from '../db/db'
import { languagePreferenceId, languagePreferenceSchema } from '../db/language-day'
import { useCloud } from '../stores/cloud'
import { useApp } from '../stores/app'
const cloud = useCloud(), app = useApp(), primary = ref<'en' | 'ja' | 'balanced'>('balanced'), share = ref(0.7), busy = ref(false), message = ref('')
onMounted(async () => {
  const parsed = languagePreferenceSchema.safeParse((await db.sessions.get(languagePreferenceId))?.draft)
  if (parsed.success) { primary.value = parsed.data.primaryLanguage; share.value = parsed.data.primaryShare }
})
async function save() {
  if (busy.value) return
  busy.value = true; message.value = ''
  try {
    const draft = languagePreferenceSchema.parse({ version: 1, primaryLanguage: primary.value, primaryShare: share.value })
    await cloud.withLocalDataChange(async () => {
      const existing = await db.sessions.get(languagePreferenceId)
      await db.sessions.put({ id: languagePreferenceId, kind: 'language-time-preference', stage: 'saved',
        startedAt: existing?.startedAt ?? Date.now(), draft })
    })
    await app.refresh(); message.value = '已保存。两门语言仍共用首页的总时间，已开始的练习不会被删除。'
  } catch { message.value = '未确认保存，请保留当前选项并重试。原来的安排没有清空。' }
  finally { busy.value = false }
}
</script>
<template>
  <section class="panel settings-panel" lang="zh-CN"><h3>两门语言怎么分配时间</h3><p>你只决定主要语言和总时间，具体课程与复习由系统安排。另一门保持小量练习，不要求英日各学一半。</p><label>主要学习<select v-model="primary" :disabled="busy"><option value="balanced">暂时均衡</option><option value="en">英语为主</option><option value="ja">日语为主</option></select></label><label v-if="primary !== 'balanced'">主要语言的大致比例<select v-model="share" :disabled="busy"><option :value="0.6">约六成</option><option :value="0.7">约七成</option><option :value="0.8">约八成</option><option :value="0.9">约九成</option></select></label><p class="help-text">这是安排偏好，不是强制分钟数；会照顾已开始的课和必要复习，切换不会产生另一份预算。</p><button class="button secondary" :disabled="busy" @click="save">保存时间偏好</button><p role="status">{{ message }}</p></section>
</template>
