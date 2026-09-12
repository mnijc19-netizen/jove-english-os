<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useApp } from "../stores/app";
import { nextAssignedTask, skillLabel, taskPath } from "../domain/engine";
import Icon from "../components/Icon.vue";
import type { PlanTask } from "../domain/types";
import { planRecovery, selectMeaningfulReviews } from "../domain/longitudinal";
const app = useApp();
const router = useRouter(), starting = ref(false), startError = ref("");
const recovery = computed(() => planRecovery(app.profile, app.events, app.clock));
const reviewSelection = computed(() => selectMeaningfulReviews(app.cards, app.events, app.clock, {
  budgetSeconds: Math.min(recovery.value.reviewBudgetSeconds, (app.plan.tasks.find(t => t.kind === 'review' && !t.done && !t.optional)?.minutes ?? 0) * 60),
  maxCards: recovery.value.maxReviewCards,
}));
const date = computed(() =>
  new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(app.clock)),
);
const requiredTasks = computed(() => app.plan.tasks.filter(task => !task.optional));
const optionalTasks = computed(() => app.plan.tasks.filter(task => task.optional));
const completed = computed(() => requiredTasks.value.filter((t) => t.done).length);
const next = computed(() => nextAssignedTask(app.plan));
const path = taskPath;
const material = computed(
  () =>
    app.materials.find(
      (m) => m.id === app.plan.tasks.find((t) => t.materialId)?.materialId,
    ) || app.materials[0],
);
const offered = new Set<string>();
watch(() => requiredTasks.value.filter(t => !t.done && t.minutes > 0).map(t => t.id).join('|'), async () => {
  for (const task of requiredTasks.value.filter(t => !t.done && t.minutes > 0)) {
    if (offered.has(task.id)) continue;
    offered.add(task.id);
    try { await app.evidence({ id: `offered:${task.id}`, type: 'TASK_OFFERED', source: 'objective',
      data: { taskId: task.id, kind: task.id.endsWith(':reading') ? 'reading' : task.kind } }); }
    catch { offered.delete(task.id); }
  }
}, { immediate: true });
async function start(task: PlanTask) {
  if (starting.value) return;
  starting.value = true; startError.value = '';
  try {
    if (!task.done) {
      await app.beginTask(task.id);
      await app.evidence({ id: `started:${task.id}`, type: 'TASK_STARTED', source: 'objective',
        data: { taskId: task.id, kind: task.id.endsWith(':reading') ? 'reading' : task.kind } });
    }
    await router.push(path(task));
  } catch { startError.value = 'Could not save your place. Please try starting again.'; }
  finally { starting.value = false; }
}
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
        <p v-if="app.contentState === 'loading'" class="help-text" role="status">Preparing suitable lessons and short audio. Your saved practice stays available.</p>
        <p v-else-if="app.contentState === 'empty'" class="help-text" role="status">Publisher lessons open at their source; your guided practice and progress stay here. Saved local lessons are also available.</p>
        <p v-else-if="app.contentState === 'error'" class="help-text" role="status">New lessons or audio could not finish loading. Your saved work is safe.
          <button class="text-button" @click="app.loadContent(true)">Retry loading</button>
        </p>
        <p v-else-if="app.contentState === 'offline'" class="help-text">Offline practice uses downloaded audio. New lessons will be checked when you reconnect.</p>
        <p v-if="recovery.mode !== 'none'" class="help-text" role="status">
          Ease back in with {{ app.plan.minutes }} minutes today. Shorter input and a small review selection;
          your load returns gradually as you practise again.
        </p>
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
              >{{ completed }} of {{ requiredTasks.length }} steps
              complete</span
            ><span>{{ app.plan.minutes }} min planned</span>
          </div>
          <div class="progress-track">
            <i
              :style="{
                width: (requiredTasks.length ? completed / requiredTasks.length : 0) * 100 + '%',
              }"
            ></i>
          </div>
        </div>
        <button
          v-if="next"
          class="button primary wide"
          :disabled="starting"
          @click="start(next)"
          >{{ completed ? "Continue my practice" : "Start today’s practice"
          }}<Icon name="arrow" :size="18"
        /></button>
        <div v-else class="success-note">
          <Icon name="check" />{{ completed === requiredTasks.length ? 'Today’s plan is complete.' : 'Your planned time is covered for today. Unfinished work stays saved.' }}
          Let it settle; there is no need to clear the backlog.
        </div>
        <RouterLink v-if="!next && app.due.length" :to="{ path: '/review', query: { extra: '1' } }" class="button secondary">Optional extra review</RouterLink>
        <div v-if="optionalTasks.length" class="section" aria-label="Optional saved practice">
          <p class="help-text">Other work you already began stays saved with its original time. It is optional, outside today’s required plan.</p>
          <div v-for="task in optionalTasks" :key="task.id">
            <p>{{ task.title }} · {{ task.minutes }} min · {{ task.done ? 'Saved' : 'Unfinished' }}</p>
            <button class="button secondary" :disabled="starting" @click="start(task)">{{ task.done ? 'View optional practice' : 'Continue optional practice' }}</button>
          </div>
        </div>
        <p v-if="startError" class="error" role="alert">{{ startError }}</p>
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
            <strong>{{ reviewSelection.selected.length }} selected to revisit</strong>
            <p>{{ reviewSelection.deferredCount ? 'Other due cards stay saved for later.' : 'A little retrieval goes a long way.' }}</p>
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
          v-for="(task, index) in requiredTasks"
          :key="task.id"
          :to="path(task)"
          class="task-row"
          :class="{ done: task.done }"
          @click.prevent="start(task)"
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
          ><span class="task-duration">{{ task.minutes ? `${task.minutes} min` : 'Saved for later' }}</span
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
          {{ material.externalStudy ? 'external lesson · guided short practice' : Math.round(material.duration) + ' seconds' }}
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
