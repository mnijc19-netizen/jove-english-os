# Dedicated Jove production activation and release

This is an executable operator sequence, not evidence that production is provisioned. The current public V1 stays available until the release hold passes. Never use another project's backend, copy real credentials into this document, or push local Auth configuration to production.

## 1. Establish the explicit target

The owner creates a dedicated Supabase project named `jove-english-os` in an owner-approved organization/plan. New paid commitments and database-password entry belong to the owner. Keep the public project reference separately from credentials.

Before any remote mutation, use the authenticated CLI's `projects list --output json` and compare the selected public reference, name and healthy status. Stop on ambiguity or if the only available projects belong to other products. Check any existing local link; do not overwrite a different link. All subsequent operations must resolve to this verified Jove target.

The guarded entry point checks the exact project name/reference/healthy state before each operation and refuses a conflicting local link. It does not create a project, configure Auth, set secrets or issue release approval. The following commands run only with the verified public placeholder replaced; no password is placed in command arguments, history or output:

```sh
node scripts/backend-operations.mjs inspect --project-ref <verified-jove-project-ref>
node node_modules/supabase/dist/supabase.js link --project-ref <verified-jove-project-ref>
node scripts/backend-operations.mjs migrate --project-ref <verified-jove-project-ref>
node scripts/backend-operations.mjs migrations --project-ref <verified-jove-project-ref>
node scripts/backend-operations.mjs deploy-functions --project-ref <verified-jove-project-ref>
node node_modules/supabase/dist/supabase.js functions list --project-ref <verified-jove-project-ref>
```

Do not proceed past a failed command. Read back every current migration version, RLS policies and private `jove-recordings`/`jove-content-audio` buckets. Record function deployment versions and the source/bundle association. A successful functions build is not a deployment. Do not run destructive reset/seed commands remotely.

The content budget preflight bundle requires `20260910115020_content_budget_preflight.sql` first. Verify the service-role-only, security-invoker `service_budget_available` RPC and its read-only paused/unknown-cost behavior before deploying functions. A missing RPC stops STT/screening media I/O; do not bypass it or raise owner budgets to hide a migration error. Preflight is not a replacement for the existing atomic paid-dispatch reservation.

The entry point rejects conflicting target/routing environment overrides, pins `SUPABASE_PROJECT_ID` for child CLI processes, also passes the explicit project-ref to database commands, and disables implicit Vault updates during migration. It compares both local/remote migration lists with the current source set. This protects against a changed link or inherited target selecting another backend; do not replace it with a bare `--linked` mutation.

## 2. Configure production Auth and the single owner

Do **not** run `config push` with `supabase/config.toml`: its Site URL and SMTP are deliberately local. Configure the hosted Auth settings separately:

- Site URL and the allowed production redirect: `https://mnijc19-netizen.github.io/jove-english-os/`.
- Email sign-in enabled, public signup disabled; six-digit email OTP, 600-second expiry, 60-second resend interval.
- Owner-configured production SMTP; provider credentials remain in the service dashboard. Supabase's restricted default sender is not production delivery acceptance.
- Configure that SMTP service before editing the magic-link template: the hosted dashboard observed on 2026-09-09 keeps subject/body on its default templates until custom SMTP is configured. Then use `{{ .Token }}` as in `supabase/templates/otp.html`, compatible with the existing code-entry UI. Numeric OTP settings alone do not prove the delivered default email contains a code. Read back the project's resend interval as well as its template after SMTP setup; the documented 60-second default is not a substitute for hosted readback.
- Through the trusted Dashboard/admin interface, pre-create only the owner's self-confirmed email account. Do not insert directly into `auth.users`, expose admin credentials to a browser or use public signup to bootstrap membership.
- Use that exact returned Auth identity for the single `public.app_members` row. Read existing membership first; if a different member exists, stop without replacing/deleting it. Verify exactly one intended member. Do not put email, owner UUID or OTP in committed evidence.

Administrative email confirmation is not email-delivery proof. The owner must receive a real OTP and sign in through the app. A valid account without membership must remain denied; never relax RLS to repair missing bootstrap.

## 3. Activate bounded server services

Set credentials only in this dedicated backend's server secrets. The browser and GitHub receive no provider/server secrets.

| Service | Required server configuration | Readback before acceptance |
| --- | --- | --- |
| Account AI/STT/TTS | `OPENROUTER_API_KEY`; supported `JOVE_FAST_MODEL`, `JOVE_STRONG_MODEL`, `JOVE_STT_MODEL`, `JOVE_TTS_MODEL` and `JOVE_TTS_VOICE` as needed | Legitimate actual LLM/STT/TTS requests, recovery and server usage; never infer model capability from its name |
| Acoustic assessment | `AZURE_SPEECH_RESOURCE_NAME`, `AZURE_SPEECH_KEY`, positive conservative `JOVE_SPEECH_MAX_DISPATCH_USD` | Actual owner recording, provider-supported acoustic fields, low-evidence/failure paths and charged/unknown usage |
| Content screening | Existing OpenRouter credential, audio-capable `JOVE_CONTENT_AUDIO_MODEL`; direct Gemini is optional, not a required third key | Actual audio/transcript screening, retained provenance and an eligible playable clip; test approval flags never qualify |
| Public routing | `JOVE_ALLOWED_ORIGINS` limited to the production origin; `JOVE_PUBLIC_SUPABASE_URL` is this project's exact HTTPS origin | Authenticated browser CORS, safe signed-audio conversion and original-byte hash |
| Scheduled ingestion | `JOVE_CONTENT_JOB_TOKEN`, at least 32 characters, also stored under a dedicated `jove-content-job-*` Vault name | Actual scheduled HTTP execution and persisted refresh results |

Preserve existing preferences. Set account budgets and recording retention explicitly before paid calls; zero budget is a safe temporary stop, not a working paid-service configuration. Owner approval is required for new billing commitments. Minimal/assessment-only retention must still preserve unprocessed work. Hosting/egress bills are not included in provider usage totals.

Free-service/privacy check (official sources checked 2026-09-09):

- [Azure pricing](https://azure.microsoft.com/en-us/pricing/details/speech/) lists five shared real-time STT hours and 0.5 million neural TTS characters per month for F0, excluding batch STT; prosody appears separately as an enhanced add-on. These quotas do not prove this account is eligible or that all required acoustic features are free. Verify the exact resource/tier/region and feature pricing before activation; do not enable billing or remove prosody from the final requirements to bypass this gate.
- [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits) distinguish free-model request caps from paid credit limits. A catalog entry or a generated key does not prove available quota, audio capability or sustained quality. Chat completions now apply `provider.data_collection: deny` in the shared adapter, including direct/BYOK, schema downgrade, configured-model fallback and streaming. The server pricing layer independently retains the same policy and its price ceilings. [This routing filter](https://openrouter.ai/docs/guides/routing/provider-selection#requiring-providers-to-comply-with-data-policies) is not a zero-retention guarantee, an account logging-setting audit or coverage of separate search/STT/TTS providers. Do not relax it when a route is unavailable. Audio endpoints require their own verified privacy contract, not an undocumented chat parameter.
- [Gemini terms](https://ai.google.dev/gemini-api/terms) describe improvement use and possible human review for unpaid-service inputs/outputs and prohibit submitting sensitive, confidential or personal information, with regional exceptions. They also restrict the service to professional/business development rather than consumer use. Resolve eligibility and the account's applicable data policy before selecting the optional direct Gemini path for this personal-use project; public source availability alone does not establish permission for downstream model improvement. No automatic switch to an unpaid tier or billing-enabled account is authorized.

References must follow `SPEECH.md`: reviewed General American suitability, rights, natural rhythm, checked transcript and immutable private bytes/SHA. No transport fixture can become a formal reference.

Only after provider/budget and owner readback succeed, enable `pg_cron` and `pg_net` in this dedicated backend. Invoke `install_content_schedule` with this project's HTTPS `/functions/v1/content` URL and the Vault **name**, never a literal credential. This installs the existing six-hour schedule. Read actual job HTTP results and content state; a cron row alone does not prove successful supply. Confirm screened content arrives automatically in Today, remains playable on mobile, and leaves core life-scenario gaps visible rather than relabeling interest clips as coverage.

## 4. Verify production before issuing the release hold

Using legitimate owner sessions and the exact candidate public URL/key configuration, verify delivered OTP, migration of existing local work, separate browser profiles, offline conflicting events, reconnect, retained original audio and unauthorized denial. Use an explicitly permitted temporary preview origin only when necessary; remove it after validation. Do not retarget `cloud-live` or `sync-browser-journey` to production; their local-only fences are intentional.

Verify real provider calls, account usage/retention, reviewed references, approved content reaching Today and actual scheduled refresh. Record only nonsecret evidence: public project reference, candidate revision, UTC check time, reviewer role, migration versions, deployed function versions, audit IDs and pass/fail outcomes. Never retain raw prompts/audio/response payloads, private signed URLs, emails, owner UUIDs, OTPs or keys in Git/CI logs. Save learner work before calling services.

This is not a substitute for post-deployment public-browser acceptance. The public site must still be checked on desktop Chromium, Android viewport and WebKit/mobile WebKit for learning, refresh, offline/reconnect, errors, themes, PWA and persistence. Record physical-iPhone-only unknowns honestly.

## 5. Issue and revoke the commit-bound Pages hold

Freeze and commit the checked source after recording evidence. Do not try to place a commit's own hash inside that commit. Set only these **public** GitHub repository variables for the explicit `mnijc19-netizen/jove-english-os` repository:

- `JOVE_SUPABASE_URL`: exact `https://<verified-project-ref>.supabase.co`, without a trailing slash.
- `JOVE_SUPABASE_PUBLISHABLE_KEY`: this project's browser-safe publishable/anon key, never a server key.
- `JOVE_PRODUCTION_PROJECT_REF`: the explicitly verified Jove target.
- `JOVE_PRODUCTION_READY_AT`: UTC ISO timestamp of actual completed readback.
- `JOVE_PRODUCTION_READY_SHA`: the exact final 40-character source commit; set this **last** using `gh variable set ... --repo mnijc19-netizen/jove-english-os`.

The hold expires after 24 hours and is checked before upload and again before deployment/retry. The live anonymous probes prove only three routes load and reject anonymous access; they do not validate owner membership, key/project pairing, migrations, provider configuration or learning quality. Those facts come from the preceding real readbacks, not the approval variable itself. CI may never set its own approval.

Before changing the target, public key, Auth, functions, provider configuration, scheduler or learner-isolation policy, remove `JOVE_PRODUCTION_READY_SHA` and cancel queued/running deployment attempts. Then perform new readback and issue fresh approval. Removing a variable is **not** instant revocation of a running job's already-resolved environment. Dispatch a complete new run after changes, not a stale artifact's deploy job.

Final acceptance requires the exact deployed commit and successful public owner journeys. Until then `STATUS.md` remains NOT accepted and the goal remains incomplete.
