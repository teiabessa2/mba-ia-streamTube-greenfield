---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-22T20:01:54-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-20T17:19:28-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "'sem impacto na performance' no upload de 10GB não tem critério mensurável"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Controle de acesso a streaming/download por status e autenticação indefinido"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Conjunto de 'metadados' a extrair e persistir no processamento não definido"
    resolved_by: clarification
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
    status: resolved
    summary: "TD-01 pending — Tecnologia de Fila (Message Queue)"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Uso do Object Storage (buckets/chaves, endpoints, CORS)"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Protocolo de upload de até 10GB + pré-cadastro em rascunho"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Execução do Video Worker (processo, container, entrypoint)"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Integração com FFmpeg/ffprobe (spawn direto vs wrapper)"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Acesso do worker ao arquivo (download vs URL pré-assinada)"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Estratégia de URL única por vídeo"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Streaming e download"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Modelo de status do vídeo"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Política de retry e falha final do processamento"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Formatos aceitos e validação do arquivo de vídeo"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Uploads abandonados: destino do rascunho no banco"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Estratégia de testes de worker, fila, storage e FFmpeg"
    resolved_by: phase-03-videos/TD-13
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._ _(todos os `Capability:` dos TDs citam bullets presentes em `## Scope`; nenhum TD com `Scope: Frontend`, portanto a checagem de órfão não se aplica; sem TDs decididos para conflitar entre si)_

### Ambiguities

_None._

### Missing Decisions

_None._ _(todos os 9 bullets de `## Capability Coverage` mapeiam para ≥1 TD; formato de erro HTTP do `nestjs-project/` herdado de `phase-02-auth/TD-07`; checagem de contract-sync (Decisão #29) não dispara — fase sem UI, `## UI Inventory` ausente)_

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._ _(nenhum TD da fase está decidido ainda — a checagem será refeita após a resolução dos OQs)_

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(fase sem escopo de UI — `## UI Inventory` ausente; `next-frontend/` diferido)_

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-11)_ — Sem TD para formatos de vídeo aceitos e estratégia de validação do arquivo. Coberto pelo TD-11 adicionado na rodada 2 de research (ainda pending → acompanhado em OQ-11).
- **MD-2** _(resolved_by phase-03-videos/TD-12)_ — Sem TD para ciclo de vida de uploads abandonados / rascunhos órfãos. Coberto pelo TD-12 adicionado na rodada 2 de research (ainda pending → acompanhado em OQ-12).
- **MD-3** _(resolved_by phase-03-videos/TD-13)_ — Sem estratégia de teste para worker, fila, storage e FFmpeg (fora do guia). Coberto pelo TD-13 adicionado na rodada 2 de research (ainda pending → acompanhado em OQ-13).
- **AMB-1** _(resolved_by clarification)_ — 'sem impacto na performance' no upload de 10GB não tem critério mensurável. Clarificação: Critério de aceite de "sem impacto na performance": a API nunca recebe os bytes (só JSON; partes direto ao storage por URL pré-assinada); tamanho declarado validado no início (máx. 10 × 1024³ bytes, acima disso rejeita sem criar rascunho); upload retomável (`ListParts`); os três pontos cobertos por testes. Registrado como Revision em `phase-03-videos/TD-03`.
- **AMB-2** _(resolved_by clarification)_ — Controle de acesso a streaming/download por status e autenticação indefinido. Clarificação: Stream e download públicos (`@Public()`), só com status `ready`; demais status → 404 sem revelar existência. Status/detalhe do próprio vídeo exige login + dono do canal. Visibilidade/publicação ficam para a Fase 04. Registrado como Revision em `phase-03-videos/TD-08`.
- **AMB-3** _(resolved_by clarification)_ — Conjunto de 'metadados' a extrair e persistir no processamento não definido. Clarificação: `duration_seconds` em coluna própria + coluna `metadata` (jsonb) com `width`, `height`, `videoCodec`, `audioCodec` (opcional), `bitrate`, `formatName`, `sizeBytes`. Registrado como Revision em `phase-03-videos/TD-05`.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 pending — Tecnologia de Fila (Message Queue). Decidido: A.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 pending — Uso do Object Storage (buckets/chaves, endpoints, CORS). Decidido: A.
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 pending — Protocolo de upload de até 10GB + pré-cadastro em rascunho. Decidido: A.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 pending — Execução do Video Worker (processo, container, entrypoint). Decidido: A.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 pending — Integração com FFmpeg/ffprobe (spawn direto vs wrapper). Decidido: A.
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 pending — Acesso do worker ao arquivo (download vs URL pré-assinada). Decidido: A.
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 pending — Estratégia de URL única por vídeo. Decidido: A.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 pending — Streaming e download. Decidido: A.
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 pending — Modelo de status do vídeo. Decidido: D.
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 pending — Política de retry e falha final do processamento. Decidido: A.
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 pending — Formatos aceitos e validação do arquivo de vídeo. Decidido: A.
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 pending — Uploads abandonados: destino do rascunho no banco. Decidido: A.
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 pending — Estratégia de testes de worker, fila, storage e FFmpeg. Decidido: A.
