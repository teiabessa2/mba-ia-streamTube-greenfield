---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-23T16:12:29-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-23T16:12:29-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-23T15:41:23-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-17T11:04:44-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de vídeos de até 10GB direto ao object storage com pré-cadastro automático em rascunho, o processamento automático em segundo plano (fila + worker FFmpeg com extração de duração e metadados e geração de thumbnail), uma URL única por vídeo e a reprodução via streaming e o download — com upload de até 10GB funcional, processamento automático, streaming funcionando e URLs únicas geradas.

---

## Step Implementations

<!-- SIs will be written in Phase B -->

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos` (nova). Colunas em snake_case, seguindo a convenção das entidades `User`/`Channel` da Fase 02.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(16) | unique, not null — ID aleatório curto gerado com `node:crypto` (base64url, 8 bytes → 11 caracteres) na criação do rascunho; colisão em UNIQUE → nova tentativa (per `phase-03-videos/TD-07`) |
| channel_id | uuid | not null, FK → `channels.id` — canal do usuário autenticado que iniciou o upload (dono) |
| status | enum `video_status` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-09`) |
| original_filename | varchar(255) | not null — nome do arquivo declarado no início do upload |
| content_type | varchar(100) | not null — MIME declarado, já validado contra a allowlist (per `phase-03-videos/TD-11`) |
| size_bytes | bigint | not null — tamanho declarado; `1 ≤ size_bytes ≤ 10737418240` (10 × 1024³, per `phase-03-videos/TD-03` revisão 2026-11-23) |
| storage_key | varchar(255) | not null — chave do objeto original no bucket: `videos/{videoId}/original` (per `phase-03-videos/TD-02`) |
| upload_id | varchar(255) | nullable — `UploadId` do S3 Multipart enquanto `status = draft`; `null` após o `complete` (per `phase-03-videos/TD-03`) |
| part_size | integer | not null — tamanho de parte fixado no início: `67108864` (64MiB, _sugestão — sem origem normativa_, per `phase-03-videos/TD-03`) |
| part_count | integer | not null — `ceil(size_bytes / part_size)`; sempre ≤ 10.000 |
| thumbnail_key | varchar(255) | nullable — chave do thumbnail gerado pelo worker: `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`) |
| duration_seconds | double precision | nullable — preenchida pelo worker a partir do `ffprobe` (per `phase-03-videos/TD-05` revisão 2026-11-23) |
| metadata | jsonb | nullable — objeto com `width`, `height`, `videoCodec`, `audioCodec` (opcional), `bitrate`, `formatName`, `sizeBytes`, extraídos do `ffprobe` (per `phase-03-videos/TD-05` revisão 2026-11-23) |
| failure_reason | text | nullable — mensagem do erro final gravada pelo handler de falha final quando `status = failed` (per `phase-03-videos/TD-10`) |
| created_at | timestamp | default now() |
| updated_at | timestamp | default now(), on update |

**Relations:** `Channel` has many `Video` (one-to-many; `Video.channel_id` → `Channel.id`). O dono do vídeo é o `User` dono do `Channel` (`channels.user_id`).
**Indexes:** unique on `public_id`; index on `channel_id`.
**Transições de status (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`):** `draft → processing` (no `complete` do upload, pela API) · `processing → ready` (worker, após metadados + thumbnail gravados) · `processing → failed` (handler de falha final do worker: `UnrecoverableError` ou tentativas esgotadas). Nenhuma outra transição existe nesta fase. Rascunho abortado é **removido** (linha apagada), não ganha estado próprio (per `phase-03-videos/TD-12`). Rascunho cujo objeto final diverge de `size_bytes` no `complete` (`UPLOAD_SIZE_MISMATCH`) recebe o mesmo destino: objeto e linha apagados, sem passar por `processing` nem `failed` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-12`).
**Migration:** nova migration TypeORM cria o enum `video_status`, a tabela `videos`, o índice único em `public_id`, o índice em `channel_id` e a FK para `channels` (`synchronize: false` herdado da Fase 01).

### API Contracts

Convenções herdadas: corpo de erro `{ statusCode, error, message }` (per `phase-02-auth/TD-07`); campos do JSON em snake_case, como em `refresh_token` / `new_password` da Fase 02. A exceção são as chaves internas do objeto `metadata`, transcritas literalmente do `phase-03-videos/TD-05`. Todo endpoint protegido aceita `Authorization: Bearer <access_token>` (guard JWT global, per `phase-02-auth/TD-02`); os endpoints públicos usam `@Public()`. Nenhum endpoint recebe os bytes do vídeo: as partes vão direto ao storage por URL pré-assinada (per `phase-03-videos/TD-03` revisão 2026-11-23). Cada endpoint recebe decoradores OpenAPI explícitos (`@ApiOperation`, `@ApiResponse` por status com `ApiErrorEnvelope`, `@ApiParam`, `@ApiBody`), per `openapi-docs-nestjs/TD-01` revisão 2026-05-12.

#### POST /videos (SI-03.5)

Inicia o upload: valida o arquivo declarado, cria o rascunho (`status = draft`) e abre o S3 Multipart Upload (`CreateMultipartUploadCommand`) na chave `videos/{videoId}/original` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-02`, `phase-03-videos/TD-11`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- file_name: string, required — 1 a 255 caracteres; a extensão precisa estar na allowlist
- content_type: string, required — precisa estar na allowlist
- size_bytes: integer, required — `1 ≤ size_bytes ≤ 10737418240`

**Response 201:**
- id: string (uuid)
- public_id: string
- status: `"draft"`
- part_size: integer — `67108864`
- part_count: integer — `ceil(size_bytes / part_size)`

**Error responses:**
- 400 VALIDATION_ERROR: corpo fora do schema (campo ausente, tipo errado, `size_bytes < 1`)
- 401 Unauthorized: sem token ou token inválido (guard global)
- 413 VIDEO_TOO_LARGE: `size_bytes > 10737418240`; nenhum rascunho é criado (per `phase-03-videos/TD-03` revisão 2026-11-23)
- 415 UNSUPPORTED_VIDEO_FORMAT: `content_type` ou extensão de `file_name` fora da allowlist; nenhum rascunho é criado (per `phase-03-videos/TD-11`)

---

#### POST /videos/:id/upload/parts (SI-03.6)

Gera, em lote, URLs PUT pré-assinadas para as partes pedidas (`UploadPartCommand` assinado com o **cliente público**, `expiresIn: 3600`), per `phase-03-videos/TD-03`, `phase-03-videos/TD-02`. Também serve para renovar URLs expiradas.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- part_numbers: integer[], required — de 1 a 100 itens, sem repetição, cada item com `1 ≤ n ≤ part_count` do vídeo

**Response 200:**
- parts: array of `{ part_number: integer, url: string }` — uma entrada por item de `part_numbers`, em ordem ascendente
- expires_in: integer — `3600` (segundos)

**Error responses:**
- 400 VALIDATION_ERROR: corpo fora do schema (array vazio, mais de 100 itens, item não inteiro ou `< 1`)
- 400 INVALID_PART_NUMBER: algum item `> part_count`
- 401 Unauthorized: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: o vídeo não existe ou não pertence ao canal do usuário
- 409 VIDEO_NOT_IN_DRAFT: o vídeo já saiu de `draft` (upload concluído)

---

#### GET /videos/:id/upload/parts (SI-03.6)

Lista as partes que já chegaram ao storage (`ListPartsCommand`), para o cliente retomar um upload interrompido (per `phase-03-videos/TD-03`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- parts: array of `{ part_number: integer, etag: string, size_bytes: integer }` — ordenado por `part_number` ascendente; vazio se nenhuma parte chegou
- part_size: integer
- part_count: integer

**Error responses:**
- 401 Unauthorized: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: o vídeo não existe ou não pertence ao canal do usuário
- 409 VIDEO_NOT_IN_DRAFT: o vídeo já saiu de `draft`

---

#### POST /videos/:id/upload/complete (SI-03.7)

Só aceita vídeo em `draft`. Sequência (per `phase-03-videos/TD-03`, `phase-03-videos/TD-09`, `phase-03-videos/TD-01`):
1. Conclui o multipart (`CompleteMultipartUploadCommand` com as `Parts` ordenadas ascendentemente por `PartNumber`).
2. Confere o tamanho real do objeto com `HeadObjectCommand` (`ContentLength`) contra `size_bytes`. Se divergir (maior **ou** menor): apaga o objeto (`DeleteObjectCommand`), apaga a linha do rascunho e responde 400 `UPLOAD_SIZE_MISMATCH`; **nenhum job é enfileirado**. Isso impede burlar o limite de 10GB declarando um tamanho menor.
3. Só se o tamanho bater: passa o vídeo para `processing` e zera `upload_id` numa atualização condicional (`WHERE status = 'draft'`), e então publica o job `process-video` na fila `videos` (ver `### Events/Messages`).
**Idempotente nos efeitos:** se o vídeo já saiu de `draft` (`processing`, `ready` ou `failed`, por exemplo num `complete` repetido), responde 409 `VIDEO_NOT_IN_DRAFT`, sem chamar o storage, sem alterar o status e sem enfileirar de novo. É o mesmo padrão do abort (per `phase-03-videos/TD-12`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- parts: array, required — de 1 a 10.000 itens, cada um `{ part_number: integer (1–10000), etag: string (não vazio) }`; `part_number` sem repetição. A API reordena por `part_number` antes de enviar ao storage.

**Response 200:**
- id: string (uuid)
- public_id: string
- status: `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: corpo fora do schema
- 400 INVALID_UPLOAD_PARTS: o storage rejeitou a lista de partes (parte ausente, `etag` divergente, número de partes diferente de `part_count`); o vídeo continua em `draft` e o cliente pode retomar
- 400 UPLOAD_SIZE_MISMATCH: o tamanho real do objeto (`HeadObject`) diverge de `size_bytes`; objeto e rascunho são apagados, nenhum job é enfileirado e o cliente precisa recomeçar com `POST /videos`
- 401 Unauthorized: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: o vídeo não existe ou não pertence ao canal do usuário
- 409 VIDEO_NOT_IN_DRAFT: o vídeo já saiu de `draft` (ex.: `complete` repetido); nada é reenfileirado

---

#### DELETE /videos/:id/upload (SI-03.8)

Aborta o upload: `AbortMultipartUploadCommand` descarta as partes já enviadas e a linha do rascunho é apagada (per `phase-03-videos/TD-12`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content.

**Error responses:**
- 401 Unauthorized: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: o vídeo não existe ou não pertence ao canal do usuário
- 409 VIDEO_NOT_IN_DRAFT: o vídeo já saiu de `draft`; o abort não se aplica

---

#### GET /videos/:id (SI-03.12)

Consulta o status e o detalhe do próprio vídeo. Exige login e ser dono do canal (per `phase-03-videos/TD-08` revisão 2026-11-23).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (uuid)
- public_id: string
- status: `"draft"` | `"processing"` | `"ready"` | `"failed"`
- original_filename: string
- content_type: string
- size_bytes: integer
- duration_seconds: number | null
- metadata: `{ width, height, videoCodec, audioCodec?, bitrate, formatName, sizeBytes }` | null
- thumbnail_url: string | null — URL GET pré-assinada pelo cliente público quando `thumbnail_key` existe
- failure_reason: string | null
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: `:id` não é UUID
- 401 Unauthorized: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: o vídeo não existe ou não pertence ao canal do usuário

---

#### GET /videos/:publicId/stream (SI-03.13)

Público (`@Public()`). Autoriza e responde **302** com `Location` = URL GET pré-assinada pelo cliente público para o objeto original (`GetObjectCommand` sem `ResponseContentDisposition`, `ResponseContentType` = `content_type` do vídeo). O storage atende `Range` (206) nativamente, então o player reproduz sem baixar o arquivo inteiro (per `phase-03-videos/TD-08`, `phase-03-videos/TD-02`).

**Request headers:** nenhum obrigatório.

**Response 302:** header `Location: <url pré-assinada>`; sem corpo.

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente **ou** vídeo com status `draft`, `processing` ou `failed` — resposta idêntica, sem revelar que o vídeo existe (per `phase-03-videos/TD-08` revisão 2026-11-23)

---

#### GET /videos/:publicId/download (SI-03.13)

Público (`@Public()`). Igual ao stream, mas a URL pré-assinada leva `ResponseContentDisposition: attachment; filename="{original_filename}"`, o que força o download (per `phase-03-videos/TD-08`).

**Request headers:** nenhum obrigatório.

**Response 302:** header `Location: <url pré-assinada com Content-Disposition attachment>`; sem corpo.

**Error responses:**
- 404 VIDEO_NOT_FOUND: mesma regra do stream

---

#### Validation Rules — Upload de vídeo

- `:id` (rotas do dono): UUID, validado com `ParseUUIDPipe` → 400 `VALIDATION_ERROR`.
- `:publicId` (rotas públicas): string; formato inválido não gera 400 — responde 404 `VIDEO_NOT_FOUND`, como o `publicId` inexistente.
- **Allowlist de formatos** (per `phase-03-videos/TD-11`, primeira camada; valores _sugestão — sem origem normativa_): `content_type` ∈ {`video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`} **e** extensão de `file_name` ∈ {`.mp4`, `.mov`, `.webm`, `.mkv`} (comparação sem diferenciar maiúsculas). A allowlist só barra o erro honesto; a validação real é o `ffprobe` no worker (segunda camada). Arquivo ilegível → `failed`.
- **Tamanho máximo:** `10737418240` bytes (10 × 1024³). Acima disso a API responde 413 `VIDEO_TOO_LARGE` sem criar rascunho.
- **Partes:** `part_size = 67108864`. `part_number` é inteiro de 1 a 10.000 e nunca maior que o `part_count` do vídeo. O lote de URLs aceita até 100 partes por chamada (_sugestão — sem origem normativa_).
- **Expiração das URLs pré-assinadas** (_sugestão — sem origem normativa_): partes de upload `3600`s (per `phase-03-videos/TD-03`); stream, download e thumbnail `3600`s; leitura interna do worker `900`s (padrão do presigner, per `phase-03-videos/TD-06`).

### Authorization Matrix

"Owner" = usuário autenticado cujo `Channel` é o `channel_id` do vídeo. Para não-donos autenticados, as rotas do dono respondem 404 `VIDEO_NOT_FOUND` (não 403), sem revelar que o vídeo existe. Stream e download são públicos, mas só para `status = ready`; nos demais status respondem 404 para qualquer chamador, inclusive o dono (per `phase-03-videos/TD-08` revisão 2026-11-23). Visibilidade (público/unlisted) e publicação ficam para a Fase 04.

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ (401) | ✓ (vira dono do rascunho criado) | — |
| POST /videos/:id/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:id/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:id/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| DELETE /videos/:id/upload | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:id | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:publicId/stream | ✓ só `ready` (senão 404) | ✓ só `ready` (senão 404) | ✓ só `ready` (senão 404) |
| GET /videos/:publicId/download | ✓ só `ready` (senão 404) | ✓ só `ready` (senão 404) | ✓ só `ready` (senão 404) |

### Error Catalog

Formato herdado da Fase 02: `{ statusCode, error, message }`, com `error` = código de domínio (per `phase-02-auth/TD-07`). Novos códigos desta fase, como subclasses de `DomainException`:

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_TOO_LARGE | 413 | `POST /videos` com `size_bytes > 10737418240`; nenhum rascunho é criado |
| UNSUPPORTED_VIDEO_FORMAT | 415 | `POST /videos` com `content_type` ou extensão de `file_name` fora da allowlist; nenhum rascunho é criado |
| VIDEO_NOT_FOUND | 404 | Vídeo inexistente ou de outro canal (rotas do dono); `publicId` inexistente ou vídeo fora de `ready` (stream/download) |
| VIDEO_NOT_IN_DRAFT | 409 | Gerar/listar URLs de parte, concluir (`complete` repetido) ou abortar um vídeo que já saiu de `draft`; no `complete`, nada é reenfileirado |
| INVALID_PART_NUMBER | 400 | `part_numbers` com item maior que o `part_count` do vídeo |
| INVALID_UPLOAD_PARTS | 400 | O storage rejeitou o `CompleteMultipartUpload` (`InvalidPart` / `InvalidPartOrder` / parte ausente); o vídeo continua em `draft` |
| UPLOAD_SIZE_MISMATCH | 400 | No `complete`, o `ContentLength` do `HeadObject` diverge de `size_bytes`; objeto e rascunho são apagados e nenhum job é enfileirado |
| VALIDATION_ERROR | 400 | Herdado — corpo ou parâmetro fora do schema (`ValidationExceptionFilter`) |

Erros do worker não viram resposta HTTP. Arquivo que o `ffprobe` rejeita (sem stream de vídeo, ilegível) → `UnrecoverableError` → `status = failed` + `failure_reason`, sem retry. Falhas transitórias (storage/Redis indisponível, timeout do FFmpeg) → exceção comum → retry pela fila; depois de 3 tentativas → `failed` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`).

### Events/Messages

Fila BullMQ sobre Redis (per `phase-03-videos/TD-01`). A fila é registrada com `BullModule.forRootAsync` (conexão vinda de um namespace `registerAs('queue', ...)`) e `BullModule.registerQueue({ name: 'videos' })`. Todas as filas, workers e `QueueEvents` usam o mesmo `prefix`, lido de `QUEUE_PREFIX`; os testes usam um prefixo único por suíte (per `phase-03-videos/TD-04`, `phase-03-videos/TD-13`).

#### process-video (fila `videos`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoProcessingQueue` (serviço produtor injetado com `@InjectQueue('videos')`), chamado pelo `VideosService` no `POST /videos/:id/upload/complete` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessor` (`@Processor('videos')`, estende `WorkerHost`), que roda **só** no entrypoint do worker (`src/worker.main.ts` + `WorkerModule`, container `video-worker`, per `phase-03-videos/TD-04`). O `AppModule` da API registra a fila só como produtora.
**Trigger:** transição `draft → processing` no `complete` do upload, só depois de o `HeadObject` confirmar que o tamanho real bate com `size_bytes`. Com `UPLOAD_SIZE_MISMATCH` ou `VIDEO_NOT_IN_DRAFT`, nenhum job é publicado.
**Processamento** (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`, `phase-03-videos/TD-11`):
1. Carrega o vídeo. Se não existe ou não está em `processing`, encerra sem erro (no-op idempotente).
2. Gera uma URL GET pré-assinada com o **cliente interno** (`S3_ENDPOINT`, `expiresIn` 900s).
3. Roda `ffprobe` (via `execFile`) sobre a URL e extrai `duration_seconds` + `metadata`. Sem stream de vídeo ou saída ilegível → `UnrecoverableError`.
4. Extrai 1 frame com `ffmpeg` (via `execFile`, seek por HTTP range até ~10% da duração, _sugestão — sem origem normativa_) para um JPEG temporário e envia para `videos/{videoId}/thumbnail.jpg` pelo cliente interno.
5. Em uma única atualização grava `duration_seconds`, `metadata`, `thumbnail_key` e `status = ready`.
**Job options** (per `phase-03-videos/TD-10`): `attempts: 3`, `backoff: { type: 'exponential', delay: <QUEUE_BACKOFF_DELAY_MS> }`, `jobId: videoId` (deduplica reenvio), `removeOnComplete: true`.
**Backoff configurável** (per `phase-03-videos/TD-10`; valor padrão e variável _sugestão — sem origem normativa_): o `delay` base vem de `QUEUE_BACKOFF_DELAY_MS`, lido pelo namespace `registerAs('queue', ...)` e validado no schema Joi de `src/config/env.validation.ts` como as demais chaves (`Joi.number().integer().min(0).default(30000)`). O padrão é `30000` (30s, a base sugerida pela TD-10). Com backoff exponencial (`2^(attemptsMade-1) × delay`), as novas tentativas acontecem cerca de 30s e 60s depois da falha anterior. Os testes de integração e E2E definem um valor curto (ex.: `100`) para não esperar 90s até a falha final. A chave entra no `.env.example` com o padrão `30000`.
**Falha final** (per `phase-03-videos/TD-10`): `@OnWorkerEvent('failed')`. Quando `err instanceof UnrecoverableError` **ou** `job.attemptsMade >= job.opts.attempts`, grava `status = failed` e `failure_reason = err.message`. Falhas intermediárias não mudam o status (continua `processing`).
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`). O processor é idempotente: reprocessar sobrescreve os mesmos campos e a mesma chave de thumbnail.

---

<!-- phase-a-complete -->

## Dependency Map

<!-- Dep Map will be written in Phase B -->

---

## Deliverables

<!-- Deliverables will be written in Phase B -->
