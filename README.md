# Jove Language OS

Formerly Jove English OS. The display name is evolving; the repository, public URL, PWA scope and existing English learning data stay unchanged. English is currently available; Japanese is approved future work, not an enabled course yet. The current objective and ordered acceptance gates are in `docs/FINAL_UPGRADE.md`.

A personal, local-first English trainer focused on natural listening and spontaneous speaking. It connects input, comprehension, chunks, retrieval, conversation, correction, delayed review and new-context transfer. Learning estimates carry evidence; completing a page never establishes mastery.

## Start learning

Website: [Jove Language OS](https://mnijc19-netizen.github.io/jove-english-os/). Release verification is recorded in `docs/STATUS.md`.

**Release boundary:** the final-upgrade worktree is not yet production-accepted. The public website still serves the accepted V1 runtime. Account synchronization, automated authentic content and acoustic practice described below must not be treated as live until the exact release and production journeys are recorded in `docs/STATUS.md`.

### Account-enabled first use (release acceptance pending)

1. Open **Settings → Learning account** on each device and use the same owner's email sign-in code. Registration is not public. Normal AI/Speech credentials are configured once on the backend, never separately on each device.
2. First binding journals and merges existing local work; successful synchronization does not delete the local copy. Wait for **Synced** before expecting another device to have the latest work. Offline work remains local until reconnect; selected recording uploads can take longer than text records.
3. Open **Today** and start the proposed session. Time, energy, goals and interests remain yours; material, practice order and reviews are the system's responsibility. **Library** import is optional, not the normal course-supply requirement.
4. Initial offline use needs the app shell and audio to finish downloading. Only actually cached material/recordings are available offline; AI analysis requires a connection. Uncached verified clips can play online with an explicit not-saved-offline notice.
5. Keep important original recordings separately if needed. Cloud retention is bounded, not an unlimited archive. Account budgets and unknown-cost holds appear separately in Settings; zero budget stops new paid requests, not local practice.

### Current public V1 / no-account fallback

1. Open the deployed site and choose **Find my starting point**. No account or API key is needed for the bundled practice.
2. Complete the short baseline or skip unobserved speech. Choose 45, 90 or 150 minutes on **Today**, then follow the practice path.
3. Listen before revealing the transcript. Save useful chunks, express your own meaning, and return when separate review cards are due.
4. For personalized AI, open **Settings**, enter a dedicated limited OpenRouter key, test the connection, refresh the model list and choose text/STT/TTS models. Keys are entered only in your browser, never in a source file or build environment.
5. Export a JSON backup regularly. Download important recordings from **Library** separately. Install through your browser's app / Add to Home Screen menu where supported.

On the first visit, stay online until **Ready for offline practice** appears in the footer. The app needs to download its bundled audio before offline playback is available. If you kept an early pre-release tab open, save your work and refresh it once to load the corrected update handler.

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
npx playwright install chromium webkit
npm run test:e2e
npm run build:functions
npm run check:cloud-local
npm run check:edge-local
npm run check:security
npm audit --audit-level=high
```

Unit/integration tests exercise deterministic scheduling, separate FSRS modalities, evidence boundaries, database migration/backup, provider contracts, audio and recovery. Playwright exercises desktop/mobile Chromium and desktop/mobile WebKit, plus separate native-recorder/PCM/mobile-UX projects. Synthetic microphone input and mocked providers do not validate physical microphones, actual iPhone Safari or paid AI quality. Linux WebKit is required for the full media matrix; a Windows limitation is not a passing result.

`check:cloud-local` validates only this project's Docker backend (API 55321, database 55322), reads back migrations and runs four SQL suites inside rolled-back transactions. It does not print local credentials. The optional `--start` starts/applies migrations to that dedicated local stack, never a linked cloud project. Separate real HTTP tests use `JOVE_LOCAL_CLOUD_TEST=1`; real content persistence uses `JOVE_CONTENT_LOCAL_TEST=1`. Multi-browser account journeys use `JOVE_LOCAL_BROWSER_TEST=1` and require the matching browser executables. These checks are not production acceptance.

For `check:edge-local`, first build functions and serve this dedicated local project with `node node_modules/supabase/dist/supabase.js functions serve` in a separate terminal. The checker verifies the local project, waits for all three actual handlers, then tests real Auth/private Storage/reference withdrawal. It makes no paid provider calls. CI owns and stops only its own functions-serving process.

To run the general UI browser suite against a deployment, set `PLAYWRIGHT_BASE_URL` to its base URL including the final slash, then run `npm run test:e2e`. This does **not** retarget the strictly local account/sync fixtures to production. Hosted OTP, independent-device sync and private audio require separate legitimate-owner journeys described in `docs/OPERATIONS.md`. No test may enter a real provider key.

## Deployment and maintenance

`.github/workflows/deploy.yml` runs clean install, static/unit checks, dedicated local SQL/HTTP tests, server/frontend builds and Chromium/WebKit checks before uploading `dist` to GitHub Pages. Configure Pages to use **GitHub Actions**. PRs verify without deployment; main/manual releases additionally require valid public cloud configuration. Missing configuration fails the build instead of replacing the accepted site with an account-disabled upgrade. Actions remain pinned to upstream commits.

The `codex/final-upgrade` branch also runs the full CI verification without publishing Pages or requiring an already-provisioned production target. Only `main` can upload/deploy a Pages artifact, and it must pass the production hold below.

Main publication also requires a commit-bound, exact-project, less-than-24-hour readiness approval. The hold is checked both before artifact upload and immediately before every Pages deployment attempt, including job retries. Anonymous handler responses establish routing/sign-in rejection only, not owner/provider readiness. The operator must complete actual backend readback before issuing approval; CI never approves itself. See `docs/OPERATIONS.md` for activation, revocation and production acceptance.

Only repository variables `JOVE_SUPABASE_URL` and `JOVE_SUPABASE_PUBLISHABLE_KEY` enter the Vite build. The exact HTTPS account origin is appended to the existing connection policy; media remains same-origin/blob and no wildcard is added. Local development may use only the dedicated loopback backend. `JOVE_REQUIRE_CLOUD=1` enforces a configured release; `JOVE_LOCAL_CLOUD_TEST=1` is solely for isolated local builds/tests and must not be set on a Pages release.

The dedicated production backend must exist before publication. Apply this project's migrations there, provision the single owner and membership, keep Storage private, and deploy the bundled `ai`, `content` and `speech-assess` functions. Production provider credentials belong only to server secrets: OpenRouter, Speech and the scheduled-job token must never be copied to GitHub variables, Vite, learning exports or logs. Each handler verifies the session and membership even though legacy gateway JWT verification is disabled.

Operational acceptance also requires verified server model/pricing configuration; actual Speech resources and reviewed General American reference artifacts; a Vault-backed content schedule with actual execution/readback; real eligible human lessons reaching Today; private recording retention and usage readback. See `docs/SYNC.md`, `docs/CONTENT_PIPELINE.md` and `docs/SPEECH.md` for the exact contracts. A successful frontend release cannot substitute for any of these backend gates. Never reuse another project's backend.

The router, Vite base, asset paths, manifest start URL and service-worker scope must retain the same project subpath. If the repository name changes, update and verify all of them. Browser data belongs to the site origin; changing host or browser does not automatically migrate it. Back up before moving.

Wait for a successful workflow and verify its commit, then exercise the actual public URL in a fresh browser. A local build does not prove deployment. On an app update, finish/save your response before accepting the refresh prompt. Database migrations must remain backward-data-safe and tested.

Official deployment references: [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [Vite static deployment](https://vite.dev/guide/static-deploy.html).

## Data, privacy and limits

- IndexedDB remains the offline learning store. The account-enabled release adds owner-isolated event synchronization and bounded private recording storage; the current public V1 still has no automatic sync. No analytics or telemetry are added. Clearing site data can delete unsynced work; persistence is requested but cannot be guaranteed.
- JSON backup restores learning records, nonsecret settings and schedules. It excludes keys and audio blobs. Recordings are original user work, not disposable synthesis cache; keep downloaded originals separately. Do not assume a JSON file contains your recordings.
- Browser BYOK is an optional advanced fallback, isolated from normal server-only production keys. A browser-saved key is not protected against malicious same-origin code. Keep untrusted material escaped; authenticated API traffic is not cached by the service worker.
- Normal account AI/STT/TTS uses server-configured providers with only the necessary current task material/audio. Acoustic practice uses the separate speech engine; STT and LLM feedback are not acoustic measurements. BYOK model choices and clearly labeled local/synthetic fallback remain advanced paths. Unreviewed synthetic voices cannot qualify as formal pronunciation references.
- Local spending totals use costs reported by the provider; unknown costs remain unknown. The application limit is not a replacement for the provider's hard spending cap.
- No API key is required for basic demo listening, saved content, reviews, recordings and scripted practice. Adaptive conversations, transcription, generated speech and personal evaluation need an available configured service. Network failures retain saved input.
- Text or STT transcription does not establish pronunciation, prosody or acoustic fluency. Those dimensions remain unscored without reliable measurement. AI language/rubric estimates and self-reflections are labeled separately. Rotating check-ins are not standardized equivalent tests or guaranteed learning outcomes.

Architecture, content provenance and research limitations are documented in `docs/ARCHITECTURE.md`, `docs/CONTENT.md` and `docs/LEARNING_SCIENCE.md`. Current release evidence and unresolved work are in `docs/STATUS.md`.
