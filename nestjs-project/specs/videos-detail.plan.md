---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: nestjs-project/test/videos-detail.e2e-spec.ts
---

# GET /videos/:slug Test Plan

## Application Overview

Leitura pública de metadados de um vídeo por `slug`. A visibilidade é condicionada pelo `status`: um vídeo `ready` é público (sem autenticação), enquanto um vídeo em qualquer outro status (`draft`, `uploaded`, `processing`, `failed`) só é visível ao próprio canal dono — para qualquer outro requisitante (incluindo anônimo) a API responde `404` de forma indistinguível de "slug inexistente", evitando enumeração.

## Test Scenarios

### 1. Video Visibility by Status

**Setup:** `beforeEach` truncate test DB via `cleanAllTables`; bootstrap `Test.createTestingModule({ imports: [AppModule] }).compile()` com `ValidationPipe` + filtros globais; seed de um `Video` com `status: ready` e um `Video` com `status: draft`, ambos pertencentes ao mesmo canal (com access token do dono disponível).

#### 1.1. retorna-metadados-de-video-ready-sem-autenticacao

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. GET /videos/:slug (slug de um vídeo `ready`) sem header `Authorization`
    - expect: status `200`
    - expect: body contém `id`, `slug`, `title`, `description`, `status`, `duration`, `metadata`, `createdAt`, `channel: { id, nickname }`

#### 1.2. retorna-404-para-video-nao-ready-de-nao-dono

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. GET /videos/:slug (slug de um vídeo `draft`) sem header `Authorization` (requisitante anônimo)
    - expect: status `404`
    - expect: body `error` igual a `"VIDEO_NOT_FOUND"`

#### 1.3. retorna-200-para-video-nao-ready-do-proprio-dono

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. GET /videos/:slug (slug de um vídeo `draft` do próprio canal) com Authorization Bearer do canal dono
    - expect: status `200`
    - expect: body `status` igual a `"draft"`
