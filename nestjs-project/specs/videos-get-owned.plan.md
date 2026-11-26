---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12, SI-03.15
target_file: test/videos-get-owned.e2e-spec.ts
---

# GET /videos/:id — Test Plan

## Application Overview

`GET /videos/:id` permite ao dono acompanhar o ciclo `draft → processing → ready | failed` do próprio vídeo e ler o que o worker extraiu: `duration_seconds`, `metadata` (`width`, `height`, `videoCodec`, `audioCodec?`, `bitrate`, `formatName`, `sizeBytes`), `failure_reason` e o `thumbnail_url`. Esta é uma URL GET pré-assinada pelo cliente público quando existe `thumbnail_key`, e `null` caso contrário. Exige login e ser dono do canal: outro usuário recebe `404 VIDEO_NOT_FOUND`, sem revelar que o vídeo existe.

## Test Scenarios

### 1. Consultar o próprio vídeo em cada status

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()` com a configuração global do `main.ts`; `cleanAllTables(dataSource)` no `beforeEach`; dois usuários confirmados e autenticados (dono e outro); o dono cria um rascunho via `POST /videos`. Para os estados `ready` e `failed`, o vídeo é levado ao estado direto no banco (sem rodar o worker, que é coberto pelo SI-03.14): `ready` grava `duration_seconds = 3.0`, `metadata` completo e `thumbnail_key = videos/{id}/thumbnail.jpg`, com um JPEG válido enviado antes a essa chave por `StorageService.putObject`; `failed` grava `failure_reason = "ffprobe: no video stream"`. O `GET` na `thumbnail_url` passa por `requestPresigned` (`src/test/presigned-http.ts`), que conecta em `minio:9000` e preserva o header `Host`. `afterAll` com `app.close()`.

#### 1.1. rascunho-sem-metadados

**Covers AC:** #1 (SI-03.12); `title` na resposta (SI-03.15)
**Source:** auto
**Last sync:** 2026-11-26T02:26:03Z

**Steps:**
  1. `GET /videos/:id` do dono para o rascunho
    - expect: status `200` com `status: "draft"`, `duration_seconds: null`, `metadata: null`, `thumbnail_url: null`, `failure_reason: null`
    - expect: corpo contém `id`, `public_id`, `title` (`"clip"`, derivado de `clip.mp4`), `original_filename`, `content_type`, `size_bytes`, `created_at` e `updated_at` (ISO-8601)

#### 1.2. video-ready-com-metadados-e-thumbnail

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `GET /videos/:id` do dono para o vídeo `ready`
    - expect: status `200` com `status: "ready"` e `duration_seconds` numérico
    - expect: `metadata` contém `width`, `height`, `videoCodec`, `bitrate`, `formatName` e `sizeBytes`
    - expect: `thumbnail_url` é uma string com o host de `S3_PUBLIC_ENDPOINT`
  2. `GET` na `thumbnail_url` via `requestPresigned`
    - expect: status `200` e corpo começando com os bytes `FF D8` (JPEG)

#### 1.3. video-failed-com-motivo

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `GET /videos/:id` do dono para o vídeo `failed`
    - expect: status `200` com `status: "failed"` e `failure_reason: "ffprobe: no video stream"`

### 2. Restringir ao dono autenticado

**Setup:** mesmo bootstrap do grupo 1.

#### 2.1. outro-usuario-recebe-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `GET /videos/:id` com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. `GET /videos/{uuid-inexistente}` com o token do dono
    - expect: status `404` com corpo idêntico ao do passo 1 (exceto `message`, se variar)

#### 2.2. sem-token-recebe-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `GET /videos/:id` sem header `Authorization`
    - expect: status `401`

#### 2.3. id-nao-uuid-recebe-400

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `GET /videos/not-a-uuid` do dono
    - expect: status `400` com `error: "VALIDATION_ERROR"`
