import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import "./styles.css";

const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", redirect: "/today" },
    { path: "/today", component: () => import("./pages/Today.vue") },
    { path: "/onboarding", component: () => import("./pages/Onboarding.vue") },
    { path: "/listen", component: () => import("./pages/Listen.vue") },
    { path: "/learn", component: () => import("./pages/Learn.vue") },
    { path: "/speak", component: () => import("./pages/Speak.vue") },
    { path: "/review", component: () => import("./pages/Review.vue") },
    { path: "/library", component: () => import("./pages/Library.vue") },
    { path: "/progress", component: () => import("./pages/Progress.vue") },
    { path: "/settings", component: () => import("./pages/Settings.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/today" },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
router.afterEach((to, _from, failure) => {
  if (failure) return;
  const destination = to.fullPath;
  const previousFocus = document.activeElement;
  // Wait for the actual route render, not an elapsed-time guess that can steal
  // focus between a user's focus/selection and their next input event.
  void nextTick(() => {
    if (router.currentRoute.value.fullPath !== destination) return;
    const active = document.activeElement;
    if (active !== document.body && active !== previousFocus) return;
    if (active instanceof HTMLElement && active.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true });
  });
});
createApp(App).use(createPinia()).use(router).mount("#app");
