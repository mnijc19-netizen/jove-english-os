import { expect, test, type Page } from "@playwright/test";
import { demoMaterials } from "../../src/content/materials";

async function open(page: Page, route = "today") {
  await page.goto("#/" + route);
  await expect(page.locator("h1")).toBeVisible();
}
async function localOnly(page: Page) {
  // These guidance/navigation checks must not contact account or paid services.
  await page.route(/^https?:\/\//, route => {
    const host = new URL(route.request().url()).hostname;
    return host === "127.0.0.1" || host === "localhost" ? route.continue() : route.abort();
  });
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

test("keyboard skip link focuses practice without changing a hash route", async ({ page }) => {
  await open(page, "review");
  await expect(page.locator("main h1")).toBeFocused();
  const currentUrl = page.url();
  await page.locator(".skip-link").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await expect(page).toHaveURL(currentUrl);
  await expect(page.locator("h1")).toContainText("Bring it back");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Practice type" })).toBeFocused();
});

test("first setup measures listening, vocabulary and reading, persists the profile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await localOnly(page);
  await open(page, "onboarding");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  const guidance = page.locator("#onboarding-guidance");
  const checkStep = async (title: string, procedure: string) => {
    await expect(page.locator('.onboarding-steps [aria-current="step"]')).toContainText(title);
    await expect(guidance).toHaveAttribute("lang", "zh-CN");
    await expect(guidance).toContainText(procedure);
  };
  await checkStep("学习方向", "这一步只是偏好设置");
  await expect(page.locator('#goal option[value="Real-world conversation"]')).toHaveText("日常交流 · Real-world conversation");
  await page.getByLabel("What should we call you?").fill("Practice learner");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await checkStep("听懂大意", "听到结尾后才会出现英文选项");
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
    await expect(page.locator("fieldset.answer-options")).toHaveAttribute("lang", "en");
    await page.getByRole("radio", { name: m.answer, exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    if (m.id === samples[0].id) {
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.getByRole("radio", { name: m.answer, exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: m.answer, exact: true })).toBeDisabled();
      await expect(page.getByRole("status").filter({ hasText: "第一次提交的答案已保存并锁定" })).toBeVisible();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    }
  }
  await checkStep("理解表达", "不代表已经能在对话中说出来");
  for (const meaning of [
    "understand or solve something",
    "the answer changes with the situation",
    "be expected to do something",
  ])
    await page.getByRole("radio", { name: meaning, exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await checkStep("开口尝试", "等待保存完成后再继续");
  await expect(page.locator("#baseline-speech")).toHaveAttribute("lang", "en");
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await checkStep("阅读理解", "不翻译短文、问题或答案");
  await expect(page.locator(".onboarding-card blockquote")).toHaveAttribute("lang", "en");
  await page
    .getByRole("radio", { name: "Because it started raining." })
    .check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await checkStep("开始练习", "没有做过的项目仍是未知");
  await page.getByRole("button", { name: "Build my daily practice" }).click();
  await expect(page).toHaveURL(/today/);
  await page.reload();
  await expect(
    page.locator("main").getByText("Practice learner，不用自己排课。", { exact: false }),
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
      chineseUsed: false,
      transcriptRevealed: false,
    });
  }
  expect(errors).toEqual([]);
});

test("Chinese navigation preserves accessible names and the mobile menu never hides keyboard focus", async ({ page }) => {
  await localOnly(page);
  await page.setViewportSize({ width: 393, height: 851 });
  await open(page, "onboarding");
  const toggle = page.getByRole("button", { name: "Toggle navigation", exact: true });
  const sidebar = page.locator("#workspace-navigation");
  const name = page.getByLabel("What should we call you?", { exact: true });
  await expect(name).toBeVisible();
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(toggle).toHaveAttribute("aria-controls", "workspace-navigation");
  await toggle.focus();
  await page.keyboard.press("Tab");
  await expect(name).toBeFocused();
  await sidebar.locator('a[href$="/settings"]').evaluate((link: HTMLAnchorElement) => link.focus());
  await expect(name).toBeFocused();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar).not.toHaveAttribute("inert", "");
  const today = page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Today", exact: true });
  await expect(today).toContainText("今日安排");
  await expect(today).toHaveAccessibleDescription("查看下一项任务，继续已保存的练习");
  await today.focus();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar).toHaveAttribute("inert", "");

  // A nonmodal menu does not trap focus or take it back from an editor.
  await toggle.click();
  await name.focus();
  await name.fill("保留当前输入");
  await page.keyboard.press("Escape");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("保留当前输入");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const theme = sidebar.getByRole("button", { name: "Toggle dark mode", exact: true });
  await theme.focus();
  await page.keyboard.press("Tab");
  await expect(name).toBeFocused();
  await page.keyboard.press("Escape");

  // Desktop navigation stays available; shrinking never strands sidebar focus.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(sidebar).not.toHaveAttribute("inert", "");
  await today.focus();
  await page.setViewportSize({ width: 393, height: 851 });
  await expect(toggle).toBeFocused();
  await expect(sidebar).toHaveAttribute("inert", "");
  await toggle.click();
  await today.click();
  await expect(page).toHaveURL(/#\/today$/);
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(page.locator("main h1")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
  await page.getByRole("button", { name: "Validate & merge backup" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Backup merged with retained learning history." }),
  ).toBeVisible();
  expect((await rows(page, "chunks")).length).toBe(chunks.length);
  await page
    .locator("#restore-file")
    .setInputFiles({
      name: "broken.json",
      mimeType: "application/json",
      buffer: Buffer.from("{invalid"),
    });
  await page.getByRole("button", { name: "Validate & merge backup" }).click();
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
    page.locator(".recorder").getByText("Saved on this device", { exact: true }),
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
  await expect(page.getByRole("heading", { name: "AI connection", exact: true })).toBeVisible();
  const advanced = page.getByRole("button", { name: "Advanced: optional browser key", exact: true });
  if (await advanced.count()) await advanced.click();
  await page.locator("#api-key").fill("test-key-not-real");
  await page.getByRole("button", { name: "Save key", exact: true }).click();
  await expect(page.getByText("Key saved locally", { exact: true })).toBeVisible();
  expect((await rows(page, "secrets")).filter(row => row.id === "openrouter")).toHaveLength(1);
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
  await expect(page.getByText("No browser key", { exact: true })).toBeVisible();
  await expect(page.locator("#api-key")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove key", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Test connection", exact: true })).toBeDisabled();
  expect((await rows(page, "secrets")).filter(row => ["openrouter", "provider-mode"].includes(String(row.id)))).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "AI connection", exact: true })).toBeVisible();
  if (await advanced.count()) await advanced.click();
  await expect(page.getByText("No browser key", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Test connection", exact: true })).toBeDisabled();
  expect((await rows(page, "audio")).length).toBe(1);
  expect(errors).toEqual([]);
});

test("all routes, dark theme and offline shell with real cached audio", async ({
  page,
  context,
}) => {
  // A fresh public-origin install downloads the real offline audio library.
  // Wait for actual control, not localhost-speed precaching, before disconnecting.
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 60000 })
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
