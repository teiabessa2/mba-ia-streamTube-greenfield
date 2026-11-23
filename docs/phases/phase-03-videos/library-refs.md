---
libs:
  "bullmq":
    version: "^6.7.8"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-23T16:12:29-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-23T16:12:29-03:00"
  "ioredis":
    version: "peer de bullmq (não fixada)"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-11-23T16:12:29-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1173.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-23T16:12:29-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1173.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-23T16:12:29-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-23T15:41:23-03:00"
---

# Library References — phase-03-videos

_Excertos obtidos via Context7 em 2026-11-23, filtrados para o uso desta fase (TD-01, TD-02, TD-03, TD-06, TD-08, TD-10, TD-12, TD-13)._

> **Divergência de versão (sinalizada):** o Context7 indexa o `bullmq` até `v6.5.3` e o `aws-sdk-js-v3` até `v3.1153.0` (mais o branch `main`); os TDs fixam `bullmq@^6.7.8` e `@aws-sdk/*@^3.1173.0`. Os excertos abaixo vêm do branch principal (`master`/`main`). As APIs usadas aqui são estáveis entre essas versões, mas confira o changelog ao instalar.

### bullmq

_Uso: TD-01 (fila), TD-10 (retry/falha final), TD-13 (testes)._

- **Retry com backoff exponencial** — é configurado por job em `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } })`. O atraso é `2^(attempts-1) * delay` ms. Para o TD-10 (3 tentativas), defina isso nas `defaultJobOptions` da fila ou em cada `add`.
- **Falha definitiva sem retry** — lance `UnrecoverableError` (de `bullmq`) dentro do processor. O job vai direto para o set `failed`, ignorando `attempts`. Use para arquivo inválido / ffprobe que rejeita o arquivo (TD-11 → `failed` do TD-09).
- **Conexão Redis** — workers exigem `maxRetriesPerRequest: null` no ioredis. O `Worker` já força esse valor por padrão; se você passar uma instância ioredis própria com outro valor, o BullMQ emite um warning (não ignore).
- **Testes (TD-13)** — aguarde a conclusão do job com `await job.waitUntilFinished(queueEvents)`, usando `new QueueEvents(queueName, { connection, prefix })` e `await queueEvents.waitUntilReady()`. Isole as filas por teste com a opção `prefix` (e/ou nome único por teste); `Queue`, `Worker` e `QueueEvents` precisam compartilhar o mesmo `prefix`. Limpe com `queue.obliterate({ force: true })` e feche com `worker.close()`.

### @nestjs/bullmq

_Uso: TD-01, TD-04 (entrypoint do worker), TD-10._

- **Registro global**: `BullModule.forRootAsync({ inject: [...], useFactory: (cfg) => ({ connection: {...} }) })`. No projeto, injete o factory `registerAs` (`@Inject(queueConfig.KEY)` / `inject: [queueConfig.KEY]`), conforme a convenção herdada da Fase 01. Filas: `BullModule.registerQueue({ name })`. Produtor: `@InjectQueue(name) queue: Queue`.
- **Processor**: uma classe com `@Processor('videos')` que estende `WorkerHost` e implementa `async process(job: Job, token?: string): Promise<any>`. Uma exceção lançada faz o job falhar e ser retentado conforme as opções do job.
- **Eventos do worker**: `@OnWorkerEvent('failed') onFailed(job: Job, err: Error)` serve de gancho para o handler de falha final do TD-10. Verifique `job.attemptsMade >= job.opts.attempts` ou `err instanceof UnrecoverableError` antes de gravar `failed`. Os listeners são ignorados em processors request-scoped.
- **Acesso ao `Worker`**: o getter `this.worker` só fica disponível depois do `onModuleInit`; use-o a partir do `onApplicationBootstrap`.

### ioredis

_Uso: conexão da fila (TD-01), peer do bullmq._

- `new Redis({ host, port, maxRetriesPerRequest: null })` — `null` desativa o flush de comandos pendentes (o padrão é 20 tentativas), o que é obrigatório para conexões de worker do BullMQ.
- A reconexão automática é o padrão (`retryStrategy` com backoff exponencial limitado a 5s mais jitter), exceto após `disconnect()`/`quit()`.
- Encerramento: `await redis.quit()`. Feche as conexões no teardown dos testes para não deixar handles abertos no Jest.
- Host via env com o nome do serviço do Compose (ex.: `REDIS_HOST=redis`), nunca `localhost` (regra do CLAUDE.md).

### @aws-sdk/client-s3

_Uso: TD-02 (clientes interno/público), TD-03 (multipart), TD-12 (abort)._

- **MinIO**: `new S3Client({ endpoint, region, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true })`. Na v3 a opção se chama `forcePathStyle` (era `s3ForcePathStyle` na v2). Cliente interno com `endpoint=S3_ENDPOINT` (ex.: `http://minio:9000`); cliente de assinatura com `endpoint=S3_PUBLIC_ENDPOINT` (TD-02).
- **Fluxo multipart (TD-03)**: `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; o cliente envia cada parte para uma URL pré-assinada de `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })`; `ListPartsCommand({ Bucket, Key, UploadId })` permite retomar; `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })`.
- **Regras das partes**: `PartNumber` é um inteiro de 1 a 10.000. As `Parts` do complete devem estar **ordenadas ascendentemente por PartNumber** (e consecutivas quando houver checksums), senão a resposta é 400 `InvalidPartOrder`. Cada parte precisa do `ETag` devolvido pelo PUT.
- **CORS**: para upload pelo browser com URL pré-assinada, o bucket precisa expor o header `ETag` (`ExposeHeaders: ["ETag"]`); sem isso o cliente não consegue ler o ETag da parte (TD-02).
- **Abort (TD-12)**: `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` descarta as partes já enviadas.
- **Leitura (TD-08)**: `GetObjectCommand` aceita `Range` e `ResponseContentDisposition` / `ResponseContentType`, que sobrescrevem os headers da resposta (útil para `attachment; filename="..."` no download).

### @aws-sdk/s3-request-presigner

_Uso: TD-03 (URLs de parte), TD-06 (leitura pelo worker), TD-08 (stream/download 302)._

- `getSignedUrl(client, command, { expiresIn })` — o `expiresIn` padrão é **900s**. O TD-03 sugere 1h (`3600`) para as partes.
- Assine com o **cliente cujo `endpoint` é o host que vai consumir a URL**: o cliente público para URLs entregues ao browser/consumidor HTTP (upload de partes, 302 de stream/download); o cliente interno (`minio:9000`) para a URL lida pelo ffprobe/ffmpeg no worker (TD-06).
- O presigner marca o payload como `UNSIGNED-PAYLOAD` e não assina `content-type`, então o corpo das partes não é verificado pela assinatura. Se quiser integridade por parte, envie `Content-MD5` ou um header `x-amz-checksum-*` declarado em `unhoistableHeaders`.
- Download (TD-08): `getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="..."' }), { expiresIn })`; o streaming usa o mesmo comando sem `ResponseContentDisposition`. O storage atende `Range` (206) nativamente.
