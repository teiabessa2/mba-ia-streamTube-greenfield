---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload-abort.e2e-spec.ts
---

# DELETE /videos/:id/upload — Test Plan

## Application Overview

`DELETE /videos/:id/upload` é o caminho de desistência explícita do upload: aborta o S3 Multipart (`AbortMultipartUpload`), o que descarta as partes já enviadas, e apaga a linha do rascunho. Não existe estado "abortado" no enum de status. Só o dono de um vídeo em `draft` pode abortar: um vídeo fora de `draft` responde `409 VIDEO_NOT_IN_DRAFT`, e outro usuário ou um rascunho já removido responde `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Abortar upload do próprio rascunho

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()` com a configuração global do `main.ts`; `cleanAllTables(dataSource)` no `beforeEach`; dois usuários confirmados e autenticados (dono e outro); o dono cria um rascunho com `{ file_name: "clip.mp4", content_type: "video/mp4", size_bytes: 67108865 }`, obtém a URL da parte 1 e envia 64MiB via `requestPresigned` (`src/test/presigned-http.ts`), guardando `storage_key` e `upload_id` lidos do banco. `afterAll` com `app.close()`.

#### 1.1. abort-remove-rascunho-e-partes

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `DELETE /videos/:id/upload` do dono
    - expect: status `204` sem corpo
  2. Buscar a linha de `videos` pelo `id`
    - expect: a linha não existe
  3. `StorageService.listParts(storage_key, upload_id)` com os valores guardados no setup
    - expect: falha com `NoSuchUpload` (as partes enviadas foram descartadas)

#### 1.2. abort-repetido-recebe-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `DELETE /videos/:id/upload` do dono
    - expect: status `204`
  2. Repetir `DELETE /videos/:id/upload` do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

### 2. Recusar abort fora das regras

**Setup:** mesmo bootstrap do grupo 1; para o cenário de status, o rascunho é passado para `processing` direto no banco (`UPDATE videos SET status = 'processing'`).

#### 2.1. video-em-processing-recebe-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `DELETE /videos/:id/upload` do dono para o vídeo em `processing`
    - expect: status `409` com `error: "VIDEO_NOT_IN_DRAFT"`
  2. Ler a linha de `videos` pelo `id`
    - expect: a linha existe com `status = processing` e os demais campos inalterados

#### 2.2. outro-usuario-recebe-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `DELETE /videos/:id/upload` com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. Ler a linha de `videos` pelo `id`
    - expect: o rascunho continua existindo em `draft`
