<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useCloud } from '../stores/cloud'
import { readAccountServices, saveAccountPreferences, type AccountPreferences, type AccountUsage } from '../cloud/services'
import { costDisplayRate, estimatedCny } from '../domain/cost-display'

const cloud = useCloud(), usage = ref<AccountUsage>(), preferences = ref<AccountPreferences>()
const busy = ref(false), message = ref(''), error = ref('')
let generation = 0, controller: AbortController | undefined
const periods = ['today', 'week', 'month'] as const
async function refresh() {
  const token = ++generation
  controller?.abort(); controller = new AbortController()
  busy.value = true; error.value = ''; message.value = ''
  try {
    const result = await readAccountServices(undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
    if (token !== generation) return
    preferences.value = result.preferences; usage.value = result.usage
  } catch { if (token === generation) error.value = 'Account usage could not be refreshed. These are not new confirmed totals.' }
  finally { if (token === generation) busy.value = false }
}
async function save(field: keyof AccountPreferences, event: Event) {
  if (busy.value || !cloud.userId) return
  const element = event.target as HTMLInputElement | HTMLSelectElement
  if (field.endsWith('_usd') && !element.value.trim()) {
    if (preferences.value) element.value = String(preferences.value[field])
    error.value = 'Enter an explicit budget amount. Nothing was changed.'; return
  }
  const patch = { [field]: field.endsWith('_usd') ? Number(element.value) : field === 'prosody_enabled' ? (element as HTMLInputElement).checked : element.value }
  const token = generation
  controller?.abort(); controller = new AbortController()
  busy.value = true; error.value = ''; message.value = ''
  try {
    const saved = await saveAccountPreferences(patch, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
    if (token !== generation) return
    preferences.value = saved
    message.value = 'Saved to your account. This preference applies across devices.'
  } catch {
    if (token !== generation) return
    if (preferences.value) {
      if (field === 'prosody_enabled') (element as HTMLInputElement).checked = preferences.value.prosody_enabled
      else element.value = String(preferences.value[field])
    }
    error.value = 'The change was not confirmed. Reconnect and refresh before trying again.'
  } finally { if (token === generation) busy.value = false }
}
watch(() => cloud.userId, owner => {
  ++generation; controller?.abort(); preferences.value = undefined; usage.value = undefined; error.value = ''; message.value = ''; busy.value = false
  if (owner) void refresh()
}, { immediate: true })
onBeforeUnmount(() => { ++generation; controller?.abort() })
</script>

<template>
  <div class="panel settings-panel">
    <h3>AI 费用与云端录音 · 所有设备共用</h3>
    <p v-if="!cloud.userId" class="help-text">登录后可以查看账号实际用量、限额和录音保留设置。本地课程不用付费。</p>
    <template v-else>
      <p class="help-text">账单日、自然周和自然月按 UTC 统计。已知费用与尚未确认的预留额度分别展示。</p>
      <div v-if="usage" class="table-scroll" tabindex="0" aria-label="Account service usage">
        <table>
          <thead><tr><th scope="col">时段</th><th scope="col">已知费用（约人民币）</th><th scope="col">未确认预留（约人民币）</th><th scope="col">待确认项</th></tr></thead>
          <tbody><tr v-for="period in periods" :key="period"><th scope="row">{{ { today: '今天', week: '本周', month: '本月' }[period] }}</th><td>¥{{ estimatedCny(usage[period].reportedUsd) }}<small> / ${{ usage[period].reportedUsd.toFixed(4) }}</small></td><td>¥{{ estimatedCny(usage[period].heldUsd) }}<small> / ${{ usage[period].heldUsd.toFixed(4) }}</small></td><td>{{ usage[period].unknownCount }}</td></tr></tbody>
        </table>
      </div>
      <p class="help-text">人民币仅按 {{ costDisplayRate.date }} 的<a :href="costDisplayRate.source" target="_blank" rel="noopener noreferrer">欧洲央行参考汇率</a>粗略换算，不是实时汇率。实际扣费和服务端限额以美元为准；没有修改你原有的限额。</p>
      <p class="help-text">两门语言的 AI、转写、合成语音和内容请求共用额度；未上报费用不等于零。托管、存储和网络账单不包含在这里。</p>
      <div v-if="preferences" class="field-grid">
        <label>账号每日上限（美元，约 ¥{{ estimatedCny(preferences.daily_budget_usd) }}）<input type="number" min="0" max="1000" step="0.1" :value="preferences.daily_budget_usd" :disabled="busy" @change="save('daily_budget_usd', $event)" /></label>
        <label>账号每月上限（美元，约 ¥{{ estimatedCny(preferences.monthly_budget_usd) }}）<input type="number" min="0" max="10000" step="1" :value="preferences.monthly_budget_usd" :disabled="busy" @change="save('monthly_budget_usd', $event)" /></label>
        <label>云端录音保留<select :value="preferences.recording_retention" :disabled="busy" @change="save('recording_retention', $event)">
          <option value="minimal">少量保留：评估与近期参考练习</option><option value="assessment-only">只保留评估原件</option><option value="more-history">保留更多历史：30 天</option>
        </select></label>
        <details><summary>可选的专项评估设置</summary><label class="check-label"><input type="checkbox" :checked="preferences.prosody_enabled" :disabled="busy" @change="save('prosody_enabled', $event)" />仅在服务能力已验证时启用专项反馈</label><p class="help-text">不属于入门课的要求；普通文字或转写不会得到发音、语调分数。</p></details>
      </div>
      <p class="help-text">未完成练习的原件受保护。额度为零或用完时停止新付费请求，本地教学仍能继续。</p>
      <p class="help-text">到期的历史云副本会在联网同步时清理，保留时间从录制日起计算。未完成练习、评估和导入音频受保护，本机原件不会被自动删除。</p>
      <button class="button secondary" :disabled="busy" @click="refresh">{{ busy ? '正在核对…' : '刷新账号用量' }}</button>
    </template>
    <p v-if="message" class="success-note" role="status">{{ message }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </div>
</template>
