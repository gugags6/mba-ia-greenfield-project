---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-22
scope_description: "Video ingestion, storage, background processing (queue + FFmpeg worker), unique URL generation, and streaming/download delivery for uploaded videos up to 10GB."
---

# Technical Decisions — Phase 03: Video Upload and Processing

_Subprojects in scope:_

- `nestjs-project/` — owns 100% of this phase's scope: upload orchestration API, background worker, object storage integration, streaming/download endpoints, and the `videos` table.
- `next-frontend/` — not yet initialized (per `CLAUDE.md`); no TD in this document. Consumption of the Phase 03 API is deferred to whichever future phase initializes the frontend.

---

## TD-01: Object Storage Technology & Bucket Strategy

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The phase needs a place to store video files (up to 10GB) and generated thumbnails, with bucket segregation, native support for client-side presigned uploads, and dev/prod parity. The project's Docker-first convention (`CLAUDE.md`) requires every service to run via Docker Compose — no external cloud dependency for local dev.

**Options:**

### Option A: MinIO (self-hosted, S3-compatible)
- `minio/minio` image in `compose.yaml`, exposing the S3 API (port 9000) and a web console (port 9001); a one-shot `minio/mc` container creates the `streamtube-videos` and `streamtube-thumbnails` buckets on boot.
- **Pros:** Fully Docker-based (matches project convention), identical wire protocol to AWS S3 so the same `@aws-sdk/client-s3` code path works unchanged in production, zero cost in dev, works fully offline.
- **Cons:** Self-managed in production if the team doesn't migrate to a managed provider (backup/scaling become ops concerns).

### Option B: AWS S3 directly (same bucket in dev and prod)
- Every environment, including local dev, talks to a real AWS S3 bucket.
- **Pros:** No dev/prod code divergence at all — there is only one implementation to verify.
- **Cons:** Requires real AWS credentials for local development, incurs cost during development, breaks offline dev, and violates the project's "everything runs via Docker Compose" convention (`CLAUDE.md`).

### Option C: Local filesystem storage with a `StorageService` abstraction
- Store files on disk in dev/test, swap to S3 in production behind a common interface.
- **Pros:** Simplest possible setup for a first pass.
- **Cons:** **Structurally incompatible with the presigned-upload architecture.** A browser cannot `PUT` a 10GB file straight to a container's local disk without the API itself terminating that HTTP connection — which is exactly what Presigned URLs (TD-03) exist to avoid. This option would force the API back into proxying upload bytes, undermining the phase's core non-functional requirement.

**Recommendation:** Option A — MinIO is the only option that keeps the environment fully Docker Compose-based, shares the exact SDK surface with production S3 (`@aws-sdk/client-s3`), and natively supports the Presigned URL flow that TD-03 depends on.

**Decision:** A (MinIO, self-hosted S3-compatible)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-02: Queue & Background Worker Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video metadata extraction and thumbnail generation are CPU/memory-intensive and must not block the API's event loop or HTTP workers. The chosen technology needs first-class NestJS integration, retry/backoff for transient FFmpeg or network failures, and a low Docker Compose footprint.

**Options:**

### Option A: BullMQ + Redis
- Job queue backed by Redis, with `@nestjs/bullmq` providing decorators for producers/consumers.
- **Pros:** Official, actively maintained NestJS integration; built-in exponential backoff, delayed jobs, and dead-letter handling; `redis:7-alpine` is a minimal addition to `compose.yaml`; matches what `testing-guide-nestjs-project`'s external-systems reference already anticipates ("Message Queue — TBD, likely BullMQ with Redis").
- **Cons:** Adds Redis as an infrastructure dependency (mitigated — trivial to run and operate).

### Option B: RabbitMQ (AMQP)
- Message broker with exchanges/routing keys, consumed via NestJS microservices transport.
- **Pros:** Enterprise-grade delivery guarantees, flexible routing topologies.
- **Cons:** Heavier NestJS setup (microservice wrapper instead of a direct queue library), more operational surface than this phase's single job-type workload justifies.

### Option C: Kafka
- Distributed log-based streaming platform.
- **Pros:** Excellent for massive real-time event streams.
- **Cons:** Wrong shape for a transactional job queue (one video = one job with a lifecycle) — no consumer-group/job-state ergonomics BullMQ provides out of the box, and operational complexity is disproportionate to this phase's needs.

**Recommendation:** Option A — `@nestjs/bullmq` is the project's de facto standard for background jobs in this stack, satisfies the retry/backoff/DLQ needs of a flaky FFmpeg step, and keeps the Compose footprint minimal.

**Decision:** A (BullMQ + Redis)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-03: Large Video Upload Strategy & Resumability

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `docs/project-plan.md` § "Pontos de Atenção" explicitly requires that the 10GB upload "permita retomar em caso de falha de conexão" (allow resuming after a connection failure) — this is a hard, stated non-functional requirement, not an optional nice-to-have. A single monolithic HTTP `PUT` of 10GB has a materially high chance of dropping mid-transfer with no way to resume, so the chosen strategy must genuinely satisfy resumability, not just avoid routing bytes through the API.

**Options:**

### Option A: Single Presigned PUT URL
- The API issues one presigned `PUT` URL (via `@aws-sdk/s3-request-presigner`); the client uploads the whole file in one HTTP request directly to MinIO/S3.
- **Pros:** Simplest to implement — one API call, one client request.
- **Cons:** **Does not satisfy the stated resumability requirement.** If the connection drops at byte 9.9GB of 10GB, the client must restart the entire upload from zero. This was the original hand-drafted decision for this phase, but it does not meet the explicit project-plan.md constraint.

### Option B: S3 Multipart Presigned Upload
- Client requests a multipart upload session from the API (`initiate`), the file is split into parts (e.g., 10–50MB each), each part gets its own presigned URL (`get-part-url`), parts upload in parallel with independent retry, and the API finalizes the upload (`complete`) once all parts are acknowledged.
- **Pros:** Genuinely resumable — only the failed part(s) need to be retried, not the whole file; supports parallel part upload for throughput; reuses the same `@aws-sdk/client-s3` + presigner investment as TD-01; natively supported by both AWS S3 and MinIO.
- **Cons:** Requires coordinating three endpoints (`initiate`, `get-part-url` per part, `complete`) instead of one, and the client needs multipart-aware upload logic (chunking, per-part retry, ETag tracking) instead of a single `fetch(url, {method:'PUT'})`.

### Option C: tus (resumable upload protocol)
- Open protocol purpose-built for resumable uploads, typically via a dedicated `tusd` server or a tus-compatible proxy in front of storage.
- **Pros:** Resumability is the protocol's native design goal, with mature client libraries (`tus-js-client`).
- **Cons:** Introduces an entirely new infrastructure component (a tus server) that doesn't talk to MinIO/S3 natively — would need a bridging step to push completed uploads into the chosen object storage, duplicating work already covered by S3 Multipart Upload without reusing the SDK already required by TD-01.

**Recommendation:** Option B — S3 Multipart Presigned Upload is the only option that actually satisfies the project-plan.md resumability requirement while reusing the same S3 SDK/presigner tooling already needed for TD-01, without introducing a new protocol/server (Option C). Note: this supersedes the "single Presigned PUT, multipart deferred to a future extension" framing in the earlier hand-drafted notes for this phase — that framing does not close the explicit resumability requirement and should not be carried forward as the decided option unless the user explicitly accepts the resumability gap as a documented risk.

**Decision:** B (S3 Multipart Presigned Upload)
**Libraries:** —

---

## TD-04: Draft Pre-registration & Video Status Lifecycle

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The video record must exist before the file finishes uploading (so the client has something to reference and the system can track upload intents that never complete), and its status must reflect asynchronous processing progress in a way both the API and the worker can safely read/write without racing each other. This also defines the retry/failure contract for the BullMQ job (TD-02) when FFmpeg or the network misbehaves.

**Options:**

### Option A: Linear 5-state enum — `draft → uploaded → processing → ready | failed`
- `draft` on `upload-intent`; `uploaded` once the client confirms the multipart upload completed; `processing` while the worker runs `ffprobe`/`ffmpeg`; terminal `ready` or `failed`.
- **Pros:** Small, easy to reason about; maps 1:1 to the phase's actual steps; `failed` carries an `error_reason` for observability.
- **Cons:** No distinct "queued" state between `uploaded` and `processing` — a video sitting in the BullMQ queue looks identical (status-wise) to one about to be picked up, which is acceptable at this phase's volume but would need refinement if queue depth becomes user-visible later.

### Option B: Same states plus an explicit `queued` state
- Adds a `queued` status set the instant the job is enqueued, separate from `processing` (set only when the worker actually starts).
- **Pros:** More precise observability (distinguishes "waiting for a worker" from "actively being processed").
- **Cons:** Extra state with no consumer need in this phase — nothing in scope (no admin dashboard yet) reads the distinction; adds complexity without a driving capability.

### Option C: Event-sourced processing log instead of a single `status` column
- Append-only `video_processing_events` table; current status derived by reading the latest event.
- **Pros:** Full audit trail of every transition, useful for debugging flaky FFmpeg runs.
- **Cons:** Substantially more implementation surface (new table, projection logic, more complex queries for "give me all ready videos") for a phase whose actual requirement is just "the user sees draft/processing/ready/failed" — the audit-trail benefit isn't a capability this phase asks for.

**Recommendation:** Option A — the 5-state enum is the minimum model that satisfies every capability bullet in this phase (draft pre-registration, async processing visibility, failure surfacing) without adding states or infrastructure the phase doesn't need. BullMQ's own job history covers ad-hoc debugging needs that Option C would otherwise address.

**Decision:** A (Linear 5-state enum)
**Libraries:** —

**Note (resolves AMB-1, `/plan-resolve 3`):** `status` (this field — technical processing pipeline: draft/uploaded/processing/ready/failed) is independent from Phase 04's future editorial `visibility`/`published` state (public/unlisted, draft→publish flow). A `ready` video is not automatically publicly listed — it becomes visible only once Phase 04's publish flow marks it so. Phase 04's own research should model `visibility` as a separate column, not overload this `status` enum.

---

## TD-05: Worker Execution Model & Metadata/Thumbnail Extraction

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Extracting duration/resolution/codec/bitrate and generating a thumbnail both require invoking `ffprobe`/`ffmpeg` against the uploaded file — CPU/memory-intensive work that must not degrade the API container's HTTP responsiveness, and must be able to read the entity model (`Video`, `Channel`) and write results back to Postgres + the thumbnails bucket.

**Options:**

### Option A: In-process (same container as the NestJS API)
- The API process itself runs `ffprobe`/`ffmpeg` when a job callback fires.
- **Pros:** No new container, no extra deployment unit.
- **Cons:** **Rejected outright** — FFmpeg is CPU-bound and would starve the Node.js event loop serving unrelated HTTP requests, directly violating the phase's core non-functional goal of not degrading API responsiveness.

### Option B: Dedicated worker container (same NestJS codebase, standalone bootstrap)
- A separate container built from the same monorepo codebase, running a NestJS standalone application (or a bare BullMQ consumer) with `ffmpeg`/`ffprobe` binaries installed, reusing existing TypeORM entities, config modules, and the storage service from TD-01.
- **Pros:** Full code/type reuse with the API (no duplicated domain logic), independent CPU/memory limits in `compose.yaml`, isolates FFmpeg load from the API entirely.
- **Cons:** Requires a second Dockerfile/build target and its own resource tuning.

### Option C: Managed SaaS transcoding/metadata service (e.g., Mux, Cloudinary, AWS MediaConvert)
- Offload extraction and thumbnailing to a third-party API instead of running FFmpeg at all.
- **Pros:** Zero FFmpeg operational burden, often includes adaptive streaming for free.
- **Cons:** Recurring external cost and a hard dependency on a third-party account/credentials for a project whose stated stack is self-hosted Docker Compose services; introduces a vendor integration this phase's scope doesn't call for, and duplicates work MinIO + a worker container already cover locally.

**Recommendation:** Option B — a dedicated worker container reusing the NestJS codebase gives full type/entity reuse while fully isolating FFmpeg's CPU/memory footprint from the API, consistent with the project's self-hosted Docker Compose architecture (no external vendor dependency).

**Decision:** B (Dedicated worker container, shared codebase)
**Libraries:** —

---

## TD-06: Unique Public Identifier Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Sequential integer IDs (`/videos/1`, `/videos/2`) let anyone enumerate every video in the system, including drafts and unlisted content in later phases. The public identifier needs to be short (URL-friendly), collision-resistant, and indexable.

**Options:**

### Option A: `nanoid` (12–16 alphanumeric characters)
- Cryptographically strong, URL-safe random ID generated at insert time and stored in an indexed, unique `slug` column.
- **Pros:** Short, readable URLs; negligible collision probability at this project's scale; tiny dependency; widely used for exactly this purpose.
- **Cons:** Requires a uniqueness check/retry-on-insert-conflict (extremely rare in practice, but non-zero).

### Option B: UUID v4 as the public identifier
- Reuse the same UUID already used as the primary key as the public-facing URL segment.
- **Pros:** No extra column, no extra generation step, zero collision risk by construction.
- **Cons:** 36-character URLs are noticeably worse UX (`/videos/f47ac10b-58cc-4372-a567-0e02b2c3d479` vs `/videos/xK9mPq2Lw3Rt`), and exposing the primary key in URLs is a mild information-architecture smell if the PK strategy ever needs to change.

### Option C: `hashids` / `sqids` (reversible encoding of the integer PK)
- Encode the numeric primary key into an obfuscated short string.
- **Pros:** Short URLs without a second random column.
- **Cons:** Reversible by design — with enough samples the encoding can often be inferred, weakening the enumeration-prevention goal that motivated this decision in the first place; also assumes an integer PK, which conflicts with the UUID PK already used project-wide (`User`, `Channel` entities).

**Recommendation:** Option A — `nanoid` gives short, non-reversible, collision-resistant public URLs without compromising the UUID primary-key convention already established in `User`/`Channel` (confirmed via `@PrimaryGeneratedColumn('uuid')` in the existing entities).

**Decision:** A (nanoid, 12-16 chars)
**Libraries:** nanoid

---

## TD-07: Video Visibility & Access Control by Status

**Scope:** Backend

**Capability:** Transversal — covers: "URL única por vídeo, sem conflito com outros vídeos", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A `draft`, `processing`, or `failed` video must not be viewable by anyone other than its owning channel — otherwise the unguessable-slug protection from TD-06 is undermined by an endpoint that still confirms a video's existence/state to strangers. The response code chosen for unauthorized access to a non-`ready` video has real information-disclosure trade-offs.

**Options:**

### Option A: `403 Forbidden` for non-owners on non-`ready` videos
- The video exists (confirmed by a 403), but the requester isn't allowed to see it.
- **Pros:** Simple, consistent with the project's existing `DomainExceptionFilter` conventions (owner-only guards elsewhere use 403).
- **Cons:** Confirms to any requester that a given slug corresponds to a real video, even one the requester will never see — a (mild) enumeration signal.

### Option B: `404 Not Found` for non-owners on non-`ready` videos
- Non-owners get the same response for "doesn't exist" and "exists but not visible to you."
- **Pros:** Strongest enumeration resistance — no distinction is leaked between a wrong slug and a real-but-private one.
- **Cons:** Slightly less semantically precise for the *owner's own* client-side error handling (though the owner's own requests are correctly authorized and never hit this branch).

**Recommendation:** Option B — `404 Not Found` is consistent with the enumeration-prevention intent that already motivated the `nanoid` slug in TD-06; a 403 on an unguessable slug would leak exactly the information the slug was chosen to hide.

**Decision:** B (404 Not Found)
**Libraries:** —

---

## TD-08: Streaming & Download Delivery Mechanism

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Both playback and download need to move up to 10GB out of storage to the client. The core question is whether the API proxies those bytes itself or redirects the client to talk to MinIO/S3 directly, and whether streaming and download should follow the same pattern.

**Options:**

### Option A: API proxies all bytes for both streaming and download
- `GET /videos/:slug/stream` and `GET /videos/:slug/download` both call `GetObjectCommand` (forwarding the `Range` header for streaming) and pipe the response through the API.
- **Pros:** Single code path, full control over every request (auth checks, future view-count hooks) at the API layer.
- **Cons:** Routes every playback second and every full download through the API's own bandwidth and connection pool — exactly the kind of byte-proxying TD-01/TD-03 were chosen to avoid for uploads; unnecessary for the download case, which has no per-chunk logic to run.

### Option B: API redirects (302) to a short-lived presigned GET URL for both
- The API validates access, then returns/redirects to a presigned `GetObjectCommand` URL (with `response-content-disposition` set for downloads), and the browser talks to MinIO/S3 directly for the actual bytes, range requests included (S3-compatible presigned GETs support `Range` natively).
- **Pros:** Zero bytes proxied through the API for either case; reuses the same presigner tooling as TD-01/TD-03; MinIO/S3 already serves `Accept-Ranges`/`206` correctly on its own.
- **Cons:** Per-request auth/visibility checks (TD-07) happen once at redirect time, not on every byte-range request — acceptable here since a presigned URL's short TTL bounds the exposure window, but worth noting as a trade-off versus Option A's per-request enforcement.

### Option C: Hybrid — proxy for streaming, redirect for download
- Streaming stays server-proxied (keeps Range handling and future auth/view-count hooks close to the API); download redirects to a presigned GET URL (no per-chunk logic needed for a single full-file transfer).
- **Pros:** Matches server-side control to where it's actually useful (streaming, which is a strong future extension point for view counts/auth) while getting the download case fully off the API's bandwidth.
- **Cons:** Two different delivery code paths to maintain instead of one.

**Recommendation:** Option B — for this phase's actual requirements (no view-count or per-chunk auth capability exists yet), redirecting both streaming and download to presigned GET URLs keeps the API fully out of the byte-proxying business, consistent with the upload architecture's core goal, while MinIO/S3's native `Range` support on presigned URLs means playback scrubbing still works correctly. If a future phase needs per-request enforcement (e.g., view-count-gated streaming), Option C is the natural migration path.

**Decision:** B (Redirect to presigned GET URL for both)
**Libraries:** —

---

## TD-09: Object Storage & Async Processing Testing Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** `testing-guide-nestjs-project`'s existing `external-systems.md` reference documents "Object Storage — Local Filesystem" as the test strategy (local disk in dev/test, S3 only in prod, behind a `StorageService` abstraction). That guidance **predates and conflicts with** TD-01/TD-03: a presigned-URL upload flow is inherently shaped around a real S3-compatible endpoint — there is no meaningful way to exercise "the client PUTs directly to storage via a presigned URL" against a local filesystem stub. The same reference's "Message Queue" section already anticipates BullMQ+Redis and shows a real-Redis integration test pattern, which is directly usable as-is. FFmpeg/ffprobe invocation inside worker tests also needs an explicit call: run real binaries against tiny fixture files, or mock the shell-out entirely.

**Options:**

### Option A: Real MinIO (Docker) for storage tests + real Redis (already anticipated) + real FFmpeg on tiny fixture videos
- Integration tests run against the actual `minio` and `redis` Compose services; a small (few-KB, 1-second) fixture video file is committed to the repo and processed for real by `ffprobe`/`ffmpeg` in worker tests.
- **Pros:** Tests the real S3 API surface the presigned-URL flow depends on (impossible to fake meaningfully); real FFmpeg output catches integration bugs (wrong flags, bad thumbnail offset math) that a mock would hide; consistent with the project's existing "PostgreSQL — Real (Docker)" and "Email — Mailpit (Real SMTP)" conventions in the same testing guide — real-dependency testing is already this project's established pattern.
- **Cons:** Worker tests take longer than pure unit tests (FFmpeg process spawn cost) and require the `ffmpeg`/`ffprobe` binaries to be present wherever tests run (CI image, local dev container).

### Option B: Mock the storage SDK and the FFmpeg shell-out entirely
- `@aws-sdk/client-s3` calls and `ffmpeg`/`ffprobe` invocations are mocked at the unit level; no real MinIO or binary execution in the test suite.
- **Pros:** Fastest possible test run, no binary dependency in CI.
- **Cons:** Breaks from the project's established "real dependencies via Docker" testing convention (Postgres, Mailpit); a mocked S3 client cannot catch a malformed presigned-URL request, and a mocked FFmpeg call cannot catch a broken thumbnail-offset calculation or an unsupported codec — exactly the failure modes this phase is most likely to hit in practice.

**Recommendation:** Option A — real MinIO and real FFmpeg-on-fixtures match this project's already-validated testing philosophy (Postgres and Mailpit are both "real via Docker," per the existing testing guide) and are the only way to genuinely exercise the presigned-URL contract and FFmpeg's actual output. `testing-guide-nestjs-project`'s "Object Storage — Local Filesystem" section should be updated to reflect MinIO once this TD is decided (tracked as a follow-up to the testing guide, outside this document's scope).

**Decision:** A (Real MinIO + real Redis + real FFmpeg on fixture files)
**Libraries:** —

---

## TD-10: Accepted Video MIME Types & Format Validation

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The upload flow needs to constrain which video formats it accepts — an unrestricted upload risks non-video files, formats `ffprobe`/`ffmpeg` (TD-05) can't process, or wasted 10GB-scale storage on files that will always fail processing. This decision affects the `Content-Type` condition on the presigned URL, the `upload-intent` DTO's validation, and what the worker does when it encounters an unexpected format.

**Options:**

### Option A: Client-declared MIME allowlist enforced only at the presigned URL
- The client declares a `mimeType` in the `upload-intent` DTO (validated against an allowlist via `class-validator`'s `IsIn`); the presigned PUT URL is generated with a matching `Content-Type` condition, so MinIO/S3 rejects the `PUT` if the browser sends a different header.
- **Pros:** Rejection happens at the earliest possible point — before any bytes reach storage; minimal validation logic.
- **Cons:** `Content-Type` is client-supplied and spoofable — a buggy or malicious client can still upload a non-video file with a forged `video/mp4` header, and nothing downstream catches it.

### Option B: Client MIME hint at upload-intent + authoritative worker-side validation via ffprobe
- Same DTO-level check as Option A, **plus**: the worker's first processing step (already running `ffprobe` for TD-05's metadata extraction) is treated as the authoritative format gate — if `ffprobe` can't identify a valid video stream, or the detected codec isn't in an allowed list, the job fails with `status: failed` and a descriptive `error_reason`.
- **Pros:** Defense-in-depth — validates actual file content, not just a spoofable header; near-zero marginal cost since `ffprobe` already runs for TD-05.
- **Cons:** A spoofed/invalid file still costs one full upload's worth of storage/bandwidth before the worker catches it (mitigated by TD-11's cleanup policy for stale rows).

### Option C: No format restriction — let ffprobe/ffmpeg fail naturally
- No explicit allowlist anywhere; any upload-intent succeeds; the worker attempts to process whatever arrives.
- **Pros:** Nothing to implement or maintain.
- **Cons:** No early feedback — rejection only surfaces after a full (potentially 10GB, potentially hours-long) upload completes and processing starts; worse UX than A or B; wastes storage indefinitely on non-video uploads with no upfront gate.

**Recommendation:** Option B — combining a fast client-side hint with authoritative worker-side validation via `ffprobe` gives the best UX/correctness balance, and the worker check is essentially free since `ffprobe` already runs for TD-05.

**Decision:** B (Client MIME hint + authoritative worker-side ffprobe validation)
**Libraries:** —

---

## TD-11: Abandoned Draft & Incomplete Multipart Upload Cleanup Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** `upload-intent` creates a `draft` row before any bytes are uploaded, and TD-03's S3 Multipart Presigned Upload creates a multipart session on MinIO/S3 before parts arrive. If the client abandons the flow (closes the tab, loses connection, never finishes), both the DB row and the multipart session persist indefinitely — the database accumulates dead rows and the bucket accumulates uploaded-but-never-completed parts that count toward storage usage without ever becoming a playable video. `project-plan.md` § "Pontos de Atenção" explicitly calls out planning for storage growth/cost "desde o início" (from the start).

**Options:**

### Option A: Scheduled BullMQ repeatable job
- A BullMQ repeatable job (e.g., hourly) queries `Video` rows with `status: draft` older than a TTL (e.g., 24h), calls `AbortMultipartUploadCommand` on the tracked `UploadId` if a multipart session was initiated, then deletes the row.
- **Pros:** Centralized and observable (visible in BullMQ tooling); reuses the queue infrastructure TD-02 already commits to — no new infra; TTL is a config value, tunable without a storage-layer redeploy.
- **Cons:** Requires tracking the multipart `UploadId` on the `Video` row (or a side table) so the job knows which sessions to abort; one more scheduled job to operate/monitor.

### Option B: S3/MinIO bucket lifecycle rule + separate DB-only cleanup
- Configure the `streamtube-videos` bucket with a native `AbortIncompleteMultipartUpload` lifecycle rule (`DaysAfterInitiation`) so MinIO/S3 aborts stale multipart sessions with zero application code; a lighter scheduled job (or raw SQL `DELETE`) separately handles orphaned `draft` DB rows.
- **Pros:** Storage-side cleanup is fully declarative/infrastructure-native — can't drift from a bug in application cleanup code; clean separation of concerns.
- **Cons:** Two independent TTLs to keep in sync (bucket lifecycle days vs. DB row TTL) — drift risk (a DB row could reference a multipart session S3 already silently aborted, or vice versa); requires `mc ilm` lifecycle configuration as part of the `createbuckets` init container (TD-01), adding setup surface there.

### Option C: No automated cleanup — manual/ops-only, addressed later if it becomes a problem
- Accept the accumulation for now; write a one-off cleanup script later if storage usage becomes a visible issue.
- **Pros:** Zero implementation cost now.
- **Cons:** Directly contradicts `project-plan.md`'s explicit instruction to plan storage growth/cost from the start; defers a cheap-to-fix-now problem into a future ops fire-drill.

**Recommendation:** Option A — a single BullMQ repeatable job keeps both DB and storage cleanup logic in one place, reuses infrastructure TD-02 already commits to, and avoids Option B's two-TTL synchronization risk; tracking `UploadId` is a one-line entity addition.

**Decision:** A (Scheduled BullMQ repeatable cleanup job)
**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object Storage Technology & Bucket Strategy | MinIO (self-hosted, S3-compatible) | A |
| TD-02 | Backend | Queue & Background Worker Technology | BullMQ + Redis | A |
| TD-03 | Backend | Large Video Upload Strategy & Resumability | S3 Multipart Presigned Upload | B |
| TD-04 | Backend | Draft Pre-registration & Video Status Lifecycle | Linear 5-state enum (draft/uploaded/processing/ready/failed) | A |
| TD-05 | Backend | Worker Execution Model & Metadata/Thumbnail Extraction | Dedicated worker container (shared codebase) | B |
| TD-06 | Backend | Unique Public Identifier Strategy | `nanoid` slug (12–16 chars) | A |
| TD-07 | Backend | Video Visibility & Access Control by Status | `404 Not Found` for non-owner access to non-ready videos | B |
| TD-08 | Backend | Streaming & Download Delivery Mechanism | Redirect to presigned GET URL for both | B |
| TD-09 | Backend | Object Storage & Async Processing Testing Strategy | Real MinIO + real Redis + real FFmpeg on fixture files | A |
| TD-10 | Backend | Accepted Video MIME Types & Format Validation | Client MIME hint + authoritative worker-side ffprobe validation | B |
| TD-11 | Backend | Abandoned Draft & Incomplete Multipart Upload Cleanup Policy | Scheduled BullMQ repeatable cleanup job | A |

---

## Notes for `/plan-resolve`

- **Out-of-scope endpoint found in the prior draft:** the earlier hand-authored `context.md` for this phase included `GET /channels/:nickname/videos` (paginated public channel video listing). That capability — "Página pública do canal com informações e listagem de vídeos" — is a **Phase 04** bullet (`Fase 04 — Gerenciamento de Vídeos e Canal`), not a Phase 03 one. No TD in this document covers it, and it should be dropped from Phase 03's contract set when `/plan-context 3` is run; it belongs to Phase 04's own research.
- **Resumability gap in the prior draft:** the earlier hand-authored decision for the upload strategy (single Presigned PUT, multipart deferred as a "future extension") does not satisfy `docs/project-plan.md`'s explicit resumability requirement. TD-03 in this document recommends promoting S3 Multipart Presigned Upload to Phase 03's actual scope instead of deferring it — this is the key decision to confirm or override during resolve.
