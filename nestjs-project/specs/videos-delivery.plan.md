---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: nestjs-project/test/videos-delivery.e2e-spec.ts
---

# GET /videos/:slug/stream e /videos/:slug/download Test Plan

## Application Overview

Entrega os bytes do vídeo via redirect `302` para uma URL presigned do storage — a API nunca proxeia o vídeo. `/stream` redireciona para uma URL presigned de leitura simples (suporta `Range` nativamente no MinIO/S3); `/download` redireciona para a mesma URL de leitura, mas com `ResponseContentDisposition: attachment` forçando o download no browser. Ambos respeitam a mesma regra de visibilidade por `status` de `GET /videos/:slug`.

## Test Scenarios

### 1. Video Delivery

**Setup:** `beforeEach` truncate test DB via `cleanAllTables`; bootstrap `Test.createTestingModule({ imports: [AppModule] }).compile()` com `ValidationPipe` + filtros globais; seed de um `Video` com `status: ready` e um `Video` com `status: draft`.

#### 1.1. stream-redireciona-para-url-presigned

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. GET /videos/:slug/stream (slug de um vídeo `ready`)
    - expect: status `302`
    - expect: header `Location` presente e apontando para uma URL presigned do bucket `streamtube-videos` no MinIO

#### 1.2. download-redireciona-com-content-disposition-attachment

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. GET /videos/:slug/download (slug de um vídeo `ready`)
    - expect: status `302`
    - expect: header `Location` contém `response-content-disposition=attachment` na query string

#### 1.3. stream-e-download-retornam-404-para-video-nao-ready

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-23T22:24:12Z

**Steps:**
  1. GET /videos/:slug/stream (slug de um vídeo `draft`)
    - expect: status `404`
    - expect: body `error` igual a `"VIDEO_NOT_FOUND"`
  2. GET /videos/:slug/download (mesmo slug do vídeo `draft`)
    - expect: status `404`
    - expect: body `error` igual a `"VIDEO_NOT_FOUND"`
