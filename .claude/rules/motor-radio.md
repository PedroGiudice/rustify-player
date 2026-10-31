---
paths:
  - "src-tauri/crates/library-indexer/src/qdrant_client.rs"
  - "src-tauri/crates/library-indexer/src/familiarity.rs"
  - "src-tauri/crates/library-indexer/src/radio_refusal.rs"
  - "src-tauri/crates/library-indexer/src/rerank.rs"
  - "src-tauri/src/desktop.rs"
  - "src-tauri/src/mobile_intel.rs"
  - "src-tauri/src/sync_receiver.rs"
  - "src/lib/radio*.ts"
  - "src/lib/listenSummary.ts"
  - "src/lib/syncStatus.ts"
  - "src/views/Stations.tsx"
  - "src/views/Queue.tsx"
  - "scripts/metrics/**"
---

# Motor de inteligência: sinal, autoplay, stations e rádio

Movido do CLAUDE.md em 31/10/2026 (o mapa ficou com uma linha apontando para cá).

## Sinal v3 (v0.2.66, 2026-08-12)

Vistoria completa + redesign do sinal em
`docs/contexto/12082026-autoplay-vistoria-sinal-v3.md` (regua, dados,
decisoes). O que importa pro dia-a-dia:

- **behavioral_signals v3** (`qdrant_client.rs`, derivacao pura testavel
  `derive_behavioral_signals`): BALANCO LIQUIDO por track — cada evento
  vira peso continuo `clamp((lp-0.30)/0.50, -0.6, 1.0)` (60% de escuta =
  +0.6; skip imediato = -0.6; decisoes de produto do CEO 2026-08-12, nao
  voltar a threshold binario nem a listas independentes), piso de
  atencao 90s no lado positivo (full de skit nao vale full de musica),
  desconto 0.6 pra origens passivas (`autoplay`/`station`/`playlist`;
  skips sem desconto), decay 14d sobre TUDO, e o saldo decide o lado:
  positives = saldo>0 + peso positivo >= 0.55 (top 25 + likes top-10);
  negatives = saldo <= -0.30 (skip unico expira sozinho em ~2 semanas,
  aversao recorrente fica). Positives DISTINTOS (weight por repeticao e
  inocuo sob `best_score` — nao reintroduzir). Tunables sao as consts no
  topo da funcao.
- **Regua automatica**: `scripts/metrics/autoplay_regua.py` roda DIARIO
  09:00 (systemd user timer `rustify-regua.timer` na VM), grava
  `docs/metrics/regua-latest.md` + historico `.jsonl`; o hook
  SessionStart do repo (`.claude/settings.json`) injeta o ultimo
  veredito em TODA sessao — a promessa "medir depois" nao depende mais
  de memoria de ninguem. Desde v0.2.69 reporta tambem a COBERTURA do
  motor (MERT / letra / vibe): o gap reabre a cada leva do Crate e nao
  havia alarme nenhum. A cobertura de letra e medida contra as
  ALCANCAVEIS (total menos `lyrics_status` none/instrumental) — perseguir
  100% e impossivel: instrumental nao tem letra.
- **Proveniencia dos eventos (v0.2.72, spec 2026-08-13-event-provenance)**:
  todo ponto novo em `play_events` sai estampado com `device_id` (slug do
  hostname, persistido em `device.json` no data dir — IMUTAVEL depois de
  criado), `app_version` (autoridade: tauri.conf.json via `package_info()`)
  e `signal_schema` (const `SIGNAL_SCHEMA` em `qdrant_client.rs`). Like
  grava `liked_device`. O backend estampa POR CIMA do que vier do frontend
  (`log_event`). Mudou a semantica dos sinais/origins? Incrementar
  `SIGNAL_SCHEMA` — a regua le o campo e o `V3_CUTOFF` por timestamp e so
  fallback pra eventos legados. Sem migracao retroativa (padrao context_id).
  E o pre-requisito do sync multi-dispositivo (uniao de conjuntos dos logs;
  fase futura na spec). Eventos de dispositivo novo aparecem sozinhos na
  regua (breakdown por device quando houver 2+).
- **Origins**: continuacoes de fila radio logam `autoplay` (contOrigin,
  PlayerBar.tsx), playlist loga `playlist`, repeat-one loga `repeat`.
  `album_seq` segue FORA dos sinais. NAO comparar skip-rate por origin
  cru com dados pre-v0.2.66 — o significado mudou.
- **record_play roda 1x por play** (no playTrack, e só depois que `playerPlay` aceitou: faixa
  que não tocou não conta, desde 31/10; nunca re-adicionar no TrackEnded — dobrava play_count).
- **Anotacao de vibe NAO e automatica**: leva nova do Crate entra sem
  energy/valence/moods (neutro 0.5 no re-rank) ate rodar o batch
  (CMR-178; processo replicavel na doc de contexto). Cobertura em
  2026-08-12: 1746/1746. E o unico dos tres vetores/anotacoes que
  continua manual — MERT e letra fecham sozinhos no ingest desde
  v0.2.69. Nenhum script commitado produz as anotacoes em uso: as tres
  levas (372, 72, 368) sairam de subagentes LLM, e o processo e prosa em
  doc, nao codigo. Decisao pendente do CEO: batch periodico agendado vs
  chamada LLM no ingest (custo recorrente + latencia por faixa).
- Deferidos rastreados: CMR-177 (double-load gapless), CMR-178
  (anotacao automatica + GC orfaos), CMR-179 (restam station Mood e
  restore de queueSource).
- **Consciencia de sessao no RADIO (v0.2.75, 2026-08-18)**: a parte de
  aversao do CMR-179 foi confirmada como causa-raiz do skip 68% da regua
  (forense: 3 sessoes de martelo 88-96% dominavam o agregado; o picker
  semeava o proximo pick pela faixa RECEM-REJEITADA e re-servia skipadas
  alem do FIFO-30 — mesma faixa 12x). Fix = paridade com a station:
  `radioSession` generalizado (rodada `radio:<ts>`, `lastAcceptedId`),
  skip cedo (<35%) trunca a cauda e re-fetcha semeado pela ultima ACEITA,
  seen da rodada e hard-filter, `lib_autoplay_next` ganha
  `session_negative_ids` (uniao com negativos globais) e filtro
  `is_junk_artist` (URL no campo artista). NAO regredir: semear re-fetch
  pos-skip pela faixa skipada e o anti-pattern que causou o colapso.
- **O vetor de som (`mert`) mede pouco estilo (medido 14/10, CMR-302)**: o container
  `rustify-embed` devolve a média da ÚLTIMA camada do MERT-v1-95M, que é a pior para estilo
  (playlists entre si, leave-one-artist-out: 0,457 de acurácia balanceada; camada 6 = 0,620;
  gap de estilo da camada 7 é 2,4x o da 12) e captura mais o ARTISTA que o gênero. E a janela
  não é o centro da faixa: `decode_flac` para em 60 s e `take_center_window` pega os segundos
  15-45. Subgênero do funk não se separa em camada nenhuma (CMR-299). Sonda reprodutível:
  `scripts/curator/mert_layer_probe.py` (relatório `docs/contexto/14102026-mert-camadas.md`).
  Avaliação offline nas escolhas reais do autoplay (`mert_autoplay_eval.py`, relatório
  `14102026-mert-camadas-autoplay.md`): desde a v0.2.75 a similaridade semente->faixa do vetor
  do app NÃO prevê aceite (AUC 0,520); camada 7 com janela central 0,587, IC sobreposto (63
  aceites só). Veredito: sem diferença clara, o app não muda; os 74% de skip não se explicam
  pela distância acústica até a semente. Vetores das 13 camadas (janela central, float16) em
  `~/.local/share/rustify-curator/mert-layers-20261014/` na VM, para reavaliar com mais eventos.
- **Forense do autoplay (14/10, `scripts/metrics/autoplay_forense.py`, relatório
  `docs/contexto/14102026-autoplay-forense.md`)**: desde a v0.2.75 o que separa aceite de pulo é
  FAMILIARIDADE, não som: nº de vezes que a faixa já foi ouvida até o fim (AUC 0,72; 0,79 sem as 5
  sessões dominantes) e like (pulo 72% curtida x 94% não curtida). Energia/valência, distância
  acústica, duração, aparelho e repetição não separam. 72% das escolhas do motor são faixas
  ouvidas até o fim no máximo 2 vezes; o rerank final (`rerank.rs`) usa só vibe (likes entram
  apenas como exemplos na busca de candidatas). 77% dos pulos são em até 5 s (navegação, em
  rajadas); sem eles o pulo do autoplay é 72%. O período anterior à v0.2.75 é contaminado pelo
  S24 0.2.74 (96% de aceite, escuta em segundo plano) e não serve de linha de base.
- **Familiaridade no autoplay (v0.2.92, desktop; S24 depois)**: `library-indexer/src/
  familiarity.rs` conta por faixa as vezes ouvida até o fim e as tentativas do motor. Cache no
  `QdrantClient`: `familiarity()` devolve `Option` e NUNCA faz I/O nem espera lock de varredura
  (remonta em thread de fundo a cada 6 h ou após invalidação; backoff de 60 s após falha; sem
  índice o rádio segue sem familiaridade); aquecimento no boot por `rebuild_familiarity()`;
  atualização incremental por evento gravado, deduplicada pelo id do ponto (replay do S24 não
  conta duas vezes); invalidação no mover. Aceite/pulo = definição da régua, travada pela
  fixture `scripts/metrics/fixtures/familiaridade.json` lida pelos testes Rust e Python (mudar
  um lado = mudar o outro; `release.sh` roda `test_autoplay_regua.py` antes do build).
  Conhecida = 3+ fins ou curtida. Autoplay serve conhecida, conhecida, descoberta (`autoplay_mix`
  em `desktop.rs`, `mix_slot` vindo de `radioSession.mixSlot`; o re-fetch pós-pulo recua o ciclo
  só pelas faixas que o rádio serviu, `mixServedIds`; não zerar o slot no re-fetch). Nunca-termina
  = 3+ pulos do motor com `listen_pct < 0.5`, 0 fins, sem like (escuta desconhecida/duração 0 e
  pulos 0 ms do S24 não contam): sai do autoplay e das stations e não expira. Camada 2 do
  fallback aplica lixo e nunca-termina; camada 3 respeita `exclude_ids`. Simulação nos dados
  reais previa pulo ~87% (de 92%); medir pela régua, linha "desde a v0.2.92".

## Leva Impeccable de 31/10 (B9, B10, B11, B14)

- **Recusa com escopo (B9, `library-indexer/src/radio_refusal.rs`)**: o CEO tira uma faixa do
  rádio por decisão, não só pelo nunca-termina. Estado em `track_enrichments` (como o like; o
  mover leva junto): `radio_never_at` (fora do autoplay e de TODAS as stations),
  `radio_off_stations` (fora só das stations listadas), `radio_release_skips`/
  `radio_released_at` (devolução). Comandos `lib_radio_excluded`,
  `lib_radio_refuse(id, "never"|"station", stationId?)`, `lib_radio_return(id, scope?)`,
  `lib_radio_restore(id, before)` (desfazer). Autoplay (as 3 camadas) e stations aplicam como
  filtro duro. Qdrant fora = rádio SEM as recusas, nunca com tudo recusado. Devolver perdoa os
  pulos cedo contados até ali; o nunca-termina volta a valer com novos pulos. O Python da régua
  não conhece o perdão (fixture `familiaridade.json` inalterada). Não é `play_event`:
  `SIGNAL_SCHEMA` não mudou. Tela: seção "Fora do rádio" no fim da Stations
  (`components/RadioExcluded.tsx`), menu da faixa "Nunca no rádio" / "Não tocar nesta
  station", `lib/radioRefusal.ts` (`radioRevision` recarrega as vistas). S24: o manifest leva
  `radio_never_at`/`radio_off_stations` e `mobile_intel.rs` aplica; reexportar o manifest
  depois do .deb.
- **Motivo da escolha (B10)**: cada Track que o rádio devolve traz `autoplay_reason`
  (`desktop.rs`); o texto sai de `lib/radioWhy.ts` e aparece na gaveta da fila e em `/queue`.
- **Escuta viva (B11)**: `lib_listen_stats({artist, album})` lê o cache de familiaridade
  (`ListenTimes`), nunca os campos fósseis `play_count`/`last_played` do payload. Texto em
  `lib/listenSummary.ts`, no slot `facts` do `LibHero` (cabeçalho de Álbum e Artista).
- **Sync do S24 visível (B14)**: o receiver grava `sync-status.json` no data dir, emite
  `sync-received` e responde `lib_sync_status`; `lib/syncStatus.ts` mostra em Settings >
  Biblioteca, em âmbar depois de 24 h sem sync.
