import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { db } from "../db/db";
import { initialize, recordEvent } from "../db/repository";
import { makePlan } from "../domain/engine";
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
import { OpenRouterProvider } from "../ai/provider";
import { profileSchema, settingsSchema } from "../db/schema";

export const useApp = defineStore("app", () => {
  const ready = ref(false),
    fatal = ref(""),
    notice = ref(""),
    keySet = ref(false);
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
  });
  window.addEventListener("offline", () => {
    online.value = false;
  });
  const clock = ref(Date.now());
  const tick = () => {
    clock.value = Date.now();
    const messages = provider.takeNotices();
    if (messages.length)
      notice.value = messages
        .map((m) =>
          m.kind === "model-fallback"
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
      (u) => new Date(u.timestamp).toLocaleDateString("en-CA") === today.value,
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
      await initialize(demoMaterials);
      await refresh();
      ready.value = true;
    } catch {
      fatal.value =
        "Your browser could not open the local learning database. Allow site storage, then reload. Your existing data has not been reset.";
    }
  }
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
                { ...previous, tasks: previous.tasks.filter((t) => t.done) },
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
  async function evidence(
    event: Omit<StudyEvent, "id" | "timestamp"> & {
      id?: string;
      timestamp?: number;
    },
  ) {
    // UI retries reuse an operation ID; the original first-attempt evidence stays immutable.
    if (event.id && (await db.events.get(event.id))) return;
    await recordEvent({
      ...event,
      id: event.id ?? crypto.randomUUID(),
      timestamp: event.timestamp ?? Date.now(),
    });
    await refresh();
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
    if (!plan.value.tasks.some((t) => t.id === taskId)) return;
    await db.plans.put(JSON.parse(JSON.stringify(plan.value)));
    plans.value = await db.plans.toArray();
  }
  async function completeTask(
    kind: string,
    identity: { taskId?: string; materialId?: string } = {},
  ) {
    const p = structuredClone(
      JSON.parse(JSON.stringify(plan.value)),
    ) as DailyPlan;
    const eligible = p.tasks.filter((t) => t.kind === kind && !t.done);
    const task = identity.taskId
      ? eligible.find((t) => t.id === identity.taskId)
      : identity.materialId
        ? eligible.find((t) => t.materialId === identity.materialId)
        : eligible.length === 1
          ? eligible[0]
          : undefined;
    if (task) {
      task.done = true;
      await db.plans.put(p);
      await evidence({
        type: "TASK_COMPLETED",
        source: "objective",
        id: "completed:" + task.id,
        data: {
          kind,
          minutes: task.minutes,
          taskId: task.id,
          ...(task.materialId ? { materialId: task.materialId } : {}),
        },
      });
    }
  }
  const provider = new OpenRouterProvider({
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
  return {
    ready,
    fatal,
    notice,
    keySet,
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
    provider,
    generatedSpeech,
  };
});
