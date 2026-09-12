import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import { db } from "../db/db";
import { initialize, recordEvent } from "../db/repository";
import { makePlan, nextAssignedTask, taskActivity, taskPath } from "../domain/engine";
import { hasTaskStarted, planLongitudinal } from "../domain/longitudinal";
import {
  defaultProfile,
  defaultSettings,
  type AudioAsset,
  type Chunk,
  type Conversation,
  type DailyPlan,
  type ErrorPattern,
  type Material,
  type Profile,
  type ReviewCard,
  type Settings,
  type Skill,
  type StudyEvent,
  type Usage,
  type Assessment,
} from "../domain/types";
import { demoMaterials } from "../content/materials";
import { externalMaterials } from "../content/external";
import { OpenRouterProvider } from "../ai/provider";
import { profileSchema, settingsSchema } from "../db/schema";
import { useCloud } from "./cloud";
import { CloudProvider, routeProvider } from "../ai/cloud-provider";
import { flushContentHistory, prepareContentAudio, refreshContentLessons } from "../cloud/content";

export const useApp = defineStore("app", () => {
  const ready = ref(false),
    fatal = ref(""),
    notice = ref(""),
    keySet = ref(false);
  const providerMode = ref<'account' | 'byok'>('account');
  const contentState = ref<'idle' | 'loading' | 'ready' | 'empty' | 'offline' | 'error'>('idle');
  let contentJob: Promise<void> | undefined, contentController: AbortController | undefined;
  let contentIdentity = '', lastContentAttempt = 0;
  const profile = ref<Profile>(defaultProfile()),
    settings = ref<Settings>({ ...defaultSettings });
  const skills = ref<Skill[]>([]),
    events = ref<StudyEvent[]>([]),
    chunks = ref<Chunk[]>([]),
    cards = ref<ReviewCard[]>([]);
  const materials = ref<Material[]>([]),
    errors = ref<ErrorPattern[]>([]),
    conversations = ref<Conversation[]>([]);
  const audio = ref<AudioAsset[]>([]),
    usage = ref<Usage[]>([]),
    assessments = ref<Assessment[]>([]),
    plans = ref<DailyPlan[]>([]);
  const online = ref(navigator.onLine);
  window.addEventListener("online", () => {
    online.value = true;
    void loadContent(true);
  });
  window.addEventListener("offline", () => {
    online.value = false;
  });
  const clock = ref(Date.now());
  const tick = () => {
    clock.value = Date.now();
    if (document.visibilityState !== 'hidden') void loadContent();
    const messages = provider.takeNotices();
    if (messages.length)
      notice.value = messages
        .map((m) =>
          m.kind === "result-cache-unconfirmed"
            ? "The received result is saved on this device. Server recovery is not confirmed; retrying the same request reuses the saved result without another AI call."
          : m.kind === "model-fallback"
            ? `A selected model was unavailable; ${m.purpose} used ${m.to}. You can change models in Settings.`
            : "The provider used validated JSON fallback for this response.",
        )
        .join(" ");
  };
  window.setInterval(tick, 15000);
  window.addEventListener("focus", tick);
  document.addEventListener("visibilitychange", tick);
  const today = computed(() =>
    new Date(clock.value).toLocaleDateString("en-CA"),
  );
  const plan = computed(() =>
    makePlan(
      profile.value,
      skills.value,
      cards.value,
      events.value,
      materials.value,
      plans.value.find((p) => p.date === today.value),
      clock.value,
    ),
  );
  const due = computed(() =>
    cards.value.filter((c) => new Date(c.card.due).getTime() <= clock.value),
  );
  const todayUsage = computed(() =>
    usage.value.filter(
      (u) => !u.purpose.startsWith('account:') && new Date(u.timestamp).toLocaleDateString("en-CA") === today.value,
    ),
  );
  const cost = computed(() =>
    todayUsage.value.reduce((s, u) => s + (u.cost ?? 0), 0),
  );
  async function refresh() {
    clock.value = Date.now();
    const results = await Promise.all([
      db.profiles.get("main"),
      db.settings.get("main"),
      db.secrets.get("openrouter"),
      db.skills.toArray(),
      db.events.toArray(),
      db.chunks.toArray(),
      db.cards.toArray(),
      db.materials.toArray(),
      db.errors.toArray(),
      db.conversations.toArray(),
      db.audio.toArray(),
      db.usage.toArray(),
      db.assessments.toArray(),
      db.plans.toArray(),
    ]);
    profile.value = results[0] ?? defaultProfile();
    settings.value = { ...defaultSettings, ...results[1]?.value };
    keySet.value = !!results[2]?.value;
    providerMode.value = (await db.secrets.get('provider-mode'))?.value === 'byok' ? 'byok' : 'account';
    skills.value = results[3];
    events.value = results[4];
    chunks.value = results[5];
    cards.value = results[6];
    materials.value = results[7];
    errors.value = results[8];
    conversations.value = results[9];
    audio.value = results[10];
    usage.value = results[11];
    assessments.value = results[12];
    plans.value = results[13];
    document.documentElement.dataset.theme =
      settings.value.theme === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : settings.value.theme;
  }
  async function init() {
    try {
      await initialize([...demoMaterials, ...externalMaterials]);
      await refresh();
      ready.value = true;
      void useCloud().start(refresh);
    } catch {
      fatal.value =
        "Your browser could not open the local learning database. Allow site storage, then reload. Your existing data has not been reset.";
    }
  }
  async function loadContent(force = false): Promise<void> {
    const cloud = useCloud();
    if (!ready.value || !profile.value.onboarded || !cloud.configured || !cloud.userId) {
      contentController?.abort(); contentIdentity = ''; contentState.value = 'idle'; return;
    }
    if (!online.value) { contentState.value = 'offline'; return; }
    const key = JSON.stringify([cloud.userId, today.value, profile.value.fatigue, profile.value.interests]);
    if (key === contentIdentity && (contentJob || (!force && Date.now() - lastContentAttempt < 900_000))) return contentJob;
    contentController?.abort();
    const controller = new AbortController(); contentController = controller;
    contentIdentity = key; lastContentAttempt = Date.now(); contentState.value = 'loading';
    const current = () => !controller.signal.aborted && contentController === controller && cloud.userId === JSON.parse(key)[0];
    const job = (async () => {
      try {
        await flushContentHistory(events.value, materials.value, controller.signal);
        const targetDifficulty = planLongitudinal({ profile: profile.value, skills: skills.value,
          cards: cards.value, events: events.value, materials: materials.value, now: Date.now() }).adjustments.targetDifficulty;
        const selected = await refreshContentLessons({ targetDifficulty, fatigue: profile.value.fatigue,
          interests: profile.value.interests.slice(0, 20), requireGeneralAmerican: targetDifficulty < 0.6 }, controller.signal);
        if (!current()) return;
        await refresh();
        // Cache only the next small practice clips. Selection never changes a begun task.
        const selectedIds = new Set(plan.value.tasks.filter(t => !t.done && ['listen', 'shadow'].includes(t.kind)).map(t => t.materialId));
        for (const material of materials.value.filter(m => selectedIds.has(m.id) && m.authenticPlayback).slice(0, 2))
          await prepareContentAudio(material, controller.signal);
        if (current()) contentState.value = selected.length || materials.value.some(m => m.authenticPlayback) ? 'ready' : 'empty';
      } catch { if (current()) contentState.value = online.value ? 'error' : 'offline'; }
      finally { if (contentController === controller) contentJob = undefined; }
    })();
    contentJob = job;
    return job;
  }
  watch(() => [ready.value, useCloud().userId, today.value, profile.value.onboarded,
    profile.value.fatigue, profile.value.interests.join('|')], () => { void loadContent(); });
  async function saveSettings(patch: Partial<Settings>) {
    try {
      const value = settingsSchema.parse(
        JSON.parse(JSON.stringify({ ...settings.value, ...patch })),
      );
      await db.settings.put({ id: "main", value });
      await refresh();
      return true;
    } catch {
      notice.value =
        "Preferences were not saved. Check the selected values and available browser storage.";
      return false;
    }
  }
  async function saveProfile(patch: Partial<Profile>) {
    try {
      const value = profileSchema.parse(
        JSON.parse(JSON.stringify({ ...profile.value, ...patch })),
      );
      await db.transaction("rw", [db.profiles, db.plans], async () => {
        await db.profiles.put(value);
        // Changed interests/goal may deliberately reassign unstarted work; keep actual completion.
        if (patch.goal !== undefined || patch.interests !== undefined) {
          const previous = await db.plans.get(today.value);
          if (previous)
            await db.plans.put(
              makePlan(
                value,
                skills.value,
                cards.value,
                events.value,
                materials.value,
                { ...previous, tasks: previous.tasks.filter((t) => t.done || t.optional || hasTaskStarted(t.id, events.value, clock.value)) },
                clock.value,
              ),
            );
        }
      });
      await refresh();
      return true;
    } catch {
      notice.value =
        "Your profile was not saved. Check the values and available browser storage.";
      return false;
    }
  }
  async function appendEvidence(
    event: Omit<StudyEvent, "id" | "timestamp"> & {
      id?: string;
      timestamp?: number;
    },
  ) {
    // UI retries reuse an operation ID; the original first-attempt evidence stays immutable.
    if (event.id && (await db.events.get(event.id))) return false;
    await recordEvent({
      ...event,
      id: event.id ?? crypto.randomUUID(),
      timestamp: event.timestamp ?? Date.now(),
    });
    return true;
  }
  async function evidence(event: Parameters<typeof appendEvidence>[0]) {
    if (await appendEvidence(event)) await refresh();
  }
  async function generatedSpeech(
    text: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const identity = JSON.stringify([
      text,
      settings.value.ttsModel,
      settings.value.voice,
      settings.value.accent,
    ]);
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(identity),
    );
    const id =
      "tts-" +
      Array.from(new Uint8Array(bytes), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    const cached = await db.audio.get(id);
    if (cached) return cached.blob;
    // Start synthesis synchronously with the same settings snapshot used by the cache key.
    // A preference change while the cache lookup was pending requires a fresh identity.
    if (
      identity !==
      JSON.stringify([
        text,
        settings.value.ttsModel,
        settings.value.voice,
        settings.value.accent,
      ])
    )
      return generatedSpeech(text, signal);
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const blob = await provider.synthesize(text, signal);
    const assets = await db.audio.toArray(),
      limit = settings.value.audioLimitMB * 1024 * 1024;
    let used = assets.reduce((n, a) => n + a.blob.size, 0);
    for (const old of assets
      .filter((a) => a.kind === "generated")
      .sort((a, b) => a.createdAt - b.createdAt)) {
      if (used + blob.size <= limit) break;
      await db.audio.delete(old.id);
      used -= old.blob.size;
    }
    if (used + blob.size <= limit)
      await db.audio.put({
        id,
        blob,
        mimeType: blob.type,
        createdAt: Date.now(),
        duration: 0,
        kind: "generated",
        processed: true,
        label: text.slice(0, 80),
      });
    return blob;
  }
  async function beginTask(taskId: string) {
    // Route hydration can resume after another tab or sync commits completion.
    // Recompute from one current database snapshot; never write a stale Pinia
    // plan over completed tasks, saved optional work or a changed daily budget.
    const task = await db.transaction('rw', [db.plans, db.profiles, db.skills, db.cards, db.events, db.materials], async () => {
      const now = Date.now(), date = new Date(now).toLocaleDateString('en-CA');
      const previous = await db.plans.get(date);
      if (previous?.tasks.find(t => t.id === taskId)?.done) return;
      const [currentProfile, currentSkills, currentCards, currentEvents, currentMaterials] = await Promise.all([
        db.profiles.get('main'), db.skills.toArray(), db.cards.toArray(), db.events.toArray(), db.materials.toArray(),
      ]);
      const current = makePlan(currentProfile ?? defaultProfile(), currentSkills, currentCards, currentEvents, currentMaterials, previous, now);
      const requested = current.tasks.find(t => t.id === taskId);
      if (!requested || requested.done) return;
      await db.plans.put(current);
      return requested;
    });
    try {
      if (task) await appendEvidence({ id: `started:${task.id}`, type: 'TASK_STARTED', source: 'objective',
        data: { taskId: task.id, kind: taskActivity(task) === 'reading' ? 'reading' : task.kind, ...(task.materialId ? { materialId: task.materialId } : {}) } })
    } finally { await refresh(); }
  }
  async function continueAssignment(afterTaskId?: string) {
    const next = nextAssignedTask(plan.value, afterTaskId);
    if (!next) return { path: '/', query: {} };
    await beginTask(next.id);
    return taskPath(next);
  }
  async function completeTask(
    kind: string,
    identity: { taskId?: string; materialId?: string; activity?: 'reading' | 'chunks' } = {},
  ) {
    const committed = await db.transaction('rw', [db.plans], async () => {
      const displayed = plan.value;
      // Completion is a change to one current assignment, not replacement of the
      // full plan that happened to be rendered before another device committed.
      const p = await db.plans.get(displayed.id) ?? JSON.parse(JSON.stringify(displayed)) as DailyPlan;
      const eligible = p.tasks.filter((t) => t.kind === kind && (!t.optional || t.id === identity.taskId) && (!t.done || t.id === identity.taskId)
        && (!identity.materialId || t.materialId === identity.materialId)
        && (!identity.activity || taskActivity(t) === identity.activity)
        // A legacy/free writing page may match a language task, never a reader.
        && (kind !== 'learn' || identity.taskId || taskActivity(t) === 'chunks'));
      const task = identity.taskId
        ? eligible.find((t) => t.id === identity.taskId)
        : identity.materialId
          ? eligible.find((t) => t.materialId === identity.materialId)
          : eligible.length === 1
            ? eligible[0]
            : undefined;
      if (task) {
        if (kind === 'learn' && task.id.endsWith(':reading')) {
          const proof = events.value.filter(e => e.data?.taskId === task.id && e.data?.materialId === task.materialId);
          if (!proof.some(e => e.type === 'READING_RESPONSE' && typeof e.data?.response === 'string' && !!e.data.response.trim()
            && proof.some(retell => retell.type === 'READING_RETELL' && retell.sessionId === e.sessionId
              && (typeof retell.data?.response === 'string' && !!retell.data.response.trim() || typeof retell.data?.audioId === 'string')))) return false;
        }
        if (kind === 'learn' && task.id.endsWith(':chunks')) {
          const proof = events.value.filter(e => e.data?.taskId === task.id && e.data?.materialId === task.materialId);
          if (!proof.some(e => e.type === 'WRITTEN_RESPONSE' && typeof e.data?.response === 'string' && !!e.data.response.trim())) return false;
          const source = materials.value.find(m => m.id === task.materialId);
          if (source?.chunks.length && !proof.some(e => e.type === 'CHUNK_RECALL' && e.chunkId
            && chunks.value.some(chunk => chunk.id === e.chunkId && chunk.sourceIds.includes(source.id)))) return false;
        }
        task.done = true;
        await db.plans.put(p);
        return task;
      }
      return null;
    });
    try {
      if (committed) await appendEvidence({
        type: "TASK_COMPLETED",
        source: "objective",
        id: "completed:" + committed.id,
        data: {
          kind: taskActivity(committed) === 'reading' ? 'reading' : kind,
          minutes: committed.minutes,
          taskId: committed.id,
          ...(committed.materialId ? { materialId: committed.materialId } : {}),
        },
      });
    } finally { await refresh(); }
    return Boolean(committed);
  }
  const localProvider = new OpenRouterProvider({
    getKey: async () => (await db.secrets.get("openrouter"))?.value ?? "",
    getSettings: () => settings.value,
    onUsage: async (u) => {
      await db.usage.put(u);
      usage.value = await db.usage.toArray();
    },
    beforeRequest: async () => {
      clock.value = Date.now();
      if (!navigator.onLine)
        throw new Error(
          "Internet required. Your work is saved; continue with local practice.",
        );
      if (cost.value >= settings.value.dailyBudget)
        throw new Error(
          "Daily budget reached. Continue local practice or adjust your budget in Settings.",
        );
    },
  });
  const provider = routeProvider(localProvider, new CloudProvider(localProvider, async (row) => {
    await db.usage.put(row);
    usage.value = await db.usage.toArray();
  }), () => useCloud().configured && providerMode.value !== "byok");
  const providerAvailable = computed(() => useCloud().configured && providerMode.value !== "byok" ? !!useCloud().userId : keySet.value);
  return {
    ready,
    fatal,
    notice,
    keySet: providerAvailable,
    browserKeySet: keySet,
    providerMode,
    online,
    clock,
    profile,
    settings,
    skills,
    events,
    chunks,
    cards,
    materials,
    errors,
    conversations,
    audio,
    usage,
    assessments,
    plan,
    due,
    cost,
    init,
    refresh,
    saveSettings,
    saveProfile,
    evidence,
    completeTask,
    beginTask,
    continueAssignment,
    provider,
    generatedSpeech,
    contentState,
    loadContent,
  };
});
