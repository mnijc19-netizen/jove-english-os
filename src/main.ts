import { createApp } from "vue";
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
router.afterEach(() => {
  window.setTimeout(
    () =>
      document
        .querySelector<HTMLElement>("main h1")
        ?.focus({ preventScroll: true }),
    80,
  );
});
createApp(App).use(createPinia()).use(router).mount("#app");
