<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router';
import { useApp } from '../stores/app';
import { db } from '../db/db';
import { useRequest } from '../composables/useRequest';
import { assessReadingFit, assessmentEvaluator, comparableObservation, readingComparisonKey, readingRubric, type ReadingSavedEvidence } from '../domain/longitudinal';
import type { Material, StudySession } from '../domain/types';
import { canonical, eventOccurrenceKey } from '../sync/protocol';
import Recorder from './Recorder.vue';

const props = defineProps<{ material: Material; taskId?: string; assessmentId?: string; segmentWords?: number }>();
const emit = defineEmits<{ saved: [evidence: ReadingSavedEvidence] }>();
const app = useApp(), router = useRouter(), ai = useRequest(), lookupAI = useRequest();
const source = JSON.parse(JSON.stringify(props.material)) as Material;
const taskId = props.taskId, assessmentId = props.assessmentId;
const originalSessionId = `reading:${assessmentId ?? taskId ?? `${new Date(app.clock).toLocaleDateString('en-CA')}:${source.id}`}`;
let sessionId = originalSessionId;
const recovery = ref(false), sessionVersion = ref(0), recoveryChoices = ref<StudySession[]>([]);
const fit = assessReadingFit(source, app.profile, app.events, app.materials, app.clock);
const tokenCount = (text: string) => text.match(/\p{L}+(?:['’-]\p{L}+)*/gu)?.length ?? 0;
const draft = reactive({ passage: source.transcript, segmentWords: Math.max(40, Math.min(fit.recommendedSegmentWords, props.segmentWords ?? 250)), stage: 'ready',
  section: 0, readSections: [] as number[], checkedSections: [] as number[], unknownTokens: [] as string[],
  activeMs: 0, sectionMs: [] as number[], lookupTokens: [] as string[], response: '', submittedResponse: '', retell: '', audioId: '', audioSeconds: 0,
  feedback: '', priorExposure: true, startedAt: Date.now(), observationAt: 0, completedAt: 0,
  syncReadingConflicts: [] as string[], syncRecovery: null as Record<string, unknown> | null });
const emptyDraft = JSON.parse(JSON.stringify(draft));
function sessionBaseline(row?: StudySession) {
  if (!row) return canonical(row);
  // Projection owns this derived discovery index. Its addition/removal is not
  // a user's edit and cannot invalidate otherwise identical local source work.
  const { syncReadingConflicts: _derived, ...savedDraft } = row.draft;
  void _derived;
  return canonical({ ...row, draft: savedDraft });
}
let storedState: { version: string | undefined } = { version: undefined };
const editorId = crypto.randomUUID();
const localConflictCommitted = ref(false);
let waitingForProof = false;
const hasSavedEvidence = computed(() => {
  void sessionVersion.value;
  if (!draft.observationAt) return false;
  const proof = app.events.filter(e => e.sessionId === sessionId && e.data?.materialId === source.id
    && (e.data?.clientTimestamp ?? e.timestamp) === draft.observationAt);
  return proof.some(e => e.type === 'READING_RESPONSE' && e.data?.response === draft.submittedResponse)
    && proof.some(e => e.type === 'READING_RETELL' && (e.data?.response ?? '') === draft.retell.trim()
      && (e.data?.audioId ?? '') === draft.audioId);
});
function notifySaved() {
  if (!currentAssignment() || recovery.value || draft.stage !== 'saved') return;
  if (!hasSavedEvidence.value) { waitingForProof = true; return; }
  waitingForProof = false;
  const evaluated = savedEvaluation.value;
  emit('saved', { sessionId, materialId: source.id, observationAt: draft.observationAt,
    response: draft.submittedResponse, retell: draft.retell, ...(draft.audioId ? { audioId: draft.audioId } : {}),
    activeSeconds: readingSeconds.value, priorExposure: draft.priorExposure,
    score: evaluated?.score ?? null, evaluated: !!evaluated });
}
const loaded = ref(false), running = ref(false), saving = ref(false), saveError = ref(''), recorderActive = ref(false);
const lookupText = ref(''), lookupMeaning = ref('');
const savedEvaluation = computed(() => {
  void sessionVersion.value;
  return app.events.find(e => e.id === `${sessionId}:evaluated` && e.type === 'READING_EVALUATED' && e.source === 'ai'
    && e.sessionId === sessionId && (e.data?.clientTimestamp ?? e.timestamp) === draft.observationAt
    && e.data?.materialId === source.id && e.data?.response === draft.submittedResponse);
});
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
  const id = sessionId, kind = recovery.value ? 'reading-recovery' : 'reading';
  const baseline = storedState;
  const currentWrite = () => currentAssignment() && id === sessionId && baseline === storedState;
  const version = ++writeVersion; unsaved = true;
  localConflictCommitted.value = false;
  const write = writes.then(async () => {
    try {
      const row = { id, kind, materialId: source.id, startedAt: snapshot.startedAt,
        stage: snapshot.stage, ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}), draft: snapshot };
      // Crypto must finish before opening an IndexedDB transaction. One editor
      // lineage has one frontier, even through repeated autosaves or retries.
      const frontierId = `reading-conflict:${await eventOccurrenceKey({ id, editorId })}`;
      const sourceVersion = await eventOccurrenceKey(row);
      let conflict = false;
      await db.transaction('rw', db.sessions, async () => {
        const existing = await db.sessions.get(id);
        if (sessionBaseline(existing) !== baseline.version) {
          // Do not overwrite the remotely committed attempt. Save this exact
          // local input durably before offering an independent continuation.
          await db.sessions.put({ ...row, id: frontierId, kind: 'reading-conflict', draft: { ...snapshot,
            syncRecovery: { sourceSessionId: id, rootSessionId: originalSessionId, sourceDeviceId: `editor:${editorId}`, sourceVersion } } });
          conflict = true;
        } else await db.sessions.put(row);
      });
      // put success is not commit success: an abort must leave the CAS baseline
      // unchanged so the exact same local write can be retried.
      if (!conflict) baseline.version = sessionBaseline(row);
      if (currentWrite() && version === writeVersion) { unsaved = false; localConflictCommitted.value = conflict; }
      if (currentWrite()) saveError.value = conflict
        ? 'Another device updated this reading. Your local draft is saved separately below; continue it without replacing the other version.' : '';
      if (conflict) {
        try { await loadRecoveries(); }
        catch { if (currentWrite()) saveError.value = 'Your local draft is saved separately. Could not load its recovery action; retry saving to show it.'; }
      }
      return !conflict;
    } catch {
      if (currentWrite()) saveError.value = 'Could not save your reading. Keep this page open and retry saving.';
      return false;
    }
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
    if (taskId && !recovery.value) await app.beginTask(taskId);
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
  const word = lookupText.value, section = draft.section, sentence = parts.value[section], id = sessionId;
  if (!await persist()) return;
  const result = await lookupAI.run(signal => app.provider.lookup(word, sentence, signal));
  if (result && currentAssignment() && id === sessionId && lookupText.value === word && draft.section === section) lookupMeaning.value = result.meaningEn;
}
function checked() {
  if (!draft.checkedSections.includes(draft.section)) draft.checkedSections.push(draft.section);
  touch(); void persist();
}
async function saveWork() {
  if (!canFinish.value || !currentAssignment()) return;
  const id = sessionId, linkedTask = recovery.value ? undefined : taskId;
  const current = () => currentAssignment() && id === sessionId;
  saving.value = true; pause();
  try {
    if (!await persist() || !current()) return;
    const audio = draft.audioId ? await db.audio.get(draft.audioId) : undefined;
    if (draft.audioId && (!audio || audio.kind !== 'recording' || !audio.blob.size || audio.duration < 2)) {
      saveError.value = 'The retell recording is not saved yet. Retry saving it, or write a retell.'; return;
    }
    if (!current()) return;
    draft.submittedResponse ||= draft.response.trim();
    draft.observationAt ||= Math.max(draft.startedAt, Date.now());
    if (!await persist() || !current()) return;
    const checkedRead = draft.checkedSections.filter(i => draft.readSections.includes(i));
    const sampled = checkedRead.reduce((n, i) => n + tokenCount(parts.value[i] ?? ''), 0);
    const unknown = draft.unknownTokens.filter(id => checkedRead.includes(Number(id.split(':')[0]))).length;
    await app.evidence({ id: `${sessionId}:observation`, type: 'READING_OBSERVATION', source: 'objective', sessionId,
      timestamp: draft.observationAt, data: { materialId: source.id, ...(linkedTask ? { taskId: linkedTask } : {}),
        firstPass: !recovery.value, priorExposure: draft.priorExposure, wordsRead: wordsRead.value, activeSeconds: readingSeconds.value,
        lookupCount: draft.lookupTokens.length, wordsReadBasis: 'learner-confirmed-sections',
        ...(sampled ? { coverageMethod: 'checked-word-sample', coverageSource: 'learner-checked-recognition',
          sampledWordCount: sampled, knownWordCount: Math.max(0, sampled - unknown) } : {}) } });
    if (!current()) return;
    await app.evidence({ id: `${sessionId}:response`, type: 'READING_RESPONSE', source: 'text', sessionId, timestamp: draft.observationAt,
      data: { materialId: source.id, ...(linkedTask ? { taskId: linkedTask } : {}), response: draft.submittedResponse } });
    if (!current()) return;
    await app.evidence({ id: `${sessionId}:retell`, type: 'READING_RETELL', source: audio ? 'objective' : 'text', sessionId,
      timestamp: draft.observationAt, prompted: true,
      data: { materialId: source.id, ...(linkedTask ? { taskId: linkedTask } : {}), response: draft.retell.trim(),
        ...(audio ? { audioId: audio.id, audioObserved: true, durationSeconds: audio.duration } : {}),
        textOnly: !audio, task: 'meaning-focused retell; no spontaneous or acoustic score inferred' } });
    if (!current()) return;
    if (readingSeconds.value >= 30) await app.evidence({ id: `${sessionId}:practice`, type: 'PRACTICE_LOGGED', source: 'objective', sessionId,
      timestamp: draft.observationAt, data: { strand: 'input', activeSeconds: Math.min(7200, readingSeconds.value), materialId: source.id } });
    if (!current()) return;
    if (linkedTask) {
      await app.completeTask('learn', { taskId: linkedTask, materialId: source.id });
      // A stale/foreign task link can save practice, but cannot fabricate completion of today's assignment.
      // Name the actual activity only after the store attests that this exact learn task was completed.
      if (app.events.some(e => e.id === `completed:${taskId}` && e.type === 'TASK_COMPLETED'
        && e.data?.taskId === taskId && e.data?.kind === 'learn' && e.data?.materialId === source.id)) {
        await app.evidence({ id: `${sessionId}:completed`, type: 'TASK_COMPLETED', source: 'objective', sessionId,
          data: { kind: 'reading', taskId: linkedTask, materialId: source.id } });
      }
    }
    if (!current()) return;
    draft.stage = 'saved'; draft.completedAt = Math.max(draft.observationAt, Date.now()); if (await persist()) notifySaved();
  } catch { saveError.value = 'Could not finish saving. Your reading and response remain here; retry to finish safely.'; }
  finally { saving.value = false; }
}
async function feedback() {
  if (draft.stage !== 'saved' || !app.keySet || !app.online || ai.busy.value || savedEvaluation.value) return;
  const id = sessionId;
  if (!await persist() || !currentAssignment() || id !== sessionId) return;
  const result = await ai.run(signal => app.provider.evaluate({ kind: readingRubric.version,
    text: draft.submittedResponse, reference: draft.passage, rubric: JSON.stringify(readingRubric) }, signal));
  if (!result || !currentAssignment() || id !== sessionId) return;
  try {
    // Revalidate the durable submitted attempt after the network request. A
    // same-ID remote replacement must not acquire this response's evaluation.
    if (!await persist() || !currentAssignment() || id !== sessionId) return;
    draft.feedback = result.summary;
    const comparisonKey = readingComparisonKey({ ...source, transcript: draft.passage });
    const comparison = comparableObservation({ rubricVersion: readingRubric.version, comparisonKey: comparisonKey ?? '',
      difficulty: source.difficulty, evaluator: assessmentEvaluator(result), conditions: `without-passage:segmented-${draft.segmentWords}:checked-${draft.checkedSections.length > 0}`,
      firstPass: !recovery.value, priorExposure: draft.priorExposure, prompted: draft.lookupTokens.length > 0 });
    if (typeof result.comprehension === 'number' && Number.isFinite(result.comprehension) && result.comprehension >= 0 && result.comprehension <= 1) await app.evidence({ id: `${sessionId}:evaluated`, type: 'READING_EVALUATED', source: 'ai', sessionId,
      timestamp: draft.observationAt, skill: 'reading', score: result.comprehension, prompted: draft.lookupTokens.length > 0,
      data: { materialId: source.id, response: draft.submittedResponse, rubricVersion: readingRubric.version,
        difficulty: source.difficulty, firstPass: !recovery.value, priorExposure: draft.priorExposure,
        comparisonBasis: 'same-editorial-difficulty-length-and-complexity;not-equated-forms', feedback: result.summary,
        ...(comparison ?? {}), ...(!recovery.value && assessmentId ? { assessmentId } : {}),
        ...(!recovery.value && taskId ? { taskId } : {}) } });
    if (await persist()) notifySaved();
  } catch { saveError.value = 'Your response is saved. Feedback could not be saved; retry later.'; }
}
async function leave() {
  if (recorderActive.value || saving.value) return false;
  pause(); return await persist() || localConflictCommitted.value;
}
async function defer(reason: 'too-hard' | 'not-interested' | 'busy') {
  if (saving.value || recorderActive.value) return;
  pause();
  if (!await persist()) return;
  try {
    if (taskId && !recovery.value) await app.evidence({ id: `${sessionId}:skipped:${reason}`, type: 'TASK_SKIPPED', source: 'objective', sessionId,
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
watch(hasSavedEvidence, async ready => {
  if (!ready || !waitingForProof) return;
  const id = sessionId;
  try {
    await writes;
    const stored = await db.sessions.get(id);
    if (currentAssignment() && id === sessionId && sessionBaseline(stored) === storedState.version) notifySaved();
  } catch {
    if (currentAssignment() && id === sessionId) saveError.value = 'Could not verify your saved reading after sync. Retry saving to check the durable response before continuing.';
  }
});
onBeforeRouteLeave(leave);
onBeforeRouteUpdate(leave);
function loadSnapshot(saved?: StudySession) {
    loaded.value = false;
    waitingForProof = false;
    localConflictCommitted.value = false;
    unsaved = false;
    Object.assign(draft, JSON.parse(JSON.stringify(emptyDraft)));
    storedState = { version: sessionBaseline(saved) };
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
      if (Array.isArray(d.syncReadingConflicts)) draft.syncReadingConflicts = d.syncReadingConflicts.filter((id): id is string => typeof id === 'string');
      if (d.syncRecovery && typeof d.syncRecovery === 'object' && !Array.isArray(d.syncRecovery)) draft.syncRecovery = d.syncRecovery as Record<string, unknown>;
    }
    sessionVersion.value++;
    loaded.value = true;
}
async function loadRecoveries() {
  const sessions = await db.sessions.where('kind').anyOf('reading-conflict', 'reading-recovery').toArray();
  if (!currentAssignment()) return;
  const related = sessions.filter(row => row.materialId === source.id && row.draft.syncRecovery
    && typeof row.draft.syncRecovery === 'object' && !Array.isArray(row.draft.syncRecovery)
    && (row.draft.syncRecovery as Record<string, unknown>).rootSessionId === originalSessionId);
  recoveryChoices.value = related.filter(row => row.kind === 'reading-recovery' || !related.some(other => other.kind === 'reading-recovery'
    && (other.draft.syncRecovery as Record<string, unknown>).frontierId === row.id
    && (other.draft.syncRecovery as Record<string, unknown>).sourceVersion === (row.draft.syncRecovery as Record<string, unknown>).sourceVersion))
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
async function openRecovery(choice: StudySession) {
  if (saving.value || recorderActive.value || ai.busy.value || lookupAI.busy.value || !currentAssignment()) return;
  saving.value = true; pause();
  try {
    const saved = await persist();
    if (!currentAssignment() || !saved && !localConflictCommitted.value) return;
    const row = await db.sessions.get(choice.id), origin = row?.draft.syncRecovery as Record<string, unknown> | undefined;
    if (!currentAssignment() || !row || row.materialId !== source.id || origin?.rootSessionId !== originalSessionId) return;
    let next = row;
    if (row.kind === 'reading-conflict') {
      if (typeof origin.sourceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(origin.sourceVersion)) return;
      const id = `reading-recovery:${row.id.slice('reading-conflict:'.length)}:${origin.sourceVersion}`;
      const existing = await db.sessions.get(id);
      if (!currentAssignment()) return;
      if (existing) next = existing;
      else {
        // This is an optional new attempt at already encountered material, not a
        // replay of old reading time, evaluation, task or assessment completion.
        const resumed = { ...JSON.parse(JSON.stringify(emptyDraft)), passage: row.draft.passage ?? source.transcript,
          response: row.draft.response ?? row.draft.submittedResponse ?? '', retell: row.draft.retell ?? '',
          audioId: row.draft.audioId ?? '', audioSeconds: row.draft.audioSeconds ?? 0,
          stage: 'respond', priorExposure: true, startedAt: Date.now(),
          syncRecovery: { ...origin, frontierId: row.id } };
        next = { id, kind: 'reading-recovery', materialId: source.id, startedAt: resumed.startedAt, stage: 'respond', draft: resumed };
        await db.transaction('rw', db.sessions, async () => {
          const concurrent = await db.sessions.get(id);
          if (concurrent) next = concurrent;
          else await db.sessions.add(next);
        });
      }
    }
    if (!currentAssignment() || next.kind !== 'reading-recovery' || next.materialId !== source.id
      || (next.draft.syncRecovery as Record<string, unknown> | undefined)?.rootSessionId !== originalSessionId) return;
    sessionId = next.id; recovery.value = true; loadSnapshot(next);
    await loadRecoveries();
  } catch { saveError.value = 'Could not open the other draft. Your submitted reading and both versions remain saved.'; }
  finally { saving.value = false; }
}
onMounted(async () => {
  try {
    const saved = await db.sessions.get(sessionId);
    if (!currentAssignment()) return;
    if (saved && (saved.materialId !== source.id || saved.kind !== 'reading')) throw new Error('Reading identity mismatch');
    loadSnapshot(saved);
    if (!draft.feedback && typeof savedEvaluation.value?.data?.feedback === 'string') draft.feedback = savedEvaluation.value.data.feedback;
    if (await persist() && draft.stage === 'saved') notifySaved();
    await loadRecoveries();
    if (!currentAssignment()) return;
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
    <aside v-if="recoveryChoices.length" class="panel" aria-label="Other saved reading versions">
      <p>Another device saved a different version. Your original submission is unchanged. Continuing a draft is optional and does not repeat the assignment or check-in.</p>
      <div v-for="choice in recoveryChoices" :key="choice.id">
        <p>{{ String(choice.draft.response || choice.draft.submittedResponse || choice.draft.retell || 'Recorded retell').slice(0, 120) }}</p>
        <button class="button secondary" :disabled="saving || recorderActive || ai.busy.value || lookupAI.busy.value || choice.id === sessionId" @click="openRecovery(choice)">
          {{ choice.kind === 'reading-recovery' ? 'Open recovered practice' : 'Continue editing saved draft' }}
        </button>
      </div>
    </aside>
    <p v-if="recovery" class="help-text" role="status">Optional recovered practice. Previous reading time and feedback are not counted again; this is not a new first-pass reading or check-in.</p>
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
      <button v-if="!assessmentId || recovery" class="button primary" @click="router.push('/')">Back to today</button>
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
