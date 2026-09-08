<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from "vue-router";
import { useApp } from "../stores/app";
import { db } from "../db/db";
import { saveError } from "../db/repository";
import { missions } from "../content/materials";
import { useRequest } from "../composables/useRequest";
import AudioPlayer from "../components/AudioPlayer.vue";
import SavedRecording from "../components/SavedRecording.vue";
import type { Conversation, Evaluation, StudyEvent } from "../domain/types";
import Recorder from "../components/Recorder.vue";
import PronunciationPractice from "../components/PronunciationPractice.vue";
import { usePronunciationSession } from "../speech/practice";
import { comparableObservation, assessmentEvaluator, planLongitudinal } from "../domain/longitudinal";
import Icon from "../components/Icon.vue";
const app = useApp(),
  route = useRoute(),
  mode = ref(String(route.query.mode || "guided")),
  missionId = ref(missions[0]?.id || ""),
  text = ref(""),
  live = ref(""),
  conversation = ref<Conversation>(),
  audioId = ref(""),
  sttText = ref(""),
  duration = ref(0),
  repairAnswers = ref<Record<string, string>>({}),
  repairResults = ref<Record<string, string>>({});
const repairAudio = ref<Record<string, string>>({}),
  loaded = ref(false),
  pending = ref(false);
const { busy, error, run, cancel } = useRequest();
const selected = computed(
  () => missions.find((m) => m.id === missionId.value) || missions[0],
);
const evaluation = computed(() => conversation.value?.evaluation);
const pronunciationScope = computed(() => conversation.value?.id || 'speak-practice');
const pronunciation = usePronunciationSession(pronunciationScope);
const { reference: pronunciationReference, savedAudioId: pronunciationAudioId, savedReferenceId: pronunciationReferenceId,
  pendingAttempt: pronunciationAttempt, active: pronunciationActive, loading: pronunciationLoading,
  problem: pronunciationProblem, disabled: pronunciationDisabled, recoveredResults: pronunciationResults } = pronunciation;
const recordingStates = ref<Record<string, boolean>>({});
const captureActive = computed(() => pronunciationActive.value || Object.values(recordingStates.value).some(Boolean));
const observation = ref<{ sessionId: string; priorExposure: boolean; difficulty: number; level: string; mode: string } | null>(null);
const evidenceOutbox = ref<StudyEvent[]>([]);
let persistence: Promise<unknown> = Promise.resolve(), evidenceQueue: Promise<void> = Promise.resolve();
const speakingRubric = 'conversation-language-accuracy-v1';
const hasUnsentResponse = computed(() => !!text.value.trim() || !!audioId.value);
const labels = [
  { id: "guided", name: "Guided conversation" },
  { id: "free", name: "Free conversation" },
  { id: "mission", name: "Real-life mission" },
  { id: "retell", name: "Retell & respond" },
];
let lastPromptAt = Date.now();
async function persist() {
  if (!loaded.value) return;
  const savedConversation = conversation.value ? JSON.parse(JSON.stringify(conversation.value)) as Conversation : undefined;
  const row = {
    id: "speak-draft",
    kind: "speak",
    startedAt: conversation.value?.startedAt || Date.now(),
    stage: mode.value,
    draft: {
      text: text.value,
      audioId: audioId.value,
      duration: duration.value,
      conversationId: conversation.value?.id || "",
      missionId: missionId.value,
      sttText: sttText.value,
      repairAnswers: JSON.parse(JSON.stringify(repairAnswers.value)),
      repairResults: JSON.parse(JSON.stringify(repairResults.value)),
      repairAudio: JSON.parse(JSON.stringify(repairAudio.value)),
      lastPromptAt,
      observation: observation.value,
      evidenceOutbox: evidenceOutbox.value,
    },
  };
  const snapshot = JSON.parse(JSON.stringify(row));
  const operation = persistence.catch(() => undefined).then(async () => {
    if (savedConversation) await db.conversations.put(savedConversation);
    await db.sessions.put(snapshot);
  });
  persistence = operation;
  await operation;
}
function flushSpeakEvidence(): Promise<void> {
  const operation = evidenceQueue.catch(() => undefined).then(async () => {
    await persist();
    while (evidenceOutbox.value.length) {
      await app.evidence(evidenceOutbox.value[0]!);
      evidenceOutbox.value.shift(); await persist();
    }
  });
  evidenceQueue = operation; return operation;
}
async function recordEvidence(event: Omit<StudyEvent, 'id' | 'timestamp'> & { id?: string; timestamp?: number }) {
  const row = { ...event, id: event.id ?? crypto.randomUUID(), timestamp: event.timestamp ?? Date.now() };
  if (!evidenceOutbox.value.some(e => e.id === row.id) && !app.events.some(e => e.id === row.id)) evidenceOutbox.value.push(row);
  await flushSpeakEvidence();
}
async function start() {
  if (busy.value || captureActive.value) return;
  live.value = "";
  const opening =
    mode.value === "retell"
      ? "Tell me what you remember from your listening. Then explain how it relates to your own life."
      : selected.value.opening;
  conversation.value = {
    id: crypto.randomUUID(),
    mode: mode.value,
    scenario: selected.value.scene,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: opening,
        timestamp: Date.now(),
      },
    ],
    startedAt: Date.now(),
  };
  const adjustment = planLongitudinal({ profile: app.profile, skills: app.skills, events: app.events, cards: app.cards, materials: app.materials, now: Date.now() }).adjustments;
  // Freeze actual prompt difficulty for this new session; never relabel old work.
  const difficulty = adjustment.targetDifficulty;
  const level = difficulty < 0.5 ? 'Beginner; clear natural short sentences, one follow-up at a time.'
    : 'Natural pace, occasional ambiguity or polite disagreement. Ask why; avoid teaching.';
  const olderConversations = await db.conversations.filter(c => c.scenario === conversation.value!.scenario && c.id !== conversation.value!.id).count();
  observation.value = { sessionId: conversation.value.id, priorExposure: olderConversations > 0 || app.events.some(e => e.data?.missionId === missionId.value), difficulty, level, mode: mode.value };
  lastPromptAt = Date.now();
  pending.value = false;
  await persist();
  await recordEvidence({ id: conversation.value.id + '-prompt', type: 'SPEAK_PROMPT_PRESENTED', source: 'objective', sessionId: conversation.value.id,
    data: { missionId: missionId.value, mode: mode.value, difficulty, priorExposure: observation.value.priorExposure } });
}
async function send() {
  if (!text.value.trim() || busy.value || pending.value || captureActive.value) return;
  if (!conversation.value) await start();
  const value = text.value.trim();
  const msg = {
    id: crypto.randomUUID(),
    role: "user" as const,
    text: value,
    timestamp: Date.now(),
    ...(audioId.value ? { audioId: audioId.value } : {}),
  };
  conversation.value!.messages.push(msg);
  await persist();
  await recordEvidence({
    id: msg.id,
    type: "SPEAK_ATTEMPT",
    source: audioId.value ? "objective" : "text",
    sessionId: conversation.value!.id,
    data: {
      duration: duration.value,
      responseLatency: Math.max(0, (Date.now() - lastPromptAt) / 1000),
      wordCount: value.split(/\s+/).length,
      chineseFallback: /[\u3400-\u9fff]/.test(value),
      audioRecorded: !!audioId.value,
      transcriptVerified: !!audioId.value && sttText.value.trim() === value,
      missionId: missionId.value, mode: mode.value,
      ...(observation.value?.sessionId === conversation.value!.id ? { priorExposure: observation.value.priorExposure } : {}),
    },
  });
  text.value = "";
  audioId.value = "";
  duration.value = 0;
  sttText.value = "";
  await persist();
  pending.value = true;
  await reply();
}
async function reply() {
  const c = conversation.value;
  if (!c || busy.value || c.messages.at(-1)?.role !== "user") return;
  live.value = "";
  let result: string | undefined;
  if (app.keySet) {
    result = await run((signal) =>
      app.provider.chat(
        c.messages.map((m) => ({ role: m.role, content: m.text })),
        {
          scenario: c.scenario,
          mode: c.mode,
          level: observation.value?.sessionId === c.id ? observation.value.level : 'Clear natural short sentences, one follow-up at a time.',
          targets: app.chunks.slice(-4).map((ch) => ch.text),
        },
        (t) => {
          live.value = t;
        },
        signal,
      ),
    );
  } else {
    const turns = c.messages.filter((m) => m.role === "user").length;
    result = [
      "Could you tell me a little more about that?",
      "What would you do if that did not work out?",
      "What would you like to ask me?",
    ][Math.min(turns - 1, 2)];
  }
  if (result !== undefined) {
    c.messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      text: result,
      timestamp: Date.now(),
    });
    live.value = "";
    lastPromptAt = Date.now();
    pending.value = false;
    await persist();
    await app.refresh();
  }
}
async function finish() {
  const c = conversation.value;
  if (!c || busy.value || pending.value || captureActive.value) return;
  if (hasUnsentResponse.value) {
    error.value = "Send your saved response before finishing the conversation.";
    return;
  }
  await persist();
  let result: Evaluation | undefined;
  if (app.keySet) {
    result = await run((signal) =>
      app.provider.evaluate(
        {
          kind: "end-of-conversation language feedback",
          text: c.messages.map((m) => `${m.role}: ${m.text}`).join("\n"),
          targets: app.chunks.slice(-8).map((ch) => ch.text),
          rubric: 'Judge the learner language transcript only: grammar and word-choice accuracy 0..1. Meaning-preserving formulations are acceptable. Do not estimate acoustic pronunciation, rhythm or spontaneous fluency. Rubric conversation-language-accuracy-v1.',
        },
        signal,
      ),
    );
    if (!result) return;
  } else {
    result = {
      summary:
        "Your responses and recordings are saved. Compare what you said with your intention: was the message clear, and where did you hesitate? Connect AI for individual language feedback.",
      strengths: [],
      errors: [],
      comprehension: null,
      accuracy: null,
      fluency: null,
      successfulChunks: [],
      nextPrompt: "Try the same message in a different real-life situation.",
    };
  }
  result.errors = result.errors.slice(
    0,
    Math.max(1, Math.min(3, app.settings.correctionIntensity)),
  );
  c.evaluation = result;
  c.completedAt = Date.now();
  for (const err of result.errors.slice(
    0,
    Math.max(1, Math.min(3, app.settings.correctionIntensity)),
  ))
    await saveError(err);
  const spokenMessages = c.messages.filter(
    (m) =>
      m.role === "user" &&
      m.audioId &&
      app.events.some(
        (e) => e.id === m.id && e.data?.transcriptVerified === true,
      ),
  );
  const allSpoken =
    spokenMessages.length > 0 &&
    spokenMessages.length ===
      c.messages.filter((m) => m.role === "user").length;
  if (result.accuracy !== null)
    await recordEvidence({
      id: c.id + "-accuracy",
      type: "CONVERSATION_EVALUATION",
      source: "ai",
      skill: allSpoken ? "speakingAccuracy" : "grammarProduction",
      score: result.accuracy,
      sessionId: c.id,
      prompted: c.mode === 'guided' || c.mode === 'retell',
      data: { audioObserved: allSpoken, transcriptVerified: allSpoken, textOnlyEvaluation: true, missionId: missionId.value,
        ...(observation.value?.sessionId === c.id ? { priorExposure: observation.value.priorExposure,
          ...(comparableObservation({ rubricVersion: speakingRubric,
            comparisonKey: JSON.stringify(['conversation', c.mode, c.scenario, c.messages.filter(m => m.role === 'assistant').map(m => m.text)]),
            difficulty: observation.value.difficulty, evaluator: assessmentEvaluator(result),
            conditions: allSpoken ? JSON.stringify({ transcriptVerified: true, mode: c.mode,
              chineseFallback: c.messages.some(m => m.role === 'user' && /[\u3400-\u9fff]/.test(m.text)), level: observation.value.level }) : null,
            firstPass: !observation.value.priorExposure, priorExposure: observation.value.priorExposure,
            prompted: c.mode === 'guided' || c.mode === 'retell' }) ?? {}) } : {}) },
    });
  for (const expression of result.successfulChunks) {
    const chunk = app.chunks.find(
      (ch) => ch.text.toLowerCase() === expression.toLowerCase(),
    );
    const message = spokenMessages.find((m) =>
      m.text.toLowerCase().includes(expression.toLowerCase()),
    );
    if (!chunk || !message) continue;
    const contextId = c.scenario;
    const supplied = c.mode === 'guided' || c.mode === 'retell' || c.messages.some(m => m.role === 'assistant' && m.text.toLowerCase().includes(expression.toLowerCase()));
    await recordEvidence({
      id: c.id + "-chunk-" + chunk.id,
      type: "CHUNK_PRODUCTION",
      source: "ai",
      chunkId: chunk.id,
      modality: c.mode === "mission" ? "transfer" : "speaking",
      contextId,
      ...(result.accuracy !== null ? { score: result.accuracy } : {}),
      sessionId: c.id,
      prompted: supplied,
      data: {
        audioObserved: true,
        transcriptVerified: true,
        suppliedLanguage: supplied,
        novelContext: !supplied && !app.events.some(
          (e) => e.chunkId === chunk.id && e.contextId === contextId,
        ),
        audioId: message.audioId!,
      },
    });
  }
  await persist();
  await app.completeTask(mode.value === "retell" ? "retell" : "speak", {
    taskId: typeof route.query.task === "string" ? route.query.task : undefined,
    ...(mode.value === "retell" && typeof route.query.material === "string"
      ? { materialId: route.query.material }
      : {}),
  });
  await app.refresh();
}
async function repair(id: string) {
  if (captureActive.value) return;
  const err = app.errors.find((e) => e.id === id);
  const attempt = repairAnswers.value[id]?.trim();
  if (!err || !attempt) return;
  await persist();
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const correct = normalize(attempt) === normalize(err.corrected);
  repairResults.value[id] = correct
    ? "Full sentence repaired. Next: retrieve it in a new situation."
    : "Try once more. Check the hint, then say the whole sentence.";
  await recordEvidence({
    type: "SPEAK_RETRY",
    source: "text",
    skill: "grammarProduction",
    score: correct ? 1 : 0,
    prompted: true,
    chunkId: err.chunkId,
    modality: "cloze",
    data: {
      errorId: id,
      response: attempt,
      ...(repairAudio.value[id] ? { audioId: repairAudio.value[id] } : {}),
      fullSentence: correct,
    },
  });
  await app.refresh();
  await persist();
}
watch(
  [text, repairAnswers, repairResults, repairAudio],
  () =>
    void persist().catch(() => {
      error.value =
        "Could not save your response. Keep the page open and try again.";
    }),
  { deep: true, flush: "sync" },
);
async function switchMode(next: string) {
  if (busy.value || captureActive.value) return;
  await persist();
  if (hasUnsentResponse.value) {
    app.notice = "Your unsent response is saved. Send it before changing conversation mode.";
    return;
  }
  mode.value = next;
  if (next === "repair") {
    await persist();
    return;
  }
  conversation.value = undefined;
  text.value = "";
  audioId.value = "";
  sttText.value = "";
  pending.value = false;
  await persist();
}
watch(
  () => route.query.mode,
  (value) => {
    if (typeof value === "string" && value !== mode.value)
      void switchMode(value);
  },
);
onMounted(async () => {
  const draft = await db.sessions.get("speak-draft");
  if (draft) {
    observation.value = draft.draft.observation as typeof observation.value ?? null;
    evidenceOutbox.value = Array.isArray(draft.draft.evidenceOutbox) ? draft.draft.evidenceOutbox as StudyEvent[] : [];
    const strings = (value: unknown) =>
      value && typeof value === "object"
        ? (Object.fromEntries(
            Object.entries(value).filter(([, v]) => typeof v === "string"),
          ) as Record<string, string>)
        : {};
    repairAnswers.value = strings(draft.draft.repairAnswers);
    repairResults.value = strings(draft.draft.repairResults);
    repairAudio.value = strings(draft.draft.repairAudio);
  }
  if (
    draft &&
    route.query.mode !== "repair" &&
    (!route.query.mode || route.query.mode === draft.stage)
  ) {
    text.value = String(draft.draft.text || "");
    audioId.value = String(draft.draft.audioId || "");
    duration.value = Number(draft.draft.duration || 0);
    sttText.value = String(draft.draft.sttText || "");
    missionId.value = String(draft.draft.missionId || missionId.value);
    const cid = String(draft.draft.conversationId || "");
    if (cid) {
      conversation.value = await db.conversations.get(cid);
    }
    mode.value = draft.stage;
    lastPromptAt = Number(draft.draft.lastPromptAt || Date.now());
    pending.value = conversation.value?.messages.at(-1)?.role === "user";
  }
  if (typeof route.query.conversation === "string") {
    const archived = await db.conversations.get(route.query.conversation);
    if (archived) {
      conversation.value = archived;
      mode.value = archived.mode;
      text.value = "";
      audioId.value = "";
      sttText.value = "";
      pending.value = archived.messages.at(-1)?.role === "user";
    }
  }
  loaded.value = true;
  try { await flushSpeakEvidence(); } catch { error.value = 'Your saved speaking evidence needs another save attempt. No recordings were removed.'; }
});
async function savedSpokenRecording(value: { audioId: string; duration: number }) {
  audioId.value = value.audioId; duration.value = value.duration;
  try {
    await persist();
    const original = await db.audio.get(value.audioId);
    if (!original || original.kind !== 'recording' || !original.blob.size || !Number.isFinite(original.duration) || original.duration <= 0 || original.duration > 7200) return;
    await recordEvidence({ id: value.audioId + '-output-time', type: 'PRACTICE_LOGGED', source: 'objective', sessionId: conversation.value?.id ?? 'speak-draft',
      data: { strand: 'output', activeSeconds: original.duration, audioId: value.audioId, measured: 'saved-recording-duration', missionId: missionId.value } });
  } catch { error.value = 'Original recording retained. Retry saving its practice evidence.'; }
}
async function beforeNavigation() {
  if (captureActive.value || busy.value) { error.value = 'Finish or cancel recording and analysis before leaving.'; return false; }
  try { await persist(); await flushSpeakEvidence(); }
  catch { error.value = 'Could not save before leaving. Keep this page open and retry.'; return false; }
}
onBeforeRouteLeave(beforeNavigation); onBeforeRouteUpdate(beforeNavigation);
</script>
<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">ENGLISH THAT LEAVES THE PAGE</p>
        <h1 tabindex="-1">Say what you <span class="serif">mean.</span></h1>
        <p class="lede">A real situation. Your own words. Room to try again.</p>
      </div>
      <button
        type="button"
        class="button secondary"
        @click="switchMode('repair')"
        ><Icon name="refresh" :size="16" />Repair
        {{ app.errors.length ? `(${app.errors.length})` : "" }}</button
      >
    </div>
    <div class="tabs" role="group" aria-label="Speaking mode">
      <button
        v-for="item in labels"
        :key="item.id"
        :class="{ active: mode === item.id }"
        :aria-pressed="mode === item.id"
        :disabled="busy || captureActive"
        @click="switchMode(item.id)"
      >
        {{ item.name }}
      </button>
    </div>
    <div v-if="mode !== 'repair'" class="speak-layout">
      <section class="panel conversation-panel">
        <template v-if="!conversation"
          ><div class="empty-conversation">
            <span class="round-icon"><Icon name="speak" :size="30" /></span>
            <p class="eyebrow">
              {{
                mode === "retell"
                  ? "MAKE THE IDEA YOUR OWN"
                  : "YOUR NEXT CONVERSATION"
              }}
            </p>
            <h2>
              {{
                mode === "retell" ? "What stayed with you?" : selected?.title
              }}
            </h2>
            <p>
              {{
                mode === "retell"
                  ? "Retell a passage from your listening, without reading it. Add one thought of your own."
                  : selected?.scene
              }}
            </p>
            <button class="button primary" @click="start">
              Start conversation <Icon name="arrow" :size="17" />
            </button></div></template
        ><template v-else
          ><div class="conversation-top">
            <span class="pill"
              ><i class="tiny-dot"></i
              >{{
                app.keySet ? "AI conversation" : "Offline scenario practice"
              }}</span
            ><span class="muted"
              >{{
                conversation.messages.filter((m) => m.role === "user").length
              }}
              responses</span
            >
          </div>
          <div class="messages" aria-live="polite">
            <article
              v-for="msg in conversation.messages"
              :key="msg.id"
              class="message"
              :class="msg.role"
            >
              <span class="message-author">{{
                msg.role === "user" ? "You" : "Conversation partner"
              }}</span>
              <p>{{ msg.text }}</p>
              <AudioPlayer
                v-if="msg.role === 'assistant'"
                :text="msg.text"
                label="Hear message"
                compact
                synthetic
              />
              <SavedRecording v-else-if="msg.audioId" :audio-id="msg.audioId" />
            </article>
            <article v-if="live" class="message assistant">
              <span class="message-author">Conversation partner</span>
              <p>{{ live }}</p>
            </article>
          </div>
          <div v-if="!evaluation" class="conversation-composer">
            <Recorder
              :saved-audio-id="audioId"
              :disabled="busy || pending || pronunciationActive"
              @active="recordingStates.conversation = $event"
              @recorded="savedSpokenRecording"
              @transcribed="
                text = $event;
                sttText = $event;
                persist();
              "
            /><label for="speak-response"
              >Your response
              <span class="muted">· edit your transcript or type</span></label
            ><textarea
              id="speak-response"
              v-model="text"
              :disabled="busy || pending"
              rows="3"
              placeholder="Take a breath. What would you say?"
              @keydown.ctrl.enter="send"
            />
            <div class="row between">
              <button
                class="text-button"
                :disabled="
                  busy || pending || captureActive || hasUnsentResponse || !conversation.messages.some((m) => m.role === 'user')
                "
                @click="finish"
              >
                Finish & reflect</button
              ><button
                class="button primary"
                :disabled="busy || pending || captureActive || !text.trim()"
                @click="send"
              >
                {{ busy ? "Listening…" : "Send response"
                }}<Icon name="arrow" :size="16" /></button
              ><button v-if="busy" class="text-button" @click="cancel">
                Cancel
              </button>
            </div>
            <p v-if="hasUnsentResponse" class="help-text">
              Your unsent response is saved. Send it before finishing or changing mode.
            </p>
            <p v-if="!app.keySet" class="help-text">
              Offline prompts are scripted. Your words and recordings remain
              local; personal language evaluation requires AI.
            </p>
            <button v-if="pending && !busy" class="text-button" @click="reply">
              Retry saved response
            </button>
          </div>
          <div v-else class="evaluation">
            <p class="eyebrow">YOUR CONVERSATION REFLECTION</p>
            <h3>Keep the message. Refine the expression.</h3>
            <p>{{ evaluation.summary }}</p>
            <p
              v-for="strength in evaluation.strengths"
              :key="strength"
              class="success-note"
            >
              <Icon name="check" :size="16" />{{ strength }}
            </p>
            <div v-if="evaluation.errors.length">
              <h3>
                Focus on {{ Math.min(3, evaluation.errors.length) }} things
              </h3>
              <button class="button secondary" @click="switchMode('repair')">
                Practice the repairs <Icon name="refresh" :size="16" />
              </button>
            </div>
            <p>{{ evaluation.nextPrompt }}</p>
            <button class="button primary" @click="start">
              Try a new conversation
            </button>
          </div></template
        >
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div v-if="error" class="row wrap">
          <button class="text-button" @click="reply">Retry response</button
          ><button class="text-button" @click="finish">Retry feedback</button
          ><RouterLink to="/settings">Change model / connection</RouterLink
          ><button
            class="text-button"
            @click="
              app.notice =
                'Your conversation is saved. You can continue local reviews and come back later.'
            "
          >
            Skip for now
          </button>
        </div>
        <details class="section">
          <summary>Separate sentence pronunciation practice · not conversation fluency</summary>
          <PronunciationPractice
            :reference="pronunciationReference" :saved-audio-id="pronunciationAudioId"
            :saved-reference-id="pronunciationReferenceId" :pending-attempt="pronunciationAttempt"
            :recovered-results="pronunciationResults"
            :persist-attempt="pronunciation.persistAttempt" :disabled="pronunciationDisabled || busy || pending || Object.values(recordingStates).some(Boolean)"
            @recorded="pronunciation.recorded" @evaluated="pronunciation.evaluated" @active="pronunciationActive = $event" />
          <p v-if="pronunciationProblem" class="error" role="alert">{{ pronunciationProblem }}</p>
          <button class="text-button" :disabled="pronunciationLoading || captureActive" @click="pronunciation.retry">Reload reviewed pronunciation reference / recover saved evidence</button>
        </details>
      </section>
      <aside class="panel mission-selector">
        <p class="eyebrow">PRACTICE FOR REAL LIFE</p>
        <h3>Where are we today?</h3>
        <label for="mission">Choose a situation</label
        ><select
          id="mission"
          v-model="missionId"
          :disabled="!!conversation && !evaluation"
        >
          <option v-for="m in missions" :key="m.id" :value="m.id">
            {{ m.title }}
          </option>
        </select>
        <p>{{ selected?.scene }}</p>
        <div v-if="mode === 'mission'">
          <span class="eyebrow">YOUR MISSION</span>
          <ul>
            <li v-for="goal in selected?.goals" :key="goal">{{ goal }}</li>
          </ul>
        </div>
        <hr />
        <Icon name="sparkle" :size="22" />
        <h3>Meaning comes first.</h3>
        <p>
          Keep the conversation going. We’ll look at the most useful corrections
          afterwards.
        </p>
        <p class="help-text">
          Recordings support replay and timing. Text alone cannot measure
          pronunciation.
        </p>
      </aside>
    </div>
    <section v-else>
      <div v-if="!app.errors.length" class="empty-state">
        <Icon name="refresh" :size="40" />
        <h2>A fresh start.</h2>
        <p>Useful repairs appear here after your evaluated conversations.</p>
        <button class="button primary" @click="mode = 'guided'">
          Start speaking
        </button>
      </div>
      <div v-for="err in app.errors" :key="err.id" class="panel repair-card">
        <span class="eyebrow">{{ err.category }} · {{ err.pattern }}</span>
        <h2>Try the whole sentence again.</h2>
        <blockquote>{{ err.original }}</blockquote>
        <p class="hint">{{ err.hint }}</p>
        <Recorder
          :label="'Repair: ' + err.pattern"
          :saved-audio-id="repairAudio[err.id]"
          :disabled="busy"
          @active="recordingStates[err.id] = $event"
          @recorded="
            repairAudio[err.id] = $event.audioId;
            persist();
          "
          @transcribed="repairAnswers[err.id] = $event"
        /><label :for="err.id">Your repaired sentence</label
        ><input
          :id="err.id"
          v-model="repairAnswers[err.id]"
          placeholder="Regenerate the complete sentence."
        /><button
          class="button primary"
          :disabled="captureActive || !repairAnswers[err.id]?.trim()"
          @click="repair(err.id)"
        >
          Check the full sentence
        </button>
        <p v-if="repairResults[err.id]" role="status">
          {{ repairResults[err.id] }}
        </p>
        <details>
          <summary>Reveal a model answer</summary>
          <p>{{ err.corrected }}</p>
          <p>{{ err.explanation }}</p>
        </details>
        <p class="help-text">
          A prompted retry is practice, not spontaneous mastery. Future review
          will use a new situation.
        </p>
      </div>
      <RouterLink
        to="/review"
        class="button secondary mt"
        @click="
          Object.values(repairResults).some((s) =>
            s.startsWith('Full sentence repaired'),
          ) &&
          app.completeTask('repair', {
            taskId:
              typeof route.query.task === 'string'
                ? route.query.task
                : undefined,
          })
        "
        >Continue with due reviews <Icon name="arrow" :size="16"
      /></RouterLink>
    </section>
  </div>
</template>
