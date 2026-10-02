<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { registerSW } from "virtual:pwa-register";
import { useApp } from "./stores/app";
import Icon from "./components/Icon.vue";
import { useCloud } from "./stores/cloud";
import { useJapaneseSpace } from "./stores/japanese-space";
import { japaneseEnabled, japaneseDevelopment } from "./release-flags";
import { updateControls } from "./release";
const cloud = useCloud();
const japanese = japaneseEnabled ? useJapaneseSpace() : null;
const app = useApp(),
  route = useRoute(),
  menu = ref(false),
  updateAvailable = ref(false),
  applyingUpdate = ref(false),
  offlineReady = ref(false);
const menuButton = ref<HTMLButtonElement>(), sidebar = ref<HTMLElement>();
// Keep this breakpoint aligned with the existing mobile sidebar CSS.
const mobileViewport = window.matchMedia("(max-width: 800px)");
const mobileNavigation = ref(mobileViewport.matches);
const sidebarHidden = computed(() => mobileNavigation.value && !menu.value);
function closeMenu(restoreFocus = false) {
  const previousFocus = document.activeElement;
  const ownedFocus = previousFocus === menuButton.value || !!sidebar.value?.contains(previousFocus);
  menu.value = false;
  if (restoreFocus && ownedFocus) void nextTick(() => {
    if (mobileNavigation.value && !menu.value &&
      (document.activeElement === previousFocus || document.activeElement === document.body))
      menuButton.value?.focus({ preventScroll: true });
  });
}
function navigationKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || !mobileNavigation.value || !menu.value) return;
  event.preventDefault(); closeMenu(true);
}
function viewportChanged(event: MediaQueryListEvent) {
  mobileNavigation.value = event.matches;
  // A newly off-screen sidebar must not retain keyboard focus.
  closeMenu(event.matches);
}
let updateReloadStarted = false;
let updateRecoveryTimer: number | undefined;
function clearUpdateRecovery() {
  if (updateRecoveryTimer !== undefined) window.clearTimeout(updateRecoveryTimer);
  updateRecoveryTimer = undefined;
}
function armUpdateRecovery(delay: number) {
  clearUpdateRecovery();
  updateRecoveryTimer = window.setTimeout(() => {
    updateRecoveryTimer = undefined;
    updateReloadStarted = false;
    applyingUpdate.value = false;
    app.notice = "The page did not refresh. Save any current work, then try Update now again.";
  }, delay);
}
function reloadAfterUpdate() {
  if (!applyingUpdate.value || updateReloadStarted) return;
  updateReloadStarted = true;
  // beforeunload can cancel a reload without throwing. Keep retry available.
  armUpdateRecovery(2000);
  window.location.reload();
}
const nav = [
  { label: "Today", zh: "今日安排", description: "查看下一项任务，继续已保存的练习" },
  { label: "Listen", zh: "听力练习", description: "先听懂意思，再复述和对照" },
  { label: "Speak", zh: "开口表达", description: "用英语回应情境，保留录音再改进" },
  { label: "Learn", zh: "阅读与表达", description: "阅读材料，练习常用表达和书面回应" },
  { label: "Review", zh: "间隔复习", description: "先独立回忆，再看参考答案" },
  { label: "Library", zh: "学习材料", description: "查看课程与已保存材料" },
  { label: "Progress", zh: "学习记录", description: "区分已完成练习与已有能力证据" },
];
const page = computed(() => route.path.slice(1) || "today");
const inJapanese = computed(() => route.path === '/ja' || route.path.startsWith('/ja/'));
const pageLabel = computed(() => inJapanese.value ? "日语学习"
  : nav.find(item => item.label.toLowerCase() === page.value)?.zh
    ?? ({ onboarding: "了解我的起点", settings: "设置" } as Record<string, string>)[page.value] ?? "学习空间");
const workspaceStatus = computed(() => inJapanese.value && japanese ? japanese.status : cloud.status);
watch(() => app.ready, ready => {
  if (ready && japanese) void japanese.startIfPresent(app.refresh).catch(() => { /* The separate Japanese status exposes the recoverable failure. */ });
});
const update = registerSW({
  onNeedReload: reloadAfterUpdate,
  onNeedRefresh: () => {
    updateAvailable.value = true;
  },
  onOfflineReady: () => {
    offlineReady.value = true;
  },
});
async function applyUpdate() {
  if (applyingUpdate.value) return;
  applyingUpdate.value = true;
  armUpdateRecovery(15000);
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    // Another tab may already have activated the offered worker.
    if (!registration?.waiting) {
      reloadAfterUpdate();
      return;
    }
    await update(true);
  } catch {
    clearUpdateRecovery();
    updateReloadStarted = false;
    applyingUpdate.value = false;
    app.notice = "The update could not be applied. Save your practice, then try again or refresh.";
  }
}
provide(updateControls, { available: updateAvailable, applying: applyingUpdate, apply: applyUpdate });
watch(
  () => route.fullPath,
  () => {
    closeMenu();
  },
);
watch(
  [() => app.ready, () => route.path],
  ([ready]) => {
    // The initial route can resolve before IndexedDB bootstrap renders main.
    // Focus after the real DOM update, without taking focus from an interaction
    // already started while the workspace was opening (for example Skip).
    if (ready && document.activeElement === document.body)
      document.querySelector<HTMLElement>("#main h1")?.focus({ preventScroll: true });
  },
  { flush: "post" },
);
onMounted(() => {
  mobileViewport.addEventListener("change", viewportChanged);
  window.addEventListener("keydown", navigationKey);
  // A first-install Workbox instance keeps isUpdate=false even on a later
  // controller handoff. Reload on that native event only after explicit consent.
  navigator.serviceWorker?.addEventListener("controllerchange", reloadAfterUpdate);
  return app.init();
});
onUnmounted(() => {
  mobileViewport.removeEventListener("change", viewportChanged);
  window.removeEventListener("keydown", navigationKey);
  clearUpdateRecovery();
  navigator.serviceWorker?.removeEventListener("controllerchange", reloadAfterUpdate);
});
function focusPractice() {
  document.getElementById("main")?.focus();
}
</script>
<template>
  <a class="skip-link" href="#main" lang="en" aria-label="Skip to practice" @click.prevent="focusPractice"><span lang="zh-CN">跳到练习 · </span>Skip to practice</a>
  <div v-if="app.fatal" class="fatal">
    <h1 tabindex="-1" lang="en">Let’s recover your workspace.</h1>
    <p lang="zh-CN">暂时无法打开本机学习记录。请保留此页面，检查浏览器存储权限后重试。</p>
    <p lang="en">{{ app.fatal }}</p>
    <button lang="en" aria-label="Try again" @click="app.init"><span lang="zh-CN">重试 · </span>Try again</button>
  </div>
  <div v-else-if="!app.ready" class="boot" role="status">
    <span class="brand-mark">j.</span>
    <p lang="zh-CN">正在打开学习空间…</p>
  </div>
  <div v-else class="app-shell">
    <header class="mobile-header">
      <RouterLink to="/today" class="brand" lang="en"
        ><span class="brand-mark">j.</span>Jove Language<span class="os"
          >OS</span
        ></RouterLink
      ><button
        ref="menuButton"
        class="icon-button"
        lang="en"
        aria-label="Toggle navigation"
        aria-description="打开或关闭导航；按 Escape 关闭并返回导航按钮"
        aria-controls="workspace-navigation"
        :aria-expanded="menu"
        @click="menu ? closeMenu(true) : menu = true"
      >
        <Icon :name="menu ? 'close' : 'menu'" />
      </button>
    </header>
    <aside id="workspace-navigation" ref="sidebar" class="sidebar" :class="{ open: menu }" :inert="sidebarHidden" :aria-hidden="sidebarHidden ? 'true' : undefined">
      <RouterLink to="/today" class="brand desktop-brand" lang="en"
        ><span class="brand-mark">j.</span
        ><span
          >Jove Language<small>YOUR PERSONAL PRACTICE</small></span
        ></RouterLink
      >
      <p class="nav-label" lang="zh-CN">学习空间</p>
      <div v-if="japaneseEnabled" class="language-links" aria-label="学习语言" lang="zh-CN">
        <RouterLink to="/today" :aria-current="!inJapanese ? 'true' : undefined" class="nav-item"><span lang="en">English</span> · 英语</RouterLink>
        <RouterLink to="/ja" :aria-current="inJapanese ? 'true' : undefined" class="nav-item"><span lang="ja">日本語</span> · {{ japaneseDevelopment ? '日语预览' : '日语' }}</RouterLink>
      </div>
      <nav v-if="!inJapanese" aria-label="Main navigation" lang="en" aria-description="英语学习导航">
        <RouterLink
          v-for="item in nav"
          :key="item.label"
          :to="'/' + item.label.toLowerCase()"
          :aria-label="item.label"
          :aria-description="item.description"
          class="nav-item"
          ><Icon :name="item.label.toLowerCase()" /><span><span lang="zh-CN">{{ item.zh }}</span> · {{ item.label }}</span
          ><span v-if="item.label === 'Review' && app.due.length" class="nav-count" aria-hidden="true">{{
            app.due.length
          }}</span
          ><span v-if="item.label === 'Today'" class="nav-dot"></span
        ></RouterLink>
      </nav>
      <nav v-else aria-label="日语导航" lang="zh-CN"><RouterLink to="/ja" class="nav-item"><Icon name="today" />今日任务与复习</RouterLink></nav>
      <div class="sidebar-bottom">
        <div class="local-note">
          <Icon name="shield" :size="18" /><span
            lang="zh-CN">{{ inJapanese ? '日语同步状态' : '英语同步状态' }}<small role="status" lang="en">{{ workspaceStatus }}</small></span
          >
        </div>
        <RouterLink to="/settings" class="nav-item" lang="en" aria-label="Settings" aria-description="设置账号、学习偏好、备份与存储"
          ><Icon name="settings" /><span><span lang="zh-CN">设置</span> · Settings</span></RouterLink
        >
        <div class="profile-row">
          <span class="avatar">{{
            app.profile.name.slice(0, 1).toUpperCase()
          }}</span>
          <div>
            <strong>{{ app.profile.name }}</strong
            ><small lang="zh-CN">{{ inJapanese ? '日语，一点点用起来。' : '英语，一点点用起来。' }}</small>
          </div>
          <button
            class="icon-button"
            aria-label="Toggle dark mode"
            lang="en"
            aria-description="切换深色或浅色外观"
            @click="
              app.saveSettings({
                theme: app.settings.theme === 'dark' ? 'light' : 'dark',
              })
            "
          >
            <Icon
              :name="app.settings.theme === 'dark' ? 'sun' : 'moon'"
              :size="18"
            />
          </button>
        </div>
      </div>
    </aside>
    <div v-if="menu && mobileNavigation" class="sidebar-scrim" aria-hidden="true" @click="closeMenu(true)"></div>
    <div class="main-wrap">
      <div class="topbar">
        <span class="breadcrumb" lang="zh-CN">学习空间 <span>/</span>
          <span>{{ pageLabel }}</span></span
        ><span class="connection"
          ><i :class="{ offline: !app.online }"></i
          ><span lang="zh-CN">{{ app.online ? (inJapanese ? '日语：' : '英语：') : '离线 · 可继续本机练习' }}</span><span v-if="app.online" lang="en">{{ workspaceStatus }}</span></span
        >
      </div>
      <div v-if="updateAvailable" class="banner">
        <span lang="zh-CN">有新版本。请先保存当前练习，再刷新页面。</span
        ><button class="text-button" lang="en" aria-label="Update now" :disabled="applyingUpdate" @click="applyUpdate"><span lang="zh-CN">更新 · </span>Update now</button>
        ><button
          class="icon-button"
          aria-label="Dismiss update"
          @click="updateAvailable = false"
        >
          <Icon name="close" />
        </button>
      </div>
      <div v-if="app.notice" class="banner" role="status">
        {{ app.notice
        }}<button
          class="icon-button"
          aria-label="Dismiss notification"
          @click="app.notice = ''"
        >
          <Icon name="close" />
        </button>
      </div>
      <main id="main" tabindex="-1" :lang="inJapanese ? 'zh-CN' : 'en'"><RouterView /></main>
      <footer class="app-footer" lang="zh-CN">
        <span>小步练习，用在真实生活。</span
        ><span>{{
          offlineReady
            ? "离线练习资源已准备好"
            : "练习先保存在本机；云端进度看同步状态"
        }}</span>
      </footer>
    </div>
  </div>
</template>
