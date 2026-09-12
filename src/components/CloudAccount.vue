<script setup lang="ts">
import { ref } from 'vue'
import { useCloud } from '../stores/cloud'
import Icon from './Icon.vue'
const cloud = useCloud(), address = ref(''), code = ref(''), sent = ref(false)
async function send() { sent.value = await cloud.requestCode(address.value) }
async function verify() {
  try { if (await cloud.verifyCode(address.value, code.value)) sent.value = false }
  finally { code.value = '' }
}
</script>
<template>
  <section class="settings-section">
    <div class="settings-description">
      <span class="small-icon"><Icon name="shield" /></span>
      <h2>Your learning account</h2>
      <p>One learning history across your devices. Offline practice stays available.</p>
    </div>
    <div class="panel settings-panel">
      <p role="status" aria-live="polite">{{ cloud.status }}</p>
      <p v-if="!cloud.configured" class="help-text">Cloud service is not connected to this build yet. Your existing learning remains saved on this device.</p>
      <template v-else-if="cloud.userId">
        <p>Signed in as {{ cloud.email }}</p>
        <p v-if="cloud.lastSynced" class="help-text">Last synced {{ new Date(cloud.lastSynced).toLocaleTimeString() }}. On another device, sign in with the same email.</p>
        <p v-if="cloud.pending || cloud.hasMore || cloud.audioPending" class="help-text">Some learning or recordings are still transferring. Keep this account signed in; interrupted transfers retry safely.</p>
        <p v-if="cloud.deferred" class="help-text" role="alert">{{ cloud.deferred }} saved items need more history or a recovery decision before they can be combined. Original records are retained; this account is not fully synced yet.</p>
        <p v-if="cloud.conflicts" class="help-text">Different versions were found in {{ cloud.conflicts }} items. Both original histories are retained.</p>
        <p v-if="cloud.audioBlocked" class="help-text" role="alert">{{ cloud.audioBlocked }} recordings need attention: missing metadata, conflicting originals or insufficient local space. No local recording was replaced.</p>
        <button class="button secondary" :disabled="cloud.syncing || !cloud.online || cloud.paused" @click="cloud.syncNow">Sync now</button>
        <button class="text-button" @click="cloud.signOut">Sign out on this device</button>
        <p class="help-text">Signing out keeps your local learning and unfinished work on this browser. Use your own device.</p>
      </template>
      <form v-else @submit.prevent="sent ? verify() : send()">
        <label for="sync-email">Your email</label>
        <input id="sync-email" v-model="address" type="email" autocomplete="email" required :readonly="sent" />
        <template v-if="sent">
          <label for="sync-code">Email sign-in code</label>
          <input id="sync-code" v-model="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required />
          <p class="help-text">Enter the six-digit code from your email. You do not need to open a link or leave your lesson.</p>
        </template>
        <button class="button primary" type="submit" :disabled="cloud.accountBusy || !cloud.online">{{ cloud.accountBusy ? 'Please wait…' : sent ? 'Sign in & continue' : 'Send sign-in code' }}</button>
        <button v-if="sent" class="text-button" type="button" :disabled="cloud.accountBusy" @click="sent = false; code = ''">Use another email or request a new code</button>
      </form>
      <p v-if="cloud.problem" class="help-text" role="alert">{{ cloud.problem }}</p>
    </div>
  </section>
</template>
