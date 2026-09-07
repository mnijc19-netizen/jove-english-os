<script setup lang="ts">
import { computed } from "vue";
import { useApp } from "../stores/app";
import { skillLabel } from "../domain/engine";
import Icon from "../components/Icon.vue";
import type { PlanTask } from "../domain/types";
const app = useApp();
const date = computed(() =>
  new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(app.clock)),
);
const completed = computed(() => app.plan.tasks.filter((t) => t.done).length);
const next = computed(() => app.plan.tasks.find((t) => !t.done));
const path = (task: PlanTask) => ({
  path:
    task.kind === "shadow"
      ? "/listen"
      : ["repair", "retell"].includes(task.kind)
        ? "/speak"
        : task.kind === "assessment"
          ? "/progress"
          : "/" + task.kind,
  query: {
    task: task.id,
    ...(task.materialId ? { material: task.materialId } : {}),
    ...(["shadow", "repair", "retell"].includes(task.kind)
      ? { mode: task.kind }
      : {}),
    ...(task.kind === "assessment" ? { assess: "1" } : {}),
  },
});
const material = computed(
  () =>
    app.materials.find(
      (m) => m.id === app.plan.tasks.find((t) => t.materialId)?.materialId,
    ) || app.materials[0],
);
</script>
<template>
  <div class="page today-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">{{ date }}</p>
        <h1 tabindex="-1">
          A little more natural,<br /><span class="serif">every day.</span>
        </h1>
        <p class="lede">
          Welcome back, {{ app.profile.name }}. Let’s turn what you know into
          what you can say.
        </p>
      </div>
      <div class="daily-date">
        <span>YOUR DAILY SPACE</span><Icon name="audio" :size="36" /><span
          >Listen. Speak. Make it yours.</span
        >
      </div>
    </div>
    <div v-if="!app.profile.onboarded" class="onboard-banner">
      <span class="small-icon"><Icon name="sparkle" /></span>
      <div>
        <strong>A plan that starts with you.</strong>
        <p>
          A short check-in helps us find your first listening and speaking
          focus.
        </p>
      </div>
      <RouterLink to="/onboarding" class="button secondary"
        >Find my starting point <Icon name="arrow" :size="16"
      /></RouterLink>
    </div>
    <div class="today-grid">
      <section class="training-card">
        <div class="row between">
          <span class="eyebrow">TODAY’S PRACTICE</span
          ><span class="pill"
            ><i class="tiny-dot"></i>Personalized for you</span
          >
        </div>
        <div class="training-title">
          <h2>
            From understanding<br />to <span class="serif">speaking.</span>
          </h2>
          <span class="focus-orbit" aria-hidden="true"
            ><Icon name="audio" :size="45"
          /></span>
        </div>
        <p class="muted">Your focus · {{ skillLabel(app.plan.focus) }}</p>
        <div class="time-options" aria-label="Practice duration">
          <button
            v-for="minutes in [45, 90, 150]"
            :key="minutes"
            :class="{ selected: app.profile.dailyMinutes === minutes }"
            :aria-pressed="app.profile.dailyMinutes === minutes"
            @click="app.saveProfile({ dailyMinutes: minutes })"
          >
            <Icon name="clock" :size="14" />{{ minutes }} min
          </button>
        </div>
        <div class="training-progress">
          <div>
            <span
              >{{ completed }} of {{ app.plan.tasks.length }} steps
              complete</span
            ><span>{{ app.plan.minutes }} min planned</span>
          </div>
          <div class="progress-track">
            <i
              :style="{
                width: (completed / app.plan.tasks.length) * 100 + '%',
              }"
            ></i>
          </div>
        </div>
        <RouterLink
          v-if="next"
          :to="path(next)"
          class="button primary wide"
          @click="app.beginTask(next.id)"
          >{{ completed ? "Continue my practice" : "Start today’s practice"
          }}<Icon name="arrow" :size="18"
        /></RouterLink>
        <div v-else class="success-note">
          <Icon name="check" />Today’s plan is complete. Let it settle; your
          next review will appear when it’s due.
        </div>
        <p class="card-footnote">
          <Icon name="shield" :size="14" />Your progress saves as you go.
        </p>
      </section>
      <aside class="today-side">
        <section class="panel focus-card">
          <div class="row">
            <span class="small-icon"><Icon name="today" /></span>
            <p class="eyebrow">WHY THIS FOCUS</p>
          </div>
          <h3>Make the familiar<br />feel automatic.</h3>
          <p>
            {{
              app.events.length
                ? "Your recent practice helps choose the next task. Listening, recall and spontaneous speaking are tracked separately."
                : "Start with a small baseline. Your plan will adapt as we learn what you recognize, hear and can use on your own."
            }}
          </p>
          <RouterLink to="/progress" class="text-button"
            >See your learning profile <Icon name="arrow" :size="15"
          /></RouterLink>
        </section>
        <section class="review-teaser">
          <Icon name="review" :size="25" />
          <div>
            <strong>{{ app.due.length }} ready to revisit</strong>
            <p>A little retrieval goes a long way.</p>
          </div>
          <RouterLink
            to="/review"
            class="icon-button"
            aria-label="Open due reviews"
            ><Icon name="arrow"
          /></RouterLink>
        </section>
        <label class="energy-row"
          >Today’s energy<select
            :value="app.profile.fatigue"
            @change="
              app.saveProfile({
                fatigue: Number(($event.target as HTMLSelectElement).value),
              })
            "
          >
            <option :value="0">Feeling fresh</option>
            <option :value="0.4">Taking it steady</option>
            <option :value="0.8">Low energy</option>
          </select></label
        >
      </aside>
    </div>
    <section class="section">
      <div class="section-title">
        <h2>Your practice path</h2>
        <span class="muted">One thing at a time.</span>
      </div>
      <div class="task-list">
        <RouterLink
          v-for="(task, index) in app.plan.tasks"
          :key="task.id"
          :to="path(task)"
          class="task-row"
          :class="{ done: task.done }"
          @click="app.beginTask(task.id)"
          ><span class="task-number"
            ><Icon v-if="task.done" name="check" :size="17" /><span v-else>{{
              String(index + 1).padStart(2, "0")
            }}</span></span
          ><span class="task-icon"
            ><Icon
              :name="
                task.kind === 'shadow'
                  ? 'audio'
                  : task.kind === 'repair'
                    ? 'refresh'
                    : task.kind === 'retell'
                      ? 'speak'
                      : task.kind
              " /></span
          ><span class="task-copy"
            ><strong>{{ task.title }}</strong
            ><small>{{ task.reason }}</small></span
          ><span class="task-duration">{{ task.minutes }} min</span
          ><Icon name="right" :size="17"
        /></RouterLink>
      </div>
    </section>
    <section v-if="material" class="material-feature">
      <div>
        <span class="eyebrow">A SMALL WINDOW INTO REAL LIFE</span>
        <h2>{{ material.title }}</h2>
        <p>
          {{ material.topic }} · {{ material.sourceLabel }} ·
          {{ Math.round(material.duration) }} seconds
        </p>
      </div>
      <RouterLink
        :to="'/listen?material=' + material.id"
        class="button secondary"
        >Listen & explore <Icon name="arrow" :size="16"
      /></RouterLink>
    </section>
  </div>
</template>
