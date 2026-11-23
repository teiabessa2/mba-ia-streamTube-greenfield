---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: test/videos-playback.e2e-spec.ts
---

# GET /videos/:publicId/stream · GET /videos/:publicId/download — Test Plan

## Application Overview

Os dois endpoints públicos (`@Public()`) entregam a reprodução e o download pela URL única do vídeo (`public_id`). Ambos respondem `302` com `Location` apontando para uma URL GET pré-assinada pelo cliente público, e a API não trafega os bytes. No stream, o storage atende `Range` nativamente (`206 Partial Content`), então o player reproduz sem baixar o arquivo inteiro. No download, a URL leva `ResponseContentDisposition: attachment; filename="{original_filename}"`. Os dois só funcionam para `status = ready`: em `draft`, `processing` ou `failed`, e para `publicId` inexistente, a resposta é a mesma `404 VIDEO_NOT_FOUND`, para qualquer chamador, inclusive o dono.

## Test Scenarios

### 1. Reproduzir e baixar um vídeo pronto

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()` com a configuração global do `main.ts`; `cleanAllTables(dataSource)` no `beforeEach`; um usuário confirmado e autenticado (dono) cria um rascunho via `POST /videos` com `{ file_name: "my clip.mp4", content_type: "video/mp4", size_bytes: 4096 }`; um buffer conhecido de 4096 bytes é gravado em `videos/{id}/original` por `StorageService.putObject`, e o vídeo é passado para `ready` direto no banco (sem rodar o worker, que é coberto pelo SI-03.14). Todo `GET` na `Location` passa por `requestPresigned` (`src/test/presigned-http.ts`), que conecta em `minio:9000` e preserva o header `Host` original. O supertest é configurado para **não** seguir redirects. `afterAll` com `app.close()`.

#### 1.1. stream-redireciona-para-url-publica

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `GET /videos/:publicId/stream` sem header `Authorization`
    - expect: status `302` sem corpo
    - expect: header `Location` com o host de `S3_PUBLIC_ENDPOINT` e a query de assinatura (`X-Amz-Signature`)

#### 1.2. stream-atende-range-com-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `GET /videos/:publicId/stream` e guardar o `Location`
    - expect: status `302`
  2. `GET` no `Location` via `requestPresigned` com header `Range: bytes=0-99`
    - expect: status `206 Partial Content`
    - expect: corpo com exatamente 100 bytes, iguais aos 100 primeiros bytes do buffer gravado no setup
    - expect: header `Content-Range: bytes 0-99/4096`
    - expect: header `Content-Type: video/mp4`

#### 1.3. download-forca-attachment-com-nome-original

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `GET /videos/:publicId/download` sem header `Authorization`
    - expect: status `302` com header `Location` no host de `S3_PUBLIC_ENDPOINT`
  2. `GET` no `Location` via `requestPresigned`
    - expect: status `200` com o corpo completo (4096 bytes)
    - expect: header `Content-Disposition: attachment; filename="my clip.mp4"`

### 2. Esconder vídeos que não estão prontos

**Setup:** mesmo bootstrap do grupo 1; um vídeo por status (`draft`, `processing`, `failed`) é criado pelo dono e levado ao status direto no banco.

#### 2.1. status-nao-ready-recebe-404-inclusive-para-o-dono

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. Para cada vídeo em `draft`, `processing` e `failed`: `GET /videos/:publicId/stream` sem token
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. Para cada um deles: `GET /videos/:publicId/download` sem token
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  3. Para cada um deles: `GET /videos/:publicId/stream` e `/download` com o token do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

#### 2.2. public-id-inexistente-tem-resposta-identica

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `GET /videos/AAAAAAAAAAA/stream` (`publicId` inexistente com formato válido)
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. Comparar com o corpo do `stream` do vídeo em `processing` do cenário 2.1
    - expect: `statusCode`, `error` e `message` idênticos
  3. `GET /videos/x/stream` (`publicId` com formato inválido)
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"` (nunca `400`)
