<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, toRefs, watch } from "vue";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import { useApp } from "../stores/app";
import { db } from "../db/db";
import { demoMaterials } from "../content/materials";
import type { StudySession } from "../domain/types";
import AudioPlayer from "../components/AudioPlayer.vue";
import Recorder from "../components/Recorder.vue";
const captureActive = ref(false);
import Icon from "../components/Icon.vue";

interface ClipAnswer {
  choice: string; starts: number; ended: boolean; priorExposure: boolean;
  submitted?: { choice: string; starts: number; ended: boolean; priorExposure: boolean };
}
interface BaselineDraft {
  step: number; name: string; goal: string; interests: string[]; clip: number;
  clipIds: string[]; options: Record<string, string[]>; answers: Record<string, ClipAnswer>;
  vocab: Record<string, string>; vocabSubmitted: Record<string, string> | null;
  speech: string; audioId: string; reading: string; readingSubmitted: string | null;
}
const app = useApp(), router = useRouter();
const draft = reactive<BaselineDraft>({
  step: 0, name: app.profile.name, goal: app.profile.goal, interests: [...app.profile.interests],
  clip: 0, clipIds: [], options: {}, answers: {}, vocab: {}, vocabSubmitted: null,
  speech: "", audioId: "", reading: "", readingSubmitted: null,
});
const { step, name, goal, interests, clip, vocab, speech, audioId, reading } = toRefs(draft);
const saving = ref(false), loading = ref(true), loaded = ref(false), error = ref("");
let startedAt = Date.now(), pending: Promise<unknown> = Promise.resolve(), disposed = false;
const topics = ["Technology", "AI", "Music", "Movies", "Everyday life", "Living abroad", "New Zealand", "Work"];
// Comparable, scene-specific alternatives; no unrelated subject gives the answer away.
const distractors: Record<string, [string, string]> = {
  "cafe-delay": [
    "The speaker is waiting at the bakery because the cafe is closed. The friend should take the next bus and meet there before looking for a table.",
    "The speaker is already at the cafe but cannot find a table. The friend should wait for the next bus; they will both go to the bakery later.",
  ],
  "notification-reset": [
    "The speaker turned off team messages but kept shopping alerts on to reduce interruptions and keep track of discounts during work.",
    "The speaker kept every alert on but checks the phone only after work to avoid missing either shopping offers or team messages.",
  ],
  "shared-kitchen": [
    "The speaker wants one person to clean the kitchen and everyone to buy their own milk, keeping separate receipts to avoid sharing costs.",
    "The speaker wants to take turns buying milk but hire someone to clean the kitchen, then split the cleaning cost using a shared list.",
  ],
  "lunch-order": [
    "The speaker wants sauce mixed into the salad and fries instead of vegetables, and asks the server to bring the food before the drink.",
    "The speaker wants extra sauce and fries on the side, and asks the server to check whether the salad can be served without dressing.",
  ],
  "train-change": [
    "The traveller has confirmed a direct train to the airport and needs to buy a new ticket because the existing one is only valid to Central.",
    "The traveller wants to leave the airport and change at Central Station, and needs to confirm whether the next train stops near the hotel.",
  ],
  "team-demo": [
    "The speaker wants to let colleagues change the deadlines without adding updates, then share the finished board with the whole team before checking the settings.",
    "The speaker wants a colleague to set up a new board because the old one cannot accept updates, then move the deadlines before checking who can access it.",
  ],
};
const clips = computed(() => draft.clipIds.map(id => demoMaterials.find(m => m.id === id)!).filter(Boolean));
const material = computed(() => clips.value[clip.value]);
const current = computed(() => material.value ? draft.answers[material.value.id] : undefined);
const choice = computed({ get: () => current.value?.choice || "", set: (value: string) => {
  if (current.value && !listeningLocked.value) current.value.choice = value;
} });
const choices = computed(() => material.value ? draft.options[material.value.id] || [] : []);
const hasEvent = (id: string) => app.events.some(e => e.id === id);
const listeningLocked = computed(() => !!current.value?.submitted || !!material.value && hasEvent("diagnostic-listen-" + material.value.id));
const vocabLocked = computed(() => !!draft.vocabSubmitted || hasEvent("diagnostic-vocab-0"));
const readingLocked = computed(() => draft.readingSubmitted !== null || hasEvent("diagnostic-reading"));
const vocabulary = [
  { text: "figure out", answer: "understand or solve something", other: "leave without saying goodbye" },
  { text: "it depends", answer: "the answer changes with the situation", other: "it always happens the same way" },
  { text: "be supposed to", answer: "be expected to do something", other: "be unable to imagine something" },
];
const steps = ["Your direction", "Listening", "Expressions", "Speaking", "Reading", "Ready to begin"];
function shuffle(values: string[]) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
function snapshot(): StudySession {
  return JSON.parse(JSON.stringify({ id: "onboarding", kind: "diagnostic", startedAt,
    stage: String(step.value), draft }));
}
function save(): Promise<unknown> {
  if (loading.value || !loaded.value) return Promise.resolve();
  const row = snapshot();
  const operation = pending.catch(() => undefined).then(() => db.sessions.put(row));
  pending = operation;
  return operation;
}
watch(draft, () => {
  void save().catch(() => { error.value = "Could not save your baseline draft. Keep this page open and retry saving."; });
}, { deep: true, flush: "sync" });
async function load() {
  if (saving.value) return;
  loading.value = true; error.value = "";
  try {
    const saved = await db.sessions.get("onboarding");
    const listenSessions = await db.sessions.where("kind").equals("listen").toArray();
    if (disposed) return;
    if (saved) {
      startedAt = saved.startedAt;
      Object.assign(draft, saved.draft, { step: Math.max(0, Math.min(5, Number(saved.stage) || 0)) });
    }
    const graded = [...demoMaterials].sort((a, b) => a.difficulty - b.difficulty);
    if (draft.clipIds.length !== 3 || draft.clipIds.some(id => !distractors[id])) {
      draft.clipIds = [graded[0]!.id, graded[Math.floor(graded.length / 2)]!.id, graded[graded.length - 1]!.id];
    }
    draft.clip = Math.max(0, Math.min(draft.clipIds.length - 1, draft.clip));
    const correctPositions = shuffle(["0", "1", "2"]);
    for (const [index, id] of draft.clipIds.entries()) {
      const m = demoMaterials.find(m => m.id === id)!;
      if (!draft.options[id]) {
        const options = shuffle(distractors[id]!);
        options.splice(Number(correctPositions[index]), 0, m.answer);
        draft.options[id] = options;
      }
      draft.answers[id] ??= {
        choice: "", starts: 0, ended: false,
        priorExposure: listenSessions.some(s => s.materialId === id && (!!s.draft.listened || Number(s.stage) > 0)) ||
          app.events.some(e => e.data?.materialId === id && ["AUDIO_PLAYED", "TRANSCRIPT_REVEALED", "DIAGNOSTIC_LISTEN"].includes(e.type)),
      };
      if (!draft.answers[id]!.submitted && listenSessions.some(s =>
        s.materialId === id && (!!s.draft.listened || Number(s.stage) > 0))) draft.answers[id]!.priorExposure = true;
      const event = app.events.find(e => e.id === "diagnostic-listen-" + id);
      if (event && !draft.answers[id]!.submitted) {
        const response = typeof event.data?.response === "string" ? event.data.response : "";
        draft.answers[id]!.choice = response;
        draft.answers[id]!.submitted = { choice: response, starts: 0, ended: false, priorExposure: true };
      }
    }
    loaded.value = true;
  } catch {
    loaded.value = false;
    error.value = "Could not restore your baseline. Nothing was overwritten. Retry loading.";
  } finally {
    loading.value = false;
  }
  if (loaded.value) {
    try { await save(); } catch { error.value = "Could not save your baseline. Keep this page open and retry saving."; }
  }
}
function played() {
  if (current.value && !listeningLocked.value) current.value.starts++;
}
function ended() {
  if (current.value && !listeningLocked.value && current.value.starts > 0) current.value.ended = true;
}
const canContinue = computed(() => loaded.value && !loading.value && (
  step.value === 0 ? !!name.value.trim() :
  step.value === 1 ? !!current.value && (listeningLocked.value || current.value.ended && !!choice.value) :
  step.value === 2 ? vocabLocked.value || vocabulary.every(v => !!vocab.value[v.text]) :
  step.value === 4 ? readingLocked.value || !!reading.value : true
));
async function next() {
  if (saving.value || captureActive.value || !canContinue.value) return;
  saving.value = true; error.value = "";
  try {
    await save();
    if (step.value === 0) await app.saveProfile({ name: name.value.trim() || "Jove", goal: goal.value, interests: [...interests.value] });
    if (step.value === 1 && material.value && current.value) {
      const m = material.value;
      if (!current.value.submitted) current.value.submitted = {
        choice: current.value.choice, starts: current.value.starts, ended: current.value.ended, priorExposure: current.value.priorExposure,
      };
      await save(); // First submitted response is immutable even if evidence persistence fails.
      const response = current.value.submitted;
      await app.evidence({
        id: "diagnostic-listen-" + m.id, type: "DIAGNOSTIC_LISTEN", sessionId: "onboarding",
        source: "objective", skill: "listeningSentences", score: response.choice === m.answer ? 1 : 0, prompted: true,
        data: {
          materialId: m.id, difficulty: m.difficulty, response: response.choice, synthetic: true,
          sourceLabel: m.sourceLabel, multipleChoice: true, transcriptRevealed: false, chineseUsed: false,
          audioEnded: response.ended, playbackStarts: response.starts, replay: response.starts > 1,
          priorExposure: response.priorExposure, firstPass: response.starts === 1 && !response.priorExposure,
        },
      });
      if (disposed) return;
      if (clip.value < clips.value.length - 1) { clip.value++; await save(); return; }
    }
    if (step.value === 2) {
      draft.vocabSubmitted ??= { ...vocab.value };
      await save();
      for (const [i, v] of vocabulary.entries()) await app.evidence({
        id: "diagnostic-vocab-" + i, type: "DIAGNOSTIC_VOCAB", sessionId: "onboarding", source: "objective",
        skill: "vocabularyRecognition", score: draft.vocabSubmitted[v.text] === v.answer ? 1 : 0, prompted: true,
        data: { response: draft.vocabSubmitted[v.text] || "", multipleChoice: true },
      });
    }
    if (step.value === 3 && (speech.value.trim() || audioId.value)) await app.evidence({
      id: "diagnostic-speaking", type: "DIAGNOSTIC_SPEAK", sessionId: "onboarding",
      source: audioId.value ? "acoustic" : "text", prompted: false,
      data: {
        audioRecorded: !!audioId.value, ...(audioId.value ? { audioId: audioId.value } : {}), response: speech.value,
        wordCount: speech.value.trim() ? speech.value.trim().split(/\s+/).length : 0,
        chineseFallback: /[\u3400-\u9fff]/.test(speech.value), scoreNotInferred: true,
      },
    });
    if (step.value === 4) {
      draft.readingSubmitted ??= reading.value;
      await save();
      await app.evidence({ id: "diagnostic-reading", type: "DIAGNOSTIC_READ", sessionId: "onboarding",
        source: "objective", skill: "reading", score: draft.readingSubmitted === "rain" ? 1 : 0, prompted: true,
        data: { response: draft.readingSubmitted, multipleChoice: true } });
    }
    if (disposed) return;
    if (step.value === 5) {
      await app.saveProfile({ onboarded: true });
      await router.push("/today"); return;
    }
    step.value++; await save();
  } catch {
    error.value = "Could not save this step. Your first response and draft are unchanged. Retry Continue when storage is available.";
  } finally { saving.value = false; }
}
function back() {
  if (saving.value || captureActive.value) return;
  if (step.value === 1 && clip.value > 0) clip.value--;
  else step.value = Math.max(0, step.value - 1);
}
async function retrySave() {
  if (!loaded.value) { await load(); return; }
  saving.value = true;
  try { await save(); error.value = ""; }
  catch { error.value = "Still unable to save. Keep this page open; your draft has not been cleared."; }
  finally { saving.value = false; }
}
onMounted(() => { void load(); });
onBeforeRouteLeave(async () => {
  try { await save(); }
  catch {
    error.value = "Could not save before leaving. Retry saving; your baseline draft is still here.";
    return false;
  }
});
onBeforeUnmount(() => { disposed = true; });
</script>
<template>
  <div class="page onboarding-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">YOUR STARTING POINT · {{ step + 1 }} OF 6</p>
        <h1 tabindex="-1">Let’s start <span class="serif">with you.</span></h1>
        <p class="lede">
          A short check-in, not an exam. We’ll refine the picture as you
          practice.
        </p>
      </div>
    </div>
    <div class="onboarding-steps">
      <span
        v-for="(s, i) in steps"
        :key="s"
        :class="{ current: step === i, complete: step > i }"
        ><i>{{ i + 1 }}</i
        >{{ s }}</span
      >
    </div>
    <p v-if="loading" role="status">Restoring your baseline…</p>
    <p v-if="error" class="error" role="alert">{{ error }}
      <button class="text-button" :disabled="saving || loading" @click="retrySave">Retry saving / loading</button>
    </p>
    <section v-if="loaded && !loading" class="panel onboarding-card" :aria-busy="saving">
      <template v-if="step === 0"
        ><h2>What would English make possible?</h2>
        <label for="name">What should we call you?</label
        ><input
          id="name"
          v-model="name"
          maxlength="50"
          autocomplete="given-name"
        /><label for="goal">Your main direction</label
        ><select id="goal" v-model="goal">
          <option>Real-world conversation</option>
          <option>Living in an English-speaking country</option>
          <option>Work & interviews</option>
          <option>Movies & natural listening</option>
          <option>IELTS foundations</option></select
        ><label>What do you naturally get curious about?</label>
        <div class="topic-chips">
          <button
            v-for="t in topics"
            :key="t"
            :aria-pressed="interests.includes(t)"
            :class="{ selected: interests.includes(t) }"
            @click="
              interests.includes(t)
                ? interests.splice(interests.indexOf(t), 1)
                : interests.push(t)
            "
          >
            {{ t }}
          </button>
        </div></template
      ><template v-else-if="step === 1 && material"
        ><p class="eyebrow">
          LISTENING SAMPLE {{ clip + 1 }} OF {{ clips.length }}
        </p>
        <h2>Listen. Then choose the main idea.</h2>
        <AudioPlayer
          :key="material.id"
          :src="material.audioPath"
          :synthetic="material.synthetic"
          label="No transcript yet. It is fine to miss some words."
          @played="played"
          @ended="ended"
        />
        <p class="help-text">Original reviewed demo · synthetic speech. Three graded samples check supported meaning recognition, not natural conversation, CEFR level or independent recall.</p>
        <p v-if="!current?.ended && !listeningLocked" role="status">Listen to the end before choosing. Pausing alone does not finish the sample.</p>
        <p v-if="listeningLocked" role="status">First response saved and locked. Replaying or going back cannot replace it.</p>
        <fieldset v-if="current?.ended || listeningLocked" class="answer-options" :disabled="listeningLocked || saving">
          <legend>What was the speaker talking about?</legend>
          <label
            v-for="option in choices"
            :key="option"
            ><input
              v-model="choice"
              type="radio"
              name="listening-answer"
              :value="option"
            />{{ option }}</label
          >
        </fieldset></template
      ><template v-else-if="step === 2"
        ><h2>Everyday expressions, in context.</h2>
        <p class="muted">
          Choose the meaning. Recognition and spoken recall are different
          skills.
        </p>
        <p v-if="vocabLocked" role="status">First expression responses saved and locked.</p>
        <fieldset v-for="v in vocabulary" :key="v.text" class="answer-options" :disabled="vocabLocked || saving">
          <legend>{{ v.text }}</legend>
          <label v-for="option in [v.other, v.answer]" :key="option"
            ><input
              v-model="vocab[v.text]"
              type="radio"
              :name="v.text"
              :value="option"
            />{{ option }}</label
          >
        </fieldset></template
      ><template v-else-if="step === 3"
        ><h2>Tell us a little about yourself.</h2>
        <p>
          What did you do yesterday? Why would you like to use English in daily
          life?
        </p>
        <Recorder
          :saved-audio-id="audioId"
          :disabled="saving"
          label="Baseline speaking sample"
          @active="captureActive = $event"
          @recorded="audioId = $event.audioId"
          @transcribed="speech = $event"
        /><label for="baseline-speech"
          >Optional transcript or written sample</label
        ><textarea
          id="baseline-speech"
          v-model="speech"
          rows="4"
          placeholder="Even a few sentences help."
        />
        <p class="help-text">
          You can skip this for now. Skipped or text-only samples do not receive
          an acoustic speaking score.
        </p></template
      ><template v-else-if="step === 4"
        ><h2>One small reading check.</h2>
        <blockquote>
          Maya was going to walk to work, but it started raining. She took the
          bus instead. She arrived ten minutes early and had time for a coffee.
        </blockquote>
        <p v-if="readingLocked" role="status">First reading response saved and locked.</p>
        <fieldset class="answer-options" :disabled="readingLocked || saving">
          <legend>Why did Maya take the bus?</legend>
          <label
            ><input
              v-model="reading"
              type="radio"
              name="reading"
              value="rain"
            />Because it started raining.</label
          ><label
            ><input
              v-model="reading"
              type="radio"
              name="reading"
              value="late"
            />Because she was already late.</label
          ><label
            ><input
              v-model="reading"
              type="radio"
              name="reading"
              value="coffee"
            />Because the café was on the bus.</label
          >
        </fieldset></template
      ><template v-else-if="step === 5"
        ><span class="round-icon"><Icon name="check" :size="35" /></span>
        <h2>Your first picture is taking shape.</h2>
        <p>
          Your responses are saved. Today will start with your current listening
          and active-recall needs, while keeping speaking in the plan.
        </p>
        <p class="help-text">
          These synthetic, multiple-choice samples provide limited recognition evidence.
          They do not establish natural listening, spontaneous conversation, transfer or a proficiency level.
          Skipped skills and skills without independent evidence remain uncertain.
        </p>
        <div class="row">
          <span class="pill"
            >{{
              app.events.filter((e) => e.type.startsWith("DIAGNOSTIC")).length
            }}
            baseline observations</span
          ><span class="pill">Listening → speaking</span>
        </div></template
      >
      <div class="onboard-actions">
        <button
          v-if="step > 0"
          class="text-button"
          :disabled="saving || captureActive"
          @click="back"
        >
          Back</button
        ><button
          class="button primary"
          :disabled="!canContinue || saving || captureActive"
          @click="next"
        >
          {{
            step === 5
              ? "Build my daily practice"
              : step === 3 && !speech && !audioId
                ? "Skip for now"
                : "Continue"
          }}<Icon name="arrow" :size="16" />
        </button>
      </div>
    </section>
  </div>
</template>
