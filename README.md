# Jove English OS

A personal, local-first English trainer focused on natural listening and spontaneous speaking. It connects input, comprehension, chunks, retrieval, conversation, correction, delayed review and new-context transfer. Learning estimates carry evidence; completing a page never establishes mastery.

## Start learning

Website: [Jove English OS](https://mnijc19-netizen.github.io/jove-english-os/). Release verification is recorded in `docs/STATUS.md`.

1. Open the deployed site and choose **Find my starting point**. No account or API key is needed for the bundled practice.
2. Complete the short baseline or skip unobserved speech. Choose 45, 90 or 150 minutes on **Today**, then follow the practice path.
3. Listen before revealing the transcript. Save useful chunks, express your own meaning, and return when separate review cards are due.
4. For personalized AI, open **Settings**, enter a dedicated limited OpenRouter key, test the connection, refresh the model list and choose text/STT/TTS models. Keys are entered only in your browser, never in a source file or build environment.
5. Export a JSON backup regularly. Download important recordings from **Library** separately. Install through your browser's app / Add to Home Screen menu where supported.

The six original demo scripts use clearly labeled synthetic speech. They are useful offline practice, not a validated measure of natural-speaker comprehension. Import recordings you have permission to use to practice authentic speech. URL access is best-effort; paste the text when retrieval is restricted. No paywall, login or DRM bypass is provided.

## Run locally

Use Node.js 24 and npm. Run from this project directory:

```sh
npm ci
npm run dev
```

Vite prints the local URL. The application uses `/jove-english-os/` and hash routes. For the production build and service-worker behavior:

```sh
npm run build
npm run preview
```

Open `http://127.0.0.1:4173/jove-english-os/`. Browser microphone access requires localhost or HTTPS. The preview server is a local verification tool, not a production server.

## Verify changes

Read `AGENTS.md` and the five permanent specification documents before making changes. Preserve the complete learning loop and update `docs/STATUS.md` with actual evidence.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run check:security
npm audit --audit-level=high
```

Unit/integration tests exercise deterministic scheduling, separate FSRS modalities, evidence boundaries, database migration/backup, provider contracts, audio and recovery. Playwright exercises the built app on desktop and mobile Chromium; synthetic test microphone input and explicit mock-provider responses are not live AI validation. See `docs/PROVIDER.md` for the optional public catalog check and paid-call boundaries.

To run the same browser journeys against a deployment, set `PLAYWRIGHT_BASE_URL` to its base URL including the final slash, then run `npm run test:e2e`. No test may enter a real key. Each test uses an isolated browser context.

## Deployment and maintenance

`.github/workflows/deploy.yml` runs clean install, checks, tests and build before uploading the verified `dist` artifact and deploying through GitHub Pages. Configure Pages to use **GitHub Actions**. Push to `main` to deploy; PRs run verification without deployment. Actions are pinned to verified upstream commits.

The router, Vite base, asset paths, manifest start URL and service-worker scope must retain the same project subpath. If the repository name changes, update and verify all of them. Browser data belongs to the site origin; changing host or browser does not automatically migrate it. Back up before moving.

Wait for a successful workflow and verify its commit, then exercise the actual public URL in a fresh browser. A local build does not prove deployment. On an app update, finish/save your response before accepting the refresh prompt. Database migrations must remain backward-data-safe and tested.

Official deployment references: [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [Vite static deployment](https://vite.dev/guide/static-deploy.html).

## Data, privacy and limits

- Learning records and recordings are kept in IndexedDB. There are no accounts, analytics, telemetry or automatic cloud synchronization. Clearing site data can delete them; browser storage persistence is requested but cannot be guaranteed.
- JSON backup restores learning records, nonsecret settings and schedules. It excludes keys and audio blobs. Recordings are original user work, not disposable synthesis cache; keep downloaded originals separately. Do not assume a JSON file contains your recordings.
- A saved key is not protected against malicious same-origin code. Use a dedicated key with a small provider-enforced cap. Keep untrusted material as escaped text. No API traffic containing credentials is cached by the service worker.
- AI/STT/TTS sends only the current task's necessary material or audio to OpenRouter and its selected provider. Explicit model selection is required; a configured compatible alternate text model can be used on failure. Browser voice fallback is local-only; voice availability differs by device.
- Local spending totals use costs reported by the provider; unknown costs remain unknown. The application limit is not a replacement for the provider's hard spending cap.
- No API key is required for basic demo listening, saved content, reviews, recordings and scripted practice. Adaptive conversations, transcription, generated speech and personal evaluation need an available configured service. Network failures retain saved input.
- Text or STT transcription does not establish pronunciation, prosody or acoustic fluency. Those dimensions remain unscored without reliable measurement. AI language/rubric estimates and self-reflections are labeled separately. Rotating check-ins are not standardized equivalent tests or guaranteed learning outcomes.

Architecture, content provenance and research limitations are documented in `docs/ARCHITECTURE.md`, `docs/CONTENT.md` and `docs/LEARNING_SCIENCE.md`. Current release evidence and unresolved work are in `docs/STATUS.md`.
