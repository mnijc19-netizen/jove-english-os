# Authentic content pipeline

## Implemented scope and acceptance boundary

Pure parsers/selection, executable ingest, SQL persistence, actual private clips, authenticated handler, scheduler installation contract, native-audio provider and budget adapter are implemented. Existing Vue/pages, Dexie, evidence, FSRS and Material architecture are retained. Browser integration is main-owned in src/cloud/content.ts.

This is **not production acceptance**. No paid key was read or used by this worker. No actual episode has yet passed provider audio screening and become an eligible recommendation. Test approvals are synthetic test-only data. Outstanding: real budgeted STT/screening → persisted eligible clip → Today → phone/WebKit playback, actual scheduled execution, production auth/deployment, and sufficient daily-life conversational coverage. Credentials explain the first acoustic gate, not the coverage gap.

## Sources and realistic core coverage

Registry configuration is trusted code, never a feed/model/browser instruction. Verified source rights permit screening of owned material; they do not approve audio or clear third-party works.

| Source | Actual feed and transcripts | Rights and supply limits |
| --- | --- | --- |
| The Launch, Jupiter Broadcasting | [RSS](https://serve.podhome.fm/rss/04b078f9-b3e8-4363-a576-98e668231306); Podcasting2 VTT/SRT. [Episode81](https://www.jupiterbroadcasting.com/show/the-launch/81/) has usable836-cue VTT. | [Publisher policy](https://www.jupiterbroadcasting.com/) CC BY-SA4.0 for shows. Host conversations include home/hobbies/camping and technology; latest item observed September2. Some recent VTTs overlap: require actual STT/alignment, not rounded-away overlaps. |
| LINUX Unplugged | [RSS](https://feeds.jupiterbroadcasting.com/lup); [episode683 VTT](https://feeds.jupiterbroadcasting.com/transcripts/lup/bde88c71-5e5d-47ea-b5db-e7af0cd0e5ef.vtt),1008cues. | Same publisher license; latest September6. Work/technology input, not daily-life core by itself. Ads, music, jargon and third-party clips require screening. |
| Hacker Public Radio | [Publisher MP3 RSS](https://hackerpublicradio.org/hpr_rss.php), selected September12 from the [official format list](https://hackerpublicradio.org/syndication.html); older Ogg rules retained. Bounded publisher-specific discovery gives [hpr4721 SRT](https://hpr.nyc3.cdn.digitaloceanspaces.com/eps/hpr4721/hpr4721.srt),1421cues. | [Contribution policy](https://hackerpublicradio.org/contribute.html) CC BY-SA4.0; expressly says whole audio is not moderated. Hobbies/personal experiences, varied accents. Actual4725 MP3/CDN/frame-window transport verified; lesson/acoustic quality remains unapproved. Large Ogg still requires a decoder. |
| VOA Everyday Grammar | [Official directory](https://learningenglish.voanews.com/podcasts), [RSS](https://learningenglish.voanews.com/podcast/?zoneId=4456). No timed transcripts: actual audio STT required. | [Current copyright statement](https://learningenglish.voanews.com/p/6021.html): exclusively VOA-produced text/audio/video public domain with credit; excludes AP, third-party works and logos. **Archive supplement**, latest March12,2025; daily/work language and dialogue examples, not continuing fresh publication or spontaneous-speech certification. |
| Open Yap public sample | [First-party dataset](https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k), exact [preview JSONL manifest](https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k/raw/main/preview/metadata.jsonl),16 MP3 conversations/8.9hours. No verified standalone preview timed transcript: actual STT required. | [Sample-only CC BY4.0 license and privacy rider](https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k/raw/main/LICENSE.txt), conversation-specific consent stated by publisher. Friends/family discuss routines, travel/visa paperwork, cooking, relocation, shopping, social/work/household life. **Archive supplement**, not a fresh recurring recording feed. Full1000h corpus has a separate restrictive Data Use Agreement and is excluded. |

Open Yap is a bounded executable adapter, not a fabricated RSS endpoint: at most128KiB/100rows, strict metadata keys and `conv_<12hex>.mp3` filenames, exact public-preview paths and observed dataset-specific CDN redirect shape. Conditional weekly manifest polling detects publisher updates; it cannot guarantee new recordings. Rounded duration, speaker statistics, topic labels and publisher QA are not converted into measured timing or observed acoustic quality. Existing three continuing RSS sources remain the fresh supply, still technology-biased. Preview MP3s are16–71MB; files above64MiB fail closed. Approximately1GB transcript/audio tar shards are not fetched, and alignment of shard captions with preview mixes is not assumed.

Material.sourceUrl, sourceLabel and license retain publisher page, attribution, license evidence URLs and modification notice. Pipeline records retain complete source/rights snapshots, absolute original interval and original SHA. CC-BY-SA excerpts retain attribution, changes and ShareAlike. Private use does not automatically waive them. A source license or an audio model cannot grant rights to third-party film/music/inserted recordings.

Additional bounded primary-source audit on September8:

- VOA Let's Learn English now has an executable, exact-six-page candidate audit: `auditVoaLessonCandidates({ids?,fetcher?,probeAudio?,now?,signal?})` in src/server/content-voa.ts. [Current first-party usage guidance](https://learningenglish.voanews.com/p/6861.html) permits attributed reuse of Learning English works but excludes agency material; the broader copyright policy also excludes other licensed works. This does not clear background music or inserted recordings. Candidates are separate from ALLOWLISTED_CONTENT_SOURCES and never automatically approved or advertised as new feeds. The final checkpoint below specifies six-item persistence and inventory semantics.
- [Level1 Lesson11: This Is My Neighborhood](https://learningenglish.voanews.com/a/lets-learn-english-lesson-11-this-is-my-neighborhood/3293986.html) binds official audio media3294378 to25 dialogue lines; useful for asking directions/help and errands. Finding a bank/getting cash is NOT account-opening or a teller transaction; apartment location is NOT rental negotiation.
- [Level2 Lesson2: The Interview](https://learningenglish.voanews.com/a/lets-learn-english-level-2-lesson-2/3960471.html) binds media4016512 to40 dialogue lines. Work-skills/interview candidate only; comedic framing and Professor Bot interludes require actual human-audio screening.
- [Level1 Lesson47: How Can I Help?](https://learningenglish.voanews.com/a/lets-learn-english-lesson-47-how-can-i-help/3737352.html) binds media3748838 to39 dialogue lines. Offers help/cooperation, NOT emergency coverage. In-story online course/Master interludes require specific ownership/music review. [Lesson21](https://learningenglish.voanews.com/a/lets-learn-english-lesson-21-can-you-come-to-the-party/3406732.html) explicitly credits another songwriter: excluded, not inferred public domain from its host site.
- The three selected pages have no verified VTT/SRT. Pure `parseVoaLessonPage` preserves plain speaker dialogue, source/page/media/audio binding and potential tasks; timing, alignment, human speech and third-party audio stay unknown. Hashes bind exact returned scripts/media. It rejects changed player/audio URLs, DTD/entities, scripts/embeds and active dialogue; publisher download-control analytics are never executed or imported. It does not fabricate sentence times, strip the interval's unknown rights gate, or claim publisher-script alignment from video timing.
- [American English Everyday Conversations](https://americanenglish.state.gov/resources/everyday-conversations-learning-american-english) has30 publisher-linked MP3 dialogues/PDF, authored by the U.S. Bureau of International Informational Programs: greetings, clarification, restaurant, shopping, directions, transport, help, opinions/social life. [Meal MP3](https://americanenglish.state.gov/files/ae/resource_files/dialogue_2-01_ordering_a_meal.mp3). [Current copyright endpoint](https://www.state.gov/copyright-information/) returns403; per-audio/third-party applicability unresolved. Disabled; not falsely classified as an ongoing RSS feed.
- [ELLLO FAQ](https://www.elllo.org/about/faq.htm) permits downloadable classroom/class-LMS use. A reachable [old primary Mixer index](https://www.elllo.org/english/Mixers/?D=A) describes noncommercial educational CC copying/distribution, but no exact adaptation/STT license version; newer lessons have copyright notices. Strong potential everyday coverage, disabled pending applicable permission, no blanket CC inference/crawl.
- [University of Colima UniSpeak A2](https://redi.ucol.mx/recurso/503) names university authors and links an MP3, but its generic CC BY label does not establish a verified exact license version; human versus synthetic speech and aligned captions are unverified. Metadata endpoint returned404. Recorded in the disabled research queue, not counted as approved human input.
- VOA's official directory also links podcast/?zoneId=1689: HTTP200, latest March31,2025 on this check. Not an answer to fresh continuing supply; outside ingestion.
- Changelog & Friends remains disabled: licensing its terms document under CC does not license all-rights-reserved show audio.

Bank, renting/landlord, interview, disagreement, emergency, airport and NZ transfer still have no verified eligible human clip here. Open Yap materially adds licensed natural everyday conversations without relying on technology shows or audiobooks, but metadata topics are not certified mission coverage. Even for restaurant/shopping/social topics, source availability is not clip approval. The remaining coverage gate is interval-level screening/alignment and current conversational supply; archives alone do not establish6–12months of fresh coverage.

## Executable worker and SQL004

Export runContentRefresh({adminClient,fetcher?,audioStore?,analyzeAudio?,transcribe?,budget?,ownerId?,now?,sources?,sourceIds?,rightsPolicies?,profile?,limits?,analyzerVersion?,transcriberVersion?,costCeilings?,transcriptOrigin?,forcePoll?,signal?}) from src/server/content-worker.ts. Injection seams are trusted server/test code only.

Default bounds:all5allowlisted sources (maximum10),2items/source,6segments/item,25feed entries,90-second job (configurable maximum120s),64MiB episode. Handler uses110s,1item/source,2candidate segments/item. Later runs advance beyond already inspected candidates; first-two rejections cannot permanently exhaust a longer transcript.

004 persists sources, rights checks, items, transcripts, whole-audio assets, segments, **segment audio clips**, speakers, scores, usage, recommendations, learning history and owner profiles. Service-only content_worker(action,args) uses180-second source leases and revision fencing. RLS permits only owner active eligible recommendation/usage/history reads; no browser access to worker RPC or private source/clip registry, and no public Storage policy.

1. Claim lease and revalidate rights before expensive work. Conditional RSS uses ETag/Last-Modified; source+GUID/revision dedupe. Checkpoint ETag only after item persistence. 304 still permits queued work; Retry-After/backoff is bounded.
2. Prefer publisher VTT/SRT/Podcasting2 JSON; cache validated transcript30days. Authorized STT saves real bytes, reserves budget then uses actual audio. Store transcript JSON, original SHA, measured media duration, model/evidence ID/time. New transcripts use `urn:jove:content-transcript:<itemdigest>` in content_transcripts: a non-fetchable database identifier, not an invented public endpoint. Slicing requires the exact trusted item digest plus licensed derivation. External source URLs still reject URNs, HTTP and private/local addresses. Local HTTP Supabase therefore needs no public transcript origin; transcriptOrigin remains only for legacy configured HTTPS references. Restart reuses saved duration and STT, not a paid redispatch.
3. Slice punctuation-bounded30–120s groups. Preserve real cue timing, reject gaps/unfinished tails; internal timing within a multi-sentence cue stays unknown, never interpolated.
4. Inspect the whole interval; validate bytes/hashes/rights/observed facts; enrich meaning question/answer/chunks; upload exactly analyzed clip before eligibility.
5. selectAndPersistContentLessons ranks only eligible work by profile fit, fatigue, source diversity and exposure. Request IDs are idempotent; recent recommendation/use cooldowns apply. recordContentLearningUse saves started/completed/skipped, never ability gains.

## Scheduled rights renewal

content-rights.ts stores reviewed baseline hashes of applicable publisher policy blocks and CC deed text. Full bounded GET of exact approved URLs (including redirects) compares extracted evidence hashes and retains response-body hashes. Extraction is inert, not DOM execution or trust-on-first-use. Changed restrictions/license markup, missing evidence or executable content fails closed.

SQL schedules success recheck after7days, unavailable/changed retry after1day. Only successful unchanged applicable evidence renews rights_checked_at using DB time. 304/network failure does not refresh the date. Prior verification survives temporary outages only within the90-day maximum age; changed policy immediately stales lessons/revokes recommendations. Pipeline verifiedAt uses this real revalidation, so the static original research date does not stop supply after3months. New terms need genuinely reviewed baselines, never blind hash/date refresh.

Explicit `forcePoll` retries an unverified policy during its backoff only by repeating the full approved-URL GET and baseline comparison. A changed/unavailable response still blocks ingestion. Open Yap hashes the complete sample license including its speaker privacy/no-cloning rider; matching only the CC label is insufficient. The full corpus remains outside that license scope.

## Actual audio model and byte binding

Normal route uses existing server OPENROUTER_API_KEY and google/gemini-2.5-flash; each job checks current catalog audio-input/structured-output capability. [Official OpenRouter docs](https://openrouter.ai/docs/guides/overview/multimodal/audio) support real base64 input_audio on chat completions for analysis; plaintext STT is not acoustic evidence. Optional JOVE_CONTENT_AUDIO_MODEL selects another checked model. JOVE_CONTENT_AUDIO_PROVIDER=gemini plus optional GEMINI_API_KEY uses direct fallback. No third key required normally; both routes inspect exactly persisted clip bytes.

Analyzer input: request ID/fingerprint, immutable episode bytes/SHA/MIME/path, segment/absolute interval, current rights snapshot/hash, abort signal. Required output:

- Original audio SHA, measured container duration, exact inspected whole interval.
- Observed or unknown human/English speech, accent, clarity, noise/music, speaker count, alignment, coherence, safety, third-party status and learning value; method/version/provider ID/time/confidence.
- Trusted-source-policy-and-audio-screen rights record with source/hash, policy URLs, check time and third-party status.
- audioEvidence with original SHA, **submitted clip SHA**, submitted absolute coverage, exact inspected interval, timing basis and independently heard timed cues.
- Validated lesson plus actual usage and nullable actual cost.

Worker independently recreates the clip and requires exact submitted SHA/timing equality. MP3 uses actual LayerIII frames with2s reservoir preroll and bounded trailing context; WAV uses exact PCM16 samples and a corrected RIFF header. Never proportional byte slicing. Encoder delay is decoder-dependent: independent heard-caption alignment remains necessary. Frame counting is not acoustic measurement. Large Ogg/page-spanning packets and unsupported M4A need an actual bounded decoder/remuxer; no fake page cuts.

Required confidence≥0.8; provisional thresholds clarity≥0.75, noise≤0.15, music≤0.05, alignment≥0.9,≤4speakers. These are product rules over qualitative model estimates, not calibrated phoneme/CEFR measurements. Alignment compares independently heard words and endpoint timing. Unknown/mismatched facts quarantine. Clean owned speech can pass trusted source+real audio screening without owner manual approval of each lesson; a model cannot clear third-party legal uncertainty.

## Exact browser/clip API

Bundle createContentHandler(env) from src/server/content.ts. Browser POST uses main authenticatedOwner. All responses are no-store. POST {action:'lessons',profile,limit?,requestId?} returns {lessons,requestId}. EligibleContentLesson={recommendationId,segmentId,material,fit,playback,timedSentences,reason}.

~~~ts
type ContentPlayback = {
  bucket: 'jove-content-audio'
  objectPath: string // clips/<segmentDigest>/<clipSHA>
  audioSha256: string // persisted CLIP
  startSeconds: number; endSeconds: number // clip-relative, includes preroll offset
  sourceAudioSha256: string // original EPISODE
  sourceStartSeconds: number; sourceEndSeconds: number // episode-absolute
  clipOriginSeconds: number
  timingBasis: 'complete-container' | 'mpeg-frame-count-with-preroll' | 'pcm-sample-count'
  mimeType: string; byteLength: number; durationSeconds: number // actual clip
}
// POST {action:'audio',segmentId}:
type AudioResponse = ContentPlayback & {
  segmentId: string; sourceId: string; url: string; expiresAt: number // epoch ms,300s
}
~~~

timedSentences are learning-segment-relative: seek=playback.startSeconds+sentence.startSeconds. sourceStartSeconds=clipOriginSeconds+startSeconds. A source30–90s MP3 window with origin27.977142857s plays approximately2.022857143–62.022857143s in the clip. Do not add source offset twice.

content_segment_audio owns actual clip/SHA mapping. Signing/recommendation no longer needs retained whole episodes. Mobile fetch≤10MiB, not whole40-minute audio. Main persists non-signed Material.authenticPlayback and coupled sentenceRanges, caches blobs as content-cache, never uploads them to jove-recordings. No synchronized signed URL/JWT/audioId/audioPath cache handles.

Public origin config: JOVE_PUBLIC_SUPABASE_URL > SUPABASE_PUBLIC_URL > SUPABASE_URL. Only clean publicHTTPS origins or dedicated local HTTP127.0.0.1:55321/localhost:55321. SDK http://kong:8000 URLs are rebased only after internal/public origin, exact clip path and single-token checks. Host/Forwarded/browser input cannot choose origin. Storage GET uses signature only, no bearer header. [SDK source](https://github.com/supabase/supabase-js/blob/master/packages/core/storage-js/src/packages/StorageFileApi.ts) confirms signed URLs prepend configured client base URL.

Other POST actions: history(segmentId,eventId,event), status, bounded refresh. No arbitrary source URL/owner override accepted.

## Scheduler, budget, network and retention

- Scheduler: POST{}, no Origin, X-Jove-Content-Job matches JOVE_CONTENT_JOB_TOKEN≥32characters. Construct service client only after validation; require exactly one configured owner.
- 004 install_content_schedule(edge_url,vault_secret_name) requires dedicated HTTPS Supabase/functions/v1/content target, jove-content-job-* Vault credential and pg_cron/pg_net; minute17 every6h. Migration does not install extensions/secrets/start jobs. Main provisions routing/Vault and migration; custom job auth is mandatory if platform JWT verification is disabled for scheduler.
- Budget reuses main reserve(ctx,requestId,fingerprint,'content',estimate) and dispatches only with reservation.acquired. SQL003 owns ledger;004 content usage. Unknown cost stays unknown/held. Uncertain dispatch preserves work and needs reconciliation, not silently paid replay.
- Before downloading an episode or reading its private cached bytes for STT/screening, the production budget adapter checks `service_budget_available`. This read-only, service-role-only, security-invoker RPC uses the same UTC-day/month reported-or-held totals as the atomic reservation; missing preferences, zero/insufficient allowance or an unavailable RPC prevent this media I/O without enabling a default allowance. Metadata and publisher transcripts can still refresh. The snapshot is advisory: a competing request may spend the budget while media is in flight, so the original atomic reservation remains mandatory before provider dispatch. This does not make all feed/Storage traffic free or include egress in AI totals. Apply `20260910115020_content_budget_preflight.sql` before deploying the new content bundle; an older database fails closed.
- Node queries both A/AAAA directly, rejects any private/special-use answer, pins a checked address via HTTPS lookup/TLS hostname and rechecks all5manual redirects. Windows OS lookup was observed adding a Teredo transition address for Hugging Face, correctly rejected by the public-address guard; direct DNS resolves actual publisher A/AAAA records instead. This is not an IPv4-only retry or ignoring unsafe answers; mixed public/private answers still prevent any socket. [Node DNS documentation](https://nodejs.org/api/dns.html) distinguishes OS lookup from direct record resolution. Deno has DNS preflight but **cannot pin** fetch's eventual answer; use controlled public-only egress or pinned Node transport, and report this limitation.
- Limits:12MiB RSS,2MiB transcript,depth32,150k XML nodes,30k cues. DTD/entities/scripts/active attributes/namespace spoofing/unsupported timing fail closed. No DOM/XSLT/HTML execution. Compressed responses rejected. Publisher-specific query/path rules only. ART19's actual GET adds a signed CDN hop hidden by HEAD; exact observed path shape allowed, no expiring URL in static registry.
- Whole cache256MiB,≤64MiB/object,3-day retry retention; finished/stale items cleaned on subsequent jobs. Clips512MiB,≤10MiB and123s with context,≤90days. Capacity reserved transactionally before upload; preparing/ready/deleting states prevent serving incomplete uploads. Cleanup first withdraws expired clips, removes exact content paths, then acknowledges metadata removal; failed deletion retries. Never deletes personal recordings. Capacity exhaustion is an explicit gate. Clip retention is separate from renewed rights and continuous discovery.

## Actual verification

September8 content + real local PostgreSQL + actual publisher ingest passed **191/7skipped (198total)** including the SQL assertion and VOA candidate regressions (JOVE_CONTENT_LOCAL_TEST=1,JOVE_CONTENT_PUBLIC_INGEST=1). The seven skipped tests are3live transcript checks and4audio probes; the exact-three-page VOA audio probe passed separately. Scoped ESLint and whole-project `npm run typecheck` passed after the VOA candidate implementation. The deadline regression uses explicit before-dispatch/after-dispatch latches and controlled timers, preserving zero spending before dispatch and uncertain accounting after dispatch without increasing the deadline.

Whole-project `npm test` at17:35 passed1070/43skipped with2failures in main/speech-owned pronunciation-components.test.ts: account invalidation and unresolved initial owner binding still exposed a historical download link (lines593/611). Both were independently reproduced by a narrow rerun and reported to main; no shared/speech fixes made here. Content tests and both worker-deadline boundaries passed in that full run. Therefore the project-wide suite was not green at this check.

Independent read-only Review/repository audit reproduced two ambiguous legacy attempt-identity cases. Franklin fixed both: original old-card identities are recovered per item; already-canonical raw history without durable IDs remains ambiguous and is rejected without selecting/deleting drafts. Latest independent `npx vitest run tests/sync.test.ts tests/review-sync.test.ts tests/db.test.ts` passed63+6+71=140, covering positive original-source recovery, unrelated alias reviews, UUID/rebase/failure/reload. Report sent to Franklin and main. No sync/UI/repository files edited by this worker. This scoped sign-off is not production/WebKit acceptance.

Heisen's independent SQL review caught nullable `<>` assertions: missing RPC JSON fields could previously produce SQLNULL and escape PL/pgSQL IF. All six comparisons in content.test.sql now use IS DISTINCT FROM. New real-Postgres tests run the original acceptance in BEGIN/ROLLBACK, then mutate each of six observed return values in memory into both missing-field and JSON-null cases:12/12 raise the exact intended assertion. Seven tests passed. No RPC/product-schema mutation occurs; each failed transaction closes/rolls back. SQL004 remains unchanged.

Actual PostgreSQL exposed JSONB object-key reordering that mock persistence missed: canonicalContentJson now stabilizes timing fingerprints and bound audio snapshots across JSONB. Regression tests cover this and persisted STT URNs/durations/resume without a second provider call. SQL fixture approvals are **synthetic only**; audio storage is MemoryAudioStore, not proof of actual Supabase Storage/HTTP signing. Randomized fixture sources, memberships and auth users were precisely cleaned; no unknown owner rows were touched.

~~~powershell
npx vitest run tests/content-worker.test.ts tests/content-pipeline.test.ts
npx eslint src/server/content.ts src/server/content-*.ts src/content/pipeline*.ts src/content/sources.ts tests/content-worker.test.ts tests/content-pipeline.test.ts
npm run typecheck
$env:JOVE_CONTENT_AUDIO_PROBE='1'
npx vitest run tests/content-worker.test.ts -t 'actual public audio'
Remove-Item Env:JOVE_CONTENT_AUDIO_PROBE
# Main has applied002–005 in the dedicated local backend:
$env:JOVE_CONTENT_LOCAL_TEST='1'
npx vitest run tests/content-worker.test.ts tests/content-pipeline.test.ts
Remove-Item Env:JOVE_CONTENT_LOCAL_TEST
# Exact actual-publisher persistence run (no paid key; retains public-source evidence):
$env:JOVE_CONTENT_LOCAL_TEST='1'
$env:JOVE_CONTENT_PUBLIC_INGEST='1'
npx vitest run tests/content-worker.test.ts tests/content-pipeline.test.ts
Remove-Item Env:JOVE_CONTENT_LOCAL_TEST
Remove-Item Env:JOVE_CONTENT_PUBLIC_INGEST
# LIVE_CONTENT_PIPELINE=1 enables three continuing-feed transcript contracts.
~~~

The latest actual-publisher persistence suite passed after correcting a real first-run DNS failure and testing real policy retries. Repeated runs assert persisted evidence rather than requiring duplicate new writes (RSS runId42fccafe-9a07-4ba8-9360-046afad0d466). Fresh SQL readback confirms28real items,5validated publisher transcripts,8quarantined segments and **0genuine eligible lessons**:

| Verified policy/source | Items | Validated transcripts | Quarantined segments |
| --- | --- | --- | --- |
| hacker-public-radio | 3 | 2 | 2 |
| jb-linux-unplugged | 3 | 2 | 4 |
| jb-the-launch | 3 | 1 | 2 |
| open-yap-sample | 16 | 0 | 0 |
| voa-everyday-grammar | 3 | 0 | 0 |

All5source policies are verified in actual PostgreSQL. Open Yap has2awaiting-analysis/14pending items: no timed transcript or acoustic facts invented. Its persisted policy evidence SHA is530dfabbdd3bb641c601b665c52aa94ecbeb7f513a170dc388ff59b77d4248ea; complete response SHA5207183619ef6bb25ac7c16f3358d76a6678b0a8c7c13888e92f4cf04b17d198. The real preview manifest SHA was8b0ed918ae10739fe20e9a0cc34885117b0b9dcd0aa5dcc099c49678386fdc0e. Randomized fixture source count after cleanup is0. Actual publisher records are deliberately retained.

Real publisher/policy bodies reached the executable worker and dedicated PostgreSQL RPC; these are not static fixtures. Remaining item gates include unusable captions requiring STT, incoherent caption windows, further segments awaiting processing, and unconfigured audio analyzer. No provider audio approval or unknown cost was fabricated. These rows remain for main's integration.

Actual public default-network audio probes cover these3sources (earlier VOA/LUP2/2passed; new OpenYap1/1passed after direct-DNS correction), no paid call/acoustic approval:

| Source | Complete bytes / container seconds | Clip bytes / absolute coverage | SHA256 |
| --- | --- | --- | --- |
| VOA Everyday Grammar | 5377174 /347.088979592 | 939884 /27.977142857–90.253061224 | Original58b7a8b505b2ef490c479e943f14c3f8032e689cdb4bbd8cfdfb3a87ed4943e9; clipac0120a680cbb4e0ea740e761b4b632620796be8408de64e10f81592d5f6ce79 |
| LINUX Unplugged683 | 63898349 /3986.128979586 | 996414 /27.977142857–90.253061224 | Originalea900373fbeb1887b36544f3ddb047ccccf8f177bdd54a3528a2bdefe91cb669; clip3fad804825ce6425575cfabf2f671e12e5e9f50053443d7a49b66b3aa9131fc6 |
| Open Yap travel/visa conversation conv_d4005da6db98 | 27467181 /1716.696 | 996480 /27.984–90.264 | Originalee95c93cbceb1af3c41b34656585177bda36ef43fd90aad45901e705eae46ed3; clip0164963d82d75eb74e777e74d6a98457286dc1d4655fa4282f4154bcbf0e72e4 |

The earlier actual VOA candidate/audio test passed for the first3exact pages using the real default network; the final six-item test below also passed. These are research probes, not SQL ingestion, Storage uploads or approvals. All requested30–90s clips contain498207actual bytes with frame/preroll coverage27.977142857–90.253061224s:

| Candidate | Original bytes / seconds | Original SHA256 | Clip SHA256 |
| --- | --- | --- | --- |
| Neighborhood | 884445 /110.550204082 | b22a6f0531dcf943a2b23d5bd09696f2cfc5970f50a3911082b457c532625c6e | 42f29446ed34febbb784db1dedd543218f8778eff4cebd9b1f6cd70cea9d2515 |
| Interview | 1963715 /245.446530612 | 6d9fd55cf3466a77f3cb7a6ea801d06cadc8aac88be3aedc84644eeb73ebba72 | 08d28c0bca6601e8317c35c55f89b0f10d83e984d4bc04675a83a35a7d68bcb4 |
| How Can I Help | 1533364 /191.660408163 | 2d28fd1c868f92fe4cf5cfa21bb2fdff7ac1cd174f13106cfd40cb46a9c79c67 | 79a19d9f65faee8c195c46ab0790fb44897a70e355d40654f34455bfa71adc0c |

Corresponding plain-script SHA256s: Neighborhood74bc225c364cde0113fc3f63a2d9439804fd5c00e315f13219380a2cd169301a; Interview406ac9de73ddd29afe70a8ba37ef249f73e696a6ad5ac09aa7727d126fb52b07; Help35a320ff0827b7f2fda1a7ff323ec64a091fa5c5bd2caa89abdbe994419ee9db. Absence of a third-party credit string is explicitly NOT a clean-audio rights finding. Current gates remain exact item/interval rights review, actual timed audio alignment and human-audio screening; renting/banking/emergency and17-mission coverage are still incomplete.

Publisher enclosure lengths differ from actual response bytes: hash actual media. Probes hold bytes in memory, do not publish clips/set reviewed flags. HTTP200/frame counts do not prove human/GA speech, clarity, timing alignment or playback on WebKit.

004+supabase/tests/content.test.sql previously executed on dedicated local Postgres inside BEGIN/ROLLBACK: readiness, whole removal preserving clip playback, expiry withdrawal, rights renewal/leases/role denials. Main has now persistently applied002–005 and reported RLS=true/versions001–005; this worker ran real persistence afterward. Stable004 SHA remains ada468eee3dd2d90f0b77655617405824801972ee9156b510a5ae458c4b3f003. This worker has not applied migrations, committed or deployed. Actual Storage upload/sign/HTTP download, budgeted real acoustic review, owner recommendation, scheduled dispatch and desktop/mobile production acceptance are still separate gates.

Owned files: src/content/pipeline.ts,pipeline-types.ts,sources.ts; src/server/content.ts,content-contracts.ts,content-network.ts,content-rights.ts,content-audio.ts,content-worker.ts,content-voa.ts; tests/content-pipeline.test.ts,content-worker.test.ts; supabase/migrations/202609080004_content.sql; supabase/tests/content.test.sql; this guide. Main owns shared schema/types/browser/Today/player/docs/status. Independent sync review findings are sent to Franklin; this worker does not edit sync.

## Final six-scene / 17-task checkpoint — September8

This checkpoint changes only sources.ts, content-voa.ts, content-worker.ts, the two content tests and this guide. SQL004, shared types, UI and HTTP handler remain unchanged. Under src, sources.ts has only two runtime importers: server/content-worker.ts and server/content-voa.ts. No frontend import was found; no frontend rebuild or new artifact-hash claim is made. Earlier whole-project results above are historical; main owns the current full merge/CI evidence.

The fixed batch adds the following three exact first-party pages to Neighborhood/Interview/Help, with no further source expansion:

| Candidate | Publisher page / player | Actual MP3 bytes / frame duration | Original SHA256 / clip SHA256 |
| --- | --- | --- | --- |
| Food ordering, unavailability, change | [Lesson23](https://learningenglish.voanews.com/a/lets-learn-english-lesson-23-what-do-you-want/3413753.html),3437143 | 1419642 /177.449795918s | 42d83f7eb8126e78eba8c7b97efc5855de2ff000d741b81fe17d67828eafdda6 / a69d7336a473513103dd85e670db44454c101b7db3cea0a0b913d612fbe1aed6 |
| Opposing views / disagreement | [Lesson37](https://learningenglish.voanews.com/a/lets-learn-english-lesson-37-lets-agree-to-disagree/3574029.html),3601381 | 1743560 /217.939591837s | f68b68c6db0f2ce8c94c04501615f9809656dd3279d5e8ac3ab63d07b3c40882 / 957fa2e5516996d48564798b5e1c16dc830069e152335924e3c0068d86f62a8f |
| Wallet loss / requests to friends | [Lesson43](https://learningenglish.voanews.com/a/lets-learn-english-lesson-43-time-for-plan-b/3666458.html),3681422 | 1750039 /218.749387755s | 3e813268b3ea2ef90b8218c0109afbd7728eb9e0ac51068bd7d127db20f2a6c3 / 034763311ab5d7621f95a6936859cb1ce216c0ba43d309b3f4a91bfc24462470 |

Script hashes: Food925ee23bb85f8f6e24b4dba9420196b5d087910c72b5d36d54aa678ef6dcc99a (44lines), Disagreement d6201a804e87c6058050b4fee49ecb67bd1d0122b893f1c53fdd6889c81ba9d8 (24lines), PlanB f3fd277cc3667117a0a556a9217f6bc95654c9f5704600cab4a6eb8e70c5760c (34lines). These pin editorial dialogue rules, NOT audio approval. PlanB includes singing; music/uncleared inserted works remain subject to actual inspection. Practical help is not emergency-services coverage; a friend mentioning an airport is not check-in/security/gate dialogue. All six lack verified timed captions and remain candidate/unknown.

### Executable no-paid pilot

The normal worker audits the six exact pages when VOA's existing poll is due. Curation contracts enter that source's config hash; changed contracts cannot silently retain old bound segments. voaPilot accepts metadata (default), probe-audio, or disabled. It stores six exact voa-pilot:<candidateId> GUIDs through existing lease/ingest RPC in content_items.episode.candidateAudit: plain publisher text, unknown timing/coverage, page/audio binding, hashes, limitations and optional real audio probe. transcripts stays empty until actual timed STT/publisher cues exist. feedUrl is the source-registry identity, NOT a claim the scene came from RSS. Publication date remains null, not today's date.

Revision uses ID/audio URL/script/normalized third-party notices/policy hashes, not retrieval time, page chrome or optional probe mode. Unchanged stored snapshots keep their original checkedAt (not a fake latest audit); fresh probes still appear in audit results. Known publisher third-party declarations are copied to licenseNotice and cause a hard quarantine BEFORE STT/audio analysis. An acoustic none-detected result can never clear them. A new declaration changes the revision; existing004 ingest resets the item to pending, stales all prior segments and deactivates recommendations. No004 edit or006 migration is required.

Run from an already authenticated dedicated server job; never send its service client to a browser:

~~~typescript
import { runVoaCandidatePilot, readOwnerContentTaskInventory } from './content-worker'
import type { OwnerContext } from './gateway'

export async function noPaidContentPilot(ctx: OwnerContext) {
  const trial = await runVoaCandidatePilot({
    adminClient: ctx.admin, ownerId: ctx.ownerId, probeAudio: true,
  })
  const inventory = await readOwnerContentTaskInventory({
    adminClient: ctx.admin, ownerId: ctx.ownerId,
    profile: { targetDifficulty: 0.45, fatigue: 0, interests: ['Everyday life'], requireGeneralAmerican: true },
  })
  return { trial, inventory }
}
~~~

runVoaCandidatePilot validates the unique configured owner before writes, accepts/forwards no analyzer/STT/budget callbacks, and performs only rights verification, six page/optional in-memory audio probes, metadata ingest, inventory reads and lease release. No RSS discovery, provider calls, Storage uploads/retention, recommendations or ability updates. Extra runtime callback keys are not forwarded. It returns the ordinary summary plus voaPilot/inventory/refreshSelection. The existing authenticated/scheduled refresh HTTP response transparently carries these additive fields. The standalone inventory read is an exported server API, not a new HTTP action. Existing lessons/playback contracts do not change.

### Single-owner inventory semantics

OwnerContentTaskInventory reports current owner-selectable unseen stock, not proficiency or the entire collection. Exactly the existing17dimensions: meeting, small talk, restaurant, shopping, transport, airport, renting, landlord, bank, work, interview, clarification, disagreement, opinions, social, emergency, living abroad.

- Per task, configuredCandidateIds / auditedCandidateCount / reviewedUsableCount remain separate. Candidate labels NEVER count as reviewed coverage. Audit readback uses only six exact GUIDs and explicit columns through the existing SDK; failed/RPC-only readback yields null/unknown, not zero. Unique owner validation precedes private reads. A null inventory request ID cannot match a recommendation request and bypass cooldown.
- Current SQL eligibility, revision, rights, ready/unexpired clip and owner cooldown are followed by fresh profile-specific quality/enrichment checks and original/clip SHA plus interval binding. Duplicate content fingerprints count once. GA still requires acoustic observation when requested.
- Supported tasks require a trusted system review bound to segment/content/timing/original SHA/policy, with reviewer/evidence/version/time and at least two distinct aligned sentence quotations. Both creation AND inventory readback require those quotations in independently heard cues in the same sentence intervals (maximum1.5s boundary tolerance, never outside the analyzed clip). A single keyword, absent heard cues, shifted quotes or unknown audio cannot establish stock. Custom semantic review is trusted server analyzer output, not browser/source input.
- Default narrow VOA rules additionally require the pinned publisher script AND both dialogue acts heard inside an already eligible clip. Current rules support restaurant order/unavailability, disagreement/opinions and social request/refusal. They do not infer shopping, bank, airport or emergency from nearby vocabulary. This is machine-text task matching on separately screened audio, not another acoustic classifier or owner manual approval. Unmatched dimensions stay unknown.
- The existing candidates RPC caps at100 and cannot paginate. A full window sets windowComplete=false/countBasis=lower-bound; absent/low task stock stays unknown, not a proven whole-library shortage. Unknown semantic classifications also preserve unknown. Fewer than100 fully classified rows can establish a gap only in this current owner-selectable reservoir. No SQL was added to hide the limit.
- Default lowWater=2 distinct clips (configurable1–10), explicitly provisional, not a scientifically calibrated or date-based target. gap/low/sufficient/unknown and needsAttention are explicit. Notices include life-task-reviewed-inventory-gap, life-task-inventory-low, life-task-inventory-unknown and content-inventory-window-limited. nextExpectedSupplyAt and estimatedDaysRemaining are always null: no invented expiry or publication plan.

Refresh prioritizes existing everyday archive work when task stock is low/unknown, rotates it by UTC day for a one-source budget, then retains mixed continuing feeds/interests. Rotation is dispatch selection, not evidence of new publication; real SQL due/ETag/lease gates still apply. Recommendations prioritize reviewed deficient tasks, then nontechnical text-topic variety, then fit/source diversity. Topic heuristics never increment task counts. Technology+Work or Technology+other topic labels remain restricted unless a valid reviewed task exchange supports them; Work-only and unknown topics also do not prove nontechnical life coverage. Restricted entries have a multi-item limit of floor(limit/2), minimum1. Insufficient variety returns a shorter batch, not counterfeit core stock. A single-item request can still receive one eligible technical clip if no suitable alternative exists.

The yearly nontechnical supply gate remains open. Archives are finite, not fresh continuing feeds. [The Bugcast publisher](https://thebugcast.org/2026/08/22/908-dove-distinction/) has current family/culture chat, but music is mixed and applicable dialogue reuse permission is unresolved. Its [HTTPS RSS](https://thebugcast.org/podcast/feed/) returned20items/September5 Last-Modified with no transcript/chapters tags; it is NOT allowlisted. No email, purchase, paid call, new source or publication promise was made. Owner must configure the existing OpenRouter key in this dedicated backend and approve a capped real audio trial; permission and missing task interactions remain separate from credentials.

### Checkpoint verification

- Targeted content units:196passed/21skipped,217total. Scoped ESLint passed. Regressions cover candidate-vs-reviewed, unique-owner rejection, no-paid metadata persistence/dedupe, changed rights, unknown readback, quote/heard/same-sentence timing/hash/script mismatch,100-row saturation, low-water, source rotation, Technology+Work restriction and both first/new third-party declaration cases. Synthetic analysis/DB fixtures are explicitly test-only.
- Actual six-page+MP3/frame probe: session27669, final exit0, September8 18:34:08 start,21.94s test time. One test contains all six real assets;96 other tests skipped by name. Each requested30–90s clip contains498207actual bytes with frame/preroll coverage27.977142857–90.253061224s. Acoustic flags remain false/unknown. No Storage upload or paid call; this observation is retained, not rerun after metadata-only fixes.
- Actual dedicated local004 notice-withdrawal test: September8 18:49:43, exit0,1passed/99 name-filtered skips,661ms. Real worker generated clean/changed-notice revisions; a random isolated source/owner and explicitly synthetic ready/eligible fixture ran inside BEGIN/ROLLBACK. Existing ingest preserved the declaration/new revision, reset the item pending, staled the old segment, deactivated recommendations and made playback raise42501. Exact source/auth-user counts after rollback were both0. No real owner record was modified; no product migration.
- The subsequent leased no-paid persistence acceptance below closes the six-real-publisher-row gap in the dedicated local PostgreSQL backend. It does not substitute for actual acoustic approval, production HTTP/owner journeys or a functions deployment. Main owns those gates.

~~~powershell
npx vitest run tests/content-worker.test.ts tests/content-pipeline.test.ts
npx eslint src/content/sources.ts src/server/content-voa.ts src/server/content-worker.ts tests/content-pipeline.test.ts tests/content-worker.test.ts
npm run typecheck
$env:JOVE_CONTENT_AUDIO_PROBE='1'
npx vitest run tests/content-worker.test.ts -t 'binds six exact VOA'
Remove-Item Env:JOVE_CONTENT_AUDIO_PROBE
$env:JOVE_CONTENT_LOCAL_TEST='1'
npx vitest run tests/content-worker.test.ts -t 'rolls back a real publisher-notice revision'
Remove-Item Env:JOVE_CONTENT_LOCAL_TEST
~~~

### Actual six-candidate metadata persistence — September8, 19:30 CST

The existing `runVoaCandidatePilot({adminClient, ownerId, probeAudio:false})` ran against the real dedicated `supabase_db_jove-english-os` container (DB55322, associated local API55321), using its unchanged SQL004 RPC plus a test-only, strictly bounded read adapter. This was committed PostgreSQL persistence, not MemoryRpc, a rollback-only demonstration, an HTTP/Edge deployment or an audio approval. The seven distinct network pages were the exact reviewed publisher policy and six approved lesson pages, through the normal bounded/DNS-pinned Node transport. No fixtures supplied the publisher text; no audio/STT/analyzer/budget/Storage callback was used.

- Authoritative exec session72928, terminal exit0:1passed/102name-filtered skips; test18.12s. Worker runId `044e4ac8-ad9c-4bd0-8ce2-31104f4dc8f0`, `2026-09-08T11:29:51.602Z` to `2026-09-08T11:30:08.095Z` (19:29:51–19:30:08 CST).
- Six new exact `voa-pilot:*` items persist as `pending`, candidate eligible=false, humanAudio/thirdPartyAudio/taskCoverage=unknown, transcript timing=unknown/alignment=unverified, audioProbe=null, publishedAt=null and transcripts=[]. The source now has9items: the prior3RSS items plus these6. Actual inventory readback reports17tasks, observed candidate inventory and0reviewed usable; it invents neither publication dates nor days of supply.
- Fresh observed policy evidence hash `108c9e0faf8523aecb90d79ab979f7f47c72a110fa3b2935208bfa99519a43f8` matched the pre-reviewed baseline. Script, audio URL, normalized third-party notices and that policy evidence were recomputed against each stored revision. Publisher attribution/notice fields were checked unchanged. Publisher policy verification is NOT clearance of third-party works in the recordings.
- Worker post-cleanup SQL readback: members0, this marker's fixture owners0, active leases0, six pending/unknown-human candidates, pilot transcripts0, pilot audio assets0, VOA segments0, global eligible segments0. Main subsequently independently confirmed members0, VOA items9/pending9, VOA segments0 and global eligible segments0. Only the random owner with its exact fixture marker was deleted (its membership cascaded); all genuine candidates remain. The local SQL/Auth fixture lease was returned immediately after readback.

The first real attempt,19:25:01/exit1, deliberately failed closed at `voa-local-config-would-reset-other-items`: it created no owner, made no public request and wrote no database state. SQL004's normal configuration transition would reset the three existing RSS queue entries. Main then explicitly authorized ONLY the observed old hash and GUID/state combination. The guard remains closed on unknown items/configurations, owners, missing/null counts, active leases or existing eligible/VOA segment/recommendation rows. The legitimate config transition was retained:

`f473de49e3819a90413333278d13599143b95a894e6d5de7cc879db4765b8cbf` → `2427e115411b4559c7195f6ccf1f3feef78ebcf82b9ea639b45e998e7ffa4b88`.

Each of the following exact RSS GUIDs changed only awaiting-analysis/attempts1 → pending/attempts0, with next_attempt_at set by the real claim. SHA256 of the complete item metadata excluding ONLY those three mutable queue fields matched before/after; thus episode, revision and all other item fields were preserved. Separate whole-table fingerprints also matched for existing transcripts/audio assets, segments/clips, speakers/scores, usage/history/recommendations/profiles and all other sources/items. No existing audio was downloaded or re-approved.

| RSS GUID suffix | Before = after metadata SHA256 |
| --- | --- |
| /7979758.html | 40684d649631363c6d348549cc25e35c5e5b99dfc86aded5cdda5bc73aeeabf3 |
| /7987362.html | ab40d942ea6ad472b2066c6e09f3a04c5ec05b42a6d7ff12a5a406922d466697 |
| /8008295.html | 3ef9d6c527e27b86f5068e34a3fb08a5fb74195e0ecadbf08c3396bf6f619ace |

The six persistent snapshots below retain the script hashes already recorded above. Page hashes bind the actual HTML fetched by this run; later unchanged-revision polls intentionally retain the earlier snapshot/check date rather than falsely claiming a rewrite.

| Candidate ID (after voa-pilot:) | Stored revision | Page SHA256 |
| --- | --- | --- |
| voa-lle-disagreement | 3d3930e0e00c4096530f6599d914792fde3ea4d54835f67fbddf6d9564b94620 | 40b6546c14f7618f6f2e43c9c9bce75b794496f8a22462b4a17715e6cc31320e |
| voa-lle-food-trucks | fec088df58e5792712b82994f102d2e64b6c56de58f0d2f0f0e514aac65b729e | 76548a4d276489caba4fd56d568d715a285b0d8b8059269cab99d7e4e6581576 |
| voa-lle-help | d784524c9c980acb98d9857753e1328623bea2a6c097f4b2b6a243fa24d4945f | 29a0022ccaf1273513a64716f5403b4c66b5aa7fb0ce63da63e4c4abded00a86 |
| voa-lle-interview | a825e0fb9a57c6539d64ad4e234f13b3e0c07e170a803eed0aa3b02b3bc0b8f5 | 637582b2e7e367ed862bb1f53a4cb2cc856c7b478f8f8c8706922916d759973d |
| voa-lle-neighborhood | 93ca4e3886746c731871f928df69d48717d724c6fe86e84fa16e8838f21b5b30 | 14de0d4a12869a345a8f6a3d1f69de19769e94b247fe318d5081617ed02b8e4e |
| voa-lle-plan-b | 2314714b5bce994130c4db3f1848819343d8d6e776960800a9bfc8f920c7812e | 3ad2362aa21960cd01e3442eb0596ab85881e4b51a445ade234c0e57cacbc71e |

Reproducible command: all three opt-ins AND a newly granted exclusive local fixture lease are required. Do not run alongside main's Auth/SQL tests or with a personal member configured. This intentionally does not invoke the older broad synthetic-eligible acceptance suite:

~~~powershell
$env:JOVE_CONTENT_LOCAL_TEST='1'
$env:JOVE_CONTENT_PUBLIC_INGEST='1'
$env:JOVE_CONTENT_VOA_PERSISTENCE='1'
try {
  npx vitest run tests/content-worker.test.ts -t 'persists and reads back exactly six real VOA candidates' --reporter=dot
} finally {
  Remove-Item Env:JOVE_CONTENT_LOCAL_TEST,Env:JOVE_CONTENT_PUBLIC_INGEST,Env:JOVE_CONTENT_VOA_PERSISTENCE
}
~~~

The test-only adapter also has two no-DB safety regressions (occupied/missing/null safety counts; unknown GUIDs/configs and the exact authorized baseline). Whole-project typecheck and scoped test-file ESLint passed before the actual run. A first TypeScript-only adapter return-type failure was corrected to explicit Promise; no production helper changed. The earlier six-audio probe was NOT rerun. Real paid audio inspection, approved clips, complete17-task coverage, continuing nontechnical supply and production owner journeys remain open.
