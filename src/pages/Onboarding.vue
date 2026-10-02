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
const topicNames: Record<string, string> = { Technology: "科技", AI: "人工智能", Music: "音乐", Movies: "影视", "Everyday life": "日常生活", "Living abroad": "海外生活", "New Zealand": "新西兰", Work: "工作" };
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
const steps = ["学习方向", "听懂大意", "理解表达", "开口尝试", "阅读理解", "开始练习"];
// Explain the procedure, never the content, correct choice or unseen transcript.
// Procedural Chinese is not a translation hint or a scored language response.
const guidance = [
  "先填写称呼（可以用中文），选择最想使用英语的场景，再选感兴趣的话题。这一步只是偏好设置，不评英语能力。",
  "共三段不同难度的音频。点击 Play audio 播放，听到结尾后才会出现英文选项；选择最符合大意的一项，再点 Continue。可以重听，但重听和第一次作答会分别记录，不必听懂每个词。",
  "逐个看英文表达，选出对应的英文释义，再点 Continue。先按自己的理解作答，不查词典；这里检查的是认得意思，不代表已经能在对话中说出来。",
  "按下方英文问题，用英语说几句。点 Record response 开始，点 Stop & save 停止并保存；等待保存完成后再继续。暂时不能录音可写几句英文，或点 Skip for now 跳过，不会因此得到口语或发音成绩。",
  "先读英文短文，再按短文内容选择答案，最后点 Continue。这一步检查书面理解；中文只解释操作，不翻译短文、问题或答案。",
  "点击 Build my daily practice 完成设置，进入今日安排，从第一项任务开始。系统会按后续真实练习继续调整；没有做过的项目仍是未知，不等于能力差。",
];
const continueLabel = computed(() => step.value === 5 ? "Build my daily practice" : step.value === 3 && !speech.value && !audioId.value ? "Skip for now" : "Continue");
const continueChinese = computed(() => step.value === 5 ? "进入今日安排" : step.value === 3 && !speech.value && !audioId.value ? "暂时跳过" : "保存并继续");
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
  void save().catch(() => { error.value = "诊断草稿暂未保存。请保留此页，检查浏览器存储后重试保存。"; });
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
    error.value = "暂时无法恢复诊断，原记录没有被覆盖。请重试读取。";
  } finally {
    loading.value = false;
  }
  if (loaded.value) {
    try { await save(); } catch { error.value = "诊断暂未保存，请保留此页并重试保存。"; }
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
    error.value = "这一步未能保存，已记录的首答和当前草稿仍保留。请在存储恢复后重试“保存并继续”。";
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
  catch { error.value = "仍无法保存。请保留此页，草稿没有被清除。"; }
  finally { saving.value = false; }
}
onMounted(() => { void load(); });
onBeforeRouteLeave(async () => {
  try { await save(); }
  catch {
    error.value = "离开前未能保存，已暂缓切换页面。诊断草稿仍在，请先重试保存。";
    return false;
  }
});
onBeforeUnmount(() => { disposed = true; });
</script>
<template>
  <div class="page onboarding-page" lang="zh-CN">
    <div class="page-heading">
      <div>
        <p class="eyebrow">英语起点了解 · 第 {{ step + 1 }} 步 / 共 6 步</p>
        <h1 tabindex="-1" lang="en">Let’s start <span class="serif">with you.</span></h1>
        <p class="lede">
          先了解起点，不是考试。操作用中文说明，英语内容用来了解你目前会什么；不需要先读懂英文界面才能开始。
        </p>
      </div>
    </div>
    <div class="onboarding-steps">
      <span
        v-for="(s, i) in steps"
        :key="s"
        :class="{ current: step === i, complete: step > i }"
        :aria-current="step === i ? 'step' : undefined"
        ><i>{{ i + 1 }}</i
        >{{ s }}</span
      >
    </div>
    <p v-if="loading" role="status">正在恢复上次的诊断草稿…</p>
    <p v-if="error" class="error" role="alert">{{ error }}
      <button class="text-button" lang="en" aria-label="Retry saving / loading" :disabled="saving || loading" @click="retrySave"><span lang="zh-CN">重试保存／读取 · </span>Retry saving / loading</button>
    </p>
    <section v-if="loaded && !loading" class="panel onboarding-card" :aria-busy="saving">
      <p id="onboarding-guidance" class="help-text" lang="zh-CN"><strong>这一步怎么做：</strong>{{ guidance[step] }}</p>
      <p v-if="saving" role="status">正在保存，请稍候…</p>
      <template v-if="step === 0"
        ><h2 lang="en">What would English make possible?</h2>
        <label for="name"><span lang="en">What should we call you?</span> · 称呼</label
        ><input
          id="name"
          v-model="name"
          maxlength="50"
          autocomplete="given-name"
          aria-label="What should we call you?"
          aria-describedby="onboarding-guidance"
        /><label for="goal"><span lang="en">Your main direction</span> · 学习方向</label
        ><select id="goal" v-model="goal" aria-label="Your main direction">
          <option value="Real-world conversation">日常交流 · Real-world conversation</option>
          <option value="Living in an English-speaking country">英语环境生活 · Living in an English-speaking country</option>
          <option value="Work & interviews">工作与面试 · Work & interviews</option>
          <option value="Movies & natural listening">影视与自然听力 · Movies & natural listening</option>
          <option value="IELTS foundations">雅思基础 · IELTS foundations</option></select
        ><p>哪些话题让你感兴趣？可多选，也可保留当前选择。</p>
        <div class="topic-chips">
          <button
            v-for="t in topics"
            :key="t"
            :aria-pressed="interests.includes(t)"
            :aria-label="t"
            lang="en"
            :class="{ selected: interests.includes(t) }"
            @click="
              interests.includes(t)
                ? interests.splice(interests.indexOf(t), 1)
                : interests.push(t)
            "
          >
            <span lang="zh-CN">{{ topicNames[t] }}</span> · {{ t }}
          </button>
        </div></template
      ><template v-else-if="step === 1 && material"
        ><p class="eyebrow">
          听力片段 {{ clip + 1 }} / {{ clips.length }}
        </p>
        <h2 lang="en">Listen. Then choose the main idea.</h2>
        <AudioPlayer
          :key="material.id"
          lang="en"
          :src="material.audioPath"
          :synthetic="material.synthetic"
          label="No transcript yet. It is fine to miss some words."
          @played="played"
          @ended="ended"
        />
        <p class="help-text">本站原创示例，使用合成语音。三段分级选择题只提供有限的意思识别线索，不代表真实对话、独立回忆或 CEFR 等级。</p>
        <p v-if="!current?.ended && !listeningLocked" role="status">请先听到结尾再选择；只点暂停不算听完。</p>
        <p v-if="listeningLocked" role="status">第一次提交的答案已保存并锁定；重听或返回不会覆盖它。</p>
        <fieldset v-if="current?.ended || listeningLocked" lang="en" class="answer-options" :disabled="listeningLocked || saving">
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
        ><h2 lang="en">Everyday expressions, in context.</h2>
        <p class="muted">
          选择你理解的意思。认得表达与独立说出来，是两种不同的能力。
        </p>
        <p v-if="vocabLocked" role="status">第一次提交的表达理解答案已保存并锁定。</p>
        <fieldset v-for="v in vocabulary" :key="v.text" lang="en" class="answer-options" :disabled="vocabLocked || saving">
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
        ><h2 lang="en">Tell us a little about yourself.</h2>
        <p lang="en">
          What did you do yesterday? Why would you like to use English in daily
          life?
        </p>
        <Recorder
          lang="en"
          :saved-audio-id="audioId"
          :disabled="saving"
          label="Baseline speaking sample"
          @active="captureActive = $event"
          @recorded="audioId = $event.audioId"
          @transcribed="speech = $event"
        /><label for="baseline-speech"
          ><span lang="en">Optional transcript or written sample</span> · 可选：英文转写或书面回答</label
        ><textarea
          id="baseline-speech"
          v-model="speech"
          lang="en"
          aria-label="Optional transcript or written sample"
          rows="4"
          placeholder="Even a few sentences help."
        />
        <p class="help-text">
          录音用于保留真实尝试，不自动给发音打分。跳过或只写文字，不会产生声学口语成绩；之后仍可继续练习。
        </p></template
      ><template v-else-if="step === 4"
        ><h2 lang="en">One small reading check.</h2>
        <blockquote lang="en">
          Maya was going to walk to work, but it started raining. She took the
          bus instead. She arrived ten minutes early and had time for a coffee.
        </blockquote>
        <p v-if="readingLocked" role="status">第一次提交的阅读答案已保存并锁定。</p>
        <fieldset lang="en" class="answer-options" :disabled="readingLocked || saving">
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
        <h2 lang="en">Your first picture is taking shape.</h2>
        <p>
          回答已保存。今日安排会结合当前听力和主动回忆的需要，并保留开口练习。
        </p>
        <p class="help-text">
          合成语音和选择题只提供有限的识别证据，不能据此确定自然听力、即兴交流、迁移能力或语言等级。跳过或缺少独立证据的能力仍待了解。
        </p>
        <div class="row">
          <span class="pill"
            >{{
              app.events.filter((e) => e.type.startsWith("DIAGNOSTIC")).length
            }}
            条起点观察（不是等级成绩）</span
          ><span class="pill">听懂 → 开口尝试</span>
        </div></template
      >
      <div class="onboard-actions">
        <button
          v-if="step > 0"
          class="text-button"
          lang="en"
          aria-label="Back"
          :disabled="saving || captureActive"
          @click="back"
        >
          <span lang="zh-CN">上一步 · </span>Back</button
        ><button
          class="button primary"
          lang="en"
          :aria-label="continueLabel"
          aria-describedby="onboarding-guidance"
          :disabled="!canContinue || saving || captureActive"
          @click="next"
        >
          <span lang="zh-CN">{{ continueChinese }} · </span>{{ continueLabel }}<Icon name="arrow" :size="16" />
        </button>
      </div>
    </section>
  </div>
</template>
