# Provider and browser audio contract

Implemented in the provider/audio owned scope. Official contracts fetched 2026-09-07; contract tests and keyless catalog acceptance run 2026-09-08. No live paid key, transcription or synthesis is assumed. The provider has no database dependency; components and the store own persistence.

## Public API

`src/ai/provider.ts` exports `OpenRouterProvider`, `ProviderModel`, `ProviderOptions`, `MaterialDraft`, `ProviderNotice`, `ProviderError`, `ProviderErrorCode`, and the public HTTP(S) URL validator `publicUrl`.

```ts
new OpenRouterProvider({
  getKey: () => Promise<string>,
  getSettings: () => Settings,
  onUsage?: (usage: Usage) => Promise<void>,
  beforeRequest?: (purpose: string) => Promise<void>,
})
```

| Method | Result and behavior |
| --- | --- |
| `listModels(signal?)` | `Promise<ProviderModel[]>`; fresh public catalog, no key required |
| `testConnection(signal?)` | `Promise<{label:string}>`; authenticates `/key`, returns a fixed safe verification label |
| `evaluate({kind,text,reference?,targets?,rubric?}, signal?)` | `Promise<Evaluation>`; validated text feedback, at most three issues; optional `rubric:string` is nonempty and at most 8,000 characters |
| `chat(messages, {scenario,mode,level,targets}, onDelta?, signal?)` | `Promise<string>`; `messages` are `{role:'user'|'assistant',content:string}[]`; callback receives **accumulated text**, compatible with `live.value = text`; final promise resolves only on complete valid output |
| `lookup(expression, sourceSentence, signal?)` | `Promise<MaterialChunk>`; exact requested expression, short English meaning, optional Chinese meaning and a contextual example; pronunciation uses the audio APIs |
| `analyzeMaterial(text, signal?)` | `Promise<MaterialDraft>`; source transcript and sentence coverage verified |
| `generateMaterial(topic, signal?)` | `Promise<MaterialDraft>`; original generated educational candidate |
| `discover(topic, signal?)` | `Promise<{title:string,url:string,description:string}[]>`; up to three actual search citations |
| `retrieve(url, signal?)` | `Promise<string>`; direct CORS excerpt fetch; paste fallback on failure |
| `transcribe(blob, signal?)` | `Promise<string>`; dedicated STT JSON endpoint |
| `synthesize(text, signal?)` | `Promise<Blob>`; dedicated TTS endpoint, MP3 bytes |
| `takeNotices()` | `ProviderNotice[]`; drains bounded model/schema fallback notices for visible UI presentation |

`MaterialDraft = Omit<Material,'id'|'createdAt'|'approved'|'sourceKind'|'sourceLabel'|'synthetic'>`. Model-generated drafts cannot supply source URLs, licenses, audio paths/IDs or approval. The caller attaches real source metadata and requires review before approval.

`ProviderModel = {id:string;name:string;inputModalities:string[];outputModalities:string[];structured:boolean;voices:string[]}`.

`fastModel` (Settings: “Fast tasks”) serves chat and discovery. `strongModel` (Settings: “Evaluation & analysis”) serves evaluation, contextual lookup and material analysis/generation.

## Current OpenRouter contracts

- Catalog: requests `GET /models?output_modalities=text`, `transcription`, and `speech` separately and merges by ID. A live check found the unfiltered catalog omitted dedicated audio models. Input/output capability comes from `architecture.*_modalities`; strict capability requires `supported_parameters` containing `structured_outputs`. Voices come from the live `supported_voices` field. `voices:[]` means unpublished/unknown. [Models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
- STT: `POST /audio/transcriptions` with `Content-Type: application/json`, `{model,input_audio:{data:RAW_BASE64,format},response_format:'json'}`. No data URI prefix. MIME determines `wav`, `mp3`, `flac`, `m4a`, `ogg`, `webm` or `aac`; codec suffixes are stripped for format selection. Response: `{text,usage?}`. The current guide also documents optional multipart compatibility; this implementation deliberately uses the documented base64 JSON contract. Browser WebM/MP4/OGG stays in its actual format; provider-specific format rejection remains a recoverable error. No implicit lossy WAV conversion. [STT guide](https://openrouter.ai/docs/guides/overview/multimodal/stt)
- TTS: `POST /audio/speech` with `{model,input,voice,response_format:'mp3'}`; response must be nonempty `audio/mpeg` bytes. Current documented formats are MP3 and PCM; PCM is not an MP3 or WAV file. An explicit voice is required here. Published voice lists are validated; an unpublished list permits a user-entered provider-documented voice. [TTS guide](https://openrouter.ai/docs/guides/overview/multimodal/tts)
- Structured output: JSON Schema generated from the same Zod schema used for local validation; `json_schema.strict:true` and `provider.require_parameters:true`. If an advertised strict endpoint rejects the request with 400/422, one plain-JSON schema-prompt attempt is permitted, with a visible notice and unchanged local validation. This may also encounter an unrelated invalid-parameter rejection; the fallback is bounded and does not claim to know the server's reason. Unsupported models use the schema prompt immediately. Invalid JSON, wrong types, unexpected fields and truncation are never accepted as evidence. [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- Streaming: handles byte/UTF-8/CRLF boundaries, multiline data, heartbeat comments, empty-choices usage frames, repeated terminal usage frames, in-stream errors and `[DONE]`. Requires both successful finish and `[DONE]`; preserves delivered callback text as an incomplete draft on failure. [Streaming](https://openrouter.ai/docs/api_reference/streaming)
- Discovery alone enables a bounded `web` plugin with `engine:'exa',max_results:3`. URLs are accepted only from `url_citation` annotations, never invented links in model prose. No client tools/tool execution exist; all other learning calls have no plugin. [Web search](https://openrouter.ai/docs/guides/features/plugins/web-search)
- Key testing uses `GET /key`, with credentials sent only to the fixed OpenRouter API origin. The returned label never reproduces a server-provided key label. [Key API](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)

## Failure, fallback, budget and usage policy

Catalog/key checks have a 15-second deadline; retrieval 20 seconds; a paid operation has a single 60-second deadline including preparation, injected callbacks, retries and response consumption. An SSE read has a 20-second idle deadline. Abort signals cover catalog, guard waits, encoding boundaries, fetch and body consumption. Cancellation cannot guarantee that an upstream provider stops billing.

At most three POST attempts per operation across all fallback/retry paths. Explicit 429/503 responses may retry once after 250 ms. Network failures, timeouts, partial streams, schema-validation failures, 401/403 and insufficient credits do not replay a paid request. Original server error bodies/messages/metadata and raw exception causes are never exposed or logged. Safe `ProviderError.code` values support Settings/retry/paste routes.

An empty model selection returns `MODEL_REQUIRED`. A missing/incompatible selected text model may fall back only to the other compatible text model already configured by the user, including a 404 after discovery. It never silently chooses an arbitrary billable model or updates Settings. Audio model replacement requires a new explicit selection. The store's `tick()` drains `takeNotices()` into visible app notices every 15 seconds and on focus/visibility changes, including notices left by a failed request. Fallbacks also appear in usage purposes (`:fallback`, `:schema-fallback`).

`beforeRequest(purpose)` runs before **every dispatched POST**, including retries and fallback. Rejection prevents that POST and returns a safe `BUDGET` error. Its detailed exception is intentionally not displayed. `onUsage` receives one locally identified record for every dispatched attempt, including ambiguous failures and cancellation; tokens/cost are `null` when not reported. Raw speech responses do not report a JSON usage object, so synthesis cost stays unknown. Never display unknown cost as zero or claim exact remaining budget. Key checks/public catalog/retrieval are not billable model calls and do not invoke these hooks.

The injected guard owns any atomic reservations needed for concurrent requests. A preflight guard and unknown final costs cannot guarantee a hard account spending cap; use a limited OpenRouter key as the external ceiling. If usage persistence fails, this provider instance blocks further paid work with `USAGE`; recover storage and recreate the instance. During cancellation, the accounting callback still runs, and its failure blocks subsequent work. No secrets enter usage, catalog, model prompts or caches.

## Caller persistence and synthesis cache

The main UI/store preserves input before network activity; the provider itself does not own persistence.

1. `const capture = await handle.stop()` returns `{blob,duration}` (duration in seconds).
2. Persist the **original** blob and metadata locally as `kind:'recording', processed:false`. Await the transaction successfully before calling `transcribe(capture.blob, signal)`.
3. STT success produces an editable transcript. A failure/cancel leaves the original recording available for native playback, retry or manual text. Never mark the original processed or delete it solely because an API call was attempted.
4. Save text/session drafts before chat/evaluation. Streaming callback content is provisional until the returned promise succeeds. Error/cancel must not mark it as completed learning evidence.

For synthesis, `generatedSpeech(text, signal)` first looks up the generated-audio cache using `tts-` plus SHA-256 of `JSON.stringify([text, ttsModel, voice, accent])`. After the awaited lookup it rechecks that identity against current settings and restarts the lookup on a mismatch, before synchronously calling `provider.synthesize`. The provider snapshots settings at call start. `AudioPlayer` uses the same identity and invalidates stale playback when text/source/settings change. Keep both identities aligned if generation-affecting options change; playback rate is a player control, not a different synthesized voice.

The returned Blob is cached as `kind:'generated'`, `mimeType:'audio/mpeg'`, with the selected model/voice cache identity; playback labels it as **synthetic**. Initial duration zero means not yet measured: `AudioPlayer` updates the matching cached asset from finite, positive audio-element metadata. Duration is never an AI estimate. Never attach this cache as authentic imported source audio or mark a synthesis failure as a cache hit. Keep the key out of cache identity, IndexedDB learning settings, logs, backups and service-worker caches.

`Recorder` checks persisted audio capacity against `audioLimitMB` before requesting the microphone, then atomically rechecks actual Blob size and saves in one audio-table write transaction. All audio kinds count toward capacity; concurrent saves cannot both consume the same remaining space. A failed save or capacity check retains the captured Blob for download/retry, blocks transcription and unsaved route navigation, and never deletes user recordings. The in-memory recovery draft survives component remount, not browser/process loss.

`Recorder.vue` accepts optional `disabled:boolean` and emits `active:boolean` immediately and synchronously on changes. Activity covers startup, capture, saving, pending recovery drafts and transcription through transcript delivery/metadata completion; passive saved playback is inactive. Parents can gate finish/mode changes with `@active`, and pass only parent LLM busy state as `:disabled` (not the activity value itself). Disabled blocks start/transcribe, including after awaited storage preparation, but never blocks stopping an active capture by button/R or retrying a retained save.

Play cached/imported blobs with `URL.createObjectURL(blob)` and an actual `<audio controls>` element; retain play/pause, seek and playback-rate controls. Revoke object URLs when replaced or unmounted, after the player no longer needs them. Avoid automatic eviction of unprocessed recordings; generated cache eviction and user recording deletion are separate caller policies.

## Browser audio API

`src/audio/recorder.ts` exports `startRecording():Promise<RecordingHandle>`, `RecordingHandle`, `AudioError`, `AudioErrorCode`, and `MAX_RECORDING_SECONDS=180`. The handle is `{stop:()=>Promise<{blob:Blob;duration:number}>,cancel:()=>void}`. Stop is idempotent, waits for the final data event and releases every microphone track. Auto-stop retains the result for the UI's later `stop()` call. Cancel releases tracks and rejects subsequent stop with `CANCELLED`. A missing final event is bounded by a five-second watchdog. Permission/device/unsupported/empty states are explicit.

`src/audio/speech.ts` exports `speakText(text,rate?):Promise<void>`, `stopSpeech():void`, `pauseSpeech():void`, `resumeSpeech():void`, `localEnglishVoice()` and `speakLocalText(text,rate?,{onStart?,onEnd?})`. Browser synthesis is explicitly synthetic and requires an English voice with `localService === true`; unavailable local voices produce an error, never an implicit remote/default voice. Rate defaults to 1 and is bounded to 0.5–2. Stop/replacement settles the previous promise even if the browser omits end events, without reporting natural completion. It does not replace imported/recorded audio or claim acoustic assessment.

`AudioPlayer` uses configured cached API speech and offers local browser speech only through an explicit user action on offline/failure paths. Its `played` event is separate from `ended`: bundled, API and local speech emit `ended` only on actual natural completion, never on pause/cancel/stale playback/unmount.

## Limits and evidence

Text calls send only required task fields; chat retains at most 12 recent messages and 16,000 characters. Evaluation/material input max 16,000 characters, optional rubric 8,000, individual chat message 4,000, topics 500, TTS 4,000. Lookup requires a nonempty expression of at most 200 characters and source sentence of at most 2,000; its strict result must preserve the requested expression exactly. Both are untrusted context, with no settings or tools in the request. Audio upload/download cap is 25 MiB. Retrieval accepts bounded public HTTP(S) text/HTML excerpts with CORS and credentials omitted, rejects IP/local/credential-bearing URLs and redirects, and never constructs a DOM or fetches embedded resources. It cannot bypass CORS, paywalls, login or DRM; large/unsupported pages require a pasted excerpt. Browser DNS resolution remains under the browser's network policy, not a backend SSRF proxy.

Evaluation numeric estimates are 0–1; `fluency` is always null. Comprehension without a reference is null. Unknown schema fields (including phoneme scores), non-null fluency and pronunciation/prosody error categories fail validation. Successful chunks must be supplied targets appearing as complete phrases in submitted text. These are text estimates; the caller must preserve text/AI provenance, and never turn them into measured acoustic ability or spontaneous mastery.

Optional `rubricScores` is a strict object `{vocabulary:number|null, interaction:number|null, taskCompletion:number|null}`, with scores bounded to 0–1. Without an input rubric, unsolicited scores are removed; with a rubric but no returned scores, all three are null. Evaluation uses the supplied stable anchors and text-observable transcript evidence, recognizes incomplete tasks, and never substitutes accuracy for interaction/task completion or infers acoustic fluency/pronunciation.

Validation commands:

```powershell
npm exec -- vitest run tests/provider.test.ts tests/audio.test.ts tests/audio-components.test.ts
npm exec -- eslint src/ai src/audio src/components/Recorder.vue src/components/AudioPlayer.vue src/composables/useRequest.ts tests/provider.test.ts tests/provider-live.test.ts tests/audio.test.ts tests/audio-components.test.ts
npm run typecheck
$env:JOVE_LIVE_CATALOG='1'
npm exec -- vitest run tests/provider-live.test.ts
Remove-Item Env:JOVE_LIVE_CATALOG
```

The optional live test exercises this actual provider against the public three-modality catalog without fetching credentials or making paid requests. Paid STT/TTS/chat smoke, real-device microphone/playback, independent product review and production desktop/mobile acceptance are separate project-level evidence. These scoped results do not certify those gates; consult the main acceptance record for their current status.

Current scoped results (2026-09-08): **101 provider contract tests, 20 browser-audio tests and 35 component/request lifecycle tests passed (156 total)** in the latest rerun. Scoped ESLint and project `vue-tsc` passed after the recorder capacity and parent-activity guards. The separate keyless live catalog test previously passed on the same date with 417 text, 20 transcription and 18 speech entries; that catalog snapshot was not refreshed in this final scoped rerun. Narrow review/test coverage includes fragmented/truncated streams, schema/model fallback, cancellation, per-attempt budgets, STT/TTS bodies, rubric honesty, contextual lookup, playback completion and recoverable recording persistence.

The 35 component tests include eight recorder-capacity regressions: full-budget microphone preflight, all asset kinds counted, persisted rather than stale UI totals, capacity consumed during capture with download/retry recovery, a lowered limit during capture, exact-boundary acceptance, serialized concurrent saves, and failed/unmounted preflight. The concurrent-save case runs real Dexie write transactions against isolated fake IndexedDB: with only one capture's worth of space, exactly one save succeeds, the other Blob remains recoverable, and the existing recording stays intact. Seven parent-activity regressions additionally cover gap-free capture/save/recovery transitions, disabled start/STT with button/R stop still available, disabled rechecks after storage waits, transcript delivery before activity clears, and STT failure/cancellation preserving input.

Verified caller integration: `Recorder.vue` saves the original Blob before its separate transcription action; the store rechecks generated cache identity after awaited lookup before the provider's synchronous settings snapshot; `AudioPlayer` writes measured duration metadata; and store `tick()` drains fallback notices for display. The earlier cache-race, missing-duration and undrained-notice observations are resolved, not remaining main-owner TODOs. No provider or store code changed in this documentation synchronization.
