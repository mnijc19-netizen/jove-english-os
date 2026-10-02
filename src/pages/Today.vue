<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useApp } from "../stores/app";
import { englishTaskGuide, englishLearningOutcome, nextAssignedTask, taskPath } from "../domain/engine";
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
  new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(app.clock)),
);
const requiredTasks = computed(() => app.plan.tasks.filter(task => !task.optional));
const optionalTasks = computed(() => app.plan.tasks.filter(task => task.optional));
const completed = computed(() => requiredTasks.value.filter((t) => t.done).length);
const next = computed(() => nextAssignedTask(app.plan));
const nextGuide = computed(() => next.value ? englishTaskGuide(next.value) : null);
const nextMaterial = computed(() => app.materials.find(m => m.id === next.value?.materialId));
const outcome = computed(() => next.value ? englishLearningOutcome(next.value, nextMaterial.value) : null);
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
      if (!await app.beginTask(task.id)) { startError.value = 'Today’s plan changed. Your saved work is safe; choose the next available task.'; return; }
    }
    await router.push(path(task));
  } catch { startError.value = 'Could not save your place. Please try starting again.'; }
  finally { starting.value = false; }
}
</script>
<template>
  <div class="page today-page" lang="zh-CN">
    <div class="page-heading">
      <div>
        <p class="eyebrow">{{ date }}</p>
        <h1 tabindex="-1">
          今天，练会一点真实表达。
        </h1>
        <p class="lede">
          {{ app.profile.name }}，不用选课。跟着下一步，先尝试，再获得帮助。
        </p>
      </div>
      <div class="daily-date">
        <span>英语学习</span><Icon name="audio" :size="36" /><span
          >听懂 · 表达 · 以后还会用</span
        >
      </div>
    </div>
    <div v-if="!app.profile.onboarded" class="onboard-banner">
      <span class="small-icon"><Icon name="sparkle" /></span>
      <div>
        <strong>第一次来？先找到合适起点。</strong>
        <p>
          做一次简短了解，之后由系统安排；现在也可以直接开始下面的练习。
        </p>
      </div>
      <RouterLink to="/onboarding" class="button secondary" aria-label="Find my starting point"
        >找到我的学习起点<Icon name="arrow" :size="16"
      /></RouterLink>
    </div>
    <div class="today-grid">
      <section class="training-card">
        <div class="row between">
          <span class="eyebrow">现在只做这一项</span
          ><span class="pill"
            ><i class="tiny-dot"></i>系统已安排</span
          >
        </div>
        <div class="training-title">
          <h2>
            {{ nextGuide?.title || '今天到这里就好。' }}
          </h2>
          <span class="focus-orbit" aria-hidden="true"
            ><Icon name="audio" :size="45"
          /></span>
        </div>
        <p v-if="outcome" class="learning-goal" data-testid="daily-learning-goal">{{ outcome.goal }}</p>
        <button v-if="next" class="button primary wide next-action" :disabled="starting" :aria-label="completed ? 'Continue my practice' : 'Start today’s practice'" @click="start(next)">
          {{ completed ? '接着练习' : '开始学习' }} · 约 {{ next.minutes }} 分钟<Icon name="arrow" :size="18" />
        </button>
        <p class="help-text">只需调整今天的时间与精力；可以暂停，未完成的内容会保留。</p>
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
        <p v-if="app.sharedDay" class="help-text">两种语言共用今天的 {{ app.sharedDay.totalMinutes }} 分钟；英语还可安排 {{ app.sharedDay.allowances.en.remaining }} 分钟，日语 {{ app.sharedDay.allowances.ja.remaining }} 分钟。切换语言不会增加任务量。</p>
        <div class="time-options" aria-label="Practice duration">
          <button
            v-for="minutes in [15, 30, 45, 90, 150]"
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
              >已练 {{ completed }} / {{ requiredTasks.length }} 项 · 不是掌握率</span
            ><span>今天最多安排 {{ app.plan.minutes }} 分钟</span>
          </div>
          <div class="progress-track">
            <i
              :style="{
                width: (requiredTasks.length ? completed / requiredTasks.length : 0) * 100 + '%',
              }"
            ></i>
          </div>
        </div>
        <section v-if="next && nextGuide" class="next-practice-guide" aria-label="下一项学习指引" lang="zh-CN">
          <h3>{{ nextGuide.title }} · 约 {{ next.minutes }} 分钟</h3>
          <ol><li v-for="step in nextGuide.steps" :key="step">{{ step }}</li></ol>
          <p class="help-text">卡住先保留尝试，再用提示；每次只改一处，不用反复硬听到疲惫。</p>
          <details v-if="outcome" class="learning-continuity"><summary>怎样知道不是只看过视频？</summary><p>{{ outcome.check }}</p><p>{{ outcome.later }}</p></details>
        </section>
        <div v-if="!next" class="success-note">
          <Icon name="check" />{{ completed === requiredTasks.length ? '今天的练习已保存。' : '今天先到这里，未完成的尝试还在。' }}
          下次从回忆和应用接续，不必为了完成任务再加量。
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
          <Icon name="shield" :size="14" />先保存你的尝试，AI 或网络失败也能接续。
        </p>
      </section>
      <aside class="today-side">
        <section class="panel focus-card">
          <div class="row">
            <span class="small-icon"><Icon name="today" /></span>
            <p class="eyebrow">为什么这样练</p>
          </div>
          <h3>从看懂，走向自己能用。</h3>
          <p>
            {{
              app.events.length
                ? "今天的输入、你的表达和后续复习连接在一起。AI 分析实际回答，确认的纠错安排再练；不同能力分开记录。"
                : "先从一小段和一个生活目标开始。系统会根据实际尝试逐步调整，不凭打卡或看过视频给能力分数。"
            }}
          </p>
          <RouterLink to="/progress" class="text-button"
            >查看真实学习证据 <Icon name="arrow" :size="15"
          /></RouterLink>
        </section>
        <section class="review-teaser">
          <Icon name="review" :size="25" />
          <div>
            <strong>今天挑选 {{ reviewSelection.selected.length }} 项复习</strong>
            <p>{{ reviewSelection.deferredCount ? '其他到期项保留，不要求清空积压。' : '复习是把以前的表达再用出来，不是重复看答案。' }}</p>
          </div>
          <RouterLink
            to="/review"
            class="icon-button"
            aria-label="Open due reviews"
            ><Icon name="arrow"
          /></RouterLink>
        </section>
        <label class="energy-row"
          >今天的精力<select
            :value="app.profile.fatigue"
            @change="
              app.saveProfile({
                fatigue: Number(($event.target as HTMLSelectElement).value),
              })
            "
          >
            <option :value="0">状态很好</option>
            <option :value="0.4">正常，稳一点</option>
            <option :value="0.8">有点累，轻一些</option>
          </select></label
        >
      </aside>
    </div>
    <section class="section">
      <div class="section-title">
        <h2>今天的接续顺序</h2>
        <span class="muted">不必自己决定先后，也不必一次做完。</span>
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
            ><strong>{{ englishTaskGuide(task).title }}</strong
            ><small>{{ task.materialId ? app.materials.find(m => m.id === task.materialId)?.title || task.title : '接续你的表达与复习' }}</small></span
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
          {{ material.externalReading ? '原版分级阅读' : material.externalStudy ? 'external lesson · guided short practice' : Math.round(material.duration) + ' seconds' }}
        </p>
      </div>
      <RouterLink
        :to="{ path: material.externalReading ? '/learn' : '/listen', query: { material: material.id, ...(material.externalReading ? { mode: 'reading' } : {}) } }"
        class="button secondary"
        >{{ material.externalReading ? '阅读原文' : 'Listen & explore' }} <Icon name="arrow" :size="16"
      /></RouterLink>
    </section>
  </div>
</template>
