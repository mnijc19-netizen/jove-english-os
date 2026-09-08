import { expect, test, type Page } from "@playwright/test";
import { demoMaterials } from "../../src/content/materials";
import type { DailyPlan, MaterialChunk, StudyEvent, StudySession } from "../../src/domain/types";

async function open(page: Page, route: string) {
  await page.goto("#/" + route);
  await expect(page.locator("h1")).toBeVisible();
}
async function rows<T>(page: Page, table: string): Promise<T[]> {
  return page.evaluate(async (name) => new Promise<T[]>((resolve, reject) => {
    const request = indexedDB.open("jove-english-os");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction(name).objectStore(name).getAll();
      read.onsuccess = () => { resolve(read.result); database.close(); };
      read.onerror = () => { reject(read.error); database.close(); };
    };
  }), table);
}
async function attempt(page: Page, materialId = demoMaterials[0]!.id) {
  const sessions = await rows<StudySession>(page, "sessions");
  const pointer = sessions.find(s => s.id === "listen-active:" + materialId);
  return sessions.find(s => s.id === pointer?.draft.activeSessionId);
}
async function startAndPause(page: Page) {
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  await expect.poll(() => page.locator(".audio-player audio").evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause audio", exact: true }).click();
}
async function finishAudio(page: Page) {
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  // Accelerated real media playback; do not fake the component's ended event.
  await page.locator(".audio-player audio").evaluate((a: HTMLAudioElement) => { a.playbackRate = 16; });
  await expect.poll(() => page.locator(".audio-player audio").evaluate((a: HTMLAudioElement) => a.ended)).toBe(true);
}
async function reveal(page: Page) {
  await startAndPause(page);
  await page.locator("#meaning").fill("The speaker is delayed and suggests a backup meeting place.");
  await page.getByRole("button", { name: "Check my understanding", exact: true }).click();
  await page.getByRole("button", { name: "Main idea + details", exact: true }).click();
  await page.getByRole("button", { name: "Reveal English transcript", exact: true }).click();
  await expect(page.locator(".transcript")).toBeVisible();
}

test("attempt pointer resumes drafts and fresh repeats preserve original evidence and provenance", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await open(page, "listen?material=cafe-delay&task=review-test-listen");
  await expect(page.locator("#meaning")).toBeVisible();
  await startAndPause(page);
  await startAndPause(page);
  await page.locator("#meaning").fill("A late bus; meet at the cafe, or the bakery if full.");
  await expect.poll(async () => (await attempt(page))?.draft.answer).toBe("A late bus; meet at the cafe, or the bakery if full.");
  const original = (await attempt(page))!;
  expect(original.draft.taskId).toBe("review-test-listen");
  await page.reload();
  await expect(page.locator("#meaning")).toHaveValue(String(original.draft.answer));
  expect((await attempt(page))?.id).toBe(original.id);
  expect((await attempt(page))?.startedAt).toBe(original.startedAt);
  await page.getByRole("button", { name: "Check my understanding", exact: true }).click();
  await page.getByRole("button", { name: "Main idea + details", exact: true }).click();
  await page.getByRole("button", { name: "Reveal English transcript", exact: true }).click();
  await page.getByRole("button", { name: "Reveal Chinese", exact: true }).click();
  await page.getByRole("button", { name: "Hide Chinese", exact: true }).click();
  await expect.poll(async () => (await attempt(page))?.draft.chineseUsed).toBe(true);
  const before = (await rows<StudyEvent>(page, "events")).filter(e => e.sessionId === original.id);
  const first = before.find(e => e.type === "LISTEN_ATTEMPT")!;
  expect(first.data).toMatchObject({ replay: true, firstPass: false, synthetic: true, transcriptRevealed: false, chineseUsed: false });
  expect(first.skill).not.toBe("naturalListening");
  expect(before.find(e => e.type === "COMPREHENSION_RESPONSE")?.prompted).toBe(true);
  await page.getByRole("button", { name: "Start a fresh attempt", exact: true }).click();
  await expect(page.locator("#meaning")).toHaveValue("");
  const repeated = (await attempt(page))!;
  expect(repeated.id).not.toBe(original.id);
  expect(repeated.draft.priorExposure).toBe(true);
  expect(repeated.draft.playCount).toBe(0);
  expect(repeated.draft.chineseUsed).toBe(false);
  const after = (await rows<StudyEvent>(page, "events")).filter(e => e.sessionId === original.id);
  expect(after).toEqual(before);
  await page.reload();
  await expect(page.locator("#meaning")).toHaveValue("");
  expect((await attempt(page))?.id).toBe(repeated.id);
  expect(errors).toEqual([]);
});

test("sentence WAV selection, real slow playback, ended-driven loop and phrase fallback", async ({ page }) => {
  await open(page, "listen?material=cafe-delay");
  await reveal(page);
  await page.locator(".transcript button").nth(1).click();
  await expect(page.locator(".audio-player audio")).toHaveAttribute("src", /cafe-delay-1\.wav$/);
  await page.getByRole("button", { name: "Change playback speed", exact: true }).click();
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  await expect.poll(() => page.locator(".audio-player audio").evaluate((a: HTMLAudioElement) => a.playbackRate)).toBe(0.85);
  await page.getByRole("button", { name: "Pause audio", exact: true }).click();
  await page.getByRole("button", { name: "Change playback speed", exact: true }).click();
  await expect.poll(() => page.locator(".audio-player audio").evaluate((a: HTMLAudioElement) => a.playbackRate)).toBe(1);
  const count = Number((await attempt(page))!.draft.playCount);
  await page.getByRole("button", { name: "Loop this sentence", exact: true }).click();
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  await page.locator(".audio-player audio").evaluate((a: HTMLAudioElement) => { a.playbackRate = 16; });
  await expect.poll(async () => Number((await attempt(page))?.draft.playCount)).toBeGreaterThan(count + 1);
  await page.getByRole("button", { name: "Stop sentence loop", exact: true }).click();
  await page.getByRole("button", { name: "Show phrase breaks", exact: true }).click();
  await page.getByLabel("Phrase practice").getByRole("button").first().click();
  await expect(page.locator(".audio-label")).toContainText("Synthesized phrase demonstration");
  await expect(page.locator(".audio-player audio")).toHaveCount(0);
});

test("route changes isolate draft hydration and preserve task/material identity", async ({ page }) => {
  await open(page, "listen?material=cafe-delay&task=listen-a");
  await page.locator("#meaning").fill("Cafe draft A");
  await expect.poll(async () => (await attempt(page))?.draft.answer).toBe("Cafe draft A");
  const idA = (await attempt(page))!.id;
  await page.evaluate(() => { location.hash = "/listen?material=notification-reset&task=listen-b"; });
  await expect(page.locator("#meaning")).toHaveValue("");
  await page.locator("#meaning").fill("Phone draft B");
  await expect.poll(async () => (await attempt(page, "notification-reset"))?.draft.answer).toBe("Phone draft B");
  await page.evaluate(() => { location.hash = "/listen?material=missing-material"; });
  await expect(page.getByRole("heading", { name: "Choose something worth listening to." })).toBeVisible();
  await page.evaluate(() => { location.hash = "/listen?material=cafe-delay&task=listen-a"; });
  await expect(page.locator("#meaning")).toHaveValue("Cafe draft A");
  expect((await attempt(page))?.id).toBe(idA);
  expect((await attempt(page, "notification-reset"))?.draft.taskId).toBe("listen-b");
  await page.evaluate(() => { location.hash = "/listen?material=cafe-delay&task=listen-a"; });
  await expect(page.locator("#meaning")).toHaveValue("Cafe draft A");
  expect((await attempt(page))?.id).toBe(idA);
  await expect.poll(async () => (await attempt(page, "notification-reset"))?.draft.answer).toBe("Phone draft B");
});

test("resuming an unanswered attempt counts exposure acquired in the baseline", async ({ page }) => {
  await open(page, "listen?material=cafe-delay");
  await expect(page.locator("#meaning")).toBeVisible();
  const first = (await attempt(page))!;
  expect(first.draft.priorExposure).toBe(false);
  await open(page, "onboarding");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await startAndPause(page);
  await open(page, "listen?material=cafe-delay");
  await expect(page.getByTestId("attempt-status")).toContainText("prior exposure recorded");
  await page.locator("#meaning").fill("Now I have already heard this in the baseline.");
  await expect.poll(async () => (await attempt(page))?.draft.priorExposure).toBe(true);
  expect((await attempt(page))?.id).toBe(first.id);
});

test("imported audio without timestamps uses labeled sentence synthesis, never the full clip", async ({ page }) => {
  await open(page, "today");
  await page.evaluate(async (demo) => {
    const blob = await (await fetch("audio/cafe-delay.wav")).blob();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("jove-english-os");
      request.onsuccess = () => {
        const database = request.result, tx = database.transaction(["materials", "audio"], "readwrite");
        tx.objectStore("audio").put({ id: "import-test-audio", blob, mimeType: "audio/wav", createdAt: Date.now(), duration: 22, kind: "import", processed: false, label: "Test import" });
        tx.objectStore("materials").put({ ...demo, id: "import-test", sourceKind: "audio", audioPath: undefined, audioId: "import-test-audio", synthetic: false, sourceLabel: "User import; transcript not aligned" });
        tx.oncomplete = () => { database.close(); resolve(); };
        tx.onerror = () => { database.close(); reject(tx.error); };
      };
    });
  }, demoMaterials[0]!);
  await open(page, "listen?material=import-test");
  await page.reload();
  await expect(page.locator(".audio-player audio")).toHaveAttribute("src", /^blob:/);
  await reveal(page);
  await page.locator(".transcript button").first().click();
  await expect(page.locator(".audio-label")).toContainText("Synthesized sentence demonstration");
  await expect(page.locator(".audio-label")).toContainText("not a segment");
  await expect(page.locator(".audio-player audio")).toHaveCount(0);
  await page.getByRole("button", { name: "Replay full passage", exact: true }).click();
  await expect(page.locator(".audio-player audio")).toHaveAttribute("src", /^blob:/);
  await page.evaluate(() => { location.hash = "/listen?material=cafe-delay"; });
  await expect(page.locator(".audio-player audio")).toHaveAttribute("src", /audio\/cafe-delay\.wav$/);
});

test("diagnostic needs ended playback, persists balanced choices, and locks first wrong response", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await open(page, "onboarding");
  await page.getByLabel("What should we call you?").fill("Baseline learner");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await startAndPause(page);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await finishAudio(page);
  await expect(page.getByRole("radio")).toHaveCount(3);
  const session = (await rows<StudySession>(page, "sessions")).find(s => s.id === "onboarding")!;
  const ids = session.draft.clipIds as string[];
  expect(ids).toEqual(["cafe-delay", "notification-reset", "team-demo"]);
  const options = session.draft.options as Record<string, string[]>;
  const positions = ids.map(id => options[id]!.indexOf(demoMaterials.find(m => m.id === id)!.answer));
  expect(new Set(positions).size).toBe(3);
  for (const id of ids) for (const option of options[id]!) {
    expect(option.split(" ").length).toBeGreaterThan(16);
    expect(option).not.toMatch(/competitive sport|cooking a meal/);
  }
  const wrong = options[ids[0]!]!.find(x => x !== demoMaterials[0]!.answer)!;
  await page.getByRole("radio", { name: wrong, exact: true }).check();
  await expect.poll(async () => ((await rows<StudySession>(page, "sessions")).find(s => s.id === "onboarding")!.draft.answers as Record<string, {choice:string}>)["cafe-delay"]?.choice).toBe(wrong);
  await page.reload();
  await expect(page.getByRole("radio", { name: wrong, exact: true })).toBeChecked();
  const restored = (await rows<StudySession>(page, "sessions")).find(s => s.id === "onboarding")!;
  expect(restored.startedAt).toBe(session.startedAt);
  expect(restored.draft.options).toEqual(options);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("LISTENING SAMPLE 2 OF 3", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("radio", { name: wrong, exact: true })).toBeChecked();
  for (const radio of await page.getByRole("radio").all()) await expect(radio).toBeDisabled();
  const first = (await rows<StudyEvent>(page, "events")).find(e => e.id === "diagnostic-listen-cafe-delay")!;
  expect(first.score).toBe(0);
  expect(first.skill).toBe("listeningSentences");
  expect(first.prompted).toBe(true);
  expect(first.data).toMatchObject({ synthetic: true, multipleChoice: true, audioEnded: true, replay: true, response: wrong });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  expect((await rows<StudyEvent>(page, "events")).find(e => e.id === first.id)).toEqual(first);
  expect(errors).toEqual([]);
});

test("storage failure retains a baseline draft and exposes recovery without hydration overwrite", async ({ page }) => {
  await open(page, "onboarding");
  await page.getByLabel("What should we call you?").fill("Before storage fault");
  await expect.poll(async () => (await rows<StudySession>(page, "sessions")).find(s => s.id === "onboarding")?.draft.name).toBe("Before storage fault");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    Object.assign(window, { restoreBaselineStorage: () => { IDBObjectStore.prototype.put = original; } });
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "sessions") throw new DOMException("Test quota fault", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await page.getByLabel("What should we call you?").fill("Draft survives quota fault");
  await expect(page.getByRole("alert")).toContainText("Could not save");
  await expect(page.getByLabel("What should we call you?")).toHaveValue("Draft survives quota fault");
  await page.evaluate(() => (window as unknown as {restoreBaselineStorage:()=>void}).restoreBaselineStorage());
  await page.getByRole("button", { name: "Retry saving / loading", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("What should we call you?")).toHaveValue("Draft survives quota fault");
});

test("pending listening evidence survives a failed write, reload and idempotent retry", async ({ page }) => {
  await open(page, "listen?material=cafe-delay");
  await startAndPause(page);
  await page.locator("#meaning").fill("My original answer survives a failed evidence write.");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    Object.assign(window, { restoreEventStorage: () => { IDBObjectStore.prototype.add = original; } });
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore["add"]>) {
      if (this.name === "events") throw new DOMException("Test event write fault", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "Check my understanding", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be saved");
  const failed = (await attempt(page))!;
  expect((failed.draft.first as { answer: string }).answer).toBe("My original answer survives a failed evidence write.");
  expect((failed.draft.outbox as StudyEvent[]).some(e => e.type === "LISTEN_ATTEMPT")).toBe(true);
  await expect(page.locator("#meaning")).toHaveAttribute("readonly", "");
  await page.reload(); // Restores native IndexedDB methods; persisted outbox is retried.
  await expect(page.locator("#meaning")).toHaveValue("My original answer survives a failed evidence write.");
  await expect.poll(async () => (await rows<StudyEvent>(page, "events")).filter(e => e.id === failed.id + "-first-estimate").length).toBe(1);
  const first = (await rows<StudyEvent>(page, "events")).find(e => e.id === failed.id + "-first-estimate");
  await page.getByRole("button", { name: "Check my understanding", exact: true }).click();
  await expect(page.locator(".answer-key")).toBeVisible();
  expect((await rows<StudyEvent>(page, "events")).find(e => e.id === first!.id)).toEqual(first);
});

test("completion starts the exact next assignment and retains the original listening attempt", async ({ page }) => {
  await open(page, "today");
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("jove-english-os");
      request.onsuccess = () => {
        const database = request.result, date = new Date().toLocaleDateString("en-CA");
        const tx = database.transaction("plans", "readwrite");
        tx.objectStore("plans").put({
          id: date, date, minutes: 8, focus: "listeningSentences", evidenceFingerprint: "test-assignment", createdAt: Date.now(),
          tasks: [{ id: "pinned-listen-cafe", kind: "listen", materialId: "cafe-delay", title: "Pinned listening assignment", minutes: 8, reason: "Test route identity", done: false }],
        });
        tx.oncomplete = () => { database.close(); resolve(); };
        tx.onerror = () => { database.close(); reject(tx.error); };
      };
    });
  });
  await open(page, "listen?material=cafe-delay&task=pinned-listen-cafe");
  await page.reload();
  await reveal(page);
  const source = (await attempt(page))!;
  const before = (await rows<DailyPlan>(page, "plans")).find(plan => plan.tasks.some(task => task.id === "pinned-listen-cafe"))!;
  const index = before.tasks.findIndex(task => task.id === "pinned-listen-cafe");
  const next = [...before.tasks.slice(index + 1), ...before.tasks.slice(0, index)]
    .find(task => !task.done && task.minutes > 0)!;
  expect(next.kind).toBe("learn");
  const sourceEvents = (await rows<StudyEvent>(page, "events")).filter(event => event.sessionId === source.id);
  expect(sourceEvents.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Continue to active recall", exact: true }).click();
  await expect.poll(() => {
    const [path, query] = new URL(page.url()).hash.split("?");
    const params = new URLSearchParams(query);
    return { path, task: params.get("task"), material: params.get("material"), mode: params.get("mode") };
  }).toEqual({ path: "#/learn", task: next.id, material: next.materialId, mode: next.id.endsWith(":reading") ? "reading" : "chunks" });
  const events = await rows<StudyEvent>(page, "events");
  const completion = events.find(e => e.id === "completed:pinned-listen-cafe");
  expect(completion?.data).toMatchObject({ taskId: "pinned-listen-cafe", materialId: "cafe-delay", kind: "listen" });
  expect(events.find(event => event.id === `started:${next.id}`)?.data).toMatchObject({ taskId: next.id, materialId: next.materialId });
  for (const event of sourceEvents) expect(events.find(saved => saved.id === event.id)).toEqual(event);
  const saved = (await attempt(page))!;
  expect(saved).toMatchObject({ id: source.id, materialId: "cafe-delay", draft: { taskId: "pinned-listen-cafe" } });
  expect(saved.draft.first).toEqual(source.draft.first);
  expect(saved.completedAt).toBeGreaterThan(0);
  const persistedNext = (await rows<DailyPlan>(page, "plans")).find(plan => plan.id === before.id)!.tasks.find(task => task.id === next.id)!;
  expect(persistedNext).toMatchObject({ id: next.id, materialId: next.materialId, done: false });
});

test("optional listening retains the source-session recall route without creating extra assigned work", async ({ page }) => {
  await open(page, "today");
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("jove-english-os");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result, date = new Date().toLocaleDateString("en-CA");
      const tx = database.transaction("plans", "readwrite");
      tx.objectStore("plans").put({ id: date, date, minutes: 150, focus: "listeningSentences", evidenceFingerprint: "completed-budget", createdAt: Date.now(),
        tasks: [{ id: "completed-optional-baseline", kind: "listen", materialId: "cafe-delay", title: "Completed assigned work", minutes: 150, reason: "Optional practice baseline", done: true }] });
      tx.oncomplete = () => { database.close(); resolve(); };
      tx.onerror = () => { database.close(); reject(tx.error); };
    };
  }));
  await open(page, "listen?material=cafe-delay");
  await page.reload(); await reveal(page);
  const source = (await attempt(page))!;
  expect(source.draft.taskId ?? "").toBe("");
  const before = await rows<DailyPlan>(page, "plans");
  await page.getByRole("button", { name: "Continue to active recall", exact: true }).click();
  await expect.poll(() => {
    const [path, query] = new URL(page.url()).hash.split("?"), params = new URLSearchParams(query);
    return { path, material: params.get("material"), sourceSession: params.get("sourceSession"), task: params.get("task") };
  }).toEqual({ path: "#/learn", material: "cafe-delay", sourceSession: source.id, task: null });
  expect((await attempt(page))?.id).toBe(source.id);
  expect((await attempt(page))?.completedAt).toBeGreaterThan(0);
  expect((await rows<StudyEvent>(page, "events")).filter(event => ["TASK_STARTED", "TASK_COMPLETED"].includes(event.type))).toEqual([]);
  expect(await rows<DailyPlan>(page, "plans")).toEqual(before);
});

test("complete baseline retains objective first responses and records an audio-only sample without a score", async ({ page }) => {
  await open(page, "onboarding");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  for (const id of ["cafe-delay", "notification-reset", "team-demo"]) {
    await finishAudio(page);
    await page.getByRole("radio", { name: demoMaterials.find(m => m.id === id)!.answer, exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  for (const meaning of ["understand or solve something", "the answer changes with the situation", "be expected to do something"]) {
    await page.getByRole("radio", { name: meaning, exact: true }).check();
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  for (const radio of await page.getByRole("radio").all()) await expect(radio).toBeDisabled();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // Exercise Recorder's save callback with Playwright's fake media device; no hardware claim.
  await expect(page.locator("#baseline-speech")).toBeVisible();
  await expect(page.locator(".onboarding-card")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "Record response", exact: true }).click();
  await expect(page.locator(".recorder .record-status")).toContainText(/[1-9]\d*s \/ 180s/);
  await page.getByRole("button", { name: "Stop & save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Record again", exact: true })).toBeEnabled();
  await expect.poll(async () => (await rows<StudySession>(page, "sessions")).find(s => s.id === "onboarding")?.draft.audioId).toBeTruthy();
  const savedAudioId = String((await rows<StudySession>(page, "sessions")).find(s => s.id === "onboarding")!.draft.audioId);
  const asset = (await rows<{ id: string; kind: string; duration: number }>(page, "audio")).find(a => a.id === savedAudioId);
  expect(asset?.kind).toBe("recording");
  expect(asset?.duration).toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator("#baseline-speech")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Record again", exact: true })).toBeVisible();
  await expect(page.locator(".recorder audio")).toHaveAttribute("src", /^blob:/);
  expect((await rows<StudySession>(page, "sessions")).find(s => s.id === "onboarding")?.draft.audioId).toBe(savedAudioId);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("radio", { name: "Because it started raining.", exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  for (const radio of await page.getByRole("radio").all()) await expect(radio).toBeDisabled();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Build my daily practice", exact: true }).click();
  await expect(page).toHaveURL(/today/);
  const events = await rows<StudyEvent>(page, "events");
  expect(events.filter(e => e.type === "DIAGNOSTIC_LISTEN")).toHaveLength(3);
  expect(events.some(e => e.skill === "naturalListening")).toBe(false);
  const sample = events.find(e => e.id === "diagnostic-speaking")!;
  expect(sample.source).toBe("acoustic");
  expect(sample.score).toBeUndefined();
  expect(sample.data).toMatchObject({ audioId: savedAudioId, audioRecorded: true, response: "", scoreNotInferred: true });
});

test("word lookup supports every sentence token, local candidates and Review without duplicate players", async ({ page }) => {
  await open(page, "listen?material=cafe-delay");
  const appOrigin = new URL(page.url()).origin;
  const external: string[] = [];
  page.on("request", request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== appOrigin) external.push(request.url());
  });
  await reveal(page);
  await page.locator(".transcript button").first().click();
  await expect(page.locator(".transcript button")).toHaveCount(demoMaterials[0]!.sentences.length);
  await expect(page.locator(".transcript button button")).toHaveCount(0);
  const words = page.getByLabel("Words in selected sentence");
  await words.getByRole("button", { name: "Look up bus", exact: true }).click();
  const lookup = page.getByRole("region", { name: "Word lookup", exact: true });
  await expect(lookup).toContainText("No AI key is configured");
  await expect(lookup.getByRole("button", { name: "Explain meaning with AI", exact: true })).toBeDisabled();
  await expect(page.locator(".audio-player")).toHaveCount(1);
  await expect(page.locator(".audio-label")).toContainText("Word / phrase pronunciation: “bus”");
  await expect(page.locator(".audio-player")).toContainText("Synthetic speech");
  await expect(page.getByRole("button", { name: "Play audio", exact: true })).toHaveCount(1);
  await expect(lookup.getByRole("button", { name: "Add lookup to Review", exact: true })).toBeDisabled();
  await lookup.locator("summary").click();
  await lookup.getByLabel("English meaning", { exact: true }).fill("A large road vehicle carrying passengers.");
  await lookup.getByLabel("Example sentence", { exact: true }).fill("The bus stops outside the cafe.");
  await expect.poll(async () => ((await attempt(page))?.draft.lookups as { candidate: MaterialChunk }[])?.[0]?.candidate.meaningEn).toBe("A large road vehicle carrying passengers.");
  await page.reload();
  await expect(lookup).toContainText("A large road vehicle carrying passengers.");
  await lookup.getByRole("button", { name: "Add lookup to Review", exact: true }).click();
  await expect(lookup.getByRole("button", { name: "Added to Review", exact: true })).toBeDisabled();
  const saved = (await rows<{ id: string; text: string }>(page, "chunks")).find(c => c.text === "bus")!;
  expect(saved).toBeTruthy();
  const cards = (await rows<{ chunkId: string; modality: string }>(page, "cards")).filter(c => c.chunkId === saved.id);
  expect(cards.map(c => c.modality).sort()).toEqual(["cloze", "listening", "recognition", "recall", "speaking", "transfer"].sort());
  const lookupEvents = (await rows<StudyEvent>(page, "events")).filter(e => e.data?.expression === "bus");
  expect(lookupEvents).toHaveLength(1);
  expect(lookupEvents[0]).toMatchObject({ type: "CHUNK_LOOKUP", prompted: true, source: "text", chunkId: saved.id });
  expect(lookupEvents[0]!.score).toBeUndefined();
  expect(lookupEvents[0]!.skill).toBeUndefined();
  await lookup.getByRole("button", { name: "Return to sentence audio", exact: true }).click();
  await expect(page.locator(".audio-player audio")).toHaveAttribute("src", /cafe-delay-0\.wav$/);
  await words.getByRole("button", { name: "Look up way", exact: true }).click();
  await page.getByLabel("Related saved expressions").getByRole("button", { name: "on my way", exact: true }).click();
  await expect(lookup).toContainText(demoMaterials[0]!.chunks[0]!.meaningEn);
  await expect(lookup.getByText(demoMaterials[0]!.chunks[0]!.meaningZh, { exact: true })).toHaveCount(0);
  await lookup.getByRole("button", { name: "Show Chinese meaning", exact: true }).click();
  await expect(lookup.getByText(demoMaterials[0]!.chunks[0]!.meaningZh, { exact: true })).toBeVisible();
  await expect.poll(async () => (await attempt(page))?.draft.chineseUsed).toBe(true);
  expect(external).toEqual([]);
});

async function lookupSettings(page: Page, ai: boolean, chineseHelp: boolean) {
  await page.evaluate(async ({ enabled, chinese }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("jove-english-os");
    request.onsuccess = () => {
      const database = request.result, tx = database.transaction(["settings", "secrets"], "readwrite");
      const get = tx.objectStore("settings").get("main");
      get.onsuccess = () => tx.objectStore("settings").put({ id: "main", value: {
        ...get.result.value, chineseHelp: chinese,
        ...(enabled ? { fastModel: "test/lookup", strongModel: "test/lookup" } : {}),
      } });
      if (enabled) tx.objectStore("secrets").put({ id: "openrouter", value: "test-lookup-placeholder-not-a-real-key" });
      tx.oncomplete = () => { database.close(); resolve(); };
      tx.onerror = () => { database.close(); reject(tx.error); };
    };
  }), { enabled: ai, chinese: chineseHelp });
  await page.reload();
}

test("word lookup makes only explicit contextual AI requests and keeps escaped supported candidates", async ({ page }) => {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const candidate: MaterialChunk = { text: "bus", meaningEn: "A vehicle carrying passengers. <img src=x onerror=alert(1)>", meaningZh: "公交车", example: "We caught the bus outside the cafe." };
  await page.route("https://openrouter.ai/api/v1/**", async route => {
    if (new URL(route.request().url()).pathname.endsWith("/models")) {
      const text = new URL(route.request().url()).searchParams.get("output_modalities") === "text";
      await route.fulfill({ json: { data: text ? [{ id: "test/lookup", name: "Lookup test fixture",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["structured_outputs"], supported_voices: [] }] : [] } });
    } else if (route.request().url().endsWith("/chat/completions")) {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ json: { model: "test/lookup", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(candidate) } }], usage: { total_tokens: 12, cost: 0 } } });
    } else await route.abort();
  });
  await open(page, "listen?material=cafe-delay");
  await reveal(page);
  await lookupSettings(page, true, true);
  await page.locator(".transcript button").first().click();
  await page.getByLabel("Words in selected sentence").getByRole("button", { name: "Look up bus", exact: true }).click();
  const lookup = page.getByRole("region", { name: "Word lookup", exact: true });
  expect(requests).toHaveLength(0);
  await lookup.getByRole("button", { name: "Explain meaning with AI", exact: true }).click();
  await expect(lookup).toContainText(candidate.meaningEn);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0]!.messages.find(m => m.role === "user")!.content)).toEqual({
    untrustedData: { expression: "bus", sourceSentence: demoMaterials[0]!.sentences[0] },
  });
  expect(requests[0]!.messages.find(m => m.role === "system")!.content).toContain("UNTRUSTED DATA");
  await expect(lookup.locator("img")).toHaveCount(0);
  await expect.poll(async () => (await rows<StudyEvent>(page, "events")).filter(e => e.type === "CHUNK_LOOKUP" && e.data?.origin === "ai").length).toBe(1);
  const viewed = (await rows<StudyEvent>(page, "events")).find(e => e.type === "CHUNK_LOOKUP" && e.data?.origin === "ai")!;
  expect(viewed).toMatchObject({ source: "ai", prompted: true, data: { supported: true, candidateOnly: true, expression: "bus" } });
  expect(viewed.score).toBeUndefined();
  expect(await rows(page, "chunks")).toHaveLength(0);
  await page.reload();
  await expect(lookup).toContainText(candidate.meaningEn);
  expect(requests).toHaveLength(1);
  await lookup.getByRole("button", { name: "Add lookup to Review", exact: true }).click();
  await expect(lookup.getByRole("button", { name: "Added to Review", exact: true })).toBeDisabled();
  expect((await rows<StudyEvent>(page, "events")).find(e => e.id === viewed.id)).toEqual(viewed);
  expect((await rows<StudyEvent>(page, "events")).filter(e => e.data?.expression === "bus" && e.chunkId)).toHaveLength(1);
  expect(requests).toHaveLength(1);
  // Both layouts must keep the word strip and lookup card within the viewport.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("text-only baseline omits absent audio references and continues to reading", async ({ page }) => {
  await open(page, "today");
  // Seed an inactive page's starting stage, never overwrite a live component draft.
  await page.evaluate(async () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("jove-english-os");
    request.onsuccess = () => {
      const database = request.result, tx = database.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put({ id: "onboarding", kind: "diagnostic", startedAt: Date.now(), stage: "3",
        draft: { speech: "", audioId: "" } });
      tx.oncomplete = () => { database.close(); resolve(); };
      tx.onerror = () => { database.close(); reject(tx.error); };
    };
  }));
  await open(page, "onboarding");
  await page.locator("#baseline-speech").fill("Yesterday I met a friend. I want to speak English at work.");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "One small reading check.", exact: true })).toBeVisible();
  const event = (await rows<StudyEvent>(page, "events")).find(e => e.id === "diagnostic-speaking")!;
  expect(event).toMatchObject({ source: "text", data: { audioRecorded: false, scoreNotInferred: true } });
  expect(event.data).not.toHaveProperty("audioId");
  expect(event.score).toBeUndefined();
  expect(await rows(page, "audio")).toHaveLength(0);
});

test("reading exposures from Learn sessions and response events prevent a fresh-blind claim", async ({ page }) => {
  await open(page, "today");
  const cases = [
    { materialId: "cafe-delay", type: "learn-session" },
    { materialId: "notification-reset", type: "READING_RESPONSE" },
    { materialId: "shared-kitchen", type: "WRITING_RESPONSE" },
    { materialId: "lunch-order", type: "WRITTEN_RESPONSE" },
    { materialId: "train-change", type: "READING_EVALUATED" },
  ];
  await page.evaluate(async records => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("jove-english-os");
    request.onsuccess = () => {
      const database = request.result, tx = database.transaction(["sessions", "events"], "readwrite");
      for (const record of records) {
        if (record.type === "learn-session") tx.objectStore("sessions").put({
          id: "learn-draft-" + record.materialId, kind: "learn", materialId: record.materialId,
          startedAt: Date.now(), stage: "practice", draft: { rephrase: "I have read and rephrased this passage." },
        });
        else tx.objectStore("events").put({
          id: "prior-reading-" + record.materialId, type: record.type, source: "text", timestamp: Date.now(),
          data: { materialId: record.materialId, response: "I have already worked with this passage." },
        });
      }
      tx.oncomplete = () => { database.close(); resolve(); };
      tx.onerror = () => { database.close(); reject(tx.error); };
    };
  }), cases);
  await page.reload();
  for (const record of cases) {
    await open(page, "listen?material=" + record.materialId);
    await expect(page.getByTestId("attempt-status")).toContainText("prior exposure recorded");
    await expect.poll(async () => (await attempt(page, record.materialId))?.draft.priorExposure).toBe(true);
  }
  await startAndPause(page);
  await page.locator("#meaning").fill("The traveller is checking the train route and ticket.");
  await page.getByRole("button", { name: "Check my understanding", exact: true }).click();
  await expect(page.locator(".answer-key")).toBeVisible();
  const event = (await rows<StudyEvent>(page, "events")).find(e => e.type === "LISTEN_ATTEMPT")!;
  expect(event.data).toMatchObject({ priorExposure: true, firstPass: false });
  expect(event.prompted).toBe(true);
});

test("word lookup respects disabled Chinese help and recovers from a failed AI request", async ({ page }) => {
  let calls = 0;
  await page.route("https://openrouter.ai/api/v1/**", async route => {
    if (new URL(route.request().url()).pathname.endsWith("/models")) {
      const text = new URL(route.request().url()).searchParams.get("output_modalities") === "text";
      await route.fulfill({ json: { data: text ? [{ id: "test/lookup", name: "Lookup test fixture",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["structured_outputs"] }] : [] } });
    } else if (route.request().url().endsWith("/chat/completions")) {
      calls++;
      if (calls === 1) await route.fulfill({ status: 402, json: { error: { message: "Test exhausted credits" } } });
      else await route.fulfill({ json: { model: "test/lookup", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        text: "bus", meaningEn: "A vehicle carrying passengers.", meaningZh: "公交车", example: "We took the bus home.",
      }) } }], usage: { total_tokens: 12, cost: 0 } } });
    } else await route.abort();
  });
  await open(page, "listen?material=cafe-delay");
  await reveal(page);
  await lookupSettings(page, true, false);
  await expect(page.getByRole("button", { name: "Reveal Chinese", exact: true })).toHaveCount(0);
  await page.locator(".transcript button").first().click();
  await page.getByLabel("Words in selected sentence").getByRole("button", { name: "Look up bus", exact: true }).click();
  const lookup = page.getByRole("region", { name: "Word lookup", exact: true });
  await lookup.getByRole("button", { name: "Explain meaning with AI", exact: true }).click();
  await expect(lookup.getByRole("alert")).toBeVisible();
  expect((await attempt(page))?.draft.lookupId).toBeTruthy();
  expect((await rows<StudyEvent>(page, "events")).filter(e => e.data?.origin === "ai")).toHaveLength(0);
  await lookup.getByRole("button", { name: "Explain meaning with AI", exact: true }).click();
  await expect(lookup).toContainText("A vehicle carrying passengers.");
  await expect(lookup.getByRole("button", { name: "Show Chinese meaning", exact: true })).toHaveCount(0);
  await expect(lookup.getByText("公交车", { exact: true })).toHaveCount(0);
  await lookup.locator("summary").click();
  await expect(lookup.getByLabel("Optional Chinese meaning", { exact: true })).toHaveCount(0);
  expect(calls).toBe(2);
});

test("review scheduling after listening waits for the committed card state", async ({ page }) => {
  await open(page, "listen?material=cafe-delay");
  await reveal(page);
  await page.locator(".transcript button").nth(1).click();
  await startAndPause(page);
  await page.getByRole("button", { name: "Know it · missed the sound", exact: true }).first().click();
  await expect.poll(async () => (await rows(page, "chunks")).length).toBe(1);
  await page.getByRole("button", { name: "Continue to active recall", exact: true }).click();
  await expect(page).toHaveURL(/learn/);
  await open(page, "review");
  await expect(page.locator(".flashcard")).toBeVisible();
  await page.locator("#review-answer").fill("My attempt at the phrase.");
  await page.getByRole("button", { name: "Check my answer", exact: true }).click();
  await page.getByRole("button", { name: "Good Independent", exact: true }).click();
  // Clicking dispatches an asynchronous answer/evidence/scheduling transaction.
  // Assert its committed result, not a getAll() snapshot raced against that work.
  await expect.poll(async () => (await rows<{ card: { reps: number } }>(page, "cards")).some(c => c.card.reps > 0)).toBe(true);
});
