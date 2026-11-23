---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 16
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-22T20:01:54-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-20T17:19:28-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "'sem impacto na performance' no upload de 10GB não tem critério mensurável"
  - id: AMB-2
    status: open
    summary: "Controle de acesso a streaming/download por status e autenticação indefinido"
  - id: AMB-3
    status: open
    summary: "Conjunto de 'metadados' a extrair e persistir no processamento não definido"
  - id: MD-1
    status: resolved
    summary: "Sem TD para formatos de vídeo aceitos e estratégia de validação do arquivo"
    resolved_by: phase-03-videos/TD-11
  - id: MD-2
    status: resolved
    summary: "Sem TD para ciclo de vida de uploads abandonados / rascunhos órfãos"
    resolved_by: phase-03-videos/TD-12
  - id: MD-3
    status: resolved
    summary: "Sem estratégia de teste para worker, fila, storage e FFmpeg (fora do guia)"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Tecnologia de Fila (Message Queue)"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — Uso do Object Storage (buckets/chaves, endpoints, CORS)"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — Protocolo de upload de até 10GB + pré-cadastro em rascunho"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — Execução do Video Worker (processo, container, entrypoint)"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Integração com FFmpeg/ffprobe (spawn direto vs wrapper)"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — Acesso do worker ao arquivo (download vs URL pré-assinada)"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — Estratégia de URL única por vídeo"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — Streaming e download"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Modelo de status do vídeo"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Política de retry e falha final do processamento"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — Formatos aceitos e validação do arquivo de vídeo"
  - id: OQ-12
    status: open
    summary: "TD-12 pending — Uploads abandonados: destino do rascunho no banco"
  - id: OQ-13
    status: open
    summary: "TD-13 pending — Estratégia de testes de worker, fila, storage e FFmpeg"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._ _(todos os `Capability:` dos TDs citam bullets presentes em `## Scope`; nenhum TD com `Scope: Frontend`, portanto a checagem de órfão não se aplica; sem TDs decididos para conflitar entre si)_

### Ambiguities

- **AMB-1** — A capability "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" não define o que significa "sem impacto na performance": memória da API limitada (sem buffer do arquivo em RAM/disco do container)? Throughput mínimo? Número de uploads concorrentes suportados? Retomada após queda de conexão? O deliverable diz apenas "upload de até 10GB funcional". Explicit choice: fixar o critério de aceite verificável (ex.: "a API nunca recebe os bytes do vídeo" / "consumo de memória da API constante independente do tamanho" / "upload retomável") — pode ser registrado como parâmetro do TD-03 ao decidi-lo, ou como clarificação no `project-plan.md`.
- **AMB-2** — "Reprodução via streaming" e "Download do vídeo pelo usuário" não definem **quem** pode acessar e **em qual status**. O projeto diz que anônimos assistem livremente, mas nesta fase todo vídeo nasce como rascunho e a publicação pertence à Fase 04 ("Gerenciamento de Vídeos e Canal"). Perguntas em aberto: (a) download exige autenticação ou é livre como o streaming? (b) vídeos em rascunho/processando podem ser transmitidos/baixados — só pelo dono? (c) a fronteira com a Fase 04 (visibilidade/publicação) fica onde? Explicit choice: definir a regra de acesso para esta fase (provavelmente via TD-08 + TD-09) e declarar explicitamente o que fica para a Fase 04.
- **AMB-3** — "Processamento automático do vídeo após upload (extração de duração e metadados)" não lista quais metadados são extraídos e persistidos (resolução, codec, bitrate, tamanho, formato de container, fps?). Isso define colunas da entidade de vídeo e o contrato da API (TDs Cross-layer). Explicit choice: enumerar o conjunto mínimo de metadados persistidos nesta fase (ao decidir TD-05/TD-09/TD-11 ou como clarificação de escopo).

### Missing Decisions

_None._ _(todos os 9 bullets de `## Capability Coverage` mapeiam para ≥1 TD; formato de erro HTTP do `nestjs-project/` herdado de `phase-02-auth/TD-07`; checagem de contract-sync (Decisão #29) não dispara — fase sem UI, `## UI Inventory` ausente)_

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._ _(nenhum TD da fase está decidido ainda — a checagem será refeita após a resolução dos OQs)_

### Unresolved Open Questions

- **OQ-1** — TD-01 pending — Tecnologia de Fila (Message Queue). Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-2** — TD-02 pending — Uso do Object Storage — Buckets/Chaves, Endpoint Interno vs Público e CORS. Resolution: fill the **Decision:** field of TD-02 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-3** — TD-03 pending — Protocolo de Upload de até 10GB + Pré-cadastro em Rascunho. Resolution: fill the **Decision:** field of TD-03 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-4** — TD-04 pending — Execução do Video Worker (processo, container e entrypoint). Resolution: fill the **Decision:** field of TD-04 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-5** — TD-05 pending — Integração com FFmpeg/ffprobe (spawn direto vs wrapper). Resolution: fill the **Decision:** field of TD-05 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-6** — TD-06 pending — Acesso do Worker ao Arquivo (download completo vs leitura por URL pré-assinada). Resolution: fill the **Decision:** field of TD-06 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-7** — TD-07 pending — Estratégia de URL Única por Vídeo. Resolution: fill the **Decision:** field of TD-07 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-8** — TD-08 pending — Streaming e Download. Resolution: fill the **Decision:** field of TD-08 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-9** — TD-09 pending — Modelo de Status do Vídeo. Resolution: fill the **Decision:** field of TD-09 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-10** — TD-10 pending — Política de Retry e Falha Final do Processamento. Resolution: fill the **Decision:** field of TD-10 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-11** — TD-11 pending — Formatos Aceitos e Validação do Arquivo de Vídeo. Resolution: fill the **Decision:** field of TD-11 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-12** — TD-12 pending — Uploads Abandonados — Destino do Rascunho no Banco. Resolution: fill the **Decision:** field of TD-12 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-13** — TD-13 pending — Estratégia de Testes de Worker, Fila, Storage e FFmpeg. Resolution: fill the **Decision:** field of TD-13 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.

### UI Coverage Gaps

_None._ _(fase sem escopo de UI — `## UI Inventory` ausente; `next-frontend/` diferido)_

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-11)_ — Sem TD para formatos de vídeo aceitos e estratégia de validação do arquivo. Coberto pelo TD-11 adicionado na rodada 2 de research (ainda pending → acompanhado em OQ-11).
- **MD-2** _(resolved_by phase-03-videos/TD-12)_ — Sem TD para ciclo de vida de uploads abandonados / rascunhos órfãos. Coberto pelo TD-12 adicionado na rodada 2 de research (ainda pending → acompanhado em OQ-12).
- **MD-3** _(resolved_by phase-03-videos/TD-13)_ — Sem estratégia de teste para worker, fila, storage e FFmpeg (fora do guia). Coberto pelo TD-13 adicionado na rodada 2 de research (ainda pending → acompanhado em OQ-13).
