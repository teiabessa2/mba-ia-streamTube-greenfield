# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 10/14 completed

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
  - **Limitação conhecida (task futura de reconciliação):** se o `enqueue` falhar depois do `UPDATE` para `processing`, o vídeo fica em `processing` sem job. Nenhum SI da Fase 03 exige tratar isso; fica para uma task futura que reconcilie vídeos em `processing` sem job na fila.
  - O aviso do `pg` "Calling client.query() when the client is already executing a query is deprecated" aparece em `videos.service.integration-spec.ts` e `videos.module.spec.ts`. É pré-existente: já aparecia na baseline, antes da Fase 03, na primeira execução de `npm test -- --runInBand`. Fora do escopo desta fase.

### SI-03.8 — Endpoint DELETE /videos/:id/upload (abort do rascunho)
- **Status:** completed
- **Tests:** 65 passing nas suítes do SI:
  - Unit/integration, 61 em 4 suítes:
    - `videos.service.spec.ts`: 4 unit novos de `abortUpload`.
    - `videos.service.integration-spec.ts`: 1 novo de `abortUpload`, com PUT real de 1 parte.
    - `storage.service.spec.ts`: 3 unit novos de `abortMultipartUpload`.
    - `storage.service.integration-spec.ts`: 1 novo (abort repetido).
  - E2E: `test/videos-upload-abort.e2e-spec.ts`, 4 testes (os 4 cenários da spec).

  Regressão: 240 unit/integration (33 suítes) e 76 e2e (7 suítes) passando. `tsc --noEmit` limpo. `npm run lint` com 0 erros e os 23 warnings pré-existentes.
- **Observations:**
  - **Divergência MinIO × AWS no abort repetido.**
    - O MinIO responde `204` a um `AbortMultipartUpload` de um `upload_id` que já não existe. A AWS S3 responde `NoSuchUpload`.
    - A tolerância pedida na ação 2 está implementada:
      - `StorageService.abortMultipartUpload` traduz `NoSuchUpload` para o novo `StorageUploadNotFoundError`, em `storage.errors.ts`, no mesmo padrão de `StorageInvalidPartsError`.
      - `VideosService.abortUpload` ignora só esse erro e remove a linha mesmo assim.
    - Como o MinIO não reproduz o `NoSuchUpload`, essa tradução é coberta por unit com mock do cliente S3.
    - O integration do storage documenta o comportamento real do MinIO: o abort repetido resolve sem erro.
  - **Delete condicional.** A linha é removida com `delete({ id, status: 'draft' })`, para nunca apagar um vídeo que saiu de `draft` entre a leitura e o delete.
  - **`abort-repetido-recebe-404`.** O `404` do abort repetido vem do `findOwnedDraft`, porque a linha já foi removida. O storage nem chega a ser chamado.

### SI-03.9 — MediaModule: wrapper fino de ffprobe/ffmpeg
- **Status:** completed
- **Tests:** 7 passing:
  - `media.service.integration-spec.ts`: 6 testes, com FFmpeg real e arquivos servidos por URL pré-assinada interna do MinIO no bucket `streamtube-test`.
    - MP4 3s 320x240 com áudio.
    - Vídeo sem áudio.
    - Texto renomeado `.mp4` → `InvalidMediaError`.
    - Objeto inexistente (403) → erro transitório.
    - Timeout do `ffprobe`.
    - `extractFrame` gera JPEG com assinatura `FF D8`.
  - `media.module.spec.ts`: 1 teste de compilação.

  Regressão: 247 unit/integration (35 suítes) e 76 e2e (7 suítes) passando. `tsc --noEmit` limpo. `npm run lint` com 0 erros e os 23 warnings pré-existentes.
- **Observations:**
  - **Classificação dos erros do `ffprobe`, verificada no container (ffmpeg 5.1.9).**
    - Arquivo inválido e falha de rede saem ambos com código 1. Então a distinção é feita pelo stderr.
    - `Invalid data found when processing input` ou `moov atom not found` → `InvalidMediaError`.
    - Qualquer outra saída ≠ 0 → `Error` comum (transitório). Exemplos: `403 Forbidden`, DNS, `Connection refused`.
    - Processo morto por timeout (`killed`/`signal`) → `Error` comum.
    - Os padrões ficam em `INVALID_MEDIA_STDERR_PATTERNS`, em `media.constants.ts`.
  - **Regras além do plano.**
    - Saída sem duração ou tamanho legíveis também vira `InvalidMediaError`. É o caso de uma imagem JPEG, que tem stream `video` sem duração.
    - Sem `bit_rate` no container, o bitrate é calculado como `size × 8 / duration`.
    - `extractFrame` falha com erro comum se o ffmpeg sair 0 com arquivo vazio, o que acontece quando o seek passa do fim.
  - **Timeouts injetáveis.** Os limites vêm do token `MEDIA_OPTIONS`, com padrão de 30s no probe e 60s no frame. Não há variável de env nova, porque o plano não pede. O teste de timeout sobrescreve o token para 500ms e aponta para um servidor HTTP local que aceita a conexão e nunca responde.
  - **Tipos próprios.** `MediaMetadata` e `ProbeResult` ficam em `media.types.ts`, para o módulo de mídia não depender de `videos`. A forma é idêntica à `VideoMetadata` de `videos.types.ts`, então são estruturalmente compatíveis no worker (SI-03.10).
  - **Arquivos além dos listados no plano:** `media.constants.ts`, `media.errors.ts` e `media.types.ts`.

### SI-03.10 — Video Worker: processor, WorkerModule e entrypoint próprio
- **Status:** completed
- **Tests:** 15 passing:
  - `video.processor.spec.ts`: 9 unit.
    - No-op para vídeo ausente e para `draft`/`ready`/`failed`, sem chamar storage nem media.
    - Caminho feliz: URL interna com 900s, frame a 10% da duração e uma única atualização condicional para `ready`.
    - Remoção do diretório temporário.
    - `InvalidMediaError` → `UnrecoverableError`.
    - Erro transitório de probe e de frame relançado como está.
  - `video.processor.integration-spec.ts`: 5 testes com Postgres, MinIO e FFmpeg reais.
    - Vídeo `ready` com duração, metadados e thumbnail `image/jpeg` no bucket.
    - Reentrega do job mantém os mesmos valores e um único objeto de thumbnail.
    - Vídeo fora de `processing` fica intacto.
    - Vídeo inexistente termina sem erro.
    - Objeto que não é vídeo → `UnrecoverableError`, com a linha ainda em `processing`.
  - `worker.module.spec.ts`: 1 teste de compilação, que também verifica a relação `Video#channel` resolvida.

  Regressão: 262 unit/integration (38 suítes) e 76 e2e (7 suítes) passando, com e2e repetido já com o `video-worker` no ar. `tsc --noEmit` limpo. `npm run lint` com 0 erros e os 23 warnings pré-existentes.
- **Observations:**
  - **ACs do Compose verificados manualmente.**
    - `docker compose up -d video-worker` sobe o container, que loga `Video worker started`.
    - Fluxo real pelo host: cadastro, token pelo Mailpit, login, `POST /videos`, PUT da parte na URL pública e `complete`. O vídeo `6807ca4e-…` chegou a `ready` em ~1s, com `duration_seconds = 3`, `metadata` e `thumbnail_key`. O thumbnail responde 403 a GET anônimo.
    - Com API (`start:dev`) e worker no ar, `Queue.getWorkers()` da fila `videos` lista 1 worker, com o IP do `video-worker`. Nenhum log do `VideoProcessor` aparece na API.
    - O `start:dev` foi parado ao fim da verificação.
    - O vídeo e o usuário `worker-check-*@example.com` dessa verificação ficaram no banco e no bucket de dev.
  - **`UsersModule` importado pelo `WorkerModule`.** É uma divergência do plano, que só cita `forFeature([Video])`. O `autoLoadEntities` precisa dos metadados de `Channel` e `User` (relação `Video → Channel → User`), senão o `DataSource` não inicializa. Importar o módulo dono registra essas entidades sem o worker declarar entidades de outros domínios.
  - **Configuração duplicada.** O `ConfigModule.forRoot` e o `TypeOrmModule.forRootAsync` do `WorkerModule` repetem os do `AppModule`. O plano pede o mesmo `load`/`validationSchema`. Extrair as opções para um arquivo compartilhado exige alterar o `AppModule`, fora do escopo do SI, e fica como follow-up.
  - **`outDir` próprio do worker (`dist-worker/`), resolvido no commit `fix(worker): build worker to its own outDir`.**
    - **Problema:** `video-worker` e `nestjs-api` montam o mesmo volume. No commit do SI, `nest start --watch`, com `deleteOutDir: true`, compilava os dois para o mesmo `dist/`, e o restart de um apagava os arquivos do outro.
    - **Solução, seguindo o padrão nest-cli/tsconfig:**
      - Novo `tsconfig.worker.json`, que estende o `tsconfig.build.json` e só troca o `outDir` para `./dist-worker`. O `.tsbuildinfo` vai junto, em `dist-worker/tsconfig.worker.tsbuildinfo`.
      - `start:worker:dev` passou a ser `nest start --watch --path tsconfig.worker.json --entryFile worker.main`. O `nest start --path` tira desse tsconfig o `outDir` usado pelo `deleteOutDir`, pela cópia de assets e pelo caminho do entrypoint.
      - `/dist-worker` foi adicionado ao `.gitignore`.
    - **`exclude` necessário:** o `tsconfig.build.json` excluía só `dist`. Sem isso, a recompilação incremental do worker lia os `.d.ts` de `dist-worker/` como entrada e falhava com 89× `TS5055 … would overwrite input file`. O build da API também passaria a incluí-los, o que mudaria o `rootDir` e o caminho `dist/main`. Então `dist-worker` entrou no `exclude` do `tsconfig.build.json`, herdado pelo `tsconfig.worker.json`. Também entrou no `tsconfig.json`, que antes não tinha `exclude` e agora repete o padrão (`node_modules`, `dist`) mais `dist-worker`.
    - **Produção inalterada:** `start:worker` continua `node dist/worker.main`. Lá não há watch, e um único `npm run build` gera os dois entrypoints em `dist/`, como o plano define.
    - **Verificação com os dois processos rodando juntos:**
      - O worker roda de `dist-worker/worker.main`, e a recompilação incremental (edição temporária de um fonte, depois desfeita) saiu com 0 erros.
      - **Restart da API com o worker no ar:** `dist/main.js` foi recriado (inode 226471 → 226473). `dist-worker/worker.main.js` ficou com o mesmo inode e o mesmo mtime. O worker seguiu no mesmo PID, sem recompilar nem reiniciar, e processou um vídeo real até `ready` (`60d7b463-…`).
      - **Restart do worker com a API no ar:** o worker recompilou o `dist-worker/` e trocou de PID (60 → 32). `dist/main.js` ficou intacto, a API seguiu no mesmo PID, respondendo 200, sem recompilar. Outro vídeo real chegou a `ready` (`7dc61c02-…`).
      - O `start:dev` foi parado ao fim.
    - **Regressão após a correção:** `tsc --noEmit` limpo. `npm run lint` com 0 erros e os 23 warnings pré-existentes. `npm run build` ok, com `dist/main.js` e `dist/worker.main.js` e sem `dist-worker` dentro de `dist/`. 262 unit/integration (38 suítes) e 76 e2e (7 suítes) passando.
    - Os vídeos e usuários `worker-check-*@example.com` dessas verificações ficaram no banco e no bucket de dev.
  - **Atualização condicional.** O `update` para `ready` usa `{ id, status: processing }`, para nunca sobrescrever um vídeo que saiu de `processing` durante o processamento.
  - **Arquivos fora da lista do plano.**
    - `worker.constants.ts`, com a posição do frame a 10%, o content-type e os nomes temporários.
    - `videoStorageKeys.thumbnail` em `videos.constants.ts`, ao lado de `original`.

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
