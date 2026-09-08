<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useApp } from "../stores/app";
import { reviewCard } from "../db/repository";
import { useRequest } from "../composables/useRequest";
import type { Modality, ReviewCard } from "../domain/types";
import AudioPlayer from "../components/AudioPlayer.vue";
import Recorder from "../components/Recorder.vue";
import Icon from "../components/Icon.vue";
import { db } from "../db/db";
import { missions } from "../content/materials";
import { planRecovery, selectMeaningfulReviews } from "../domain/longitudinal";
import { liveQuery } from "dexie";
import { onUnmounted } from "vue";
import { resolveEventAliases, resolveReviewAttempts } from "../sync/journal";
import { reviewAttempt, reviewAttemptCompleted, selectedReviewCard, type ReviewAttempt } from "../sync/review";
const app = useApp(),
  filter = ref("all"),
  response = ref(""),
  revealed = ref(false),
  hint = ref(false),
  recording = ref(""),
  recorderActive = ref(false),
  completed = ref(0),
  saving = ref(false),
  error = ref(""),
  heard = ref(false),
  sttText = ref(""),
  evaluated = ref<number | null>(null);
const ai = useRequest();
const route = useRoute();
const router = useRouter();
const extra = computed(() => typeof route.query.extra === 'string' && /^\d{1,6}$/.test(route.query.extra) ? route.query.extra : null);
const loaded = ref(false);
const block = ref<{ id: string; taskId?: string; startedAt: number; items: ReviewAttempt[] }>();
const aliases = ref<{ cards: Record<string, string>; events: Record<string, string[]> }>({ cards: {}, events: {} });
const aliasSubscription = liveQuery(async () => ({
  cards: ((await db.syncMeta.get('cardAliases'))?.value ?? {}) as Record<string, string>,
  events: ((await db.syncMeta.get('eventAliases'))?.value ?? {}) as Record<string, string[]>,
})).subscribe(value => { aliases.value = value; });
onUnmounted(() => aliasSubscription.unsubscribe());
const blockReady = ref(false);
const blockScope = computed(() => (typeof route.query.task === 'string' && !extra.value ? route.query.task : new Date(app.clock).toLocaleDateString('en-CA'))
  + (extra.value ? `:extra:${extra.value}` : ''));
let blockVersion = 0;
const reviewed = (item: ReviewAttempt) => reviewAttemptCompleted(item, app.events, aliases.value.cards, aliases.value.events);
const blockDone = computed(() => blockReady.value && !!block.value?.items.length && block.value.items.every(reviewed));
let completing: Promise<void> | undefined;
async function finishBlock() {
  if (!blockDone.value || !block.value) return;
  if (completing) return completing;
  const saved = block.value;
  completing = (async () => {
    await app.evidence({ id: `${saved.id}:completed`, type: 'REVIEW_BLOCK_COMPLETED', source: 'objective', sessionId: saved.id,
      data: { reviewedCardIds: saved.items.map(item => item.cardId), attemptIds: saved.items.map(item => item.attemptId),
        ...(saved.taskId ? { taskId: saved.taskId } : {}) } });
    if (saved.taskId) await app.completeTask('review', { taskId: saved.taskId });
  })();
  try { await completing; } finally { completing = undefined; }
}
watch(blockDone, done => { if (done) void finishBlock().catch(() => { error.value = 'Your reviews are saved. Reload to retry completing this block.'; }); });
const missingSelection = computed(() => blockReady.value && block.value?.items.some(item => !reviewed(item)
  && !selectedReviewCard(item, app.cards, aliases.value.cards)));
const queue = computed(() => !blockReady.value ? [] : (block.value?.items ?? []).filter(item => !reviewed(item)).flatMap(item => {
  const current = selectedReviewCard(item, app.cards, aliases.value.cards);
  return current ? [current] : [];
}));
watch([blockScope, filter], async () => {
  const version = ++blockVersion, id = `review-block:${blockScope.value}:${filter.value}`;
  blockReady.value = false;
  try {
    const saved = await db.sessions.get(id);
    if (version !== blockVersion) return;
    const savedItems = Array.isArray(saved?.draft.items) ? saved.draft.items : [];
    const cardAliases = ((await db.syncMeta.get('cardAliases'))?.value ?? {}) as Record<string, string>;
    const items = await resolveReviewAttempts(db, id, savedItems, cardAliases);
    const taskId = extra.value ? undefined : typeof route.query.task === 'string' ? route.query.task : app.plan.tasks.find(t => t.kind === 'review' && !t.done)?.id;
    if (!items.length) {
      const recovery = planRecovery(app.profile, app.events, app.clock);
      const assigned = !extra.value && typeof route.query.task === 'string' ? app.plan.tasks.find(t => t.id === taskId) : undefined;
      const selection = selectMeaningfulReviews(app.cards.filter(c => filter.value === 'all' || c.modality === filter.value), app.events, app.clock, {
        budgetSeconds: Math.min(recovery.reviewBudgetSeconds, assigned ? assigned.minutes * 60 : Infinity), maxCards: recovery.maxReviewCards,
      });
      for (const cardId of selection.selectedIds) {
        const current = app.cards.find(c => c.id === cardId)!;
        items.push(reviewAttempt(cardId, current.card.reps));
      }
    }
    const started = saved?.startedAt ?? Date.now();
    const owner = typeof saved?.draft.taskId === 'string' ? saved.draft.taskId : taskId;
    if (owner) await app.beginTask(owner);
    await db.sessions.put({ id, kind: 'review-block', startedAt: started, stage: 'selection', draft: { items, ...(owner ? { taskId: owner } : {}) } });
    if (version !== blockVersion) return;
    block.value = { id, items, startedAt: started, ...(owner ? { taskId: owner } : {}) };
    completed.value = items.filter(reviewed).length;
    blockReady.value = true;
  } catch (failure) { if (version === blockVersion) error.value = failure instanceof Error && failure.message.startsWith('Legacy review selection')
    ? failure.message : 'Could not save your review selection. Keep your work and reload to retry.'; }
}, { immediate: true });
const card = computed(() => queue.value[0]),
  chunk = computed(() => app.chunks.find((c) => c.id === card.value?.chunkId));
const attempt = computed(() => card.value ? block.value?.items.find(item => !reviewed(item)
  && selectedReviewCard(item, app.cards, aliases.value.cards)?.id === card.value!.id) : undefined);
watch(() => block.value?.items.filter(reviewed).length ?? 0, value => { completed.value = value; });
const context = ref("");
const contextReused = ref(false);
const usesContext = (modality?: Modality) => modality === "speaking" || modality === "transfer";
const contextKey = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
const contextVariations = [
  "Explain what changed and agree a next step.",
  "Disagree politely and suggest an alternative.",
  "Ask for clarification, then explain your own needs.",
  "Respond to an unexpected problem and check understanding.",
];
const contexts = missions.flatMap(m => contextVariations.map(variation => `${m.scene} ${variation}`));
async function contextFor(active: ReviewCard, draft?: Record<string, unknown>) {
  if (!usesContext(active.modality)) return { text: "", reused: false };
  const responseIds = new Set(await resolveEventAliases(db, attempt.value!.responseEventId));
  const [siblings, events] = await Promise.all([
    db.cards.where("chunkId").equals(active.chunkId).toArray(),
    db.events.where("chunkId").equals(active.chunkId).toArray(),
  ]);
  const used = new Set([
    ...siblings.flatMap(card => card.contextIds),
    ...events.filter(event => !responseIds.has(event.id) && event.contextId).map(event => event.contextId!),
  ].map(contextKey));
  const saved = typeof draft?.context === "string" ? draft.context : "";
  // Preserve a response's original prompt. If it has become familiar, label it honestly.
  const hasWork = !!(typeof draft?.response === "string" && draft.response.trim())
    || !!draft?.recording || !!draft?.sttText || draft?.revealed === true || draft?.hint === true;
  const text = saved && (hasWork || !used.has(contextKey(saved))) ? saved
    : contexts.find(candidate => !used.has(contextKey(candidate))) ?? contexts[active.card.reps % contexts.length] ?? "Describe an everyday situation and explain what you need.";
  return { text, reused: used.has(contextKey(text)) };
}
const attemptKey = computed(() =>
  attempt.value?.draftId ?? "",
);
let startedAt = Date.now();
async function persist() {
  if (!loaded.value || !attemptKey.value) return false;
  const id = attemptKey.value;
  try {
    await db.sessions.put({
      id,
      kind: "review",
      startedAt,
      stage: revealed.value ? "checked" : "answer",
      draft: {
        attemptId: attempt.value!.attemptId,
        responseEventId: attempt.value!.responseEventId,
        cardId: attempt.value!.cardId,
        response: response.value,
        revealed: revealed.value,
        hint: hint.value,
        recording: recording.value,
        heard: heard.value,
        sttText: sttText.value,
        evaluated: evaluated.value,
        ...(usesContext(card.value?.modality) ? { context: context.value } : {}),
      },
    });
    if (id === attemptKey.value) error.value = "";
    return true;
  } catch {
    if (id === attemptKey.value) error.value = "Could not save this attempt. Keep this page open and retry.";
    return false;
  }
}
watch(
  attemptKey,
  async (id) => {
    loaded.value = false;
    reset();
    if (!id) return;
    const active = card.value!;
    const saved = await db.sessions.get(id);
    if (id !== attemptKey.value) return;
    const d = saved?.draft;
    startedAt = saved?.startedAt ?? Date.now();
    response.value = typeof d?.response === "string" ? d.response : "";
    revealed.value = d?.revealed === true;
    hint.value = d?.hint === true;
    recording.value = typeof d?.recording === "string" ? d.recording : "";
    heard.value = d?.heard === true;
    sttText.value = typeof d?.sttText === "string" ? d.sttText : "";
    evaluated.value = typeof d?.evaluated === "number" ? d.evaluated : null;
    const selected = await contextFor(active, d);
    if (id !== attemptKey.value) return;
    context.value = selected.text;
    contextReused.value = selected.reused;
    loaded.value = true;
    await persist();
  },
  { immediate: true, flush: "sync" },
);
watch(
  [response, revealed, hint, recording, heard, sttText, evaluated],
  persist,
  { flush: "sync" },
);
const prompts: Record<Modality, string> = {
  recognition: "Read the expression. Explain its meaning.",
  listening: "Listen first. Write the expression you hear.",
  recall: "Recall the English expression from its meaning.",
  cloze: "Complete the missing expression.",
  speaking: "Answer aloud using the expression naturally.",
  transfer: "Use this idea in a new situation.",
};
function reset() {
  context.value = "";
  contextReused.value = false;
  response.value = "";
  revealed.value = false;
  hint.value = false;
  recording.value = "";
  recorderActive.value = false;
  error.value = "";
  heard.value = false;
  sttText.value = "";
  evaluated.value = null;
}
async function check() {
  if (!loaded.value || saving.value || ai.busy.value || recorderActive.value || !card.value || !chunk.value) return;
  const submitted = { key: attemptKey.value, response: response.value, context: context.value, chunkText: chunk.value.text, modality: card.value.modality };
  // Lock recording before the draft-save await, not only once evaluation starts.
  saving.value = true;
  try {
  if (!await persist()) return;
  if (
    usesContext(submitted.modality) &&
    app.keySet &&
    submitted.response.trim()
  ) {
    const result = await ai.run((signal) =>
      app.provider.evaluate(
        {
          kind: "independent expression use",
          text: submitted.response,
          reference: submitted.context,
          targets: [submitted.chunkText],
        },
        signal,
      ),
    );
    if (submitted.key !== attemptKey.value || submitted.response !== response.value || submitted.context !== context.value) return;
    if (result)
      evaluated.value = result.successfulChunks.some(
        (s) => s.toLowerCase() === submitted.chunkText.toLowerCase(),
      )
        ? (result.accuracy ?? 0.7)
        : 0;
  }
  if (submitted.key === attemptKey.value && submitted.response === response.value) revealed.value = true;
  } finally { saving.value = false; }
}
async function rate(rating: 1 | 2 | 3 | 4) {
  if (!loaded.value || !revealed.value || !card.value || saving.value || ai.busy.value || recorderActive.value || !chunk.value) return;
  const submitted = {
    active: card.value, chunk: chunk.value, sessionId: attemptKey.value, attempt: attempt.value!,
    response: response.value, hint: hint.value, heard: heard.value,
    recording: recording.value, sttText: sttText.value, evaluated: evaluated.value,
    context: usesContext(card.value.modality) ? context.value : undefined,
  };
  saving.value = true;
  try {
    const active = submitted.active;
    if (!await persist()) return;
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, "")
        .trim()
        .replace(/\s+/g, " ");
    const exact = normalize(submitted.response) === normalize(submitted.chunk.text);
    const objective =
      ["recall", "cloze"].includes(active.modality) ||
      (active.modality === "listening" && submitted.heard);
    const actual = objective ? (exact ? 1 : 0) : submitted.evaluated;
    const chosen = actual === 0 ? 1 : rating;
    const verified =
      !!submitted.recording &&
      !!submitted.sttText.trim() &&
      submitted.sttText.trim() === submitted.response.trim();
    // A sync collision can move the original response to a projection alias.
    // Do not create a second response occurrence when retrying that same attempt.
    const responseIds = await resolveEventAliases(db, submitted.attempt.responseEventId);
    const previousResponses = await db.events.bulkGet(responseIds);
    if (!previousResponses.some(event => event?.type === 'REVIEW_RESPONSE' && event.sessionId === submitted.sessionId
      && event.chunkId === submitted.chunk.id && event.modality === active.modality)) await app.evidence({
      id: submitted.attempt.responseEventId,
      type: "REVIEW_RESPONSE",
      source: "text",
      sessionId: submitted.sessionId,
      chunkId: submitted.chunk.id,
      modality: active.modality,
      prompted: submitted.hint,
      ...(submitted.context ? { contextId: submitted.context } : {}),
      data: {
        attemptId: submitted.attempt.attemptId,
        response: submitted.response,
        ...(submitted.recording ? { audioId: submitted.recording } : {}),
        transcriptVerified: verified,
      heard: submitted.heard,
        ...(block.value?.taskId ? { taskId: block.value.taskId } : {}),
      },
    });
    const oldReviews = await db.events.bulkGet(await resolveEventAliases(db, submitted.attempt.attemptId));
    const legacyRetry = submitted.attempt.legacy && oldReviews.some(event => event?.type === 'review'
      && event.sessionId === undefined && event.data?.responseEventId === undefined);
    await reviewCard(active.id, chosen, {
      eventId: submitted.attempt.attemptId,
      ...(!legacyRetry ? { responseEventId: submitted.attempt.responseEventId, sessionId: submitted.sessionId } : {}),
      expectedReps: active.card.reps,
      prompted: submitted.hint,
      ...(submitted.context ? { contextId: submitted.context } : {}),
      source: objective
        ? active.modality === "listening"
          ? "objective"
          : "text"
        : submitted.evaluated !== null && verified
          ? "ai"
          : "self-report",
      score: actual ?? (rating === 1 ? 0 : rating === 2 ? 0.5 : 1),
      audioObserved: verified,
      transcriptVerified: verified,
      ...(verified ? { audioId: submitted.recording } : {}),
    });
    await app.refresh();
    completed.value = block.value?.items.filter(reviewed).length ?? 0;
    await finishBlock();
  } catch {
    // A concurrent replay may change reps while the draft is being saved. Keep
    // this attempt/draft identity and refresh the CAS value for an honest retry.
    await app.refresh().catch(() => {});
    error.value =
      "Could not save this review. Your answer is still here; try again.";
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <div class="page task-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">A LITTLE RETRIEVAL. A STRONGER MEMORY.</p>
        <h1 tabindex="-1">Bring it <span class="serif">back.</span></h1>
        <p class="lede">
          Try to recall before revealing. The effort is part of the learning.
        </p>
      </div>
      <span class="count-badge">{{ queue.length }} in this selection</span>
    </div>
    <p class="help-text">A small, saved selection for this practice. Other due cards remain in your library with their original schedules.</p>
    <div class="review-toolbar">
      <label
        >Practice type<select v-model="filter" :disabled="saving || ai.busy.value || recorderActive">
          <option value="all">Recommended mix</option>
          <option
            v-for="m in [
              'recognition',
              'listening',
              'recall',
              'cloze',
              'speaking',
              'transfer',
            ]"
            :key="m"
            :value="m"
          >
            {{ m.charAt(0).toUpperCase() + m.slice(1) }}
          </option>
        </select></label
      ><span class="muted">{{ completed }} revisited this session</span>
    </div>
    <section v-if="card && chunk" class="panel flashcard">
      <div class="row between">
        <span class="pill capitalize">{{ card.modality }}</span
        ><span class="eyebrow">RETRIEVE → CHECK → RESCHEDULE</span>
      </div>
      <p class="review-instruction">{{ prompts[card.modality] }}</p>
      <AudioPlayer
        v-if="card.modality === 'listening'"
        :key="card.id"
        :text="chunk.text"
        label="Listen without reading the expression."
        compact
        synthetic
        @played="heard = true"
      />
      <h2 v-else-if="card.modality === 'recognition'">{{ chunk.text }}</h2>
      <h2 v-else-if="card.modality === 'cloze'">
        {{
          chunk.sourceSentence.replace(
            new RegExp(chunk.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
            "________",
          )
        }}
      </h2>
      <template v-else
        ><p
          v-if="card.modality === 'transfer' || card.modality === 'speaking'"
          class="context-prompt"
        >
          {{ context }}
        </p>
        <p v-if="usesContext(card.modality) && contextReused" class="help-text context-reuse-note">
          Previously used context · practice, not new-context evidence.
        </p>
        <h2>{{ chunk.meaningEn }}</h2></template
      ><Recorder
        v-if="['speaking', 'transfer'].includes(card.modality)"
        :key="card.id"
        :saved-audio-id="recording"
        :disabled="ai.busy.value || saving"
        @active="recorderActive = $event"
        @recorded="
          recording = $event.audioId;
          sttText = '';
          evaluated = null;
        "
        @transcribed="
          response = $event;
          sttText = $event;
          evaluated = null;
        "
      /><label for="review-answer">{{
        ["speaking", "transfer"].includes(card.modality)
          ? "Your transcript or written response"
          : "Your answer"
      }}</label
      ><textarea
        id="review-answer"
        v-model="response"
        rows="3"
        placeholder="Try before you look."
        :readonly="revealed || ai.busy.value || saving"
        :disabled="!loaded"
      />
      <div v-if="!revealed" class="row between">
        <button class="text-button" @click="hint = true">Need a hint?</button
        ><button
          class="button primary"
          :disabled="
            ai.busy.value ||
            saving || recorderActive || !loaded ||
            (!response.trim() && !recording) ||
            (card.modality === 'listening' && !heard)
          "
          @click="check"
        >
          Check my answer <Icon name="arrow" :size="16" />
        </button>
      </div>
      <p v-if="hint" class="hint">
        Starts with “{{ chunk.text.split(" ")[0] }}…” · {{ chunk.meaningZh }}
      </p>
      <div v-if="revealed" class="review-answer">
        <p class="eyebrow">COMPARE WITH YOUR RESPONSE</p>
        <h2>{{ chunk.text }}</h2>
        <p>{{ chunk.meaningEn }}</p>
        <blockquote>{{ chunk.sourceSentence }}</blockquote>
        <p class="help-text">
          Self-grade your recall honestly.
          {{
            hint
              ? "A hint was used; this attempt will not count as independent mastery."
              : "Can you generate it again without this answer in view?"
          }}
        </p>
        <div class="rating-grid">
          <button :disabled="saving || ai.busy.value || recorderActive" @click="rate(1)">
            <strong>Again</strong><small>Couldn’t recall</small></button
          ><button :disabled="saving || ai.busy.value || recorderActive" @click="rate(2)">
            <strong>Hard</strong><small>With effort</small></button
          ><button :disabled="saving || ai.busy.value || recorderActive" @click="rate(3)">
            <strong>Good</strong><small>Independent</small></button
          ><button :disabled="saving || ai.busy.value || recorderActive" @click="rate(4)">
            <strong>Easy</strong><small>Immediate</small>
          </button>
        </div>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="ai.error.value" class="error" role="alert">
        {{ ai.error.value }} Your response is saved in this review; use the
        self-check below.
      </p>
    </section>
    <div v-else class="empty-state">
      <span class="round-icon"><Icon name="check" :size="35" /></span>
      <h2>
        {{
          missingSelection
            ? "Your saved selection is waiting for card history."
            : completed
            ? "That’s enough for this moment."
            : "Nothing due in this practice type."
        }}
      </h2>
      <p v-if="missingSelection" role="status">This task has not been marked complete. Keep this saved selection while the matching cards and review history become available.</p>
      <p v-else>
        Let spacing do its work. New expressions and listening gaps will return
        when they need you.
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button
        v-if="blockDone && app.due.length" class="button secondary"
        @click="router.push({ path: '/review', query: { extra: String(Math.min(999999, Number(extra || 0) + 1)) } })">Choose another optional selection</button>
      <RouterLink to="/listen" class="button primary"
        >Explore your next listening <Icon name="arrow" :size="16"
      /></RouterLink>
    </div>
    <p v-if="card && missingSelection" class="help-text" role="status">Part of your saved selection is waiting for matching card history. This task has not been marked complete.</p>
    <p class="center help-text mt">
      Review timing uses FSRS. Listening, recognition and production have
      separate schedules.
      <span v-if="extra">This optional practice does not add tasks or minutes to today's plan.</span>
    </p>
  </div>
</template>
