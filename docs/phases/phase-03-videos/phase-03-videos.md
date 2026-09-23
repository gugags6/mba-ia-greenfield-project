---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-22T23:02:45-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-22T23:02:31-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-22T22:19:37-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-20T17:46:47-03:00"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Implementar a ingestão, o armazenamento e o processamento assíncrono de vídeos de até 10GB — upload resiliente via presigned URLs multipart, pré-cadastro automático como rascunho, extração automática de metadados e thumbnail via worker dedicado, geração de URL pública única, e entrega via streaming (HTTP 206) e download — sem que a API HTTP trafegue os bytes do vídeo.

---

## Step Implementations

### SI-03.1 — Criar entidade Video

**Description:** Migration + entidade TypeORM `Video`, base para todo o restante da fase — armazena metadados, chaves de storage, status do pipeline e slug público.

**Technical actions:**

1. Criar migration `CreateVideos` — tabela `videos` com colunas per `## Technical Specifications → Data Model` (id, channel_id FK, title, description, slug, status enum, video_storage_key, thumbnail_storage_key, multipart_upload_id, duration, size_bytes, metadata jsonb, error_reason, timestamps) + índices (`UQ_videos_slug`, índice em `channel_id`, índice em `status`).
2. Criar `Video` entity (`video.entity.ts`) com `@Entity('videos')`, colunas mapeadas 1:1 à migration, `@ManyToOne(() => Channel)`.
3. Criar `VideoStatus` enum (`draft`, `uploaded`, `processing`, `ready`, `failed`) (per `phase-03-videos/TD-04`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, unique `slug` | `video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Migration `CreateVideos` roda com sucesso e cria a tabela `videos` com todas as colunas do Data Model.
- Inserir um segundo `Video` com `slug` já existente viola a constraint `UQ_videos_slug`.
- `status` tem default `draft` quando omitido na criação.

---

### SI-03.2 — Infra: StorageService (MinIO/S3)

**Description:** Encapsula o SDK S3 v3 (presigned URLs + multipart) atrás de um serviço injetável, e sobe o MinIO no Docker Compose — base para upload, streaming, download e cleanup.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` (per `phase-03-videos/TD-01`).
2. Criar `storage.config.ts` com `registerAs('storage', ...)` (per `## Inherited Conventions`) — endpoint, region, `forcePathStyle`, credenciais, nomes dos buckets (`streamtube-videos`, `streamtube-thumbnails`).
3. Criar `StorageService` (`storage.service.ts`) — encapsula `S3Client`, expõe `getPresignedPutUrl`, `getPresignedGetUrl`, `createMultipartUpload`, `getPresignedPartUrl`, `completeMultipartUpload`, `abortMultipartUpload` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`).
4. Adicionar serviço `minio` + init container `createbuckets` (`minio/mc`) ao `compose.yaml`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: real MinIO via Docker (per `phase-03-videos/TD-09`) — geração de presigned URL, ciclo de vida multipart | `storage.service.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `StorageService.getPresignedPutUrl` retorna uma URL válida assinada para o bucket `streamtube-videos`.
- `StorageService.createMultipartUpload` seguido de `abortMultipartUpload` remove a sessão multipart no MinIO (verificável via `ListMultipartUploads`).
- `docker compose up minio createbuckets` cria os buckets `streamtube-videos` e `streamtube-thumbnails`.

---

### SI-03.3 — Endpoint POST /videos/upload-intent

**Route:** POST /videos/upload-intent
**Test Specs:** _pending /plan-test-specs_

**Description:** Ponto de entrada do upload — valida o canal do usuário, gera o slug público, cria o rascunho e inicia a sessão multipart, devolvendo as URLs presigned por parte.

**Technical actions:**

1. Criar `UploadIntentDto` (`class-validator`) — `title`, `description?`, `filename`, `mimeType` (allowlist via `@IsIn`, per `phase-03-videos/TD-10`), `sizeBytes` (per `phase-03-videos/TD-03`).
2. Criar `VideosService.createUploadIntent` — valida canal do usuário autenticado, gera `slug` único via `nanoid` (per `phase-03-videos/TD-06`), cria `Video` com `status: draft`, chama `StorageService.createMultipartUpload` e gera as `partUrls` presigned (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`, `phase-03-videos/TD-04`).
3. Criar `VideosController` com `POST /videos/upload-intent`, protegido por guard JWT (per `## Inherited Conventions`).
4. Mapear `ChannelNotFoundException` no `DomainExceptionFilter` existente (per `## Inherited Conventions`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadIntentDto` | E2E: wiring de validação (allowlist de `mimeType`, limites de `sizeBytes`) | `videos.e2e-spec.ts` |
| `VideosController` | E2E only | `videos.e2e-spec.ts` |
| `VideosService` | Unit: branch logic (mock repo + mock `StorageService`) | `videos.service.spec.ts` |

**Dependencies:** SI-03.1 (entidade), SI-03.2 (StorageService)

**Acceptance criteria:**

- `POST /videos/upload-intent` com payload válido retorna `201` com `video.status: "draft"`, `uploadId` e `partUrls` não-vazio.
- `POST /videos/upload-intent` com `mimeType` fora do allowlist retorna `400` com erro de validação.
- `POST /videos/upload-intent` sem JWT retorna `401`.
- `POST /videos/upload-intent` de um usuário sem canal retorna `404 CHANNEL_NOT_FOUND`.

---

### SI-03.4 — Endpoint POST /videos/:slug/confirm-upload

**Route:** POST /videos/:slug/confirm-upload
**Test Specs:** _pending /plan-test-specs_

**Description:** Finaliza a sessão multipart no storage e enfileira o job de processamento assíncrono — transição de `draft` para `uploaded`.

**Technical actions:**

1. Criar `ConfirmUploadDto` — `parts: { partNumber: number, eTag: string }[]`.
2. Criar `VideosService.confirmUpload` — valida `status: draft`, chama `StorageService.completeMultipartUpload`, atualiza `status: uploaded`, enfileira o job `process-video` na fila `video-processing` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-04`).
3. Aplicar checagem de propriedade (owner-only) — `video.channel_id === user.channel.id`, caso contrário `403 UNAUTHORIZED_VIDEO_ACCESS`.
4. Adicionar `POST /videos/:slug/confirm-upload` ao `VideosController`.
5. Mapear `InvalidVideoStateException` (409) e `UnauthorizedVideoAccessException` (403) no `DomainExceptionFilter`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosController` | E2E only | `videos.e2e-spec.ts` |
| `VideosService` | Unit: branch logic (draft/não-draft, dono/não-dono) | `videos.service.spec.ts` |
| `VideosService` (fila) | Integration: real BullMQ via Docker (per `phase-03-videos/TD-09`) — assert job enfileirado com payload correto | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2, SI-03.3, SI-03.5 — fila `video-processing` precisa existir para o enqueue funcionar

**Acceptance criteria:**

- `POST /videos/:slug/confirm-upload` de um vídeo `draft` do próprio canal retorna `200` e muda `status` para `uploaded`.
- `POST /videos/:slug/confirm-upload` enfileira um job `process-video` na fila `video-processing` com `videoId` correto.
- `POST /videos/:slug/confirm-upload` de um vídeo de outro canal retorna `403 UNAUTHORIZED_VIDEO_ACCESS`.
- `POST /videos/:slug/confirm-upload` de um vídeo já `ready` retorna `409 INVALID_VIDEO_STATE`.

---

### SI-03.5 — Infra: fila BullMQ + bootstrap do worker

**Description:** Sobe a infraestrutura de fila (Redis + BullMQ) e o container dedicado do worker com FFmpeg instalado — pré-requisito para todo processamento assíncrono da fase.

**Technical actions:**

1. Instalar `@nestjs/bullmq` e `bullmq` (per `phase-03-videos/TD-02`).
2. Criar `queue.config.ts` com `registerAs('queue', ...)` (per `## Inherited Conventions`) — host/porta do Redis.
3. Registrar `BullModule.forRootAsync` no `AppModule` + `BullModule.registerQueue({ name: 'video-processing' })`.
4. Criar bootstrap standalone do worker (`worker.main.ts`) + `Dockerfile.worker` com `ffmpeg`/`ffprobe` instalados (per `phase-03-videos/TD-05`).
5. Adicionar serviços `redis` e `video-worker` ao `compose.yaml` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `AppModule` (fila) | Unit: compilation test | `app.module.spec.ts` |
| Registro da fila | Integration: real Redis via Docker (per `phase-03-videos/TD-09`) — round-trip de enqueue/dequeue | `queue.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up redis video-worker` sobe os dois serviços com status `running`.
- Um job enfileirado na fila `video-processing` é reconhecido pelo `video-worker` (visível via log ou inspeção do BullMQ).
- `ffmpeg -version` e `ffprobe -version` executam com sucesso dentro do container `video-worker`.

---

### SI-03.6 — Worker: extração de metadados via ffprobe + validação de formato

**Description:** Primeiro estágio do processamento — extrai duração/resolução/codec/bitrate do vídeo real e valida o formato de forma autoritativa, rejeitando arquivos inválidos.

**Technical actions:**

1. Criar `VideoProcessingProcessor` (`@Processor('video-processing')`) consumindo o job `process-video` (per `phase-03-videos/TD-05`).
2. No processor, ler o arquivo via `StorageService` e rodar `ffprobe` para extrair duração, resolução, codec e bitrate (per `phase-03-videos/TD-05`).
3. Validar o formato real via `ffprobe` contra o allowlist de `phase-03-videos/TD-10` — se inválido, marcar `status: failed` com `error_reason` preenchido.
4. Persistir `duration` e `metadata` e transicionar `status: processing` no `Video` via `VideosService`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Integration: FFmpeg real sobre arquivo de vídeo fixture (per `phase-03-videos/TD-09`) | `video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2, SI-03.5

**Acceptance criteria:**

- Processar um job com um vídeo fixture válido persiste `duration` e `metadata.width/height/codec/bitrate` corretos no `Video`.
- Processar um job com um arquivo de formato inválido (fora do allowlist de `phase-03-videos/TD-10`) marca `status: failed` com `error_reason` preenchido.
- Uma falha transitória (ex: erro de rede no download) resulta em retry automático via backoff do BullMQ (per `phase-03-videos/TD-02`).

---

### SI-03.7 — Worker: geração de thumbnail via ffmpeg

**Description:** Segundo estágio do processamento — captura um frame representativo do vídeo, envia ao bucket de thumbnails e conclui o pipeline marcando o vídeo como `ready`.

**Technical actions:**

1. No `VideoProcessingProcessor`, após extração de metadados bem-sucedida (SI-03.6), rodar `ffmpeg` para capturar um frame em 10% da duração (ou no segundo 1.0 quando a duração for desconhecida) e gerar `thumbnail.jpg` (per `phase-03-videos/TD-05`).
2. Fazer upload do thumbnail para o bucket `streamtube-thumbnails` via `StorageService` (per `phase-03-videos/TD-01`).
3. Persistir `thumbnail_storage_key` e transicionar `status: ready` (per `phase-03-videos/TD-04`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` (thumbnail) | Integration: FFmpeg real sobre arquivo de vídeo fixture (per `phase-03-videos/TD-09`) | `video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Processar um job com vídeo fixture válido gera um `thumbnail_storage_key` não-nulo apontando para um objeto existente no bucket `streamtube-thumbnails`.
- Após sucesso da geração de thumbnail, o `status` do `Video` transiciona para `ready`.
- O offset do frame capturado corresponde a 10% da duração extraída em SI-03.6 (ou 1.0s quando a duração é 0/indisponível).

---

### SI-03.8 — Endpoint GET /videos/:slug

**Route:** GET /videos/:slug
**Test Specs:** _pending /plan-test-specs_

**Description:** Leitura de metadados de um vídeo, respeitando a regra de visibilidade por status — pública quando `ready`, restrita ao dono caso contrário.

**Technical actions:**

1. Criar `VideosService.findBySlug` — busca por `slug`, inclui `channel` (id, nickname).
2. Aplicar a regra de visibilidade: `status !== ready` e requisitante não é o dono → lança `VideoNotFoundException` (404) (per `phase-03-videos/TD-07`).
3. Adicionar `GET /videos/:slug` ao `VideosController`, com guard JWT opcional (autenticação presente ou não).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosController` | E2E only | `videos.e2e-spec.ts` |
| `VideosService` | Unit: branch logic (`ready`/não-`ready`, dono/não-dono) | `videos.service.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `GET /videos/:slug` de um vídeo `ready` retorna `200` com os metadados, sem autenticação.
- `GET /videos/:slug` de um vídeo `draft`/`processing`/`failed` por um não-dono (ou anônimo) retorna `404 VIDEO_NOT_FOUND`.
- `GET /videos/:slug` de um vídeo não-`ready` pelo próprio canal dono retorna `200`.

---

### SI-03.9 — Endpoints GET /videos/:slug/stream e /download

**Route:** GET /videos/:slug/stream, GET /videos/:slug/download
**Test Specs:** _pending /plan-test-specs_

**Description:** Entrega do vídeo via redirect para URLs presigned — a API nunca proxeia os bytes, tanto para reprodução em streaming quanto para download.

**Technical actions:**

1. Criar `VideosService.getStreamRedirectUrl` — valida `status: ready` (404 caso contrário), gera GET presigned via `StorageService` (per `phase-03-videos/TD-08`).
2. Criar `VideosService.getDownloadRedirectUrl` — mesma validação, GET presigned com `ResponseContentDisposition: attachment` (per `phase-03-videos/TD-08`).
3. Adicionar `GET /videos/:slug/stream` e `GET /videos/:slug/download` ao `VideosController`, ambos respondendo `302 Found` com header `Location`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosController` | E2E only | `videos.e2e-spec.ts` |
| `VideosService` | Unit: branch logic (checagem de `ready`, geração de URL) | `videos.service.spec.ts` |

**Dependencies:** SI-03.1, SI-03.2, SI-03.8

**Acceptance criteria:**

- `GET /videos/:slug/stream` de um vídeo `ready` retorna `302` com header `Location` apontando para uma URL presigned do MinIO.
- `GET /videos/:slug/download` de um vídeo `ready` retorna `302` com `Location` cuja URL inclui `response-content-disposition=attachment`.
- `GET /videos/:slug/stream` ou `/download` de um vídeo não-`ready` retorna `404 VIDEO_NOT_FOUND`.

---

### SI-03.10 — Job de limpeza de rascunhos abandonados

**Description:** Job BullMQ agendado que expira rascunhos nunca finalizados e aborta sessões multipart órfãs, evitando acúmulo indefinido de linhas e partes de storage.

**Technical actions:**

1. Registrar a fila `video-cleanup` + job repeatable (`0 * * * *`) no bootstrap do worker (per `phase-03-videos/TD-11`).
2. Criar `VideoCleanupProcessor` (`@Processor('video-cleanup')`) — busca `Video` com `status: draft` e `created_at` mais antigo que 24h.
3. Para cada vídeo expirado, chamar `StorageService.abortMultipartUpload` (quando `multipart_upload_id` estiver presente) e remover a linha (per `phase-03-videos/TD-11`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoCleanupProcessor` | Integration: real MinIO + DB via Docker (per `phase-03-videos/TD-09`) — cria draft expirado, roda o job, verifica remoção | `video-cleanup.processor.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2, SI-03.5

**Acceptance criteria:**

- Um `Video` com `status: draft` e `created_at` > 24h é removido após a execução do job de limpeza.
- A sessão multipart associada (quando existir) é abortada no MinIO junto com a remoção da linha.
- Um `Video` com `status: draft` recém-criado (< 24h) NÃO é removido pelo job.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`uuid_generate_v4()`, matches `Channel`/`User` PK convention) |
| channel_id | uuid | FK → `channels.id`, not null, `ON DELETE RESTRICT` |
| title | varchar(150) | not null |
| description | text | nullable |
| slug | varchar(16) | unique, not null, indexed (`nanoid`, per `phase-03-videos/TD-06`) |
| status | enum | not null, default `draft` — values: `draft`, `uploaded`, `processing`, `ready`, `failed` (per `phase-03-videos/TD-04`) |
| video_storage_key | varchar(255) | nullable until uploaded — object key in `streamtube-videos` bucket (per `phase-03-videos/TD-01`) |
| thumbnail_storage_key | varchar(255) | nullable until processed — object key in `streamtube-thumbnails` bucket (per `phase-03-videos/TD-01`) |
| multipart_upload_id | varchar(255) | nullable — S3 `UploadId`, cleared on complete/abort (per `phase-03-videos/TD-03`, `phase-03-videos/TD-11`) |
| duration | integer | nullable — seconds, set by worker (per `phase-03-videos/TD-05`) |
| size_bytes | bigint | nullable — avoids INTEGER overflow at 10GB scale |
| metadata | jsonb | nullable — `{width, height, codec, bitrate}` (per `phase-03-videos/TD-05`) |
| error_reason | text | nullable — set when `status = failed` (per `phase-03-videos/TD-04`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), updated on write |

**Relations:** `Channel` has many `Video` (one-to-many); `Video.channel_id` → `Channel.id`
**Indexes:** unique on `slug` (`UQ_videos_slug`); index on `channel_id`; index on `status` (worker and cleanup-job queries filter by status, per `phase-03-videos/TD-11`)

### API Contracts

#### POST /videos/upload-intent (SI-03.3)

**Request headers:**
- Authorization: Bearer {access_token} — required (JWT, per `## Inherited Conventions`)
- Content-Type: application/json

**Request body:**
- title: string, required — max 150 characters
- description: string, optional
- filename: string, required
- mimeType: string, required — validated against the accepted allowlist (per `phase-03-videos/TD-10`)
- sizeBytes: number, required — integer, > 0, ≤ 10737418240 (10GB)

**Response 201:**
- video: { id, slug, title, status: "draft" }
- uploadId: string — S3 multipart `UploadId` (per `phase-03-videos/TD-03`)
- partUrls: array of { partNumber: number, url: string } — presigned per-part upload URLs (per `phase-03-videos/TD-03`)

**Error responses:**
- 400 validation error: when the request body fails schema validation (e.g., `mimeType` not in the accepted allowlist, per `phase-03-videos/TD-10`)
- 404 CHANNEL_NOT_FOUND: when the authenticated user has no channel
- 401 UNAUTHORIZED: when no valid JWT is present

---

#### POST /videos/:slug/confirm-upload (SI-03.4)

**Request headers:**
- Authorization: Bearer {access_token} — required, owner-only

**Request body:**
- parts: array of { partNumber: number, eTag: string }, required — per-part ETags returned by the client's S3 `PUT` responses, needed to call `CompleteMultipartUploadCommand` (per `phase-03-videos/TD-03`)

**Response 200:**
- status: "uploaded"
- message: string

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug doesn't resolve to a video owned by the caller
- 403 UNAUTHORIZED_VIDEO_ACCESS: when the caller isn't the owning channel
- 409 INVALID_VIDEO_STATE: when the video isn't in `draft` status (per `phase-03-videos/TD-04`)
- 400 validation error: when `parts` is missing or malformed

---

#### GET /videos/:slug (SI-03.8)

**Request headers:**
- Authorization: Bearer {access_token} — optional (public when `status: ready`, owner-only otherwise, per `phase-03-videos/TD-07`)

**Response 200:**
- id, slug, title, description, status, duration, metadata, createdAt
- channel: { id, nickname }

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug doesn't exist, OR the video isn't `ready` and the requester isn't the owning channel (per `phase-03-videos/TD-07` — same response for both cases, enumeration-resistant)

---

#### GET /videos/:slug/stream (SI-03.9)

**Request headers:**
- Range: bytes=start-end — optional, the browser sends this directly to the presigned redirect target, not to this endpoint's own response

**Response 302:**
- Location: presigned `GetObjectCommand` URL (per `phase-03-videos/TD-08`) — MinIO/S3 serves `206 Partial Content` / `200 OK` with `Accept-Ranges` / `Content-Range` on that URL directly to the client

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug doesn't exist or the video isn't `ready` (public endpoint — TD-07's enumeration-resistant 404 applies uniformly regardless of caller)

---

#### GET /videos/:slug/download (SI-03.9)

**Response 302:**
- Location: presigned `GetObjectCommand` URL with `ResponseContentDisposition: attachment; filename="{title}.mp4"` override (per `phase-03-videos/TD-08`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: same condition as `/stream`

---

#### Validation Rules — upload-intent & confirm-upload

- `title`: required, max 150 characters
- `mimeType`: required, must be in the accepted MIME allowlist (per `phase-03-videos/TD-10`) — checked at `upload-intent`; re-validated authoritatively by the worker via `ffprobe` after upload (per `phase-03-videos/TD-10`)
- `sizeBytes`: required, integer, > 0, ≤ 10737418240 (10GB)
- `parts`: required array, non-empty, each entry has `partNumber` (integer ≥ 1) and `eTag` (string)

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos/upload-intent | ✗ | ✗ | ✓ |
| POST /videos/:slug/confirm-upload | ✗ | ✗ | ✓ |
| GET /videos/:slug (status: ready) | ✓ | ✓ | ✓ |
| GET /videos/:slug (status: draft \| uploaded \| processing \| failed) | ✗ | ✗ | ✓ |
| GET /videos/:slug/stream (status: ready) | ✓ | ✓ | ✓ |
| GET /videos/:slug/download (status: ready) | ✓ | ✓ | ✓ |

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Slug não existe, ou vídeo não está `ready` e requisitante não é o canal dono (per `phase-03-videos/TD-07`) |
| CHANNEL_NOT_FOUND | 404 | Usuário autenticado não possui canal (upload-intent) |
| UNAUTHORIZED_VIDEO_ACCESS | 403 | Tentativa de `confirm-upload` em vídeo de outro canal |
| INVALID_VIDEO_STATE | 409 | `confirm-upload` chamado em vídeo que não está em `draft` (per `phase-03-videos/TD-04`) |

### Events/Messages

#### process-video (queue: `video-processing`)

**Payload:**

```json
{ "videoId": "uuid", "channelId": "uuid", "videoStorageKey": "string" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`) — enqueues on `confirm-upload` success
**Consumer:** `VideoProcessingWorker` (per `phase-03-videos/TD-05`) — dedicated worker container
**Trigger:** Client successfully confirms multipart upload completion
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-02` — BullMQ retry with exponential backoff on `ffprobe`/`ffmpeg` or network failure)

---

#### cleanup-abandoned-videos (queue: `video-cleanup`, repeatable job)

**Payload:**

```json
{ "olderThanHours": 24 }
```

**Producer:** BullMQ repeatable scheduler registered at module bootstrap (per `phase-03-videos/TD-11`)
**Consumer:** `VideoCleanupWorker` (per `phase-03-videos/TD-11`)
**Trigger:** Hourly schedule (repeatable job pattern)
**Delivery semantics:** at-least-once — idempotent by construction (aborting an already-aborted multipart session, or deleting an already-deleted `draft` row, is a no-op)

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root — entidade Video)
├── SI-03.3 — depends on SI-03.1, SI-03.2 (upload-intent precisa da entidade + storage)
│   └── SI-03.4 — depends on SI-03.1, SI-03.2, SI-03.3, SI-03.5 (confirm-upload precisa do upload-intent + fila)
├── SI-03.6 — depends on SI-03.1, SI-03.2, SI-03.5 (worker precisa da entidade + storage + fila)
│   └── SI-03.7 — depends on SI-03.6 (thumbnail depois dos metadados)
├── SI-03.8 — depends on SI-03.1 (leitura pública/dono)
│   └── SI-03.9 — depends on SI-03.1, SI-03.2, SI-03.8 (stream/download depois da leitura)
└── SI-03.10 — depends on SI-03.1, SI-03.2, SI-03.5 (cleanup precisa da entidade + storage + fila)

SI-03.2 (root — StorageService, independente)
SI-03.5 (root — fila BullMQ + worker bootstrap, independente)
```

---

## Deliverables

- [ ] SI-03.1 — Criar entidade Video
- [ ] SI-03.2 — Infra: StorageService (MinIO/S3)
- [ ] SI-03.3 — Endpoint POST /videos/upload-intent
- [ ] SI-03.4 — Endpoint POST /videos/:slug/confirm-upload
- [ ] SI-03.5 — Infra: fila BullMQ + bootstrap do worker
- [ ] SI-03.6 — Worker: extração de metadados via ffprobe + validação de formato
- [ ] SI-03.7 — Worker: geração de thumbnail via ffmpeg
- [ ] SI-03.8 — Endpoint GET /videos/:slug
- [ ] SI-03.9 — Endpoints GET /videos/:slug/stream e /download
- [ ] SI-03.10 — Job de limpeza de rascunhos abandonados

**Full test suites:**

- [ ] Testes unitários e de integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes E2E passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passa (`docker compose exec nestjs-api npm run lint`)
