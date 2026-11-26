---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-parts.e2e-spec.ts
---

# POST /videos/:id/upload/parts · GET /videos/:id/upload/parts — Test Plan

## Application Overview

Os dois endpoints sustentam o envio direto das partes ao storage. `POST /videos/:id/upload/parts` gera, em lote de até 100 itens, URLs `PUT` pré-assinadas pelo cliente público (`expires_in: 3600`), e também serve para renovar URLs expiradas. `GET /videos/:id/upload/parts` lista as partes que já chegaram ao storage (`ListParts`), para o cliente retomar um upload interrompido. Os dois só respondem ao dono de um vídeo em `draft`: para outro usuário a resposta é `404 VIDEO_NOT_FOUND`, e para um vídeo fora de `draft` é `409 VIDEO_NOT_IN_DRAFT`.

## Test Scenarios

### 1. Gerar URLs de parte e enviar ao storage

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()` com a configuração global do `main.ts`; `cleanAllTables(dataSource)` no `beforeEach`; dois usuários confirmados e autenticados pelo fluxo da Fase 02 (dono e outro); o dono cria o rascunho via `POST /videos` com `{ file_name: "clip.mp4", content_type: "video/mp4", size_bytes: 67108865 }` (`part_count: 2`). Os `PUT` nas URLs pré-assinadas passam por `requestPresigned` (`src/test/presigned-http.ts`), que conecta em `minio:9000` e preserva o header `Host` original. `afterAll` com `app.close()`.

#### 1.1. gera-urls-ordenadas-no-host-publico

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/parts` do dono com `{ "part_numbers": [2, 1] }`
    - expect: status `200`
    - expect: `parts` com exatamente 2 entradas, na ordem `part_number` `1`, `2`
    - expect: cada `url` tem o host de `S3_PUBLIC_ENDPOINT`
    - expect: `expires_in: 3600`

#### 1.2. put-de-parte-aceito-pelo-storage

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/parts` do dono com `{ "part_numbers": [1] }`
    - expect: status `200` com a `url` da parte 1
  2. `PUT` de um buffer de 64MiB (67108864 bytes) na `url` via `requestPresigned`
    - expect: status `200` do storage
    - expect: header `ETag` presente e não vazio na resposta

#### 1.3. rejeita-numero-de-parte-acima-do-part-count

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/parts` do dono com `{ "part_numbers": [3] }` (`part_count + 1`)
    - expect: status `400` com `error: "INVALID_PART_NUMBER"`

#### 1.4. rejeita-lote-vazio-ou-acima-de-100

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/parts` do dono com `{ "part_numbers": [] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  2. `POST /videos/:id/upload/parts` do dono com `part_numbers` de 101 itens (`1..101`)
    - expect: status `400` com `error: "VALIDATION_ERROR"`

### 2. Listar partes recebidas para retomar o upload

**Setup:** mesmo bootstrap do grupo 1; o dono envia só a parte 1 (64MiB) via `requestPresigned` antes do cenário.

#### 2.1. lista-somente-a-parte-enviada

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `GET /videos/:id/upload/parts` do dono
    - expect: status `200`
    - expect: `parts` igual a `[{ part_number: 1, etag, size_bytes: 67108864 }]`, com `etag` igual ao `ETag` devolvido pelo `PUT`
    - expect: `part_size: 67108864` e `part_count: 2`

### 3. Restringir ao dono e ao status draft

**Setup:** mesmo bootstrap do grupo 1; para o cenário de status, o rascunho é passado para `processing` direto no banco (`UPDATE videos SET status = 'processing'`).

#### 3.1. outro-usuario-recebe-404-nas-duas-rotas

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/parts` com o token do outro usuário e `{ "part_numbers": [1] }`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. `GET /videos/:id/upload/parts` com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

#### 3.2. video-fora-de-draft-recebe-409-nas-duas-rotas

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/parts` do dono com `{ "part_numbers": [1] }` para o vídeo em `processing`
    - expect: status `409` com `error: "VIDEO_NOT_IN_DRAFT"`
  2. `GET /videos/:id/upload/parts` do dono para o vídeo em `processing`
    - expect: status `409` com `error: "VIDEO_NOT_IN_DRAFT"`

#### 3.3. id-nao-uuid-recebe-400

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/not-a-uuid/upload/parts` do dono com `{ "part_numbers": [1] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  2. `GET /videos/not-a-uuid/upload/parts` do dono
    - expect: status `400` com `error: "VALIDATION_ERROR"`
