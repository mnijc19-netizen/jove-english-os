<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { registerSW } from "virtual:pwa-register";
import { useApp } from "./stores/app";
import Icon from "./components/Icon.vue";
import { useCloud } from "./stores/cloud";
const cloud = useCloud();
const app = useApp(),
  route = useRoute(),
  menu = ref(false),
  updateAvailable = ref(false),
  applyingUpdate = ref(false),
  offlineReady = ref(false);
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
  "Today",
  "Listen",
  "Speak",
  "Learn",
  "Review",
  "Library",
  "Progress",
];
const page = computed(() => route.path.slice(1) || "today");
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
watch(
  () => route.path,
  () => {
    menu.value = false;
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
  // A first-install Workbox instance keeps isUpdate=false even on a later
  // controller handoff. Reload on that native event only after explicit consent.
  navigator.serviceWorker?.addEventListener("controllerchange", reloadAfterUpdate);
  return app.init();
});
onUnmounted(() => {
  clearUpdateRecovery();
  navigator.serviceWorker?.removeEventListener("controllerchange", reloadAfterUpdate);
});
function focusPractice() {
  document.getElementById("main")?.focus();
}
</script>
<template>
  <a class="skip-link" href="#main" @click.prevent="focusPractice">Skip to practice</a>
  <div v-if="app.fatal" class="fatal">
    <h1 tabindex="-1">Let’s recover your workspace.</h1>
    <p>{{ app.fatal }}</p>
    <button @click="app.init">Try again</button>
  </div>
  <div v-else-if="!app.ready" class="boot" role="status">
    <span class="brand-mark">j.</span>
    <p>Opening your learning space…</p>
  </div>
  <div v-else class="app-shell">
    <header class="mobile-header">
      <RouterLink to="/today" class="brand"
        ><span class="brand-mark">j.</span>Jove Language<span class="os"
          >OS</span
        ></RouterLink
      ><button
        class="icon-button"
        aria-label="Toggle navigation"
        :aria-expanded="menu"
        @click="menu = !menu"
      >
        <Icon :name="menu ? 'close' : 'menu'" />
      </button>
    </header>
    <aside class="sidebar" :class="{ open: menu }">
      <RouterLink to="/today" class="brand desktop-brand"
        ><span class="brand-mark">j.</span
        ><span
          >Jove Language<small>YOUR PERSONAL PRACTICE</small></span
        ></RouterLink
      >
      <p class="nav-label">YOUR WORKSPACE</p>
      <nav aria-label="Main navigation">
        <RouterLink
          v-for="item in nav"
          :key="item"
          :to="'/' + item.toLowerCase()"
          class="nav-item"
          ><Icon :name="item.toLowerCase()" /><span>{{ item }}</span
          ><span v-if="item === 'Review' && app.due.length" class="nav-count">{{
            app.due.length
          }}</span
          ><span v-if="item === 'Today'" class="nav-dot"></span
        ></RouterLink>
      </nav>
      <div class="sidebar-bottom">
        <div class="local-note">
          <Icon name="shield" :size="18" /><span
            >Your space. Your progress.<small role="status">{{ cloud.status }}</small></span
          >
        </div>
        <RouterLink to="/settings" class="nav-item"
          ><Icon name="settings" />Settings</RouterLink
        >
        <div class="profile-row">
          <span class="avatar">{{
            app.profile.name.slice(0, 1).toUpperCase()
          }}</span>
          <div>
            <strong>{{ app.profile.name }}</strong
            ><small>English, a little more natural.</small>
          </div>
          <button
            class="icon-button"
            aria-label="Toggle dark mode"
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
    <div v-if="menu" class="sidebar-scrim" @click="menu = false"></div>
    <div class="main-wrap">
      <div class="topbar">
        <span class="breadcrumb"
          >Workspace <span>/</span>
          <span class="capitalize">{{ page }}</span></span
        ><span class="connection"
          ><i :class="{ offline: !app.online }"></i
          >{{
            app.online
              ? "Local workspace"
              : "Offline · local practice available"
          }}</span
        >
      </div>
      <div v-if="updateAvailable" class="banner">
        <span
          >A new version is ready. Save your current practice before
          refreshing.</span
        ><button class="text-button" :disabled="applyingUpdate" @click="applyUpdate">Update now</button>
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
      <main id="main" tabindex="-1"><RouterView /></main>
      <footer class="app-footer">
        <span>Small practice. Real-world confidence.</span
        ><span>{{
          offlineReady
            ? "Ready for offline practice"
            : "Your learning stays on this device"
        }}</span>
      </footer>
    </div>
  </div>
</template>
