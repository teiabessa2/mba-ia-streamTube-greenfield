# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/14 completed

### SI-03.1 — Infra: Redis, MinIO, FFmpeg e bibliotecas da fase
- **Status:** completed
- **Tests:** no tests (Infra). ACs verificados manualmente: redis `healthy`, minio `running` com digest pinado, `/minio/health/live` → 200 a partir do `nestjs-api`, console `:9001` → 200 do host, objeto preservado após `--force-recreate minio`, `docker compose --env-file .env.example config` ok, `MAIL_FROM` → `"StreamTube" <noreply@streamtube.com>`, `ffmpeg`/`ffprobe` 5.1.9, `npm ls` sem erro. Regressão: 144 unit/integration + 52 e2e passando.
- **Observations:**
  - **Divergência de plano (ioredis):** o SI afirmava que `ioredis` entra como dependência transitiva do `bullmq`; no `bullmq@6.7.8` ele é peer opcional (`>=5.0.0`) e `new Queue({ connection: { host } })` falha com "BullMQ could not load the optional 'ioredis' package". Por decisão da usuária, instalado `ioredis@^5` (resolvido 5.11.1) como dependência direta, coerente com a TD-01 (que lista `ioredis` sem versão). Plano corrigido: ação 4 e AC de `npm ls` do SI-03.1 em `phase-03-videos.md`, e versão `^5` + nota na seção `ioredis` do `library-refs.md`.
  - **Versões vs library-refs.md:** `bullmq@6.7.8`, `@nestjs/bullmq@11.0.5`, `@aws-sdk/client-s3@3.1176.0`, `@aws-sdk/s3-request-presigner@3.1176.0`. Dentro dos ranges do plano; o library-refs.md já sinalizava que o Context7 indexa só até bullmq v6.5.3 / aws-sdk v3.1153.0. Ranges no `package.json` mantidos como no plano (`^3.1173.0`).
  - `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` vinham sem valor no plano; usados os valores de dev `streamtube` / `streamtube-secret` (MinIO exige senha ≥ 8 caracteres), lidos pelo Compose via interpolação para `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`.
  - **Desvio menor do plano (porta 6379):** a porta `6379` do Redis foi exposta no host (`ports: 6379:6379`), o que o plano não pedia; segue o padrão de `db`/`mailpit`, que também expõem suas portas.

### SI-03.2 — Configuração de storage e fila (namespaces + schema Joi)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — StorageModule: clientes S3 interno e público
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
