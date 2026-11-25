# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/14 completed

### SI-03.1 — Infra: Redis, MinIO, FFmpeg e bibliotecas da fase
- **Status:** completed
- **Tests:** no tests (Infra). ACs verificados manualmente: redis `healthy`, minio `running` com digest pinado, `/minio/health/live` → 200 a partir do `nestjs-api`, console `:9001` → 200 do host, objeto preservado após `--force-recreate minio`, `docker compose --env-file .env.example config` ok, `MAIL_FROM` → `"StreamTube" <noreply@streamtube.com>`, `ffmpeg`/`ffprobe` 5.1.9, `npm ls` sem erro. Regressão: 144 unit/integration + 52 e2e passando.
- **Observations:**
  - **Divergência de plano (ioredis):** o SI afirmava que `ioredis` entra como dependência transitiva do `bullmq`; no `bullmq@6.7.8` ele é peer opcional (`>=5.0.0`) e `new Queue({ connection: { host } })` falha com "BullMQ could not load the optional 'ioredis' package". Por decisão da usuária, instalado `ioredis@^5` (resolvido 5.11.1) como dependência direta, coerente com a TD-01 (que lista `ioredis` sem versão). Plano corrigido: ação 4 e AC de `npm ls` do SI-03.1 em `phase-03-videos.md`, e versão `^5` + nota na seção `ioredis` do `library-refs.md`.
  - **Versões vs library-refs.md:** `bullmq@6.7.8`, `@nestjs/bullmq@11.0.5`, `@aws-sdk/client-s3@3.1176.0`, `@aws-sdk/s3-request-presigner@3.1176.0`. Dentro dos ranges do plano; o library-refs.md já sinalizava que o Context7 indexa só até bullmq v6.5.3 / aws-sdk v3.1153.0. Ranges no `package.json` mantidos como no plano (`^3.1173.0`).
  - `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` vinham sem valor no plano; usados os valores de dev `streamtube` / `streamtube-secret` (MinIO exige senha ≥ 8 caracteres), lidos pelo Compose via interpolação para `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`.
  - **Desvio menor do plano (porta 6379):** a porta `6379` do Redis foi exposta no host (`ports: 6379:6379`), o que o plano não pedia; segue o padrão de `db`/`mailpit`, que também expõem suas portas.

### SI-03.2 — Configuração de storage e fila (namespaces + schema Joi)
- **Status:** completed
- **Tests:** 22 passing (`src/config/env.validation.integration-spec.ts`; 4 pré-existentes de `SWAGGER_ENABLED` + 18 novos). Regressão: 162 unit/integration + 52 e2e passando; lint e `tsc --noEmit` limpos.
- **Observations:**
  - **`.env` compartilhado entre testes e dev:** os testes e o dev usam o mesmo `nestjs-project/.env` (o Jest o carrega via `setupFiles: ["dotenv/config"]`; não há `.env.test`). Por isso o `.env` local usa `QUEUE_BACKOFF_DELAY_MS=100` (backoff curto exigido pelos testes de integração/E2E, também vigente no dev local), enquanto o `.env.example` mantém o padrão `30000`.
  - Além do schema Joi, o spec boota `ConfigModule.forRoot` com `ignoreEnvFile: true` para cobrir os ACs de boot (aborta sem `S3_BUCKET` / com `QUEUE_BACKOFF_DELAY_MS=-1`, defaults de fila resolvidos, `forcePathStyle` boolean).
  - `requiredEnv` do spec pré-existente ganhou as cinco chaves S3 obrigatórias, senão os testes de `SWAGGER_ENABLED` falhariam.

### SI-03.3 — StorageModule: clientes S3 interno e público
- **Status:** completed
- **Tests:** 18 passing (`storage.service.integration-spec.ts` 10, `storage.service.spec.ts` 7, `storage.module.spec.ts` 1). Regressão: 180 unit/integration + 52 e2e passando; lint e `tsc --noEmit` limpos.
- **Observations:**
  - **Item "a verificar" da TD-02 (CORS) resolvido:** o `cgr.dev/chainguard/minio` responde `NotImplemented` (HTTP 501) ao `PutBucketCors`, como previsto. O boot registra `Logger.warn` citando `MINIO_API_CORS_ALLOW_ORIGIN` e segue.
  - Distinção "storage não responde" no `HeadBucket`, verificada no SDK instalado: erros de conexão (`ECONNREFUSED` / `ENOTFOUND`) trazem `$metadata` sem `httpStatusCode`. Além deles, `503` também é tratado como "ainda iniciando" e entra no retry; `404`/`NotFound` → `CreateBucket`; qualquer outro status derruba o boot sem retry. Janela de 30s com intervalo fixo de 1s (`STORAGE_BOOT` em `storage.constants.ts`).
  - Os testes de integração usam o bucket fixo `streamtube-test` (sobrescrevem `S3_BUCKET` antes de carregar o namespace), para não poluir o bucket de dev (TD-13). O AC "boot com o `minio` ainda iniciando espera o storage" é coberto pelo unit (retry com fake timers), não por parar o container real.
  - O `StorageModule` ainda não é importado pelo `AppModule`; entra via `VideosModule` no SI-03.5 e via `WorkerModule` no SI-03.10, conforme o plano. O AC "após o boot da aplicação o bucket existe e rejeita GET anônimo (403)" foi verificado com `moduleRef.init()` do `StorageModule`.
  - Arquivos auxiliares além dos listados no plano: `storage.constants.ts` (tokens DI, prazos de URL, janela de boot, nomes de erro de partes), `storage.errors.ts` (`StorageInvalidPartsError`) e `storage.types.ts`.
  - `listParts` pagina por `NextPartNumberMarker` (o `ListParts` devolve no máximo 1000 partes por chamada, e um upload pode ter até 10.000).

### SI-03.4 — Entidade Video + migration + gerador de public_id
- **Status:** completed
- **Tests:** 12 passing (`video.entity.integration-spec.ts` 6, `migrations.integration-spec.ts` 4, `public-id.util.spec.ts` 2). Regressão: 190 unit/integration + 52 e2e passando; lint e `tsc --noEmit` limpos. AC de migration verificado no banco de dev: `migration:run` cria tabela + enum + índices (PK, `public_id` único, `channel_id`), `migration:revert` remove tudo; banco deixado migrado.
- **Observations:**
  - Migration `1795621684480-CreateVideos.ts` gerada com `migration:generate` a partir da entidade (só contém `videos` / `video_status`), para que o schema da migration bata com o `synchronize: true` usado pelos specs de entidade no mesmo banco.
  - `VideoStatus` (enum) e `VideoMetadata` (forma do `jsonb`) ficaram em `src/videos/videos.types.ts`, arquivo não listado no plano.
  - Relação `Video → Channel` é só `ManyToOne` (unidirecional), como pede a ação 1 e como `RefreshToken → User`; o `channel.entity.ts` não foi tocado (fora do escopo do SI).
  - `migrations.integration-spec.ts`: o teste de revert existente passou a desfazer primeiro a `CreateVideos` (novo teste) e depois a `CreateAuthTokens`; o `afterAll` reaplica todas.
  - Com o `DELETE FROM "videos"` no `cleanAllTables`, todo suite que o chama depende de a tabela `videos` existir no banco (mesma premissa já valendo para `refresh_tokens`/`verification_tokens`).

### SI-03.5 — Endpoint POST /videos (início do upload + pré-cadastro em rascunho)
- **Status:** completed
- **Tests:** 28 passing (`videos.service.spec.ts` 15, `videos.service.integration-spec.ts` 1, `channels.service.integration-spec.ts` 5 — 3 existentes + 2 de `findByUserId`, `videos.module.spec.ts` 1, `test/videos-initiate-upload.e2e-spec.ts` 6 — os 6 cenários da spec). Regressão: 209 unit/integration + 58 e2e passando; `tsc --noEmit` limpo; `npm run lint` com 0 erros (23 warnings, todos pré-existentes em `src/auth/auth.service*.spec.ts`).
- **Observations:**
  - Sessão retomada após queda de conexão: os arquivos já estavam no disco sem commit; revisados contra as 5 ações do plano e os 6 cenários de `specs/videos-initiate-upload.plan.md`, nada faltava, e nada foi recriado.
  - **Compensação além do plano:** se a gravação do rascunho falhar depois do `CreateMultipartUpload`, o serviço faz `abortMultipartUpload` e relança o erro, para não deixar multipart órfão sem linha no banco.
  - Usuário autenticado sem canal lança `Error` genérico (500): é uma invariante da Fase 02 (todo cadastro cria canal) e não há código para isso no Error Catalog.
  - Colisão de `public_id`: até 5 tentativas (`PUBLIC_ID_MAX_ATTEMPTS`), detectando `23505` cujo `detail` cita `public_id`. A checagem duplica o padrão de `isPgUniqueViolationOnColumn` do `channels.service.ts`; extraí-la para `src/common` fica como follow-up (fora do escopo).
  - Arquivos além dos listados no plano: `videos.constants.ts` (limites, allowlist, chave de storage), `dto/initiate-upload-response.dto.ts` (schema OpenAPI do 201) e `src/test/test-bucket.ts` (`TEST_S3_BUCKET` + `useTestBucket()`), usado pelos specs novos. O `storage.service.integration-spec.ts` (SI-03.3) ainda declara sua própria constante `'streamtube-test'`; passar a usar o helper fica como follow-up.
  - Os e2e que sobem o `AppModule` sem `useTestBucket()` (auth, app, swagger) agora executam o `ensureBucket()` no bucket de dev (`streamtube`): só o garantem/criam, sem gravar objetos.
  - O `openapi.json` commitado não foi regenerado: o plano faz isso no SI-03.13.

### SI-03.6 — Endpoints de partes do upload (gerar URLs + listar para retomar)
- **Status:** completed
- **Tests:** 35 passing — `videos.service.spec.ts` + `videos.service.integration-spec.ts` 27 (10 unit novos de `findOwnedDraft`/`presignParts` + 1 integration novo de `listUploadedParts`, somados aos 16 do SI-03.5), `test/videos-upload-parts.e2e-spec.ts` 8 (os 8 cenários da spec). Regressão: 220 unit/integration + 66 e2e passando; `tsc --noEmit` limpo; `npm run lint` com 0 erros (23 warnings pré-existentes em `src/auth/auth.service*.spec.ts`).
- **Observations:**
  - `findOwnedDraft` também trata como `VIDEO_NOT_IN_DRAFT` um `draft` sem `upload_id` (estado inconsistente), e responde `VIDEO_NOT_FOUND` sem consultar `videos` quando o usuário não tem canal.
  - `MAX_PARTS_PER_PRESIGN` (100) e `PART_URL_EXPIRES_IN_S` (3600) entraram em `videos.constants.ts`; DTOs de resposta para o OpenAPI: `dto/presign-parts-response.dto.ts` e `dto/uploaded-parts-response.dto.ts` (não listados no plano).
  - Novo helper `test/support/videos-e2e.ts` (`createVideosE2eApp()` reproduzindo o `main.ts` + `registerAndLogin()` do fluxo da Fase 02), usado pelo e2e novo. O `test/videos-initiate-upload.e2e-spec.ts` (SI-03.5) ainda tem esse bootstrap inline; passar a usar o helper fica como follow-up (fora do escopo).
  - O teste de integração envia uma parte pequena (16 bytes); o PUT de 64MiB exigido pela spec está no e2e (`put-de-parte-aceito-pelo-storage` e `lista-somente-a-parte-enviada`).

### SI-03.7 — Endpoint POST /videos/:id/upload/complete + produtor da fila
- **Status:** completed
- **Tests:** 45 passing. Unit/integration: 39 em 5 suítes:
  - `videos.service.spec.ts`: 7 unit novos de `completeUpload`.
  - `video-processing.queue.integration-spec.ts`: 2 testes.
  - `videos.service.integration-spec.ts`: 1 novo de `completeUpload`, com upload real de 1 parte.
  - `queue.module.spec.ts`: 1 teste.
  - `videos.module.spec.ts`: atualizado.

  E2E: `test/videos-upload-complete.e2e-spec.ts` com 6 testes, os 6 cenários da spec. Regressão: 231 unit/integration e 72 e2e passando. `tsc --noEmit` limpo. `npm run lint` com 0 erros e os 23 warnings pré-existentes.
- **Observations:**
  - Sobre `QUEUE_NAMES`, `PROCESS_VIDEO_JOB` e `MAX_PART_NUMBER`:
    - O nome da fila fica em `src/queue/queue.constants.ts` (`QUEUE_NAMES.VIDEOS`), para o worker reusar no SI-03.10.
    - O nome do job e as `attempts` ficam em `videos.constants.ts` (`PROCESS_VIDEO_JOB`).
    - `VIDEO_UPLOAD_LIMITS.MAX_PART_NUMBER` (10000) limita o `part_number` e o tamanho do array no `CompleteUploadDto`.
    - O payload do job é tipado como `ProcessVideoJobData` em `videos.types.ts`.
  - Arquivos fora da lista do plano:
    - `dto/complete-upload-response.dto.ts`, DTO de resposta para o OpenAPI.
    - Helper `src/test/test-queue.ts` (`useTestQueuePrefix(suite)`), que define um `QUEUE_PREFIX` único por suíte antes do compile, no mesmo padrão de `useTestBucket`. Usado no integration da fila, no do service e no e2e.
  - `@ArrayUnique` recebe um identificador por `part_number`, com optional chaining para itens que não são objetos, e assim um `part_number` repetido vira `VALIDATION_ERROR`.
  - As duas suítes `describe` já existentes em `videos.service.spec.ts` passaram a prover um mock de `VideoProcessingQueue`, nova dependência do `VideosService`.
  - Agora o `AppModule` carrega o `QueueModule` pelo `VideosModule`. Por isso todas as suítes e2e abrem uma conexão Redis com o prefixo padrão, sem publicar jobs. A fila é fechada no `app.close()` pelo `onApplicationShutdown` do `@nestjs/bullmq`, e nenhum aviso de handle aberto apareceu.
  - Ponto não coberto pelo plano: se o `enqueue` falhar depois do `UPDATE` para `processing`, o vídeo fica em `processing` sem job. Fica registrado para o SI-03.10 ou SI-03.11, ou para uma task futura de reconciliação.
  - No run das suítes do SI, `videos.service.integration-spec.ts` e `videos.module.spec.ts` imprimiram o aviso do `pg` "Calling client.query() when the client is already executing a query is deprecated". Não bloqueia agora, mas vai quebrar no pg@9. Não verifiquei se o aviso já existia antes deste SI; fica como follow-up.

### SI-03.8 — Endpoint DELETE /videos/:id/upload (abort do rascunho)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — MediaModule: wrapper fino de ffprobe/ffmpeg
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Video Worker: processor, WorkerModule e entrypoint próprio
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Handler de falha final do processamento (retry + `failed`)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Endpoint GET /videos/:id (status e detalhe do próprio vídeo)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Endpoints públicos de streaming e download (302 pré-assinado)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Fluxo completo upload → processamento → streaming (E2E com worker real)
- **Status:** pending
- **Tests:** —
- **Observations:** none
