---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-11-20
scope_description: "Upload e processamento de vídeos: tecnologia de fila, uso do object storage S3-compatível (buckets/chaves, endpoints interno/público, CORS), protocolo de upload de até 10GB direto ao storage com pré-cadastro em rascunho, execução do worker FFmpeg, URL única por vídeo, streaming/download e ciclo de status com política de retry."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — API: orquestra o upload (pré-cadastro, assinatura de partes, conclusão), publica jobs na fila, emite URLs de streaming/download. Também hospeda o código do Video Worker (ver TD-04). Recebe novos serviços no `compose.yaml` (storage, fila, worker) e novas chaves de env no schema Joi (`phase-01-configuracao-base/TD-02`).
- `next-frontend/` — **Fora do escopo desta fase, sem slice de frontend** (decisão de escopo confirmada na sessão de 2026-11-20: o desafio da Fase 03 é só backend; os bullets da Fase 03 também não listam telas). Nenhum TD com `Scope: Frontend`. Os TDs marcados `Cross-layer` (TD-02, TD-03, TD-07, TD-08, TD-09) fixam apenas o **contrato da API** que um cliente HTTP (testes E2E agora, frontend em fase futura) consome. Nenhum código do `next-frontend/` é produzido nesta fase.

**Restrições herdadas (não reabertas):** NestJS 11 (`@nestjs/common@11.1.16` instalado), TypeORM 0.3 + PostgreSQL 17, guard JWT global (`phase-02-auth/TD-02`), filtro de exceções de domínio `{ statusCode, error, message }` (`phase-02-auth/TD-07`), config com `registerAs` + Joi (`phase-01-configuracao-base/TD-01..TD-04`), projeto **CommonJS** (`tsconfig` com `module: nodenext` e sem `"type": "module"` no `package.json`), Jest 30 + ts-jest 29. Object storage **S3-compatível** (MinIO em Docker no dev, S3 em produção): aqui só se decide o **uso**.

**Nota sobre ESM-only:** o Node 24/25 consegue fazer `require()` de ESM, mas o Jest 30 com ts-jest em modo CJS não transforma `node_modules` por padrão (`transformIgnorePatterns`). Por isso, pacotes ESM-only tendem a quebrar testes unitários e de integração sem ajuste extra de config. Isso pesa contra libs com `"type": "module"` em vários TDs abaixo. O formato de módulo foi conferido no registry npm em 2026-11-20; a quebra no Jest é inferência a partir do comportamento padrão documentado e **não foi reproduzida neste repositório**.

**Convenção de origem:** valores numéricos e políticas marcados com _(sugestão — sem origem normativa)_ não vêm do project-plan, de TDs anteriores nem da pesquisa citada. São pontos de partida a confirmar no `/plan-resolve` ou na implementação.

---

## TD-01: Tecnologia de Fila (Message Queue)

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** _Abrangência: Backend + infra (novo serviço no Compose, novas chaves de env)._ O diagrama C4 marca a fila como "TBD". A API publica um job de processamento quando o upload termina, e o Video Worker o consome (TD-04). A fila precisa de retry com backoff e de um estado de "falha final" observável (TD-10). Por isso, esta é a principal decisão de stack da fase. Também afeta os testes: os de integração rodam com `--runInBand` contra infraestrutura compartilhada, então a fila precisa permitir isolamento por prefixo ou namespace no ambiente de teste.

**Options:**

### Option A: BullMQ + Redis
- Fila sobre Redis com retry (`attempts` + `backoff` exponencial), `UnrecoverableError` para falha sem retry, detecção de jobs travados (stalled) e retenção configurável de jobs falhos. Integra no Nest via `@nestjs/bullmq` (`BullModule.forRootAsync` + `@Processor`/`WorkerHost`).
- **Pros:** padrão de fato no ecossistema Nest, com módulo oficial. API madura e bem documentada. Isolamento por `prefix` em testes. O BullMQ 6 também tem backend PostgreSQL (`createPostgresBackend`) com a mesma API, o que dá um caminho futuro para remover o Redis sem reescrever o código (backend lançado em 2026-07, ainda recente).
- **Cons:** adiciona o Redis ao Compose e à produção (mais um serviço stateful). **Fixar `@nestjs/bullmq@^11.0.5`**: a linha 12.x é ESM-only (`"type": "module"`), enquanto a 11.0.5 é CJS e já aceita `bullmq ^6`.
- **Libraries:** `bullmq@^6.7.8` (CJS em `dist/cjs`), `@nestjs/bullmq@^11.0.5`, cliente Redis `ioredis` (peer do bullmq).

### Option B: RabbitMQ (AMQP)
- Broker AMQP dedicado. Retry é implementado com dead-letter exchanges + TTL (ou o plugin de delayed messages), e a falha final vai para uma DLQ. No Nest: `@golevelup/nestjs-rabbitmq` ou `@nestjs/microservices` (transport RMQ).
- **Pros:** broker robusto e agnóstico de linguagem (útil se o worker sair do Node no futuro). Roteamento flexível.
- **Cons:** retry com backoff exige topologia manual (exchanges/filas de espera), sem nada pronto como `attempts`. Mais um serviço pesado no Compose. `@golevelup/nestjs-rabbitmq@9` exige `@nestjs/common ^11.1.24`, mais novo que o instalado (11.1.16), o que força um bump do Nest. Excesso para uma única fila de jobs.
- **Libraries:** `@golevelup/nestjs-rabbitmq@^9.1.2`, `amqplib@^2.4.0`.

### Option C: Amazon SQS (LocalStack no dev)
- Fila gerenciada da AWS. Retry via visibility timeout + `maxReceiveCount` e redrive para DLQ. No dev, um emulador (LocalStack).
- **Pros:** sem broker para operar em produção se o deploy for na AWS. Combina com S3 em produção.
- **Cons:** desde a 2026.03.0 o LocalStack exige auth token (conta) até para o uso gratuito, o que é atrito para dev e CI. Backoff exponencial não é nativo (só visibility timeout). `sqs-consumer@15` é ESM-only. Amarra a fila à AWS antes de a Fase 07 (deploy) decidir o provedor.
- **Libraries:** `@aws-sdk/client-sqs`, `sqs-consumer@^15` (ESM-only).

### Option D: pg-boss (fila sobre o PostgreSQL existente)
- Jobs persistidos no próprio PostgreSQL 17 (`SKIP LOCKED`). Tem `retryLimit`, `retryDelay`, `retryBackoff` e `deadLetter` por fila.
- **Pros:** zero infra nova (reusa o `db`). Retry e dead letter nativos. Permite enfileirar na mesma transação do update de status, no estilo outbox.
- **Cons:** `pg-boss@12` é **ESM-only** (`"type": "module"`, Node ≥ 22.12), o que conflita com o projeto CJS e o Jest. Sem módulo Nest oficial (wrapper manual). Cria um schema próprio fora das migrations TypeORM. Carga de polling no banco principal.
- **Libraries:** `pg-boss@^12.38.2` (ESM-only).

**Recommendation:** **Option A (BullMQ + Redis)** — é a única opção com módulo Nest oficial **em CJS** (`@nestjs/bullmq@11.0.5`) e com retry/backoff/falha final prontos, como o TD-10 precisa. O custo é um serviço Redis no Compose. O backend PostgreSQL do BullMQ 6 fica como saída futura se o Redis virar peso operacional. pg-boss seria a alternativa "sem infra nova", mas o ESM-only cria atrito direto com o projeto CommonJS e o Jest.

**Decision:** _[pending]_

---

## TD-02: Uso do Object Storage — Buckets/Chaves, Endpoint Interno vs Público e CORS

**Scope:** Cross-layer

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** _Abrangência: infra (serviço de storage no Compose, chaves de env) + Backend (clientes S3 na API e no worker) + cliente browser futuro (fará PUT/GET direto no storage via URL pré-assinada; nesta fase o cliente são os testes E2E por HTTP direto)._ O storage S3-compatível já está decidido. Falta decidir como usá-lo. Três pontos se acoplam:
1. Organização de buckets e chaves, compartilhada por API, worker e bootstrap.
2. **Endpoint:** dentro do Compose o storage é `minio:9000` (regra do CLAUDE.md), mas a URL pré-assinada é assinada com o *host* (SigV4) e precisa ser resolvível pelo browser.
3. **CORS:** o browser lê o header `ETag` de cada parte do multipart (TD-03), então o CORS precisa expor `ETag`.

_Risco de infra (não reabre a decisão S3):_ a MinIO parou de publicar imagens Docker da edição comunitária em 2025-10, e o repositório entrou em modo manutenção/arquivado (fontes de terceiros; ver pesquisa). **Verificação na máquina de desenvolvimento em 2026-11-20:**
- `docker pull minio/minio:latest` → "repository does not exist" (Docker Hub). A API do Docker Hub também responde 404 para `minio/mc`.
- `docker pull quay.io/minio/minio:latest` → 401 UNAUTHORIZED (Quay).
- `docker pull cgr.dev/chainguard/minio:latest` → OK, digest `sha256:e9cf6b99c226e9539ed0f14b6f00e37b07da153c7ba1f4f8709c807574b471ec`.
- `docker run` com volume nomeado em `/data` → o servidor sobe (`RELEASE.2026-11-16T00-11-40Z`, fork Chainguard), e `GET /minio/health/live` → 200 OK com `Accept-Ranges: bytes`. Sem volume, o log mostrou "Rename across devices not allowed" (overlayfs); com volume nomeado, o erro não ocorre.

**Restrições de infra para o Compose** (valem para qualquer opção abaixo):
1. **Imagem do storage:** `cgr.dev/chainguard/minio:latest@sha256:e9cf6b99c226e9539ed0f14b6f00e37b07da153c7ba1f4f8709c807574b471ec`. No plano gratuito a Chainguard só publica a tag `latest`, por isso o pin é feito pelo digest (com digest presente, a tag não decide qual imagem é baixada). Nunca usar `latest` sem digest. Risco residual: a Chainguard pode remover digests antigos, e o pull passa a falhar até o digest ser atualizado.
2. **`/data` em volume nomeado** (verificado: evita o erro "Rename across devices not allowed" do overlayfs).
3. **Console web em porta fixa** via `--console-address ":9001"` (opcional, para inspeção local).
4. **Imagem mínima, sem shell nem curl:** um healthcheck `CMD-SHELL` com `curl`/`wget` não roda dentro do container, então o `healthcheck` do serviço no Compose precisa de outra estratégia, a definir na implementação.
5. **Sem container `mc`** (`minio/mc` indisponível): o bootstrap do bucket e do CORS é feito via SDK (`CreateBucket`/`PutBucketCors`).

**Item a verificar no SI de infraestrutura (CORS):** nada na Fase 03 depende de CORS (frontend fora de escopo; os testes E2E enviam as partes por HTTP direto, sem browser), então a verificação fica para o SI de infraestrutura, sem bloquear a fase:
- Confirmar se `cgr.dev/chainguard/minio` aceita `PutBucketCors`. A documentação upstream do MinIO (`reference/s3-api-compatibility.rst`) lista `BucketCORS` como **não suportado** e diz que o CORS já vem habilitado por padrão em todos os buckets. Espera-se, portanto, que a chamada falhe nessa imagem.
- Se não aceitar, usar a configuração global de CORS do servidor pela variável de ambiente `MINIO_API_CORS_ALLOW_ORIGIN` (lista de origens separadas por vírgula, padrão `'*'`; confirmada em `docs/config/README.md` do MinIO, subsistema `api`), no serviço de storage do Compose. Nesse caso, o `PutBucketCors` da restrição 5 vale só para S3 em produção.

**Options:**

### Option A: Bucket único privado com prefixos + dois clientes S3 (interno e público)
- Um bucket privado (`S3_BUCKET`) com chaves `videos/{videoId}/original` e `videos/{videoId}/thumbnail.jpg`. Todo acesso do cliente é por URL pré-assinada. A API e o worker operam com um `S3Client` no endpoint interno (`http://minio:9000`). Um segundo `S3Client`, configurado com `S3_PUBLIC_ENDPOINT` (ex.: `http://localhost:9000`), é usado **só para assinar** (assinar é operação local, sem tráfego de rede). CORS no bucket: origem do cliente browser (frontend futuro), métodos `PUT/GET/HEAD`, `ExposeHeaders: ETag`. Nesta fase sem frontend, o CORS só é exercitado se algum teste usar browser; os testes E2E via HTTP direto não dependem dele.
- **Pros:** respeita a regra de service name do Compose para todo tráfego real. URLs assinadas válidas para o browser. Tudo privado (unlisted da Fase 04 continua protegido). Um bucket só simplifica bootstrap e lifecycle (ex.: regra `AbortIncompleteMultipartUpload`).
- **Cons:** duas configurações de endpoint para manter coerentes. Thumbnails em listagens (Fases 04/07) também precisam de URL assinada (barato, pois é offline, mas impede cache de CDN por URL estável). Configuração de CORS varia por provedor (ver o item "a verificar no SI de infraestrutura" acima: `PutBucketCors` vs `MINIO_API_CORS_ALLOW_ORIGIN`).
- **Libraries:** `@aws-sdk/client-s3@^3.1173.0`, `@aws-sdk/s3-request-presigner@^3.1173.0` (ambos com build CJS).

### Option B: Dois buckets — vídeos privado, thumbnails público-leitura
- `videos` privado (acesso por URL assinada) e `thumbnails` com policy de leitura pública (URL estável e cacheável). Mesmo esquema de dois clientes para assinar vídeos.
- **Pros:** thumbnails com URL estável, cacheável em CDN, sem assinatura por item em listagens grandes.
- **Cons:** policy pública diferente por ambiente. A thumbnail de vídeo unlisted ou rascunho fica pública para quem souber a chave. Mais um bucket para criar e configurar.
- **Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.

### Option C: Endpoint único público, inclusive para API e worker
- API e worker acessam o storage pelo mesmo hostname que o browser (ex.: `extra_hosts`/`host-gateway` ou um hostname resolvível dentro e fora do Compose). Um único `S3Client`.
- **Pros:** uma configuração só. URLs geradas sempre consistentes.
- **Cons:** contraria a regra de rede do CLAUDE.md (service name dentro do Compose). Frágil entre WSL, Linux e CI. Tráfego interno sai e volta pelo host.
- **Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.

**Recommendation:** **Option A** — mantém todo tráfego real em `minio:9000` (regra do CLAUDE.md) e resolve o problema do host assinado com um cliente só para assinar, sem custo de rede. Bucket único privado mantém vídeos unlisted e rascunhos protegidos. Chaves de env canônicas (contrato entre schema Joi, `compose.yaml` e `.env.example`): `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` (`true` para MinIO). A Option B pode ser revisitada na Fase 07 se o volume de thumbnails em listagens exigir CDN.

**Decision:** _[pending]_

---

## TD-03: Protocolo de Upload de até 10GB + Pré-cadastro em Rascunho

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** _Abrangência: Cross-layer — o handshake vive na API (orquestração) e no cliente (envio das partes); nesta fase o cliente são os testes E2E, e o frontend consumirá o mesmo contrato em fase futura; depende do TD-02._ Os bytes de até 10GB **não devem passar pela API** ("sem impacto na performance"). O upload deve poder ser **retomado** após falha de conexão (Pontos de Atenção do project-plan). O PUT único do S3 aceita no máximo **5GB**, então a URL pré-assinada simples é inviável para 10GB. O multipart do S3 aceita partes de 5MiB a 5GiB e até 10.000 partes. O vídeo é pré-cadastrado como rascunho no momento em que o upload começa.

**Options:**

### Option A: S3 Multipart com URLs pré-assinadas por parte (orquestrado pela API)
- Fluxo: (1) cliente autenticado chama a API para iniciar. A API valida o tamanho declarado (≤ 10GB, do project-plan) e o content-type (allowlist _(sugestão — sem origem normativa)_), **cria o vídeo em rascunho**, chama `CreateMultipartUpload` e devolve `videoId`, `uploadId`, `partSize` e `partCount`. (2) O cliente pede URLs assinadas por lote de partes e faz `PUT` direto no storage, guardando cada `ETag`. (3) O cliente envia as `ETag`s para a API, que faz `CompleteMultipartUpload`, confere o tamanho com `HeadObject` e enfileira o job (TD-01). Retomada: `ListParts` diz quais partes já subiram. Também há um endpoint de abort.
- **Pros:** zero bytes pela API. Retomada e paralelismo nativos do S3. Funciona igual em MinIO e S3. A API decide quando processar, no `complete`, sem precisar de notificações de bucket.
- **Cons:** 3–4 endpoints de orquestração. O cliente precisa coordenar partes, o que é mais elaborado que um POST único (nesta fase, os testes E2E fazem esse papel). Uploads abandonados deixam partes órfãs. **No dev (MinIO)**, o servidor as expira sozinho: `MINIO_API_STALE_UPLOADS_EXPIRY` remove uploads multipart abandonados com mais de 24h (padrão), e a varredura roda a cada `MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL` (padrão 6h) (documentação do MinIO, `docs/config/README.md`, subsistema `api`; documentação upstream, não verificada no fork da Chainguard). **Em produção (S3)**, o equivalente é a regra de lifecycle `AbortIncompleteMultipartUpload` já citada no TD-02. Nenhum dos dois limpa o registro do vídeo em rascunho no banco, que continua precisando de limpeza própria de rascunhos parados. Um cliente browser futuro exige CORS expondo `ETag` (TD-02).
- **Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.

### Option B: Protocolo tus (servidor tus com store S3)
- Servidor tus (`@tus/server` + `@tus/s3-store`) montado na API ou em um serviço próprio. O cliente usa `tus-js-client`/Uppy. O servidor recebe os chunks e os grava no S3 como multipart.
- **Pros:** protocolo de retomada padronizado e maduro. Cliente simples.
- **Cons:** **os bytes passam pelo servidor tus**, o que contradiz "sem passar pela API" (ou exige mais um serviço dimensionado para 10GB de throughput). `@tus/server@2` é ESM-only. Hooks para pré-cadastro e autenticação JWT exigem integração manual com o guard global.
- **Libraries:** `@tus/server@^2.4.7` (ESM-only), `@tus/s3-store`, `tus-js-client`.

### Option C: Proxy streaming pela API
- O cliente envia multipart/form-data ou um stream para a API, que repassa ao S3 em streaming (`@aws-sdk/lib-storage` `Upload`), sem bufferizar em disco.
- **Pros:** cliente trivial. Validação e autenticação no mesmo request.
- **Cons:** 10GB atravessam a API (CPU, rede, conexões longas, timeouts de proxy). Sem retomada: uma queda reinicia do zero. Contradiz a arquitetura ("API uploads to storage" vale para arquivos pequenos, não para o vídeo bruto).
- **Libraries:** `@aws-sdk/lib-storage@^3.1173.0`, `busboy`.

**Recommendation:** **Option A** — é a única que atende ao mesmo tempo "10GB sem impacto" (bytes direto no storage), "retomar em caso de falha" (`ListParts`) e o limite de 5GB do PUT único. O pré-cadastro em rascunho acontece no endpoint de início, e o enfileiramento acontece no `complete`, que é idempotente. Parâmetros _(sugestão — sem origem normativa)_: partes de 64MiB (cerca de 160 partes para 10GB, bem abaixo do limite de 10.000) e URLs de parte com expiração curta (ex.: 1h, renováveis por lote). Depende do TD-02.

**Decision:** _[pending]_

---

## TD-04: Execução do Video Worker (processo, container e entrypoint)

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** _Abrangência: Backend + infra (novo serviço `video-worker` no Compose, imagem com FFmpeg)._ O diagrama C4 define o Video Worker como container separado, que consome a fila e atualiza DB e storage. O processamento com FFmpeg consome muita CPU e não pode competir com o tráfego HTTP da API. O worker precisa das mesmas entidades (`Video`), da mesma config Joi e do mesmo cliente S3 da API.

**Options:**

### Option A: Mesmo código (`nestjs-project/`), segundo entrypoint, container próprio
- Um `src/worker.ts` sobe `NestFactory.createApplicationContext(WorkerModule)` (sem HTTP), registrando só o processor da fila, TypeORM, config e S3. Novo serviço `video-worker` no `compose.yaml` com imagem baseada no `Dockerfile.dev` + `ffmpeg` instalado via apt. A API não registra processor, só produz jobs.
- **Pros:** reusa entidades, config, migrations e testes sem pacote compartilhado. Isolamento de CPU por container, como no diagrama. Escala horizontal independente da API.
- **Cons:** a imagem do worker carrega o código da API (maior). Dois processos para subir em dev. Os testes precisam isolar a fila (prefixo de teste) para um worker rodando não consumir jobs dos testes.
- **Libraries:** nenhuma nova além da fila (TD-01). FFmpeg/ffprobe como binário do sistema na imagem.

### Option B: Subprojeto separado (`video-worker/`)
- Novo pacote na raiz do monorepo com `package.json`, Dockerfile e entidades próprias.
- **Pros:** fronteira de deploy explícita. Imagem enxuta. Permitiria outra linguagem no futuro.
- **Cons:** duplica entidade `Video`, config e cliente S3 (o monorepo não tem workspaces nem `packages/*` para compartilhar). Risco de divergência de schema. Mais um subprojeto com lint, testes e CI.
- **Libraries:** as mesmas, duplicadas.

### Option C: Processor dentro da API (mesmo processo) ou sandboxed processor
- O processor da fila é registrado no `AppModule` da API, opcionalmente como sandboxed processor do BullMQ (processo filho ou worker thread).
- **Pros:** zero serviço novo. Mais simples de rodar em dev.
- **Cons:** FFmpeg disputa CPU e memória com a API (mesmo com sandbox, é o mesmo container). Contradiz o container separado do diagrama. Escalar o processamento obriga a escalar a API.
- **Libraries:** as da fila.

**Recommendation:** **Option A** — cumpre o container separado do diagrama sem criar um pacote compartilhado inexistente. O worker é um "modo" da mesma aplicação Nest, com módulo raiz próprio. O isolamento da fila em testes (prefixo por ambiente) deve constar no plano, porque os testes de integração rodam `--runInBand` contra infra compartilhada.

**Decision:** _[pending]_

---

## TD-05: Integração com FFmpeg/ffprobe (spawn direto vs wrapper)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** _Abrangência: Backend (código do worker) + infra (binário na imagem, TD-04)._ O worker roda o `ffprobe` (duração, codec, resolução) e o `ffmpeg` (um frame vira JPEG). `fluent-ffmpeg`, o wrapper mais conhecido, está **deprecated no npm** ("Package no longer supported", v2.1.3) e com o **repositório arquivado**.

**Options:**

### Option A: `child_process` direto (spawn/execFile) com módulo próprio fino
- Um serviço `FfmpegService` com dois métodos: `probe(input)`, que executa `ffprobe -v error -print_format json -show_format -show_streams` e parseia o JSON, e `extractFrame(input, at, output)`, que executa `ffmpeg -ss <t> -i <input> -frames:v 1 ...`. Os argumentos vão como array (`execFile`/`spawn`), sem shell, com timeout e captura de stderr.
- **Pros:** zero dependência. Sem risco de manutenção. JSON do ffprobe tipável. Fácil de mockar em teste unitário.
- **Cons:** é preciso escrever o parse e o tratamento de erro/timeout (pouco código, mas é nosso).
- **Libraries:** nenhuma (Node `child_process`).

### Option B: `fluent-ffmpeg`
- Wrapper fluente clássico (`ffprobe()`, `.screenshots()`).
- **Pros:** API conhecida, muitos exemplos.
- **Cons:** **deprecated e arquivado**: sem correções de segurança ou compatibilidade com novas versões do FFmpeg. Tipos via `@types` externo.
- **Libraries:** `fluent-ffmpeg@2.1.3` (deprecated), `@types/fluent-ffmpeg`.

### Option C: Binário via npm (`ffmpeg-static`/`ffprobe-static`) + spawn
- Igual à A, mas o binário vem de um pacote npm em vez do apt da imagem.
- **Pros:** versão do binário fixada pelo lockfile. Funciona fora do Docker.
- **Cons:** binários grandes no `node_modules` montado por volume (o dev já roda em Docker, então a vantagem é pequena). Manutenção desses pacotes é de terceiros. Não muda o código de invocação.
- **Libraries:** `ffmpeg-static`, `ffprobe-static`.

**Recommendation:** **Option A** — com o `fluent-ffmpeg` deprecated e arquivado, um módulo próprio de duas funções sobre `execFile` é menor que o risco de depender de um wrapper morto. O binário vem do apt na imagem do worker (TD-04).

**Decision:** _[pending]_

---

## TD-06: Acesso do Worker ao Arquivo (download completo vs leitura por URL pré-assinada)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** _Abrangência: Backend (worker) + infra (disco do container do worker)._ Baixar 10GB para extrair a duração e um frame custa disco, tempo e rede. O FFmpeg e o ffprobe leem entradas HTTP(S) e fazem seek com requests `Range`, então podem ler só os trechos necessários (cabeçalho/`moov`, frame alvo). Depende do TD-02 (endpoint interno) e do TD-05.

**Options:**

### Option A: Ler por URL pré-assinada (GET) gerada para o endpoint interno
- O worker gera uma URL GET de curta duração com o cliente **interno** (`minio:9000`) e a passa como `-i` para o ffprobe e o ffmpeg. Só a thumbnail gerada é gravada em disco temporário e enviada com `PutObject`.
- **Pros:** sem baixar 10GB. Uso de disco mínimo. Processamento rápido mesmo com arquivos enormes.
- **Cons:** depende de o storage suportar `Range` (S3 e MinIO suportam). MP4 com `moov` no final exige um request extra de range (o FFmpeg faz seek em entradas HTTP; comportamento conhecido, mas **não verificado nesta pesquisa**: validar com um arquivo de teste na implementação). Erros de rede viram erros do job (retry no TD-10).
- **Libraries:** `@aws-sdk/s3-request-presigner`.

### Option B: Download completo para disco temporário
- O worker baixa o objeto (`GetObject` em stream para arquivo) e roda o FFmpeg localmente.
- **Pros:** FFmpeg sobre arquivo local é o caminho mais previsível. Facilita transformações futuras que leem o arquivo inteiro.
- **Cons:** até 10GB de disco por job concorrente. Tempo de download antes de qualquer resultado. Precisa limpar o temporário em caso de falha.
- **Libraries:** `@aws-sdk/client-s3`.

### Option C: Stream do `GetObject` via stdin do FFmpeg (`-i pipe:0`)
- O corpo do `GetObject` é encadeado direto no stdin do processo.
- **Pros:** sem disco e sem URL assinada.
- **Cons:** pipe não permite seek. O ffprobe falha ou lê o arquivo inteiro quando o `moov` está no final, e extrair um frame no meio exige consumir o stream até ele. Pior das duas opções para MP4.
- **Libraries:** `@aws-sdk/client-s3`.

**Recommendation:** **Option A** — o caso de uso (metadados + 1 frame) é justamente o que range/seek HTTP resolve sem baixar o arquivo. Se uma fase futura exigir transcodificação completa, a Option B pode ser adotada para esse job específico.

**Decision:** _[pending]_

---

## TD-07: Estratégia de URL Única por Vídeo

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** _Abrangência: Cross-layer — o identificador público aparece nas rotas do frontend (ex.: `/watch/{id}`, Fase 05) e nos endpoints da API; afeta o schema da tabela `videos`._ Os Pontos de Atenção pedem uma URL **curta** e única que nunca conflite. O projeto é CommonJS: `nanoid@6` e `uuid@14` são **ESM-only** (`"type": "module"`), o que gera o atrito com o Jest descrito no topo. O identificador público pode ser separado da PK interna.

**Options:**

### Option A: ID aleatório curto gerado com `node:crypto` (base64url/base62) + índice UNIQUE
- `public_id` curto (ex.: 11 caracteres, cerca de 64 bits de entropia _(sugestão — sem origem normativa)_) gerado com `crypto.randomBytes`/`randomInt` sobre um alfabeto URL-safe, separado da PK. Coluna com `UNIQUE`. Em violação `23505`, gera de novo e repete (mesmo código de erro já tratado em `src/channels/channels.service.ts`, `PG_UNIQUE_VIOLATION`).
- **Pros:** zero dependência e zero problema de ESM. Curto e não enumerável (não revela volume nem ordem). Colisão praticamente impossível, e o UNIQUE + retry garante "nunca conflita".
- **Cons:** é preciso escrever um gerador pequeno (alfabeto + rejeição de viés) e o loop de retry.
- **Libraries:** nenhuma (Node `crypto`).

### Option B: Sqids sobre ID sequencial
- Codifica a PK numérica em uma string curta e reversível (`sqids`, dual CJS/ESM).
- **Pros:** curto, determinístico, sem colisão por construção. Pacote CJS-compatível.
- **Cons:** reversível e ordenável: com o alfabeto, revela volume e ordem e permite enumerar vídeos unlisted (Fase 04/05). Não é mecanismo de sigilo (é codificação, não criptografia). Exige PK sequencial.
- **Libraries:** `sqids@^0.3.0`.

### Option C: UUID (v4/v7) como identificador público
- `crypto.randomUUID()` (v4, nativo) ou UUID v7 ordenável.
- **Pros:** nativo (v4), sem colisão prática, padrão universal.
- **Cons:** 36 caracteres: não é "curto". O v7 expõe o timestamp de criação. A lib `uuid@14` é ESM-only (só o v4 nativo escapa).
- **Libraries:** nenhuma para v4 (Node `crypto`). `uuid@^14` (ESM-only) para v7.

### Option D: `nanoid`
- Gerador de IDs curtos e seguros com alfabeto customizável.
- **Pros:** API pronta (`customAlphabet`), bem conhecida.
- **Cons:** `nanoid@6` é ESM-only. Usar a linha 3.x (CJS) significa fixar uma versão legada. O ganho sobre a Option A são poucas linhas.
- **Libraries:** `nanoid@^6.0.2` (ESM-only) ou `nanoid@3` (legado CJS).

**Recommendation:** **Option A** — entrega o que o nanoid entregaria (curto, aleatório, não enumerável) sem dependência ESM-only. A garantia de "sem conflito" fica no banco (UNIQUE + retry), não em probabilidade. A não-enumerabilidade importa porque vídeos unlisted (Fase 04) dependem de o link não ser adivinhável.

**Decision:** _[pending]_

---

## TD-08: Streaming e Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** _Abrangência: Cross-layer — a API autoriza e emite a URL; o storage serve os bytes; o player (frontend futuro, Fase 05) consome o mesmo contrato. Depende do TD-02 e do TD-07._ O diagrama C4 diz "Frontend **streams from Object Storage**", então os bytes do vídeo não passam pela API. A reprodução sem download completo exige requests HTTP `Range` (206), que o S3 e o MinIO suportam nativamente. O download precisa de `Content-Disposition: attachment`. O acesso anônimo é permitido (Fase 05), mas rascunhos e unlisted exigem controle, então URL pública permanente não serve.

**Options:**

### Option A: Endpoint da API que autoriza e redireciona (302) para URL GET pré-assinada
- `GET /videos/{publicId}/stream` e `GET /videos/{publicId}/download` (rotas públicas via o decorator `@Public()` existente em `src/auth/decorators/public.decorator.ts`, que libera o guard JWT global) validam o estado do vídeo e respondem 302 para uma URL assinada de curta duração. No download, a URL leva `ResponseContentDisposition=attachment; filename=...`. O `<video>` segue o redirect e faz os `Range` direto no storage.
- **Pros:** fiel ao diagrama (bytes saem do storage). Seek nativo via `Range`. Controle de acesso por request. Download e streaming com o mesmo mecanismo. Zero processamento extra.
- **Cons:** URL assinada expira (escolher validade compatível com sessões longas de vídeo; o player pode pedir de novo). Reprodução progressiva de arquivo único, sem bitrate adaptativo.
- **Libraries:** `@aws-sdk/s3-request-presigner`.

### Option B: Proxy de `Range` (206) pela API
- A API recebe o `Range`, faz `GetObject` com o mesmo range e repassa o stream.
- **Pros:** URL estável, sem expiração. Controle total de headers.
- **Cons:** todo o tráfego de vídeo passa pela API, o oposto do diagrama e do "sem impacto na performance". A API vira gargalo de banda.
- **Libraries:** `@aws-sdk/client-s3`.

### Option C: HLS (segmentos + playlist) gerado pelo worker
- O worker transcodifica para HLS (`.m3u8` + segmentos) e o player usa `hls.js`.
- **Pros:** bitrate adaptativo. Padrão de plataformas de vídeo.
- **Cons:** transcodificação não está nos bullets da fase (processamento = metadados + thumbnail). Multiplica CPU e storage. Segmentos privados exigem assinar cada segmento ou reescrever o manifesto. O download continua precisando do original.
- **Libraries:** `hls.js` (frontend). FFmpeg (worker).

**Recommendation:** **Option A** — atende "streaming sem download completo" com `Range` nativo do storage, respeita o "Frontend streams from Object Storage" do diagrama e reaproveita o mesmo mecanismo para download. HLS fica como evolução futura, fora do escopo da Fase 03.

**Decision:** _[pending]_

---

## TD-09: Modelo de Status do Vídeo

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** _Abrangência: Cross-layer — o status é exposto pela API (o painel da Fase 04 mostra "status", conforme o project-plan); define colunas e enum da tabela `videos`._ A Fase 03 cria o vídeo "como rascunho". A Fase 04 traz o "fluxo de rascunho → publicação" e a visibilidade público/unlisted. Há duas dimensões possivelmente distintas: o **estado técnico do arquivo** (enviando, processando, pronto, erro) e o **estado editorial** (rascunho, publicado). O modelo escolhido aqui condiciona a Fase 04.

**Critério de aceite externo:** o desafio do MBA exige "rascunho → processando → pronto/erro refletido no banco" (informado na sessão de 2026-11-20; não consta no `project-plan.md`). As opções abaixo são avaliadas também pela aderência literal a esse critério.

**Options:**

### Option A: Dois eixos ortogonais — `processing_status` + estado editorial
- `processing_status`: `uploading → processing → ready | failed` (Fase 03). Estado editorial `draft` na criação (o estado publicado seria adicionado pela Fase 04, junto com a visibilidade). Um vídeo pode estar `draft` + `ready` (processado, ainda não publicado). Que a publicação exija `ready` é uma regra da Fase 04 _(sugestão — sem origem normativa)_.
- **Pros:** cada eixo tem um dono e transições simples. A Fase 04 adiciona publicação sem mexer no ciclo de processamento. O painel mostra os dois com clareza.
- **Cons:** duas colunas e regras de combinação (ex.: impedir publicado com `failed`). **Não é literal ao critério de aceite**: o banco mostra `uploading → processing → ready|failed` em uma coluna e `draft` em outra, e a correspondência com "rascunho → processando → pronto/erro" exige explicação.
- **Libraries:** nenhuma.

### Option B: Enum único linear
- `draft(uploading) → processing → ready → published | failed`.
- **Pros:** uma coluna. Simples de consultar.
- **Cons:** mistura arquivo e editorial. Despublicar, reprocessar ou falhar depois de publicado gera estados ambíguos. Antecipa na Fase 03 um estado (`published`) que pertence à Fase 04.
- **Libraries:** nenhuma.

### Option C: Status de processamento derivado do estado do job na fila
- O banco guarda só o editorial. "Processando/erro" vem de consultar a fila pelo job do vídeo.
- **Pros:** sem duplicação de estado.
- **Cons:** acopla a API ao backend de fila. O estado se perde quando o job é removido pela retenção. Listagens (Fase 04) teriam de consultar a fila vídeo a vídeo. **Não atende ao critério de aceite**, que exige o estado "refletido no banco".
- **Libraries:** as da fila.

### Option D: Eixo único da Fase 03 — `draft → processing → ready | failed`
- Uma coluna `status` com quatro valores: `draft` no pré-cadastro (upload iniciado, ainda não concluído), `processing` após o `complete` do upload, e `ready` ou `failed` ao fim do job. Corresponde termo a termo ao critério de aceite "rascunho → processando → pronto/erro refletido no banco". Nenhum estado da Fase 04 é antecipado.
- **Pros:** aderência literal e verificável ao critério de aceite (uma consulta à tabela mostra a transição). Uma coluna, transições lineares e simples de testar. Não inventa estados fora do escopo da fase.
- **Cons:** `draft` aqui significa "upload não concluído", mas na Fase 04 "rascunho" é estado editorial (não publicado). Um vídeo `ready` ainda não publicado é editorialmente um rascunho, mas `status` dirá `ready`. A Fase 04 terá de modelar a publicação em campo próprio (ex.: data de publicação ou visibilidade) ou ressignificar o enum, com migration. Também não distingue upload em andamento de upload abandonado (ambos `draft`).
- **Libraries:** nenhuma.

**Recommendation:** **Option D** — o critério de aceite do desafio pede literalmente "rascunho → processando → pronto/erro" no banco, e D o atende sem tradução nem estados da Fase 04 antecipados. A colisão semântica com o "rascunho" editorial fica explícita para a Fase 04, que pode resolvê-la com um campo de publicação próprio, sem reescrever este enum. A Option A continua sendo a modelagem mais limpa no longo prazo se a aderência literal ao critério não for exigência de avaliação. _(Recomendação revista em 2026-11-20 após o critério de aceite ser informado; antes era A.)_

**Decision:** _[pending]_

---

## TD-10: Política de Retry e Falha Final do Processamento

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** _Abrangência: Backend (worker + API) — o resultado final fica no status do vídeo no banco (TD-09) e é exposto pela API. Depende do TD-01 e do TD-09._ Falhas podem ser transitórias (rede com o storage, worker reiniciado no meio do job) ou permanentes (arquivo que não é vídeo, codec ilegível). É preciso decidir quantas tentativas fazer, com qual espera, como distinguir os dois tipos e o que acontece depois da última tentativa.

**Options:**

### Option A: Retry nativo da fila + erro irrecuperável + handler de falha final
- Job com N tentativas e backoff exponencial (ex.: `attempts: 3`, 30s de base _(sugestão — sem origem normativa)_). Erros de mídia inválida (ffprobe sem stream de vídeo) lançam erro **irrecuperável** (`UnrecoverableError` no BullMQ) e falham na hora. No evento de falha final (tentativas esgotadas ou irrecuperável), o worker grava o status de falha do TD-09 e, opcionalmente, um código curto do motivo _(sugestão — sem origem normativa)_. O job falho fica retido para diagnóstico. O processamento é idempotente (reprocessar sobrescreve thumbnail e metadados). Manter o objeto original na falha é _(sugestão — sem origem normativa)_.
- **Pros:** usa o que a fila entrega pronto. Diferencia transitório de permanente. O estado final fica no banco (TD-09). Jobs travados por queda do worker são re-entregues pelo stalled check.
- **Cons:** o handler de falha final precisa ser confiável (se ele próprio falhar, o vídeo fica em processamento indefinidamente). Pede uma salvaguarda, como um job de reconciliação _(sugestão — sem origem normativa)_.
- **Libraries:** as da fila (TD-01).

### Option B: Retry nativo + dead-letter queue + reprocessamento manual
- Igual à A, mas o job esgotado vai para uma DLQ, e um endpoint ou comando administrativo reenfileira.
- **Pros:** trilha explícita de falhas. Reprocessamento sob demanda sem novo upload.
- **Cons:** precisa de uma superfície administrativa que a fase não pede. No BullMQ a "DLQ" é o próprio conjunto de failed (redundante). Mais escopo.
- **Libraries:** as da fila.

### Option C: Sem retry automático — falhou, marca erro
- Uma tentativa só. Qualquer erro vira `failed`, e o usuário refaz o upload.
- **Pros:** mínimo de código. Comportamento óbvio.
- **Cons:** falhas transitórias (rede, restart do worker) viram erro definitivo, e o usuário reenvia 10GB por um soluço de rede. Contradiz o processamento "automático".
- **Libraries:** nenhuma.

**Recommendation:** **Option A** — poucas tentativas com backoff exponencial cobrem falhas transitórias. O erro irrecuperável evita gastar tentativas em arquivo inválido. O estado `failed` no banco dá uma resposta definitiva, como o critério de aceite exige ("pronto/erro refletido no banco"). Reprocessamento manual (Option B) fica para quando houver painel administrativo.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend (+ infra Compose/env) | Tecnologia de fila | A — BullMQ + Redis (`@nestjs/bullmq@^11.0.5`, CJS) | _[pending]_ |
| TD-02 | Cross-layer (+ infra Compose/env) | Uso do object storage: buckets/chaves, endpoints, CORS | A — bucket único privado + cliente interno e cliente de assinatura público | _[pending]_ |
| TD-03 | Cross-layer | Protocolo de upload 10GB + pré-cadastro em rascunho | A — S3 multipart com URLs pré-assinadas por parte | _[pending]_ |
| TD-04 | Backend (+ infra Compose) | Execução do Video Worker | A — mesmo código, segundo entrypoint, container próprio | _[pending]_ |
| TD-05 | Backend | Integração FFmpeg/ffprobe | A — `child_process` direto (fluent-ffmpeg deprecated) | _[pending]_ |
| TD-06 | Backend | Acesso do worker ao arquivo | A — leitura por URL pré-assinada (Range/seek) | _[pending]_ |
| TD-07 | Cross-layer | URL única por vídeo | A — ID curto aleatório via `node:crypto` + UNIQUE | _[pending]_ |
| TD-08 | Cross-layer | Streaming e download | A — API autoriza e redireciona 302 para URL pré-assinada | _[pending]_ |
| TD-09 | Cross-layer | Modelo de status do vídeo | D — eixo único `draft → processing → ready \| failed` (literal ao critério de aceite) | _[pending]_ |
| TD-10 | Backend | Retry e falha final | A — retry nativo + irrecuperável + handler de falha final | _[pending]_ |
