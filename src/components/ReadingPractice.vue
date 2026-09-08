<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router';
import { useApp } from '../stores/app';
import { db } from '../db/db';
import { useRequest } from '../composables/useRequest';
import { assessReadingFit, assessmentEvaluator, comparableObservation, readingComparisonKey, readingRubric, type ReadingSavedEvidence } from '../domain/longitudinal';
import type { Material } from '../domain/types';
import Recorder from './Recorder.vue';

const props = defineProps<{ material: Material; taskId?: string; assessmentId?: string; segmentWords?: number }>();
const emit = defineEmits<{ saved: [evidence: ReadingSavedEvidence] }>();
const app = useApp(), router = useRouter(), ai = useRequest(), lookupAI = useRequest();
const source = JSON.parse(JSON.stringify(props.material)) as Material;
const taskId = props.taskId, assessmentId = props.assessmentId;
const sessionId = `reading:${assessmentId ?? taskId ?? `${new Date(app.clock).toLocaleDateString('en-CA')}:${source.id}`}`;
const fit = assessReadingFit(source, app.profile, app.events, app.materials, app.clock);
const tokenCount = (text: string) => text.match(/\p{L}+(?:['’-]\p{L}+)*/gu)?.length ?? 0;
const draft = reactive({ passage: source.transcript, segmentWords: Math.max(40, Math.min(fit.recommendedSegmentWords, props.segmentWords ?? 250)), stage: 'ready',
  section: 0, readSections: [] as number[], checkedSections: [] as number[], unknownTokens: [] as string[],
  activeMs: 0, sectionMs: [] as number[], lookupTokens: [] as string[], response: '', submittedResponse: '', retell: '', audioId: '', audioSeconds: 0,
  feedback: '', priorExposure: true, startedAt: Date.now(), observationAt: 0, completedAt: 0 });
function notifySaved() {
  if (!currentAssignment() || draft.stage !== 'saved') return;
  const evaluated = app.events.find(e => e.id === `${sessionId}:evaluated` && e.source === 'ai');
  emit('saved', { sessionId, materialId: source.id, observationAt: draft.observationAt,
    response: draft.submittedResponse, retell: draft.retell, ...(draft.audioId ? { audioId: draft.audioId } : {}),
    activeSeconds: readingSeconds.value, priorExposure: draft.priorExposure,
    score: evaluated?.score ?? null, evaluated: !!evaluated });
}
const loaded = ref(false), running = ref(false), saving = ref(false), saveError = ref(''), recorderActive = ref(false);
const lookupText = ref(''), lookupMeaning = ref('');
const savedEvaluation = computed(() => app.events.find(e => e.id === `${sessionId}:evaluated` && e.source === 'ai'));
const parts = computed(() => {
  const sentences = draft.passage.match(/[^.!?]+[.!?]*/g) ?? [draft.passage];
  const output: string[] = []; let current = '';
  for (const sentence of sentences) {
    if (current && tokenCount(current + sentence) > draft.segmentWords) { output.push(current.trim()); current = ''; }
    current += sentence;
  }
  if (current.trim()) output.push(current.trim());
  return output;
});
const tokens = computed(() => (parts.value[draft.section] ?? '').match(/\p{L}+(?:['’-]\p{L}+)*|[^\p{L}]+/gu) ?? []);
const wordToken = (text: string) => /^\p{L}/u.test(text);
const tokenId = (index: number) => `${draft.section}:${index}`;
const readingSeconds = computed(() => Math.floor(draft.activeMs / 1000));
const wordsRead = computed(() => draft.readSections.reduce((n, index) => n + tokenCount(parts.value[index] ?? ''), 0));
const meaningful = (value: string) => value.trim().length >= 15 && tokenCount(value) >= 4;
const canFinish = computed(() => draft.stage === 'respond' && meaningful(draft.response) &&
  (meaningful(draft.retell) || !!draft.audioId && draft.audioSeconds >= 2) && !recorderActive.value && !saving.value);
let disposed = false, timer: ReturnType<typeof setInterval> | undefined;
function currentAssignment() {
  return !disposed && props.material.id === source.id && props.taskId === taskId && props.assessmentId === assessmentId;
}
let lastTick = 0, lastInteraction = 0;
let writes: Promise<boolean> = Promise.resolve(true);
let unsaved = false, writeVersion = 0;

function persist(): Promise<boolean> {
  if (!loaded.value) return Promise.resolve(false);
  const snapshot = JSON.parse(JSON.stringify(draft));
  const version = ++writeVersion; unsaved = true;
  const write = writes.then(async () => {
    try {
      await db.sessions.put({ id: sessionId, kind: 'reading', materialId: source.id, startedAt: snapshot.startedAt,
        stage: snapshot.stage, ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}), draft: snapshot });
      if (!disposed) saveError.value = '';
      if (version === writeVersion) unsaved = false;
      return true;
    } catch { if (!disposed) saveError.value = 'Could not save your reading. Keep this page open and retry saving.'; return false; }
  });
  writes = write; return write;
}
async function retrySave() {
  if (saving.value || !currentAssignment()) return;
  saving.value = true;
  // persist captures this stage synchronously. Only that successfully committed
  // saved snapshot can release the parent's continuation gate; no evidence replay.
  const savedSnapshot = draft.stage === 'saved';
  try { if (await persist() && savedSnapshot) notifySaved(); }
  finally { saving.value = false; }
}
function tick() {
  if (!running.value) return;
  const now = performance.now(), elapsed = now - lastTick;
  lastTick = now;
  if (document.hidden || now - lastInteraction > 180_000 || elapsed < 0 || elapsed > 5000) {
    running.value = false; void persist(); return;
  }
  draft.activeMs += elapsed;
  draft.sectionMs[draft.section] = (draft.sectionMs[draft.section] ?? 0) + elapsed;
}
function pause() { tick(); running.value = false; void persist(); }
function touch() { lastInteraction = performance.now(); }
function resume() {
  if (!loaded.value || draft.stage !== 'reading' || document.hidden || saving.value) return;
  lastTick = performance.now(); touch(); running.value = true;
}
async function start() {
  if (!loaded.value || draft.stage !== 'ready' || saving.value) return;
  saving.value = true;
  try {
    // Determine exposure BEFORE saving our own start event. Page navigation is not reading.
    draft.priorExposure = app.events.some(e => e.data?.materialId === source.id &&
      !['TASK_OFFERED', 'TASK_STARTED', 'TASK_COMPLETED'].includes(e.type));
    if (!await persist()) return;
    if (taskId) await app.beginTask(taskId);
    await app.evidence({ id: `${sessionId}:started`, type: 'READING_STARTED', source: 'objective', sessionId,
      data: { materialId: source.id, ...(taskId ? { taskId } : {}), priorExposure: draft.priorExposure } });
    draft.stage = 'reading';
    if (!await persist()) { draft.stage = 'ready'; return; }
  } catch { saveError.value = 'Could not save the start of this reading. Please retry.'; }
  finally { saving.value = false; }
  if (draft.stage === 'reading') resume();
}
async function nextSection() {
  if (!loaded.value || draft.stage !== 'reading' || saving.value || (draft.sectionMs[draft.section] ?? 0) < 2000) return;
  pause(); saving.value = true;
  const before = draft.section;
  if (!draft.readSections.includes(before)) draft.readSections.push(before);
  if (before < parts.value.length - 1) draft.section++;
  else draft.stage = 'respond';
  const saved = await persist(); saving.value = false;
  if (saved && draft.stage === 'reading') resume();
}
async function lookup(index: number, word: string) {
  if (saving.value || draft.stage !== 'reading') return;
  pause();
  const id = tokenId(index);
  if (!draft.unknownTokens.includes(id)) draft.unknownTokens.push(id);
  if (!draft.lookupTokens.includes(id)) draft.lookupTokens.push(id);
  lookupText.value = word;
  const found = source.chunks.find(c => c.text.toLowerCase() === word.toLowerCase()) ??
    app.chunks.find(c => c.text.toLowerCase() === word.toLowerCase());
  lookupMeaning.value = found?.meaningEn ?? 'No saved meaning yet. You can note this word and continue, or request an explanation when AI is available.';
  await persist();
}
async function explainLookup() {
  if (!lookupText.value || !app.keySet || !app.online || lookupAI.busy.value) return;
  const word = lookupText.value, section = draft.section, sentence = parts.value[section];
  if (!await persist()) return;
  const result = await lookupAI.run(signal => app.provider.lookup(word, sentence, signal));
  if (result && lookupText.value === word && draft.section === section) lookupMeaning.value = result.meaningEn;
}
function checked() {
  if (!draft.checkedSections.includes(draft.section)) draft.checkedSections.push(draft.section);
  touch(); void persist();
}
async function saveWork() {
  if (!canFinish.value) return;
  saving.value = true; pause();
  try {
    if (!await persist()) return;
    const audio = draft.audioId ? await db.audio.get(draft.audioId) : undefined;
    if (draft.audioId && (!audio || audio.kind !== 'recording' || !audio.blob.size || audio.duration < 2)) {
      saveError.value = 'The retell recording is not saved yet. Retry saving it, or write a retell.'; return;
    }
    draft.submittedResponse ||= draft.response.trim();
    draft.observationAt ||= Math.max(draft.startedAt, Date.now());
    if (!await persist()) return;
    const checkedRead = draft.checkedSections.filter(i => draft.readSections.includes(i));
    const sampled = checkedRead.reduce((n, i) => n + tokenCount(parts.value[i] ?? ''), 0);
    const unknown = draft.unknownTokens.filter(id => checkedRead.includes(Number(id.split(':')[0]))).length;
    await app.evidence({ id: `${sessionId}:observation`, type: 'READING_OBSERVATION', source: 'objective', sessionId,
      timestamp: draft.observationAt, data: { materialId: source.id, ...(taskId ? { taskId } : {}),
        firstPass: true, priorExposure: draft.priorExposure, wordsRead: wordsRead.value, activeSeconds: readingSeconds.value,
        lookupCount: draft.lookupTokens.length, wordsReadBasis: 'learner-confirmed-sections',
        ...(sampled ? { coverageMethod: 'checked-word-sample', coverageSource: 'learner-checked-recognition',
          sampledWordCount: sampled, knownWordCount: Math.max(0, sampled - unknown) } : {}) } });
    await app.evidence({ id: `${sessionId}:response`, type: 'READING_RESPONSE', source: 'text', sessionId, timestamp: draft.observationAt,
      data: { materialId: source.id, ...(taskId ? { taskId } : {}), response: draft.submittedResponse } });
    await app.evidence({ id: `${sessionId}:retell`, type: 'READING_RETELL', source: audio ? 'objective' : 'text', sessionId,
      timestamp: draft.observationAt, prompted: true,
      data: { materialId: source.id, ...(taskId ? { taskId } : {}), response: draft.retell.trim(),
        ...(audio ? { audioId: audio.id, audioObserved: true, durationSeconds: audio.duration } : {}),
        textOnly: !audio, task: 'meaning-focused retell; no spontaneous or acoustic score inferred' } });
    if (readingSeconds.value >= 30) await app.evidence({ id: `${sessionId}:practice`, type: 'PRACTICE_LOGGED', source: 'objective', sessionId,
      timestamp: draft.observationAt, data: { strand: 'input', activeSeconds: Math.min(7200, readingSeconds.value), materialId: source.id } });
    if (taskId) {
      await app.completeTask('learn', { taskId, materialId: source.id });
      // A stale/foreign task link can save practice, but cannot fabricate completion of today's assignment.
      // Name the actual activity only after the store attests that this exact learn task was completed.
      if (app.events.some(e => e.id === `completed:${taskId}` && e.type === 'TASK_COMPLETED'
        && e.data?.taskId === taskId && e.data?.kind === 'learn' && e.data?.materialId === source.id)) {
        await app.evidence({ id: `${sessionId}:completed`, type: 'TASK_COMPLETED', source: 'objective', sessionId,
          data: { kind: 'reading', taskId, materialId: source.id } });
      }
    }
    draft.stage = 'saved'; draft.completedAt = Math.max(draft.observationAt, Date.now()); if (await persist()) notifySaved();
  } catch { saveError.value = 'Could not finish saving. Your reading and response remain here; retry to finish safely.'; }
  finally { saving.value = false; }
}
async function feedback() {
  if (draft.stage !== 'saved' || !app.keySet || !app.online || ai.busy.value || savedEvaluation.value) return;
  if (!await persist()) return;
  const result = await ai.run(signal => app.provider.evaluate({ kind: readingRubric.version,
    text: draft.submittedResponse, reference: draft.passage, rubric: JSON.stringify(readingRubric) }, signal));
  if (!result || disposed) return;
  try {
    draft.feedback = result.summary;
    const comparisonKey = readingComparisonKey({ ...source, transcript: draft.passage });
    const comparison = comparableObservation({ rubricVersion: readingRubric.version, comparisonKey: comparisonKey ?? '',
      difficulty: source.difficulty, evaluator: assessmentEvaluator(result), conditions: `without-passage:segmented-${draft.segmentWords}:checked-${draft.checkedSections.length > 0}`,
      firstPass: true, priorExposure: draft.priorExposure, prompted: draft.lookupTokens.length > 0 });
    if (typeof result.comprehension === 'number' && Number.isFinite(result.comprehension) && result.comprehension >= 0 && result.comprehension <= 1) await app.evidence({ id: `${sessionId}:evaluated`, type: 'READING_EVALUATED', source: 'ai', sessionId,
      timestamp: draft.observationAt, skill: 'reading', score: result.comprehension, prompted: draft.lookupTokens.length > 0,
      data: { materialId: source.id, response: draft.submittedResponse, rubricVersion: readingRubric.version,
        difficulty: source.difficulty, firstPass: true, priorExposure: draft.priorExposure,
        comparisonBasis: 'same-editorial-difficulty-length-and-complexity;not-equated-forms', feedback: result.summary,
        ...(comparison ?? {}), ...(props.assessmentId ? { assessmentId: props.assessmentId } : {}),
        ...(props.taskId ? { taskId: props.taskId } : {}) } });
    if (await persist()) notifySaved();
  } catch { saveError.value = 'Your response is saved. Feedback could not be saved; retry later.'; }
}
async function leave() {
  if (recorderActive.value || saving.value) return false;
  pause(); return await persist();
}
async function defer(reason: 'too-hard' | 'not-interested' | 'busy') {
  if (saving.value || recorderActive.value) return;
  pause();
  if (!await persist()) return;
  try {
    if (taskId) await app.evidence({ id: `${sessionId}:skipped:${reason}`, type: 'TASK_SKIPPED', source: 'objective', sessionId,
      data: { taskId, kind: 'reading', reason, materialId: source.id } });
    await router.push('/');
  } catch { saveError.value = 'Your reading is saved, but this change could not be saved. Try again.'; }
}
function beforeUnload(event: BeforeUnloadEvent) {
  const needsSave = running.value || unsaved || !!saveError.value || recorderActive.value || saving.value;
  pause();
  if (needsSave) { event.preventDefault(); event.returnValue = ''; }
}
function visibility() { if (document.hidden) pause(); }
watch(() => [draft.response, draft.retell, draft.audioId], () => { if (loaded.value) void persist(); }, { flush: 'sync' });
onBeforeRouteLeave(leave);
onBeforeRouteUpdate(leave);
onMounted(async () => {
  try {
    const saved = await db.sessions.get(sessionId);
    if (disposed) return;
    if (saved) {
      const d = saved.draft;
      for (const key of ['passage', 'response', 'submittedResponse', 'retell', 'audioId', 'feedback'] as const) if (typeof d[key] === 'string') draft[key] = d[key];
      for (const key of ['activeMs', 'section', 'segmentWords', 'audioSeconds', 'observationAt', 'completedAt'] as const) if (typeof d[key] === 'number' && Number.isFinite(d[key]) && d[key] >= 0) draft[key] = d[key];
      draft.segmentWords = Math.max(40, Math.min(250, draft.segmentWords));
      draft.section = Math.max(0, Math.min(parts.value.length - 1, Math.floor(draft.section)));
      for (const key of ['readSections', 'checkedSections'] as const) if (Array.isArray(d[key])) draft[key] = [...new Set(d[key].filter((n): n is number => Number.isInteger(n) && n >= 0 && n < parts.value.length))];
      if (Array.isArray(d.sectionMs)) draft.sectionMs = d.sectionMs.map(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0).slice(0, parts.value.length);
      for (const key of ['unknownTokens', 'lookupTokens'] as const) if (Array.isArray(d[key])) draft[key] = [...new Set(d[key].filter((s): s is string => typeof s === 'string' && /^\d+:\d+$/.test(s)))];
      draft.stage = ['ready', 'reading', 'respond', 'saved'].includes(String(saved.stage)) ? saved.stage : 'ready';
      draft.priorExposure = d.priorExposure !== false; draft.startedAt = saved.startedAt;
    }
    loaded.value = true;
    if (!draft.feedback && typeof savedEvaluation.value?.data?.feedback === 'string') draft.feedback = savedEvaluation.value.data.feedback;
    if (await persist() && draft.stage === 'saved') notifySaved();
    timer = setInterval(() => { tick(); if (running.value) void persist(); }, 1000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', pause); window.addEventListener('beforeunload', beforeUnload);
  } catch { saveError.value = 'Could not load your saved reading. Reload to retry; existing work has not been replaced.'; }
});
onBeforeUnmount(() => {
  pause(); disposed = true; if (timer) clearInterval(timer);
  document.removeEventListener('visibilitychange', visibility);
  window.removeEventListener('blur', pause); window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
  <section class="reading-practice" aria-label="Reading practice">
    <div class="page-heading"><div><p class="eyebrow">READ FOR MEANING · HAVE SOMETHING TO SAY</p>
      <h1 tabindex="-1">A story worth <span class="serif">sharing.</span></h1>
      <p class="lede">{{ source.title }} · {{ source.topic }}</p></div></div>
    <p class="help-text">{{ source.sourceLabel }} · {{ fit.confidence === 'unknown' ? 'Reading fit is still unknown. Start with a small section.' : 'Reading fit is an estimate from observed practice.' }}</p>
    <p v-if="saveError" class="error" role="alert">{{ saveError }} <button class="text-button" :disabled="saving" @click="retrySave">Retry saving</button></p>
    <div v-if="draft.stage === 'ready'" class="panel">
      <p>Read at your own pace. Tap unfamiliar words, then share the main idea and something it makes you think about.</p>
      <button class="button primary" :disabled="!loaded || saving" @click="start">Start reading</button>
    </div>
    <template v-else-if="draft.stage === 'reading'">
      <div class="row between"><span>Section {{ draft.section + 1 }} of {{ parts.length }} · {{ readingSeconds }} active seconds</span>
        <button class="text-button" :disabled="saving" @click="running ? pause() : resume()">{{ running ? 'Pause reading' : 'Resume reading' }}</button></div>
      <article class="panel reading-passage" @pointerdown="touch" @keydown="touch">
        <template v-for="(token, index) in tokens" :key="index"><button
          v-if="wordToken(token)" class="reading-word" :aria-label="`Look up ${token}`"
          :aria-pressed="draft.unknownTokens.includes(tokenId(index))" :disabled="saving" @click="lookup(index, token)">{{ token }}</button><span v-else>{{ token }}</span></template>
      </article>
      <div v-if="lookupText" class="panel" aria-label="Reading word lookup">
        <strong>{{ lookupText }}</strong><p>{{ lookupMeaning }}</p>
        <button v-if="app.keySet && app.online" class="text-button" :disabled="lookupAI.busy.value" @click="explainLookup">Explain this word with AI</button>
        <p v-if="lookupAI.error.value" class="error" role="alert">{{ lookupAI.error.value }}</p>
        <button class="button secondary" @click="lookupText = ''; lookupAI.cancel(); resume()">Return to reading</button>
      </div>
      <details class="section"><summary>Optional word familiarity check</summary>
        <p>After marking unfamiliar words, confirm only if you checked the remaining words in this section. This is your recognition estimate, not a comprehension test.</p>
        <button class="button secondary" :disabled="draft.checkedSections.includes(draft.section)" @click="checked">{{ draft.checkedSections.includes(draft.section) ? 'Word check saved' : 'I checked the words in this section' }}</button>
      </details>
      <button class="button primary" :disabled="saving || (draft.sectionMs[draft.section] ?? 0) < 2000" @click="nextSection">{{ draft.section < parts.length - 1 ? 'I read this section · continue' : 'I read this section · share the meaning' }}</button>
      <p class="help-text">The timer pauses when hidden or interrupted. Visible reading time and your section confirmations cannot prove comprehension.</p>
    </template>
    <div v-else-if="draft.stage === 'respond'" class="panel">
      <label for="reading-response">In your own words: what happened, and what interested you?</label>
      <textarea id="reading-response" v-model="draft.response" rows="4" maxlength="3000" :disabled="saving || !!draft.observationAt" />
      <h2>Tell it to someone</h2><p>Retell the idea without the passage. A short recording is enough; a written retell is available too.</p>
      <Recorder
        label="Retell your reading" :saved-audio-id="draft.audioId" :disabled="saving || !!draft.observationAt" @active="recorderActive = $event"
        @recorded="draft.audioId = $event.audioId; draft.audioSeconds = $event.duration; persist()" @transcribed="draft.retell = $event" />
      <label for="reading-retell">Your retell or recording transcript</label>
      <textarea id="reading-retell" v-model="draft.retell" rows="3" maxlength="3000" :disabled="saving || !!draft.observationAt" />
      <p class="help-text">Save an actual brief response and a retell. Written retells do not establish spoken or acoustic ability.</p>
      <button class="button primary" :disabled="!canFinish" @click="saveWork">Save reading & retell</button>
    </div>
    <div v-else-if="draft.stage === 'saved'" class="panel" role="status">
      <h2>Saved. Ready to reflect on the meaning.</h2>
      <p>Your reading observations, response and retell are saved. No mastery score was awarded for finishing.</p>
      <blockquote>{{ draft.submittedResponse }}</blockquote>
      <button v-if="app.keySet && app.online && !savedEvaluation" class="button secondary" :disabled="ai.busy.value" @click="feedback">Get feedback on the meaning</button>
      <p v-if="draft.feedback">{{ draft.feedback }}</p><p v-if="ai.error.value" class="error" role="alert">{{ ai.error.value }} Your saved work is safe.</p>
      <button v-if="!assessmentId" class="button primary" @click="router.push('/')">Back to today</button>
      <p v-else class="help-text">This reading is saved for your check-in. Without meaning evaluation its score remains unobserved; saving text is not evidence of improvement.</p>
    </div>
    <details v-if="loaded && draft.stage !== 'saved'" class="section">
      <summary>Leave this reading for later</summary>
      <p>Your draft stays saved. Pick the reason that fits today.</p>
      <div class="row">
        <button class="button secondary" :disabled="saving || recorderActive" @click="defer('too-hard')">Too difficult today</button>
        <button class="button secondary" :disabled="saving || recorderActive" @click="defer('not-interested')">Not interested in this topic</button>
        <button class="button secondary" :disabled="saving || recorderActive" @click="defer('busy')">No time today</button>
      </div>
    </details>
  </section>
</template>

<style scoped>
.reading-passage { font-size: 1.18rem; line-height: 2; margin: 1rem 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.reading-word { display: inline; min-width: 0; padding: 0; border: 0; border-radius: 2px; color: inherit; background: none; font: inherit; text-align: inherit; cursor: pointer; }
.reading-word[aria-pressed="true"] { text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 4px; }
.reading-word:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
.reading-practice .panel > .button { margin-top: 1rem; margin-right: .75rem; }
.reading-practice textarea { width: 100%; margin-bottom: 1rem; }
</style>
