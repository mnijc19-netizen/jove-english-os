# Product specification — approved scope

Current final-upgrade requirements and the September13 external-playback/optional-acoustics/partial-release amendments are in `FINAL_UPGRADE.md`; they supersede conflicting historical V1 boundaries below.

Jove English OS serves one Chinese-native learner pursuing real-world English independence. Priority: natural listening, spontaneous speaking, high-frequency chunks, intelligibility/prosody, productive grammar, reading, writing. Exams are secondary transfer benefits. This complete V1 includes all requirements below; milestones do not redefine completion.

## Core loop

Diagnostic → appropriate material → blind listening → comprehension response → listening gaps/chunks → active recall → spoken output → 1–3 targeted corrections → full-sentence retry → same-day/delayed testing → new-context transfer → spaced review → evidence aggregation → next plan.

## Pages and behaviors

- Onboarding: goal, interests/preferences, three listening difficulties, sampled vocabulary, recorded speaking, short reading, initial evidence-based bottleneck. Unknown skills remain unknown; skipped recordings do not earn ability.
- Today: deterministic 45/90/150-minute plan with due reviews, weaknesses, recent failures, interests, fatigue, completion and activity balance. Speaking always remains. Continue resumes persisted task/session state.
- Assigned reading and deliberate chunk/writing practice are distinct learning tasks, not one interchangeable slot. Today and completion buttons follow the saved next task/material/mode; skipping does not fabricate completion or start unrelated work. Legacy task and draft identities remain recoverable. Reading continuation requires a durably saved response/retell, including after same-page save retry. New chunk assignments require an actual written response and, when offered, a saved source expression before completion.
- Listen: blind audio first; comprehension estimate and meaning response; then English transcript, optional Chinese, chunk lookup; mark unknown vs reading-known/listening-missed; sentence replay at normal/0.85 speed, segmentation, shadow recording and retell. Imported audio stays authentic; TTS is labeled synthetic.
- Learn: phrase units with English meanings, optional Chinese, usage/register, examples, source, audio, independent reading/listening/recall/production strengths.
- Speak: Guided Conversation, Free Conversation, Real-life Mission, Retell/Spontaneous Response. Missions cover stranger, flatmate, restaurant, shopping, airport, transport, bank, landlord/renting, work, interview, clarification, social and living abroad. Increasing difficulty from evidence. Natural conversation, end-of-session feedback. Record → local save → STT → editable transcript → evaluation. Text fallback is explicitly not pronunciation/speaking-acoustic evidence.
- Repair: prompt first, regenerate full sentence, preserve repeated error patterns, schedule immediate and later novel-context retrieval. Prompted success differs from spontaneous success.
- Review: Recognition, Listening, Recall, Cloze, Speaking, Transfer. FSRS scheduling per chunk/modality. Recognition alone never grants spoken mastery.
- Library: curated built-ins, pasted text, URL retrieval with paste fallback, uploaded audio, web discovery and generated fallback. Review candidate lesson metadata before approval. Sources and generated labels visible. Interests influence material choice without bypassing weak skills.
- Progress: first-pass comprehension, speech duration/latency, Chinese fallback, active/listening/reading-only/spontaneous chunks, error recurrence, interaction and task performance. Evidence confidence/counts; no invented precision. Weekly trends and 14-day comparable listening/retell/conversation/mission assessments with stable rubric and rotating prompts.
- Settings: goal, duration, interests, accent, Chinese help, correction intensity, theme, AI key test/remove, dynamic capability-filtered model selection (fast/strong/STT/TTS), usage/budget, backup/restore/reset, storage/cache control.

## Experience

Quiet warm-neutral light / near-black dark appearance, restrained blue accent, clear typography, spacious task focus. Responsive desktop/mobile. Progressive disclosure, semantic HTML, keyboard/focus/labels, adequate contrast/44px touch targets and reduced-motion support. Space/play, arrows/sentence, R/record, Enter/submit must not hijack form editing. Full empty/loading/error/offline/disabled/success states.

## Data, AI and operating constraints

IndexedDB owns persistent settings/profile/skills/chunks/errors/sources/materials/sessions/events/reviews/queue/conversations/messages/audio/assessments/plans. Versioned migrations and transactions; event evidence permits rebuilds. Audio is bounded and recoverable, with optional explicit cleanup. Request persistent storage without assuming grant. Backups include nonsecret records, never keys or audio blobs; validate schema and relationships before atomic restore, preserve existing data on invalid imports.

Replaceable LLM/STT/TTS/discovery adapter. Verify actual current OpenRouter contract. Dynamic model catalog and capability detection, structured outputs validated by Zod, streaming, cancellation, timeout, bounded retry, normalized errors, model fallback and usage/cost tracking with honest unknown costs. Dedicated limited BYOK; no fake encryption claims. Network input cannot modify application settings or access keys. No full learner-history uploads.

No-key demo must support onboarding/listening/basic review/core navigation with real embedded audio. External capabilities explain configuration need. Offline supports app shell, history, existing material/reviews/audio. SW update requires deliberate safe refresh.

## Final-upgrade scope (supersedes V1 exclusions)

The complete binding requirements and original section mapping are in `FINAL_UPGRADE.md`. Retain all current pages and UI while adding single-owner email authentication, automatic event-based cloud sync including recoverable drafts and selected recordings, authenticated server AI/Speech, scheduled licensed authentic-content supply, stable General American reference practice with real acoustic assessment, longitudinal adaptive reading/planning, recovery mode and WebKit acceptance. Imports and browser BYOK become optional advanced paths, not prerequisites for normal long-term use. Content discovery/quality approval is system work. Local data must survive migration and offline conflicts.

Still excluded: social/economy/rankings, marketplace/payment product, universal scraping, DRM bypass/downloaders, 3D teacher/avatar and a home-built purportedly calibrated phoneme engine. No guarantee of individual learning outcomes.
