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

### SI-03.1 — Infra: Redis, MinIO, FFmpeg e bibliotecas da fase

**Description:** Sobe a infraestrutura nova da fase no Compose (Redis para a fila, MinIO como object storage), instala FFmpeg/ffprobe na imagem compartilhada por API e worker, e adiciona as dependências npm decididas.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml` o serviço `redis` (`redis:7`, healthcheck `redis-cli ping`) e o serviço `minio` com a imagem `cgr.dev/chainguard/minio:latest@sha256:e9cf6b99c226e9539ed0f14b6f00e37b07da153c7ba1f4f8709c807574b471ec` (pin por digest; `minio/minio` não existe mais), `command: server /data --console-address :9001`, portas `9000`/`9001`, volume nomeado montado em `/data` (sem ele o servidor falha com "Rename across devices not allowed"), `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` iguais a `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` e `MINIO_API_CORS_ALLOW_ORIGIN=*` (fallback de CORS global do servidor), per `phase-03-videos/TD-02` restrições 1, 4 e 5
2. Ligar os serviços ao `nestjs-api` em `depends_on`: `redis` com `condition: service_healthy`; `minio` **sem healthcheck** (a imagem não tem shell nem curl/wget, então um `CMD-SHELL` não roda) e com `condition: service_started`. A prontidão real do storage fica a cargo do boot da aplicação, que tenta de novo o `HeadBucket` até o MinIO responder (ver SI-03.3), per `phase-03-videos/TD-02` restrição 4, `phase-03-videos/TD-01`, `phase-03-videos/TD-13`
3. Alterar `nestjs-project/Dockerfile.dev` para instalar `ffmpeg` via apt na mesma linha do `procps curl` — o binário vem do apt e a imagem é a mesma da API e do worker (per `phase-03-videos/TD-05`, `phase-03-videos/TD-13`, `phase-03-videos/TD-04`)
4. Instalar `bullmq@^6.7.8`, `@nestjs/bullmq@^11.0.5`, `@aws-sdk/client-s3@^3.1173.0`, `@aws-sdk/s3-request-presigner@^3.1173.0` e `ioredis@^5` em `nestjs-project/package.json` — o `ioredis` é instalado explicitamente porque no `bullmq@6.7.8` ele passou a ser peer opcional (`>=5.0.0`) e não vem mais como dependência transitiva; sem ele, `new Queue({ connection: { host, port } })` falha com "BullMQ could not load the optional 'ioredis' package", per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`
5. Adicionar a `nestjs-project/.env.example` as chaves `REDIS_HOST=redis`, `REDIS_PORT=6379`, `QUEUE_PREFIX=streamtube`, `QUEUE_BACKOFF_DELAY_MS=30000`, `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_REGION=us-east-1`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET=streamtube`, `S3_FORCE_PATH_STYLE=true` — hosts internos usam o nome do serviço do Compose (regra de Docker Networking do CLAUDE.md), per `phase-03-videos/TD-02`. Na mesma edição, pôr o valor de `MAIL_FROM` entre aspas simples (`MAIL_FROM='"StreamTube" <noreply@streamtube.com>'`), porque o Docker Compose v5 rejeita o valor atual sem aspas externas

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up` sobe `redis` com healthcheck `healthy` e `minio` em estado `running` antes de o `nestjs-api` iniciar
- O container `minio` usa a imagem fixada pelo digest `sha256:e9cf6b99c226e9539ed0f14b6f00e37b07da153c7ba1f4f8709c807574b471ec`, e `GET http://minio:9000/minio/health/live` a partir do `nestjs-api` retorna `200`
- Recriar o container `minio` (`docker compose up -d --force-recreate minio`) preserva os objetos do bucket (volume nomeado em `/data`)
- `docker compose config` interpreta o `.env.example` sem erro, e `MAIL_FROM` resolve para `"StreamTube" <noreply@streamtube.com>`
- `ffprobe -version` e `ffmpeg -version` executam com sucesso dentro do container `nestjs-api`
- `npm ls bullmq @nestjs/bullmq @aws-sdk/client-s3 @aws-sdk/s3-request-presigner ioredis` lista as cinco dependências sem erro de peer
- O console do MinIO responde em `http://localhost:9001` a partir do host

---

### SI-03.2 — Configuração de storage e fila (namespaces + schema Joi)

**Description:** Cria os namespaces de configuração `storage` e `queue` e valida as chaves novas no schema Joi, seguindo a convenção `registerAs` herdada da Fase 01.

**Technical actions:**

1. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` expondo `endpoint` (`S3_ENDPOINT`), `publicEndpoint` (`S3_PUBLIC_ENDPOINT`), `region`, `accessKeyId`, `secretAccessKey`, `bucket`, `forcePathStyle` (boolean a partir de `S3_FORCE_PATH_STYLE`), per `phase-03-videos/TD-02`, `phase-01-configuracao-base/TD-03`
2. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` expondo `host` (`REDIS_HOST`), `port` (`REDIS_PORT`), `prefix` (`QUEUE_PREFIX`), `backoffDelayMs` (`QUEUE_BACKOFF_DELAY_MS`), per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`, `phase-03-videos/TD-10`
3. Estender `envValidationSchema` em `src/config/env.validation.ts` com `S3_ENDPOINT` (uri, required), `S3_PUBLIC_ENDPOINT` (uri, required), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY_ID` (required), `S3_SECRET_ACCESS_KEY` (required), `S3_BUCKET` (required), `S3_FORCE_PATH_STYLE` (`'true'|'false'`, default `'true'`), `REDIS_HOST` (default `redis`), `REDIS_PORT` (port, default `6379`), `QUEUE_PREFIX` (default `streamtube`), `QUEUE_BACKOFF_DELAY_MS` (`Joi.number().integer().min(0).default(30000)`), per `phase-01-configuracao-base/TD-02`
4. Registrar `storageConfig` e `queueConfig` no `load` de `ConfigModule.forRoot` em `src/app.module.ts`, e preencher as chaves de teste (incluindo `QUEUE_BACKOFF_DELAY_MS=100`) no `.env` usado pelos testes

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: chaves S3 obrigatórias ausentes falham; defaults de `REDIS_*`, `QUEUE_*` e `S3_FORCE_PATH_STYLE` aplicados; `QUEUE_BACKOFF_DELAY_MS` negativo rejeitado | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1 — chaves de env e serviços do Compose precisam existir

**Acceptance criteria:**

- Iniciar a API sem `S3_BUCKET` aborta o boot com erro de validação nomeando a chave
- Iniciar a API sem `REDIS_HOST`, `QUEUE_PREFIX` e `QUEUE_BACKOFF_DELAY_MS` resolve `redis`, `streamtube` e `30000` respectivamente
- `QUEUE_BACKOFF_DELAY_MS=-1` aborta o boot com erro de validação
- `S3_FORCE_PATH_STYLE=true` é exposto como boolean `true` no namespace `storage`

---

### SI-03.3 — StorageModule: clientes S3 interno e público

**Description:** Encapsula todo acesso ao object storage num `StorageService` com dois clientes S3 — o interno (tráfego real em `minio:9000`) e o público (só assina URLs entregues a consumidores HTTP) — e garante o bucket privado no boot, tentando configurar o CORS por bucket sem depender dele no MinIO.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` — providers `S3_INTERNAL_CLIENT` (`endpoint = storage.endpoint`) e `S3_PUBLIC_CLIENT` (`endpoint = storage.publicEndpoint`), ambos `new S3Client({ endpoint, region, credentials, forcePathStyle })` via `useFactory` com `inject: [storageConfig.KEY]`; exporta `StorageService` (per `phase-03-videos/TD-02`)
2. Criar `src/storage/storage.service.ts` com as operações multipart sobre o cliente interno: `createMultipartUpload(key, contentType)`, `listParts(key, uploadId)`, `completeMultipartUpload(key, uploadId, parts)` (ordena `Parts` por `PartNumber` e mapeia `InvalidPart` / `InvalidPartOrder` / `NoSuchUpload` para a exceção de storage própria `StorageInvalidPartsError`, que o domínio de vídeos traduz para `INVALID_UPLOAD_PARTS`), `abortMultipartUpload(key, uploadId)`, `headObjectSize(key)`, `deleteObject(key)`, `putObject(key, body, contentType)` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-12`)
3. Adicionar ao `StorageService` a assinatura de URLs com `getSignedUrl`: `presignUploadPart(key, uploadId, partNumber, 3600)` e `presignGet(key, { expiresIn, contentType?, contentDisposition? })` no **cliente público**, e `presignInternalGet(key, 900)` no **cliente interno** (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`, `phase-03-videos/TD-08`)
4. Implementar `ensureBucket()` em `onModuleInit`: `HeadBucket` com nova tentativa enquanto o storage não responde (erro de conexão, até ~30s com intervalo fixo, depois falha o boot com mensagem clara), porque o `minio` não tem healthcheck no Compose; `CreateBucket` se ausente (bucket privado, sem policy pública); depois `PutBucketCors` com `ExposeHeaders: ['ETag']` e métodos `GET` e `PUT`. Se o `PutBucketCors` falhar com `NotImplemented`, registra `Logger.warn` e o boot segue: no MinIO o CORS vem do `MINIO_API_CORS_ALLOW_ORIGIN` do Compose (SI-03.1), e o `PutBucketCors` só tem efeito no S3 de produção. Qualquer outro erro do `PutBucketCors` (ex.: `AccessDenied`) derruba o boot (per `phase-03-videos/TD-02` restrições 4 e 5 e item "a verificar")
5. Criar o helper de teste `src/test/presigned-http.ts` — `requestPresigned(url, { method, headers?, body? })` com `node:http`: conecta no host/porta de `S3_ENDPOINT` (`minio:9000`), envia o path + query da URL pré-assinada sem alteração e mantém o header `Host` original da URL (`localhost:9000`). Isso é necessário porque, dentro do container de testes, `localhost:9000` aponta para o próprio container (regra de Docker Networking do CLAUDE.md), e a assinatura SigV4 inclui o `Host`, então trocar o host na URL invalidaria a assinatura. Todo teste que acessa URL do **cliente público** (PUT de partes, stream, download, thumbnail) usa este helper, como o `src/test/mailpit.ts` é usado para o e-mail (per `phase-03-videos/TD-02`, `phase-03-videos/TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real do Compose): create → upload de 2 partes via URL pré-assinada → listParts → complete → headObjectSize; abort descarta partes; complete com ETag inválido lança `StorageInvalidPartsError`; URL do cliente público carrega o host de `S3_PUBLIC_ENDPOINT`; os `PUT` de partes passam por `requestPresigned` | `src/storage/storage.service.integration-spec.ts` |
| `StorageService.ensureBucket` | Unit: `HeadBucket` com erro de conexão tenta de novo e passa quando o storage responde; esgotar o prazo falha com erro claro; `PutBucketCors` com `NotImplemented` → `warn` sem lançar; `PutBucketCors` com `AccessDenied` → lança (mock `S3Client.send`) | `src/storage/storage.service.spec.ts` |
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2 — namespace `storage` precisa existir

**Acceptance criteria:**

- Após o boot da aplicação, o bucket `S3_BUCKET` existe no MinIO e não aceita `GET` anônimo (403)
- O boot da aplicação contra o MinIO conclui com sucesso mesmo com o `PutBucketCors` respondendo `NotImplemented`, e o log registra um aviso nomeando o fallback `MINIO_API_CORS_ALLOW_ORIGIN`
- O boot com o `minio` ainda iniciando espera o storage responder e conclui sem erro
- Uma parte enviada por `PUT` HTTP direto (sem browser) à URL pré-assinada do cliente público, por `minio:9000` com o header `Host` original preservado, retorna `200` com o header `ETag` na resposta
- `completeMultipartUpload` com partes fora de ordem produz o objeto final (a ordenação é feita pelo serviço)
- `completeMultipartUpload` com `ETag` divergente lança `StorageInvalidPartsError`, e o upload continua retomável por `listParts`
- `abortMultipartUpload` faz `listParts` subsequente falhar com `NoSuchUpload`
- URLs geradas por `presignInternalGet` apontam para o host de `S3_ENDPOINT`; as de `presignGet` / `presignUploadPart`, para o host de `S3_PUBLIC_ENDPOINT`

---

### SI-03.4 — Entidade Video + migration + gerador de public_id

**Description:** Cria o modelo persistente do vídeo (tabela `videos`, enum `video_status`) e o gerador do ID público curto e não enumerável que garante URL única por vídeo.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — entidade `Video` com as colunas de `### Data Model → Video` (snake_case via `name:`), `status` como enum `video_status` default `draft`, `size_bytes` `bigint` (transformer para `number`), `metadata` `jsonb`, relação `ManyToOne` → `Channel` por `channel_id`, `@Index({ unique: true })` em `public_id` e `@Index()` em `channel_id` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-05`, `phase-03-videos/TD-07`)
2. Criar migration `src/database/migrations/{timestamp}-CreateVideos.ts` — cria o enum `video_status`, a tabela `videos`, o índice único em `public_id`, o índice em `channel_id` e a FK para `channels(id)`; `down` remove na ordem inversa (`synchronize: false` herdado da Fase 01)
3. Criar `src/videos/public-id.util.ts` — `generatePublicId()` com `randomBytes(8).toString('base64url')` de `node:crypto` (11 caracteres), per `phase-03-videos/TD-07`
4. Estender `cleanAllTables` em `src/test/create-test-data-source.ts` com `DELETE FROM "videos"` antes de `"channels"` (ordem de FK)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `status = draft`; UNIQUE em `public_id` rejeita duplicata; FK rejeita `channel_id` inexistente; enum rejeita status fora de `draft/processing/ready/failed`; `size_bytes` de 10737418240 persiste sem perda | `src/videos/entities/video.entity.integration-spec.ts` |
| `CreateVideos` migration | Integration: `up` cria tabela/enum/índices e `down` reverte | `src/database/migrations.integration-spec.ts` |
| `generatePublicId` | Unit: 11 caracteres no alfabeto base64url; 10.000 chamadas sem colisão | `src/videos/public-id.util.spec.ts` |

**Dependencies:** none _(depende apenas das entidades da Fase 02)_

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos`, o enum `video_status` e os índices; `npm run migration:revert` remove todos
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade
- Inserir um vídeo com `channel_id` inexistente falha com violação de FK
- Um vídeo inserido sem `status` explícito é lido com `status = draft`
- `size_bytes = 10737418240` é lido de volta com o mesmo valor numérico

---

### SI-03.5 — Endpoint POST /videos (início do upload + pré-cadastro em rascunho)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-initiate-upload.plan.md`
**Authorization:** Authenticated (vira dono do rascunho criado) — per `### Authorization Matrix`

**Description:** Inicia o upload: valida o arquivo declarado, cria o rascunho (`status = draft`) no canal do usuário e abre o S3 Multipart Upload, sem que a API receba nenhum byte do vídeo.

**Technical actions:**

1. Criar `src/videos/video.exceptions.ts` — subclasses de `DomainException` para todos os códigos de `### Error Catalog` da fase: `VideoTooLargeException` (413 `VIDEO_TOO_LARGE`), `UnsupportedVideoFormatException` (415 `UNSUPPORTED_VIDEO_FORMAT`), `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`), `VideoNotInDraftException` (409 `VIDEO_NOT_IN_DRAFT`), `InvalidPartNumberException` (400 `INVALID_PART_NUMBER`), `InvalidUploadPartsException` (400 `INVALID_UPLOAD_PARTS`), `UploadSizeMismatchException` (400 `UPLOAD_SIZE_MISMATCH`), per `phase-02-auth/TD-07`
2. Adicionar `ChannelsService.findByUserId(userId)` em `src/channels/channels.service.ts` — a busca do canal do dono pertence ao domínio de canais (Single Responsibility)
3. Criar `src/videos/videos.service.ts` com `initiateUpload(userId, dto)` — checa `size_bytes > 10737418240` → `VideoTooLargeException` e allowlist de `content_type` + extensão de `file_name` (case-insensitive) → `UnsupportedVideoFormatException` **antes** de qualquer escrita; gera `id` (`randomUUID`) e `public_id` (`generatePublicId`, nova tentativa em violação de UNIQUE); chama `StorageService.createMultipartUpload('videos/{id}/original', content_type)`; persiste `Video` com `upload_id`, `part_size = 67108864`, `part_count = ceil(size_bytes / part_size)` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-07`, `phase-03-videos/TD-11`)
4. Criar `src/videos/dto/initiate-upload.dto.ts` (`file_name` 1–255, `content_type`, `size_bytes` inteiro ≥ 1) e `src/videos/videos.controller.ts` com `POST /videos` (201) usando `@CurrentUser()`, mais `@ApiOperation`, `@ApiBody`, `@ApiResponse` para 201/400/401/413/415 com `ApiErrorEnvelope` (per `phase-02-auth/TD-06`, `openapi-docs-nestjs/TD-01`)
5. Criar `src/videos/videos.module.ts` (`TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`) e registrá-lo em `src/app.module.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: ramos 413 e 415 não tocam repo nem storage; allowlist case-insensitive; cálculo de `part_count`; colisão de `public_id` gera nova tentativa (mock repo + mock `StorageService`) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (Postgres + MinIO reais): rascunho persistido com `upload_id` válido no storage e `storage_key = videos/{id}/original` | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 — `StorageService` para abrir o multipart; SI-03.4 — entidade `Video` e `generatePublicId`

**Acceptance criteria:**

- `POST /videos` com `{ file_name: "clip.mp4", content_type: "video/mp4", size_bytes: 134217728 }` autenticado retorna `201` com `id`, `public_id` de 11 caracteres, `status: "draft"`, `part_size: 67108864`, `part_count: 2`
- `POST /videos` com `size_bytes: 10737418241` retorna `413` com `error: "VIDEO_TOO_LARGE"` e nenhuma linha é criada em `videos`
- `POST /videos` com `content_type: "image/png"` ou `file_name: "clip.avi"` retorna `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"` e nenhuma linha é criada em `videos`
- `POST /videos` com `file_name: "CLIP.MOV"` e `content_type: "video/quicktime"` retorna `201`
- `POST /videos` sem `size_bytes` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem token retorna `401`
- O rascunho criado pertence ao canal do usuário autenticado e tem um multipart aberto no storage na chave `videos/{id}/original`

---

### SI-03.6 — Endpoints de partes do upload (gerar URLs + listar para retomar)

**Route:** POST /videos/:id/upload/parts · GET /videos/:id/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner (não-dono autenticado → 404) — per `### Authorization Matrix`

**Description:** Entrega ao dono, em lote, as URLs PUT pré-assinadas das partes (também usadas para renovar URLs expiradas) e lista as partes já recebidas pelo storage para retomar um upload interrompido.

**Technical actions:**

1. Adicionar `VideosService.findOwnedDraft(userId, id)` — carrega o vídeo pelo `id` restrito ao canal do usuário (`ChannelsService.findByUserId`); inexistente ou de outro canal → `VideoNotFoundException`; `status ≠ draft` → `VideoNotInDraftException`. Reutilizado por `complete` e `abort`
2. Adicionar `VideosService.presignParts(userId, id, partNumbers)` — item `> part_count` → `InvalidPartNumberException`; para cada número em ordem ascendente, `StorageService.presignUploadPart(storage_key, upload_id, n, 3600)`; retorna `{ parts, expires_in: 3600 }` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-02`)
3. Adicionar `VideosService.listUploadedParts(userId, id)` — `StorageService.listParts` mapeado para `{ part_number, etag, size_bytes }` ordenado, mais `part_size` e `part_count` (per `phase-03-videos/TD-03`)
4. Criar `src/videos/dto/presign-parts.dto.ts` (`part_numbers`: `@ArrayMinSize(1)`, `@ArrayMaxSize(100)`, `@ArrayUnique()`, `@IsInt({ each: true })`, `@Min(1, { each: true })`) e as rotas `POST /videos/:id/upload/parts` (200) e `GET /videos/:id/upload/parts` (200) em `VideosController` com `ParseUUIDPipe` em `:id` e decoradores OpenAPI (`@ApiParam`, `@ApiResponse` 200/400/401/404/409), per `openapi-docs-nestjs/TD-01`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnedDraft` / `presignParts` | Unit: vídeo de outro canal → `VideoNotFoundException`; status `processing` → `VideoNotInDraftException`; item `> part_count` → `InvalidPartNumberException`; saída ordenada ascendente (mock repo + mock `StorageService`) | `src/videos/videos.service.spec.ts` |
| `VideosService.listUploadedParts` | Integration (Postgres + MinIO reais): após enviar a parte 1 por PUT à URL pré-assinada via `requestPresigned` (`src/test/presigned-http.ts`), a listagem retorna só `part_number: 1` com `etag` e `size_bytes` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — rascunho, `VideosModule` e `VideosController` precisam existir; SI-03.3 — helper `requestPresigned` para os `PUT` de partes nos testes

**Acceptance criteria:**

- `POST /videos/:id/upload/parts` do dono com `{ part_numbers: [2, 1] }` retorna `200` com `parts` em ordem `[1, 2]`, cada uma com `url` apontando para o host de `S3_PUBLIC_ENDPOINT`, e `expires_in: 3600`
- Um `PUT` de 64MiB na `url` retornada, enviado a `minio:9000` com o header `Host` original preservado, é aceito pelo storage e devolve `ETag`
- `POST /videos/:id/upload/parts` com `part_numbers` contendo `part_count + 1` retorna `400` com `error: "INVALID_PART_NUMBER"`
- `POST /videos/:id/upload/parts` com `part_numbers: []` ou 101 itens retorna `400` com `error: "VALIDATION_ERROR"`
- `GET /videos/:id/upload/parts` após enviar só a parte 1 retorna `200` com `parts: [{ part_number: 1, etag, size_bytes }]`, `part_size` e `part_count`
- Ambas as rotas chamadas por outro usuário autenticado retornam `404` com `error: "VIDEO_NOT_FOUND"`
- Ambas as rotas para um vídeo em `processing` retornam `409` com `error: "VIDEO_NOT_IN_DRAFT"`
- `:id` que não é UUID retorna `400` com `error: "VALIDATION_ERROR"`

---

### SI-03.7 — Endpoint POST /videos/:id/upload/complete + produtor da fila

**Route:** POST /videos/:id/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner (não-dono autenticado → 404) — per `### Authorization Matrix`

**Description:** Conclui o multipart, confere o tamanho real do objeto contra o declarado, passa o vídeo para `processing` e publica o job `process-video` — o gatilho do processamento automático.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (q) => ({ connection: { host: q.host, port: q.port }, prefix: q.prefix }) })` + `BullModule.registerQueue({ name: 'videos' })`, exportando `BullModule`; importado pelo `VideosModule` (produtor) e, no SI-03.10, pelo `WorkerModule` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`)
2. Criar `src/videos/video-processing.queue.ts` — `VideoProcessingQueue` com `@InjectQueue('videos')` + `@Inject(queueConfig.KEY)` e `enqueue(videoId)` → `queue.add('process-video', { videoId }, { attempts: 3, backoff: { type: 'exponential', delay: queueConfig.backoffDelayMs }, jobId: videoId, removeOnComplete: true })` (per `phase-03-videos/TD-10`, `### Events/Messages → process-video`)
3. Adicionar `VideosService.completeUpload(userId, id, parts)` — `findOwnedDraft` → `StorageService.completeMultipartUpload` (`StorageInvalidPartsError` → `InvalidUploadPartsException`, vídeo continua `draft`) → `headObjectSize` ≠ `size_bytes` → `deleteObject` + remove a linha + `UploadSizeMismatchException` sem enfileirar → `UPDATE ... SET status = 'processing', upload_id = NULL WHERE id = :id AND status = 'draft'` (0 linhas afetadas → `VideoNotInDraftException`) → `VideoProcessingQueue.enqueue(id)` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-09`)
4. Criar `src/videos/dto/complete-upload.dto.ts` (`parts`: 1–10.000 itens `{ part_number: int 1–10000, etag: string não vazio }` com `@ValidateNested`, `part_number` sem repetição) e a rota `POST /videos/:id/upload/complete` (200, `{ id, public_id, status: "processing" }`) em `VideosController`, com decoradores OpenAPI para 200/400/401/404/409
5. Registrar `QueueModule` e `VideoProcessingQueue` em `src/videos/videos.module.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: `StorageInvalidPartsError` → `INVALID_UPLOAD_PARTS` sem alterar status; tamanho divergente (maior e menor) apaga objeto + linha e não enfileira; update condicional com 0 linhas → `VIDEO_NOT_IN_DRAFT` sem enfileirar (mock repo, `StorageService`, `VideoProcessingQueue`) | `src/videos/videos.service.spec.ts` |
| `VideoProcessingQueue` | Integration (Redis real, `prefix` único por suíte): job `process-video` criado com `jobId = videoId`, `attempts: 3`, backoff exponencial; segundo `enqueue` do mesmo id não duplica | `src/videos/video-processing.queue.integration-spec.ts` |
| `VideosService.completeUpload` | Integration (Postgres + MinIO + Redis reais): upload real de 1 parte (PUT via `requestPresigned`) → complete → vídeo `processing`, `upload_id = null` e job na fila | `src/videos/videos.service.integration-spec.ts` |
| `QueueModule` | Unit: compilation test | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.6 — `findOwnedDraft` e as partes enviadas por URL pré-assinada

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` do dono com as `parts` (`part_number` + `etag`) de todas as partes enviadas retorna `200` com `status: "processing"`, e o vídeo fica com `status = processing` e `upload_id = null` no banco
- Após um `complete` bem-sucedido, a fila `videos` contém um job `process-video` com payload `{ "videoId": "<id>" }`
- Repetir o `complete` retorna `409` com `error: "VIDEO_NOT_IN_DRAFT"` e a fila continua com um único job para o vídeo
- `complete` com um `etag` errado retorna `400` com `error: "INVALID_UPLOAD_PARTS"`; o vídeo continua `draft` e `GET /videos/:id/upload/parts` ainda lista as partes
- `complete` de um objeto cujo tamanho real difere de `size_bytes` retorna `400` com `error: "UPLOAD_SIZE_MISMATCH"`; a linha do vídeo e o objeto deixam de existir e nenhum job é publicado
- `complete` com `parts` contendo `part_number` repetido retorna `400` com `error: "VALIDATION_ERROR"`
- `complete` por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.8 — Endpoint DELETE /videos/:id/upload (abort do rascunho)

**Route:** DELETE /videos/:id/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-abort.plan.md`
**Authorization:** Owner (não-dono autenticado → 404) — per `### Authorization Matrix`

**Description:** Fecha o caminho de desistência explícita: descarta as partes já enviadas no storage e remove a linha do rascunho, sem criar estado novo no enum de status.

**Technical actions:**

1. Adicionar `VideosService.abortUpload(userId, id)` — `findOwnedDraft` → `StorageService.abortMultipartUpload(storage_key, upload_id)` → remove a linha do vídeo (per `phase-03-videos/TD-12`)
2. Tolerar `NoSuchUpload` no abort (multipart já expirado/abortado no storage) e remover a linha mesmo assim — o efeito final é idempotente (per `phase-03-videos/TD-12`)
3. Adicionar a rota `DELETE /videos/:id/upload` (204) em `VideosController` com `ParseUUIDPipe` e decoradores OpenAPI para 204/401/404/409 (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.abortUpload` | Unit: `NoSuchUpload` do storage não impede remover a linha; status `processing` → `VIDEO_NOT_IN_DRAFT` sem chamar o storage (mock repo + mock `StorageService`) | `src/videos/videos.service.spec.ts` |
| `VideosService.abortUpload` | Integration (Postgres + MinIO reais): após enviar 1 parte (PUT via `requestPresigned`) e abortar, a linha some e `listParts` do `upload_id` falha com `NoSuchUpload` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 — `findOwnedDraft`

**Acceptance criteria:**

- `DELETE /videos/:id/upload` do dono para um rascunho retorna `204` e a linha deixa de existir em `videos`
- Após o abort, as partes já enviadas não existem mais no storage para aquele `upload_id`
- `DELETE /videos/:id/upload` para um vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_IN_DRAFT"` e o vídeo não é alterado
- `DELETE /videos/:id/upload` repetido após um abort bem-sucedido retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `DELETE /videos/:id/upload` por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.9 — MediaModule: wrapper fino de ffprobe/ffmpeg

**Description:** Módulo próprio de duas funções sobre `execFile` — sondar metadados e extrair um frame — que o worker usa sem depender de wrapper de terceiros.

**Technical actions:**

1. Criar `src/media/media.service.ts` com `probe(url)` — `execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url], { timeout })`; extrai `durationSeconds` + `{ width, height, videoCodec, audioCodec?, bitrate, formatName, sizeBytes }` (per `phase-03-videos/TD-05` revisão 2026-11-23, `phase-03-videos/TD-06`)
2. Fazer `probe` lançar `InvalidMediaError` quando a saída não tem stream de vídeo, não é JSON legível ou o `ffprobe` sai com código ≠ 0 por arquivo inválido; timeout e falha de rede lançam erro comum (transitório) — essa distinção alimenta `UnrecoverableError` vs retry no SI-03.11 (per `phase-03-videos/TD-11`, `phase-03-videos/TD-10`)
3. Adicionar `extractFrame(url, atSeconds, outputPath)` — `execFile('ffmpeg', ['-ss', String(atSeconds), '-i', url, '-frames:v', '1', '-q:v', '2', '-y', outputPath])` com seek antes do `-i` (leitura por HTTP range, sem baixar o arquivo inteiro), per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`
4. Criar `src/media/media.module.ts` exportando `MediaService`, e um helper de teste `src/test/media-fixtures.ts` que gera vídeos curtos com `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240` (+ `sine` para áudio) em diretório temporário — nenhum binário de vídeo é commitado (per `phase-03-videos/TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaService` | Integration (FFmpeg real do `Dockerfile.dev`, arquivo servido por URL pré-assinada do MinIO): `probe` de MP4 gerado retorna duração ≈ 3s, `320x240`, `videoCodec: "h264"`; arquivo de texto renomeado `.mp4` lança `InvalidMediaError`; vídeo sem áudio retorna `audioCodec` ausente; `extractFrame` gera JPEG não vazio | `src/media/media.service.integration-spec.ts` |
| `MediaModule` | Unit: compilation test | `src/media/media.module.spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg instalado na imagem; SI-03.3 — URLs pré-assinadas internas para o teste por HTTP

**Acceptance criteria:**

- `probe` sobre a URL de um MP4 de 3s `320x240` com áudio retorna `durationSeconds` entre 2.9 e 3.1, `width: 320`, `height: 240`, `videoCodec`, `audioCodec`, `bitrate`, `formatName` e `sizeBytes` preenchidos
- `probe` sobre um objeto que não é vídeo lança `InvalidMediaError`
- `probe` sobre um vídeo sem trilha de áudio retorna metadados sem `audioCodec`
- `extractFrame` grava em `outputPath` um JPEG válido (assinatura `FF D8`) a partir de uma URL HTTP
- Um `ffprobe` que excede o timeout lança um erro que **não** é `InvalidMediaError`

---

### SI-03.10 — Video Worker: processor, WorkerModule e entrypoint próprio

**Description:** Implementa o consumidor da fila `videos` — extrai duração/metadados, gera o thumbnail e marca o vídeo como `ready` — rodando num segundo entrypoint da mesma aplicação, em container próprio.

**Technical actions:**

1. Criar `src/worker/video.processor.ts` — `@Processor('videos')` estendendo `WorkerHost`; `process(job)`: carrega o vídeo por `job.data.videoId` (inexistente ou fora de `processing` → retorna sem erro); `StorageService.presignInternalGet(storage_key, 900)`; `MediaService.probe(url)` (`InvalidMediaError` → `throw new UnrecoverableError(message)`) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`, `phase-03-videos/TD-11`)
2. Continuar o `process`: `MediaService.extractFrame(url, ~10% da duração, tmp.jpg)` → `StorageService.putObject('videos/{id}/thumbnail.jpg', ..., 'image/jpeg')` → uma única atualização gravando `duration_seconds`, `metadata`, `thumbnail_key` e `status = ready`; remove o JPEG temporário em `finally`. Reprocessar sobrescreve os mesmos campos (at-least-once, idempotente), per `phase-03-videos/TD-05`, `### Events/Messages → process-video`
3. Criar `src/worker/worker.module.ts` — `ConfigModule.forRoot` (mesmo `load`/`validationSchema` da API), `TypeOrmModule.forRootAsync` + `forFeature([Video])`, `QueueModule`, `StorageModule`, `MediaModule` e `VideoProcessor`; o `AppModule` da API **não** registra o processor (per `phase-03-videos/TD-04`)
4. Criar `src/worker.main.ts` (`NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`) e os scripts `start:worker` (`node dist/worker.main`) e `start:worker:dev` (`nest start --watch --entryFile worker.main`) em `package.json`
5. Adicionar ao `compose.yaml` o serviço `video-worker` — mesmo `build`/`Dockerfile.dev` e volume do `nestjs-api`, `command: npm run start:worker:dev`, `depends_on` `db` e `redis` (`service_healthy`) e `minio` (`service_started`, pela mesma razão do SI-03.1; o `StorageModule` espera o storage no boot) — o container separado do diagrama (per `phase-03-videos/TD-04`, `phase-03-videos/TD-02` restrição 4)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor.process` | Unit: vídeo ausente ou fora de `processing` → no-op sem chamar storage/media; `InvalidMediaError` vira `UnrecoverableError`; erro transitório é relançado como está (mock repo, `StorageService`, `MediaService`) | `src/worker/video.processor.spec.ts` |
| `VideoProcessor.process` | Integration (Postgres + MinIO + FFmpeg reais, processor instanciado no processo do teste): vídeo `processing` com MP4 gerado no storage termina `ready` com `duration_seconds`, `metadata` e `thumbnail.jpg` existente no bucket | `src/worker/video.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilation test | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.7 — `QueueModule` e o job `process-video`; SI-03.9 — `MediaService`

**Acceptance criteria:**

- Processar um job de um vídeo `processing` cujo objeto é um MP4 válido deixa o vídeo com `status = ready`, `duration_seconds` preenchida, `metadata` com `width`, `height`, `videoCodec`, `bitrate`, `formatName`, `sizeBytes` e `thumbnail_key = videos/{id}/thumbnail.jpg`
- Após o processamento, o objeto `videos/{id}/thumbnail.jpg` existe no bucket com `Content-Type: image/jpeg`
- Processar um job de um vídeo que não está em `processing` (ou não existe) termina sem erro e sem alterar o banco
- Processar o mesmo job duas vezes deixa o vídeo `ready` com os mesmos valores e um único objeto de thumbnail
- `docker compose up` sobe o container `video-worker`, e um vídeo concluído pela API chega a `ready` sem intervenção manual
- O container `nestjs-api` não consome jobs da fila `videos` (só publica)

---

### SI-03.11 — Handler de falha final do processamento (retry + `failed`)

**Description:** Fecha o ciclo de status: falha irrecuperável ou tentativas esgotadas marcam o vídeo como `failed` com o motivo, enquanto falhas intermediárias seguem no retry nativo da fila.

**Technical actions:**

1. Adicionar `@OnWorkerEvent('failed') onFailed(job, err)` em `src/worker/video.processor.ts` — grava `status = failed` e `failure_reason = err.message` **somente** quando `err instanceof UnrecoverableError` ou `job.attemptsMade >= job.opts.attempts`; nos demais casos não altera o vídeo (continua `processing`), per `phase-03-videos/TD-10`, `phase-03-videos/TD-09`
2. Restringir a atualização a `WHERE id = :id AND status = 'processing'`, para que um evento de falha tardio nunca sobrescreva um vídeo já `ready`
3. Registrar log estruturado (`Logger`) de cada falha com `videoId`, `attemptsMade` e se foi final

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor.onFailed` | Unit: `UnrecoverableError` na 1ª tentativa → `failed`; erro comum com `attemptsMade < attempts` → sem alteração; erro comum com `attemptsMade = attempts` → `failed` (mock repo) | `src/worker/video.processor.spec.ts` |
| `VideoProcessor` + fila | Integration (Redis + Postgres + MinIO reais, `Worker` do processor no processo do teste, `QUEUE_BACKOFF_DELAY_MS=100`, aguardando com `job.waitUntilFinished(queueEvents)`): objeto inválido → `failed` após 1 tentativa; storage com objeto ausente → 3 tentativas e depois `failed` | `src/worker/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.10 — `VideoProcessor` precisa existir

**Acceptance criteria:**

- Um vídeo cujo objeto não é um vídeo legível termina com `status = failed` e `failure_reason` preenchido após **uma** única tentativa (`attemptsMade = 1`)
- Um vídeo cujo processamento falha de forma transitória em todas as tentativas termina com `status = failed` após exatamente 3 tentativas
- Entre tentativas intermediárias, o vídeo continua com `status = processing` e `failure_reason = null`
- Um evento de falha recebido para um vídeo já `ready` não altera o status

---

### SI-03.12 — Endpoint GET /videos/:id (status e detalhe do próprio vídeo)

**Route:** GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-get-owned.plan.md`
**Authorization:** Owner (não-dono autenticado → 404) — per `### Authorization Matrix`

**Description:** Permite ao dono acompanhar o ciclo `draft → processing → ready | failed` e ler os metadados extraídos e o thumbnail do próprio vídeo.

**Technical actions:**

1. Adicionar `VideosService.findOwned(userId, id)` — vídeo restrito ao canal do usuário, em qualquer status; inexistente ou de outro canal → `VideoNotFoundException` (per `phase-03-videos/TD-08` revisão 2026-11-23)
2. Criar `src/videos/dto/video-response.dto.ts` — mapeia a entidade para o shape de `### API Contracts → GET /videos/:id` (snake_case; `metadata` com as chaves internas literais; `thumbnail_url` via `StorageService.presignGet(thumbnail_key, { expiresIn: 3600 })` quando `thumbnail_key` existe, senão `null`), per `phase-03-videos/TD-02`
3. Adicionar a rota `GET /videos/:id` (200) em `VideosController` com `ParseUUIDPipe` e decoradores OpenAPI (`@ApiOkResponse` com `VideoResponseDto`, 400/401/404 com `ApiErrorEnvelope`), per `openapi-docs-nestjs/TD-01`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwned` | Integration (Postgres real): retorna vídeo do próprio canal em qualquer status; vídeo de outro canal → `VideoNotFoundException` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — `VideosController` e rascunho; SI-03.10 — vídeos `ready` com metadados e thumbnail para o caso completo

**Acceptance criteria:**

- `GET /videos/:id` do dono para um rascunho retorna `200` com `status: "draft"`, `duration_seconds: null`, `metadata: null`, `thumbnail_url: null`
- `GET /videos/:id` do dono para um vídeo `ready` retorna `200` com `duration_seconds` numérico, `metadata` com `width`, `height`, `videoCodec`, `bitrate`, `formatName`, `sizeBytes` e `thumbnail_url` cujo `GET`, enviado a `minio:9000` com o header `Host` original preservado, devolve um JPEG
- `GET /videos/:id` do dono para um vídeo `failed` retorna `200` com `status: "failed"` e `failure_reason` preenchido
- `GET /videos/:id` por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:id` sem token retorna `401`
- `GET /videos/:id` com `:id` que não é UUID retorna `400` com `error: "VALIDATION_ERROR"`

---

### SI-03.13 — Endpoints públicos de streaming e download (302 pré-assinado)

**Route:** GET /videos/:publicId/stream · GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** Public (`@Public()`), só para `status = ready` — demais status → 404 para qualquer chamador — per `### Authorization Matrix`

**Description:** Entrega a reprodução por streaming (Range nativo do storage) e o download pela URL única do vídeo, redirecionando para uma URL GET pré-assinada, sem que a API trafegue os bytes.

**Technical actions:**

1. Adicionar `VideosService.findReadyByPublicId(publicId)` — busca por `public_id` com `status = 'ready'`; ausente, outro status ou formato inválido → `VideoNotFoundException` com a mesma resposta (per `phase-03-videos/TD-08` revisão 2026-11-23, `phase-03-videos/TD-07`)
2. Adicionar `VideosService.getPlaybackUrl(publicId, mode)` — `StorageService.presignGet(storage_key, { expiresIn: 3600, contentType: content_type })` para `stream`; para `download`, inclui `contentDisposition: 'attachment; filename="{original_filename}"'` com o nome escapado (aspas/controle removidos) — assinado pelo **cliente público** (per `phase-03-videos/TD-08`, `phase-03-videos/TD-02`)
3. Adicionar as rotas `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` em `VideosController` com `@Public()`, respondendo `302` com `Location` (`@Redirect()` dinâmico ou `res.redirect(302, url)`), e decoradores OpenAPI (`@ApiResponse` 302 com header `Location`, 404 com `ApiErrorEnvelope`)
4. Regenerar o `openapi.json` commitado com `npm run openapi:export`, incluindo todas as rotas de vídeos da fase (per `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackUrl` | Unit: `download` inclui `attachment; filename="..."` com nome saneado; `stream` não inclui `contentDisposition` (mock repo + mock `StorageService`) | `src/videos/videos.service.spec.ts` |
| `VideosService.findReadyByPublicId` | Integration (Postgres real): só retorna vídeo `ready`; `draft`, `processing` e `failed` → `VideoNotFoundException` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.10 — vídeos chegam a `ready`; SI-03.12 — todas as rotas de vídeo do dono existem antes de regenerar o `openapi.json`

**Acceptance criteria:**

- `GET /videos/:publicId/stream` sem token para um vídeo `ready` retorna `302` com `Location` no host de `S3_PUBLIC_ENDPOINT`
- Um `GET` na URL da `Location` do stream, enviado ao host interno `minio:9000` mas mantendo o header `Host` original da URL, com `Range: bytes=0-99`, retorna `206 Partial Content` com exatamente 100 bytes no corpo, `Content-Range: bytes 0-99/{size_bytes}` e `Content-Type` igual ao `content_type` do vídeo
- `GET /videos/:publicId/download` para um vídeo `ready` retorna `302`, e a `Location`, acessada por `minio:9000` com o header `Host` original preservado, responde com `Content-Disposition: attachment; filename="{original_filename}"`
- `GET /videos/:publicId/stream` e `/download` para vídeos `draft`, `processing` ou `failed` retornam `404` com `error: "VIDEO_NOT_FOUND"`, inclusive quando chamados pelo dono autenticado
- `GET /videos/:publicId/stream` com `publicId` inexistente retorna `404` com corpo idêntico ao de um vídeo não `ready`
- `openapi.json` contém as oito operações de `### API Contracts` com os códigos de erro documentados

---

### SI-03.14 — Fluxo completo upload → processamento → streaming (E2E com worker real)

**Description:** Prova os entregáveis da fase de ponta a ponta sobre a infra real do Compose: upload multipart retomável, processamento automático pelo worker até `ready`/`failed` e streaming pela URL única.

**Technical actions:**

1. Criar `test/support/video-pipeline.ts` — sobe o `AppModule` (com os pipes/filtros globais do `main.ts`) **e** o `WorkerModule` no mesmo processo do teste, com `QUEUE_PREFIX` único por suíte e `QUEUE_BACKOFF_DELAY_MS=100`; expõe `QueueEvents` para aguardar jobs com `job.waitUntilFinished(queueEvents)`; teardown com `queue.obliterate({ force: true })`, `worker.close()` e `app.close()` (per `phase-03-videos/TD-13`, `phase-03-videos/TD-04`)
2. Criar `test/video-pipeline.e2e-spec.ts` — cenário feliz (MP4 gerado por `src/test/media-fixtures.ts`, enviado em 2 partes por `PUT` nas URLs pré-assinadas → `complete` → espera do job → `GET /videos/:id` `ready` → `stream` 302 + `Range` 206 → `download` com `attachment`), cenário de retomada (envia parte 1, `GET .../upload/parts`, envia parte 2, `complete`) e cenário de arquivo inválido (`failed` com `failure_reason`) — cobrindo os três pontos de aceite de `phase-03-videos/TD-03` revisão 2026-11-23
3. Expor em `test/support/video-pipeline.ts` os helpers `putPart(url, chunk)` (devolve o `ETag`), `getStream(location, range?)` e `getDownload(location)`, todos sobre o `requestPresigned` de `src/test/presigned-http.ts` (SI-03.3): enviam para `minio:9000` (host de `S3_ENDPOINT`) e preservam o header `Host` original da URL pré-assinada. O `video-pipeline.e2e-spec.ts` usa só esses helpers para os `PUT` de partes, o stream e o download, nunca um `fetch` direto na URL (per `phase-03-videos/TD-02`, `phase-03-videos/TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline API + worker | E2E (supertest + Redis/MinIO/Postgres/FFmpeg reais, worker no processo do teste): feliz → `ready` + stream/download; retomada via `ListParts`; arquivo inválido → `failed` | `test/video-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.8 — abort disponível para limpeza dos cenários; SI-03.11 — caminho de `failed`; SI-03.13 — stream e download

**Acceptance criteria:**

- Um MP4 enviado em 2 partes direto ao storage e concluído pela API chega a `status = ready` com duração, metadados e thumbnail, sem nenhuma chamada manual ao worker
- Nenhuma requisição à API nesse fluxo carrega bytes do vídeo no corpo (só JSON)
- Um upload interrompido após a parte 1 é retomado a partir de `GET /videos/:id/upload/parts` e concluído sem reenviar a parte 1
- Um arquivo que não é vídeo, enviado com `content_type: "video/mp4"`, termina com `status = failed` e `failure_reason` preenchido
- Dois vídeos enviados na mesma suíte recebem `public_id` distintos, e cada `stream` aponta para o próprio objeto
- No vídeo que chegou a `ready` pelo fluxo completo, `GET /videos/:publicId/stream` retorna `302`, e um `GET` na `Location` com `Range: bytes=0-99` retorna `206 Partial Content` com 100 bytes iguais aos 100 primeiros bytes do arquivo enviado e `Content-Range: bytes 0-99/{size_bytes}`

---

### SI-03.15 — Título do vídeo

**Route:** POST /videos · GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-initiate-upload.plan.md` e `nestjs-project/specs/videos-get-owned.plan.md`
**Authorization:** inalterada — per `### Authorization Matrix`

**Description:** Acrescenta o título do vídeo, exigido pelo enunciado do desafio do MBA, seção "Persistência": a entidade de vídeos deve ter "pelo menos identificação, dono (canal), título, status, chaves de storage do arquivo e do thumbnail, duração e metadados, e o identificador da URL única". O `docs/project-plan.md` só trata da **edição** do título, na Fase 04. Nesta fase o título é definido no início do upload (opcional, com valor derivado do nome do arquivo) e devolvido no detalhe do vídeo.

**Technical actions:**

1. Criar `src/videos/video-title.util.ts` com `deriveVideoTitle(fileName)`. É a regra única do título derivado, aplicada em ordem:
   1. Remove a última extensão com a expressão `/\.[^.]+$/`.
   2. Aplica trim (espaços em branco das pontas).
   3. Se o resultado ficar vazio, usa o `file_name` original com trim. Exemplos: `.mp4` → `.mp4`; ` .mp4` → `.mp4`.
   4. Limita o resultado a 100 caracteres, contados por caractere (code point), como o `varchar(100)` do Postgres.

   O limite de 100 é consequência do `varchar(100)`, porque `file_name` aceita até 255 caracteres. O resultado nunca fica vazio, porque `file_name` tem pelo menos 1 caractere que não é espaço depois da validação do DTO e da allowlist.
2. Criar a migration `src/database/migrations/{timestamp}-AddVideoTitle.ts`. A `CreateVideos` já foi aplicada e não é alterada.
   - O `up` adiciona `title varchar(100)` como nullable.
   - Em seguida preenche as linhas existentes com **exatamente a mesma regra** do `deriveVideoTitle`, escrita em SQL:
     ```sql
     UPDATE "videos" SET "title" = left(
       coalesce(
         nullif(regexp_replace(regexp_replace("original_filename", '\.[^.]+$', ''), '^\s+|\s+$', '', 'g'), ''),
         regexp_replace("original_filename", '^\s+|\s+$', '', 'g')
       ),
       100
     )
     ```
   - Por fim aplica `ALTER COLUMN "title" SET NOT NULL`.
   - O `down` **apenas** remove a coluna: `ALTER TABLE "videos" DROP COLUMN "title"`. Nenhuma outra coluna, índice ou enum é tocado, e a `CreateVideos` continua como está (`synchronize: false` herdado da Fase 01).
3. Adicionar `title` (`varchar(100)`, not null) à entidade `Video` em `src/videos/entities/video.entity.ts`, conforme `### Data Model → Video`.
4. Adicionar `title?: string` a `src/videos/dto/initiate-upload.dto.ts`.
   - Decoradores: `@IsOptional()`, `@Transform(({ value }) => typeof value === 'string' ? value.trim() : value)`, `@IsString()` e `@Length(1, 100)`.
   - O trim roda antes da validação, porque o `ValidationPipe` global usa `transform: true`. Assim, um `title` só com espaços vira `""` e é rejeitado com 400 `VALIDATION_ERROR`.
   - Documentar o campo no `@ApiProperty` como opcional.
5. Em `VideosService.initiateUpload`, persistir o `dto.title` já com trim e, na ausência do campo, `deriveVideoTitle(dto.file_name)`.
6. Adicionar `title: string` a `src/videos/dto/video-response.dto.ts`, mapeado em `VideoResponseDto.from`, conforme `### API Contracts → GET /videos/:id`.
7. Regenerar o `openapi.json` commitado com `npm run openapi:export` (per `openapi-docs-nestjs/TD-02`).
8. Atualizar os cenários de `nestjs-project/specs/videos-initiate-upload.plan.md` e `nestjs-project/specs/videos-get-owned.plan.md` com o título.
9. Incluir `title` nas fixtures que inserem `Video` direto no banco, para atender ao `NOT NULL`. Isso vale para os specs de integração da entidade, do `VideosService` e do `VideoProcessor`, e para os mocks tipados do `videos.service.spec.ts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `deriveVideoTitle` | Unit: `clip.final.mp4` → `clip.final`; `  Minhas férias.mp4 ` → `Minhas férias`; `.mp4` → `.mp4`; ` .mp4` → `.mp4`; nome de 255 caracteres → 100 caracteres; truncamento por code point (não parte emoji) | `src/videos/video-title.util.spec.ts` |
| `VideosService.initiateUpload` | Unit: `title` informado é persistido; ausente → `deriveVideoTitle(file_name)` (mock repo + mock `StorageService`) | `src/videos/videos.service.spec.ts` |
| `VideoResponseDto.from` / `getOwnedDetail` | Unit: a resposta inclui `title` | `src/videos/videos.service.spec.ts` |
| `Video` | Integration: inserir sem `title` falha com violação de `NOT NULL`; `title` de 100 caracteres persiste | `src/videos/entities/video.entity.integration-spec.ts` |
| `AddVideoTitle` migration | Integration: o `up` preenche `title` das linhas existentes com a mesma regra do `deriveVideoTitle` (`clip.final.mp4` → `clip.final`; `.mp4` → `.mp4`; ` .mp4` → `.mp4`; nome de 255 caracteres → 100) e deixa a coluna `NOT NULL`; o `down` remove só a coluna `title`, mantendo as demais colunas e as linhas | `src/database/migrations.integration-spec.ts` |
| `VideosService.initiateUpload` | Integration (Postgres + MinIO reais): rascunho persistido com o `title` derivado quando ausente | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos` | E2E: com `title` → `GET /videos/:id` devolve o mesmo `title`; `title` com espaços nas pontas → gravado sem eles; sem `title` → título derivado de `file_name`; `file_name: " .mp4"` sem `title` → `.mp4`; `title` vazio, só com espaços ou com 101 caracteres após o trim → 400 `VALIDATION_ERROR` sem criar linha | `test/videos-initiate-upload.e2e-spec.ts` |
| `GET /videos/:id` | E2E: a resposta inclui `title` | `test/videos-get-owned.e2e-spec.ts` |

**Dependencies:** SI-03.4 — entidade `Video` e migration `CreateVideos`; SI-03.5 — `POST /videos`; SI-03.12 — `GET /videos/:id`; SI-03.13 — `openapi.json` já cobre todas as rotas da fase

**Acceptance criteria:**

- `npm run migration:run` aplica `AddVideoTitle` sobre um banco com `CreateVideos` já aplicada. As linhas existentes recebem o `title` pela mesma regra do `deriveVideoTitle`: `original_filename = "clip.final.mp4"` → `"clip.final"` e `original_filename = ".mp4"` → `".mp4"`.
- Depois da migration, a coluna `videos.title` é `varchar(100) NOT NULL`.
- `npm run migration:revert` desfaz a `AddVideoTitle` removendo **apenas** a coluna `title`: as demais colunas, índices, o enum `video_status` e as linhas de `videos` continuam como estavam.
- `POST /videos` com `{ title: "Minhas férias", file_name: "clip.mp4", content_type: "video/mp4", size_bytes: 134217728 }` retorna `201`, e o `GET /videos/:id` desse rascunho devolve `title: "Minhas férias"`.
- `POST /videos` com `title: "  Minhas férias  "` grava e devolve `title: "Minhas férias"`.
- `POST /videos` com `title: ""`, com `title: "   "` (só espaços) ou com `title` de 101 caracteres após o trim retorna `400` com `error: "VALIDATION_ERROR"`, e nenhuma linha é criada em `videos`.
- `POST /videos` sem `title` e com `file_name: "clip.final.mp4"` cria o rascunho com `title: "clip.final"`.
- `POST /videos` sem `title` e com `file_name: " .mp4"` (o nome sem extensão fica vazio após o trim) cria o rascunho com `title: ".mp4"`, o `file_name` original com trim.
- `deriveVideoTitle(".mp4")` retorna `".mp4"`. Pelo `POST /videos`, `file_name: ".mp4"` continua sendo rejeitado com 415 pela allowlist, porque não tem extensão.
- `POST /videos` sem `title` e com `file_name` de 255 caracteres cria o rascunho com `title` de 100 caracteres.
- O shape de resposta do `POST /videos` (201) não muda.
- `openapi.json` documenta `title` como opcional no corpo do `POST /videos` e como obrigatório na resposta do `GET /videos/:id`.

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
| title | varchar(100) | not null — título do vídeo; informado no `POST /videos` (com trim) ou derivado do `file_name` por `deriveVideoTitle` (per enunciado do desafio do MBA, seção "Persistência"; SI-03.15). A edição do título fica para a Fase 04 (`docs/project-plan.md`) |
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
**Migration:** nova migration TypeORM cria o enum `video_status`, a tabela `videos`, o índice único em `public_id`, o índice em `channel_id` e a FK para `channels` (`synchronize: false` herdado da Fase 01). A coluna `title` entra depois, numa migration própria (`AddVideoTitle`, SI-03.15), porque a `CreateVideos` já foi aplicada. Ela preenche as linhas existentes a partir de `original_filename`, com a mesma regra do título derivado, antes de aplicar `NOT NULL`. O `down` remove apenas a coluna `title`.

### API Contracts

Convenções herdadas: corpo de erro `{ statusCode, error, message }` (per `phase-02-auth/TD-07`); campos do JSON em snake_case, como em `refresh_token` / `new_password` da Fase 02. A exceção são as chaves internas do objeto `metadata`, transcritas literalmente do `phase-03-videos/TD-05`. Todo endpoint protegido aceita `Authorization: Bearer <access_token>` (guard JWT global, per `phase-02-auth/TD-02`); os endpoints públicos usam `@Public()`. Nenhum endpoint recebe os bytes do vídeo: as partes vão direto ao storage por URL pré-assinada (per `phase-03-videos/TD-03` revisão 2026-11-23). Cada endpoint recebe decoradores OpenAPI explícitos (`@ApiOperation`, `@ApiResponse` por status com `ApiErrorEnvelope`, `@ApiParam`, `@ApiBody`), per `openapi-docs-nestjs/TD-01` revisão 2026-05-12.

#### POST /videos (SI-03.5)

Inicia o upload: valida o arquivo declarado, cria o rascunho (`status = draft`) e abre o S3 Multipart Upload (`CreateMultipartUploadCommand`) na chave `videos/{videoId}/original` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-02`, `phase-03-videos/TD-11`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- title: string, optional — espaços das pontas removidos (trim); depois disso, 1 a 100 caracteres. Se ausente, é derivado do `file_name`: sem a última extensão e com trim; se ficar vazio, o `file_name` original com trim; limitado a 100 caracteres (per enunciado do desafio do MBA, seção "Persistência"; SI-03.15)
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
- 400 VALIDATION_ERROR: corpo fora do schema (campo ausente, tipo errado, `size_bytes < 1`, `title` vazio, só com espaços ou com mais de 100 caracteres após o trim)
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
- title: string (SI-03.15)
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
- **Título** (per enunciado do desafio do MBA, seção "Persistência"; SI-03.15): `title` opcional no `POST /videos`. O valor recebe trim e, depois disso, precisa ter de 1 a 100 caracteres; fora disso (inclusive só espaços) → 400 `VALIDATION_ERROR`. Se ausente, vale `deriveVideoTitle(file_name)`: remove a última extensão (`\.[^.]+$`) e aplica trim; se ficar vazio, usa o `file_name` original com trim; limita a 100 caracteres. A migration `AddVideoTitle` usa a mesma regra para as linhas existentes.
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

## Dependency Map

```
SI-03.1 (root)
└── SI-03.2 — depends on SI-03.1 (chaves de env e serviços do Compose)
    └── SI-03.3 — depends on SI-03.2 (namespace storage)
        ├── SI-03.5 — depends on SI-03.3 + SI-03.4 (StorageService + entidade Video)
        │   ├── SI-03.6 — depends on SI-03.5 (rascunho + VideosController)
        │   │   ├── SI-03.7 — depends on SI-03.6 (findOwnedDraft + partes enviadas)
        │   │   │   └── SI-03.10 — depends on SI-03.7 + SI-03.9 (QueueModule/job + MediaService)
        │   │   │       ├── SI-03.11 — depends on SI-03.10 (VideoProcessor)
        │   │   │       └── SI-03.12 — depends on SI-03.5 + SI-03.10 (controller + vídeos ready)
        │   │   │           └── SI-03.13 — depends on SI-03.10 + SI-03.12 (ready + rotas do dono antes do openapi.json)
        │   │   └── SI-03.8 — depends on SI-03.6 (findOwnedDraft)
        └── SI-03.9 — depends on SI-03.1 + SI-03.3 (FFmpeg na imagem + URLs internas)
SI-03.4 (root, independent — só entidades da Fase 02)
SI-03.14 — depends on SI-03.8 + SI-03.11 + SI-03.13 (abort, caminho failed, stream/download)
SI-03.15 — depends on SI-03.4 + SI-03.5 + SI-03.12 + SI-03.13 (entidade/migration, POST /videos, GET /videos/:id, openapi.json completo)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: Redis, MinIO, FFmpeg e bibliotecas da fase
- [ ] SI-03.2 — Configuração de storage e fila (namespaces + schema Joi)
- [ ] SI-03.3 — StorageModule: clientes S3 interno e público
- [ ] SI-03.4 — Entidade Video + migration + gerador de public_id
- [ ] SI-03.5 — Endpoint POST /videos (início do upload + pré-cadastro em rascunho)
- [ ] SI-03.6 — Endpoints de partes do upload (gerar URLs + listar para retomar)
- [ ] SI-03.7 — Endpoint POST /videos/:id/upload/complete + produtor da fila
- [ ] SI-03.8 — Endpoint DELETE /videos/:id/upload (abort do rascunho)
- [ ] SI-03.9 — MediaModule: wrapper fino de ffprobe/ffmpeg
- [ ] SI-03.10 — Video Worker: processor, WorkerModule e entrypoint próprio
- [ ] SI-03.11 — Handler de falha final do processamento (retry + `failed`)
- [ ] SI-03.12 — Endpoint GET /videos/:id (status e detalhe do próprio vídeo)
- [ ] SI-03.13 — Endpoints públicos de streaming e download (302 pré-assinado)
- [ ] SI-03.14 — Fluxo completo upload → processamento → streaming (E2E com worker real)
- [ ] SI-03.15 — Título do vídeo

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`) — obrigatório `--runInBand`: as suítes de integração compartilham o mesmo Postgres (per `phase-03-videos/TD-13`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e -- --runInBand`) — obrigatório `--runInBand`: as suítes E2E compartilham Postgres, Redis e MinIO (per `phase-03-videos/TD-13`; `README.md`: "Testes de integração/e2e rodam com `--runInBand`")
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
