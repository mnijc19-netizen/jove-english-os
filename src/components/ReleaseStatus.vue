<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref } from 'vue'
import { currentRelease, checkPublishedRelease, updateControls, type ReleaseInfo } from '../release'
import { abortable } from '../ai/transport'

const updates = inject(updateControls, null)
const latest = ref<ReleaseInfo>(), checking = ref(false), checkedAt = ref(''), problem = ref('')
const same = computed(() => !!currentRelease && latest.value?.buildId === currentRelease.buildId)
const updateReady = computed(() => updates?.available.value ?? false)
const applying = computed(() => updates?.applying.value ?? false)
let controller: AbortController | undefined
onBeforeUnmount(() => controller?.abort())
async function check() {
  if (checking.value) return
  latest.value = undefined; checkedAt.value = ''; problem.value = ''
  if (!navigator.onLine) { problem.value = '当前离线，无法确认网站最新版本；本机学习记录仍然保留。'; return }
  checking.value = true
  const request = controller = new AbortController()
  try {
    const release = await checkPublishedRelease(import.meta.env.BASE_URL, request.signal, async signal => {
      if (!navigator.serviceWorker) return
      const registration = await abortable(navigator.serviceWorker.getRegistration(), signal)
      if (registration && !registration.installing) await abortable(registration.update(), signal)
    })
    if (request.signal.aborted) return
    latest.value = release; checkedAt.value = new Date().toLocaleString('zh-CN')
  } catch {
    if (!request.signal.aborted) problem.value = '暂时无法确认最新版本，请联网后再检查。登录成功或没有更新提示，都不能代替版本核对。'
  } finally { if (controller === request) checking.value = false }
}
</script>

<template>
  <section class="panel release-status" aria-labelledby="release-heading" lang="zh-CN">
    <h2 id="release-heading">网站版本与更新</h2>
    <p class="help-text">这里只核对已发布的网站，不代表所有开发中的功能都已上线，也不检查其他设备。</p>
    <dl class="release-details">
      <div><dt>当前页面版本</dt><dd><code data-testid="current-release">{{ currentRelease?.buildId ?? '本地开发 · 尚无发布编号' }}</code></dd></div>
      <div v-if="currentRelease"><dt>构建时间</dt><dd>{{ new Date(currentRelease.builtAt).toLocaleString('zh-CN') }}</dd></div>
      <div v-if="latest"><dt>网站发布版本</dt><dd><code data-testid="published-release">{{ latest.buildId }}</code></dd></div>
    </dl>
    <p v-if="currentRelease?.dirty || currentRelease && !currentRelease.revision" class="help-text">这是未提交或未标记来源的开发构建，不作为正式上线证明。</p>
    <p v-if="checkedAt" class="help-text">最近核对：{{ checkedAt }}。这是该时刻的结果，不代表网站此后不会发布新版本。</p>
    <p role="status" aria-live="polite" data-testid="release-result">
      {{ checking ? '正在核对版本，不会自动刷新…' : problem || (latest ? (same ? '核对一致：此页面与网站当前发布版本相同。' : '发现不同的发布版本。请先保存练习，再更新页面。') : '尚未联网核对，不能仅凭登录判断是否最新。') }}
    </p>
    <div class="actions">
      <button class="button secondary" :disabled="checking || applying" @click="check">{{ checking ? '正在检查…' : '检查更新' }}</button>
      <button v-if="updateReady" class="button primary" :disabled="applying || checking" @click="updates?.apply()">{{ applying ? '正在更新…' : '已保存练习，更新页面' }}</button>
    </div>
    <p v-if="latest && !same && !updateReady" class="help-text">更新组件可能还在准备。若未出现更新按钮，请保存练习后关闭并重新打开本站；不要清除网站数据，也不需要重新登录。</p>
  </section>
</template>

<style scoped>
.release-status { margin-bottom: 24px; }
.release-details { display: grid; gap: 12px; margin: 20px 0; }
.release-details div { display: flex; flex-wrap: wrap; gap: 6px 20px; }
.release-details dt { min-width: 112px; color: var(--muted); }
.release-details dd { margin: 0; overflow-wrap: anywhere; min-width: 0; }
.release-status .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
</style>
