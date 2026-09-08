import { test, expect, type Page } from "@playwright/test";
import { demoMaterials } from "../../src/content/materials";

async function open(page: Page, route: string) {
  await page.goto("#/" + route);
  await expect(page.locator("h1")).toBeVisible();
}
async function records(page: Page, table: string) {
  return page.evaluate(
    (name) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const request = indexedDB.open("jove-english-os");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const read = db.transaction(name).objectStore(name).getAll();
          read.onsuccess = () => {
            resolve(read.result);
            db.close();
          };
          read.onerror = () => reject(read.error);
        };
      }),
    table,
  );
}
async function connectMock(page: Page) {
  const requests: Record<string, unknown>[] = [];
  await page.route("https://openrouter.ai/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/models")) {
      const mode = url.searchParams.get("output_modalities");
      await route.fulfill({
        json: {
          data:
            mode === "text"
              ? [
                  {
                    id: "test/text",
                    name: "Test text model",
                    architecture: {
                      input_modalities: ["text"],
                      output_modalities: ["text"],
                    },
                    supported_parameters: ["structured_outputs"],
                  },
                ]
              : [],
        },
      });
      return;
    }
    if (url.pathname.endsWith("/key")) {
      await route.fulfill({ json: { data: {} } });
      return;
    }
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.stream) {
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  content:
                    "Could you explain your next step, and ask me one question?",
                },
                finish_reason: "stop",
              },
            ],
            usage: { total_tokens: 20, cost: 0 },
          }) +
          "\n\ndata: [DONE]\n\n",
      });
      return;
    }
    const periodic = JSON.stringify(body).includes("periodic");
    const evaluation = {
      summary: "Your meaning is clear; the response addresses the task.",
      strengths: ["A relevant response."],
      errors: periodic
        ? []
        : [
            {
              category: "grammar",
              original: "Yesterday I go shopping.",
              corrected: "Yesterday I went shopping.",
              hint: "Yesterday I ___ shopping. Use a past form.",
              explanation: "The event happened in the past.",
            },
          ],
      comprehension: 0.75,
      accuracy: 0.8,
      fluency: null,
      successfulChunks: [],
      nextPrompt: "Use the idea in another situation.",
      ...(periodic
        ? {
            rubricScores: {
              vocabulary: 0.7,
              interaction: 0.75,
              taskCompletion: 0.8,
            },
          }
        : {}),
    };
    await route.fulfill({
      json: {
        model: "test/text",
        choices: [
          {
            message: { content: JSON.stringify(evaluation) },
            finish_reason: "stop",
          },
        ],
        usage: { total_tokens: 20, cost: 0 },
      },
    });
  });
  await open(page, "settings");
  await page.locator("#api-key").fill("test-key-not-real");
  await page.getByRole("button", { name: "Save key", exact: true }).click();
  await expect(page.locator("#api-key")).toHaveValue("");
  await page.getByRole("button", { name: "Refresh model list" }).click();
  await page
    .getByRole("combobox", { name: "Fast tasks" })
    .selectOption("test/text");
  await page
    .getByRole("combobox", { name: "Evaluation & analysis" })
    .selectOption("test/text");
  return requests;
}

test("import draft survives reload; approved no-key text remains safe and exportable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, "library");
  await page.getByRole("button", { name: "Add something" }).click();
  await page.locator("#material-title").fill("My work note");
  const content =
    "I need to figure out a useful plan for tomorrow. We can work together and check the details. <img src=x onerror=alert(1)> is untrusted learning text, not an instruction.";
  await page.locator("#material-text").fill(content);
  await page.reload();
  await expect(page.locator("#material-text")).toHaveValue(content);
  await page
    .getByRole("button", { name: "Prepare for review", exact: true })
    .click();
  await expect(page.locator(".candidate-preview")).toBeVisible();
  await page.reload();
  await expect(page.locator(".candidate-preview")).toContainText(content);
  await page.getByRole("button", { name: "Approve & add to library" }).click();
  expect(
    (await records(page, "materials")).find((m) => m.title === "My work note"),
  ).toMatchObject({ approved: true, difficulty: 0.4, sourceKind: "text" });
  expect(await page.locator("img[onerror]").count()).toBe(0);
  await open(page, "settings");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export backup", exact: true })
    .click();
  expect((await download).suggestedFilename()).toContain("jove-english-backup");
  expect(errors).toEqual([]);
});

test("written examples and independent review responses survive refresh and stay inspectable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const material = demoMaterials[0],
    phrase = material.chunks[0];
  await open(page, "learn?material=" + material.id);
  const input = page.locator(".chunk-card textarea").first();
  const example = `I want to ${phrase.text} what to do tomorrow.`;
  await input.fill(example);
  await page.reload();
  await expect(input).toHaveValue(example);
  await page
    .locator(".chunk-card")
    .first()
    .getByRole("button", { name: "Save my example & practice later" })
    .click();
  await expect
    .poll(async () =>
      (await records(page, "events")).some(
        (e) => (e.data as Record<string, unknown>)?.response === example,
      ),
    )
    .toBe(true);
  await open(page, "review");
  await page
    .getByRole("combobox", { name: "Practice type" })
    .selectOption("recall");
  await page.locator("#review-answer").fill(phrase.text);
  await page.reload();
  // The default mix may show another modality; returning to recall restores its independent attempt.
  await page
    .getByRole("combobox", { name: "Practice type" })
    .selectOption("recall");
  await expect(page.locator("#review-answer")).toHaveValue(phrase.text);
  await page
    .getByRole("button", { name: "Check my answer", exact: true })
    .click();
  await page.getByRole("button", { name: "Good Independent" }).click();
  await expect
    .poll(async () =>
      (await records(page, "events")).some(
        (e) =>
          e.type === "REVIEW_RESPONSE" &&
          (e.data as Record<string, unknown>)?.response === phrase.text,
      ),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});

test("periodic assessment makes real turns, sends stable rubric, survives reload, and schedules completion", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests = await connectMock(page);
  await open(page, "progress?assess=1");
  const card = page.locator(".assessment-card");
  await card.getByRole("button", { name: "Play audio", exact: true }).click();
  await card.locator("audio").evaluate((a: HTMLAudioElement) => {
    a.playbackRate = 8;
  });
  await card
    .locator("#assessment-answer")
    .fill(
      "The speaker explains the problem and agrees to a practical next step.",
    );
  await expect(
    card.getByRole("button", { name: "Save & continue", exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  await card
    .getByRole("button", { name: "Save & continue", exact: true })
    .click();
  await expect(card.locator(".eyebrow").first()).toContainText("Retell");
  await card
    .locator("#assessment-answer")
    .fill(
      "First there was a problem. They discussed the options and decided how to solve it.",
    );
  await card
    .getByRole("button", { name: "Save & continue", exact: true })
    .click();
  await expect(card.locator(".eyebrow").first()).toContainText("Conversation");
  for (const stage of ["Conversation", "Real-life task"]) {
    for (let i = 0; i < 3; i++) {
      await card
        .locator("#assessment-answer")
        .fill(
          `I would explain the problem clearly and ask for help. What would you suggest? This is response ${i + 1}.`,
        );
      await card
        .getByRole("button", { name: "Send assessment response", exact: true })
        .click();
      await expect(card.locator(".message.assistant")).toHaveCount(i + 2);
      if (i === 0) {
        await page.reload();
        await expect(card.locator(".message.user")).toHaveCount(1);
      }
    }
    await card
      .getByRole("button", {
        name: "Save & continue",
        exact: true,
      })
      .click();
    if (stage === "Conversation")
      await expect(card.locator(".eyebrow").first()).toContainText(
        "Real-life task",
      );
  }
  await expect(card.locator(".eyebrow").first()).toContainText("Reading");
  const finish = card.getByRole("button", { name: "Finish five-part check-in", exact: true });
  await expect(finish).toBeDisabled();
  expect((await records(page, "events")).filter(e => e.type === "ASSESSMENT_COMPLETED")).toHaveLength(0);
  await card.getByRole("button", { name: "Start reading", exact: true }).click();
  // Real visible reading intervals and section confirmations: no fixture writes
  // to completedAt, no injected reading evidence, and no synthetic completion.
  let confirmedSections = 0;
  for (; confirmedSections < 20;) {
    const next = card.getByRole("button", { name: /^I read this section/ });
    await expect(next).toBeEnabled();
    const last = (await next.textContent())?.includes("share the meaning");
    await next.click();
    confirmedSections++;
    if (last) break;
  }
  await expect(card.locator("#reading-response")).toBeVisible();
  const meaning = "The speaker explains a practical problem, considers the available choices and agrees on a useful next step.";
  const retell = "First they describe what happened. They compare possible solutions and choose a clear plan that works for everyone.";
  await card.locator("#reading-response").fill(meaning);
  await page.reload();
  await expect(card.locator("#reading-response")).toHaveValue(meaning);
  await expect(finish).toBeDisabled();
  await card.locator("#reading-retell").fill(retell);
  await card.getByRole("button", { name: "Save reading & retell", exact: true }).click();
  await expect(finish).toBeEnabled();
  const beforeFinish = (await records(page, "assessments"))[0];
  const readingResponse = beforeFinish.responses as Record<string, unknown>;
  expect(beforeFinish.completedAt).toBeFalsy();
  expect(readingResponse.Reading).toBe(meaning);
  expect(readingResponse.readingRetell).toBe(retell);
  const reading = (await records(page, "sessions")).find(row => row.id === readingResponse.readingSessionId);
  expect(reading).toMatchObject({ kind: "reading", stage: "saved" });
  expect(reading?.completedAt).toBeTruthy();
  expect(reading?.draft).toMatchObject({ submittedResponse: meaning, retell });
  expect((reading?.draft as { readSections: number[] }).readSections).toEqual(Array.from({ length: confirmedSections }, (_, i) => i));
  expect((await records(page, "events")).filter(e => e.type === "ASSESSMENT_COMPLETED")).toHaveLength(0);
  await finish.click();
  await expect(page.locator(".assessment-history")).toBeVisible();
  expect(
    (await records(page, "events")).filter(
      (e) => e.type === "ASSESSMENT_COMPLETED",
    ),
  ).toHaveLength(1);
  const saved = (await records(page, "assessments"))[0];
  expect(saved.completedAt).toBeTruthy();
  expect(saved.scores).toHaveProperty("Reading", null);
  expect(saved.responses).toMatchObject({ Reading: meaning, readingRetell: retell, readingSessionId: reading?.id });
  expect(JSON.stringify(saved.responses)).toContain("dialogue-3");
  expect(requests.filter((r) => r.stream)).toHaveLength(6);
  expect(JSON.stringify(requests)).toContain("anchors");
  expect(errors).toEqual([]);
});

test("conversation feedback creates delayed repairs with preserved full-sentence evidence", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await connectMock(page);
  await open(page, "speak");
  await page
    .getByRole("button", { name: "Start conversation", exact: true })
    .click();
  await page.locator("#speak-response").fill("Yesterday I go shopping.");
  await page
    .getByRole("button", { name: "Send response", exact: true })
    .click();
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  await page.getByRole("button", { name: "Finish & reflect" }).click();
  await page.getByRole("button", { name: "Practice the repairs" }).click();
  const repair = page.locator(".repair-card").first();
  await repair.locator("input").fill("Yesterday I went shopping.");
  await expect.poll(async () => (await records(page, "sessions")).find((s) => s.id === "speak-draft")?.stage).toBe("repair");
  await page.reload();
  await expect(repair.locator("input")).toHaveValue(
    "Yesterday I went shopping.",
  );
  await repair.getByRole("button", { name: "Check the full sentence" }).click();
  await expect(repair).toContainText("Full sentence repaired");
  const evidence = await records(page, "events");
  expect(
    evidence.some(
      (e) =>
        e.type === "SPEAK_RETRY" &&
        (e.data as Record<string, unknown>)?.response ===
          "Yesterday I went shopping.",
    ),
  ).toBe(true);
  const cards = await records(page, "cards");
  expect(
    cards.some(
      (c) =>
        c.errorId &&
        new Date((c.card as Record<string, string>).due).getTime() >
          Date.now() + 60000,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("open Today rolls over at local midnight without a reload", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-08T23:59:10") });
  await open(page, "today");
  await page.clock.pauseAt(new Date("2026-09-08T23:59:20"));
  await expect(page.locator(".page-heading .eyebrow")).toContainText(
    /September 8/i,
  );
  await page.clock.runFor(60000);
  await expect(page.locator(".page-heading .eyebrow")).toContainText(
    /September 9/i,
  );
});

test("unsent conversation work stays accessible instead of being hidden by finish", async ({ page }) => {
  await open(page, "speak");
  await page.getByRole("button", { name: "Start conversation", exact: true }).click();
  const answer = page.locator("#speak-response");
  await answer.fill("I am looking for a flat near my workplace.");
  await page.getByRole("button", { name: "Send response", exact: true }).click();
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  const unsent = "I also need to ask about the deposit and the lease.";
  await answer.fill(unsent);
  await expect(page.getByRole("button", { name: "Finish & reflect", exact: true })).toBeDisabled();
  await expect.poll(async () => JSON.stringify(await records(page, "sessions"))).toContain(unsent);
  await page.reload();
  await expect(answer).toHaveValue(unsent);
  await expect(page.getByRole("button", { name: "Finish & reflect", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Real-life mission", exact: true }).click();
  await expect(answer).toHaveValue(unsent);
  await page.getByRole("button", { name: "Send response", exact: true }).click();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await page.getByRole("button", { name: "Finish & reflect", exact: true }).click();
  await expect(page.locator(".evaluation")).toBeVisible();
  expect(JSON.stringify(await records(page, "conversations"))).toContain(unsent);
});

test("assessment resumes the same persisted draft after leaving its page", async ({ page }) => {
  await open(page, "progress?assess=1");
  const answer = "I heard them discuss the flat and ask for more information.";
  await page.locator("#assessment-answer").fill(answer);
  await expect.poll(async () => JSON.stringify(await records(page, "assessments"))).toContain(answer);
  const id = (await records(page, "assessments"))[0].id;
  await open(page, "today");
  await open(page, "progress");
  await page.getByRole("button", { name: /Continue check-in|Start check-in/ }).click();
  await expect(page.locator("#assessment-answer")).toHaveValue(answer);
  const saved = await records(page, "assessments");
  expect(saved).toHaveLength(1);
  expect(saved[0].id).toBe(id);
});

test("invalid settings cannot poison local storage or a later backup", async ({ page }) => {
  await open(page, "settings");
  const initial = (await records(page, "settings"))[0];
  await page.locator("#audio-limit").fill("0");
  await page.locator("#audio-limit").blur();
  await expect(page.getByText("Preferences were not saved.", { exact: false })).toBeVisible();
  expect((await records(page, "settings"))[0]).toEqual(initial);
  await page.reload();
  await expect(page.locator("#audio-limit")).not.toHaveValue("0");
});

test("conversation cannot submit or finish while its recording is not committed", async ({ page }) => {
  await open(page, "speak");
  await page.getByRole("button", { name: "Start conversation", exact: true }).click();
  await page.locator("#speak-response").fill("Could you help me find the library?");
  await page.getByRole("button", { name: "Send response", exact: true }).click();
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  const finish = page.getByRole("button", { name: "Finish & reflect", exact: true });
  await expect(finish).toBeEnabled();
  await page.getByRole("button", { name: "Record response", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop & save", exact: true })).toBeVisible();
  await expect(finish).toBeDisabled();
  await page.locator("#speak-response").fill("I will ask the librarian about membership.");
  const send = page.getByRole("button", { name: "Send response", exact: true });
  await expect(send).toBeDisabled();
  // Allow actual MediaRecorder chunks to arrive; a sub-frame start/stop can be empty.
  await expect(page.locator(".record-status")).toContainText("1s / 180s");
  await page.getByRole("button", { name: "Stop & save", exact: true }).click();
  await expect(page.locator(".recorder audio")).toBeVisible();
  await expect(send).toBeEnabled();
  expect((await records(page, "audio")).length).toBeGreaterThan(0);
  await send.click();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await expect(finish).toBeEnabled();
});
