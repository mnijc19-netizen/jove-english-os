import { test, expect, openPractice, records, recordingEvidence, playLesson, waitForOfflineShell } from "./browser-fixtures";
import type { Page } from "@playwright/test";

// Windows' Playwright WebKit port has neither MediaRecorder nor Web Audio.
// The 2359 Linux GTK/WPE builds also omit MediaRecorder (Web Audio is present).
// Linux exercises real AudioWorklet PCM capture; it never gets a fake recorder.
// Windows has no capture/Web Audio APIs, so its full media gate remains unmet.
const windowsPort = process.platform === "win32";
const mediaLimit = "Windows WebKit lacks Web Audio; use a WebKit port with native media support.";

async function browserCaptureAvailable(page: Page) {
  return page.evaluate(() => typeof navigator.mediaDevices?.getUserMedia === "function" &&
    (typeof MediaRecorder === "function" || (typeof AudioContext === "function" && typeof AudioWorkletNode === "function" && 'audioWorklet' in AudioContext.prototype)));
}
async function requireBrowserCapture(page: Page) {
  test.skip(!await browserCaptureAvailable(page),
    "This port has neither a native encoder nor Web Audio capture. The capability gate remains unmet; a real media-capable WebKit run is required.");
}

async function assertSpeakingModeLabels(page: Page) {
  const tabs = page.getByRole("group", { name: "Speaking mode" });
  const buttons = tabs.getByRole("button");
  await expect(buttons).toHaveCount(4);
  const bounds = await buttons.evaluateAll(elements => elements.map(element => {
    const button = element.getBoundingClientRect(), style = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    const label = range.getBoundingClientRect();
    return { text: element.textContent!.trim(), left: button.left, right: button.right,
      height: button.height, labelLeft: label.left, labelRight: label.right,
      paddingLeft: Number.parseFloat(style.paddingLeft), paddingRight: Number.parseFloat(style.paddingRight) };
  }));
  for (const [index, bound] of bounds.entries()) {
    // Container overflow alone misses text painting over an adjacent button.
    expect(bound.labelLeft, `${bound.text}: label inside its own left padding`).toBeGreaterThanOrEqual(bound.left + bound.paddingLeft - 1);
    expect(bound.labelRight, `${bound.text}: label inside its own right padding`).toBeLessThanOrEqual(bound.right - bound.paddingRight + 1);
    expect(bound.height, `${bound.text}: touch target height`).toBeGreaterThanOrEqual(44);
    if (index) expect(bound.labelLeft, `${bound.text}: no adjacent label overlap`).toBeGreaterThanOrEqual(bounds[index - 1].labelRight);
    const button = buttons.nth(index);
    await button.scrollIntoViewIfNeeded();
    // A closing mobile navigation can briefly cover the already-laid-out tabs.
    // Keep the real hit-test gate, allowing only normal UI settling.
    await expect.poll(() => button.evaluate(element => {
      const rect = element.getBoundingClientRect(), clip = element.parentElement!.getBoundingClientRect();
      return rect.left >= Math.max(0, clip.left) - 1 && rect.right <= Math.min(innerWidth, clip.right) + 1
        && element.contains(document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2));
    }), { message: `${bound.text}: fully reachable in its horizontal scroller` }).toBe(true);
  }
  await buttons.first().scrollIntoViewIfNeeded();
}

test("native WebKit capabilities and emulation limits are recorded", async ({ page, browser, isMobile }, testInfo) => {
  await openPractice(page);
    const capabilities = await page.evaluate(() => ({
    userAgent: navigator.userAgent, secureContext: isSecureContext,
    indexedDB: typeof indexedDB, serviceWorker: Boolean(navigator.serviceWorker),
    mediaRecorder: typeof MediaRecorder, audioContext: typeof AudioContext,
    audioWorklet: typeof AudioWorkletNode,
    getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
    formats: typeof MediaRecorder === "undefined" ? [] : ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].filter(type => MediaRecorder.isTypeSupported(type)),
    touchEvents: "ontouchstart" in window, coarsePointer: matchMedia("(pointer: coarse)").matches,
    viewport: { width: innerWidth, height: innerHeight },
  }));
  await testInfo.attach("native-capabilities", { body: JSON.stringify({ host: process.platform, engine: browser.version(), emulatedMobile: isMobile, physicalDevice: false, ...capabilities }, null, 2), contentType: "application/json" });
  expect(capabilities.secureContext).toBe(true);
  expect(capabilities.indexedDB).toBe("object");
  expect(capabilities.serviceWorker).toBe(true);
  expect.soft(await browserCaptureAvailable(page), "Full media acceptance needs native MediaRecorder or an actual AudioWorklet capture graph").toBe(true);
  if (!windowsPort) {
    expect(capabilities.audioContext).toBe("function");
    expect(capabilities.getUserMedia).toBe("function");
    if (capabilities.mediaRecorder === "function") expect(capabilities.formats.length).toBeGreaterThan(0);
    else expect(capabilities.audioWorklet).toBe("function");
  }
  if (isMobile) {
    expect(capabilities.touchEvents).toBe(true);
    expect(capabilities.coarsePointer).toBe(true);
    expect(capabilities.viewport.width).toBe(390);
  }
});

test("unsupported native recording preserves typed work and gives an actionable fallback", async ({ page }) => {
  await openPractice(page, "speak");
  test.skip(await browserCaptureAvailable(page), "This port supports native recording or AudioWorklet; use the real capture journeys.");
  await page.getByRole("button", { name: "Start conversation", exact: true }).click();
  await page.locator("#speak-response").fill("Keep my written answer when recording is unavailable.");
  await page.getByRole("button", { name: "Record response", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Audio recording is unavailable");
  expect(await records(page, "audio")).toHaveLength(0);
  await page.reload();
  await expect(page.locator("#speak-response")).toHaveValue("Keep my written answer when recording is unavailable.");
});

test("built-in WAV really plays, pauses and decodes without a provider key", async ({ page, browserName }) => {
  test.skip(windowsPort && browserName === "webkit", mediaLimit);
  await openPractice(page, "listen?material=cafe-delay");
  await expect(page.locator(".transcript")).toHaveCount(0);
  await playLesson(page);
  const decoded = await page.locator(".audio-player audio").evaluate(async (audio: HTMLAudioElement) => {
    const bytes = await (await fetch(audio.currentSrc)).arrayBuffer();
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(bytes);
      return { duration: buffer.duration, samples: buffer.length, channels: buffer.numberOfChannels, paused: audio.paused, error: audio.error?.message ?? null };
    } finally { await context.close(); }
  });
  expect(decoded.duration).toBeGreaterThan(1);
  expect(decoded.samples).toBeGreaterThan(10000);
  expect(decoded.channels).toBeGreaterThan(0);
  expect(decoded.paused).toBe(true);
  expect(decoded.error).toBeNull();
  expect(await records(page, "secrets")).toHaveLength(0);
});

for (const captureMode of ["denied", "missing"] as const) {
  test.describe(`${captureMode} microphone input`, () => {
    test.use({ captureMode });
    test("device rejection is recoverable and cannot discard a persisted answer", async ({ page }) => {
      await openPractice(page, "speak");
      await requireBrowserCapture(page);
      await page.getByRole("button", { name: "Start conversation", exact: true }).click();
      const answer = `Retain this answer after ${captureMode} capture.`;
      await page.locator("#speak-response").fill(answer);
      await page.getByRole("button", { name: "Record response", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText(captureMode === "denied" ? "Microphone permission was denied" : "No working microphone");
      await expect(page.getByRole("button", { name: "Record response", exact: true })).toBeEnabled();
      expect(await page.evaluate(() => window.__joveCaptureProbe.requests)).toEqual([{ audio: true }]);
      expect(await records(page, "audio")).toHaveLength(0);
      await page.reload();
      await expect(page.locator("#speak-response")).toHaveValue(answer);
    });
  });
}

test.describe("real browser capture with generated MediaStream (no physical microphone)", () => {
  test.use({ captureMode: "synthetic" });

  test("capture commits a decodable blob, releases tracks, replays and survives offline reload byte-for-byte", async ({ page, offlineServer }, testInfo) => {
    test.setTimeout(90000);
    await page.goto(offlineServer.url + "#/speak");
    await expect(page.locator("main h1")).toBeVisible();
    await requireBrowserCapture(page);
    await waitForOfflineShell(page);
    await page.getByRole("button", { name: "Start conversation", exact: true }).click();
    await page.getByRole("button", { name: "Record response", exact: true }).click();
    // The UI clock rounds wall time; PCM duration counts only actual samples.
    await expect(page.locator(".record-status")).toContainText("3s / 180s");
    await expect(page.getByRole("button", { name: "Finish & reflect" })).toBeDisabled();
    await page.getByRole("button", { name: "Stop & save", exact: true }).click();
    await expect(page.locator(".recorder").getByText("Saved on this device", { exact: true })).toBeVisible();
    const before = await recordingEvidence(page);
    expect(before).toHaveLength(1);
    expect(before[0].bytes).toBeGreaterThan(500);
    expect(before[0].duration).toBeGreaterThanOrEqual(2);
    expect(before[0].mimeType).toMatch(/^audio\//);
    expect(before[0].blobType).toBe(before[0].mimeType);
    expect(before[0].processed).toBe(false);
    expect(await page.evaluate(() => ({ native: window.MediaRecorder === window.__joveCaptureProbe.nativeRecorder && window.AudioWorkletNode === window.__joveCaptureProbe.nativeWorklet, requests: window.__joveCaptureProbe.requests, tracks: window.__joveCaptureProbe.streams.flatMap(stream => stream.getTracks().map(track => track.readyState)) }))).toEqual({ native: true, requests: [{ audio: true }], tracks: ["ended"] });
    const pcm = await page.evaluate(() => typeof MediaRecorder === "undefined");
    if (pcm) expect(before[0].mimeType).toBe("audio/wav");
    const decoded = await page.evaluate(async () => {
      // Use the committed Blob as the speech adapter does. Fetching blob: URLs
      // is intentionally outside the app's connect-src CSP and is not needed.
      const blob = await new Promise<Blob>((resolve, reject) => {
        const request = indexedDB.open("jove-english-os");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("audio");
          const read = transaction.objectStore("audio").getAll();
          transaction.oncomplete = () => { db.close(); resolve(read.result.find(asset => asset.kind === "recording").blob); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        };
      });
      const context = new AudioContext();
      try {
        const buffer = await context.decodeAudioData(await blob.arrayBuffer());
        const samples = buffer.getChannelData(0);
        let energy = 0, crossings = 0;
        for (let i = 0; i < samples.length; i++) {
          energy += samples[i] * samples[i];
          if (i && samples[i - 1] <= 0 && samples[i] > 0) crossings++;
        }
        return { duration: buffer.duration, rms: Math.sqrt(energy / samples.length), channels: buffer.numberOfChannels, frequency: crossings / buffer.duration };
      } finally { await context.close(); }
    });
    expect(decoded.duration).toBeGreaterThan(1);
    expect(decoded.rms).toBeGreaterThan(0.01);
    expect(Math.abs(decoded.frequency - 440)).toBeLessThan(15);
    await testInfo.attach("synthetic-capture-evidence", { body: JSON.stringify({ backend: pcm ? "native AudioWorklet PCM WAV" : "native MediaRecorder", original: before[0], decoded, physicalMicrophone: false }), contentType: "application/json" });
    await expect(page.getByRole("button", { name: "Transcribe recording", exact: true })).toBeDisabled();
    await page.locator("#speak-response").fill("This recording is saved locally before any network request.");
    await offlineServer.disconnect();
    await expect(fetch(offlineServer.url)).rejects.toThrow();
    await page.reload();
    await expect(page.locator("#speak-response")).toHaveValue("This recording is saved locally before any network request.");
    await expect(page.locator(".recording-playback")).toBeVisible();
    expect(await recordingEvidence(page)).toEqual(before);
    await page.locator(".recording-playback").evaluate((audio: HTMLAudioElement) => audio.play());
    await expect.poll(() => page.locator(".recording-playback").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.1);
    expect(await records(page, "secrets")).toHaveLength(0);
  });

  test("route guard retains active capture until explicit save, then releases the stream and preserves the original", async ({ page }) => {
    await openPractice(page, "speak");
    await requireBrowserCapture(page);
    await page.getByRole("button", { name: "Start conversation", exact: true }).click();
    await page.getByRole("button", { name: "Record response", exact: true }).click();
    await expect(page.locator(".record-status")).toContainText("1s / 180s");
    await page.evaluate(() => { location.hash = "#/today"; });
    await expect(page.getByRole("alert")).toContainText("Finish or cancel recording and analysis before leaving");
    await expect(page).toHaveURL(/#\/speak$/);
    await expect(page.getByRole("button", { name: "Stop & save", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Stop & save", exact: true }).click();
    await expect(page.locator(".recorder").getByText("Saved on this device", { exact: true })).toBeVisible();
    await page.evaluate(() => { location.hash = "#/today"; });
    await expect(page).toHaveURL(/#\/today$/);
    await expect.poll(async () => (await recordingEvidence(page)).length).toBe(1);
    const before = await recordingEvidence(page);
    expect(before[0].bytes).toBeGreaterThan(500);
    expect(await page.evaluate(() => window.__joveCaptureProbe.streams.flatMap(stream => stream.getTracks().map(track => track.readyState)))).toEqual(["ended"]);
    await openPractice(page, "speak");
    await expect(page.locator(".recording-playback")).toBeVisible();
    expect(await recordingEvidence(page)).toEqual(before);
  });

  test("first capture after a cold offline reload loads the cached worklet and saves original audio", async ({ page, offlineServer }) => {
    test.setTimeout(90000);
    await page.goto(offlineServer.url + "#/speak");
    await requireBrowserCapture(page);
    await waitForOfflineShell(page);
    const workletCached = await page.evaluate(async () => {
      for (const name of await caches.keys()) {
        if ((await (await caches.open(name)).keys()).some(request => /\/pcm-recorder-[^/]+\.js/.test(request.url))) return true;
      }
      return false;
    });
    expect(workletCached).toBe(true);
    await offlineServer.disconnect();
    await expect(fetch(offlineServer.url)).rejects.toThrow();
    await page.reload();
    await page.getByRole("button", { name: "Start conversation", exact: true }).click();
    await page.getByRole("button", { name: "Record response", exact: true }).click();
    await expect(page.locator(".record-status")).toContainText("3s / 180s");
    await page.getByRole("button", { name: "Stop & save", exact: true }).click();
    await expect(page.locator(".recorder").getByText("Saved on this device", { exact: true })).toBeVisible();
    const before = await recordingEvidence(page);
    expect(before).toHaveLength(1);
    expect(before[0].duration).toBeGreaterThanOrEqual(2);
    expect(before[0].processed).toBe(false);
    await page.reload();
    expect(await recordingEvidence(page)).toEqual(before);
    await expect(page.locator(".recorder").getByText("Saved on this device", { exact: true })).toBeVisible();
    await expect.poll(() => page.locator(".recording-playback").evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(2);
    const originalSource = await page.locator(".recording-playback").getAttribute("src");
    expect(originalSource).toMatch(/^blob:/);
    await page.locator(".recording-playback").evaluate((audio: HTMLAudioElement) => audio.play());
    await expect.poll(() => page.locator(".recording-playback").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.1);
    await expect.poll(() => page.locator(".recording-playback").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(1);
    await expect(page.locator(".recording-playback")).toHaveAttribute("src", originalSource!);
    const playback = await page.locator(".recording-playback").evaluate((audio: HTMLAudioElement) => ({ duration: audio.duration, error: audio.error?.code ?? null }));
    expect(playback.error).toBeNull();
    // PCM WAV has a sample-exact header; live-encoded WebM may report Infinity
    // in its media element until the end is discovered. Neither clock is faked.
    if (before[0].mimeType === "audio/wav") expect(playback.duration).toBeCloseTo(before[0].duration as number, 1);
  });
});

test.describe("private-context Blob storage is observed, never replaced with a fake database", () => {
  test.use({ storageMode: "private", captureMode: "synthetic" });
  test("private-mode capture stays recoverable when native IndexedDB cannot store a Blob", async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== "webkit", "WebKit port-specific private storage diagnostic");
    await openPractice(page, "speak");
    await requireBrowserCapture(page);
    const storage = await page.evaluate(() => new Promise<{ supported: boolean; error?: string }>((resolve, reject) => {
      const request = indexedDB.open("jove-private-blob-probe");
      request.onupgradeneeded = () => request.result.createObjectStore("blobs");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("blobs", "readwrite");
        transaction.objectStore("blobs").put(new Blob([new Uint8Array(100)], { type: "audio/wav" }), "probe");
        transaction.oncomplete = () => { db.close(); resolve({ supported: true }); };
        transaction.onabort = () => { db.close(); resolve({ supported: false, error: transaction.error?.message }); };
      };
    }));
    await testInfo.attach("private-blob-storage", { body: JSON.stringify({ ...storage, physicalSafari: false }), contentType: "application/json" });
    await page.getByRole("button", { name: "Start conversation", exact: true }).click();
    await page.getByRole("button", { name: "Record response", exact: true }).click();
    await expect(page.locator(".record-status")).toContainText("2s / 180s");
    await page.getByRole("button", { name: "Stop & save", exact: true }).click();
    if (storage.supported) {
      await expect(page.locator(".recorder").getByText("Saved on this device", { exact: true })).toBeVisible();
      expect(await recordingEvidence(page)).toHaveLength(1);
    } else {
      await expect(page.getByRole("alert")).toContainText("Recording has not been saved");
      await expect(page.getByRole("link", { name: "Download recording", exact: true })).toBeVisible();
      expect(await recordingEvidence(page)).toHaveLength(0);
      await page.getByRole("button", { name: "Retry saving recording", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Your audio is retained here");
      // Exercise the retained original with the browser audio decoder/player.
      await page.getByLabel("Your unsaved recording", { exact: true }).evaluate((audio: HTMLAudioElement) => audio.play());
      await expect.poll(() => page.getByLabel("Your unsaved recording", { exact: true }).evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.1);
      const retainedUrl = await page.getByRole("link", { name: "Download recording", exact: true }).getAttribute("href");
      await page.evaluate(() => { location.hash = "#/today"; });
      await expect(page.getByRole("alert").filter({ hasText: "Finish or cancel recording and analysis before leaving" })).toBeVisible();
      await expect(page).toHaveURL(/#\/speak$/);
      await expect(page.getByRole("link", { name: "Download recording", exact: true })).toBeVisible();
      expect(await page.getByRole("link", { name: "Download recording", exact: true }).getAttribute("href")).toBe(retainedUrl);
    }
    expect(await page.evaluate(() => window.__joveCaptureProbe.streams.flatMap(stream => stream.getTracks().map(track => track.readyState)))).toEqual(["ended"]);
  });
});

test("scoped PWA, IndexedDB draft, cached WAV and hash routes survive cold reload with the actual server disconnected", async ({ page, offlineServer, browserName }) => {
  test.setTimeout(90000);
  await page.goto(offlineServer.url + "#/listen?material=cafe-delay");
  await expect(page.locator("#meaning")).toBeVisible();
  await waitForOfflineShell(page);
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
    const response = await fetch(link.href);
    return { url: link.href, status: response.status, body: await response.json() };
  });
  expect(manifest.status).toBe(200);
  expect(manifest.body).toMatchObject({ start_url: "/jove-english-os/", scope: "/jove-english-os/", display: "standalone" });
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope)).toBe(new URL("./", page.url()).href);
  for (const icon of manifest.body.icons as { src: string }[]) {
    expect(await page.evaluate(async url => (await fetch(url)).status, new URL(icon.src, manifest.url).href)).toBe(200);
  }
  const answer = "Offline WebKit keeps this listening response in IndexedDB.";
  await page.locator("#meaning").fill(answer);
  await expect.poll(async () => JSON.stringify(await records(page, "sessions"))).toContain(answer);
  // WebKit 2359 setOffline(true) fails before dispatching to even a minimal SW.
  // Cut the real origin instead: the network is actually unreachable, and neither
  // navigator.onLine nor a service-worker response is mocked. No OS-offline claim.
  await offlineServer.disconnect();
  await expect(fetch(offlineServer.url)).rejects.toThrow();
  await page.reload();
  await expect(page.locator("#meaning")).toHaveValue(answer);
  // A real fetch fails while the precached audio still has real, nonempty bytes.
  expect(await page.evaluate(async () => {
    try { await fetch(`unavailable-offline-${crypto.randomUUID()}.json`, { cache: "no-store" }); return false; }
    catch { return true; }
  })).toBe(true);
  const cachedAudio = await page.evaluate(async () => {
    const urls = (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(request => request.url)))).flat();
    const url = urls.find(url => /\/audio\/.*\.wav/.test(url));
    if (!url) throw new Error("No actual WAV in the service worker cache");
    // Workbox's internal cache key has a revision query. Request the original
    // asset URL, just as the player does, so the actual precache route handles it.
    const assetURL = new URL(url);
    assetURL.searchParams.delete("__WB_REVISION__");
    const response = await fetch(assetURL.href);
    return { status: response.status, size: (await response.arrayBuffer()).byteLength };
  });
  expect(cachedAudio.status).toBe(200);
  expect(cachedAudio.size).toBeGreaterThan(1000);
  if (!(windowsPort && browserName === "webkit")) await playLesson(page);
  await openPractice(page, "review");
  await page.reload();
  await expect(page.locator("h1")).toContainText("Bring it");
  await openPractice(page, "listen?material=cafe-delay");
  await expect(page.locator("#meaning")).toHaveValue(answer);
});

test("offline browser state saves an editable draft and reconnects without losing it", async ({ page, context }) => {
  await openPractice(page, "listen?material=cafe-delay");
  await context.setOffline(true);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await page.locator("#meaning").fill("Saved while the browser reports offline.");
  await expect.poll(async () => JSON.stringify(await records(page, "sessions"))).toContain("Saved while the browser reports offline.");
  await context.setOffline(false);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await page.reload();
  await expect(page.locator("#meaning")).toHaveValue("Saved while the browser reports offline.");
});

test("all nine routes render in light and dark with no horizontal overflow", async ({ page, isMobile }, testInfo) => {
  test.setTimeout(90000);
  const headings: Record<string, RegExp> = {
    today: /A little more natural,\s*every day\./,
    listen: /Listen for meaning\./,
    learn: /Make the expression yours\./,
    speak: /Say what you mean\./,
    review: /Bring it back\./,
    library: /Your little library\./,
    progress: /Progress with evidence\./,
    settings: /A few thoughtful settings\./,
    onboarding: /Let’s start with you\./,
  };
  for (const theme of ["light", "dark"]) {
    await openPractice(page, "settings");
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const route of ["today", "listen", "learn", "speak", "review", "library", "progress", "settings", "onboarding"]) {
      await openPractice(page, route);
      // A same-document hash change can return while the previous page's h1
      // remains visible. Capture only the intended route, including its fonts.
      await expect(page.locator("main h1")).toHaveText(headings[route]!);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${theme} ${route} overflow`).toBeLessThanOrEqual(1);
      if (isMobile && route === "speak") await assertSpeakingModeLabels(page);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${route}-viewport.png`) });
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${route}.png`), fullPage: true });
    }
  }
});

test("keyboard skip navigation preserves the route and typing R, Space and Enter cannot start recording", async ({ page }) => {
  await openPractice(page, "review");
  const url = page.url();
  await page.locator(".skip-link").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await expect(page).toHaveURL(url);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Practice type" })).toBeFocused();
  await openPractice(page, "speak");
  await page.getByRole("button", { name: "Start conversation", exact: true }).click();
  await page.locator("#speak-response").focus();
  await page.keyboard.type("R for response");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Still typing");
  await expect(page.locator("#speak-response")).toHaveValue("R for response\nStill typing");
  await expect(page.getByRole("button", { name: "Record response", exact: true })).toBeVisible();
  await expect(page.locator(".record-status")).toHaveCount(0);
});

test("mobile touch targets, landscape reflow and reduced viewport keep an editable draft reachable", async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, "Touch/orientation coverage uses the mobile WebKit project.");
  await openPractice(page);
  const menu = page.getByRole("button", { name: "Toggle navigation" });
  const box = await menu.boundingBox();
  // Keep the touch-size gate, but also exercise rotation/keyboard reflow when it fails.
  expect.soft(box!.width, "Navigation touch target width").toBeGreaterThanOrEqual(44);
  expect.soft(box!.height, "Navigation touch target height").toBeGreaterThanOrEqual(44);
  await menu.tap();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Speak", exact: true }).tap();
  await expect(page).toHaveURL(/#\/speak$/);
  const modes = page.getByRole("group", { name: "Speaking mode" }).getByRole("button");
  await assertSpeakingModeLabels(page);
  await modes.last().scrollIntoViewIfNeeded();
  await modes.last().tap();
  await expect(modes.last()).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: testInfo.outputPath("mobile-mode-labels-rightmost.png") });
  await modes.first().scrollIntoViewIfNeeded();
  await modes.first().tap();
  await expect(modes.first()).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: testInfo.outputPath("mobile-mode-labels-first.png") });
  await page.getByRole("button", { name: "Start conversation", exact: true }).tap();
  await page.locator("#speak-response").fill("Rotation and a smaller viewport keep this draft.");
  await page.setViewportSize({ width: 844, height: 390 });
  expect(await page.evaluate(() => matchMedia("(orientation: landscape)").matches)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("mobile-landscape.png"), fullPage: true });
  const settings = page.locator(".sidebar").getByRole("link", { name: "Settings", exact: true });
  await settings.scrollIntoViewIfNeeded();
  await expect(settings).toBeInViewport();
  await settings.tap();
  await expect(page).toHaveURL(/#\/settings$/);
  await page.screenshot({ path: testInfo.outputPath("mobile-landscape-settings.png") });
  const speak = page.locator(".sidebar").getByRole("link", { name: "Speak", exact: true });
  await speak.scrollIntoViewIfNeeded();
  await speak.tap();
  await expect(page.locator("#speak-response")).toHaveValue("Rotation and a smaller viewport keep this draft.");
  // A reduced viewport tests reflow/scroll reachability, not an actual iOS keyboard.
  await page.setViewportSize({ width: 390, height: 360 });
  await page.locator("#speak-response").tap();
  await expect(page.locator("#speak-response")).toBeFocused();
  await expect(page.locator("#speak-response")).toBeInViewport();
  await expect(page.locator("#speak-response")).toHaveValue("Rotation and a smaller viewport keep this draft.");
  await page.getByRole("button", { name: "Send response", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Send response", exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("mobile-reduced-viewport.png"), fullPage: true });
});

test("safe-area environment and reduced-motion support are observed without inventing a physical notch", async ({ page }, testInfo) => {
  await openPractice(page);
  const insets = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = { top: style.paddingTop, right: style.paddingRight, bottom: style.paddingBottom, left: style.paddingLeft, viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") };
    probe.remove();
    return result;
  });
  await testInfo.attach("safe-area-observation", { body: JSON.stringify({ ...insets, limitation: "Playwright has no physical notch/home indicator or OS keyboard; zero insets do not prove safe-area padding on iPhone." }), contentType: "application/json" });
  for (const side of [insets.top, insets.right, insets.bottom, insets.left]) expect(Number.parseFloat(side)).toBeGreaterThanOrEqual(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const durations = await page.locator(".sidebar").evaluate(element => ({ transition: getComputedStyle(element).transitionDuration, animation: getComputedStyle(element).animationDuration }));
  for (const value of [durations.transition, durations.animation]) expect(Number.parseFloat(value)).toBeLessThanOrEqual(0.01);
});
