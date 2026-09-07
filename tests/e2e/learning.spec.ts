import { expect, test, type Page } from "@playwright/test";
import { demoMaterials } from "../../src/content/materials";

async function open(page: Page, route = "today") {
  await page.goto("#/" + route);
  await expect(page.locator("h1")).toBeVisible();
}
async function rows(page: Page, table: string) {
  return page.evaluate(async (name) => {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = indexedDB.open("jove-english-os");
      request.onsuccess = () => {
        const database = request.result;
        const read = database.transaction(name).objectStore(name).getAll();
        read.onsuccess = () => {
          resolve(read.result);
          database.close();
        };
        read.onerror = () => reject(read.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, table);
}
async function play(page: Page, complete = false) {
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".audio-player audio")
        .evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeGreaterThan(0);
  if (complete) {
    // Accelerate real playback; never synthesize an ended event.
    await page
      .locator(".audio-player audio")
      .evaluate((a: HTMLAudioElement) => { a.playbackRate = 8; });
    await expect
      .poll(() =>
        page
          .locator(".audio-player audio")
          .evaluate((a: HTMLAudioElement) => a.ended),
      )
      .toBe(true);
  } else {
    await page.getByRole("button", { name: "Pause audio", exact: true }).click();
  }
}

test("first setup measures listening, vocabulary and reading, persists the profile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, "onboarding");
  await page.getByLabel("What should we call you?").fill("Practice learner");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const graded = [...demoMaterials].sort((a, b) => a.difficulty - b.difficulty);
  const samples = [
    graded[0]!,
    graded[Math.floor(graded.length / 2)]!,
    graded[graded.length - 1]!,
  ];
  for (const m of samples) {
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await play(page, true);
    await page.getByRole("radio", { name: m.answer, exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  for (const meaning of [
    "understand or solve something",
    "the answer changes with the situation",
    "be expected to do something",
  ])
    await page.getByRole("radio", { name: meaning, exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await page
    .getByRole("radio", { name: "Because it started raining." })
    .check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Build my daily practice" }).click();
  await expect(page).toHaveURL(/today/);
  await page.reload();
  await expect(
    page.getByText("Welcome back, Practice learner.", { exact: false }),
  ).toBeVisible();
  const profiles = await rows(page, "profiles");
  expect(profiles[0].onboarded).toBe(true);
  const evidence = await rows(page, "events");
  expect(evidence.filter((e) => e.type === "DIAGNOSTIC_LISTEN")).toHaveLength(
    3,
  );
  for (const event of evidence.filter((e) => e.type === "DIAGNOSTIC_LISTEN")) {
    expect(event.skill).toBe("listeningSentences");
    expect(event.data).toMatchObject({
      audioEnded: true,
      synthetic: true,
      multipleChoice: true,
    });
  }
  expect(errors).toEqual([]);
});

test("listening first, durable draft, gaps, recall, review scheduling and backup restore", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const m = demoMaterials[0];
  await open(page, "listen?material=" + m.id);
  await expect(page.locator(".transcript")).toHaveCount(0);
  await play(page);
  await page
    .locator("#meaning")
    .fill("There was a delay, so the speaker changed the plan.");
  await page.reload();
  await expect(page.locator("#meaning")).toHaveValue(
    "There was a delay, so the speaker changed the plan.",
  );
  await page
    .getByRole("button", { name: "Check my understanding", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Main idea + details", exact: true })
    .click();
  await page.getByRole("button", { name: "Reveal English transcript" }).click();
  await expect(page.locator(".transcript")).toBeVisible();
  await page.locator(".transcript button").nth(1).click();
  await play(page);
  await page
    .getByRole("button", { name: "Know it · missed the sound", exact: true })
    .first()
    .click();
  await expect.poll(async () => (await rows(page, "chunks")).length).toBe(1);
  await page.getByRole("button", { name: "Continue to active recall" }).click();
  await expect(page).toHaveURL(/learn/);
  const chunks = await rows(page, "chunks");
  expect(Number(chunks[0].listeningStrength)).toBeLessThan(0.5);
  await open(page, "review");
  await expect(page.locator(".flashcard")).toBeVisible();
  await page.locator("#review-answer").fill("My attempt at the phrase.");
  await page
    .getByRole("button", { name: "Check my answer", exact: true })
    .click();
  await page.getByRole("button", { name: "Good Independent" }).click();
  await expect.poll(async () => {
    const cards = await rows(page, "cards");
    return cards.some((c) => Number((c.card as { reps: number }).reps) > 0);
  }).toBe(true);
  await open(page, "settings");
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export backup", exact: true })
    .click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const pieces: Buffer[] = [];
  if (stream) for await (const piece of stream) pieces.push(Buffer.from(piece));
  const content = Buffer.concat(pieces);
  expect(content.toString()).not.toContain('"secrets"');
  await page
    .locator("#restore-file")
    .setInputFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: content,
    });
  await page.getByRole("button", { name: "Validate & restore backup" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "restored" }),
  ).toBeVisible();
  expect((await rows(page, "chunks")).length).toBe(chunks.length);
  await page
    .locator("#restore-file")
    .setInputFiles({
      name: "broken.json",
      mimeType: "application/json",
      buffer: Buffer.from("{invalid"),
    });
  await page.getByRole("button", { name: "Validate & restore backup" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect((await rows(page, "chunks")).length).toBe(chunks.length);
  expect(errors).toEqual([]);
});

test("recording is saved before transcription and survives an API error", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, "speak");
  await page
    .getByRole("button", { name: "Start conversation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Record response", exact: true })
    .click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Stop & save", exact: true }).click();
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  expect((await rows(page, "audio")).length).toBe(1);
  await page
    .locator("#speak-response")
    .fill("I would like to meet a new friend.");
  await page.reload();
  await expect(page.locator("#speak-response")).toHaveValue(
    "I would like to meet a new friend.",
  );
  await expect(page.locator(".recording-playback")).toBeVisible();
  await page
    .getByRole("button", { name: "Send response", exact: true })
    .click();
  await expect(
    page.getByText("Could you tell me a little more about that?", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Finish & reflect" }).click();
  await expect(
    page.getByText("YOUR CONVERSATION REFLECTION", { exact: true }),
  ).toBeVisible();
  await open(page, "settings");
  await page.locator("#api-key").fill("test-key-not-real");
  await page.getByRole("button", { name: "Save key", exact: true }).click();
  await page.route("https://openrouter.ai/api/v1/**", (r) =>
    r.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "Unauthorized" } }),
    }),
  );
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect((await rows(page, "audio")).length).toBe(1);
  await page.getByRole("button", { name: "Remove key", exact: true }).click();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("all routes, dark theme and offline shell with real cached audio", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  for (const route of [
    "today",
    "listen",
    "learn",
    "speak",
    "review",
    "library",
    "progress",
    "settings",
    "onboarding",
  ]) {
    await open(page, route);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await open(page, "settings");
  await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await context.setOffline(true);
  await open(page, "listen?material=" + demoMaterials[0].id);
  await play(page);
  await open(page, "review");
  await page.reload();
  await expect(page.locator("h1")).toContainText("Bring it");
  expect(errors).toEqual([]);
});
