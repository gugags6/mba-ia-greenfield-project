---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.3
target_file: nestjs-project/test/videos-upload-intent.e2e-spec.ts
---

# POST /videos/upload-intent Test Plan

## Application Overview

Endpoint de entrada do fluxo de upload de vídeo. Um usuário autenticado com canal próprio envia metadados do arquivo (título, filename, mimeType, sizeBytes) e recebe de volta um rascunho de `Video` (`status: draft`) junto com uma sessão multipart S3 já iniciada — `uploadId` e a lista de `partUrls` presigned que o client usa para enviar os bytes diretamente ao storage, sem a API intermediar o tráfego.

## Test Scenarios

### 1. Upload Intent Creation

**Setup:** `beforeEach` truncate test DB via `cleanAllTables`; bootstrap `Test.createTestingModule({ imports: [AppModule] }).compile()` com `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` e `DomainExceptionFilter` + `ValidationExceptionFilter` globais (per `.claude/rules/nestjs-testing.md`); seed de um usuário autenticado com canal próprio (access token válido).

#### 1.1. cria-rascunho-com-payload-valido

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. POST /videos/upload-intent com Authorization Bearer válido e body `{ title, filename, mimeType: <allowlist>, sizeBytes }`
    - expect: status `201`
    - expect: body `video.status` igual a `"draft"`
    - expect: body `uploadId` presente (string não-vazia)
    - expect: body `partUrls` é array não-vazio de `{ partNumber, url }`

#### 1.2. rejeita-mimetype-fora-do-allowlist

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. POST /videos/upload-intent com Authorization Bearer válido e `mimeType` fora do allowlist aceito (per `phase-03-videos/TD-10`)
    - expect: status `400`
    - expect: body de erro de validação (per `.claude/rules/...` envelope `{ statusCode, error, message }`)

#### 1.3. rejeita-sem-jwt

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. POST /videos/upload-intent sem header `Authorization`
    - expect: status `401`

#### 1.4. rejeita-usuario-sem-canal

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. POST /videos/upload-intent com Authorization Bearer de um usuário autenticado que não possui canal
    - expect: status `404`
    - expect: body `error` igual a `"CHANNEL_NOT_FOUND"`
