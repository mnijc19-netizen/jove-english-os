<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useApp } from "../stores/app";
import { addChunk } from "../db/repository";
import { db } from "../db/db";
import AudioPlayer from "../components/AudioPlayer.vue";
import { useRequest } from "../composables/useRequest";
import Icon from "../components/Icon.vue";
import ReadingPractice from "../components/ReadingPractice.vue";
import { planLongitudinal, type ReadingSavedEvidence } from "../domain/longitudinal";
import { taskActivity } from "../domain/engine";
const app = useApp(),
  route = useRoute(),
  router = useRouter(),
  chinese = ref<string[]>([]),
  recalled = ref<Record<string, string>>({}),
  revealed = ref<string[]>([]);
const loaded = ref(false),
  saveError = ref("");
const rephrase = ref(""),
  writingFeedback = ref("");
const ai = useRequest();
const writingSaving = ref(false), recallSaving = ref(false), completing = ref(false);
const material = computed(
  () =>
    typeof route.query.material === 'string'
      ? app.materials.find((m) => m.id === route.query.material && m.approved)
      : app.materials.find(m => m.approved),
);
const taskId = computed(() => typeof route.query.task === "string" ? route.query.task : undefined);
const draftId = computed(() => "learn-draft-" + (taskId.value?.endsWith(':chunks') ? taskId.value : material.value?.id));
const assignment = computed(() => app.plan.tasks.find(task => task.id === taskId.value));
const readingPlan = computed(() => planLongitudinal({ profile: app.profile, skills: app.skills, events: app.events,
  cards: app.cards, materials: app.materials, now: app.clock }));
const readingMode = computed(() => taskId.value
  ? taskActivity(assignment.value ?? { kind: 'learn', id: taskId.value }) === 'reading'
  : route.query.mode === 'reading');
const deliberateTask = computed(() => taskId.value?.endsWith(':chunks'));
const hasSavedResponse = computed(() => {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const proof = app.events.filter(event => ["CHUNK_RECALL", "WRITTEN_RESPONSE"].includes(event.type)
    && event.sessionId === draftId.value && event.data?.materialId === material.value?.id
    && typeof event.data?.response === "string" && !!event.data.response.trim()
    && (taskId.value ? event.data.taskId === taskId.value : event.timestamp >= dayStart.getTime()));
  return deliberateTask.value
    ? proof.some(event => event.type === 'WRITTEN_RESPONSE') && (!material.value?.chunks.length || proof.some(event => event.type === 'CHUNK_RECALL'))
    : proof.length > 0;
});
const savedReading = ref('');
watch([taskId, () => material.value?.id, readingMode], () => { savedReading.value = ''; }, { flush: 'sync' });
function readingSaved(evidence: ReadingSavedEvidence) {
  if (readingMode.value && taskId.value && evidence.sessionId === `reading:${taskId.value}`
    && evidence.materialId === material.value?.id) savedReading.value = evidence.sessionId;
}
// Plan completion can precede the final session write. The child emits only
// after that write (including on reload); never navigate away from a partial save.
const readingComplete = computed(() => readingMode.value && savedReading.value === `reading:${taskId.value}` && assignment.value?.done
  && assignment.value.materialId === material.value?.id);
let startedAt = Date.now();
let loadVersion = 0;
async function persist() {
  if (!loaded.value || !material.value) return false;
  const id = draftId.value;
  try {
    await db.sessions.put({
      id,
      kind: "learn",
      materialId: material.value.id,
      startedAt,
      stage: "practice",
      draft: JSON.parse(
        JSON.stringify({
          recalled: recalled.value,
          revealed: revealed.value,
          chinese: chinese.value,
          rephrase: rephrase.value,
          writingFeedback: writingFeedback.value,
        }),
      ),
    });
    if (id === draftId.value) saveError.value = "";
    return true;
  } catch {
    if (id === draftId.value) saveError.value =
      "Could not save your writing. Keep this page open and retry saving.";
    return false;
  }
}
watch(
  draftId,
  async (id) => {
    const version = ++loadVersion;
    loaded.value = false;
    const saved = await db.sessions.get(id);
    if (version !== loadVersion || id !== draftId.value) return;
    startedAt = saved?.startedAt ?? Date.now();
    recalled.value = Object.fromEntries(
      Object.entries(saved?.draft.recalled ?? {}).filter(
        ([, v]) => typeof v === "string",
      ),
    ) as Record<string, string>;
    revealed.value = Array.isArray(saved?.draft.revealed)
      ? saved.draft.revealed.filter((v) => typeof v === "string")
      : [];
    chinese.value = [];
    rephrase.value =
      typeof saved?.draft.rephrase === "string" ? saved.draft.rephrase : "";
    writingFeedback.value =
      typeof saved?.draft.writingFeedback === "string"
        ? saved.draft.writingFeedback
        : "";
    loaded.value = true;
  },
  { immediate: true },
);
watch(rephrase, () => { if (loaded.value) writingFeedback.value = ""; }, { flush: "sync" });
watch([recalled, revealed, chinese, rephrase, writingFeedback], persist, {
  deep: true,
  flush: "sync",
});
async function recordReadingDisclosure(event: Event) {
  const details = event.target as HTMLDetailsElement;
  if (!details.open || !details.dataset.materialId) return;
  // Capture the displayed element's identity: toggle can run after a route change.
  const materialId = details.dataset.materialId;
  const disclosedTask = details.dataset.taskId;
  const sessionId = "learn-draft-" + (disclosedTask?.endsWith(':chunks') ? disclosedTask : materialId);
  const timestamp = Date.now();
  try {
    // Disclosure is exposure even without editing. Preserve an existing writing draft,
    // and allow an early disclosure while that draft is still being hydrated.
    await db.transaction("rw", db.sessions, async () => {
      if (!await db.sessions.get(sessionId)) await db.sessions.add({
        id: sessionId, kind: "learn", materialId, startedAt: timestamp,
        stage: "reading", draft: {},
      });
    });
    await app.evidence({
      type: "TRANSCRIPT_REVEALED", source: "objective", sessionId, timestamp,
      data: { materialId, ...(disclosedTask ? { taskId: disclosedTask } : {}) },
    });
  } catch {
    if (sessionId === draftId.value) saveError.value =
      "Could not record transcript exposure. Keep this page open; close and reopen the reading section to retry.";
  }
}
async function checkWriting() {
  if (!loaded.value || writingSaving.value || !material.value || !rephrase.value.trim()) return;
  const submission = {
    id: crypto.randomUUID(), response: rephrase.value, materialId: material.value.id,
    reference: material.value.transcript, sessionId: draftId.value, taskId: taskId.value, version: loadVersion,
  };
  const data = { response: submission.response, materialId: submission.materialId, submissionId: submission.id,
    ...(submission.taskId ? { taskId: submission.taskId } : {}) };
  const stillCurrent = () => submission.version === loadVersion && submission.sessionId === draftId.value
    && submission.taskId === taskId.value && submission.response === rephrase.value;
  writingSaving.value = true;
  try {
    if (!await persist()) return;
    await app.evidence({ id: submission.id, type: "WRITTEN_RESPONSE", source: "text", sessionId: submission.sessionId, data });
    let feedback = "Your rephrasing is saved. Compare whether your version preserves the main idea and key details. No automatic correctness score was assigned.";
    if (app.keySet) {
      const result = await ai.run(signal => app.provider.evaluate({
        kind: "reading comprehension and rephrasing", text: submission.response, reference: submission.reference,
      }, signal));
      if (!result) return;
      feedback = result.summary;
      if (result.comprehension !== null) await app.evidence({
        id: `${submission.id}:reading`, type: "READING_EVALUATED", source: "ai", skill: "reading",
        score: result.comprehension, sessionId: submission.sessionId, data: { ...data, summary: feedback },
      });
      if (result.accuracy !== null) await app.evidence({
        id: `${submission.id}:writing`, type: "WRITING_EVALUATED", source: "ai", skill: "writing",
        score: result.accuracy, sessionId: submission.sessionId, prompted: true, data: { ...data, summary: feedback },
      });
    }
    if (stillCurrent()) { writingFeedback.value = feedback; await persist(); }
  } catch {
    if (stillCurrent()) saveError.value = "Could not save this submission. Your answer is still here; retry saving.";
  } finally { writingSaving.value = false; }
}
async function recall(text: string) {
  const candidate = material.value?.chunks.find(chunk => chunk.text === text);
  if (!loaded.value || recallSaving.value || !candidate || !recalled.value[text]?.trim() || revealed.value.includes(text)) return;
  const submission = { id: crypto.randomUUID(), response: recalled.value[text], materialId: material.value!.id,
    sessionId: draftId.value, taskId: taskId.value, version: loadVersion, chunk: { ...candidate } };
  recallSaving.value = true;
  try {
    if (!await persist()) return;
    const chunk = await addChunk(submission.chunk, submission.materialId);
    await app.evidence({
    id: submission.id,
    type: "CHUNK_RECALL",
    source: "text",
    skill: "vocabularyRecall",
    chunkId: chunk.id,
    modality: "recall",
    score: submission.response
      ?.trim()
      .toLowerCase()
      .includes(text.toLowerCase())
      ? 1
      : 0,
    prompted: true,
    sessionId: submission.sessionId,
    data: {
      response: submission.response,
      materialId: submission.materialId,
      ...(submission.taskId ? { taskId: submission.taskId } : {}),
      task: "supported written example; lexical presence only, not a correctness score",
    },
  });
    if (submission.version === loadVersion && submission.sessionId === draftId.value && submission.taskId === taskId.value && submission.response === recalled.value[text]) {
      revealed.value.push(text);
      await persist();
    }
  } catch { saveError.value = "Could not save your example. Keep your response and retry."; }
  finally { recallSaving.value = false; }
}
async function completeAndContinue() {
  if (!loaded.value || !hasSavedResponse.value || completing.value || writingSaving.value || recallSaving.value) return;
  const identity = { taskId: taskId.value, materialId: material.value?.id, activity: 'chunks' as const };
  completing.value = true;
  try {
    if (!await persist()) return;
    const completed = await app.completeTask("learn", identity);
    if (identity.taskId && !completed) { saveError.value = "Your writing is saved. This assignment could not be completed; return to Today to check it."; return; }
    if (identity.materialId === material.value?.id && identity.taskId === taskId.value) {
      const next = identity.taskId ? await app.continueAssignment(identity.taskId) : '/speak';
      if (identity.materialId === material.value?.id && identity.taskId === taskId.value) await router.push(next);
    }
  } catch { saveError.value = "Could not finish this task. Your responses are saved; try again."; }
  finally { completing.value = false; }
}
async function continueReading() {
  if (!readingComplete.value || completing.value) return;
  const id = taskId.value;
  completing.value = true;
  try {
    const next = await app.continueAssignment(id);
    if (id === taskId.value) await router.push(next);
  } catch { saveError.value = 'Your reading is saved. Retry continuing to the next task.'; }
  finally { completing.value = false; }
}
</script>
<template>
  <div v-if="readingMode" class="page task-page">
    <ReadingPractice
      v-if="material?.approved" :key="`${taskId ?? 'free'}:${material.id}`" :material="material" :task-id="taskId"
      :segment-words="Math.min(readingPlan.reading.segmentWords, readingPlan.adjustments.segmentSeconds * 2)" @saved="readingSaved" />
    <div v-else class="empty-state"><h1>Reading is waiting for a suitable passage.</h1><p>Choose an approved reader from your library when one is available.</p><RouterLink to="/library">Open library</RouterLink></div>
    <button v-if="readingComplete" class="button primary mt" :disabled="completing" @click="continueReading">Continue to next task <Icon name="arrow" :size="17" /></button>
    <p v-if="saveError" role="alert" class="error">{{ saveError }}</p>
  </div>
  <div v-else class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">LESS MEMORIZING · MORE MEANING</p>
        <h1 tabindex="-1">
          Make the expression <span class="serif">yours.</span>
        </h1>
        <p class="lede">
          Small combinations of words. A surprisingly large part of everyday
          English.
        </p>
      </div>
    </div>
    <div class="section-title">
      <h2>From your listening</h2>
      <span class="muted">{{ material?.title }}</span>
    </div>
    <p v-if="saveError" role="alert" class="error">
      {{ saveError }}
      <button class="text-button" @click="persist">Retry saving</button>
    </p>
    <div class="chunk-grid">
      <article
        v-for="c in material?.chunks"
        :key="c.text"
        class="panel chunk-card"
      >
        <div class="row between">
          <span class="eyebrow">USEFUL IN CONVERSATION</span>
        </div>
        <h2>{{ c.text }}</h2>
        <p>{{ c.meaningEn }}</p>
        <blockquote>{{ c.example }}</blockquote>
        <AudioPlayer
          :text="c.text"
          :label="'Hear ' + c.text"
          compact
          synthetic
        />
        <button
          v-if="app.settings.chineseHelp"
          class="text-button"
          @click="
            chinese.includes(c.text)
              ? chinese.splice(chinese.indexOf(c.text), 1)
              : chinese.push(c.text)
          "
        >
          {{ chinese.includes(c.text) ? "Hide Chinese" : "Reveal Chinese" }}
        </button>
        <p v-if="chinese.includes(c.text)" lang="zh">{{ c.meaningZh }}</p>
        <label :for="c.text">Write a sentence about your own life.</label
        ><textarea
          :id="c.text"
          v-model="recalled[c.text]"
          :disabled="!loaded"
          rows="2"
          placeholder="Use it in a situation that matters to you."
        /><button
          class="button secondary wide"
          :disabled="!loaded || recallSaving || !recalled[c.text]?.trim() || revealed.includes(c.text)"
          @click="recall(c.text)"
        >
          {{
            revealed.includes(c.text)
              ? "Saved for future practice"
              : "Save my example & practice later"
          }}<Icon name="check" :size="16" />
        </button>
        <p v-if="revealed.includes(c.text)" class="help-text">
          This was a supported written attempt. A future spoken recall will test
          independent use.
        </p>
      </article>
    </div>
    <div class="section-title mt">
      <h2>Your expression notebook</h2>
      <span class="muted">{{ app.chunks.length }} expressions</span>
    </div>
    <details
      :key="draftId"
      class="panel section"
      :open="deliberateTask || undefined"
      :data-material-id="material?.id"
      :data-task-id="taskId"
      @toggle="recordReadingDisclosure"
    >
      <summary>Read and rephrase · supporting reading and writing</summary>
      <p>{{ material?.transcript }}</p>
      <label for="rephrase"
        >Explain the main idea and two details in your own English.</label
      >
      <textarea id="rephrase" v-model="rephrase" :disabled="!loaded" rows="4" />
      <button
        class="button secondary"
        :disabled="!loaded || writingSaving || ai.busy.value || !rephrase.trim()"
        @click="checkWriting"
      >
        Save & check my rephrasing
      </button>
      <p v-if="writingFeedback" role="status">{{ writingFeedback }}</p>
      <p v-if="ai.error.value" role="alert" class="error">
        {{ ai.error.value }}
      </p>
    </details>
    <div v-if="app.chunks.length" class="panel">
      <div v-for="c in app.chunks" :key="c.id" class="notebook-row">
        <div>
          <strong>{{ c.text }}</strong
          ><small>{{ c.meaningEn }}</small>
        </div>
        <div class="mini-strengths">
          <span>Read {{ Math.round(c.readingStrength * 100) }}%</span
          ><span>Hear {{ Math.round(c.listeningStrength * 100) }}%</span
          ><span>Say {{ Math.round(c.productionStrength * 100) }}%</span>
        </div>
      </div>
    </div>
    <p v-else class="muted">
      Your saved expressions will appear here as you practice.
    </p>
    <button
      class="button primary mt"
      :disabled="!loaded || !hasSavedResponse || writingSaving || recallSaving || completing"
      @click="completeAndContinue"
      >Use these in conversation <Icon name="arrow" :size="17"
    /></button>
    <p v-if="!hasSavedResponse" class="help-text">{{ deliberateTask ? 'Save a rephrasing and, when an expression is offered, your own example before completing this practice.' : 'Save a written example or a rephrasing before completing this practice.' }}</p>
    <RouterLink :to="taskId ? '/' : '/speak'" class="text-button">Skip practice for now</RouterLink>
  </div>
</template>
