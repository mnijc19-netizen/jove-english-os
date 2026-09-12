# Architecture

September13 delivery amendment: curated external lesson metadata uses the existing Material/Listen/planner/session/sync architecture. Publisher media opens externally; the app stores original learning prompts and learner work, not copied publisher audio or transcripts. Normal practice no longer invokes automatic acoustic assessment. See `FINAL_UPGRADE.md` for current scope and partial-release boundaries.

Vue 3/TypeScript/Vite SPA, hash-history Vue Router, Pinia UI state, Dexie IndexedDB persistence, Zod validation, mature ts-fsrs scheduling, Vitest integration/unit tests and Playwright browser tests. CSS variables express the small design system without a second styling dependency. GitHub Actions publishes Vite dist to GitHub Pages at `/jove-english-os/`; PWA scope/start URL share that base.

`src/domain/types.ts` defines shared serializable entities. `src/domain/engine.ts` computes evidence aggregation, modality-specific review scheduling and deterministic plans. `src/db/` provides migration/bootstrap, atomic learning updates and backup. `src/ai/` defines provider contracts, schemas and OpenRouter implementation. `src/audio/` handles capture, PCM conversion, replay and speech. `src/content/` holds reviewed demo material and import helpers. `src/stores/` coordinates persistent state for Vue. `src/pages/` owns task flows; components provide reusable accessible controls.

All timestamps in persisted domain data are epoch milliseconds, except mature FSRS Card fields which are restored to Date instances at the boundary. Events have unique IDs and measured vs self-report vs AI vs text evidence provenance. Store events and their projections atomically. Prompts and model output never update settings or execute HTML. Keys live in a separate secrets table, are read only immediately around first-party provider requests and are never serialized in backups. Do not cache authenticated API traffic in the SW.

Use persisted learning-session drafts and conversation history to survive reload/errors. Capture audio before network calls. Provider failures preserve recordings and text, expose retry/cancel/skip/settings routes. Audio blobs have metadata for retention; delete generated cache only by policy and never discard unprocessed user recordings silently.

Content has source kind, provenance, approval, transcript, sentence structure, comprehension keys, chunks and synthetic/real audio labeling. Retain approved excerpts/user inputs, not mirrored paid libraries. Imported text renders with Vue escaping, URLs accept only HTTP(S), no executable DOM.

The deterministic planner balances weaknesses/due work/new input/fluency with minimum speaking and strain-aware duration. AI chooses phrasing, explanations and context variants within task constraints. Evidence scores express estimates with counts/confidence, not calibrated proficiency or phoneme measurements.

Verify deployment exact commit + successful Actions + public URL + fresh-browser journey. Existing visibility cannot be changed without owner authorization. Never add runtime secrets to Actions or static builds.

## Final-upgrade architecture boundary

Retain this SPA/Dexie/Pages architecture. Add a dedicated Supabase backend (never reuse another project's backend): Auth, append-only RLS-owned sync operations/events, private Storage, authenticated AI/Speech functions and scheduled content processing. The browser retains local learning and an offline journal; upload/download/merge rebuild derived evidence instead of replacing a whole database. Server-only production keys supersede the browser-only key rule for normal operation. Public frontend configuration may contain only project URL and publishable key. Entity/draft conflicts and audio retention must be specified/tested before production. Full requirement map: `FINAL_UPGRADE.md`.
