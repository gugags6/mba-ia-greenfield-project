# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

### SI-03.1 — Criar entidade Video
- **Status:** completed
- **Tests:** 3 passing
- **Observations:**
  - Dev DB `migrations` table was empty while `channels`/`users`/`refresh_tokens`/`verification_tokens` already existed (residue from entity integration tests running `synchronize: true` against the same dev DB) with real data (1 user, 1 channel, 2 tokens). Per user decision, marked the 2 pre-existing migrations as applied (verified schema match via identical constraint hashes) instead of dropping tables, preserving dev data.
  - Entity's `created_at`/`updated_at` use plain `@CreateDateColumn()`/`@UpdateDateColumn()` (postgres `timestamp`, no tz) to match every other entity in the codebase (`Channel`, `User`, `RefreshToken`), rather than the plan's Data Model `timestamptz` note — that detail wasn't tied to a specific TD citation.
  - `size_bytes` typed as `string | null` in the entity (TypeORM's default bigint deserialization) rather than `number`, to avoid a silent precision-loss bug; no transformer was in scope for this SI.
  - Added the inverse `@OneToMany(Video) videos` relation on `Channel` and a `DELETE FROM "videos"` line to the shared `cleanAllTables` test helper — both required for the new FK relation and not called out explicitly in the SI's Technical actions, but necessary per the project's bidirectional-relationship rule and existing test infra pattern.

### SI-03.2 — Infra: StorageService (MinIO/S3)
- **Status:** completed
- **Tests:** 2 passing
- **Observations:**
  - Docker Hub's `minio/minio` and `minio/mc` images return "pull access denied" (MinIO moved distribution off Docker Hub). Used `quay.io/minio/minio` and `quay.io/minio/mc` instead — same images, different registry.
  - Created `StorageModule` (mirroring the existing `MailModule` shared-infra pattern) even though the SI's Technical actions only listed `StorageService` — needed so the service can be DI-injected by `VideosModule` in a later SI; not imported into `AppModule` yet (no consumer exists until SI-03.3, matching how `MailModule` is only imported by its consumer `AuthModule`).
  - Added a 7th method `putObject` to `StorageService` beyond the 6 listed in the plan's Technical actions, for the worker's direct thumbnail upload (SI-03.7) — the worker holds real SDK credentials server-side, so a presign-then-fetch round trip for its own upload would be pointless.
  - Registered `storageConfig` in `AppModule`'s `ConfigModule.forRoot({ load: [...] })` array and added `STORAGE_*` env vars (with dev defaults) to `.env` and `env.validation.ts`.

### SI-03.3 — Endpoint POST /videos/upload-intent
- **Status:** completed
- **Tests:** 15 passing (4 unit VideosService + 7 unit ChannelsService + 4 e2e)
- **Observations:**
  - Process deviation: delegated the spec-derived E2E authoring (Step 3a) to a subagent instead of authoring it on the main thread as the skill prescribes, to save main-thread context on this large SI. Reviewed the generated `nestjs-project/test/videos-upload-intent.e2e-spec.ts` afterward — correct auth flow (mirrors `auth.e2e-spec.ts`'s register→confirm→login), correct channel-delete pattern (avoids the `delete({})` empty-criteria pitfall). Will author JIT specs directly going forward for remaining SIs.
  - Added all 4 phase Error Catalog exceptions (`ChannelNotFoundException`, `VideoNotFoundException`, `UnauthorizedVideoAccessException`, `InvalidVideoStateException`) to `common/exceptions/domain.exception.ts` in this SI, even though only `ChannelNotFoundException` is used here — the other 3 are fully specified by the plan's Error Catalog and this avoids re-opening the shared file 3 more times in later SIs.
  - Added `ChannelsService.findByUserId` (with unit tests) — needed to resolve the caller's channel; not explicitly listed in the SI's Technical actions but required to implement action #2.
  - Registration auto-creates a channel (`UsersService.createUserWithChannel`), confirmed during E2E authoring — worth knowing for later video SIs' test fixtures.

### SI-03.4 — Endpoint POST /videos/:slug/confirm-upload
- **Status:** completed
- **Tests:** 12 passing (8 unit VideosService + 4 e2e)
- **Observations:**
  - Implemented after SI-03.5 (out of the requested confirmation order) because the Dependency Map requires the queue to exist first; flagged this to the user before starting.
  - Found and fixed a real regression from SI-03.5: adding `BullModule.forRootAsync` (Redis) to `AppModule` made full-module compilation slow enough to intermittently exceed Jest's default 5000ms `beforeAll` hook timeout in E2E specs, which then cascades into `app` being `undefined` in `afterAll` (`Cannot read properties of undefined (reading 'close')`). This had already silently bitten the SI-03.3 subagent (it just got lucky on a warm retry). Added an explicit `}, 30000);` timeout to every `beforeAll` that boots `AppModule` across the whole `test/` suite (`app.e2e-spec.ts`, both blocks in `auth.e2e-spec.ts`, both blocks in `swagger.e2e-spec.ts`, `videos-upload-intent.e2e-spec.ts`, `videos-confirm-upload.e2e-spec.ts`) rather than leaving it as recurring flakiness.
  - Process note: dispatched the E2E test-running subagent, but a `docker compose exec` it was running hung with the un-fixed 5s timeout for a very long wall-clock time (near-zero CPU, sitting in `epoll_wait`). Diagnosed and fixed directly on the main thread instead of continuing to wait — killed the stuck process, found the root cause, applied the timeout fix project-wide, and verified all 12 tests pass myself. Also authored the `videos-confirm-upload.e2e-spec.ts` JIT spec directly on the main thread this time (correcting the SI-03.3 process deviation).
  - The 200/enqueue scenarios go through a real `upload-intent` → real MinIO presigned-part PUT (via native `fetch`) → real `confirm-upload` flow to get a genuine ETag, since this project never mocks storage (TD-09). The 403/409 scenarios seed a `Video` row directly since those paths fail before ever touching storage.

### SI-03.5 — Infra: fila BullMQ + bootstrap do worker
- **Status:** completed
- **Tests:** 2 passing
- **Observations:**
  - Implemented out of numeric order, ahead of SI-03.4: the Dependency Map has SI-03.4 depending on SI-03.5, so SI-03.5 had to run first even though the user was asked to confirm SI-03.4 next. Corrected course before writing any SI-03.4 code.
  - `bullmq` requires `ioredis` as an optional peer dependency that isn't auto-installed — first test run crashed at module-load time (`BullMQ could not load the optional 'ioredis' package`). Installed `ioredis` explicitly; not listed in the plan's Technical actions or library-refs.md since it's a transitive requirement discovered only by running the code.
  - `BullModule.registerQueue({ name: 'video-processing' })` registered both in `AppModule` (per the SI's literal instruction, also exercised by `app.module.spec.ts`) and again in `WorkerModule` — NestJS module encapsulation means each module that wants `@InjectQueue`/`@Processor` for a queue must import the registration itself; registering only in `AppModule` would leave `VideosModule` (SI-03.4) and the worker's processors (SI-03.6/07/10) unable to resolve the queue.
  - `worker.main.ts` bootstraps via `ts-node` (`npm run worker:start`), mirroring the existing `seed`/`openapi:export` scripts, rather than through the Nest CLI build — `nest-cli.json` has `deleteOutDir: true`, and running two concurrent `nest start --watch` processes (API + worker) against the same `dist/` would have them repeatedly wipe each other's output.
  - `Dockerfile.worker` mirrors `Dockerfile.dev`'s "sleep and let CLAUDE.md commands `docker compose exec` in" pattern (no auto-start), just with `ffmpeg` added. `WorkerModule` currently has no providers — SI-03.6/03.7/03.10 add the actual `@Processor` classes.

### SI-03.6 — Worker: extração de metadados via ffprobe + validação de formato
- **Status:** completed
- **Tests:** 2 passing (real ffmpeg-generated fixture)
- **Observations:**
  - Added `ffmpeg` to `Dockerfile.dev` (nestjs-api), not just `Dockerfile.worker` — all test commands run via `docker compose exec nestjs-api` per project convention, and the processor source lives in the shared `src/` tree, so the test needs ffprobe available in that container too.
  - Found and fixed a DI gap: `WorkerModule` imported `VideosModule` (→ `ChannelsModule`, registers `Channel`) but never `UsersModule` (registers `User`). Since `Channel` has a relation to `User`, TypeORM failed at startup with "Entity metadata for Channel#user was not found" — `AppModule` never hit this because it reaches `UsersModule` transitively via `AuthModule`, which `WorkerModule` doesn't have. Added `UsersModule` to `WorkerModule`.
  - Distinguishes transient vs. permanent failure per the plan's AC: the MinIO download (`getObjectStream` + `pipeline`) is NOT wrapped in try/catch — a network/storage error propagates and fails the BullMQ job for automatic retry (TD-02 backoff). Only `ffprobe`'s own "invalid format / no video stream" result is caught and converted to `Video.status: failed` + `error_reason` (non-retryable, per TD-10).
  - No ffprobe wrapper library was decided in library-refs.md (TD-05 lists no Libraries) — shelled out to the `ffprobe` CLI directly via `child_process.execFile` with `-print_format json`, parsing the same JSON output format ffprobe/ffmpeg command-line docs describe, rather than introducing an undecided npm dependency.
  - Generated two test fixtures synthetically via `ffmpeg -f lavfi -i testsrc=...` (a tiny real H.264 mp4) and a garbage-bytes file misnamed `.mp4` — checked into `src/test/fixtures/`, no network download needed, no license/attribution concerns.
  - Codec allowlist (`ACCEPTED_VIDEO_CODECS`) is a new decision not literally specified by any TD (TD-10 only decided the client-hint-plus-ffprobe *strategy*, not the concrete codec list) — picked `h264/hevc/vp8/vp9/av1` as the common codecs inside the already-decided MIME container allowlist (mp4/mov/mkv/webm).
  - Pre-added two thumbnail-related constants (`THUMBNAIL_OFFSET_RATIO`, `THUMBNAIL_FALLBACK_OFFSET_SECONDS`) to `videos.constants.ts` while already in that file for SI-03.7 — unused until then.

### SI-03.7 — Worker: geração de thumbnail via ffmpeg
- **Status:** completed
- **Tests:** 4 passing (2 pure-unit for offset calc + extended 2-test integration file from SI-03.6)
- **Observations:**
  - Thumbnail generation runs in the same synchronous `process()` call as SI-03.6's metadata extraction (not a separate job/queue) — matches the Dependency Map ("SI-03.7 depends on SI-03.6, thumbnail depois dos metadados"). This meant SI-03.6's original test, which asserted the final status was `processing`, was now stale (status now progresses to `ready` within the same call) — updated that assertion rather than leaving a contradictory/failing check.
  - Extracted the offset formula (`duration>0 ? duration*0.1 : 1.0s` fallback) into a small pure exported function `computeThumbnailOffset` and added a plain `.spec.ts` for it — not listed in the SI's Tests table (which names only the integration file) but gives direct, fast coverage of the AC about the 10%/1.0s offset rule without having to infer it indirectly from ffmpeg's real output.
  - Thumbnail key convention: `thumbnails/{video.id}/thumbnail.jpg`, mirroring the `videos/{video.id}/original` key chosen in SI-03.3.
  - `readFile`/`unlink` for the temp thumbnail file added to the existing `fs`/`fs/promises` imports in the processor; temp file cleanup uses the same `finally` + log-and-swallow pattern as the video temp file (SI-03.6).

### SI-03.8 — Endpoint GET /videos/:slug
- **Status:** completed
- **Tests:** 16 passing (13 unit + 3 e2e)
- **Observations:**
  - No "optional JWT auth" pattern existed anywhere yet in this codebase — designed `OptionalJwtAuthGuard` (never throws; sets `request.user` only when a valid token happens to be present) applied via `@Public() + @UseGuards(OptionalJwtAuthGuard)`. `@Public()` skips the global `JwtAuthGuard` entirely (which never touches `request.user` on public routes), so the local guard is what actually parses an optional token.
  - Found and fixed a real DI bug: `OptionalJwtAuthGuard` needs `JwtService`, which lives in `AuthModule`'s `JwtModule`. First attempt imported the whole `AuthModule` into `VideosModule`, which compiled `VideosModule` fine but broke `WorkerModule` (which imports `VideosModule` transitively) — `AuthModule` also pulls in `MailModule`/`ThrottlerModule`, and `WorkerModule`'s `ConfigModule` never loaded `mailConfig`, so `MailerModule.forRootAsync` failed to resolve. Fixed properly by registering `JwtModule.registerAsync` directly in `VideosModule` (same factory `AuthModule` uses) instead of importing the whole module, and adding just `authConfig` (not `mailConfig`) to `WorkerModule`'s config load list — the worker now can verify JWTs (unused capability, but harmless) without pulling in mail/throttling infra it doesn't need.
  - Per TD-07, non-ready-and-not-owner gets the same 404 as a nonexistent slug (enumeration-resistant) — anonymous callers and wrong-channel authenticated callers are treated identically in `findBySlug`.
  - Verified the combined e2e run for all 3 `videos-*` specs together needs `--runInBand` (a first run without it hit real FK-violation/cross-suite contamination from Jest's default parallel workers, exactly as `CLAUDE.md` warns) — not a code bug, just confirmed the documented constraint still holds with the new spec added.

### SI-03.9 — Endpoints GET /videos/:slug/stream e /download
- **Status:** completed
- **Tests:** 8 passing (5 unit + 3 e2e)
- **Observations:**
  - Both endpoints are purely status-gated (`Authorization Matrix` in the plan makes them anonymous-accessible whenever `ready`) — no owner-exception like SI-03.8's `findBySlug`, so no `OptionalJwtAuthGuard` needed here; plain `@Public()` with no guard override.
  - Added a `sanitizeFilename` helper (strips `"`/CR/LF, caps length) before interpolating `video.title` into the `Content-Disposition` header — the plan's API Contract literally says `attachment; filename="{title}.mp4"`, but an unsanitized user-supplied title interpolated into a response header is a header-injection risk (CRLF/quote breakout), not something to carry through verbatim.
  - `@Res()` is used for both handlers (to call `res.redirect(302, url)` directly) — confirmed this doesn't bypass the global `DomainExceptionFilter`: `VideoNotFoundException` is thrown before `res` is ever touched, so NestJS's exception pipeline still intercepts it normally.

### SI-03.10 — Job de limpeza de rascunhos abandonados
- **Status:** completed
- **Tests:** 3 passing (real MinIO + DB)
- **Observations:**
  - library-refs.md's BullMQ notes flagged the repeatable-job API "has shifted across BullMQ major versions" and to verify at implement time — correctly so: BullMQ v6 removed `repeat` from `queue.add()`'s `JobsOptions` entirely in favor of `queue.upsertJobScheduler(id, repeatOpts, jobTemplate)`. Used the new API — it's also a better fit than my original plan (a fixed `jobId` on `add()`) since it's explicitly upsert-semantics (create-or-update), guaranteeing exactly one scheduler across repeated worker restarts.
  - `abortMultipartUpload` is wrapped to swallow a `NoSuchUpload` error specifically (any other error still propagates) — needed so a retried cleanup job (at-least-once delivery) doesn't fail forever trying to re-abort a session it already removed on a prior attempt, per the plan's own "idempotent by construction" note in Events/Messages.
  - `VideoCleanupProcessor` uses `@InjectRepository(Video)` directly rather than going through `VideosService` (unlike SI-03.6, whose technical action literally said "via VideosService") — this SI's technical action doesn't mention the service, and a batch `find(status=draft, created_at<cutoff)` + `remove()` doesn't map onto any existing single-video service method. Added `TypeOrmModule.forFeature([Video])` directly to `WorkerModule` for this (same "duplicate registration across the worker boundary" pattern already used for the BullMQ queue registrations).
  - Verified the scheduler for real (not just via test): booted `video-worker` via `npm run worker:start` and confirmed `bull:video-cleanup:repeat` in Redis actually contains the `cleanup-abandoned-videos-scheduler` entry with a delayed first run — `Test.createTestingModule().compile()` alone (used by the integration test) does NOT fire `onModuleInit`, so this real-process check was necessary to confirm the scheduler registration path actually works end-to-end, not just that the processor's `process()` method works in isolation.

### Final verification (2026-09-27)
- **Unit + integration** (`npm test -- --runInBand`): 31 suites / 178 tests passing.
- **E2E** (`npm run test:e2e`): 7 suites / 66 tests passing.
- **Type-check** (`npx tsc --noEmit`): exit 0.
- **Lint** (`npm run lint`): 0 errors (81 warnings, which the project configures as warnings).
- **Fixes applied during verification:**
  - `migrations.integration-spec.ts` failed with `type "verification_tokens_type_enum" already exists`. `DROP TABLE ... CASCADE` does not drop Postgres enum types, so `beforeAll` now also runs `DROP TYPE IF EXISTS` on the managed enums. The same failure had hung the whole Jest run: `afterAll` threw in `runMigrations()` before `dataSource.destroy()`, which left the pg pool open.
  - `test/jest-e2e.json` lacked the serial execution that `nestjs-project/CLAUDE.md` says is "already configured". With the 4 new `videos-*` suites, parallel runs hit FK violations every time. Added `"maxWorkers": 1`.
  - Fixed the 49 lint errors that phase 3 introduced in `test/videos-*.e2e-spec.ts` and `videos.service.spec.ts`.
  - The 150 lint errors that already existed on `dev` were fixed separately in `bugfix/lint-debt` (PR #1, merged into `dev`). `dev` was then merged into this branch; the only conflict, `makeDataSource` in `channels.service.spec.ts`, was resolved by combining both sides.
- **Out-of-scope follow-ups:**
  - Integration and e2e tests run against the dev database `streamtube`, and the migrations spec drops every table. Consider a dedicated test database.
  - `videos.created_at`/`updated_at` are `timestamp`, not `timestamptz` as the plan specified (see SI-03.1).
