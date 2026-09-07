# Audio recovery and assessment integration

Updated 2026-09-08. This scoped follow-up modifies Recorder, AudioPlayer, useRequest, audio helpers and their tests. The separately requested rubric extension modifies provider.ts/schemas.ts; shared types and store/page integration remain with their owners.

## Recording ownership and recovery

`Recorder.vue` synchronizes `savedAudioId` when it arrives asynchronously. A recording in progress or awaiting save keeps ownership of its original data. Existing recordings are never overwritten when starting another capture.

Stop first obtains `{blob,duration}`, then retains it in the route/label-scoped `recordingDrafts` recovery ledger before any storage call. `saveRecording(draft, write)` deduplicates in-flight writes and uses the same asset ID on retry. Only a successfully committed recording can be attached to the parent or transcribed. STT reads the saved original back from IndexedDB; an unsaved in-memory draft cannot reach the provider.

Storage failure retains the original Blob, native playback, a download link and a save-only retry button. A library refresh failure after a successful commit does not mislabel the audio as unsaved or lose its ID. A transcript already returned by STT stays visible and is emitted before a later metadata-update failure.

An ordinary router leave waits for stop and save. If storage fails, navigation is stopped so retry/download remains available. A forced component unmount stops capture and attempts salvage rather than cancelling/discarding it. Late microphone permission results are also stopped and salvaged. Recovery entries survive component remounts in the same running tab and require explicit attachment when recovered after teardown. A device failure exposes already available bytes as `AudioError.recovery?:{blob:Blob,duration:number}`; partial audio is labeled for replay/review.

The recovery ledger is memory, not an alternative durable store. While recording/saving or holding unsaved bytes, a before-unload handler asks the browser to protect the tab. Page-hide salvage is best effort. A killed browser/OS process cannot reliably finish IndexedDB writes, and some mobile browsers omit unload events; download or successfully save a retained draft before closing. No code deletes an unprocessed original. [Browser unload limitations](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)

`R` selects one eligible recorder, prioritizing the active recording and then focus. It ignores form controls, links, contenteditable/ARIA text-entry controls, key repeats, IME composition, modified shortcuts and already handled events. Lifecycle cleanup unregisters the shortcut.

## Playback and explicit local fallback

`AudioPlayer` uses `app.generatedSpeech(text,signal)` for configured/cached TTS. Cached audio can play offline. Failure, offline cache miss or absent configuration offers a separate **Play with a local device voice** action; there is no automatic switch to browser synthesis.

`speakText(text,rate?)` remains `Promise<void>` and now permits only a discovered English voice with `localService === true`. A missing local voice rejects before synthesis; it never uses a remote or unspecified browser default. `localEnglishVoice()` exposes availability. Local availability can change as device voices load; retrying the explicit action checks again. [Voice locality contract](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService)

`speakLocalText(text,rate?,{onStart?,onEnd?})` additionally exposes actual speech lifecycle callbacks. `stopSpeech`, `pauseSpeech`, and `resumeSpeech` retain their APIs. Stop/interruption settles the promise without invoking completion. AudioPlayer emits `played` for actual media/local-speech start, and `ended` for actual natural completion of bundled, API-generated or explicitly selected local speech. Pause, failure, cancel, stale completion and unmount do not complete a listening/assessment gate. Local playback is labeled synthetic, with real pause/resume; media retains seeking and rate controls. Local rate can be chosen before playback.

`useRequest` identifies each controller independently. Cancelling frees the UI for a new request; an old promise cannot return a stale result, publish an old error or clear the new request's busy state. Unmount cancels and prevents new work. AudioPlayer also invalidates pending synthesis when text/source/voice identity changes, and revokes superseded object URLs.

## Generated cache metadata

`speechIdentity(text,settings)` is currently `JSON.stringify([text,ttsModel,voice,accent])`; `speechCacheId(identity)` is its SHA-256 digest prefixed with `tts-`. This matches the main store's current identity. Neither includes credentials. AudioPlayer snapshots that identity, checks it again after asynchronous work, and ignores stale results. Main owns the corresponding store-side identity consistency check and generation/cache writes. If the store's identity format changes, update this helper together with it.

On loaded metadata, the component records a finite, positive measured duration into the matching generated audio asset. It verifies the asset kind and returned Blob type/size and never applies an estimate to a user recording. Metadata-storage failure does not discard the generated Blob or interrupt playback. A cache miss caused by retention limits simply leaves no metadata row to update. In-memory player duration still reflects actual audio metadata.

## Explicit assessment rubric extension

```ts
evaluate(input: {
  kind: string
  text: string
  reference?: string
  targets?: string[]
  rubric?: string // nonempty, at most 8,000 characters; JSON string is supported
}, signal?: AbortSignal): Promise<Evaluation>
```

`Evaluation.rubricScores?` has exactly:

```ts
{ vocabulary: number | null; interaction: number | null; taskCompletion: number | null }
```

Each score is a validated 0–1 text-observable estimate against explicitly supplied dimensions/version/anchors. Instructions distinguish an incomplete task from accurate language and prohibit copying accuracy into vocabulary, interaction or task completion. Unsupported or unobserved dimensions remain null. No rubric supplied means unsolicited rubric scores are removed; a supplied rubric with no returned scores yields all-null dimensions, preserving legacy response compatibility. Additional fields, acoustic dimensions and out-of-range scores fail Zod validation. Fluency remains null; pronunciation/prosody are never inferred from text or STT. Rubric text is task data and cannot enable tools or change settings.

The caller must preserve the actual text/verified-STT evidence provenance, rubric version, task conditions and transcript. This extension supplies anchored estimates, not calibrated proficiency, timing or measured acoustic evidence.

## Current verification

The general transcript-word API is `lookup(expression:string, sourceSentence:string, signal?:AbortSignal):Promise<MaterialChunk>`. It accepts any nonempty expression up to 200 characters and contextual sentence up to 2,000 characters, with the same budget/cancel/fallback safeguards as other structured calls. Returned `text` must match the exact requested expression, including case and spacing. `meaningEn` is a short contextual explanation, `example` a short natural phrase/collocation example, and optional Chinese is represented by `meaningZh:''`. Strict validation rejects extra fields and substituted expressions. Source text remains untrusted data with no tools/settings access. The UI uses the returned expression with the existing playback APIs for pronunciation; the result does not invent acoustic scores or add fields outside `MaterialChunk`.

- 20 real compiled-SFC/custom-Vue-renderer lifecycle and useRequest tests pass, without adding jsdom, test-utils or changing the dependency manifest.
- 20 audio capture/speech lifecycle tests pass, including partial capture recovery and refusal of remote browser voices.
- 101 provider tests pass, including 20 general-lookup tests, optional rubric compatibility, missing criteria, bounded input, independent dimensions, invalid schema/acoustic fields and the existing streaming/audio contracts.
- Project typecheck and scoped ESLint pass. The latest lookup run reran all 101 provider tests; the 40 audio/component tests passed in the preceding audio change.

Run `npm exec -- vitest run tests/audio-components.test.ts tests/audio.test.ts tests/provider.test.ts`, followed by `npm run typecheck`. These tests exercise actual compiled component setup, props, rendering and lifecycle with simulated device/storage/network hosts; real microphone permissions, device voices, production desktop/mobile playback and independent product review are separate main-task gates. Store/pages were not edited by this follow-up.
