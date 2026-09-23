---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1137.0"
    context7_id: "N/A — context7 MCP unavailable in this environment; sourced via WebSearch"
    fetched_at: "2026-09-22T22:56:57-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1134.0"
    context7_id: "N/A — context7 MCP unavailable in this environment; sourced via WebSearch"
    fetched_at: "2026-09-22T22:56:57-03:00"
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "N/A — context7 MCP unavailable in this environment; sourced via WebSearch"
    fetched_at: "2026-09-22T22:56:57-03:00"
  "bullmq":
    version: "^6.3.8"
    context7_id: "N/A — context7 MCP unavailable in this environment; sourced via WebSearch"
    fetched_at: "2026-09-22T22:56:57-03:00"
  "nanoid":
    version: "^3.3.11"
    context7_id: "N/A — context7 MCP unavailable in this environment; sourced via WebSearch"
    fetched_at: "2026-09-22T22:56:57-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-22T22:19:37-03:00"
---

> **Provenance note:** this cache was NOT built via the `context7` MCP tool (not registered in this environment — see conversation history for the earlier `research/CLAUDE.md`-mandated attempt). Contents below are sourced via `WebSearch` against npm/GitHub/AWS docs on 2026-09-22 and cross-checked against this project's installed stack (`nestjs-project/package.json`, `tsconfig.json`). Re-verify with `context7` (or `npm view <pkg> versions`) once that tool is available, and update this file's `fetched_at` when re-verified.

### @aws-sdk/client-s3

**Decided by:** `phase-03-videos/TD-01` (Object Storage Technology & Bucket Strategy)

- Latest published version at research time: `3.1137.0` (AWS SDK v3 packages release near-daily; pin a recent minor, don't chase every patch).
- Core usage for this phase: `S3Client` configured with a custom `endpoint` (MinIO in dev, real S3/R2 in prod) + `forcePathStyle: true` (required for MinIO — path-style addressing, since MinIO doesn't support virtual-hosted-style bucket DNS by default).
- Relevant commands: `PutObjectCommand` (not used directly for uploads — presigned instead, TD-03), `CreateMultipartUploadCommand`, `UploadPartCommand` (presigned per-part, TD-03), `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand` (TD-11 cleanup), `GetObjectCommand` (TD-08 streaming/download redirect, supports a `Range` param for byte-range requests).
- MinIO config example shape:
  ```ts
  new S3Client({
    endpoint: config.storage.endpoint, // e.g. http://minio:9000 in Compose
    region: 'us-east-1', // MinIO ignores region but the SDK requires a value
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })
  ```

### @aws-sdk/s3-request-presigner

**Decided by:** `phase-03-videos/TD-01`, `phase-03-videos/TD-03`, `phase-03-videos/TD-08`

- Latest published version at research time: `3.1134.0` — keep in lockstep with `@aws-sdk/client-s3`'s minor version (both are part of the same SDK v3 release train; mismatched minors between the two packages is a known source of type errors).
- Core function: `getSignedUrl(client, command, { expiresIn })` — returns a presigned URL string for any S3 command. `expiresIn` defaults to 900s (15min) if omitted; TD-03's context calls for an "extended expiration (ex: 60 minutos)" for the upload flow, and TD-08 wants short-lived GET URLs for streaming/download (a few minutes is enough since the browser resolves the redirect near-instantly).
- For `GetObjectCommand`, the response-header override param `ResponseContentDisposition` can be set on the command before signing to force a download filename — this is what TD-08's Recommendation refers to as `response-content-disposition`, used for the download-vs-stream distinction without two separate storage-side objects.
- For TD-03's multipart flow: sign each `UploadPartCommand` individually (one presigned URL per `PartNumber`), and sign `CreateMultipartUploadCommand` / `CompleteMultipartUploadCommand` are typically called directly by the API (not presigned) since only the API needs to orchestrate session start/finish — only the actual byte-carrying `UploadPartCommand` calls need to go directly client→storage.

### @nestjs/bullmq

**Decided by:** `phase-03-videos/TD-02`

- WebSearch returned conflicting "latest" signals (one source: `12.0.0`; npm registry cache via another source: `11.0.4`). **Recommendation: pin to the `^11.x` line**, not `12.x` — every other `@nestjs/*` package already installed in `nestjs-project/package.json` is on the `^11.x` line (matching `@nestjs/core@^11.0.1`); a `@nestjs/bullmq@12.x` likely targets a NestJS 12 core that isn't installed here. Verify the exact `11.x` patch with `npm view @nestjs/bullmq versions` at install time.
- Core API: `BullModule.forRoot({ connection: { host, port } })` at the app-module level (Redis connection, shared by all queues unless overridden), `BullModule.registerQueue({ name: 'video-processing' })` per queue, `@Processor('video-processing')` class + `@Process()` method (or `WorkerHost` subclass, depending on the installed minor's API surface — check the installed version's own docs at implement time) for the consumer side, `@InjectQueue('video-processing')` to get a `Queue` instance for producers (TD-04's `confirm-upload` enqueue, TD-11's repeatable cleanup job).
- Repeatable jobs (TD-11): `queue.add(name, data, { repeat: { pattern: '0 * * * *' } })` (cron-like) or `{ every: <ms> }` — confirm the exact repeatable-job option shape against the installed `bullmq` version's docs, since this API has shifted across BullMQ major versions.

### bullmq

**Decided by:** `phase-03-videos/TD-02` (transitive — `@nestjs/bullmq` depends on it, but it's also imported directly for typed `Queue`/`Worker`/`Job` references)

- Latest published version at research time: `6.3.8`. `@nestjs/bullmq`'s installed version pins a compatible `bullmq` range as a peer/dependency — let the installed `@nestjs/bullmq` version's `package.json` dictate the exact `bullmq` version actually resolved, rather than independently pinning a possibly-incompatible one.
- Retry/backoff (TD-02's context — resilience to flaky FFmpeg/network): job options `{ attempts: N, backoff: { type: 'exponential', delay: msBase } }` passed on `queue.add(...)`.
- Dead-letter handling: BullMQ doesn't have a built-in "DLQ" concept like some brokers — the equivalent pattern is checking `job.attemptsMade >= job.opts.attempts` in a `failed` event listener and moving/recording the job elsewhere (or simply relying on BullMQ's own failed-job retention + the `Video.status = 'failed'` + `error_reason` already decided in TD-04, which makes an explicit DLQ redundant for this phase's actual requirement).

### nanoid

**Decided by:** `phase-03-videos/TD-06`

- **Compatibility warning (load-bearing — verify at implement time):** `nanoid` v5+ (current latest per WebSearch: `6.0.1`) **dropped CommonJS support and is ESM-only**. This project's `nestjs-project/tsconfig.json` has `"module": "nodenext"` and `package.json` has **no** `"type": "module"` field — confirmed via direct read of both files — meaning the compiled output is **CommonJS**. A plain `require('nanoid')` (or TS `import` compiled to `require` under `nodenext`+CommonJS) against `nanoid@6.x` will fail at runtime.
- **Recommendation: pin `nanoid@^3.3.11`** (or whatever is the latest `3.x` patch at install time) — the last major line that ships a CommonJS build. This is the version to actually install, not the "latest" tag.
- Usage per TD-06: `import { nanoid } from 'nanoid'; const slug = nanoid(14);` (14 chars falls in the TD's "12–16 chars" range) — default alphabet is URL-safe (`A-Za-z0-9_-`). If a stricter alphanumeric-only charset is wanted (no `_`/`-` in URLs), use `customAlphabet` from `'nanoid'` instead: `customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 14)`.
