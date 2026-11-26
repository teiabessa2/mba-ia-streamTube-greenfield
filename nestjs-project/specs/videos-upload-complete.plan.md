---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:id/upload/complete — Test Plan

## Application Overview

`POST /videos/:id/upload/complete` fecha o upload: conclui o S3 Multipart com as partes ordenadas, confere o tamanho real do objeto (`HeadObject`) contra o `size_bytes` declarado e só então passa o vídeo de `draft` para `processing` (zerando `upload_id`) e publica o job `process-video` na fila `videos`. É o gatilho do processamento automático. Partes rejeitadas pelo storage mantêm o rascunho (`400 INVALID_UPLOAD_PARTS`). Tamanho divergente apaga objeto e rascunho sem enfileirar (`400 UPLOAD_SIZE_MISMATCH`). Um `complete` repetido não reenfileira (`409 VIDEO_NOT_IN_DRAFT`).

## Test Scenarios

### 1. Concluir upload e enfileirar processamento

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()` com a configuração global do `main.ts`, `QUEUE_PREFIX` único por suíte (ex.: `e2e-complete-{timestamp}`); `cleanAllTables(dataSource)` no `beforeEach`; dois usuários confirmados e autenticados (dono e outro); o dono cria um rascunho com `{ file_name: "clip.mp4", content_type: "video/mp4", size_bytes: 1024 }` (`part_count: 1`), obtém a URL da parte 1 e envia 1024 bytes via `requestPresigned` (`src/test/presigned-http.ts`), guardando o `ETag`. A fila é inspecionada pela instância `Queue` obtida com `app.get(getQueueToken('videos'))`; nenhum worker roda nesta suíte. `afterAll` com `queue.obliterate({ force: true })` e `app.close()`.

#### 1.1. conclui-e-passa-para-processing

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/complete` do dono com `{ "parts": [{ "part_number": 1, "etag": "<ETag>" }] }`
    - expect: status `200` com `{ id, public_id, status: "processing" }`
  2. Ler a linha de `videos` pelo `id`
    - expect: `status = processing` e `upload_id = null`
  3. `queue.getJob(id)`
    - expect: job existe com `name: "process-video"` e `data` igual a `{ "videoId": "<id>" }`

#### 1.2. complete-repetido-nao-reenfileira

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/complete` do dono com as partes corretas
    - expect: status `200`
  2. Repetir a mesma requisição
    - expect: status `409` com `error: "VIDEO_NOT_IN_DRAFT"`
  3. Contar os jobs da fila para o vídeo (`queue.getJobs(['waiting', 'delayed', 'active'])` filtrado por `data.videoId`)
    - expect: exatamente 1 job

### 2. Rejeitar conclusões inválidas

**Setup:** mesmo bootstrap do grupo 1. Para o cenário de tamanho, o rascunho é criado com `size_bytes: 2048`, mas só 1024 bytes são enviados na parte 1 (`part_count: 1`).

#### 2.1. etag-errado-mantem-rascunho-retomavel

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/complete` do dono com `{ "parts": [{ "part_number": 1, "etag": "\"00000000000000000000000000000000\"" }] }`
    - expect: status `400` com `error: "INVALID_UPLOAD_PARTS"`
  2. Ler a linha de `videos` pelo `id`
    - expect: `status = draft` e `upload_id` inalterado
  3. `GET /videos/:id/upload/parts` do dono
    - expect: status `200` com `parts` contendo a parte 1 enviada

#### 2.2. tamanho-real-divergente-apaga-rascunho-e-objeto

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/complete` do dono com a parte 1 e seu `ETag` correto (objeto final de 1024 bytes, declarado 2048)
    - expect: status `400` com `error: "UPLOAD_SIZE_MISMATCH"`
  2. Buscar a linha de `videos` pelo `id`
    - expect: a linha não existe
  3. `HeadObject` em `videos/{id}/original` pelo cliente interno
    - expect: o objeto não existe (`NotFound`)
  4. `queue.getJob(id)`
    - expect: nenhum job para o vídeo

#### 2.3. part-number-repetido-recebe-400

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/complete` do dono com `{ "parts": [{ "part_number": 1, "etag": "<ETag>" }, { "part_number": 1, "etag": "<ETag>" }] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"`
    - expect: o vídeo continua `draft`

### 3. Restringir ao dono

**Setup:** mesmo bootstrap do grupo 1.

#### 3.1. outro-usuario-recebe-404

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos/:id/upload/complete` com o token do outro usuário e as partes corretas
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo continua `draft` e nenhum job é publicado
