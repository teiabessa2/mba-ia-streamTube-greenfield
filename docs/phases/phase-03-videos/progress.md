# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/14 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Endpoint POST /videos (início do upload + pré-cadastro em rascunho)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoints de partes do upload (gerar URLs + listar para retomar)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoint POST /videos/:id/upload/complete + produtor da fila
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
