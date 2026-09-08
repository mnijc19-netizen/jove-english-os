<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRefs, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from "vue-router";
import { useApp } from "../stores/app";
import { db } from "../db/db";
import { addChunk } from "../db/repository";
import { useRequest } from "../composables/useRequest";
import { demoMaterials } from "../content/materials";
import { contentAudioIsTransient, prepareContentAudio } from "../cloud/content";
import type { Evaluation, MaterialChunk, StudyEvent, StudySession } from "../domain/types";
import AudioPlayer from "../components/AudioPlayer.vue";
import Recorder from "../components/Recorder.vue";
import PronunciationPractice from "../components/PronunciationPractice.vue";
import { usePronunciationSession } from "../speech/practice";
import { ObservedPracticeClock } from "../speech/events";
import { comparableObservation, assessmentEvaluator } from "../domain/longitudinal";
const shadowCaptureActive = ref(false);
import Icon from "../components/Icon.vue";

interface FirstResponse {
  answer: string; estimate: number; playCount: number; completedPlays: number;
  priorExposure: boolean; revealed: boolean; chineseUsed: boolean; synthetic: boolean;
  playbackRates: number[] | null;
}
interface WordLookup {
  id: string; expression: string; sourceSentence: string; sentence: number;
  candidate: MaterialChunk; origin: "material" | "saved" | "manual" | "ai";
  edited: boolean; chineseShown: boolean; revision: number; chunkId: string;
}
interface ListeningDraft {
  stage: number; answer: string; estimate: number; listened: boolean;
  selfCheck: number | null; audioId: string; sentence: number; phrase: number;
  chinese: boolean; chineseUsed: boolean; revealed: boolean; answerRevealed: boolean;
  chunked: boolean; playCount: number; completedPlays: number; priorExposure: boolean;
  taskId: string; taskKind: string; first: FirstResponse | null; feedback: Evaluation | null;
  outbox: StudyEvent[];
  lookups: WordLookup[]; lookupId: string;
  playbackRates: number[]; playbackRateUnknown: boolean;
}
const freshDraft = (): ListeningDraft => ({
  stage: 0, answer: "", estimate: 50, listened: false, selfCheck: null, audioId: "",
  sentence: -1, phrase: -1, chinese: false, chineseUsed: false, revealed: false,
  answerRevealed: false, chunked: false, playCount: 0, completedPlays: 0,
  priorExposure: false, taskId: "", taskKind: "listen", first: null, feedback: null, outbox: [],
  lookups: [], lookupId: "", playbackRates: [], playbackRateUnknown: false,
});
const app = useApp(), route = useRoute(), router = useRouter();
const player = ref<InstanceType<typeof AudioPlayer>>();
const materialId = ref(""), sid = ref(""), startedAt = ref(0), completedAt = ref<number>();
const pronunciation = usePronunciationSession(sid, materialId);
const { reference: pronunciationReference, savedAudioId: pronunciationAudioId, savedReferenceId: pronunciationReferenceId,
  pendingAttempt: pronunciationAttempt, active: pronunciationActive, loading: pronunciationLoading, problem: pronunciationProblem,
  disabled: pronunciationDisabled, recoveredResults: pronunciationResults } = pronunciation;
const captureActive = computed(() => shadowCaptureActive.value || pronunciationActive.value);
watch(captureActive, active => { if (active) player.value?.stop(); });
const listeningMedia = ref<HTMLElement>();
const listeningClock = new ObservedPracticeClock();
let listeningTimer: ReturnType<typeof setInterval> | undefined;
const listeningRubric = 'listening-main-idea-detail-v1';
const draft = reactive<ListeningDraft>(freshDraft());
const { stage, answer, estimate, listened, selfCheck, sentence, chinese, chunked, feedback } = toRefs(draft);
const savedAudioId = computed({ get: () => draft.audioId, set: (value: string) => { draft.audioId = value; } });
const material = computed(() => app.materials.find(m => m.id === materialId.value));
const blobUrl = ref(""), hydrating = ref(true), restoreFailed = ref(false), localError = ref(""), working = ref(false), repeating = ref(false);
const audioLoading = ref(false), audioError = ref(""), audioReload = ref(0), audioTransient = ref(false);
const { busy, error, run, cancel } = useRequest();
const { busy: lookupBusy, error: lookupError, run: runLookup, cancel: cancelLookup } = useRequest();
const lookupInput = ref("");
const wordLookup = computed(() => draft.lookups.find(entry => entry.id === draft.lookupId));
const normalized = (value: string) => value.trim().toLocaleLowerCase("en").replace(/’/g, "'");
const wordsOf = (value: string) => value.match(/[\p{L}\p{N}]+(?:['’\p{Pd}][\p{L}\p{N}]+)*/gu) || [];
const sentenceWords = computed(() => wordsOf(material.value?.sentences[sentence.value] || ""));
const relatedChunks = computed(() => wordLookup.value ? material.value?.chunks.filter(c =>
  normalized(c.text) !== normalized(wordLookup.value!.expression) &&
  wordsOf(c.text).some(word => normalized(word) === normalized(wordLookup.value!.expression))) || [] : []);
const canAddLookup = computed(() => !!wordLookup.value?.candidate.meaningEn.trim() &&
  !!wordLookup.value?.candidate.example.trim() && !wordLookup.value.chunkId && !lookupBusy.value && !working.value);
let generation = 0, disposed = false, pending: Promise<unknown> = Promise.resolve();
let evidenceQueue: Promise<void> = Promise.resolve();
const hasSentenceFiles = computed(() => !!material.value && demoMaterials.some(m =>
  m.id === material.value!.id && m.audioPath === material.value!.audioPath &&
  m.transcript === material.value!.transcript && JSON.stringify(m.sentences) === JSON.stringify(material.value!.sentences)) &&
  !material.value.audioId && material.value.synthetic);
const phrases = computed(() => {
  const line = material.value?.sentences[sentence.value] || "";
  // Editorial phrase boundaries are practice scaffolding, not forced-alignment timestamps.
  return line.split(/(?<=[,;:])\s+|\s+(?=(?:but|because|so|then|and|instead of)\b)/i).filter(Boolean);
});
const supplementaryAudio = computed(() => !!wordLookup.value || sentence.value >= 0 && draft.phrase >= 0);
const authenticAudio = computed(() => !!material.value?.authenticPlayback && !supplementaryAudio.value);
const playbackRange = computed(() => {
  if (!authenticAudio.value) return undefined;
  const playback = material.value!.authenticPlayback!;
  const { startSeconds, endSeconds, durationSeconds } = playback;
  if (![startSeconds, endSeconds, durationSeconds].every(Number.isFinite) || startSeconds < 0 ||
    endSeconds <= startSeconds || endSeconds > durationSeconds + 0.05) return undefined;
  if (sentence.value < 0) return { startSeconds, endSeconds };
  const range = playback.sentenceRanges?.[sentence.value];
  if (!range || !Number.isInteger(sentence.value) || ![range.startSeconds, range.endSeconds].every(Number.isFinite) ||
    range.startSeconds < 0 || range.endSeconds <= range.startSeconds || range.endSeconds > endSeconds - startSeconds + 0.05) return undefined;
  // Sentence times start at lesson zero; source timestamps must never seek into the saved clip.
  return { startSeconds: startSeconds + range.startSeconds, endSeconds: startSeconds + range.endSeconds };
});
// Omitting text also removes AudioPlayer's explicit device/provider TTS fallback on media errors.
const audioText = computed(() => authenticAudio.value ? undefined : wordLookup.value ? wordLookup.value.expression : sentence.value < 0 ? material.value?.transcript :
  draft.phrase >= 0 ? phrases.value[draft.phrase] : material.value?.sentences[sentence.value]);
const sentenceFallback = computed(() => !authenticAudio.value && sentence.value >= 0 && (!hasSentenceFiles.value || draft.phrase >= 0));
const audioSrc = computed(() => supplementaryAudio.value ? undefined : authenticAudio.value ? blobUrl.value || undefined : sentence.value >= 0
  ? hasSentenceFiles.value && draft.phrase < 0 ? `audio/${materialId.value}-${sentence.value}.wav` : undefined
  : blobUrl.value || material.value?.audioPath);
const syntheticPlayback = computed(() => !authenticAudio.value && (!!wordLookup.value || sentenceFallback.value || !!material.value?.synthetic || !audioSrc.value));
const audioReady = computed(() => (supplementaryAudio.value || !audioLoading.value && !audioError.value) &&
  (!authenticAudio.value || !!blobUrl.value && !!playbackRange.value));
const audioLabel = computed(() => wordLookup.value
  ? `Word / phrase pronunciation: “${wordLookup.value.expression}” · synthetic demonstration, not original recorded speech.`
  : authenticAudio.value
  ? sentence.value >= 0 ? `Original recorded speech · sentence ${sentence.value + 1} of ${material.value?.sentences.length}. Use 1× → 0.85× → 1×.`
    : "Original recorded speech · listen without the transcript. Playback starts and repeats are recorded."
  : sentenceFallback.value
  ? `Synthesized ${draft.phrase >= 0 ? "phrase" : "sentence"} demonstration · not a segment of the imported recording.`
  : sentence.value >= 0 ? `Sentence ${sentence.value + 1} of ${material.value?.sentences.length}. Use 1× → 0.85× → 1×.`
    : stage.value === 0 ? "Listen without the transcript. Playback starts and repeats are recorded." : "Full passage replay.");
const locked = computed(() => !!draft.first || completedAt.value !== undefined);
// Store refresh replaces Material objects after evidence writes. Identical content must keep playing.
const audioIdentity = computed(() => hydrating.value || restoreFailed.value || !material.value ? "" :
  JSON.stringify([material.value.id, material.value.authenticPlayback, material.value.audioId,
    material.value.sentences, material.value.transcript, material.value.synthetic, material.value.approved]));
watch([audioIdentity, audioReload], async ([identity], _previous, onCleanup) => {
  const controller = new AbortController();
  let url = "";
  onCleanup(() => {
    controller.abort(); player.value?.stop();
    if (url) URL.revokeObjectURL(url);
    blobUrl.value = ""; audioTransient.value = false;
  });
  audioError.value = ""; audioLoading.value = false;
  const currentMaterial = material.value;
  if (!identity || !currentMaterial || disposed) return;
  if (!currentMaterial.authenticPlayback && !currentMaterial.audioId) return;
  audioLoading.value = true;
  try {
    const blob = currentMaterial.authenticPlayback
      ? await prepareContentAudio(currentMaterial, controller.signal)
      : (await db.audio.get(currentMaterial.audioId!))?.blob;
    if (controller.signal.aborted || disposed) return;
    if (!blob?.size) throw new Error('Missing saved audio');
    url = URL.createObjectURL(blob); blobUrl.value = url;
    audioTransient.value = !!currentMaterial.authenticPlayback && contentAudioIsTransient(blob);
  } catch {
    if (!controller.signal.aborted && !disposed) audioError.value = "The original audio could not be loaded or verified. Your answer stays here. Check your connection and retry.";
  } finally {
    if (!controller.signal.aborted && !disposed) audioLoading.value = false;
  }
}, { immediate: true, flush: "sync" });
function retryAudio() { if (!audioLoading.value && !captureActive.value) audioReload.value++; }
function audioPlaybackFailed() {
  if (!authenticAudio.value) return;
  player.value?.stop(); repeating.value = false;
  audioError.value = "The original audio could not play. Your answer stays here. Retry loading the recording.";
}
function snapshot(): StudySession {
  return JSON.parse(JSON.stringify({
    id: sid.value, kind: "listen", materialId: materialId.value, startedAt: startedAt.value,
    ...(completedAt.value !== undefined ? { completedAt: completedAt.value } : {}),
    stage: String(stage.value), draft,
  }));
}
function save(): Promise<unknown> {
  if (hydrating.value || restoreFailed.value || !sid.value || !material.value) return Promise.resolve();
  const row = snapshot();
  const operation = pending.catch(() => undefined).then(() => db.sessions.put(row));
  pending = operation;
  return operation;
}
function reportSave() {
  void save().catch(() => { localError.value = "Could not save this attempt. Keep this page open and retry saving."; });
}
function flushEvidence() {
  const expectedSid = sid.value, expectedGeneration = generation;
  const operation = evidenceQueue.catch(() => undefined).then(async () => {
    while (!disposed && !hydrating.value && generation === expectedGeneration && sid.value === expectedSid && draft.outbox.length) {
      const event = JSON.parse(JSON.stringify(draft.outbox[0])) as StudyEvent;
      await save();
      await app.evidence(event);
      if (sid.value !== expectedSid || generation !== expectedGeneration || disposed) return;
      draft.outbox = draft.outbox.filter(e => e.id !== event.id);
      await save();
    }
  });
  evidenceQueue = operation;
  return operation;
}
async function evidence(event: Omit<StudyEvent, "id" | "timestamp"> & { id?: string; timestamp?: number }) {
  const row = { ...event, id: event.id || crypto.randomUUID(), timestamp: event.timestamp ?? Date.now() };
  if (!draft.outbox.some(e => e.id === row.id)) draft.outbox.push(row);
  await save();
  await flushEvidence();
}
watch(draft, reportSave, { deep: true, flush: "sync" });
const pointerId = (id: string) => "listen-active:" + id;
const contentExposureTypes = new Set([
  "AUDIO_PLAYED", "DIAGNOSTIC_LISTEN", "TRANSCRIPT_REVEALED", "LISTEN_ATTEMPT",
  "COMPREHENSION_RESPONSE", "READING_RESPONSE", "WRITING_RESPONSE", "WRITTEN_RESPONSE",
  "READING_EVALUATED", "WRITING_EVALUATED", "CHUNK_LOOKUP", "CHUNK_RECALL",
]);
async function hasContentExposure(id: string, currentSessionId?: string) {
  const [sessions, baseline] = await Promise.all([
    db.sessions.where("materialId").equals(id).toArray(), db.sessions.get("onboarding"),
  ]);
  const baselineAnswer = (baseline?.draft.answers as Record<string, { starts?: number }> | undefined)?.[id];
  const relatedSessions = new Set(sessions.filter(s => s.id !== currentSessionId).map(s => s.id));
  // Reading/rephrasing the same content removes novelty even without playing its audio.
  return sessions.some(s => s.id !== currentSessionId &&
    (s.kind === "learn" || s.kind === "listen" && (!!s.draft.listened || Number(s.stage) > 0 || !!s.completedAt))) ||
    Number(baselineAnswer?.starts) > 0 ||
    app.events.some(e => (!currentSessionId || e.sessionId !== currentSessionId) && contentExposureTypes.has(e.type) &&
      (e.data?.materialId === id || !!e.sessionId && relatedSessions.has(e.sessionId)));
}
async function createAttempt(id: string, taskId: string, taskKind: string) {
  const priorExposure = await hasContentExposure(id);
  const row: StudySession = {
    id: "listen-" + crypto.randomUUID(), kind: "listen", materialId: id,
    startedAt: Date.now(), stage: "0", draft: { ...freshDraft(), priorExposure, taskId, taskKind },
  };
  await db.transaction("rw", db.sessions, async () => {
    await db.sessions.add(row);
    await db.sessions.put({ id: pointerId(id), kind: "listen-pointer", materialId: id,
      startedAt: row.startedAt, stage: "active", draft: { activeSessionId: row.id } });
  });
  return row;
}
async function load(fresh = false) {
  if (sid.value && !hydrating.value) await flushListeningTime();
  const token = ++generation;
  hydrating.value = true; restoreFailed.value = false; localError.value = ""; repeating.value = false;
  player.value?.stop(); cancel(); cancelLookup(); lookupError.value = "";
  try {
    await pending.catch(() => undefined);
    const id = String(route.query.material || materialId.value ||
      app.plan.tasks.find(t => t.kind === "listen")?.materialId || app.materials[0]?.id || "");
    if (!app.materials.some(m => m.id === id)) {
      materialId.value = id; sid.value = "";
      return;
    }
    const requestedTask = String(route.query.task || route.query.taskId || "");
    const task = app.plan.tasks.find(t => requestedTask ? t.id === requestedTask : t.kind === "listen" && t.materialId === id && !t.done);
    const taskId = requestedTask || task?.id || "";
    const pointer = await db.sessions.get(pointerId(id));
    let row = !fresh && typeof pointer?.draft.activeSessionId === "string"
      ? await db.sessions.get(pointer.draft.activeSessionId) : undefined;
    // Legacy drafts remain resumable, but all new/repeat attempts use UUIDs.
    if (!row && !fresh) row = await db.sessions.get("listen-" + id);
    if (row?.materialId !== id || row?.kind !== "listen" ||
      (requestedTask && row.draft.taskId !== requestedTask)) row = undefined;
    if (token !== generation || disposed) return;
    if (task && !task.done && task.materialId === id && ["listen", "shadow"].includes(task.kind)) await app.beginTask(task.id);
    if (!row) row = await createAttempt(id, taskId, task?.kind || "listen");
    if (token !== generation || disposed) return;
    materialId.value = id; sid.value = row.id; startedAt.value = row.startedAt; completedAt.value = row.completedAt;
    Object.assign(draft, freshDraft(), row.draft, { stage: Number(row.stage) || 0 });
    lookupInput.value = wordLookup.value?.expression || "";
    if (!draft.taskId && !row.completedAt) { draft.taskId = taskId; draft.taskKind = task?.kind || "listen"; }
    if (!draft.first && !draft.priorExposure) {
      const exposed = await hasContentExposure(id, row.id);
      if (token !== generation || disposed) return;
      draft.priorExposure = exposed;
    }
  } catch {
    restoreFailed.value = true;
    localError.value = "Could not restore your attempt. Nothing was overwritten. Retry loading.";
  } finally {
    if (token === generation && !disposed) hydrating.value = false;
  }
  if (token === generation && !disposed && !restoreFailed.value) {
    try { await save(); if (draft.outbox.length) await flushEvidence(); }
    catch { localError.value = "Your draft includes pending learning evidence. Retry saving to finish recording it."; }
  }
}
async function safely(action: () => Promise<void>) {
  if (working.value || hydrating.value) return;
  working.value = true; localError.value = "";
  try { await action(); }
  catch { localError.value = "This action could not be saved. Your draft is still here; retry before leaving."; }
  finally { working.value = false; }
}
function conditions(first = draft.first) {
  return {
    materialId: materialId.value, priorExposure: first?.priorExposure ?? draft.priorExposure,
    playbackStarts: first?.playCount ?? draft.playCount, completedPlays: first?.completedPlays ?? draft.completedPlays,
    replay: (first?.playCount ?? draft.playCount) > 1,
    transcriptRevealed: first?.revealed ?? draft.revealed,
    chineseUsed: first?.chineseUsed ?? draft.chineseUsed,
    chineseResponse: /[\u3400-\u9fff]/.test(first?.answer ?? answer.value),
    synthetic: first?.synthetic ?? syntheticPlayback.value,
    firstPass: !(first?.priorExposure ?? draft.priorExposure) && (first?.playCount ?? draft.playCount) === 1 &&
      !(first?.revealed ?? draft.revealed) && !(first?.chineseUsed ?? draft.chineseUsed),
  };
}
async function heard() {
  if (hydrating.value || !audioReady.value || captureActive.value) return;
  if (wordLookup.value) {
    const lookup = wordLookup.value;
    try {
      await evidence({ type: "AUDIO_PLAYED", source: "objective", sessionId: sid.value, prompted: true,
        data: { materialId: materialId.value, expression: lookup.expression, synthetic: true, supported: true,
          wordPronunciation: true, transcriptRevealed: true, sentence: sentence.value } });
    } catch { localError.value = "Pronunciation played, but its practice record is pending. Retry saving."; }
    return;
  }
  draft.playCount++; if (sentence.value < 0) listened.value = true;
  const event = { type: "AUDIO_PLAYED", source: "objective" as const, sessionId: sid.value,
    prompted: stage.value > 0, data: { ...conditions(null), sentence: sentence.value,
      phrase: draft.phrase, synthetic: syntheticPlayback.value, replay: draft.playCount > 1 } };
  try { await evidence(event); }
  catch { localError.value = "Playback worked, but its record could not be saved. Retry saving."; }
}
async function ended() {
  if (hydrating.value || !audioReady.value || captureActive.value || wordLookup.value) return;
  draft.completedPlays++;
  if (repeating.value && sentence.value >= 0) {
    await nextTick();
    if (repeating.value && !disposed) await player.value?.toggle();
  }
}
async function check(localOnly = false) {
  await safely(async () => {
    if (!material.value || !answer.value.trim() || !listened.value) return;
    const token = generation, currentMaterial = material.value, currentSid = sid.value;
    if (!draft.first) draft.first = { answer: answer.value, estimate: estimate.value,
      playCount: draft.playCount, completedPlays: draft.completedPlays, priorExposure: draft.priorExposure,
      revealed: draft.revealed, chineseUsed: draft.chineseUsed, synthetic: !!material.value.synthetic || !audioSrc.value,
      playbackRates: draft.playbackRates.length && !draft.playbackRateUnknown ? [...draft.playbackRates] : null };
    await save(); // Freeze response and assistance before any network operation or answer reveal.
    if (token !== generation || disposed) return;
    const data = conditions();
    await evidence({ id: currentSid + "-first-estimate", type: "LISTEN_ATTEMPT", sessionId: currentSid,
      skill: "listeningSentences", score: draft.first.estimate / 100, source: "self-report",
      prompted: !data.firstPass, data: { ...data, response: draft.first.answer } });
    if (token !== generation || disposed) return;
    if (app.keySet && !localOnly) {
      const result = await run(signal => app.provider.evaluate({
        kind: "listening comprehension", text: draft.first!.answer, reference: currentMaterial.transcript,
        rubric: 'Judge the first response only against the reference: main meaning and accurate relevant details. Score comprehension 0..1; meaning-preserving paraphrases are acceptable. No acoustic, fluency or accent score. Rubric listening-main-idea-detail-v1.',
      }, signal));
      if (!result || token !== generation || disposed) return;
      feedback.value = result;
      if (result.comprehension !== null) await evidence({
        id: currentSid + "-meaning", type: "COMPREHENSION_RESPONSE", sessionId: currentSid,
        skill: "listeningSentences", score: result.comprehension, source: "ai", prompted: !data.firstPass,
        data: { ...data, response: draft.first.answer, textOnlyEvaluation: true,
          ...(comparableObservation({ rubricVersion: listeningRubric,
            // Exact prompt/transcript prevent unequal editorial forms being pooled.
            comparisonKey: JSON.stringify(['listen', currentMaterial.id, currentMaterial.transcript, currentMaterial.question]),
            difficulty: currentMaterial.difficulty, evaluator: assessmentEvaluator(result),
            conditions: draft.first.playbackRates ? JSON.stringify({ playbackStarts: data.playbackStarts, completedPlays: data.completedPlays,
              playbackRates: draft.first.playbackRates,
              synthetic: data.synthetic, transcriptRevealed: data.transcriptRevealed, chineseUsed: data.chineseUsed,
              chineseResponse: data.chineseResponse, rubric: listeningRubric }) : null,
            firstPass: data.firstPass && data.completedPlays === 1, priorExposure: data.priorExposure, prompted: !data.firstPass }) ?? {}) },
      });
    }
    if (token !== generation || disposed) return;
    draft.answerRevealed = true; stage.value = 1; await save();
  });
}
function markSelf(value: number) {
  return safely(async () => {
    selfCheck.value ??= value;
    await evidence({ id: sid.value + "-self-check", type: "COMPREHENSION_RESPONSE", sessionId: sid.value,
      skill: "listeningSentences", score: selfCheck.value, source: "self-report", prompted: true,
      data: { ...conditions(), answerKeyVisible: true } });
  });
}
function reveal() {
  return safely(async () => {
    draft.revealed = true; stage.value = 2;
    await evidence({ id: sid.value + "-reveal", type: "TRANSCRIPT_REVEALED", sessionId: sid.value,
      source: "objective", data: { materialId: materialId.value } });
  });
}
function toggleChinese() {
  chinese.value = !chinese.value;
  if (chinese.value) draft.chineseUsed = true;
}
function selectSentence(index: number) {
  closeLookup();
  repeating.value = false; player.value?.stop(); sentence.value = index; draft.phrase = -1;
}
function selectPhrase(index: number) {
  closeLookup();
  repeating.value = false; player.value?.stop(); draft.phrase = index;
}
function toggleChunks() {
  chunked.value = !chunked.value;
  if (chunked.value && sentence.value < 0) selectSentence(0);
  if (!chunked.value) selectPhrase(-1);
}
function closeLookup() {
  cancelLookup(); lookupError.value = ""; draft.lookupId = ""; lookupInput.value = "";
  player.value?.stop();
}
function markLookupEdited() {
  if (wordLookup.value) { wordLookup.value.edited = true; wordLookup.value.chunkId = ""; }
}
function lookupData(entry: WordLookup) {
  return { materialId: materialId.value, expression: entry.expression, sourceSentence: entry.sourceSentence,
    meaningEn: entry.candidate.meaningEn, meaningZh: entry.candidate.meaningZh, example: entry.candidate.example,
    origin: entry.origin, edited: entry.edited, supported: true, transcriptRevealed: true,
    chineseUsed: entry.chineseShown && app.settings.chineseHelp, candidateOnly: !entry.chunkId };
}
async function recordLookup(entry: WordLookup, added = false) {
  await evidence({
    id: sid.value + "-word-" + entry.id + "-" + (added ? "added-" + entry.chunkId : entry.revision),
    type: "CHUNK_LOOKUP", source: entry.origin === "ai" && !entry.edited ? "ai" : "text",
    sessionId: sid.value, prompted: true,
    ...(entry.chunkId ? { chunkId: entry.chunkId } : {}),
    // Viewing a definition or adding a card is supported study, not a scored ability observation.
    data: lookupData(entry),
  });
}
async function selectWord(value: string) {
  const token = generation, expression = value.trim(), sourceSentence = material.value?.sentences[sentence.value] || "";
  if (stage.value < 2 || !sourceSentence || !expression || expression.length > 200) return;
  cancelLookup(); lookupError.value = ""; repeating.value = false; player.value?.stop();
  let entry = draft.lookups.find(item => normalized(item.expression) === normalized(expression) && item.sourceSentence === sourceSentence);
  if (!entry) {
    if (draft.lookups.length >= 200) { lookupError.value = "This attempt already has 200 saved lookups. Reuse an entry or start a fresh attempt."; return; }
    const materialEntry = material.value?.chunks.find(c => normalized(c.text) === normalized(expression));
    const savedEntry = app.chunks.find(c => normalized(c.text) === normalized(expression));
    const candidate: MaterialChunk = materialEntry ? { ...materialEntry, text: expression } : savedEntry ? {
      text: expression, meaningEn: savedEntry.meaningEn, meaningZh: savedEntry.meaningZh,
      example: savedEntry.examples[0] || savedEntry.sourceSentence,
    } : { text: expression, meaningEn: "", meaningZh: "", example: sourceSentence };
    entry = { id: crypto.randomUUID(), expression, sourceSentence, sentence: sentence.value, candidate,
      origin: materialEntry ? "material" : savedEntry ? "saved" : "manual",
      edited: false, chineseShown: false, revision: 0, chunkId: "" };
    draft.lookups.push(entry);
  }
  draft.lookupId = entry.id; lookupInput.value = entry.expression;
  try {
    await save();
    if (entry.candidate.meaningEn && token === generation && draft.lookupId === entry.id && !disposed) await recordLookup(entry);
  } catch { localError.value = "Your lookup candidate is retained. Retry saving before leaving."; }
}
async function explainWord() {
  const entry = wordLookup.value, token = generation;
  if (!entry || lookupBusy.value || !app.keySet || !app.online) return;
  lookupError.value = "";
  try {
    await save(); // Store the query and source before any paid request.
    if (token !== generation || draft.lookupId !== entry.id || disposed) return;
    const result = await runLookup(signal => app.provider.lookup(entry.expression, entry.sourceSentence, signal));
    if (!result || token !== generation || draft.lookupId !== entry.id || disposed) return;
    const active = wordLookup.value;
    if (!active) return;
    active.candidate = { ...result }; active.origin = "ai"; active.edited = false;
    active.revision++; active.chunkId = ""; active.chineseShown = false;
    await save();
    if (token === generation && draft.lookupId === active.id && !disposed) await recordLookup(active);
  } catch { lookupError.value = "Your candidate is still here, but could not be saved. Retry saving before requesting again."; }
}
function pronounceWord() {
  return safely(async () => {
    const token = generation, id = draft.lookupId;
    await save(); await nextTick();
    if (id && token === generation && id === draft.lookupId && !disposed) await player.value?.toggle();
  });
}
function addLookupToReview() {
  return safely(async () => {
    const entry = wordLookup.value, token = generation, id = materialId.value;
    if (!entry || !entry.candidate.meaningEn.trim() || !entry.candidate.example.trim() || entry.chunkId) return;
    const candidate = JSON.parse(JSON.stringify(entry.candidate)) as MaterialChunk;
    await save();
    const chunk = await addChunk(candidate, id);
    if (token !== generation || disposed || draft.lookupId !== entry.id) return;
    entry.chunkId = chunk.id; await save(); await recordLookup(entry, true);
    await app.refresh();
    app.notice = "Added to Review as supported study. Future recall and speaking need separate attempts.";
  });
}
function toggleLookupChinese() {
  if (!wordLookup.value || !app.settings.chineseHelp) return;
  wordLookup.value.chineseShown = !wordLookup.value.chineseShown;
  if (wordLookup.value.chineseShown) draft.chineseUsed = true;
}
function capture(text: string, gap: boolean) {
  return safely(async () => {
    const token = generation;
    const c = material.value?.chunks.find(c => c.text === text);
    if (!c || !material.value) return;
    const chunk = await addChunk(c, material.value.id);
    if (token !== generation || disposed) return;
    await evidence({
      id: sid.value + (gap ? "-gap-" : "-lookup-") + chunk.id,
      type: gap ? "LISTENING_MISS" : "CHUNK_LOOKUP", source: "self-report",
      sessionId: sid.value, skill: gap ? "listeningWords" : "chunkRecognition", score: gap ? 0 : 0.3,
      chunkId: chunk.id, modality: gap ? "listening" : "recognition", prompted: true,
      data: { readingKnown: gap, materialId: materialId.value, transcriptRevealed: true },
    });
    app.notice = gap ? "Saved as a listening gap. Future practice can focus on hearing this expression." : "Added to your chunks and future recall practice.";
  });
}
async function recorded(value: { audioId: string; duration: number }) {
  savedAudioId.value = value.audioId;
  try {
    await evidence({ id: sid.value + "-shadow-" + value.audioId, type: "PRONUNCIATION_ATTEMPT",
      source: "objective", sessionId: sid.value, prompted: true,
      data: { duration: value.duration, audioId: value.audioId, materialId: materialId.value, sentence: sentence.value, imitation: true } });
  } catch { localError.value = "Your recording reference is retained. Retry saving its learning evidence before leaving."; }
}
function finish() {
  if (captureActive.value) return;
  return safely(async () => {
    const taskId = draft.taskId, id = materialId.value, taskKind = draft.taskKind, sessionId = sid.value, token = generation;
    completedAt.value ??= Date.now(); repeating.value = false; player.value?.stop();
    await flushListeningTime(); await save(); await flushEvidence();
    const assignment = app.plan.tasks.find(t => t.id === taskId);
    if (assignment?.materialId && assignment.materialId !== id) {
      app.notice = "Practice saved. This route's assignment belongs to another material, so it was not marked complete.";
    } else {
      await app.completeTask(taskKind === "shadow" ? "shadow" : "listen", { taskId: taskId || undefined, materialId: id });
    }
    if (token === generation && !disposed) await router.push({ path: "/learn", query: { material: id, sourceSession: sessionId } });
  });
}
async function restart() {
  if (captureActive.value) return;
  await safely(async () => { await save(); await flushEvidence(); await load(true); });
}
async function retrySave() {
  if (!sid.value || restoreFailed.value) { await load(); return; }
  await safely(async () => { await save(); await flushEvidence(); });
}
async function beforeNavigation() {
  if (captureActive.value) { localError.value = "Finish or cancel the recording/assessment before leaving."; return false; }
  try { await flushListeningTime(); await save(); }
  catch {
    localError.value = "Could not save before leaving. Retry saving; your draft is still here.";
    return false;
  }
}
onBeforeRouteLeave(beforeNavigation);
onBeforeRouteUpdate(beforeNavigation);
function hotkey(e: KeyboardEvent) {
  if (hydrating.value || captureActive.value || /INPUT|TEXTAREA|SELECT|BUTTON/.test((e.target as HTMLElement).tagName)) return;
  if (e.code === "Space") { e.preventDefault(); void player.value?.toggle(); }
  if (stage.value >= 2 && material.value && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();
    selectSentence(Math.max(0, Math.min(material.value.sentences.length - 1, sentence.value + (e.key === "ArrowRight" ? 1 : -1))));
  }
}
watch(() => [route.query.material, route.query.task, route.query.taskId], () => { void load(); }, { immediate: true });
let lastMediaTime: number | null = null, lastMediaSample: number | null = null, mediaIdentity: HTMLAudioElement | undefined;
function observePlaybackRate() {
  if (draft.first) return;
  const audio = listeningMedia.value?.querySelector('audio');
  if (!audio || !Number.isFinite(audio.playbackRate) || audio.playbackRate <= 0) { draft.playbackRateUnknown = true; return; }
  if (!draft.playbackRates.includes(audio.playbackRate)) draft.playbackRates.push(audio.playbackRate);
}
function sampleListeningTime() {
  const audio = listeningMedia.value?.querySelector('audio');
  const now = performance.now();
  const elapsed = lastMediaSample === null ? 0 : (now - lastMediaSample) / 1000;
  const advanced = !!audio && audio === mediaIdentity && lastMediaTime !== null && audio.currentTime > lastMediaTime &&
    audio.currentTime - lastMediaTime <= elapsed * audio.playbackRate + 0.3;
  if (audio && !audio.paused) observePlaybackRate();
  listeningClock.sample(now, advanced && !!audio && audio.readyState >= 3 && !audio.paused && !audio.ended && !audio.seeking &&
    document.visibilityState === 'visible' && document.hasFocus() && !captureActive.value && !hydrating.value);
  lastMediaTime = audio?.currentTime ?? null; lastMediaSample = now; mediaIdentity = audio ?? undefined;
}
async function flushListeningTime() {
  sampleListeningTime();
  const activeSeconds = listeningClock.takeSeconds();
  if (!activeSeconds || !sid.value || hydrating.value || disposed) return;
  await evidence({ type: 'PRACTICE_LOGGED', source: 'objective', sessionId: sid.value,
    data: { strand: 'input', activeSeconds, materialId: materialId.value, measured: 'visible-media-playback-wall-time' } });
}
onMounted(() => {
  window.addEventListener("keydown", hotkey);
  let ticks = 0;
  listeningTimer = setInterval(() => {
    sampleListeningTime();
    if (++ticks % 15 === 0) void flushListeningTime().catch(() => { localError.value = 'Observed listening time is pending in your draft. Retry saving.'; });
  }, 1000);
});
onBeforeUnmount(() => {
  disposed = true; generation++; repeating.value = false; cancel(); cancelLookup();
  window.removeEventListener("keydown", hotkey);
  clearInterval(listeningTimer);
});
</script>
<template>
  <div class="page task-page">
    <div class="page-heading compact-heading">
      <div>
        <p class="eyebrow">LISTEN · UNDERSTAND · NOTICE</p>
        <h1 tabindex="-1">Listen for <span class="serif">meaning.</span></h1>
        <p class="lede">Let the sound come first. The words can wait.</p>
      </div>
      <RouterLink to="/library" class="button secondary"
        ><Icon name="library" :size="16" />Choose material</RouterLink
      >
    </div>
    <p v-if="hydrating" role="status">Restoring your listening attempt…</p>
    <p v-if="localError" class="error" role="alert">{{ localError }}
      <button class="text-button" :disabled="working || hydrating" @click="retrySave">Retry saving / loading</button>
    </p>
    <div v-if="material && !hydrating && !restoreFailed" class="practice-layout" :aria-busy="working">
      <section class="panel practice-main">
        <div class="step-strip">
          <span :class="{ active: stage === 0 }">01 · Blind listen</span
          ><span :class="{ active: stage === 1 }">02 · Meaning</span
          ><span :class="{ active: stage >= 2 }">03 · Notice & repeat</span>
        </div>
        <div class="lesson-meta">
          <span class="pill">{{ material.topic }}</span
          ><span class="muted"
            >{{ material.duration }} sec · {{ material.sourceLabel }}</span
          >
        </div>
        <h2>{{ material.title }}</h2>
        <p class="help-text" data-testid="attempt-status">
          {{ draft.priorExposure ? "Repeat material · prior exposure recorded." : "New attempt · no earlier exposure recorded in this device’s history." }}
          {{ completedAt ? "This attempt is completed." : "Your draft resumes in this attempt." }}
          Playback starts: {{ draft.playCount }} · completed plays: {{ draft.completedPlays }}.
        </p>
        <button class="text-button" :disabled="working || busy || captureActive" @click="restart">Start a fresh attempt</button>
        <p v-if="audioLoading" role="status">Loading the original recording…</p>
        <p v-if="authenticAudio && audioTransient && audioReady && !captureActive" class="help-text" role="status">Ready to play now. This audio could not be saved offline; stay online or free browser storage.</p>
        <p v-if="audioError" class="error" role="alert">{{ audioError }}
          <button class="text-button" :disabled="audioLoading || captureActive" @click="retryAudio">Retry original audio</button>
        </p>
        <p v-if="authenticAudio && !playbackRange" role="status" class="help-text">
          The original recording has no valid timing for this selection.
          <button v-if="sentence >= 0" class="text-button" :disabled="captureActive" @click="selectSentence(-1)">Return to full passage</button>
        </p>
        <div ref="listeningMedia" @error.capture="audioPlaybackFailed" @ratechange.capture="observePlaybackRate" @play.capture="observePlaybackRate"><AudioPlayer
          v-if="audioReady && !captureActive"
          :key="sid + ':' + sentence + ':' + draft.phrase + ':' + draft.lookupId"
          ref="player"
          :src="audioSrc"
          :text="audioText"
          :synthetic="syntheticPlayback"
          :start-seconds="playbackRange?.startSeconds"
          :end-seconds="playbackRange?.endSeconds"
          :label="audioLabel"
          @played="heard"
          @ended="ended"
        /></div>
        <div v-if="stage === 0" class="response-area">
          <h3>How much did you catch?</h3>
          <div class="choice-row">
            <button
              v-for="n in [0, 25, 50, 75, 100]"
              :key="n"
              :class="{ selected: estimate === n }"
              :aria-pressed="estimate === n"
              :disabled="locked || working"
              @click="estimate = n"
            >
              {{ n === 100 ? "90%+" : n + "%" }}
            </button>
          </div>
          <label for="meaning">{{ material.question }}</label
          ><textarea
            id="meaning"
            v-model="answer"
            :readonly="locked"
            rows="3"
            placeholder="Tell us the main idea. English or Chinese is fine."
          />
          <p class="help-text">
            {{
              app.keySet
                ? "AI checks the meaning, details and misunderstandings."
                : "Without AI, compare your answer with the reviewed key and reflect honestly."
            }}
          </p>
          <button
            class="button primary"
            :disabled="!listened || !answer.trim() || busy || working"
            @click="check()"
          >
            {{ busy ? "Checking meaning…" : "Check my understanding"
            }}<Icon name="arrow" :size="16" /></button
          ><button v-if="busy" class="text-button" @click="cancel">
            Cancel
          </button>
          <button v-if="draft.first && !busy" class="text-button" :disabled="working" @click="check(true)">
            Continue with local self-check
          </button>
        </div>
        <div v-if="stage === 1" class="response-area">
          <span class="eyebrow">THE MAIN IDEA</span>
          <p class="answer-key">{{ material.answer }}</p>
          <p v-if="feedback">{{ feedback.summary }}</p>
          <div v-if="!feedback">
            <p class="muted">
              Compare this with your original response. This is self-reflection,
              not an objective score.
            </p>
            <div class="choice-row">
              <button
                v-for="item in [
                  { v: 0, t: 'Missed it' },
                  { v: 0.5, t: 'Some details' },
                  { v: 1, t: 'Main idea + details' },
                ]"
                :key="item.v"
                :class="{ selected: selfCheck === item.v }"
                :disabled="(selfCheck !== null && selfCheck !== item.v) || working"
                @click="markSelf(item.v)"
              >
                {{ item.t }}
              </button>
            </div>
          </div>
          <button class="button primary" :disabled="working" @click="reveal">
            Reveal English transcript <Icon name="arrow" :size="16" />
          </button>
        </div>
        <div v-if="stage >= 2" class="response-area">
          <div class="row between">
            <h3>Notice the sounds between the words.</h3>
            <button
              class="text-button"
              :aria-pressed="chunked"
              @click="toggleChunks"
            >
              {{ chunked ? "Plain text" : "Show phrase breaks" }}
            </button>
          </div>
          <div class="transcript">
            <button
              v-for="(line, index) in material.sentences"
              :key="index"
              :class="{ current: sentence === index }"
              @click="selectSentence(index)"
            >
              <span>{{ String(index + 1).padStart(2, "0") }}</span
              >{{ line
              }}<Icon name="volume" :size="15" />
            </button>
          </div>
          <div v-if="sentence >= 0" class="sentence-practice">
            <p class="help-text">Play this sentence at normal speed, switch the speed control to 0.85×, then return to 1×. Repeats are supported practice, not new independent evidence.</p>
            <button class="text-button" :disabled="!!wordLookup" :aria-pressed="repeating" @click="repeating = !repeating">
              {{ repeating ? "Stop sentence loop" : "Loop this sentence" }}
            </button>
            <div v-if="chunked" class="choice-row" aria-label="Phrase practice">
              <button
                v-for="(phrase, index) in phrases" :key="index" class="text-button"
                :aria-pressed="draft.phrase === index" @click="selectPhrase(index)">{{ phrase }}</button>
              <button class="text-button" @click="selectPhrase(-1)">Whole sentence</button>
            </div>
            <p v-if="chunked" class="help-text">Phrase buttons select synthesized phrase demonstrations, not slices of the original recording. A local voice or configured TTS is required.</p>
            <h3>Explore any word in this sentence.</h3>
            <div class="row wrap word-strip" aria-label="Words in selected sentence">
              <button
                v-for="(word, index) in sentenceWords" :key="index" class="button secondary"
                :aria-label="'Look up ' + word" :aria-pressed="normalized(wordLookup?.expression || '') === normalized(word)"
                :disabled="working" @click="selectWord(word)">{{ word }}</button>
            </div>
            <form class="mt" @submit.prevent="selectWord(lookupInput)">
              <label for="word-expression">Word or expression</label>
              <div class="row wrap">
                <input id="word-expression" v-model="lookupInput" maxlength="200" placeholder="Or enter a phrase from this sentence" />
                <button class="button secondary" type="submit" :disabled="!lookupInput.trim() || working">Look up expression</button>
              </div>
            </form>
            <section v-if="wordLookup" class="panel mt word-lookup" aria-label="Word lookup">
              <div class="row between">
                <h3>{{ wordLookup.expression }}</h3>
                <button class="text-button" @click="closeLookup">Return to sentence audio</button>
              </div>
              <p class="help-text">The player above now pronounces this word or phrase as synthetic speech. Press Play audio, or explicitly choose its local-device-voice fallback. Selecting a word does not send a request.</p>
              <button class="button secondary" :disabled="working" @click="pronounceWord">Play / pause word pronunciation</button>
              <p class="help-text">
                {{ wordLookup.origin === "ai" ? "AI draft · verify this contextual explanation before adding it." :
                  wordLookup.origin === "material" ? "Saved material entry · supported study." :
                    wordLookup.origin === "saved" ? "From your saved entries · supported study." : "Your local candidate · enter a meaning, or request AI help." }}
                {{ wordLookup.edited ? "You edited this candidate." : "" }}
                Looking up a word does not demonstrate independent recall.
              </p>
              <p class="muted">Source sentence: {{ wordLookup.sourceSentence }}</p>
              <p v-if="wordLookup.candidate.meaningEn"><strong>Meaning:</strong> {{ wordLookup.candidate.meaningEn }}</p>
              <p v-if="wordLookup.candidate.example"><strong>{{ wordLookup.origin === "manual" && !wordLookup.edited ? "Source example:" : "Example:" }}</strong> {{ wordLookup.candidate.example }}</p>
              <button
                v-if="app.settings.chineseHelp && wordLookup.candidate.meaningZh" class="text-button"
                :aria-pressed="wordLookup.chineseShown" @click="toggleLookupChinese">{{ wordLookup.chineseShown ? "Hide Chinese meaning" : "Show Chinese meaning" }}</button>
              <p v-if="app.settings.chineseHelp && wordLookup.chineseShown" lang="zh">{{ wordLookup.candidate.meaningZh }}</p>
              <div v-if="relatedChunks.length" class="row wrap" aria-label="Related saved expressions">
                <span class="muted">This word also appears in:</span>
                <button
                  v-for="entry in relatedChunks" :key="entry.text" class="text-button"
                  :disabled="working" @click="selectWord(entry.text)">{{ entry.text }}</button>
              </div>
              <p v-if="!app.keySet" class="help-text">No AI key is configured. Saved entries and your own definitions work locally. <RouterLink to="/settings">Connect AI in Settings</RouterLink> for other contextual meanings; no external dictionary is contacted.</p>
              <p v-else-if="!app.online" class="help-text">You are offline. Keep this local candidate and use saved meanings; AI lookup is available when you reconnect.</p>
              <p v-else class="help-text">Only an explicit request sends this expression and this one source sentence to your configured AI provider. No learning history is included.</p>
              <div class="row wrap">
                <button class="button secondary" :disabled="!app.keySet || !app.online || lookupBusy || working" @click="explainWord">
                  {{ lookupBusy ? "Looking up meaning…" : "Explain meaning with AI" }}
                </button>
                <button v-if="lookupBusy" class="text-button" @click="cancelLookup">Cancel lookup</button>
              </div>
              <p v-if="lookupError" class="error" role="alert">{{ lookupError }}</p>
              <details class="mt">
                <summary>Edit or supply a local meaning and example</summary>
                <label for="lookup-meaning">English meaning</label>
                <textarea
                  id="lookup-meaning" v-model="wordLookup.candidate.meaningEn" rows="2" maxlength="500"
                  :disabled="lookupBusy || working" @input="markLookupEdited" />
                <template v-if="app.settings.chineseHelp">
                  <label for="lookup-zh">Optional Chinese meaning</label>
                  <input id="lookup-zh" v-model="wordLookup.candidate.meaningZh" maxlength="500" :disabled="lookupBusy || working" @input="markLookupEdited" />
                </template>
                <label for="lookup-example">Example sentence</label>
                <textarea
                  id="lookup-example" v-model="wordLookup.candidate.example" rows="2" maxlength="600"
                  :disabled="lookupBusy || working" @input="markLookupEdited" />
              </details>
              <button class="button primary mt" :disabled="!canAddLookup" @click="addLookupToReview">
                {{ wordLookup.chunkId ? "Added to Review" : "Add lookup to Review" }}
              </button>
            </section>
          </div>
          <button class="text-button" @click="selectSentence(-1)">
            Replay full passage</button
          ><button
            v-if="material.translation && app.settings.chineseHelp"
            class="text-button"
            @click="toggleChinese"
          >
            {{ chinese ? "Hide Chinese" : "Reveal Chinese" }}
          </button>
          <p v-if="chinese && app.settings.chineseHelp" lang="zh" class="translation">
            {{ material.translation }}
          </p>
          <h3 class="mt">Which expressions need another listen?</h3>
          <div
            v-for="chunk in material.chunks"
            :key="chunk.text"
            class="gap-row"
          >
            <div>
              <strong>{{ chunk.text }}</strong
              ><small>{{ chunk.meaningEn }}</small>
            </div>
            <button class="text-button" @click="capture(chunk.text, true)">
              Know it · missed the sound</button
            ><button class="text-button" @click="capture(chunk.text, false)">
              New to me
            </button>
          </div>
          <details class="shadow-box">
            <summary>Shadow a sentence · record & compare</summary>
            <p class="help-text">
              Listen, repeat with similar rhythm, then compare the recordings.
              No phoneme score is inferred.
            </p>
            <Recorder
              :saved-audio-id="savedAudioId"
              :disabled="working || busy || pronunciationActive"
              label="Shadowing practice"
              @active="shadowCaptureActive = $event"
              @recorded="recorded"
            />
          </details>
          <PronunciationPractice
            :reference="pronunciationReference" :saved-audio-id="pronunciationAudioId"
            :saved-reference-id="pronunciationReferenceId" :pending-attempt="pronunciationAttempt"
            :recovered-results="pronunciationResults"
            :persist-attempt="pronunciation.persistAttempt" :disabled="pronunciationDisabled || working || busy || shadowCaptureActive"
            @recorded="pronunciation.recorded" @evaluated="pronunciation.evaluated" @active="pronunciationActive = $event" />
          <p v-if="pronunciationProblem" class="error" role="alert">{{ pronunciationProblem }}</p>
          <button class="text-button" :disabled="pronunciationLoading || captureActive" @click="pronunciation.retry">Reload reviewed pronunciation reference / recover saved evidence</button>
          <button class="button primary wide" :disabled="working || busy || captureActive" @click="finish">
            Continue to active recall <Icon name="arrow" :size="17" />
          </button>
        </div>
        <p v-if="error && stage === 0" class="error" role="alert">{{ error }}</p>
        <div v-if="error && stage === 0" class="row">
          <button class="text-button" :disabled="working" @click="check()">Retry</button
          ><RouterLink to="/settings">Change model</RouterLink>
        </div>
      </section>
      <aside class="practice-note">
        <Icon name="listen" :size="26" />
        <h3>Hearing is a skill of its own.</h3>
        <p>
          You can recognize a word on the page and still miss it in a sentence.
          We keep those two kinds of evidence separate.
        </p>
        <hr />
        <span class="eyebrow">A USEFUL RHYTHM</span>
        <p>
          Normal → 0.85× → normal.<br />Use slower audio to notice, then return
          to a natural pace.
        </p>
        <span class="keyboard-hint">Space to play · ← → sentence</span>
      </aside>
    </div>
    <div v-else-if="!hydrating" class="empty-state">
      <Icon name="listen" :size="40" />
      <h2>Choose something worth listening to.</h2>
      <RouterLink to="/library" class="button primary"
        >Open your library</RouterLink
      >
    </div>
  </div>
</template>
