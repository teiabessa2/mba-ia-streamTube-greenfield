---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5, SI-03.15
target_file: test/videos-initiate-upload.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo de até 10GB. O endpoint só troca JSON: valida o arquivo declarado (`file_name`, `content_type`, `size_bytes`) e o `title` opcional (SI-03.15) contra o limite de 10737418240 bytes e a allowlist de formatos, cria o rascunho (`status = draft`) no canal do usuário autenticado e abre um S3 Multipart Upload na chave `videos/{id}/original`. As partes vão depois direto ao storage por URL pré-assinada (SI-03.6). Rejeições de tamanho (`413 VIDEO_TOO_LARGE`) e de formato (`415 UNSUPPORTED_VIDEO_FORMAT`) acontecem antes de qualquer escrita, sem criar rascunho.

## Test Scenarios

### 1. Iniciar upload e pré-cadastrar rascunho

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a configuração global do `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`); `cleanAllTables(dataSource)` no `beforeEach` (inclui `videos`); usuário confirmado e autenticado pelo fluxo da Fase 02 (`register` → confirmação → `login`), cujo `access_token` vai no header `Authorization: Bearer`. MinIO real do Compose, com o bucket garantido pelo `StorageModule` no boot; `afterAll` com `app.close()`.

#### 1.1. inicia-upload-cria-rascunho-com-multipart-aberto

**Covers AC:** #1, #7
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos` autenticado com `{ "file_name": "clip.mp4", "content_type": "video/mp4", "size_bytes": 134217728 }`
    - expect: status `201`
    - expect: corpo com `id` (uuid), `public_id` de 11 caracteres no alfabeto base64url, `status: "draft"`, `part_size: 67108864`, `part_count: 2`
  2. Ler a linha de `videos` pelo `id` retornado
    - expect: `status = draft`, `channel_id` igual ao canal do usuário autenticado, `storage_key = videos/{id}/original`, `upload_id` não nulo
  3. Chamar `StorageService.listParts(storage_key, upload_id)` sobre o rascunho criado
    - expect: retorna lista vazia (o multipart existe e está aberto), sem `NoSuchUpload`

#### 1.2. aceita-extensao-e-mime-em-maiusculas

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos` autenticado com `{ "file_name": "CLIP.MOV", "content_type": "video/quicktime", "size_bytes": 1048576 }`
    - expect: status `201` com `status: "draft"` e `part_count: 1`

### 2. Rejeitar arquivo fora das regras sem criar rascunho

**Setup:** mesmo bootstrap do grupo 1; cada cenário confere `SELECT COUNT(*) FROM videos` antes e depois da requisição.

#### 2.1. rejeita-tamanho-acima-de-10gb

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos` autenticado com `{ "file_name": "big.mp4", "content_type": "video/mp4", "size_bytes": 10737418241 }`
    - expect: status `413` com corpo `{ statusCode: 413, error: "VIDEO_TOO_LARGE", message }`
    - expect: nenhuma linha nova em `videos`
  2. `POST /videos` autenticado com `size_bytes: 10737418240` (exatamente o limite)
    - expect: status `201` (o limite é inclusivo)

#### 2.2. rejeita-formato-fora-da-allowlist

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos` autenticado com `{ "file_name": "clip.mp4", "content_type": "image/png", "size_bytes": 1048576 }`
    - expect: status `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
    - expect: nenhuma linha nova em `videos`
  2. `POST /videos` autenticado com `{ "file_name": "clip.avi", "content_type": "video/mp4", "size_bytes": 1048576 }`
    - expect: status `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
    - expect: nenhuma linha nova em `videos`

#### 2.3. rejeita-corpo-fora-do-schema

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos` autenticado com `{ "file_name": "clip.mp4", "content_type": "video/mp4" }` (sem `size_bytes`)
    - expect: status `400` com `error: "VALIDATION_ERROR"`
    - expect: nenhuma linha nova em `videos`

### 3. Exigir autenticação

**Setup:** mesmo bootstrap do grupo 1, sem obter token.

#### 3.1. rejeita-requisicao-sem-token

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-23T22:45:04Z

**Steps:**
  1. `POST /videos` sem header `Authorization`, com corpo válido
    - expect: status `401`
    - expect: nenhuma linha nova em `videos`

### 4. Título do vídeo (SI-03.15)

**Setup:** mesmo bootstrap do grupo 1. O detalhe é lido por `GET /videos/:id` com o mesmo token. "Covers AC" deste grupo refere-se aos critérios de aceite do SI-03.15.

#### 4.1. titulo-informado-e-devolvido-no-detalhe

**Covers AC:** #4, #11
**Source:** auto
**Last sync:** 2026-11-26T02:25:46Z

**Steps:**
  1. `POST /videos` autenticado com `{ "title": "Minhas férias", "file_name": "clip.mp4", "content_type": "video/mp4", "size_bytes": 134217728 }`
    - expect: status `201`, com as mesmas chaves de antes no corpo (`id`, `public_id`, `status`, `part_size`, `part_count`), sem `title`
  2. `GET /videos/:id` do rascunho criado
    - expect: `title: "Minhas férias"`

#### 4.2. titulo-com-espacos-nas-pontas-e-gravado-sem-eles

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-26T02:25:46Z

**Steps:**
  1. `POST /videos` autenticado com `title: "  Minhas férias  "` e corpo válido
    - expect: status `201`
  2. `GET /videos/:id` do rascunho criado
    - expect: `title: "Minhas férias"`

#### 4.3. titulo-derivado-do-file-name

**Covers AC:** #7, #10
**Source:** auto
**Last sync:** 2026-11-26T02:25:46Z

**Steps:**
  1. `POST /videos` autenticado sem `title`, com `file_name: "clip.final.mp4"`
    - expect: status `201`, e `GET /videos/:id` devolve `title: "clip.final"`
  2. `POST /videos` autenticado sem `title`, com `file_name` de 255 caracteres (`"a" × 251 + ".mp4"`)
    - expect: status `201`, e `GET /videos/:id` devolve `title` com os 100 primeiros `a`

#### 4.4. titulo-derivado-quando-o-nome-fica-vazio

**Covers AC:** #8, #9
**Source:** auto
**Last sync:** 2026-11-26T02:25:46Z

**Steps:**
  1. `POST /videos` autenticado sem `title`, com `file_name: " .mp4"`
    - expect: status `201`, e `GET /videos/:id` devolve `title: ".mp4"` (o `file_name` com trim)
  2. `POST /videos` autenticado sem `title`, com `file_name: ".mp4"`
    - expect: status `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"`: `.mp4` não tem extensão para a allowlist
    - expect: nenhuma linha nova em `videos`

#### 4.5. rejeita-titulo-invalido

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-26T02:25:46Z

**Steps:**
  1. `POST /videos` autenticado com `title: ""`, depois com `title: "   "` e depois com `title` de 101 caracteres, sempre com o resto do corpo válido
    - expect: status `400` com `error: "VALIDATION_ERROR"` nos três casos
    - expect: nenhuma linha nova em `videos`
