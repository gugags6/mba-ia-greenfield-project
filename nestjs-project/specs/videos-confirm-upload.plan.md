---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4
target_file: nestjs-project/test/videos-confirm-upload.e2e-spec.ts
---

# POST /videos/:slug/confirm-upload Test Plan

## Application Overview

Finaliza a sessão multipart iniciada em `upload-intent` — o client já enviou todas as partes diretamente ao storage e agora envia os `eTag`s de volta para que a API complete a sessão S3, transicione o vídeo de `draft` para `uploaded`, e enfileire o job assíncrono `process-video` que dispara a extração de metadados e geração de thumbnail.

## Test Scenarios

### 1. Confirm Upload

**Setup:** `beforeEach` truncate test DB via `cleanAllTables`; bootstrap `Test.createTestingModule({ imports: [AppModule] }).compile()` com `ValidationPipe` + `DomainExceptionFilter`/`ValidationExceptionFilter` globais; seed de um `Video` com `status: draft` pertencente ao canal do usuário autenticado (e um segundo `Video` de outro canal para o cenário 1.3).

#### 1.1. confirma-upload-de-video-draft-proprio

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. POST /videos/:slug/confirm-upload (slug do vídeo `draft` do próprio canal) com Authorization Bearer válido e body `{ parts: [{ partNumber, eTag }, ...] }`
    - expect: status `200`
    - expect: `Video.status` no banco transicionou para `"uploaded"`

#### 1.2. enfileira-job-process-video-com-payload-correto

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. POST /videos/:slug/confirm-upload (slug do vídeo `draft` do próprio canal) com body de `parts` válido
    - expect: status `200`
    - expect: um job `process-video` foi enfileirado na fila `video-processing` com `videoId` igual ao id do vídeo confirmado (verificação via inspeção da fila BullMQ no `beforeAll`/teste)

#### 1.3. rejeita-confirmacao-de-video-de-outro-canal

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. POST /videos/:slug/confirm-upload (slug de um vídeo `draft` pertencente a outro canal) com Authorization Bearer válido
    - expect: status `403`
    - expect: body `error` igual a `"UNAUTHORIZED_VIDEO_ACCESS"`

#### 1.4. rejeita-confirmacao-de-video-ja-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. POST /videos/:slug/confirm-upload (slug de um vídeo já em `status: ready` do próprio canal)
    - expect: status `409`
    - expect: body `error` igual a `"INVALID_VIDEO_STATE"`
