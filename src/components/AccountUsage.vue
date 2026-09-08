<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useCloud } from '../stores/cloud'
import { readAccountServices, saveAccountPreferences, type AccountPreferences, type AccountUsage } from '../cloud/services'

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
    <h3>Account services — all devices</h3>
    <p v-if="!cloud.userId" class="help-text">Sign in above to view account usage and cloud recording preferences.</p>
    <template v-else>
      <p class="help-text">Today, calendar week and calendar month use UTC. Known charges and unconfirmed budget holds are shown separately.</p>
      <div v-if="usage" class="table-scroll" tabindex="0" aria-label="Account service usage">
        <table>
          <thead><tr><th scope="col">Period</th><th scope="col">Reported USD</th><th scope="col">Held USD</th><th scope="col">Unconfirmed</th></tr></thead>
          <tbody><tr v-for="period in periods" :key="period"><th scope="row">{{ period }}</th><td>{{ usage[period].reportedUsd.toFixed(4) }}</td><td>{{ usage[period].heldUsd.toFixed(4) }}</td><td>{{ usage[period].unknownCount }}</td></tr></tbody>
        </table>
      </div>
      <p class="help-text">AI, transcription, speech and content requests share this budget. Unreported charges are not zero. Hosting, storage and network bills are separate and are not reported by these APIs; check the provider billing page for the complete bill.</p>
      <div v-if="preferences" class="field-grid">
        <label>Account daily limit (USD)<input type="number" min="0" max="1000" step="0.1" :value="preferences.daily_budget_usd" :disabled="busy" @change="save('daily_budget_usd', $event)" /></label>
        <label>Account monthly limit (USD)<input type="number" min="0" max="10000" step="1" :value="preferences.monthly_budget_usd" :disabled="busy" @change="save('monthly_budget_usd', $event)" /></label>
        <label>Keep cloud recordings<select :value="preferences.recording_retention" :disabled="busy" @change="save('recording_retention', $event)">
          <option value="minimal">Minimal — assessments and recent pronunciation</option><option value="assessment-only">Assessment only</option><option value="more-history">More history — 30 days</option>
        </select></label>
        <label class="check-label"><input type="checkbox" :checked="preferences.prosody_enabled" :disabled="busy" @change="save('prosody_enabled', $event)" />Include available rhythm and intonation assessment</label>
      </div>
      <p class="help-text">Unfinished originals remain protected. A zero budget pauses new paid requests, not local practice. Service estimates and provider-side spending caps supplement these limits.</p>
      <button class="button secondary" :disabled="busy" @click="refresh">{{ busy ? 'Please wait…' : 'Refresh account usage' }}</button>
    </template>
    <p v-if="message" class="success-note" role="status">{{ message }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </div>
</template>
