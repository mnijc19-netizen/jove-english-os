<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useApp } from "../stores/app";
import { db } from "../db/db";
import { skillLabel } from "../domain/engine";
import {
  assessmentPrompts,
  assessmentRubric,
  missions,
} from "../content/materials";
import { useRequest } from "../composables/useRequest";
import type { Assessment, Message } from "../domain/types";
import Recorder from "../components/Recorder.vue";
import AudioPlayer from "../components/AudioPlayer.vue";
import Icon from "../components/Icon.vue";
import SavedRecording from "../components/SavedRecording.vue";
const app = useApp(),
  route = useRoute(),
  assessment = ref<Assessment>(),
  answer = ref(""),
  played = ref(false),
  audioId = ref(""),
  self = ref<string>(""),
  show = ref(false);
const dialogue = ref<Message[]>([]),
  sttText = ref(""),
  live = ref(""),
  pendingReply = ref(false);
const starting = ref(false);
const captureActive = ref(false);
const dialogueTurns = computed(
  () => dialogue.value.filter((m) => m.role === "user").length,
);
const { busy, error, run, cancel } = useRequest();
const completeAssessments = computed(() =>
  app.assessments
    .filter((a) => a.completedAt)
    .sort((a, b) => b.timestamp - a.timestamp),
);
const last = computed(() => completeAssessments.value[0]?.completedAt);
const dueDate = computed(() =>
  last.value ? last.value + 14 * 86400000 : app.clock,
);
const stages = ["Listening", "Retell", "Conversation", "Real-life task"];
const stage = computed(() => Number(assessment.value?.stage || 0));
const form = computed(
  () =>
    assessmentPrompts[
      (assessment.value?.variant || 0) % assessmentPrompts.length
    ],
);
const material = computed(() =>
  app.materials.find((m) => m.id === form.value.listeningMaterialId),
);
const prompt = computed(
  () =>
    [
      form.value.listening,
      form.value.retell,
      form.value.conversation,
      missions.find((m) => m.id === form.value.missionId)?.scene ||
        "Complete a real-life conversation.",
    ][stage.value],
);
const recent = computed(() =>
  app.events.filter((e) => e.timestamp >= app.clock - 7 * 86400000),
);
const listening = computed(() =>
  app.events.filter(
    (e) =>
      [
        "LISTEN_ATTEMPT",
        "COMPREHENSION_RESPONSE",
        "DIAGNOSTIC_LISTEN",
      ].includes(e.type) && e.score !== undefined,
  ),
);
const speechEvents = computed(() =>
  app.events.filter((e) => e.type === "SPEAK_ATTEMPT" && e.data?.audioRecorded),
);
const speechSeconds = computed(() =>
  speechEvents.value.reduce((n, e) => n + Number(e.data?.duration || 0), 0),
);
const chineseCount = computed(
  () =>
    app.events.filter(
      (e) => e.type === "SPEAK_ATTEMPT" && e.data?.chineseFallback,
    ).length,
);
const avgLatency = computed(() =>
  speechEvents.value.length
    ? speechEvents.value.reduce(
        (n, e) => n + Number(e.data?.responseLatency || 0),
        0,
      ) / speechEvents.value.length
    : null,
);
const days = computed(() =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date(app.clock);
    d.setDate(d.getDate() - 6 + i);
    const date = d.toDateString();
    return {
      label: d.toLocaleDateString("en", { weekday: "short" }),
      count: app.events.filter(
        (e) => new Date(e.timestamp).toDateString() === date,
      ).length,
    };
  }),
);
const maxDay = computed(() => Math.max(1, ...days.value.map((d) => d.count)));
const weeklyReport = computed(() => {
  const window = (offset: number) =>
    app.events.filter(
      (e) =>
        e.timestamp > app.clock - (offset + 7) * 86400000 &&
        e.timestamp <= app.clock - offset * 86400000,
    );
  const average = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const metrics = (offset: number) => {
    const list = window(offset),
      measured = list.filter(
        (e) =>
          ["COMPREHENSION_RESPONSE", "DIAGNOSTIC_LISTEN"].includes(e.type) &&
          e.source !== "self-report" &&
          e.score !== undefined &&
          !e.prompted,
      );
    const speech = list.filter(
      (e) => e.type === "SPEAK_ATTEMPT" && e.data?.audioRecorded,
    );
    const turns = list.filter((e) => e.type === "SPEAK_ATTEMPT");
    return [
      {
        label: "First-attempt meaning check",
        value: average(measured.map((e) => e.score!)),
        n: measured.length,
        unit: "%",
      },
      {
        label: "Prompt-to-send time (includes editing)",
        value: average(speech.map((e) => Number(e.data?.responseLatency || 0))),
        n: speech.length,
        unit: "s",
      },
      {
        label: "Recording length per response",
        value: average(speech.map((e) => Number(e.data?.duration || 0))),
        n: speech.length,
        unit: "s",
      },
      {
        label: "Responses containing Chinese",
        value: turns.length
          ? turns.filter((e) => e.data?.chineseFallback).length / turns.length
          : null,
        n: turns.length,
        unit: "%",
      },
      {
        label: "Repeated error observations",
        value: list.filter(
          (e) =>
            e.type === "error-detected" || (e.data?.errorId && e.score === 0),
        ).length,
        n: list.length,
        unit: "",
      },
    ];
  };
  const current = metrics(0),
    previous = metrics(7);
  const display = (item: (typeof current)[number]) =>
    item.value === null
      ? "Not observed"
      : Math.round(item.value * (item.unit === "%" ? 100 : 1)) + item.unit;
  return current.map((m, i) => ({
    label: m.label,
    current: display(m),
    previous: display(previous[i]),
    n: m.n,
  }));
});
const chunkStates = computed(() => [
  {
    label: "Reading only",
    n: app.chunks.filter(
      (c) => c.readingStrength > 0.5 && c.listeningStrength <= 0.5,
    ).length,
  },
  {
    label: "Listening-recognized",
    n: app.chunks.filter((c) => c.listeningStrength > 0.5).length,
  },
  {
    label: "Active in production",
    n: app.chunks.filter((c) => c.productionStrength > 0.5).length,
  },
  {
    label: "Spontaneously used",
    n: app.chunks.filter((c) => c.spontaneousUses > 0).length,
  },
]);
async function start() {
  if (starting.value || busy.value || captureActive.value) return;
  starting.value = true;
  try {
    assessment.value = await db.transaction("rw", db.assessments, async () => {
      const saved = await db.assessments.toArray();
      const existing = saved.find((a) => !a.completedAt);
      if (existing) return existing;
      const created: Assessment = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        variant: saved.filter((a) => a.completedAt).length,
        stage: "0",
        responses: { rubric: assessmentRubric.version },
        scores: {},
      };
      await db.assessments.put(created);
      return created;
    });
    show.value = true;
    answer.value = assessment.value.responses["draft"] || "";
    audioId.value = assessment.value.responses["audio-" + stage.value] || "";
    sttText.value = assessment.value.responses["stt-draft"] || "";
    played.value = assessment.value.responses["played"] === "true";
    restoreDialogue();
    await app.refresh();
  } catch {
    error.value = "Could not open your saved check-in. Your existing answers have not been replaced; try again.";
  } finally {
    starting.value = false;
  }
}
function restoreDialogue() {
  const raw = assessment.value?.responses["dialogue-" + stage.value];
  try {
    const value = JSON.parse(raw || "[]");
    dialogue.value = Array.isArray(value)
      ? value.filter(
          (m) =>
            m &&
            ["user", "assistant"].includes(m.role) &&
            typeof m.text === "string",
        )
      : [];
  } catch {
    dialogue.value = [];
  }
  if (stage.value >= 2 && !dialogue.value.length)
    dialogue.value = [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text:
          stage.value === 2
            ? form.value.conversation
            : missions.find((m) => m.id === form.value.missionId)!.opening,
        timestamp: Date.now(),
      },
    ];
  pendingReply.value = dialogue.value.at(-1)?.role === "user";
}
async function draft() {
  if (!assessment.value) return;
  assessment.value.responses.draft = answer.value;
  assessment.value.responses["audio-" + stage.value] = audioId.value;
  assessment.value.responses["stt-draft"] = sttText.value;
  assessment.value.responses.played = String(played.value);
  if (stage.value >= 2)
    assessment.value.responses["dialogue-" + stage.value] = JSON.stringify(
      dialogue.value,
    );
  await db.assessments.put(JSON.parse(JSON.stringify(assessment.value)));
}
async function reply() {
  if (busy.value || !assessment.value) return;
  let result: string | undefined;
  const mission = missions.find((m) => m.id === form.value.missionId)!;
  if (app.keySet)
    result = await run((signal) =>
      app.provider.chat(
        dialogue.value.map((m) => ({ role: m.role, content: m.text })),
        {
          scenario: prompt.value.slice(0, 500),
          mode:
            stage.value === 2
              ? "assessment free conversation"
              : "assessment real-life mission",
          level:
            "Natural short prompts. No hints or corrections. Ask for reasons or clarification.",
          targets: [],
        },
        (t) => (live.value = t),
        signal,
      ),
    );
  else
    result =
      stage.value === 2
        ? [
            "What led you to that choice?",
            "What was difficult about it, and how did you handle that?",
            "I see it differently. How would you explain your point to me?",
            "What would you like to ask me before we finish?",
          ][Math.min(dialogueTurns.value - 1, 3)]
        : [
            `Before we continue, could you explain what you need? ${mission.goals[0]}`,
            "That option may not be available today. What alternative would work for you?",
            "Let me check I understood. What exactly are we agreeing to do next?",
            "Is there anything else you need to clarify before we finish?",
          ][Math.min(dialogueTurns.value - 1, 3)];
  if (result !== undefined) {
    dialogue.value.push({
      id: crypto.randomUUID(),
      role: "assistant",
      text: result,
      timestamp: Date.now(),
    });
    live.value = "";
    pendingReply.value = false;
    await draft();
  }
}
async function sendTurn() {
  if (
    !assessment.value ||
    !answer.value.trim() ||
    busy.value || captureActive.value ||
    pendingReply.value
  )
    return;
  await draft();
  const message: Message = {
    id: crypto.randomUUID(),
    role: "user",
    text: answer.value.trim(),
    timestamp: Date.now(),
    ...(audioId.value ? { audioId: audioId.value } : {}),
  };
  dialogue.value.push(message);
  assessment.value.responses["verified-" + message.id] = String(
    !!audioId.value &&
      !!sttText.value.trim() &&
      sttText.value.trim() === message.text,
  );
  await draft();
  answer.value = "";
  audioId.value = "";
  sttText.value = "";
  pendingReply.value = true;
  await draft();
  await reply();
}
async function submit() {
  const a = assessment.value;
  if (
    !a ||
    busy.value || captureActive.value ||
    (stage.value < 2
      ? !answer.value.trim()
      : dialogueTurns.value < 3 || pendingReply.value || !!answer.value.trim() || !!audioId.value)
  )
    return;
  await draft();
  const submitted =
    stage.value < 2
      ? answer.value
      : dialogue.value.map((m) => `${m.role}: ${m.text}`).join("\n");
  const verified =
    stage.value < 2
      ? !!audioId.value &&
        !!sttText.value.trim() &&
        sttText.value.trim() === answer.value.trim()
      : dialogue.value
          .filter((m) => m.role === "user")
          .every(
            (m) => !!m.audioId && a.responses["verified-" + m.id] === "true",
          );
  a.responses[stages[stage.value]] = submitted;
  a.responses["mode-" + stage.value] = verified
    ? "STT-verified recordings"
    : "text or unverified transcript";
  a.responses["duration-" + stage.value] =
    stage.value >= 2
      ? String(
          (Date.now() - (dialogue.value[0]?.timestamp ?? Date.now())) / 1000,
        )
      : "";
  a.responses["priorExposure-" + stage.value] = String(
    app.events.some(
      (e) =>
        e.data?.materialId === material.value?.id && e.timestamp < a.timestamp,
    ),
  );
  let source: "ai" | "self-report" = "self-report";
  if (app.keySet) {
    const result = await run((signal) =>
      app.provider.evaluate(
        {
          kind: `periodic ${stages[stage.value]}`,
          text: submitted,
          rubric: JSON.stringify(assessmentRubric),
          reference:
            stage.value < 2
              ? material.value?.transcript
              : prompt.value +
                " Goals: " +
                (stage.value === 3
                  ? missions
                      .find((m) => m.id === form.value.missionId)
                      ?.goals.join("; ")
                  : "Sustain interaction, answer follow-ups and ask a relevant question."),
        },
        signal,
      ),
    );
    if (!result) return;
    source = "ai";
    a.scores[stages[stage.value]] =
      stage.value === 0
        ? result.comprehension
        : stage.value === 3
          ? (result.rubricScores?.taskCompletion ?? null)
          : stage.value === 2
            ? (result.rubricScores?.interaction ?? null)
            : result.accuracy;
    a.responses["dimensions-" + stage.value] = JSON.stringify({
      comprehension: result.comprehension,
      accuracy: result.accuracy,
      vocabulary: result.rubricScores?.vocabulary ?? null,
      interaction: result.rubricScores?.interaction ?? null,
      taskCompletion: result.rubricScores?.taskCompletion ?? null,
      fluency: null,
      pronunciation: null,
    });
    a.responses["feedback-" + stage.value] = result.summary;
    a.responses["scorer-" + stage.value] = "AI estimate";
  } else {
    a.scores[stages[stage.value]] =
      self.value === "" ? null : Number(self.value) / 2;
    a.responses["scorer-" + stage.value] =
      "Self reflection, not an objective score";
  }
  await app.evidence({
    id: a.id + "-" + stage.value,
    type: "ASSESSMENT_RESPONSE",
    source,
    skill:
      stage.value === 0
        ? "listeningSentences"
        : stage.value === 3
          ? "realWorld"
          : stage.value === 2
            ? "interaction"
            : verified
              ? "speakingAccuracy"
              : "grammarProduction",
    score: a.scores[stages[stage.value]] ?? undefined,
    sessionId: a.id,
    prompted: false,
    contextId: `assessment:${form.value.id}:${stage.value}`,
    data: {
      audioObserved: verified,
      transcriptVerified: verified,
      variant: a.variant,
      novelContext: !app.events.some(
        (e) => e.contextId === `assessment:${form.value.id}:${stage.value}`,
      ),
      materialId: material.value?.id ?? "",
      response: submitted,
    },
  });
  if (stage.value === 3) {
    a.completedAt = Date.now();
    a.stage = "complete";
    await app.evidence({
      id: a.id + "-complete",
      type: "ASSESSMENT_COMPLETED",
      source: "objective",
      sessionId: a.id,
      data: { variant: a.variant },
    });
    show.value = false;
    await app.completeTask("assessment", {
      taskId:
        typeof route.query.task === "string" ? route.query.task : undefined,
    });
  } else {
    a.stage = String(stage.value + 1);
  }
  a.responses.draft = "";
  answer.value = "";
  audioId.value = "";
  self.value = "";
  played.value = false;
  sttText.value = "";
  a.responses["stt-draft"] = "";
  a.responses.played = "false";
  dialogue.value = [];
  if (!a.completedAt) restoreDialogue();
  await db.assessments.put(JSON.parse(JSON.stringify(a)));
  await app.refresh();
}
onMounted(() => {
  if (route.query.assess) void start();
});
</script>
<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">NOTICE WHAT’S BECOMING NATURAL</p>
        <h1 tabindex="-1">
          Progress with <span class="serif">evidence.</span>
        </h1>
        <p class="lede">
          What you understand, what you can use, and where practice can help
          next.
        </p>
      </div>
    </div>
    <div class="metric-grid">
      <article class="panel metric">
        <span>Listening observations</span
        ><strong>{{ listening.length }}</strong
        ><small>First passes and meaning checks</small>
      </article>
      <article class="panel metric">
        <span>Recorded speaking</span
        ><strong>{{ Math.round(speechSeconds / 60) }}<em> min</em></strong
        ><small>{{ speechEvents.length }} recorded responses</small>
      </article>
      <article class="panel metric">
        <span>Response latency</span
        ><strong
          >{{ avgLatency === null ? "—" : Math.round(avgLatency)
          }}<em v-if="avgLatency !== null"> sec</em></strong
        ><small>Prompt-to-send time, includes editing</small>
      </article>
      <article class="panel metric">
        <span>Chinese fallback</span><strong>{{ chineseCount }}</strong
        ><small>Responses containing Chinese</small>
      </article>
    </div>
    <div class="progress-layout">
      <section class="panel">
        <div class="section-title">
          <h2>Your learning profile</h2>
          <span class="pill">{{ app.events.length }} observations</span>
        </div>
        <p class="help-text">
          These are learning estimates. Confidence grows with independent
          evidence; unknown dimensions remain unscored.
        </p>
        <div v-for="skill in app.skills" :key="skill.id" class="skill-row">
          <div>
            <span>{{ skillLabel(skill.id) }}</span
            ><small
              >{{ skill.evidenceCount }} observations ·
              {{
                skill.confidence < 0.3
                  ? "early picture"
                  : skill.confidence < 0.7
                    ? "developing evidence"
                    : "more established evidence"
              }}</small
            >
          </div>
          <div class="skill-meter">
            <i
              :style="{
                width: (skill.evidenceCount ? skill.score * 100 : 0) + '%',
              }"
            ></i>
          </div>
          <span>{{
            skill.evidenceCount ? Math.round(skill.score * 100) + "%" : "—"
          }}</span>
        </div>
      </section>
      <div>
        <section class="panel activity-card">
          <h2>A week of showing up</h2>
          <p class="muted">
            {{ recent.length }} learning observations this week
          </p>
          <div
            class="activity-chart"
            role="img"
            :aria-label="
              days
                .map((d) => d.label + ': ' + d.count + ' observations')
                .join(', ')
            "
          >
            <div v-for="d in days" :key="d.label">
              <span>{{ d.count }}</span
              ><i :style="{ height: 8 + (d.count / maxDay) * 100 + 'px' }"></i
              ><small>{{ d.label }}</small>
            </div>
          </div>
          <p class="help-text">
            Activity is a record of practice, not a fluency score.
          </p>
        </section>
        <section class="panel mt">
          <h2>From familiar to usable</h2>
          <div v-for="s in chunkStates" :key="s.label" class="stat-row">
            <span>{{ s.label }}</span
            ><strong>{{ s.n }}</strong>
          </div>
          <p class="help-text">
            These groups can overlap. Recognizing an expression does not
            establish independent speech.
          </p>
        </section>
      </div>
    </div>
    <section class="panel section">
      <h2>Your weekly evidence report</h2>
      <p class="help-text">
        Last seven days compared with the preceding seven. Different materials,
        difficulty, synthetic/real audio and small samples are not equivalent
        tests. These observations show practice conditions, not guaranteed
        improvement.
      </p>
      <div style="overflow-x: auto" tabindex="0" role="region" aria-label="Weekly evidence comparison; scroll horizontally on narrow screens">
        <table class="evidence-table">
          <thead>
            <tr>
              <th scope="col">Observation</th>
              <th scope="col">Previous 7 days</th>
              <th scope="col">Last 7 days</th>
              <th scope="col">Sample</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in weeklyReport" :key="m.label">
              <th scope="row">{{ m.label }}</th>
              <td>{{ m.previous }}</td>
              <td>{{ m.current }}</td>
              <td>{{ m.n }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="help-text">
        Current recommended focus: {{ skillLabel(app.plan.focus) }}.
        {{ app.due.length }} modality-specific cards are due; completing more
        pages does not by itself increase ability.
      </p>
    </section>
    <section class="assessment-banner">
      <div>
        <span class="eyebrow">YOUR 14-DAY CHECK-IN</span>
        <h2>Try something <span class="serif">unrehearsed.</span></h2>
        <p>
          {{
            last
              ? "Next check-in: " + new Date(dueDate).toLocaleDateString()
              : "Your first comparable check-in is ready when you are."
          }}
          Listening, retelling, conversation and a real-life task.
        </p>
      </div>
      <button class="button primary" @click="start">
        {{
          app.assessments.some((a) => !a.completedAt)
            ? "Continue check-in"
            : "Start check-in"
        }}<Icon name="arrow" :size="16" />
      </button>
    </section>
    <section v-if="show && assessment" class="panel assessment-card">
      <p class="eyebrow">
        {{ stages[stage] }} · {{ stage + 1 }} OF 4 · FORM
        {{ (assessment.variant % 3) + 1 }}
      </p>
      <h2>{{ prompt }}</h2>
      <div v-if="stage >= 2" class="messages">
        <p class="help-text">
          Aim for 5–10 minutes of natural conversation. Complete at least three
          responses, follow-ups and a question. Shorter attempts remain labeled
          by their actual duration.
          {{
            app.keySet
              ? ""
              : "No-key partner prompts are scripted practice, not an adaptive AI test."
          }}
        </p>
        <article
          v-for="message in dialogue"
          :key="message.id"
          class="message"
          :class="message.role"
        >
          <span class="message-author">{{
            message.role === "user" ? "You" : "Conversation partner"
          }}</span>
          <p>{{ message.text }}</p>
          <AudioPlayer
            v-if="message.role === 'assistant'"
            :text="message.text"
            label="Hear partner"
            compact
            synthetic
          />
          <SavedRecording
            v-else-if="message.audioId"
            :audio-id="message.audioId"
          />
        </article>
        <p v-if="live" role="status">{{ live }}</p>
      </div>
      <AudioPlayer
        v-if="stage === 0 && material"
        :src="material.audioPath"
        :synthetic="material.synthetic"
        @ended="
          played = true;
          draft();
        "
      /><Recorder
        v-else
        :key="stage"
        :saved-audio-id="audioId"
        :disabled="busy || pendingReply"
        @active="captureActive = $event"
        @recorded="
          audioId = $event.audioId;
          draft();
        "
        @transcribed="
          answer = $event;
          sttText = $event;
          draft();
        "
      /><label for="assessment-answer">Your response</label
      ><textarea
        id="assessment-answer"
        v-model="answer"
        :disabled="busy || pendingReply"
        rows="4"
        placeholder="Try without hints. Record or write what you can express."
        @input="draft"
      />
      <button
        v-if="stage >= 2"
        class="button secondary"
        :disabled="busy || captureActive || !answer.trim() || pendingReply"
        @click="sendTurn"
      >
        Send assessment response
      </button>
      <button v-if="pendingReply && !busy" class="text-button" @click="reply">
        Retry partner response
      </button>
      <div v-if="!app.keySet">
        <label for="self-score">Your reflection against the task</label
        ><select id="self-score" v-model="self">
          <option value="">Not observed / leave unscored</option>
          <option
            v-for="(anchor, i) in assessmentRubric.anchors"
            :key="anchor"
            :value="String(i)"
          >
            {{ anchor }}
          </option>
        </select>
        <p class="help-text">
          AI is not connected; these ratings remain labeled self-reflections.
          Recorded audio can be revisited later.
        </p>
      </div>
      <button
        class="button primary"
        :disabled="
          busy || captureActive ||
          (stage < 2
            ? !answer.trim()
            : dialogueTurns < 3 || pendingReply || !!answer.trim() || !!audioId) ||
          (stage === 0 && !played)
        "
        @click="submit"
      >
        {{
          busy
            ? "Reviewing…"
            : stage === 3
              ? "Finish check-in"
              : "Save & continue"
        }}<Icon name="arrow" :size="16" /></button
      ><button v-if="busy" class="text-button" @click="cancel">Cancel</button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p class="help-text">
        Acoustic fluency and pronunciation are unscored. Language, interaction
        and task judgments are tentative estimates from submitted text, not
        standardized proficiency scores.
      </p>
    </section>
    <section class="section">
      <div class="section-title">
        <h2>Recurring patterns</h2>
        <span class="muted">Practice targets, not a list of failures.</span>
      </div>
      <div v-if="app.errors.length" class="panel">
        <div v-for="e in app.errors" :key="e.id" class="notebook-row">
          <div>
            <strong>{{ e.pattern }}</strong
            ><small
              >{{ e.failures }} failures / {{ e.attempts }} attempts ·
              {{ e.spontaneousSuccesses }} spontaneous successes</small
            >
          </div>
          <RouterLink to="/speak?mode=repair" class="text-button"
            >Revisit <Icon name="arrow" :size="16"
          /></RouterLink>
        </div>
      </div>
      <p v-else class="muted">
        Evaluated conversations will reveal useful recurring patterns here.
      </p>
    </section>
    <section v-if="completeAssessments.length" class="section">
      <h2>Your check-in history</h2>
      <article
        v-for="a in completeAssessments"
        :key="a.id"
        class="panel assessment-history"
      >
        <h3>
          {{ new Date(a.timestamp).toLocaleDateString() }} · Form
          {{ (a.variant % 3) + 1 }}
        </h3>
        <div v-for="(name, i) in stages" :key="name" class="stat-row">
          <span
            >{{ name }}<small>{{ a.responses["scorer-" + i] }}</small></span
          ><strong>{{
            a.scores[name] === null
              ? "Unscored"
              : Math.round(a.scores[name] * 100) + "%"
          }}</strong>
        </div>
        <details v-for="(name, i) in stages" :key="'response-' + name">
          <summary>{{ name }} · response and feedback</summary>
          <p style="white-space: pre-wrap">{{ a.responses[name] }}</p>
          <p>{{ a.responses["feedback-" + i] }}</p>
          <p class="help-text">
            {{ a.responses["mode-" + i]
            }}{{
              a.responses["duration-" + i]
                ? " · " +
                  Math.round(Number(a.responses["duration-" + i])) +
                  " seconds"
                : ""
            }}
          </p>
          <SavedRecording
            v-if="a.responses['audio-' + i]"
            :audio-id="a.responses['audio-' + i]"
          />
        </details>
        <p class="help-text">
          Rotating tasks share a rubric; they are not standardized equivalent
          tests. Compare similar conditions and review recordings.
        </p>
      </article>
    </section>
  </div>
</template>
