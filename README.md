# Jove Language OS

Formerly Jove English OS. The repository, public URL, PWA scope and existing English learning data stay unchanged. English and Japanese share infrastructure, but keep their curricula, learner evidence and reviews separate. Public activation and current acceptance evidence are tracked in `docs/STATUS.md`; the approved objective is in `docs/FINAL_UPGRADE.md`.

A personal, local-first language trainer for a native Chinese speaker, focused on natural listening and spontaneous speaking. It connects input, comprehension, chunks, retrieval, conversation, correction, delayed review and new-context transfer. Learning estimates carry evidence; completing a page never establishes mastery.

## 新课堂试用版：教学验证尚未完成

10月3日文书要求的改版已实现，主人批准明确标注为有限试用版；是否已发布、确切版本及验收记录以 [项目状态](docs/STATUS.md) 为准。英语和日语各有三节原创入门课：先用中文解释、听一句短示范，再认意思、拼一句、表达自己的意思；遇到困难可缩小任务，不要求先会写或先会五十音。隔天到期后用不同场景复用，不把照着提示答对算成独立掌握。

试用版从 Today／日本語的课堂主按钮开始，跟随每一步的一个主要动作；“听不懂／需要帮助”保留辅助示范，录音不可用时可点选或打字继续。原有练习在另一个可展开区域，旧记录不清空。AI 是可选的当前回答纠错，先保存原答案再请求；失败时仍能继续本地课。短示范明确标注为待人工复核的合成语音，不冒充真人发音教材。三节课不是完整语言课程；既有真人外链、阅读和复习继续保留。

本轮待完成的真实模型、人工教学／音频复核、iPhone 和次日／一周试用见 [项目状态](docs/STATUS.md)。这些不能用模拟回答或程序测试代替；有限试用不代表教学准确率或长期学习效果已经被证实。

## 中文使用说明

1. 电脑和 iPhone 在 [Settings](https://mnijc19-netizen.github.io/jove-english-os/#/settings) 登录同一个学习账号。正常使用不需要在每台设备重新填写 AI 密钥。
2. 英语从 [Today](https://mnijc19-netizen.github.io/jove-english-os/#/today) 开始；日语从 [日本語](https://mnijc19-netizen.github.io/jove-english-os/#/ja) 开始。零基础直接点新课堂主按钮，从中文示范起步，不必先做诊断或会五十音。旧安排的诊断可按实际情况完成或跳过；若曾随意填写日语诊断，可用“起点填错了？按零基础重新起步”校正。它只调整起步安排，不产生能力分数，也不清空旧记录。
3. 每天只需告诉系统可用时间、精力，跟着下一项指引学习；英语与日语共用每天的时间预算，学习记录、课程和复习分开。Library 是选看材料的地方，不需要你每天自己编课。
4. 新课堂先学一句的意思，再辨认、拼句、表达自己的意思；需要帮助就用示范，隔天到期后换一个场景回应。原有真人课程仍在出版社原站播放，只听指引中的一小段，再抓大意、核对文本、用于自己的句子并录音重说，不必机械完成整个视频。系统替你选下一项，不需要每天自己找视频、编课程；原答案和帮助条件始终分开记录。
5. 换设备前等对应语言同步完成；录音可能比文字慢。离线时先留在原设备，联网后再同步。外部课程和 AI 需要网络，已保存的本地练习不会因为 AI 失败而消失。
6. 更新网站时先保存练习，在 Settings 的“网站版本与更新”点“检查更新”，出现更新按钮再点。不要清空网站数据；能登录不等于已更新。确切发布版本、验收范围和使用边界见 [项目状态](docs/STATUS.md)。

AI 提供文字解释、对话和纠错，不提供可靠的自动发音／音高评分，也不能保证固定天数达到某水平。参考发音优先听原站真人；保留自己的录音，回听、对照、重说。预算用尽时，基础练习、保存和复习仍可继续；重要录音请另存备份。

AI 的用途是帮你把自己的话说清楚、写清楚，不是代替你先回答。先独立尝试，需要时点开提示；核对建议确实符合自己的意思，再确认加入针对性复习。反馈和首答都会保留，下一次从已保存内容接续；已有结果不自动重复收费。日常“已练几项”只是进度，真正的目标是隔天不看答案也能在新场景写出来、说出来。

新入门课堂先教再练，不要求凭空作答。原有进阶场景练习在首次尝试后推荐一个表达，提供简短中文讲解和本站原创例句；例句只是帮助理解，不会自动填成你的作答。你不必自己设计句型练习，也不需要逐字照抄参考；用自己的名字、地点、想法和目的写或说，才是在把语言用起来。

日语已完成的练习可从“最近完成的练习”回看原答案、两次录音和已有 AI 反馈。回看不会自动请求 AI；未保存的反馈需明确点击取回，只有仍有效的同一次缓存结果可免于重新生成，新的请求仍可能收费。

## Start learning

Website: [Jove Language OS](https://mnijc19-netizen.github.io/jove-english-os/). Release verification is recorded in `docs/STATUS.md`.

**Release boundary:** the owner-approved limited classroom trial is published on clean build `64cb1c1-abcbe1736a00`, source `64cb1c1bfd2e0ad7a5bdae4c9d36ce41d03187a0`. Exact-source CI,18 actual-public desktop/mobile-WebKit learner paths and the legitimate owner's normal PWA update pass; both language syncs and all39 prior sessions,184 events/four recordings are preserved. Historical releases and operating limits are recorded separately in `docs/STATUS.md`. This is software trial acceptance, not human-language/audio review,50 live-feedback outputs per language, current physical-iPhone classroom proof or next-day/week human gains. Two synthetic real-model service diagnostics cost0.063175USD total and create no learner evidence; normal quotas/holds remain. Android compatibility remains, with physical acceptance waived. No acoustic scoring, bulk course-media hosting, unlimited content, universally best UI or guaranteed individual gains are claimed. Preserve old drafts and use Settings → 检查更新; later documentation-only commits do not alter the published runtime.

### Account-enabled first use

1. Open **Settings → Learning account** on each device and use the same owner's email sign-in code. Registration is not public. Normal AI/Speech credentials are configured once on the backend, never separately on each device.
2. First binding journals and merges existing local work; successful synchronization does not delete the local copy. Wait for **Synced** before expecting another device to have the latest work. Offline work remains local until reconnect; selected recording uploads can take longer than text records.
3. Open **Today** and start the proposed session. Time, energy, goals and interests remain yours; material, practice order and reviews are the system's responsibility. **Library** import is optional, not the normal course-supply requirement.
4. Primary courses play on the publisher's site; return to this app for guided recall, expression, saved recordings and review. Opening a link does not complete a lesson. Publisher playback and AI need a connection; only actually cached practice and recordings are available offline.
5. Keep important original recordings separately if needed. Cloud retention is bounded, not an unlimited archive. Account budgets and unknown-cost holds appear separately in Settings; zero budget stops new paid requests, not local practice.

### Local practice and advanced no-account fallback

1. Open **Today** or **日本語** and choose the new classroom's primary action. No account, API key, prior diagnostic or Japanese input method is needed for the bundled entry practice.
2. Follow the Chinese teaching and manageable next action; optional older diagnostics still allow unknown/skipped skills. Set the time and energy you have on **Today**, then follow its proposed practice path; you do not need to select a curriculum or plan each modality.
3. Listen before revealing the transcript. Save useful chunks, express your own meaning, and return when separate review cards are due.
4. Normal AI uses the signed-in account's backend configuration. Browser-only OpenRouter BYOK is an optional advanced fallback, not required on each device. Never put a private key in source, Git, exports or a public build environment.
5. Export a JSON backup regularly. Download important recordings from **Library** separately. Install through your browser's app / Add to Home Screen menu where supported.

On the first visit, stay online until **Ready for offline practice** appears in the footer. The app needs to download its bundled audio before offline playback is available. If you kept an early pre-release tab open, save your work and refresh it once to load the corrected update handler.

The six original demo scripts use clearly labeled synthetic speech. They remain supplementary offline practice, not the long-term human listening curriculum or a validated measure of natural-speaker comprehension. Reviewed publisher links and guided in-app practice supply the normal course path; personal imports remain optional and rights-limited. No paywall, login or DRM bypass is provided.

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

- IndexedDB remains the offline learning store. The current account-enabled release synchronizes owner-isolated English/Japanese records and bounded private recordings; signed-out/offline changes stay on the device until a successful account sync. No analytics or telemetry are added. Clearing site data can delete unsynced work; persistence is requested but cannot be guaranteed.
- JSON backup restores learning records, nonsecret settings and schedules. It excludes keys and audio blobs. Recordings are original user work, not disposable synthesis cache; keep downloaded originals separately. Do not assume a JSON file contains your recordings.
- Browser BYOK is an optional advanced fallback, isolated from normal server-only production keys. A browser-saved key is not protected against malicious same-origin code. Keep untrusted material escaped; authenticated API traffic is not cached by the service worker.
- Normal account AI/STT/TTS uses server-configured providers with only the necessary current task material/audio. Acoustic practice uses the separate speech engine; STT and LLM feedback are not acoustic measurements. BYOK model choices and clearly labeled local/synthetic fallback remain advanced paths. Unreviewed synthetic voices cannot qualify as formal pronunciation references.
- Local spending totals use costs reported by the provider; unknown costs remain unknown. The application limit is not a replacement for the provider's hard spending cap.
- No API key is required for basic demo listening, saved content, reviews, recordings and scripted practice. Adaptive conversations, transcription, generated speech and personal evaluation need an available configured service. Network failures retain saved input.
- Text or STT transcription does not establish pronunciation, prosody or acoustic fluency. Those dimensions remain unscored without reliable measurement. AI language/rubric estimates and self-reflections are labeled separately. Rotating check-ins are not standardized equivalent tests or guaranteed learning outcomes.

Architecture, content provenance and research limitations are documented in `docs/ARCHITECTURE.md`, `docs/CONTENT.md` and `docs/LEARNING_SCIENCE.md`. Current release evidence and unresolved work are in `docs/STATUS.md`.
