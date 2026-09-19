import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import { db } from "../db/db";
import { readLanguageDay } from "../db/language-day";
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
import { externalMaterials, externalLessonCandidates } from "../content/external";
import { OpenRouterProvider } from "../ai/provider";
import { eventSchema, planSchema, profileSchema, settingsSchema } from "../db/schema";
import { useCloud } from "./cloud";
import { CloudProvider, routeProvider } from "../ai/cloud-provider";
import { flushContentHistory, prepareContentAudio, refreshContentLessons, refreshExternalCourseCatalog } from "../cloud/content";

export const useApp = defineStore("app", () => {
  const ready = ref(false),
    fatal = ref(""),
    notice = ref(""),
    keySet = ref(false);
  const providerMode = ref<'account' | 'byok'>('account');
  const contentState = ref<'idle' | 'loading' | 'ready' | 'empty' | 'offline' | 'error'>('idle');
  const catalogState = ref<'idle' | 'loading' | 'ready' | 'partial' | 'empty' | 'offline' | 'error'>('idle');
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
    const priorDate = new Date(clock.value).toLocaleDateString('en-CA');
    clock.value = Date.now();
    if (priorDate !== new Date(clock.value).toLocaleDateString('en-CA') || sharedDay.value && sharedDay.value.date !== today.value) void refreshSharedAllowance();
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
  window.addEventListener("focus", () => { tick(); void refreshSharedAllowance(); });
  document.addEventListener("visibilitychange", tick);
  const today = computed(() =>
    new Date(clock.value).toLocaleDateString("en-CA"),
  );
  const sharedDay = ref<Awaited<ReturnType<typeof readLanguageDay>>>(null);
  let sharedRefresh: Promise<void> | undefined;
  const sharedCap = computed(() => sharedDay.value ? sharedDay.value.date === today.value ? sharedDay.value.allowances.en.planCap : 0 : undefined);
  function refreshSharedAllowance() {
    if (sharedRefresh) return sharedRefresh;
    sharedRefresh = readLanguageDay(db, Date.now()).then(value => {
      if (!value || value.date === today.value) sharedDay.value = value;
    }).catch(() => { notice.value = '暂时无法核对另一种语言的今日安排；已保存的学习记录不受影响。'; })
      .finally(() => { sharedRefresh = undefined; });
    return sharedRefresh;
  }
  const plan = computed(() =>
    makePlan(
      profile.value,
      skills.value,
      cards.value,
      events.value,
      materials.value,
      plans.value.find((p) => p.date === today.value),
      clock.value,
      sharedCap.value,
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
    await refreshSharedAllowance();
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
    if (!ready.value || !cloud.configured || !cloud.userId) {
      contentController?.abort(); contentIdentity = ''; contentState.value = 'idle'; catalogState.value = 'idle'; return;
    }
    if (!online.value) { contentState.value = 'offline'; catalogState.value = 'offline'; return; }
    const key = JSON.stringify([cloud.userId, today.value, profile.value.fatigue, profile.value.interests, profile.value.onboarded]);
    if (key === contentIdentity && (contentJob || (!force && Date.now() - lastContentAttempt < 900_000))) return contentJob;
    contentController?.abort();
    const controller = new AbortController(); contentController = controller;
    contentIdentity = key; lastContentAttempt = Date.now(); contentState.value = 'loading'; catalogState.value = 'loading';
    const current = () => !controller.signal.aborted && contentController === controller && cloud.userId === JSON.parse(key)[0];
    const job = (async () => {
      let hasCatalog = false;
      try {
        // Independent delivery: the legacy clip/history route may be unavailable.
        try {
          const catalogs = await Promise.allSettled([
            refreshExternalCourseCatalog(controller.signal),
            refreshExternalCourseCatalog(controller.signal, 'voa-level2'),
          ]);
          if (!current()) return;
          const loaded = catalogs.filter(result => result.status === 'fulfilled' && result.value.length > 0).length;
          hasCatalog = loaded > 0;
          if (hasCatalog) await refresh();
          if (!current()) return;
          catalogState.value = loaded === 2 ? 'ready' : loaded ? 'partial'
            : catalogs.some(result => result.status === 'rejected') ? 'error' : 'empty';
        } catch { if (!current()) return; catalogState.value = online.value ? 'error' : 'offline'; }
        // The shared page-only directory needs no learner diagnosis. Personalized
        // legacy selection still waits for setup; never mark setup done for access.
        if (!profile.value.onboarded) { contentState.value = hasCatalog ? 'ready' : catalogState.value === 'error' ? 'error' : 'empty'; return; }
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
        if (current()) contentState.value = hasCatalog || selected.length || materials.value.some(m => m.authenticPlayback) ? 'ready' : 'empty';
      } catch { if (current()) contentState.value = hasCatalog ? 'ready' : online.value ? 'error' : 'offline'; }
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
                sharedCap.value,
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
    const budget = await readLanguageDay(db, Date.now());
    // Route hydration can resume after another tab or sync commits completion.
    // Recompute from one current database snapshot; never write a stale Pinia
    // plan over completed tasks, saved optional work or a changed daily budget.
    const task = await db.transaction('rw', [db.plans, db.profiles, db.skills, db.cards, db.events, db.materials, db.syncMeta], async () => {
      if (budget && (await db.syncMeta.get('owner'))?.value !== budget.owner) throw new Error('Learning account changed');
      const now = Date.now(), date = new Date(now).toLocaleDateString('en-CA');
      if (budget && budget.date !== date) throw new Error('Daily plan changed');
      const previous = await db.plans.get(date);
      if (previous?.tasks.find(t => t.id === taskId)?.done) return;
      const [currentProfile, currentSkills, currentCards, currentEvents, currentMaterials] = await Promise.all([
        db.profiles.get('main'), db.skills.toArray(), db.cards.toArray(), db.events.toArray(), db.materials.toArray(),
      ]);
      const current = makePlan(currentProfile ?? defaultProfile(), currentSkills, currentCards, currentEvents, currentMaterials, previous, now, budget?.allowances.en.planCap);
      const requested = current.tasks.find(t => t.id === taskId);
      if (!requested || requested.done) return;
      await db.plans.put(current);
      return requested;
    });
    try {
      if (task) await appendEvidence({ id: `started:${task.id}`, type: 'TASK_STARTED', source: 'objective',
        data: { taskId: task.id, kind: taskActivity(task) === 'reading' ? 'reading' : task.kind, ...(task.materialId ? { materialId: task.materialId } : {}) } })
    } finally { await refresh(); }
    return !!task;
  }
  async function continueAssignment(afterTaskId?: string) {
    const next = nextAssignedTask(plan.value, afterTaskId);
    if (!next) return { path: '/', query: {} };
    if (!await beginTask(next.id)) return { path: '/', query: {} };
    return taskPath(next);
  }
  async function replaceUnavailableExternalLesson(sessionId: string, materialId: string, taskId: string, signal?: AbortSignal) {
    const budget = await readLanguageDay(db, Date.now());
    let budgetExhausted = false;
    const userId = useCloud().userId, owner = (await db.syncMeta.get('owner'))?.value;
    const next = await db.transaction('rw', [db.plans, db.profiles, db.skills, db.cards, db.events, db.materials, db.sessions, db.syncMeta], async () => {
      const assertOwner = async () => {
        signal?.throwIfAborted();
        if (useCloud().userId !== userId || (await db.syncMeta.get('owner'))?.value !== owner) throw new Error('Learning account changed');
        signal?.throwIfAborted();
      };
      await assertOwner();
      const session = await db.sessions.get(sessionId), now = Date.now(), date = new Date(now).toLocaleDateString('en-CA');
      if (budget && (budget.date !== date || budget.owner !== owner)) throw new Error('Daily plan or learning account changed');
      if (!session || session.kind !== 'listen' || session.materialId !== materialId || session.completedAt
        || String(session.draft.taskId ?? '') !== taskId) throw new Error('Listening attempt changed');
      const [profile, skills, cards, events, materials, previous] = await Promise.all([
        db.profiles.get('main'), db.skills.toArray(), db.cards.toArray(), db.events.toArray(), db.materials.toArray(), db.plans.get(date),
      ]);
      if (!materials.some(m => m.id === materialId && m.externalStudy)) throw new Error('Not an external lesson');
      const current = previous ?? makePlan(profile ?? defaultProfile(), skills, cards, events, materials, undefined, now);
      const assigned = taskId ? current.tasks.find(task => task.id === taskId && task.materialId === materialId && task.kind === 'listen') : undefined;
      if (taskId && (!assigned || assigned.done || events.some(event => event.type === 'TASK_COMPLETED' && event.data?.taskId === taskId))) throw new Error('Assignment changed');
      if (assigned && !assigned.optional && budget && budget.allowances.en.remaining === 0) {
        budgetExhausted = true;
        await assertOwner();
        return { path: '/', query: {} };
      }
      const eventId = `${sessionId}:unavailable:${date}`, existing = events.find(event => event.id === eventId);
      if (assigned?.optional && existing?.data?.replacementTaskId) {
        const replacement = current.tasks.find(task => task.id === existing.data!.replacementTaskId && !task.done);
        await assertOwner();
        return replacement ? taskPath(replacement) : { path: '/', query: {} };
      }
      const report = eventSchema.parse({ id: eventId, type: 'EXTERNAL_LINK_UNAVAILABLE', source: 'self-report', timestamp: now,
        sessionId, data: { materialId, taskId, issue: 'cannot-open', playbackObserved: false } });
      const history = [...events, ...(existing ? [] : [report])];
      const target = planLongitudinal({ profile: profile ?? defaultProfile(), skills, cards, events: history, materials, now }).adjustments.targetDifficulty;
      const suitable = externalLessonCandidates(materials.filter(m => m.id !== materialId && m.difficulty <= Math.min(1, target + 0.25)), history, now);
      const publisher = materials.find(m => m.id === materialId)?.externalStudy?.publisher;
      const otherSource = suitable.filter(m => m.externalStudy?.publisher !== publisher);
      const pool = otherSource.length ? otherSource : suitable;
      if (!pool.length) return null;
      // Select without unrelated active-task bindings, then preserve every other
      // assignment exactly. Never fall back to a too-hard or synthetic lesson.
      const selected = makePlan(profile ?? defaultProfile(), skills, cards, history, pool, undefined, now).tasks.find(task => task.kind === 'listen' && task.materialId);
      if (!selected) return null;
      const replacement = { ...selected, id: `${date}:listen:${selected.materialId}:alt:${sessionId}`,
        minutes: Math.min(assigned?.minutes ?? selected.minutes, budget?.allowances.en.remaining || Infinity) };
      const required = assigned && !assigned.optional;
      const proposed = required ? { ...current, minutes: current.minutes - assigned!.minutes + replacement.minutes,
        tasks: current.tasks.flatMap(task => task.id === taskId ? [{ ...task, optional: true }, replacement] : [task]) } : current;
      if (proposed.tasks.length > 100) return null;
      // These fixed non-scoring facts change no skill/card projection. Keep the
      // report, assignment and start marker atomic; never complete the old task.
      await assertOwner();
      if (!existing) await db.events.add(eventSchema.parse({ ...report, data: { ...report.data, ...(required ? { replacementTaskId: replacement.id } : {}) } }));
      if (required) {
        await db.plans.put(planSchema.parse(proposed));
        const startedId = `started:${replacement.id}`;
        if (!await db.events.get(startedId)) await db.events.add(eventSchema.parse({ id: startedId, type: 'TASK_STARTED', source: 'objective',
          timestamp: now, data: { taskId: replacement.id, kind: 'listen', materialId: replacement.materialId! } }));
      }
      await assertOwner();
      return required ? taskPath(replacement) : { path: '/listen', query: { material: replacement.materialId! } };
    });
    await refresh();
    if (budgetExhausted) notice.value = '今天两种语言共用的计划时间已用完。原草稿和录音已保留，没有新增必做任务。';
    return next;
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
    sharedDay,
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
    replaceUnavailableExternalLesson,
    provider,
    generatedSpeech,
    contentState,
    catalogState,
    loadContent,
  };
});
