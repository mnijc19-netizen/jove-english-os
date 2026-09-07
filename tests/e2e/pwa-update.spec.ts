import { test, expect, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";

const scope = "/jove-english-os/";
const marker = 'meta[name="test-version"]';
const materialId = "cafe-delay";

declare global {
  interface Window {
    __jovePwaUpdateDocument: {
      id: string;
      controlledAtBoot: boolean;
      controllerChanges: number;
    };
  }
}

async function serveUpgrade() {
  // Snapshot the real build once per test. No generated worker, mocked lifecycle,
  // bundle rewriting, or disk mutation; concurrent preview servers are independent.
  const root = resolve("dist");
  const files = new Map<string, Buffer>();
  async function snapshot(directory = "") {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await snapshot(relative);
      else if (entry.isFile()) files.set(relative, await readFile(resolve(root, relative)));
    }
  }
  await snapshot();
  const currentHTML = files.get("index.html")?.toString("utf8");
  const currentSW = files.get("sw.js")?.toString("utf8");
  if (!currentHTML || !currentSW) throw new Error("Build dist/index.html and dist/sw.js before running this spec.");
  if (currentHTML.includes('name="test-version"')) throw new Error("The production build already contains a test-version marker.");
  const initialHTML = currentHTML.replace("</head>", `<meta name="test-version" content="A" data-build="${randomUUID()}"></head>`);
  if (initialHTML === currentHTML) throw new Error("Could not mark the initial built HTML.");
  const initialRevision = createHash("sha256").update(initialHTML).digest("hex");
  let replaced = 0;
  const initialSW = currentSW.replace(
    /(\{\s*(?:"url"|url)\s*:\s*"index\.html"\s*,\s*(?:"revision"|revision)\s*:\s*")[^"]*(")/g,
    (_entry, before: string, after: string) => { replaced++; return before + initialRevision + after; },
  );
  if (replaced !== 1 || initialSW === currentSW) throw new Error("Expected exactly one built index.html precache revision.");
  let version: "A" | "B" = "A";
  const httpErrors: string[] = [];
  const types: Record<string, string> = {
    ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
    ".json": "application/json", ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml", ".png": "image/png", ".wav": "audio/wav",
    ".woff2": "font/woff2", ".ico": "image/x-icon",
  };
  const server = createServer((request, response) => {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname); }
    catch { httpErrors.push("Malformed request path"); response.writeHead(400).end(); return; }
    const relative = pathname.startsWith(scope) ? pathname.slice(scope.length) || "index.html" : "";
    // Exact map lookup also prevents decoded traversal from escaping the build.
    const body = version === "A" && relative === "index.html" ? Buffer.from(initialHTML)
      : version === "A" && relative === "sw.js" ? Buffer.from(initialSW) : files.get(relative);
    if (!body) { httpErrors.push(`404 ${pathname}`); response.writeHead(404).end(); return; }
    response.writeHead(200, {
      "Content-Type": types[extname(relative)] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      ...(relative === "sw.js" ? { "Service-Worker-Allowed": scope } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); accept(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a random TCP port.");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, baseURL: origin + scope, httpErrors,
    deployCurrent: () => { version = "B"; },
    close: () => new Promise<void>((accept, reject) => {
      server.close(error => error ? reject(error) : accept());
      server.closeAllConnections();
    }),
  };
}

async function savedAnswer(page: Page) {
  return page.evaluate(id => new Promise<string | undefined>((accept, reject) => {
    const request = indexedDB.open("jove-english-os");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction("sessions").objectStore("sessions").getAll();
      read.onsuccess = () => {
        const sessions = read.result as { id: string; draft: { activeSessionId?: string; answer?: string } }[];
        const pointer = sessions.find(row => row.id === `listen-active:${id}`);
        const session = sessions.find(row => row.id === pointer?.draft.activeSessionId);
        accept(session?.draft.answer);
        database.close();
      };
      read.onerror = () => { reject(read.error); database.close(); };
    };
  }), materialId);
}

for (const controlledReload of [false, true]) {
  test(controlledReload
    ? "PWA explicit update preserves a draft on a controlled page after reload"
    : "PWA explicit update preserves a draft on the first uncontrolled document without reloading it", async ({ page }) => {
    const host = await serveUpgrade();
    const pageErrors: string[] = [], consoleErrors: string[] = [], externalRequests: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("request", request => {
      if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== host.origin) externalRequests.push(request.url());
    });
    try {
      await page.addInitScript(() => {
        // Observation only. Never synthesize controllerchange, skipWaiting or registration events.
        window.__jovePwaUpdateDocument = {
          id: crypto.randomUUID(), controlledAtBoot: !!navigator.serviceWorker.controller, controllerChanges: 0,
        };
        navigator.serviceWorker.addEventListener("controllerchange", () => { window.__jovePwaUpdateDocument.controllerChanges++; });
      });
      await page.goto(host.baseURL + `#/listen?material=${materialId}`);
      await expect(page.locator("#meaning")).toBeVisible();
      await expect(page.locator(marker)).toHaveAttribute("content", "A");
      const original = await page.evaluate(() => window.__jovePwaUpdateDocument);
      expect(original.controlledAtBoot).toBe(false);
      const initialDraft = "The bus is delayed; meet at the cafe or try the bakery.";
      await page.locator("#meaning").fill(initialDraft);
      await expect.poll(() => savedAnswer(page)).toBe(initialDraft);
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      const claimed = await page.evaluate(() => window.__jovePwaUpdateDocument);
      expect(claimed.id).toBe(original.id);
      expect(claimed.controlledAtBoot).toBe(false);
      expect(claimed.controllerChanges).toBeGreaterThan(0);
      await expect(page.locator(marker)).toHaveAttribute("content", "A");
      await expect(page.locator("#meaning")).toHaveValue(initialDraft);

      // This is the ONLY preparatory reload. The first-open variant must retain
      // the Workbox instance that registered before any controller existed.
      if (controlledReload) {
        await page.reload();
        await expect(page.locator("#meaning")).toHaveValue(initialDraft);
        const reloaded = await page.evaluate(() => window.__jovePwaUpdateDocument);
        expect(reloaded.id).not.toBe(original.id);
        expect(reloaded.controlledAtBoot).toBe(true);
      }
      const beforeUpdate = await page.evaluate(() => window.__jovePwaUpdateDocument);
      expect(beforeUpdate.controlledAtBoot).toBe(controlledReload);
      await expect(page.locator(marker)).toHaveAttribute("content", "A");
      const updateButton = page.getByRole("button", { name: "Update now", exact: true });
      await expect(updateButton).toHaveCount(0);
      host.deployCurrent();
      await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
      await expect(updateButton).toBeVisible();
      await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe("installed");

      // A short observation window asserts the ABSENCE of automatic refresh;
      // lifecycle readiness itself is synchronized by waiting/visible assertions above.
      await page.waitForTimeout(750);
      const finalDraft = initialDraft + " Keep this additional thought typed while the update prompt is open.";
      await page.locator("#meaning").fill(finalDraft);
      await expect.poll(() => savedAnswer(page)).toBe(finalDraft);
      await expect(page.locator(marker)).toHaveAttribute("content", "A");
      expect((await page.evaluate(() => window.__jovePwaUpdateDocument)).id).toBe(beforeUpdate.id);
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // The application owns the reload. Poll a complete new document and draft
      // together: a temporarily empty DOM or a destroyed execution context is not success.
      await expect.poll(async () => {
        try {
          return await page.evaluate(({ previousId, answer }) => document.readyState === "complete"
            && window.__jovePwaUpdateDocument.id !== previousId
            && window.__jovePwaUpdateDocument.controlledAtBoot
            && !document.querySelector('meta[name="test-version"]')
            && (document.querySelector("#meaning") as HTMLTextAreaElement | null)?.value === answer,
          { previousId: beforeUpdate.id, answer: finalDraft });
        } catch (error) {
          if (/Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation/.test(String(error))) return false;
          throw error;
        }
      }, { timeout: 15000 }).toBe(true);
      await expect(page.locator(marker)).toHaveCount(0);
      await expect(page.locator("#meaning")).toBeVisible();
      await expect(page.locator("#meaning")).toHaveValue(finalDraft);
      expect(await savedAnswer(page)).toBe(finalDraft);
      await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(false);
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(host.httpErrors).toEqual([]);
      expect(externalRequests).toEqual([]);
    } finally {
      await page.close();
      await host.close();
    }
  });
}

async function savedSpeakingWork(page: Page) {
  return page.evaluate(async () => {
    type Session = { draft: { text?: string; audioId?: string } };
    type Asset = { id: string; kind: string; blob: Blob; mimeType: string; duration: number };
    const saved = await new Promise<{ session?: Session; assets: Asset[] }>((accept, reject) => {
      const request = indexedDB.open("jove-english-os");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(["sessions", "audio"]);
        let session: Session | undefined;
        let assets: Asset[] = [];
        const readSession = transaction.objectStore("sessions").get("speak-draft");
        const readAudio = transaction.objectStore("audio").getAll();
        readSession.onsuccess = () => { session = readSession.result; };
        readAudio.onsuccess = () => { assets = readAudio.result; };
        transaction.oncomplete = () => { database.close(); accept({ session, assets }); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
    const recordings = await Promise.all(saved.assets.filter(asset => asset.kind === "recording").map(async asset => ({
      id: asset.id, size: asset.blob.size, duration: asset.duration, mimeType: asset.mimeType,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await asset.blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join(""),
    })));
    return { text: saved.session?.draft.text, audioId: saved.session?.draft.audioId, recordings };
  });
}

test("PWA cancelled beforeunload recovers Update now and retries without losing the original recording", async ({ page }) => {
  const host = await serveUpgrade();
  const pageErrors: string[] = [], consoleErrors: string[] = [], externalRequests: string[] = [];
  const dialogs: string[] = [], dialogErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== host.origin) externalRequests.push(request.url());
  });
  // Handle the real browser dialog raised by Recorder's beforeunload guard.
  // Unexpected repeat dialogs are also dismissed so failures leave the work intact.
  page.on("dialog", async dialog => {
    dialogs.push(dialog.type());
    try { await dialog.dismiss(); }
    catch (error) { dialogErrors.push(String(error)); }
  });
  try {
    await page.addInitScript(() => {
      window.__jovePwaUpdateDocument = {
        id: crypto.randomUUID(), controlledAtBoot: !!navigator.serviceWorker.controller, controllerChanges: 0,
      };
      navigator.serviceWorker.addEventListener("controllerchange", () => { window.__jovePwaUpdateDocument.controllerChanges++; });
    });
    await page.goto(host.baseURL + "#/speak");
    await page.getByRole("button", { name: "Start conversation", exact: true }).click();
    const response = "Please keep my unsent response and the recording I am about to make.";
    await page.locator("#speak-response").fill(response);
    await expect.poll(async () => (await savedSpeakingWork(page)).text).toBe(response);
    const original = await page.evaluate(() => window.__jovePwaUpdateDocument);
    expect(original.controlledAtBoot).toBe(false);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    expect((await page.evaluate(() => window.__jovePwaUpdateDocument)).id).toBe(original.id);
    await expect(page.locator(marker)).toHaveAttribute("content", "A");
    host.deployCurrent();
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
    const updateButton = page.getByRole("button", { name: "Update now", exact: true });
    await expect(updateButton).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe("installed");

    const recorder = page.locator(".conversation-composer .record-button");
    const captureStatus = page.locator(".conversation-composer .record-status");
    await recorder.click();
    await expect(recorder).toHaveText("Stop & save");
    await expect(captureStatus).toContainText(/[1-9]\d*s \/ 180s/);
    const secondsBeforeUpdate = Number.parseInt(await captureStatus.innerText(), 10);
    await updateButton.click();
    await expect.poll(() => dialogs).toEqual(["beforeunload"]);
    // The reload-cancellation recovery is 2s, not the 15s activation deadline.
    await expect(page.getByRole("status").filter({ hasText: "The page did not refresh." })).toBeVisible({ timeout: 6000 });
    await expect(updateButton).toBeEnabled({ timeout: 6000 });
    await expect(page.locator(marker)).toHaveAttribute("content", "A");
    expect((await page.evaluate(() => window.__jovePwaUpdateDocument)).id).toBe(original.id);
    await expect(page.locator("#speak-response")).toHaveValue(response);
    await expect(recorder).toHaveText("Stop & save");
    await expect(recorder).toBeEnabled();
    await expect.poll(async () => Number.parseInt(await captureStatus.innerText(), 10)).toBeGreaterThan(secondsBeforeUpdate);
    expect((await savedSpeakingWork(page)).recordings).toHaveLength(0);
    // Activation succeeded despite the cancelled navigation: retry must handle no waiting worker.
    await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(false);

    await recorder.click();
    await expect(recorder).toHaveText("Record again");
    await expect(recorder).toBeEnabled();
    await expect.poll(async () => {
      const work = await savedSpeakingWork(page);
      return work.recordings.length === 1 && work.recordings[0]?.id === work.audioId;
    }).toBe(true);
    const saved = await savedSpeakingWork(page);
    expect(saved.text).toBe(response);
    expect(saved.recordings[0]!.size).toBeGreaterThan(0);
    expect(saved.recordings[0]!.duration).toBeGreaterThan(0);
    expect(saved.recordings[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(updateButton).toBeEnabled();
    await updateButton.click();
    await expect.poll(async () => {
      try {
        return await page.evaluate(({ previousId, text }) => document.readyState === "complete"
          && window.__jovePwaUpdateDocument.id !== previousId
          && window.__jovePwaUpdateDocument.controlledAtBoot
          && !document.querySelector('meta[name="test-version"]')
          && (document.querySelector("#speak-response") as HTMLTextAreaElement | null)?.value === text,
        { previousId: original.id, text: response });
      } catch (error) {
        if (/Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation/.test(String(error))) return false;
        throw error;
      }
    }, { timeout: 15000 }).toBe(true);
    await expect(page.locator(marker)).toHaveCount(0);
    await expect(page.locator("#speak-response")).toHaveValue(response);
    await expect(page.locator(".conversation-composer .recording-playback")).toBeVisible();
    expect(await savedSpeakingWork(page)).toEqual(saved);
    expect(dialogs).toEqual(["beforeunload"]);
    expect(dialogErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(host.httpErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    await page.close();
    await host.close();
  }
});
