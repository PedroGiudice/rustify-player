# Contexto: Crate v1 + v1.1 shipados (v0.2.62 → v0.2.65), fix do pacer, quality_label

**Data:** 2026-08-08
**Sessão:** main (commits diretos, rolling release tag `dev`)
**Duração:** sessão longa (2 dias, com compact), ciclo completo do Crate

---

## O que foi feito

### 1. Crate v1 — busca + download Soulseek in-app (v0.2.62)

Feature completa em 5 etapas SDD (subagentes implementers + reviews):

- **A** `src-tauri/crates/slskd-client/` — protocolo puro (wire/auth/rank/
  pacing/stage_plan), fixtures da API real do spike, FakeSlskd.
- **B** `library-indexer` — `dedup.rs` (OwnedIndex collab-aware),
  `IndexerCommand::IngestPaths` com reply channel (indexação determinística,
  track_id por path).
- **C** `src-tauri/src/slsk/` — coordinator thread única `slsk-coord`,
  JobBoard escritor único (11 estados tagged `kind`), staging
  `.rustify-incoming` + rename atômico pro layout
  `~/Music/<playlist>/<Artista>/<Álbum>/`, reconciliação de boot via
  `slsk_jobs.json`. 2 fix rounds de review (3 Criticals: IPC bloqueante,
  starvation, trocar-fonte inalcançável; + NB-1..3).
- **D** frontend — `src/views/Crate.tsx`, `src/store/crate.ts` (board global,
  ciclo longo, badge da sidebar), wrappers `slsk_*` em `src/tauri.ts` (tipos
  espelham o serde REAL: RejectReason externally-tagged, JobState
  `tag="kind"`, track_id String no wire), rota `/crate`, ⌘K ActionItem.
  Fix wave: opener real (`revealItemInDir`, capability ESTREITADA de
  `opener:default` pra só `opener:allow-reveal-item-in-dir`) + IM-D1.
- **E** letras — `library-indexer/src/lyrics_fetch.rs`: worker thread
  `slsk-lyrics`, canal crossbeam bounded(64), coordinator só `try_send`
  (nunca bloqueia). lrclib.net via ureq, `write_sidecar_if_absent`
  (create_new, nunca sobrescreve). Hook no `try_ingest` pós-Ok com tags do
  arquivo staged (`parse_flac`).

### 2. Fix do cold falso do pacer (v0.2.63) — bug de produção achado no teste do CEO

Sintoma: 2 buscas manuais por "sidoka" → "pausado por 60 min".
Root cause (systematic-debugging, confirmado no código): coordinator chamava
`pacer.record_result()` **a cada poll de 700ms** da busca; o contrato do pacer
é "3 BUSCAS vazias seguidas". Primeiros ticks de toda busca vêm zerados (rede
demora segundos) → cold armava no 3º tick e dobrava a cada 3 ticks
(10→20→40→60 min) DENTRO de uma busca que terminou COM resultado.
Fix: `record_result` movido pra dentro de `window_over` (1x por busca
fechada), teste de regressão `pacer_outcome_e_por_busca_fechada_nao_por_poll`
(falhou antes, passou depois). Nota: o pacer conta respostas CRUAS (pré-filtro
FLAC) — busca de artista BR cheio de MP3 não conta como rede calada.

### 3. Crate v1.1 — visual do handoff claude design (v0.2.64)

Handoff importado via **DesignSync MCP** (projeto do usuário no claude.ai/design)
→ salvo como fonte da verdade em
`docs/design-refs/design_handoff_crate/Rustify Crate.html` → implementado por
1 agente Workflow (Opus, effort low) → review pelo coordenador.
Resultado: grid 6 colunas com r-state, pills por estado, progresso 2px,
cooldown de 4s como anel+countdown NO botão Buscar (banner amarelo só pro
cold longo), fontes em tabela (peer/qualidade/tamanho/fila/velocidade/path
remoto rtl-ellipsis), fila em seções "Em voo"/"Terminadas", estado manual
como card `terminal`, pré-busca com empty state ⌘K.

### 4. quality_label no DownloadJob (v0.2.65)

Pedido do usuário: Fila mostrava tamanho, não "FLAC 16/44". Implementado pelo
coordenador: `rank::quality_label(bit_depth, sample_rate)` pub compartilhado;
campo em `DownloadJob` + `PersistedJob` (`serde(default)` — jobs antigos
carregam vazio e o frontend cai no tamanho); atualizado na troca de fonte
(testado 16/44 → 24/96); wire TS + badge da Fila.

### 5. Operacional

- **Diretriz nova do usuário (memória salva, vai virar rule):** subagentes de
  EXECUÇÃO = Opus com effort low (supera "sonnet pros subagentes" de 07/12).
  Agent tool NÃO tem parâmetro de effort — controle via Workflow
  `opts.effort` ou frontmatter de agent definition.
- **Reviews pelo coordenador** (ordem do usuário "pra acelerar") — sem
  subagente reviewer desde a Etapa D.
- Todos os teammates da sessão encerrados (shutdown_request formal).
- Contas Soulseek: slskd = `cmr-auto-rp` (oficial, share /music);
  Nicotine usa a conta ANTIGA `cmr-auto` — ela está VIVA e a senha está em
  `~/.config/nicotine/config` na cmr-auto (recuperável). Nicotine não roda
  mais (verificado via SSH).

## Estado dos arquivos (principais)

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/crates/slskd-client/` | Criado | protocolo slskd puro, fixtures reais |
| `src-tauri/src/slsk/{mod,coordinator,board,stage,config}.rs` | Criado | coordinator+JobBoard+staging |
| `src-tauri/crates/library-indexer/src/{dedup,lyrics_fetch}.rs` | Criado | OwnedIndex, worker de letras |
| `src/views/Crate.tsx` + `Crate.test.tsx` | Criado | view v1.1 (handoff aplicado) |
| `src/store/crate.ts` + testes | Criado | board global + kv-crate-dest |
| `src/tauri.ts` | Modificado | +tipos e 10 wrappers `slsk_*` |
| `src/styles/extractor-lab.css` | Modificado | bloco `/* ── Crate ── */` v1.1 |
| `src-tauri/capabilities/default.json` | Modificado | opener estreitado a reveal-item-in-dir |
| `docs/design-refs/design_handoff_crate/` | Criado | handoff = fonte da verdade visual |
| `docs/soulseek/manual-qa.md` | Criado | 7 casos de QA com rede real |
| `CLAUDE.md` | Modificado | seção Crate (arquitetura/destino/guard-rails/v1.1) |

## Commits desta sessão

Range completo `5eee890..30df19c` (35 commits — ver `git log`). Marcos:
`93a95d3` v0.2.62 (Crate v1) · `bd2f4b7`+`169db40` v0.2.63 (pacer) ·
`2221749`+`484b542`+`1ea4a26` v0.2.64 (v1.1) · `7b1e4a6`+`30df19c` v0.2.65
(quality_label). Tudo pushado; releases na tag `dev`.

## Decisões tomadas

- **Guard-rails de rede ficam** (não viram "modo Nicotine sem limite"):
  o servidor Soulseek pune rajada (comprovado em julho). Calibrados pra uso
  humano ser invisível: min 4s, 40/h, cold só com 3 buscas COMPLETAS vazias.
  Descartado: remover limites — protege a conta a custo zero.
- **Busca mais lenta que Nicotine é conhecida e aceita na v1.1**: Nicotine
  faz streaming de respostas; nós somos poll encadeado (backend 700ms +
  frontend 800ms ≈ até 2s de latência inicial). Tuning anotado (pendência).
- **Densidade compacta apenas** na v1.1 (default do handoff; roomy
  estruturado no CSS pra depois). Pill "analisando…" do mockup OMITIDA
  (sem backend — não inventar estado).
- **Transparência do bg** (ressalva do CEO): view/listas sem fundo — motion
  atravessa; fundo só em superfícies locais. Verificado na review.
- **Capa de álbum**: embutida no FLAC vem junto (indexer extrai); cover.jpg
  separado NÃO baixa na v1. Decisão: opção "puxar cover.jpg da pasta remota
  quando faltar arte embutida" é candidata da Fase 2.

## Métricas

| Métrica | Valor |
|---------|-------|
| Releases | v0.2.62, 63, 64, 65 (todas na tag `dev`) |
| Testes Rust | 293 passed (15 suites), 0 failed |
| Testes frontend | 257 passed, typecheck limpo |
| Fix rounds de review | A:0 · B:1 · C:2 · D:1 wave |

## Pendências identificadas

1. **BUG lyrics do Crate** (alta) — usuário baixou "1010" (Djonga) e chegou
   SEM letra. Hipóteses ordenadas: (H1) sidecar `.lrc` FOI escrito mas
   `lrc_path`/vetor lyrics só entram no Qdrant no backfill de STARTUP do
   indexer — o .lrc chega depois do IngestPaths, então a letra só aparece
   após reiniciar o app (gap de fluxo, fix: disparar set_payload/mini-backfill
   pós-sidecar); (H2) lrclib não tem a faixa synced (rap BR — miss legítimo;
   404 ou syncedLyrics vazio); (H3) worker/canal não rodou (logs `slsk-lyrics`);
   (H4) tags do arquivo staged ruins → query errada no lrclib.
2. **Verificar autoplay** (alta) — pedido do usuário; validar session-awareness
   (v0.2.61: lib_station_next incremental, skip <35%, context_id) no app real.
3. **Curadoria nova** (alta) — music-curator **SÓ SUGERE, NUNCA BAIXA**
   (reforço enfático do usuário). Fluxo: sugestões → aprovação humana →
   download (Crate pra avulsas; `baixar_soulseek_teste.py` pra leva).
4. **Latência da busca** (média) — polls iniciais mais agressivos (ex.
   200-300ms nos 3 primeiros) ou evento no lugar de poll.
5. **Cover art fallback** (média) — cover.jpg da pasta remota do peer quando
   o FLAC não tem arte embutida (Fase 2 ou item avulso).
6. **Parked v1.1** (baixa) — popover fecha em clique fora; densidade roomy;
   "N no acervo" é soma das playlists (aproximação).
7. **Fase 2 do Crate** (baixa) — álbum inteiro. **R14** evt_rx leak
   pré-existente (fora do escopo Crate).
