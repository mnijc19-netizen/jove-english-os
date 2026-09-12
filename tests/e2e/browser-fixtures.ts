import { test as base, expect, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

type CaptureMode = "native" | "synthetic" | "denied" | "missing";
declare global {
  interface Window {
    __joveMediaTrace: Record<string, string | number | boolean | null>[];
    __joveInputTrace: Record<string, string | number | boolean | null>[];
    __joveCaptureProbe: {
      nativeRecorder: typeof MediaRecorder;
      nativeWorklet: typeof AudioWorkletNode;
      mediaDevices: MediaDevices | undefined;
      requests: MediaStreamConstraints[];
      streams: MediaStream[];
      contexts: AudioContext[];
    };
  }
}

/** Only the input device is substituted. MediaRecorder, codecs, playback, IDB,
 * service workers and network status are the real browser implementations.
 * A sine wave tests plumbing, never speech quality or a physical microphone. */
export const test = base.extend<{
  captureMode: CaptureMode;
  storageMode: "regular" | "private";
  browserChecks: void;
  offlineServer: { url: string; disconnect: () => Promise<void> };
}>({
  captureMode: ["native", { option: true }],
  storageMode: ["regular", { option: true }],
  context: async ({ context, playwright, browserName, storageMode }, use) => {
    if (browserName !== "webkit" || storageMode === "private") { await use(context); return; }
    // WebKit 2359 private contexts reject even a native 100-byte Blob IDB put;
    // an independent regular profile does not. Never change Blob/IDB semantics.
    // Empty userDataDir asks Playwright for a disposable, isolated directory.
    // The runner inherits project device/baseURL/CSP options for this context.
    const regular = await playwright.webkit.launchPersistentContext("");
    try { await use(regular); }
    finally { await regular.close(); }
  },
  // Playwright requires an object pattern even for fixtures without dependencies.
  // eslint-disable-next-line no-empty-pattern
  offlineServer: async ({}, use) => {
    // Real built files and real service worker. No interception or injected cache.
    // A memory snapshot also isolates this test from another worker rebuilding dist.
    const files = new Map<string, Buffer>();
    const buildDirectory = process.env.PLAYWRIGHT_BUILD_DIR || "dist";
    async function snapshot(directory = "") {
      for (const entry of await readdir(join(buildDirectory, directory), { withFileTypes: true })) {
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await snapshot(relative);
        else if (entry.isFile()) files.set(relative, await readFile(join(buildDirectory, relative)));
      }
    }
    await snapshot();
    if (!files.has("index.html") || !files.has("sw.js")) throw new Error("Build the production app before WebKit PWA tests.");
    const types: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".wav": "audio/wav", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const name = path.replace(/^\/jove-english-os\//, "") || "index.html";
      const bytes = files.get(name);
      response.writeHead(bytes ? 200 : 404, { "Content-Type": types[extname(name)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      response.end(bytes);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local PWA test port");
    let disconnected = false;
    const disconnect = async () => {
      if (disconnected) return;
      disconnected = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    };
    try { await use({ url: `http://127.0.0.1:${address.port}/jove-english-os/`, disconnect }); }
    finally { await disconnect(); }
  },
  browserChecks: [async ({ page, captureMode }, use, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ mode, forcePcm, observeInputs }) => {
      window.__joveInputTrace = [];
      if (observeInputs) {
        // Observe only metadata in isolated synthetic learning journeys. Do not
        // synthesize input/focus, keep element references or retain typed text.
        for (const type of ['focusin', 'focusout', 'beforeinput', 'input', 'change', 'compositionstart', 'compositionend']) {
          document.addEventListener(type, event => {
            const target = event.target;
            if (!(target instanceof HTMLTextAreaElement)) return;
            window.__joveInputTrace.push({ type, id: target.id, length: target.value.length,
              composing: !!(target as HTMLTextAreaElement & { composing?: boolean }).composing,
              trusted: event.isTrusted, disabled: target.disabled, at: performance.now(),
              activeTag: document.activeElement?.tagName ?? null, activeId: document.activeElement?.id ?? null });
            if (window.__joveInputTrace.length > 150) window.__joveInputTrace.shift();
          }, true);
        }
      }
      // Observe native events/calls without advancing the clock or replacing playback.
      // Exclude URL query strings so a future signed source cannot enter reports.
      window.__joveMediaTrace = [];
      const observe = (event: string, media?: HTMLMediaElement, stack?: string) => {
        const source = media?.currentSrc || media?.getAttribute("src");
        const url = source ? new URL(source, location.href) : undefined;
        const events = window.__joveMediaTrace;
        events.push({ event, at: performance.now(), visibility: document.visibilityState,
          route: location.hash, source: url ? (url.protocol === "blob:" ? "blob:" + url.pathname : url.origin + url.pathname) : null,
          currentTime: media?.currentTime ?? null, paused: media?.paused ?? null,
          seeking: media?.seeking ?? null, readyState: media?.readyState ?? null,
          duration: Number.isFinite(media?.duration) ? media!.duration : null,
          error: media?.error?.code ?? null, stack: stack ?? null });
        if (events.length > 300) events.shift();
      };
      for (const event of ["play", "playing", "pause", "ended", "timeupdate", "loadedmetadata", "seeking", "seeked", "waiting", "emptied", "stalled", "error"])
        document.addEventListener(event, e => { if (e.target instanceof HTMLMediaElement) observe(event, e.target); }, true);
      document.addEventListener("visibilitychange", () => observe("visibilitychange"));
      window.addEventListener("hashchange", () => observe("hashchange"));
      const nativePause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.pause = function () {
        observe("pause-call", this, new Error("native pause call").stack);
        return nativePause.call(this);
      };
      // The PCM project only hides native encoder availability. It does not
      // replace AudioContext, AudioWorkletNode or the audio-thread processor.
      if (forcePcm) Object.defineProperty(window, "MediaRecorder", { value: undefined, configurable: true });
      window.__joveCaptureProbe = {
        nativeRecorder: window.MediaRecorder, nativeWorklet: window.AudioWorkletNode,
        // Keep the WebKit host-object wrapper alive: its test-only expando can
        // otherwise disappear when the wrapper is collected between clicks.
        mediaDevices: navigator.mediaDevices, requests: [], streams: [], contexts: [],
      };
      if (mode === "native" || !navigator.mediaDevices) return;
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async (constraints: MediaStreamConstraints) => {
          const probe = window.__joveCaptureProbe;
          probe.requests.push(constraints);
          if (mode === "denied") throw new DOMException("Test permission denied", "NotAllowedError");
          if (mode === "missing") throw new DOMException("Test device absent", "NotFoundError");
          const context = new AudioContext();
          probe.contexts.push(context);
          const destination = context.createMediaStreamDestination();
          const source = context.createOscillator();
          const gain = context.createGain();
          source.frequency.value = 440;
          gain.gain.value = 0.15;
          source.connect(gain).connect(destination);
          source.start();
          await context.resume();
          probe.streams.push(destination.stream);
          return destination.stream;
        },
      });
    }, { mode: captureMode, forcePcm: testInfo.project.name === "chromium-pcm",
      observeInputs: testInfo.project.name.startsWith('webkit-') && testInfo.file.endsWith('longitudinal.spec.ts') });
    await use();
    if (!page.isClosed()) {
      if (testInfo.status !== testInfo.expectedStatus)
        await testInfo.attach("native-media-events", {
          body: JSON.stringify(await page.evaluate(() => ({
            events: window.__joveMediaTrace,
            inputEvents: window.__joveInputTrace,
            inputState: Array.from(document.querySelectorAll('textarea')).map(input => ({
              id: input.id, length: input.value.length, disabled: input.disabled,
              composing: !!(input as HTMLTextAreaElement & { composing?: boolean }).composing,
            })),
            generatedSourceContexts: window.__joveCaptureProbe?.contexts.map(context => ({
              state: context.state, currentTime: context.currentTime, sampleRate: context.sampleRate,
            })),
            inputTracks: window.__joveCaptureProbe?.streams.flatMap(stream => stream.getTracks().map(track => ({
              readyState: track.readyState, enabled: track.enabled, muted: track.muted,
            }))),
          }))),
          contentType: "application/json",
        });
      await page.evaluate(async () => {
        const probe = window.__joveCaptureProbe;
        for (const stream of probe?.streams ?? []) stream.getTracks().forEach(track => track.stop());
        await Promise.all((probe?.contexts ?? []).map(context => context.close()));
      });
    }
    await testInfo.attach("uncaught-browser-errors", { body: JSON.stringify(errors), contentType: "application/json" });
    expect(errors).toEqual([]);
  }, { auto: true }],
});
export { expect };

export async function openPractice(page: Page, route = "today") {
  const hash = "#/" + route;
  await page.goto(/^https?:/.test(page.url()) ? new URL(hash, page.url()).href : hash);
  await expect(page.locator("main h1")).toBeVisible();
}

export async function records(page: Page, table: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(name => new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const request = indexedDB.open("jove-english-os");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(name);
      const read = transaction.objectStore(name).getAll();
      transaction.oncomplete = () => { database.close(); resolve(read.result); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }), table);
}

export async function recordingEvidence(page: Page) {
  return page.evaluate(async () => {
    const assets = await new Promise<{ id: string; blob: Blob; duration: number; mimeType: string; kind: string; processed: boolean }[]>((resolve, reject) => {
      const request = indexedDB.open("jove-english-os");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("audio");
        const read = transaction.objectStore("audio").getAll();
        transaction.oncomplete = () => { database.close(); resolve(read.result); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
    return Promise.all(assets.filter(asset => asset.kind === "recording").map(async asset => ({
      id: asset.id, bytes: asset.blob.size, mimeType: asset.mimeType, blobType: asset.blob.type,
      duration: asset.duration, processed: asset.processed,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await asset.blob.arrayBuffer())))
        .map(byte => byte.toString(16).padStart(2, "0")).join(""),
    })));
  });
}

export async function playLesson(page: Page) {
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  await expect.poll(() => page.locator(".audio-player audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.1);
  await page.getByRole("button", { name: "Pause audio", exact: true }).click();
}

export async function waitForOfflineShell(page: Page) {
  // BrowserContext.serviceWorkers() is Chromium-only. Observe the native DOM API.
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 60000 }).toBe(true);
}
