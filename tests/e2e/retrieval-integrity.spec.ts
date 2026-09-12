import { test, expect, type Page } from "@playwright/test";
import { createEmptyCard } from "ts-fsrs";
import { demoMaterials } from "../../src/content/materials";
import { defaultSettings, type Chunk, type Modality, type ReviewCard, type StudyEvent, type StudySession, type DailyPlan } from "../../src/domain/types";
import type { ReviewAttempt } from "../../src/sync/review";

// Fresh browser contexts and a completely intercepted provider: no real keys or paid calls.
async function open(page: Page, route: string) {
  await page.goto("#/" + route);
  await expect(page.locator("h1")).toBeVisible();
}
async function records<T>(page: Page, table: string): Promise<T[]> {
  return page.evaluate(name => new Promise<T[]>((resolve, reject) => {
    const request = indexedDB.open("jove-english-os");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction(name).objectStore(name).getAll();
      read.onsuccess = () => { resolve(read.result); db.close(); };
      read.onerror = () => { reject(read.error); db.close(); };
    };
  }), table);
}
async function put(page: Page, table: string, rows: unknown[]) {
  await page.evaluate(({ table, rows }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("jove-english-os");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(table, "readwrite");
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
      for (const row of rows) tx.objectStore(table).put(row);
    };
  }), { table, rows });
}
const firstMaterial = demoMaterials[0]!;
const secondMaterial = demoMaterials[1]!;
const summary = "Feedback for the submitted first answer, not later edits.";
async function delayedEvaluation(page: Page) {
  const requests: Record<string, unknown>[] = [];
  const transcriptions: Record<string, unknown>[] = [];
  const transcript = "Could you explain the next step so I can make a clear plan?";
  let release!: () => void;
  let releaseSTT!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sttGate = new Promise<void>(resolve => { releaseSTT = resolve; });
  await page.route("https://openrouter.ai/api/v1/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/models")) {
      await route.fulfill({ json: { data: url.searchParams.get("output_modalities") === "text" ? [{
        id: "test/retrieval", name: "Test retrieval model",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["structured_outputs"],
      }] : url.searchParams.get("output_modalities") === "transcription" ? [{
        id: "test/transcription", name: "Test transcription model",
        architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] },
      }] : [] } });
    } else if (url.pathname.endsWith("/key")) {
      await route.fulfill({ json: { data: {} } });
    } else if (url.pathname.endsWith("/audio/transcriptions")) {
      transcriptions.push(route.request().postDataJSON());
      await sttGate;
      await route.fulfill({ json: { text: transcript } });
    } else if (url.pathname.endsWith("/chat/completions")) {
      requests.push(route.request().postDataJSON());
      await gate;
      await route.fulfill({ json: {
        model: "test/retrieval",
        choices: [{ message: { content: JSON.stringify({
          summary, strengths: [], errors: [], comprehension: 0.75, accuracy: 0.8,
          fluency: null, successfulChunks: [], nextPrompt: "Try a different situation.",
        }) }, finish_reason: "stop" }],
        usage: { total_tokens: 20, cost: 0 },
      } });
    } else await route.abort();
  });
  await open(page, `learn?material=${firstMaterial.id}&task=integrity-task-a`);
  await put(page, "settings", [{ id: "main", value: {
    ...defaultSettings, fastModel: "test/retrieval", strongModel: "test/retrieval", sttModel: "test/transcription",
  } }]);
  await put(page, "secrets", [{ id: "openrouter", value: "test-key-not-real" }, { id: "provider-mode", value: "byok" }]);
  await page.reload();
  await expect(page.locator("#rephrase")).toBeEnabled();
  return { requests, release, transcriptions, transcript, releaseSTT };
}
async function reviewFixture(page: Page) {
  await open(page, "review");
  const expression = firstMaterial.chunks[0]!;
  const chunk: Chunk = {
    id: "integrity-chunk", text: expression.text, meaningEn: expression.meaningEn, meaningZh: expression.meaningZh,
    sourceSentence: expression.example, examples: [expression.example], register: "neutral", sourceIds: [firstMaterial.id],
    readingStrength: 0, listeningStrength: 0, recallStrength: 0, productionStrength: 0,
    spontaneousUses: 0, createdAt: Date.now() - 60_000,
  };
  const modalities: Modality[] = ["recognition", "listening", "recall", "cloze", "speaking", "transfer"];
  const cards: ReviewCard[] = modalities.map(modality => ({
    id: `integrity-${modality}`, chunkId: chunk.id, modality, contextIds: [],
    card: createEmptyCard(new Date(Date.now() - 60_000)),
  }));
  await put(page, "chunks", [chunk]);
  await put(page, "cards", cards);
  await page.reload();
  await expect(page.locator("#review-answer")).toBeEnabled();
  return { chunk, cards };
}
async function selectReview(page: Page, modality: Modality) {
  await page.getByRole("combobox", { name: "Practice type" }).selectOption(modality);
  await expect(page.locator(".flashcard .pill")).toHaveText(modality);
  await expect(page.locator("#review-answer")).toBeEnabled();
}
async function draft(page: Page, id: string) {
  return (await records<StudySession>(page, "sessions")).find(row => row.id === id);
}
async function reviewItem(page: Page, cardId: string): Promise<ReviewAttempt> {
  const filter = await page.getByRole("combobox", { name: "Practice type" }).inputValue();
  const read = async () => {
    const block = (await records<StudySession>(page, "sessions"))
      .find(row => row.id.startsWith("review-block:") && row.id.endsWith(":" + filter));
    return (block?.draft.items as ReviewAttempt[] | undefined)?.find(item => item.cardId === cardId);
  };
  await expect.poll(read).toMatchObject({ cardId, draftId: expect.any(String), attemptId: expect.any(String), responseEventId: expect.any(String) });
  return (await read())!;
}
const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

test("Learn delayed evaluation scores the submitted text, never a later edit", async ({ page }) => {
  const mock = await delayedEvaluation(page);
  const original = "They change their meeting time and arrange a clear next step.";
  const edited = "This is my different, unevaluated draft about another subject.";
  try {
    await page.getByText("Read and rephrase · supporting reading and writing", { exact: true }).click();
    await page.locator("#rephrase").fill(original);
    await page.getByRole("button", { name: "Save & check my rephrasing" }).click();
    await expect.poll(() => mock.requests.length).toBe(1);
    expect(JSON.stringify(mock.requests[0])).toContain(original);
    expect(JSON.stringify(mock.requests[0])).toContain(firstMaterial.transcript);
    await page.locator("#rephrase").fill(edited);
    mock.release();
    await expect.poll(async () => (await records<StudyEvent>(page, "events")).filter(e => e.type.endsWith("_EVALUATED")).length).toBe(2);
    const events = await records<StudyEvent>(page, "events");
    const raw = events.find(e => e.type === "WRITTEN_RESPONSE")!;
    expect(raw).toMatchObject({ source: "text", sessionId: `learn-draft-${firstMaterial.id}`, data: { response: original, taskId: "integrity-task-a" } });
    for (const event of events.filter(e => e.type.endsWith("_EVALUATED"))) {
      expect(event).toMatchObject({ source: "ai", sessionId: raw.sessionId, data: {
        response: original, materialId: firstMaterial.id, taskId: "integrity-task-a", submissionId: raw.id,
      } });
    }
    expect(events.find(e => e.type === "WRITING_EVALUATED")).toMatchObject({ skill: "writing", prompted: true, score: 0.8 });
    expect(events.find(e => e.type === "READING_EVALUATED")).toMatchObject({ skill: "reading", score: 0.75 });
    await expect.poll(async () => (await draft(page, raw.sessionId!))?.draft.rephrase).toBe(edited);
    await expect(page.getByText(summary, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#rephrase")).toHaveValue(edited);
    expect((await draft(page, raw.sessionId!))?.draft.writingFeedback).not.toBe(summary);
  } finally { mock.release(); }
});

test("Learn delayed evaluation keeps the original material, session and task after navigation", async ({ page }) => {
  const mock = await delayedEvaluation(page);
  const original = "The first conversation changes the meeting time with a friend.";
  const next = "Notifications can wait until after I finish my work.";
  try {
    await page.getByText("Read and rephrase · supporting reading and writing", { exact: true }).click();
    await page.locator("#rephrase").fill(original);
    await page.getByRole("button", { name: "Save & check my rephrasing" }).click();
    await expect.poll(() => mock.requests.length).toBe(1);
    // Change the route without unmounting Learn or cancelling its in-flight request.
    await page.evaluate(id => { location.hash = `#/learn?material=${id}&task=integrity-task-b`; }, secondMaterial.id);
    await expect(page.locator(".section-title").first()).toContainText(secondMaterial.title);
    await expect(page.locator("#rephrase")).toHaveValue("");
    // Material changes close the reading section so each newly shown transcript is disclosed.
    await expect(page.locator("details")).not.toHaveAttribute("open");
    await page.getByText("Read and rephrase · supporting reading and writing", { exact: true }).click();
    await page.locator("#rephrase").fill(next);
    mock.release();
    await expect.poll(async () => (await records<StudyEvent>(page, "events")).filter(e => e.type.endsWith("_EVALUATED")).length).toBe(2);
    const events = await records<StudyEvent>(page, "events");
    for (const event of events.filter(e => e.type.endsWith("_EVALUATED"))) {
      expect(event).toMatchObject({ sessionId: `learn-draft-${firstMaterial.id}`, data: {
        response: original, materialId: firstMaterial.id, taskId: "integrity-task-a",
      } });
    }
    expect(events.some(e => e.data?.response === next)).toBe(false);
    await expect.poll(async () => (await draft(page, `learn-draft-${secondMaterial.id}`))?.draft.rephrase).toBe(next);
    await expect(page.getByText(summary, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Use these in conversation" })).toBeDisabled();
  } finally { mock.release(); }
});

test("Transfer context excludes normalized sibling-card and event history and persists its selection", async ({ page }) => {
  const { chunk, cards } = await reviewFixture(page);
  await selectReview(page, "transfer");
  const attempt = await reviewItem(page, "integrity-transfer");
  const draftId = attempt.draftId;
  const first = (await page.locator(".context-prompt").innerText()).trim();
  await expect.poll(async () => (await draft(page, draftId))?.draft.context).toBe(first);
  const sibling = cards.find(card => card.modality === "speaking")!;
  sibling.contextIds = ["  " + first.toUpperCase().replace(/ /g, "  ") + "  "];
  await put(page, "cards", [sibling]);
  await page.reload();
  await selectReview(page, "transfer");
  const second = (await page.locator(".context-prompt").innerText()).trim();
  expect(normalize(second)).not.toBe(normalize(first));
  await put(page, "events", [{ id: "integrity-context-history", type: "CONTEXT_EXPOSURE", timestamp: Date.now(),
    source: "text", chunkId: chunk.id, modality: "cloze", contextId: second.toUpperCase(),
  } satisfies StudyEvent]);
  await page.reload();
  await selectReview(page, "transfer");
  const third = (await page.locator(".context-prompt").innerText()).trim();
  expect([normalize(first), normalize(second)]).not.toContain(normalize(third));
  await expect.poll(async () => (await draft(page, draftId))?.draft.context).toBe(third);
  await page.reload();
  await selectReview(page, "transfer");
  await expect(page.locator(".context-prompt")).toHaveText(third);
  await expect(page.locator(".context-reuse-note")).toHaveCount(0);
  await page.locator("#review-answer").fill("Could you explain the next step so I can make a plan?");
  await page.getByRole("button", { name: "Check my answer" }).click();
  await page.getByRole("button", { name: "Good Independent", exact: true }).click();
  await expect.poll(async () => (await records<StudyEvent>(page, "events")).find(e => e.id === attempt.attemptId)).toMatchObject({
    contextId: third, source: "self-report", data: { novelContext: true, audioObserved: false, transcriptVerified: false },
  });
});

test("Transfer preserves a started response's prompt and labels a subsequently reused context", async ({ page }) => {
  const { cards } = await reviewFixture(page);
  await selectReview(page, "transfer");
  const attempt = await reviewItem(page, "integrity-transfer");
  const context = (await page.locator(".context-prompt").innerText()).trim();
  const response = "Could you explain the next step so that I can make a clear plan?";
  await page.locator("#review-answer").fill(response);
  await expect.poll(async () => (await draft(page, attempt.draftId))?.draft.response).toBe(response);
  const sibling = cards.find(card => card.modality === "speaking")!;
  sibling.contextIds = [context];
  await put(page, "cards", [sibling]);
  await page.reload();
  await selectReview(page, "transfer");
  await expect(page.locator(".context-prompt")).toHaveText(context);
  await expect(page.locator("#review-answer")).toHaveValue(response);
  await expect(page.locator(".context-reuse-note")).toContainText("not new-context evidence");
  await page.getByRole("button", { name: "Check my answer" }).click();
  await page.getByRole("button", { name: "Good Independent", exact: true }).click();
  await expect.poll(async () => (await records<StudyEvent>(page, "events")).find(e => e.id === attempt.responseEventId)?.contextId).toBe(context);
  await expect.poll(async () => (await records<ReviewCard>(page, "cards")).find(c => c.id === "integrity-transfer")?.card.reps).toBe(1);
  const evidence = (await records<StudyEvent>(page, "events")).filter(e => e.modality === "transfer" && e.type !== "REVIEW_RESPONSE");
  expect(evidence.length).toBeGreaterThan(0);
  expect(evidence.every(e => e.source === "self-report")).toBe(true);
  expect(evidence.find(e => e.type === "review")?.data?.novelContext).toBe(false);
});

test("Recall strips legacy hidden context from drafts, response events and scheduling", async ({ page }) => {
  const { chunk } = await reviewFixture(page);
  const id = "review-draft:integrity-recall:0";
  // Exercise an actual pre-upgrade block plus its counter-shaped original draft.
  // New blocks use durable IDs; existing legacy selections must still reopen.
  const scope = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
  await put(page, "sessions", [{ id: `review-block:${scope}:recall`, kind: "review", startedAt: Date.now(), stage: "review",
    draft: { items: [{ cardId: "integrity-recall", reps: 0 }] },
  } satisfies StudySession, { id, kind: "review", startedAt: Date.now(), stage: "answer",
    draft: { context: "An old prompt never displayed during recall", response: "" },
  } satisfies StudySession]);
  await selectReview(page, "recall");
  await expect(page.locator(".context-prompt")).toHaveCount(0);
  await expect.poll(async () => (await draft(page, id))?.draft).toBeDefined();
  await expect.poll(async () => Object.hasOwn((await draft(page, id))!.draft, "context")).toBe(false);
  await page.locator("#review-answer").fill(chunk.text);
  await page.getByRole("button", { name: "Check my answer" }).click();
  await page.getByRole("button", { name: "Good Independent", exact: true }).click();
  await expect.poll(async () => (await records<ReviewCard>(page, "cards")).find(c => c.id === "integrity-recall")?.card.reps).toBe(1);
  const events = (await records<StudyEvent>(page, "events")).filter(e => e.modality === "recall");
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events.find(e => e.type === "REVIEW_RESPONSE")).toMatchObject({ data: { response: chunk.text } });
  expect(Object.hasOwn(events.find(e => e.type === "REVIEW_RESPONSE")!, "contextId")).toBe(false);
  // The repository uses an optional field with value undefined on its scheduling event.
  expect(events.every(e => e.contextId === undefined)).toBe(true);
  expect(events.find(e => e.type === "review")?.data?.novelContext).toBe(false);
  expect((await records<ReviewCard>(page, "cards")).find(c => c.id === "integrity-recall")?.contextIds).toEqual([]);
});

test("Empty Learn skips without completion; only saved chunk and written responses complete its assignment", async ({ page }) => {
  await open(page, "today");
  const task = page.locator('.task-row[href*="/learn?"][href*="mode=chunks"]').first();
  await expect(task).toBeVisible();
  const href = (await task.getAttribute("href"))!;
  const query = new URLSearchParams(href.split("?")[1]);
  const taskId = query.get("task")!;
  const materialId = query.get("material")!;
  expect(taskId).toMatch(/:chunks$/);
  await task.click();
  const complete = page.getByRole("button", { name: "Use these in conversation" });
  await expect(complete).toBeDisabled();
  // A draft alone is not a submitted retrieval response.
  const input = page.locator(".chunk-card textarea").first();
  await expect(input).toBeEnabled();
  await input.fill("An unsaved practice sentence is not completion evidence.");
  await expect(complete).toBeDisabled();
  const startedBeforeSkip = (await records<StudyEvent>(page, "events")).filter(event => event.type === "TASK_STARTED").map(event => event.id);
  await page.getByRole("link", { name: "Skip practice for now" }).click();
  await expect(page).toHaveURL(/#\/today$/);
  expect((await records<StudyEvent>(page, "events")).filter(event => event.type === "TASK_STARTED").map(event => event.id)).toEqual(startedBeforeSkip);
  expect((await records<StudyEvent>(page, "events")).some(e => e.type === "TASK_COMPLETED" && e.data?.kind === "learn")).toBe(false);
  expect((await records<DailyPlan>(page, "plans")).flatMap(plan => plan.tasks).find(t => t.id === taskId)?.done).toBe(false);
  await page.goto(href);
  await expect(input).toHaveValue("An unsaved practice sentence is not completion evidence.");
  const expression = demoMaterials.find(m => m.id === materialId)!.chunks[0]!.text;
  const savedResponse = `I can use ${expression} when I talk about my own plans.`;
  await input.fill(savedResponse);
  await page.getByRole("button", { name: "Save my example & practice later" }).first().click();
  await expect(complete).toBeDisabled();
  const written = "I explained the important idea in a different way for a friend.";
  await page.locator("#rephrase").fill(written);
  await expect(complete).toBeDisabled();
  await page.getByRole("button", { name: "Save & check my rephrasing" }).click();
  await expect(complete).toBeEnabled();
  const before = (await records<DailyPlan>(page, "plans")).find(plan => plan.tasks.some(task => task.id === taskId))!;
  const index = before.tasks.findIndex(task => task.id === taskId);
  const next = [...before.tasks.slice(index + 1), ...before.tasks.slice(0, index)].find(task => !task.done && task.minutes > 0)!;
  await complete.click();
  await expect.poll(() => {
    const [path, query] = new URL(page.url()).hash.split("?");
    const params = new URLSearchParams(query);
    return { path, task: params.get("task"), material: params.get("material"), mode: params.get("mode") };
  }).toEqual({ path: next.kind === "shadow" ? "#/listen" : ["repair", "retell"].includes(next.kind) ? "#/speak" : next.kind === "assessment" ? "#/progress" : `#/${next.kind}`,
    task: next.id, material: next.materialId ?? null,
    mode: next.kind === "learn" ? next.id.endsWith(":reading") ? "reading" : "chunks" : ["shadow", "repair", "retell"].includes(next.kind) ? next.kind : null });
  const events = await records<StudyEvent>(page, "events");
  const response = events.find(e => e.type === "CHUNK_RECALL" && e.data?.taskId === taskId)!;
  const completion = events.filter(e => e.type === "TASK_COMPLETED" && e.data?.kind === "learn");
  expect(response).toMatchObject({ source: "text", prompted: true, data: { response: savedResponse, materialId } });
  expect(completion).toHaveLength(1);
  expect(completion[0]).toMatchObject({ source: "objective", data: { taskId, materialId } });
  expect(completion[0]!.timestamp).toBeGreaterThanOrEqual(response.timestamp);
  const writing = events.find(event => event.type === "WRITTEN_RESPONSE" && event.data?.taskId === taskId)!;
  expect(writing).toMatchObject({ source: "text", sessionId: response.sessionId, data: { taskId, materialId, response: written } });
  expect(completion[0]!.timestamp).toBeGreaterThanOrEqual(writing.timestamp);
  const after = (await records<DailyPlan>(page, "plans")).find(plan => plan.id === before.id)!;
  for (const task of before.tasks) expect(after.tasks.find(saved => saved.id === task.id)?.done).toBe(task.id === taskId ? true : task.done);
});

test("Learn chunk pronunciation stays compact with meaning and retrieval controls intact", async ({ page, isMobile }) => {
  await open(page, `learn?material=${firstMaterial.id}`);
  const cards = page.locator(".chunk-card");
  await expect(cards).toHaveCount(firstMaterial.chunks.length);
  for (let i = 0; i < firstMaterial.chunks.length; i++) {
    const card = cards.nth(i);
    await expect(card).toContainText(firstMaterial.chunks[i]!.meaningEn);
    await expect(card.locator("textarea")).toBeEnabled();
    await expect(card.getByRole("button", { name: "Save my example & practice later" })).toBeVisible();
    const player = card.locator(".audio-player.compact");
    await expect(player).toBeVisible();
    await expect(player.locator(".audio-wave")).toBeHidden();
    await expect(player).toHaveCSS("padding-top", "12px");
    const size = await player.boundingBox();
    // Desktop's three narrower columns wrap the visible local-voice privacy help.
    expect(size!.height).toBeLessThan(isMobile ? 230 : 250);
    const play = await player.locator(".play-button").boundingBox();
    expect(play!.width).toBeGreaterThanOrEqual(44);
    expect(play!.height).toBeGreaterThanOrEqual(44);
  }
});

test("Review waits for capture and STT, keeps Stop enabled and locks recording during evaluation", async ({ page }) => {
  const mock = await delayedEvaluation(page);
  try {
    await reviewFixture(page);
    await selectReview(page, "transfer");
    const check = page.getByRole("button", { name: "Check my answer" });
    const record = page.locator(".recorder .record-button");
    const filter = page.getByRole("combobox", { name: "Practice type" });
    const good = page.getByRole("button", { name: "Good Independent", exact: true });
    const attempt = await reviewItem(page, "integrity-transfer");
    const id = attempt.draftId;
    await page.locator("#review-answer").fill("My written response must wait for the original recording.");
    await record.click();
    await expect(record).toHaveText("Stop & save");
    await expect(record).toBeEnabled();
    await expect(check).toBeDisabled();
    await expect(filter).toBeDisabled();
    await expect(page.locator(".record-status")).toContainText(/[1-9]\d*s \/ 180s/);
    await record.click();
    await expect(record).toHaveText("Record again");
    await expect(record).toBeEnabled();
    await expect(check).toBeEnabled();
    const firstAudio = (await draft(page, id))!.draft.recording;
    expect(typeof firstAudio).toBe("string");
    const savedAudioSize = await page.evaluate(audioId => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open("jove-english-os");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction("audio").objectStore("audio").get(audioId as string);
        read.onsuccess = () => { resolve(read.result?.blob?.size ?? 0); db.close(); };
        read.onerror = () => { reject(read.error); db.close(); };
      };
    }), firstAudio);
    expect(savedAudioSize).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Transcribe recording", exact: true }).click();
    await expect.poll(() => mock.transcriptions.length).toBe(1);
    await expect(check).toBeDisabled();
    await expect(filter).toBeDisabled();
    await expect(record).toBeDisabled();
    expect(mock.requests).toHaveLength(0);
    mock.releaseSTT();
    await expect(page.locator("#review-answer")).toHaveValue(mock.transcript);
    await expect(check).toBeEnabled();
    await check.click();
    await expect.poll(() => mock.requests.length).toBe(1);
    expect((await draft(page, id))?.draft).toMatchObject({ recording: firstAudio, response: mock.transcript, sttText: mock.transcript });
    expect(JSON.stringify(mock.requests[0])).toContain(mock.transcript);
    await expect(record).toBeDisabled();
    await expect(filter).toBeDisabled();
    mock.release();
    await expect(good).toBeEnabled();
    await record.click();
    await expect(record).toHaveText("Stop & save");
    await expect(record).toBeEnabled();
    await expect(good).toBeDisabled();
    await expect(page.locator(".record-status")).toContainText(/[1-9]\d*s \/ 180s/);
    await record.click();
    await expect(good).toBeEnabled();
    // A replacement recording cannot inherit the previous recording's verified transcript.
    await expect.poll(async () => (await draft(page, id))?.draft.sttText).toBe("");
    expect((await draft(page, id))?.draft.recording).not.toBe(firstAudio);
    await good.click();
    await expect.poll(async () => (await records<StudyEvent>(page, "events")).find(event => event.id === attempt.attemptId)).toMatchObject({
      source: "self-report", data: { audioObserved: false, transcriptVerified: false },
    });
  } finally { mock.releaseSTT(); mock.release(); }
});

test("Learn transcript disclosure without typing makes the next single-play Listen attempt prompted", async ({ page }) => {
  const materialId = "lunch-order";
  const material = demoMaterials.find(item => item.id === materialId)!;
  await open(page, `learn?material=${materialId}&task=reading-disclosure-task`);
  expect((await records<StudyEvent>(page, "events")).filter(event => event.type === "TRANSCRIPT_REVEALED")).toHaveLength(0);
  await page.getByText("Read and rephrase · supporting reading and writing", { exact: true }).click();
  await expect(page.locator("details > p").first()).toHaveText(material.transcript);
  await expect(page.locator("#rephrase")).toHaveValue("");
  await expect.poll(async () => (await records<StudyEvent>(page, "events")).find(event => event.type === "TRANSCRIPT_REVEALED")).toMatchObject({
    source: "objective", sessionId: `learn-draft-${materialId}`,
    data: { materialId, taskId: "reading-disclosure-task" },
  });
  expect(await draft(page, `learn-draft-${materialId}`)).toMatchObject({ kind: "learn", materialId });
  expect((await records<StudyEvent>(page, "events")).some(event => event.score !== undefined || event.type === "TASK_COMPLETED")).toBe(false);
  await expect(page.getByRole("button", { name: "Use these in conversation" })).toBeDisabled();
  // Navigate with no text input or Learn submission at all, and play the actual audio once.
  await open(page, `listen?material=${materialId}`);
  await expect(page.getByTestId("attempt-status")).toContainText("prior exposure recorded");
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  await page.locator(".audio-player audio").evaluate((audio: HTMLAudioElement) => { audio.playbackRate = 16; });
  await expect.poll(() => page.locator(".audio-player audio").evaluate((audio: HTMLAudioElement) => audio.ended)).toBe(true);
  await page.locator("#meaning").fill("The customer changes an unavailable lunch order and confirms the side and drink.");
  await page.getByRole("button", { name: "Check my understanding", exact: true }).click();
  await expect.poll(async () => (await records<StudyEvent>(page, "events")).find(event => event.type === "LISTEN_ATTEMPT")).toMatchObject({
    prompted: true, data: { materialId, priorExposure: true, firstPass: false, playbackStarts: 1, completedPlays: 1, replay: false },
  });
});
