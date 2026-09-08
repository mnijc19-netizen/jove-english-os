# Local-first synchronization

The eleven findings from the initial independent review have executable fixes and regressions. Dedicated local SQL/HTTP verification, core sync/Settings independent review, the additional Review identity review, and local Chromium/Firefox/WebKit account journeys have passed. No production-sync or physical-iPhone acceptance is claimed.

## Durable protocol

The existing learning database advances from Dexie schema 2 to 3 by adding only `syncOperations`, `syncSnapshots`, and `syncMeta`. Schema 1→2 remains executable. Existing settings, events, audio and FSRS data are retained. Portable learning backups remain schema 2; account sessions, device identity, transport journals and credentials are not exported.

Source operations are immutable, including original timestamps and legacy card states. Materialized aliases and derived projections may be reconciled only after their sources have been captured in the same transaction. On first account binding, legacy learning is journaled without deleting the source. A fresh unlearned device does not publish untouched default settings/profile over its account; their first genuine edit publishes a complete initial put. Full validated entity records plus changed-field paths form immutable operations. Logical/device/operation ordering arbitrates edits. Missing initial baselines can provisionally use the complete source record, then the whole union is folded again as earlier operations arrive.

Before applying a remote page, capture local changes in the same Dexie transaction. Native SHA-256 work uses `Dexie.waitFor` to keep that transaction alive. Uploaded acknowledgements never advance the download cursor. A failed request leaves its outbox intact; identity/schema/receipt/merge failures roll back operations, snapshots, projections and cursor together. Identical receipts are idempotent; contradictory receipts and clocks above the receipt cursor fail closed. Audio metadata is independent of private blob transfer; no placeholder blobs are created.

## Fields, tombstones and references

- Empty objects changing to branches do not generate parent deletions. Existing faulty marker patches are also interpreted safely: actual deletions precede writes and cannot erase a still-present branch. FSRS fields are atomic before replay; plan minutes are recomputed from winning tasks, and completed task flags are unioned.
- A delete survives later sparse edits. Only a complete put after it constitutes recreation. Discarded sparse edits remain in source operations and conflict metadata for recovery. Recreation starts a new card baseline generation.
- Referenced tombstones retain their complete dependency record, with `syncMeta.tombstones[].retained=true`; these are archived dependencies, not successful physical erasures. Missing dependencies remain staged in the immutable log and explained in `syncMeta.deferred`, until subsequent pages can safely materialize their dependents. Event/card modality mismatches remain deferred rather than becoming evidence.
- Materialization replaces snapshots atomically, including removal of remotely deleted snapshots. It never echoes a remote tombstone as a fresh local operation. Obsolete event collision aliases are reconciled without deleting any source operations.

## Canonical events and legacy FSRS

`eventOccurrenceKey` is SHA-256 of the canonical original event, excluding only local `audioAvailable`. Native Web Crypto requires no new dependency. All differing variants of a colliding source ID receive content-derived suffixes, independent of duplicate operation selection or arrival order. Duplicate copies use the earliest observed server receipt to normalize future timestamps; originals remain in source operations and projected `clientTimestamp`. Receipt normalization does not change the occurrence key.

New card baselines carry `baseEventKeys`, resolving aliases through `syncMeta.eventKeys`. Legacy `baseEventIds` map to the originating device's latest matching event before that baseline; unambiguous global/old-alias matches are a fallback. Missing or ambiguous occurrences remain explicit pending dependencies.

Legacy arbitrary card IDs materialize under deterministic chunk/modality IDs (a SHA-256 fallback handles very long chunk IDs). `syncMeta.cardAliases` maps old IDs to those targets; projected event and draft `cardId` references are remapped together, before inserting into Dexie's unique chunk/modality index. Old card IDs, source records and event occurrence hashes remain unchanged in the operation log. Main should refresh active views/drafts from the merged database and use this alias map when resolving a previously held card ID.

`syncMeta.eventAliases` maps each original event ID to its materialized occurrence IDs. `resolveEventAliases(database, id): Promise<string[]>` returns the original plus those aliases; this lookup is not evidence by itself. A caller must still verify the actual event type, canonical card identity and attempt payload. Main's `reviewCard` checks this evidence before its expected-repetitions guard; advanced counters without the same proven attempt now throw instead of silently succeeding.

New Review selections save UUID `attemptId`, `responseEventId` and `draftId` before submitting any evidence. FSRS replay can change counters without changing these IDs or losing the open draft. Old counter-shaped selections preserve their original identities before card canonicalization. An already-upgraded block missing those IDs can recover its binding from the immutable items-field source, only when the current card/reps selection matches and the source itself establishes an original identity. Neither alias insertion order nor the mere existence of already-canonical raw history proves that identity. Ambiguous old selections retain every draft/recording and ask for original block-history recovery, rather than inventing IDs or choosing another attempt's draft.

Completed blocks require real review events for the selected attempt, including that attempt's collision aliases; missing cards, other old-card attempts and unrelated reviews never imply completion. Existing response evidence is reused on retry, and block/task completion can recover after reload or remote merge. Six actual-SFC/Dexie/repository regressions, a separate independent review, and real cross-profile browser journeys cover these paths.

When complete review history accounts for baseline repetitions, FSRS rebuilds from an empty state and the canonical chronological occurrence union, with fuzz disabled. Tests compare complete scheduler states, not just repetition counts. Opaque legacy progress is retained as a seed and represented occurrences are excluded. Earlier unrepresented events or incomparable opaque snapshots cannot be reliably inverted: they retain the original seed and set a recovery reason instead of inventing history. Future baseline `last_review` and `due` are normalized consistently with receipt time. The next independent review must include opaque-history recovery and its eventual owner-facing flow.

Authenticated RPC writes are per-owner serialized through transaction commit, avoiding identity-sequence cursor holes from concurrently committing uploads. Clients cannot update/delete the operation log. Postgres derives the owner from `auth.uid()`; clients cannot submit it. Membership is provisioned server-side and cannot be self-enrolled. Recordings are private, scoped by owner UUID, and not bundled into JSON operations. No other project's cloud resources are used.

## Session and interface

Email OTP, no public registration, persistent browser auth, no magic-link hash collision. Normal AI keys will be server-only; session credentials are separate from learning/export data. The same learning account is required on each device. Cross-account binding fails closed. Signing out preserves owner-bound local work; use a private device. Status: Synced / Syncing / Offline / Sync problem. Foreground timer, focus and reconnect trigger automatic retries. Public configuration is only `VITE_SUPABASE_URL` plus `VITE_SUPABASE_PUBLISHABLE_KEY`; a service-role key is rejected by the client initializer.

Before and after each learning request, `getUser(token)` validates the journal principal and the active SDK token must remain unchanged. That exact validated token is fixed on the PostgREST builder's Authorization header, so switching the SDK session during dispatch cannot upload A's work as B. Refresh/switch/revocation discards the response and preserves retryable work. Tokens stay ephemeral and never enter journals, diagnostics, errors or exports. Installed PostgREST `setHeader` and Supabase `fetchWithAuth` were inspected; explicit Authorization is preserved.

Interfaces changed for main-task integration:

```ts
projectOperations(operations): Promise<Projection>
eventOccurrenceKey(record): Promise<string>
journal.owner(): Promise<string>
remote.upload(operations, owner): Promise<Receipt[]>
remote.download(cursor, owner): Promise<StoredOperation[]>
synchronize(journal, remote): Promise<{
  pending: number; downloaded: number; hasMore: boolean;
  deferred: number; conflicts: number;
}>
```

The cloud store presents complete sync only when `pending === 0 && !hasMore && deferred === 0` AND private audio has no pending retention, transfer or blocked-original state. `hasMore` means the bounded metadata loop saved a checkpoint and another run is needed. Continue downloading before treating unresolved references as permanently missing. Direct HTTP/adapter tests must supply owner; legacy SDK fakes must support `.setHeader()`. Canonical card aliases are exposed by the store and `resolveCardAlias(database, id)`; repository transactions using the resolver must include `syncMeta`.

## Fixed-principal requests, reset fences and recording retention

`bindSyncAccess(sourceClient, ownerId, publicConfig, assertLocal)` validates the exact JWT via Auth, then constructs an isolated client whose Authorization cannot follow SDK account changes. Its fetch wrapper checks the original token and local principal before/after every metadata and Storage request. Tokens remain in closures only. `SyncAccess` has `{ ownerId, client, assertCurrent }`; its client must be immutable, not the shared session-mutating application client. Audio upload/download accept this access as their first argument; they no longer accept independent client/owner arguments.

The store validates membership before binding legacy local data. `pause(): Promise<void>` immediately fences new requests and waits for in-flight work. `beforeLocalReset(): Promise<void>` is a lower-level pause/capture hook, not a license to clear account history. Settings uses `withLocalDataChange<T>(change: () => Promise<T>): Promise<T>`: it fences pending sync, runs the database-only callback in one all-table transaction, rejects owner/journal/private-original tampering, reconciles older imported data without deletion tombstones, and resumes only when a newer manual pause/stop has not superseded it. A failed change rolls back and remains retryable. Network work and `app.refresh()` belong outside the callback. Signing out or changing accounts invalidates pending work and prevents stale responses from presenting success.

Settings reset explicitly clears only the optional local API key and generated/content audio caches. Learning, settings, private original audio, unfinished drafts, owner binding and operation history remain. Backup restore is an additive protected merge, not a destructive replacement. Four actual Settings SFC regression tests dispatch these buttons against real Dexie/repository/store behavior.

The server's `service_preferences.recording_retention` is authoritative. Login/sync reads that field directly without aggregating usage. Settings contains only a local mirror; capture excludes that mirror, and old synced settings cannot overwrite it. The prior local value is retained in `syncMeta.legacyRecordingRetention` as a migration suggestion, not silently applied to the account. Main's account preferences UI owns explicit online preference changes.

Only `recording` and `import` audio enter private recording sync. `generated` and `content-cache` remain local disposable caches; they are never uploaded to `jove-recordings` or assigned private retention. Cache handles are removed from synchronized references while original local cache blobs remain. Optional material `authenticPlayback` is validated by the shared schema, preserved without signed URLs, and merged as one coupled provenance object (hash/range/segment/sentence must not mix between clips).

Private manifests use keyset pagination until an empty page. Audio download verifies SHA-256/bytes before a transaction that rechecks owner, current storage capacity and whether another tab already saved that ID. It never overwrites an existing blob. Manifest identity is immutable; an interrupted upload is recovered by reading/verifying the existing object before confirming the manifest. New uploads start protected from expiry until complete metadata can be reconciled. Unfinished session/conversation work, assessments and imports remain protected; eligible pronunciation/history TTLs are anchored to original creation rather than renewed every sync. Ineligible completed history receives a fixed seven-day creation-anchored grace, never deletion of the local original.

002 adds `reconcile_recording_retention(recording_id, expected_cursor, retention_purpose, retention_expires_at, expected_policy)`. Under the same owner lock as metadata append, it rejects a stale metadata frontier, locks/checks the authoritative server policy, and updates only that owner's manifest. Before 003 creates preferences it conservatively returns false. Authenticated direct manifest updates are revoked; service-role retention cleanup remains available. Changing policy or discovering new work must trigger another sync; failed/stale reconciliation remains visibly pending.

Uploads obey both 100-operation and conservative 3,500,000-byte limits, below SQL's 4 MiB batch cap. The estimator includes JSONB separators and numeric exponent expansion. Each payload must also fit the existing 1 MiB limit. An individually oversized source remains local with a recoverable error.

## Server clocks and recovery

The additive `202609080002_sync_hardening.sql` preserves operation history and RLS and adds `logical_clock <= cursor`. Under the existing owner transaction lock, a new operation can advance that owner's maximum logical clock by at most one. Older offline clocks and exact retries remain valid; batches arrive in pending-clock order. `IS DISTINCT FROM` also rejects malformed retry identities containing missing/null fields.

Local clocks are rebuilt from valid acknowledged history and the pending chain, never trusted from poisoned metadata. Impossible pending jumps remain under their original IDs and are listed in `syncMeta.quarantinedOperations`; unchanged payloads are reissued with new IDs and legal clocks. Acknowledged history is never renumbered. The migration aborts if historical server receipts already violate the invariant; explicit administrative recovery must preserve that history rather than silently rewriting it.

Main reported successful persistent application of 002–005 to the dedicated local Jove service, preserving 001 data. This worker did not apply DDL. Subsequent actual local SQL/HTTP tests proved:

1. Clock 1, ordered 2/3, older offline clocks, exact retries and concurrent owner uploads pass; every receipt satisfies the clock/cursor bound.
2. First clock 2, huge jumps and batches skipping increments fail atomically; a subsequent valid operation still succeeds.
3. Duplicate IDs with missing/null/changed fields fail without changing the original row or cursor.
4. Existing membership/RLS/private-storage tests still pass; unauthorized and cross-owner access remains rejected.
5. Lost HTTP responses retry original operation IDs; account switching never sends A's records with B's Authorization.

## Evidence so far

- Latest combined narrow run: 63 sync, 6 Review SFC, 4 Settings SFC and 71 DB tests passed (144 total). Sync regressions include all eleven original counterexamples, all 32 pagination partitions, V2→V3 recording-byte persistence, contradictory receipt rollback, protected reset/restore and canonical attempt aliases. Injected fetch is not live-backend acceptance. Typecheck/lint were also rerun; concurrent shared-file changes must still pass main's final gates.
- `supabase/tests/sync.test.sql`: this worker executed the current script against the already-migrated dedicated DB (host port 55322); all checks passed and fixtures rolled back. No migrations or other worker DDL were reapplied.
- `tests/cloud-live.test.ts`: 9 real Auth/PostgREST/Storage cases passed after 002. All HTTP requests target only `http://127.0.0.1:55321`; CLI configuration stays in memory. This includes lost-response retry, a real SDK account switch during request dispatch, 505+ event pagination/large byte-bounded drafts, owner/member isolation, hash-checked originals and server-authoritative retention. Its admin-issued code case does not claim SMTP/browser delivery.
- `tests/sync-browser-journey.ts` is the shared real-browser scenario, registered by the Vitest and native Playwright entry points. Chromium passed the full Review journey (100.6 seconds); Linux Firefox passed it plus migration of pre-account local work (104 seconds); native Linux WebKit passed (2.8 minutes). These cover actual Mailpit-delivered OTP entry on independent profiles, offline conflicting evidence, exact private Blob bytes, two real legacy counter occurrences, UUID draft/response identity after another device advances FSRS, owner-scoped PostgREST occurrence readback, reload completion, Settings reset/older-backup merge and rejection of another enabled member in an owner-bound browser. No CSP bypass or reduced Auth cooldown was used. This is storage/identity evidence, not acoustic-quality or production acceptance.
- Keep the initial failure evidence distinct: remote Firefox `launchServer` did not forward host loopback, fixed by the `run-server` network-proxy path. WebKit private contexts reject Blob storage. Separately, Playwright WebKit `setOffline(true)` makes even a fresh Blob's `arrayBuffer()` throw `NotReadableError`, before IndexedDB is involved. A minimal native regular-profile probe reproduced online pass / offline failure / online pass. Therefore WebKit uses native disposable regular profiles and an explicit real HTTP network partition (`route.abort`), with failed health-fetch and no-upload server assertions. Blob/IndexedDB are not mocked. Chromium/Firefox still use their normal offline emulation. None of this proves physical iPhone disconnection behavior.
- Independent reviewer rechecked core merge/RLS/retention and Settings local changes without an open P0/P1 and independently rejected contradictory receipts. A second Review review found and closed two legacy identity P2 boundaries (arbitrary alias-draft selection and already-canonical raw-history identity fabrication), then independently passed 63 sync + 6 Review + 71 DB tests (140 total).

### Reproduce local browser journeys

Use only the dedicated local Jove backend at API 55321, DB 55322 and Mailpit 55324, with migrations applied by main. The runners read CLI configuration in memory, create isolated random owners, and clean their own owners/objects. No OTP/key is logged or written into a fixture; traces, video and screenshots are disabled. Pages clear form values and navigate blank before context closure to prevent automatic failure snapshots retaining OTP input.

- Windows Chromium/Firefox: set `JOVE_LOCAL_BROWSER_TEST=1` and `JOVE_SYNC_BROWSERS=chromium,firefox`, then `npx vitest run tests/sync-browser-live.test.ts`. The default Windows engine list is those two; Firefox uses the existing official image in an isolated loopback-only temporary control container.
- Windows-hosted native Linux WebKit: `node tests/run-sync-webkit.mjs` reuses `jove-webkit-sidecar-20260908`. It starts only its own frontend at 55173 and temporary loopback relays inside that container. CLI configuration travels over stdin into process memory, not Docker environment configuration or disk. It leaves the pre-existing container and other workers' preview services running.
- Native Linux: with browser runtimes installed, set `JOVE_LOCAL_BROWSER_TEST=1` and the desired `JOVE_SYNC_BROWSERS` list (for example `chromium,webkit` in main's CI), then run the same Vitest entry point. Every engine uses a disposable regular profile. The Playwright-specific WebKit entry/config exist to reuse the exact same scenario inside the existing Windows Docker sidecar, not to replace assertions.

## Native WebKit file-backed Blob preservation — September 8, 20:20

Repeatedly overwriting an IndexedDB record with its own previously read Blob reproduced `NotFoundError`/multipart `InvalidStateError` despite correct Blob size/type. The verified fix is shared in `src/db/audio.ts`: unchanged metadata does not rewrite or materialize audio; a real change reads the original bytes, validates their size, and saves a new independent Blob preserving its MIME type. The read and put remain in one transaction, including the outer journal transaction; any read/size failure rolls back metadata, receipts, snapshots and cursor. Recorder processed-status and generated-cache duration use the same path. `Blob.slice()`, `new Blob([oldBlob])` and Dexie `update()` are not equivalent byte detachment.

Four sync regression cases and the 48 compiled audio-component cases pass (115 combined with the other sync tests); an independent reviewer reran all 115 and approved the shared helper/callers. `tests/native-audio-journal.ts` is now part of every enabled local browser journey, covering actual native IndexedDB, repeated local/remote metadata changes, no-op replay, SHA-verified multipart parsing and close/reopen, using 8-byte, 64-KiB and 25-MiB synthetic fixtures. The actual native Linux WebKit run 27435 passed this plus the complete real Auth/offline/private-audio/reset/restore/account-isolation journey in 1.8 minutes. This is not physical-iPhone, real-microphone, acoustic-quality or production acceptance. The helper's 30-second timeout is per read; underlying I/O cancellation and physical-device peak memory are not established by these tests.

## Required work before acceptance

Explicit owner recovery for genuinely opaque/incompatible legacy baselines or irreversibly ambiguous old selections; main-owned server budget/AI/Speech acceptance and dedicated production provisioning; actual production login/offline/reconnect/recording sync and physical mobile/browser acceptance. The current local evidence is not production acceptance. See `FINAL_UPGRADE.md` for the complete scope.
