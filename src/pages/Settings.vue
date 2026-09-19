<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Dexie from "dexie";
import { useApp } from "../stores/app";
import { db } from "../db/db";
import { exportBackup, restoreBackup } from "../db/repository";
import type { ProviderModel } from "../ai/provider";
import type { Settings } from "../domain/types";
import { useRequest } from "../composables/useRequest";
import Icon from "../components/Icon.vue";
import CloudAccount from "../components/CloudAccount.vue";
import AccountUsage from "../components/AccountUsage.vue";
import { useCloud } from "../stores/cloud";
import { useJapaneseSpace } from "../stores/japanese-space";
import { resetDeviceCacheAndKey } from "../sync/local-change";
const cloud = useCloud();
const japanese = useJapaneseSpace();
const japaneseEnabled = import.meta.env.DEV;
const dataLanguage = ref<'en' | 'ja'>('en');
const dataLabel = computed(() => dataLanguage.value === 'ja' ? '日语' : '英语');
const importedLanguage = ref<'en' | 'ja'>('en');
const fileInput = ref<HTMLInputElement>();
const japaneseAudioMB = ref<number>();
const advancedAi = ref(false);
const app = useApp(),
  key = ref(""),
  models = ref<ProviderModel[]>([]),
  message = ref(""),
  storage = ref(""),
  resetText = ref(""),
  importText = ref(""),
  importName = ref("");
const { busy, error, run, cancel } = useRequest();
function clearImport() {
  importText.value = ''; importName.value = '';
  if (fileInput.value) fileInput.value.value = '';
}
watch(dataLanguage, () => { clearImport(); message.value = ''; error.value = ''; });
async function dataContext(language: 'en' | 'ja') {
  if (language === 'en') return { database: db, account: cloud };
  if (!japaneseEnabled || !(await Dexie.getDatabaseNames()).includes(japanese.database.name))
    throw new Error('请先打开日语学习区；这里不会为了备份而创建空的学习记录。');
  await japanese.ensure();
  return { database: japanese.database, account: japanese };
}
const textModels = computed(() =>
  models.value.filter((m) => m.outputModalities.includes("text")),
);
const sttModels = computed(() =>
  models.value.filter((m) => m.outputModalities.includes("transcription")),
);
const ttsModels = computed(() =>
  models.value.filter((m) => m.outputModalities.includes("speech")),
);
const voices = computed(
  () => models.value.find((m) => m.id === app.settings.ttsModel)?.voices || [],
);
const audioMB = computed(
  () => app.audio.reduce((n, a) => n + a.blob.size, 0) / 1024 / 1024,
);
const unknownCosts = computed(
  () => app.usage.filter((u) => u.cost === null).length,
);
async function saveKey() {
  if (!key.value.trim()) return;
  await db.secrets.put({ id: "openrouter", value: key.value.trim() });
  await db.secrets.put({ id: "provider-mode", value: "byok" });
  key.value = "";
  message.value =
    "Key saved on this browser. Test the connection before starting AI practice.";
  await app.refresh();
}
async function test() {
  const result = await run((signal) => app.provider.testConnection(signal));
  if (result) message.value = "Connection verified. " + result.label;
}
async function catalog() {
  const result = await run((signal) => app.provider.listModels(signal));
  if (result) {
    models.value = result;
    message.value = `Loaded ${result.length} available models. Choose models for each task below.`;
  }
}
async function removeKey() {
  await db.secrets.delete("openrouter");
  await db.secrets.delete("provider-mode");
  key.value = "";
  message.value = "Key removed from this device.";
  await app.refresh();
}
async function useAccountProvider() {
  await db.secrets.delete("provider-mode");
  await app.refresh();
}
async function preference(field: keyof Settings, event: Event) {
  const input = event.target as HTMLInputElement;
  const value = input.value;
  const saved = await app.saveSettings({
    [field]: ["dailyBudget", "correctionIntensity", "audioLimitMB"].includes(
      field,
    )
      ? Number(value)
      : value,
  });
  if (!saved) input.value = String(app.settings[field]);
}
async function backup() {
  const language = dataLanguage.value;
  await run(async (signal) => {
    const { database } = await dataContext(language);
    const content = await exportBackup(database);
    signal.throwIfAborted();
    const url = URL.createObjectURL(
      new Blob([content], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `jove-${language === 'ja' ? 'japanese' : 'english'}-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.value =
      "Backup exported. It excludes keys and audio blobs. Keep it somewhere safe.";
  });
}
async function loadFile(event: Event) {
  if (busy.value) return;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  clearImport();
  if (file.size > 25 * 1024 * 1024) {
    message.value = "Backup must be smaller than 25 MB.";
    return;
  }
  const language = dataLanguage.value;
  const content = await run(async (signal) => {
    const text = await file.text();
    signal.throwIfAborted();
    return text;
  });
  if (content !== undefined && language === dataLanguage.value) {
    importText.value = content; importName.value = file.name; importedLanguage.value = language;
  }
}
async function restore() {
  const language = dataLanguage.value, text = importText.value;
  const result = await run(async (signal) => {
    if (!text || importedLanguage.value !== language) throw new Error('请重新选择此语言的备份文件。');
    const { database, account } = await dataContext(language);
    signal.throwIfAborted();
    await account.withLocalDataChange(async () => {
      signal.throwIfAborted();
      await restoreBackup(text, database);
      signal.throwIfAborted();
    });
    await app.refresh();
    await storageStatus();
    return true;
  });
  if (result) {
    clearImport();
    message.value =
      "Backup merged with retained learning history. Existing recordings and account sync history are safe. Audio files are separate from this backup.";
  }
}
async function persistent() {
  const granted = await navigator.storage?.persist?.();
  message.value = granted
    ? "Persistent storage granted by this browser. Keep backups as well."
    : "Persistent storage was not granted. Regular exports help protect your learning history.";
  await storageStatus();
}
async function storageStatus() {
  const estimate = await navigator.storage?.estimate?.();
  const persistent = await navigator.storage?.persisted?.();
  storage.value = `${((estimate?.usage || 0) / 1024 / 1024).toFixed(1)} MB used · ${persistent ? "persistent storage" : "standard browser storage"}`;
  japaneseAudioMB.value = undefined;
  if (japaneseEnabled && (await Dexie.getDatabaseNames()).includes(japanese.database.name)
      && (await japanese.database.syncMeta.get('owner'))?.value === (await db.syncMeta.get('owner'))?.value) {
    japaneseAudioMB.value = (await japanese.database.audio.toArray()).reduce((sum, asset) => sum + asset.blob.size, 0) / 1024 / 1024;
  }
}
async function clearCache() {
  const language = dataLanguage.value;
  const result = await run(async (signal) => {
    const { database, account } = await dataContext(language);
    signal.throwIfAborted();
    await account.withLocalDataChange(async () => {
      signal.throwIfAborted();
      await database.audio.filter((asset) => asset.kind === "generated" || asset.kind === "content-cache").delete();
      signal.throwIfAborted();
    });
    await app.refresh();
    await storageStatus();
    return true;
  });
  if (result) message.value = `${language === 'ja' ? '日语' : '英语'}可重新下载的音频缓存已清理。录音原件、导入音频和另一语言的数据均保留。`;
}
async function reset() {
  if (resetText.value !== "RESET") return;
  const result = await run(async (signal) => {
    await cloud.withLocalDataChange(async () => {
      signal.throwIfAborted();
      await resetDeviceCacheAndKey(db);
      signal.throwIfAborted();
    });
    key.value = "";
    await app.refresh();
    await storageStatus();
    return true;
  });
  if (result) {
    resetText.value = "";
    message.value =
      "Optional local API key and audio caches cleared. Learning, drafts, original recordings, preferences and account sync history are retained.";
  }
}
onMounted(storageStatus);
</script>
<template>
  <div class="page settings-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">MAKE THIS SPACE WORK FOR YOU</p>
        <h1 tabindex="-1">
          A few thoughtful <span class="serif">settings.</span>
        </h1>
        <p class="lede">Your learning, your models, your data.</p>
      </div>
    </div>
    <p v-if="message" class="success-note" role="status">
      <Icon name="check" :size="17" />{{ message }}
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button v-if="busy" class="text-button" @click="cancel">
      Cancel current request
    </button>
    <CloudAccount />
    <section class="settings-section">
      <div class="settings-description">
        <span class="small-icon"><Icon name="sparkle" /></span>
        <h2>AI connection</h2>
        <p v-if="cloud.configured">Your account connects the AI services for all your devices.</p>
        <p v-else>
          Use your own OpenRouter key for conversations, language feedback and
          speech.
        </p>
      </div>
      <div class="panel settings-panel">
        <template v-if="cloud.configured">
          <h3>Account AI</h3>
          <p>No production API key is stored on this browser or included in your learning backup.</p>
          <button class="button secondary" :disabled="!cloud.userId || busy" @click="useAccountProvider().then(test)">Check account connection</button>
          <p v-if="app.providerMode === 'byok'" class="help-text">This browser is using your optional local key. Other devices keep their own connection mode.</p>
          <button class="text-button" @click="advancedAi = !advancedAi">{{ advancedAi ? 'Hide advanced connection' : 'Advanced: optional browser key' }}</button>
        </template>
        <template v-if="!cloud.configured || advancedAi">
        <div class="row between">
          <h3>OpenRouter</h3>
          <span class="pill">{{
            app.browserKeySet ? "Key saved locally" : "No browser key"
          }}</span>
        </div>
        <label for="api-key">Dedicated API key</label
        ><input
          id="api-key"
          v-model="key"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="Paste your personal limited key"
        />
        <div class="row wrap">
          <button
            class="button primary"
            :disabled="!key.trim() || busy"
            @click="saveKey"
          >
            Save key</button
          ><button
            class="button secondary"
            :disabled="!app.browserKeySet || busy"
            @click="test"
          >
            Test connection</button
          ><button
            class="text-button"
            :disabled="!app.browserKeySet || busy"
            @click="removeKey"
          >
            Remove key
          </button>
        </div>
        <p class="help-text">
          Stored in this browser only, excluded from backups. Same-origin code
          can access it: use a dedicated key with a low provider spending limit.
          Audio and relevant text are sent to OpenRouter only when you use those
          features.
        </p>
        <a
          href="https://openrouter.ai/settings/keys"
          target="_blank"
          rel="noopener noreferrer"
          class="text-button"
          >Manage keys at OpenRouter <Icon name="external" :size="14"
        /></a>
        <hr />
        <div class="row between">
          <h3>Choose your models</h3>
          <button class="text-button" :disabled="busy" @click="catalog">
            {{ busy ? "Loading…" : "Refresh model list"
            }}<Icon name="refresh" :size="15" />
          </button>
        </div>
        <p class="help-text">
          Models are discovered from the provider’s current capabilities. No
          permanent model is hardcoded. Select each model you want to use. Only
          your other configured text model can be used as a fallback; the app
          will not pick an unapproved paid model for you.
          Fast tasks covers content, lookup and conversation; evaluation uses
          the stronger model selected below.
        </p>
        <div class="field-grid">
          <label
            >Fast tasks<select
              :value="app.settings.fastModel"
              @change="preference('fastModel', $event)"
            >
              <option value="">Select a text model</option>
              <option
                v-if="
                  app.settings.fastModel &&
                  !models.some((m) => m.id === app.settings.fastModel)
                "
                :value="app.settings.fastModel"
              >
                {{ app.settings.fastModel }}
              </option>
              <option v-for="m in textModels" :key="m.id" :value="m.id">
                {{ m.name }}{{ m.structured ? " · structured" : "" }}
              </option>
            </select></label
          ><label
            >Evaluation & analysis<select
              :value="app.settings.strongModel"
              @change="preference('strongModel', $event)"
            >
              <option value="">Select a text model</option>
              <option
                v-if="
                  app.settings.strongModel &&
                  !models.some((m) => m.id === app.settings.strongModel)
                "
                :value="app.settings.strongModel"
              >
                {{ app.settings.strongModel }}
              </option>
              <option v-for="m in textModels" :key="m.id" :value="m.id">
                {{ m.name }}
              </option>
            </select></label
          ><label
            >Transcription<select
              :value="app.settings.sttModel"
              @change="preference('sttModel', $event)"
            >
              <option value="">Select a transcription model</option>
              <option v-for="m in sttModels" :key="m.id" :value="m.id">
                {{ m.name }}
              </option>
            </select></label
          ><label
            >Speech generation<select
              :value="app.settings.ttsModel"
              @change="preference('ttsModel', $event)"
            >
              <option value="">Select a speech model</option>
              <option v-for="m in ttsModels" :key="m.id" :value="m.id">
                {{ m.name }}
              </option>
            </select></label
          ><label
            >Voice<select
              :value="app.settings.voice"
              @change="preference('voice', $event)"
            >
              <option value="">Provider default</option>
              <option v-for="v in voices" :key="v" :value="v">{{ v }}</option>
            </select></label
          >
        </div>
        </template>
      </div>
    </section>
    <section class="settings-section">
      <div class="settings-description">
        <span class="small-icon"><Icon name="today" /></span>
        <h2>Learning preferences</h2>
        <p>A steady pace, with enough room for real conversation.</p>
      </div>
      <div class="panel settings-panel">
        <div class="field-grid">
          <label
            >Daily practice<select
              :value="app.profile.dailyMinutes"
              @change="
                app.saveProfile({
                  dailyMinutes: Number(
                    ($event.target as HTMLSelectElement).value,
                  ),
                })
              "
            >
              <option :value="45">45 minutes</option>
              <option :value="90">90 minutes</option>
              <option :value="150">150 minutes</option>
            </select></label
          ><label
            >Appearance<select
              aria-label="Appearance"
              :value="app.settings.theme"
              @change="preference('theme', $event)"
            >
              <option value="system">Follow device</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select></label
          ><label
            >Pronunciation reference<select
              :value="app.settings.accent"
              @change="preference('accent', $event)"
            >
              <option value="en-US">General American</option>
              <option value="en-GB">British English</option>
              <option value="en-NZ">New Zealand English</option>
            </select></label
          ><label
            >Correction focus<select
              :value="app.settings.correctionIntensity"
              @change="preference('correctionIntensity', $event)"
            >
              <option :value="1">One high-value issue</option>
              <option :value="2">Two useful issues</option>
              <option :value="3">Up to three issues</option>
            </select></label
          >
        </div>
        <label class="checkbox-label"
          ><input
            type="checkbox"
            :checked="app.settings.chineseHelp"
            @change="
              app.saveSettings({
                chineseHelp: ($event.target as HTMLInputElement).checked,
              })
            "
          />Offer optional Chinese help</label
        ><RouterLink to="/onboarding" class="text-button"
          >Revisit goals and starting point <Icon name="arrow" :size="15"
        /></RouterLink>
      </div>
    </section>
    <section class="settings-section">
      <div class="settings-description">
        <span class="small-icon"><Icon name="clock" /></span>
        <h2>Usage & budget</h2>
        <p>Keep your practice predictable.</p>
      </div>
      <AccountUsage v-if="cloud.configured" />
      <div v-if="!cloud.configured || app.browserKeySet" class="panel settings-panel">
        <h3 v-if="cloud.configured">Optional browser-key usage</h3>
        <div class="usage-total">
          <strong>${{ app.cost.toFixed(2) }}</strong
          ><span>reported cost today</span>
        </div>
        <p v-if="unknownCosts" class="help-text">
          {{ unknownCosts }} requests did not return a final cost. This is a
          reported subtotal, not a provider billing guarantee. Set a
          provider-side cap too.
        </p>
        <label for="budget">Daily local budget (USD)</label
        ><input
          id="budget"
          type="number"
          min="0.1"
          max="100"
          step="0.1"
          :value="app.settings.dailyBudget"
          @change="
            Number(($event.target as HTMLInputElement).value) > 0 &&
            preference('dailyBudget', $event)
          "
        />
        <details>
          <summary>Recent request usage</summary>
          <div
            v-for="u in [...app.usage]
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, 20)"
            :key="u.id"
            class="usage-row"
          >
            <span
              >{{ u.purpose }}<small>{{ u.model }}</small></span
            ><span>{{
              u.cost === null ? "Not reported" : "$" + u.cost.toFixed(4)
            }}</span>
          </div>
          <p v-if="!app.usage.length" class="muted">No AI requests yet.</p>
        </details>
      </div>
    </section>
    <section class="settings-section">
      <div class="settings-description">
        <span class="small-icon"><Icon name="shield" /></span>
        <h2>Your data</h2>
        <p>
          {{ cloud.configured ? 'Learning sync is managed by your account above. Keep a separate backup before clearing browser data.' : 'Cloud service is not connected to this build. Keep a backup before clearing browser data or moving devices.' }}
        </p>
      </div>
      <div class="panel settings-panel">
        <h3>Backup & restore</h3>
        <template v-if="japaneseEnabled">
          <label for="data-language">备份、恢复及清理缓存的语言</label>
          <select id="data-language" v-model="dataLanguage" :disabled="busy">
            <option value="en">英语</option><option value="ja">日语</option>
          </select>
          <p class="help-text">当前操作只针对{{ dataLabel }}。两种语言分别备份，系统会拒绝导入错误语言的文件，不会改写另一语言的学习记录。</p>
        </template>
        <p v-if="cloud.configured" class="help-text">Cloud recording preferences are managed with your account usage above. Unfinished originals remain protected.</p>
        <p>
          Back up your learning, review schedules and preferences. Keys and
          audio blobs are excluded.
        </p>
        <button class="button secondary" :disabled="busy" @click="backup">
          <Icon name="download" :size="16" />Export backup</button
        ><label for="restore-file">Restore an exported backup</label
        ><input
          id="restore-file"
          ref="fileInput"
          :disabled="busy"
          type="file"
          accept=".json,application/json"
          @change="loadFile"
        />
        <div v-if="importText" class="restore-confirm">
          <p>
            Restore <strong>{{ importName }}</strong
            >? The validated backup will merge with retained learning history.
            Missing older records do not delete newer work. Existing audio originals and account identity stay on this device.
          </p>
          <button class="button secondary" :disabled="busy" @click="restore">
            Validate & merge backup</button
          ><button
            class="text-button"
            :disabled="busy"
            @click="clearImport"
          >
            Cancel
          </button>
        </div>
        <hr />
        <h3>Device storage</h3>
        <p>{{ storage }}</p>
        <p class="muted">{{ audioMB.toFixed(1) }} MB of saved English audio</p>
        <p v-if="japaneseAudioMB !== undefined" class="muted">日语音频 {{ japaneseAudioMB.toFixed(1) }} MB · 两种语言合计 {{ (audioMB + japaneseAudioMB).toFixed(1) }} MB。浏览器总占用还包括页面缓存和学习记录。</p>
        <div class="row wrap">
          <button class="text-button" @click="persistent">
            Request persistent storage</button
          ><button class="text-button" :disabled="busy" @click="clearCache">
            Clear reusable audio caches
          </button>
        </div>
        <label for="audio-limit">Audio storage budget (MB)</label
        ><input
          id="audio-limit"
          type="number"
          min="25"
          max="1000"
          step="25"
          :value="app.settings.audioLimitMB"
          @change="preference('audioLimitMB', $event)"
        />
        <details class="danger-zone">
          <summary>Reset local key and audio caches</summary>
          <p v-if="japaneseEnabled" class="help-text">下方重置只清理英语端的可选 API Key 和可再下载缓存，不随上方语言选择改变。日语缓存请使用上面的清理按钮。任何操作都不会删除录音原件。</p>
          <p>
            This clears the optional API key and reusable audio caches on this device.
            Learning, drafts, original recordings, preferences and the account's sync history are kept.
            It does not erase your cloud learning or sign you out.
          </p>
          <label for="reset-confirm">Type RESET to confirm</label
          ><input
            id="reset-confirm"
            v-model="resetText"
            autocomplete="off"
          /><button
            class="button danger"
            :disabled="resetText !== 'RESET' || busy"
            @click="reset"
          >
            Reset local key & caches
          </button>
        </details>
      </div>
    </section>
  </div>
</template>
