# Curated demo content and audio

## External-course continuation checkpoint — 2026-09-13

The four existing publisher links remain the current external reserve. The planner now remembers valid submitted guided reflections across all available history, selects eligible unpractised lessons first, and revisits the oldest practice after exhaustion. This records participation, not verified comprehension or acoustic skill; it does not change FSRS scheduling or retarget an existing task. Recurring metadata delivery and broader graded coverage remain required.

Candidate screening checked the [ESL-Lab easy directory](https://www.esl-lab.com/easy/) and publisher pages for apartments, hotel reservations, immigration/customs, train tickets, coffee shop, restaurant orders and phone messages. The [Coffee Shop page](https://www.esl-lab.com/easy/coffee-shop/) explicitly discloses AI collaboration, without establishing whether that includes its audio. Do not infer a human voice from an institutional name, a speaker-count field or the absence of an AI label. These candidates were not added as approved human references. Inspect provenance and source terms before admission; store links/original prompts only, not copied media/transcripts. Source discovery must not require paid audio-model retries.

## Existing original demo pack

`src/content/materials.ts` exports `demoMaterials: Material[]`, `missions`, `assessmentPrompts`, and `assessmentRubric`. Six original scripts cover everyday life, technology, and living abroad. Each has five sentences, three useful multiword chunks with English/Chinese meanings and a new-context example, a Chinese translation, an English meaning question, an expected answer, and four keyword cues. Register is included in each chunk's English explanation because MaterialChunk has no separate register field.

All scripts are original project writing, with editorial review and automated consistency checks by the implementation agent. `sourceKind: 'curated'`, `approved: true`, and `sourceLabel: 'Original reviewed demo / synthetic speech'` describe curated original demos. They do not claim a human editorial panel, external publication, authentic conversation, or human voice recording. Independent product review remains a main-task acceptance gate. No external transcript, personal data, API key, or third-party audio recording is bundled. The license field describes text provenance; it does not claim ownership of the Windows voice engine or impose a new project license.

| ID | Material | Topic | Full WAV, seconds | Voice |
| --- | --- | --- | ---: | --- |
| cafe-delay | A small change of plan | Everyday life | 22.12 | Zira |
| notification-reset | Make your phone quieter | Technology | 22.63 | David |
| shared-kitchen | A fair plan for the kitchen | Living abroad | 21.84 | Zira |
| lunch-order | Ask for the lunch you want | Everyday life | 24.37 | David |
| train-change | Check before you board | Living abroad | 23.55 | Zira |
| team-demo | Clarify the next step at work | Technology | 24.24 | David |

## Integration contract

- Full audio is `audio/{id}.wav`; sentence audio is `audio/{id}-{index}.wav` with **zero-based** indices 0–4. Files live in `public/audio/`. Prefix app URLs with Vite's `import.meta.env.BASE_URL` so GitHub Pages subpaths work. `Material.duration` is the rounded actual full-WAV duration in seconds.
- The 36 WAV files are real mono, 22,050 Hz, 16-bit PCM. The full clip concatenates each sentence's exact PCM samples in order, including the voice's pauses. Sentence replay therefore avoids estimated seek boundaries and uses the same samples as full playback. Sentence-level synthesis can sound less connected than a natural uninterrupted paragraph.
- `public/audio/manifest.json` records voice, rate, format, actual durations, filenames, and SHA-256 hashes of both text and audio. Text hashes use UTF-8 without a trailing newline. It contains no environment paths or learner data. The generator reads the TypeScript materials directly, so no second transcript needs synchronising.
- Keyword cues assist a coarse meaning check, not a calibrated score. The expected answer supplies the main idea and details; allow paraphrases and require correct relationships. In `train-change`, the traveller asks about a connection and ticket validity; the recording does **not** confirm either answer. Full translations/answers should remain behind the first attempt/reveal flow.
- Chunk examples deliberately change the context; practising or revealing an example is prompted work. Independent success requires a later prompt that does not supply the chunk. Difficulty values are editorial proportions from 0 to 1, compatible with the shared domain schema.
- `missions` has all 13 requested scenes: stranger, flatmate, restaurant, shopping, airport, transport, bank, landlord, work, interview, clarification, social, living-abroad. Each object supplies `id`, `title`, `scene`, partner `opening`, three observable `goals`, and `topic`. These are language roleplays with concrete goals, not advice on actual banking, travel rules, or tenant law.
- `assessmentPrompts` supplies three forms, each with a real `listeningMaterialId`, listening instruction, a 45–60 second retell prompt, conversation task, and `missionId`. `assessmentRubric` supplies one version and descriptive 0–2 anchors; it is an editorial comparison aid, not an equated or CEFR test. Repeated exposure to built-in clips must be logged. UI wiring and storage of these conditions belong to the main task.

## Regenerate and verify

Prerequisites: Windows desktop with `System.Speech`, an enabled English desktop voice, and Node.js 24+. The script has no network calls and needs no API key or additional npm package to generate audio. Run from the project root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-demo-audio.ps1
npm test -- tests/content.test.ts
npx eslint src/content/materials.ts tests/content.test.ts
```

The default alternates Microsoft Zira Desktop and Microsoft David Desktop at rate 0, volume 100. If unavailable, it uses installed English voices. `-Voice 'Microsoft Zira Desktop'` selects one enabled English voice; `-Rate` accepts -3 through 3. The script synthesises every sentence into a unique staging directory inside `public/audio`, validates the whole batch, then publishes only its known WAVs and manifest. It cleans only its own validated staging directory and never enumerates or deletes user recordings. Generation failure before publication preserves existing assets. Publication consists of individual file moves, not a transactional directory swap; interruption during that final step requires rerunning the script and tests.

If text, voice or rate changes, regenerate, inspect the new durations, and update the six rounded `Material.duration` values using `apply_patch`; tests detect stale transcripts and durations. Exact audio bytes may change across Windows voice versions. Commit the generated WAVs and manifest with their material source; consumers do not need Windows to play the bundled WAVs.

The content test checks all six materials, three chunks each, source labels, English answer/keyword alignment, mission/assessment references, all 36 files, RIFF/PCM validity, meaningful non-silent signal, clipping bounds, hashes, real durations, and exact full/sentence sample equivalence. Signal checks establish asset integrity, not pronunciation quality or pedagogical effectiveness.

## Acceptance record and remaining limits

2026-09-07: targeted content tests passed (16/16); targeted ESLint and strict TypeScript checks passed. A second generator run produced identical SHA-256 hashes for all 36 WAVs and the manifest (37 files). The WAVs total 12,239,424 bytes, about 11.7 MiB. Windows SoundPlayer loaded all 36 WAVs and completed playback of the first sentence from both `cafe-delay` (Zira) and `notification-reset` (David). Browser acceptance remains unproven in this sidecar: the installed Playwright package had no matching bundled Chromium executable, and system Edge rejected remote debugging under its administrator policy. No system policy was changed. Main must complete public subpath playback, desktop/mobile UI, offline-cache/audio availability and independent review under ACCEPTANCE.md, then record those results in STATUS.md.

This demo pack contains about two minutes of unique synthetic speech. It demonstrates a usable no-key lesson loop; it is not sufficient long-term listening coverage. Natural-speed connected speech, diverse speakers/accents, real conversational timing, and observed novel-context transfer require further approved materials. Learning-science sources and the limits of the design are in LEARNING_SCIENCE.md.
