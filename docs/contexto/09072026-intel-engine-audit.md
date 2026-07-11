# Auditoria: motor de inteligência (stations/autoplay/recommend) + mistério das 1500

**Data:** 2026-07-09
**Estado:** diagnóstico completo; **fixes #1-#6 EXECUTADOS na v0.2.47** (mesma
sessão, TDD, gates verdes) e **#9 RESOLVIDO operacionalmente** (ver abaixo).
Pendentes: #7 (UI de degradação do autoplay), #8 (match_avg),
#10 (set_enrichment sem lock — tech debt).

## Enrichment #9 — resolvido com Opus (Gemini morto por decisão do usuário)

As 372 tracks sem mood/energy foram anotadas em 2026-07-09 por **15 subagentes
Opus em paralelo** (batches de 25, via subscription — SEM API key), com o
vocabulário FECHADO extraído dos 934 já anotados (24 moods, 14 activities,
inglês — os dados reais; o prompt PT do script Gemini antigo nunca foi o que
chegou ao Qdrant). Validação central: 372/372 dentro do vocabulário, ranges
ok. Upsert na cmr-auto: 259 set_payload (merge, preservando play_count) + 113
pontos novos. **Cobertura: 1306/1306 tracks vivas com mood_tags.**
Artifact: `data/enrichments/2026-07-09-opus-mood-annotations.json` (IDs reais).
Smoke test no app real: `lib_mood_search("sensual")` retorna faixas
recém-anotadas (Mochakk/PAWSA/DJ Arana). Processo replicável: extrair
faltantes do Qdrant → batches com índice local (nunca retranscrever u64 em
prompt) → agentes Opus com vocabulário fechado → validador → merge/upsert.
Scripts gemini-* em scripts/ estão MORTOS como pipeline (manter só como
referência histórica ou deletar).
Órfãos conhecidos: 9 pontos de enrichment de tracks removidas (inofensivos,
filtrados na resolução de track; nenhum tem mood_tags).

**Update 2026-07-11:** as 72 tracks da leva de 09/07 (indexadas pelo boot
scan, acervo → 1378) foram anotadas com o mesmo pipeline (3 subagentes Opus,
batches de 25 com índice local, vocabulário fechado, validação 72/72, upsert
63 pontos novos + 9 set_payload merge preservando play_count).
**Cobertura: 1378/1378 tracks vivas com mood_tags.**
Artifact: `data/enrichments/2026-07-11-opus-mood-annotations-leva72.json`.

## Fixes v0.2.47 (executados)

1. Station play toca: `handleResume` usa o `Vec<Track>` (setQueue "curated" +
   playTrack origin "station"). Testes novos em Stations.test.tsx.
2. `recommendations()` lê `track_enrichments` (dados vivos: 910 plays, 65
   likes); discover filtra por set real de tracks tocadas.
3. Your Mix: `your-mix.json` regravado NA CMR-AUTO com top 5 seeds DISTINTOS
   dos signals atuais (4x J. Cole + 99 Neighbors) — efeito imediato; código
   ganhou `dedup_preserving_order` em maybe_seed + generate (positives são
   ponderados por design).
4. New from current track: usa `player.currentTrack` como seed; sem track não
   cria. BUG EXTRA descoberto: `seed_track_ids` viajava como number (u64>2^53
   corrompe em JS) — agora serde string no wire, deserialização aceita
   numbers legados dos JSONs em disco.
5. `lib_semantic_search` respeita `RUSTIFY_LYRICS_EMBED_URL` (literal removido).
6. Branch mood de `generate_station_tracks` aplica filtro de genre
   client-side (paridade com lib_mood_search).

Nota de infra: teste de integração `lyrics_embed` falhou por cogmem travado no
caminho de embed (health ok, embed >90s) — restart do serviço resolveu; não
relacionado ao diff. Nota de teste: mocks de invoke via `window.__TAURI__` em
runtime NÃO funcionam (tauri.ts captura invoke no load) — usar
`vi.mock("../tauri")`; o teste antigo do grid passava por coincidência
(placeholders também têm `.st-card`).

## 1. Mistério das 1500 músicas — RESOLVIDO, não há bug

Números medidos na cmr-auto (2026-07-09):

| Fonte | Contagem |
|---|---|
| Arquivos de áudio em `~/Music` (disco) | 1314 (1313 flac + 1 m4a) |
| Dentro das 12 pastas-playlist | 1306 |
| Em `.quarentena` (fora do índice, deliberado) | 8 |
| Qdrant `rustify_tracks` | 1306 |
| Agregação por playlist (réplica exata do `list_folders`) | 1306 — bate pasta a pasta com o disco |
| slskd pendente | 0 completos, 6 incomplete |

Disco = índice = soma das playlists, linha a linha (453 Rap & Hip-Hop ... 2 Clássica).
**O número "1500" nunca existiu no disco.** Total de arquivos de QUALQUER tipo em
~/Music é 2633 (1122 .lrc, 103 imagens etc.) — contagem grosseira mista é a origem
provável da estimativa. O acervo real é ~1306.

## 2. Motor de inteligência — mapa e bugs confirmados

Mapa completo por subsistema produzido por exploração de código (paths com linhas
abaixo). Dados reais medidos no Qdrant da cmr-auto na mesma data.

### Dados reais (baseline 2026-07-09)

- `rustify_tracks`: 1306 pontos; 1306 com vetor `mert` (768d), 1092 com `lyrics`
  (1024d); embedding_status done em 100%. Campos legados: play_count>0 em só 96,
  liked=0 (FÓSSEIS).
- `track_enrichments`: 1199 pontos (107 tracks sem NADA); 934 com
  mood_tags/energy/valence (372 tracks invisíveis pra mood search/stations mood);
  **play_count>0 em 910; liked_at>0 em 65** (dados VIVOS).
- `play_events`: 4179 eventos — 3193 skipped (76%), 917 ended; origins: queue 2989,
  album_seq 722, manual 240, autoplay 107, resume 57; listen_pct>=0.85 em 973.
- `stations/`: um único `your-mix.json` (21/05), `seed_track_ids` = MESMO id 5x
  (3940784406639047387 = Black Hippy — Black Friday II, play_count 0), `played: 0`.

### Bugs confirmados, por severidade

1. **Play de station não toca nada.** `Stations.tsx:194-202` (`handleResume`)
   chama `libPlayStation(id)` e DESCARTA o `Vec<Track>` retornado — nunca chama
   `setQueue`/play. Só incrementa `stats.played` no JSON. É o "quebrada" visível.
2. **Home recomenda com dados fósseis.** `lib_recommendations`
   (`query.rs:561-624`) lê `play_count`/`liked_at` de `rustify_tracks`, mas
   `record_play`/`toggle_like` escrevem em `track_enrichments`
   (`query.rs:511-542`). Resultado: most_played/based_on_top/discover ignoram
   910 play_counts e TODOS os 65 likes do usuário. Migração
   (`scripts/migrate-enrichments.py`) moveu os dados mas o leitor não acompanhou.
3. **"Your Mix" fossilizada e degenerada.** `maybe_seed_default_station`
   (`lib.rs:3359-3394`) roda SÓ com diretório vazio; semeou em 21/05 com
   behavioral_signals paupérrimos → 5 seeds idênticos de uma faixa nunca tocada.
   Nunca re-semeia. A station "personalizada" orbita uma faixa aleatória.
4. **"New from current track" cria station morta.** `Stations.tsx:204-219` —
   stub MVP cria kind seed com `seed_track_ids` vazio → `generate_station_tracks`
   itera lista vazia → 0 tracks pra sempre.
5. **Semantic search com URL hardcoded.** `lib.rs:263` usa literal
   `http://100.123.73.128:3939` IGNORANDO o env `RUSTIFY_LYRICS_EMBED_URL`
   (aplicado só ao client do indexer em `lib.rs:2500-2502`, cujo comentário
   afirma o contrário). App sem tailnet/VM fora → busca semântica erra sempre.
6. **Mood search: vazio silencioso + genre ignorado nas stations.**
   `MoodFilters::parse` (qdrant_client.rs:18-54) é vocabulário hardcoded PT/EN;
   query fora dele → `Ok(vec![])` sem sinal. `generate_station_tracks` branch
   mood (`lib.rs:3234-3258`) não aplica filtro de genre (o `lib_mood_search`
   compensa client-side em `lib.rs:298-306`, station não).
7. **Degradação silenciosa do autoplay.** 3 camadas (`lib.rs:369-491`): signals →
   recommend puro → shuffle aleatório. Qualquer falha vira `tracing::warn` e cai
   de camada — usuário nunca sabe que o "radio" virou random.
8. **`stats.match_avg` nunca é escrito** (declarado em `lib.rs:3133`, UI mostra "—").
9. **Enrichment pipeline órfão.** mood/energy/valence vêm de
   `scripts/gemini-annotate-tracks.py` (I/O em /tmp, execução manual, uploader
   incerto). Cobertura 934/1306 e caindo conforme acervo cresce.
   `gemini_mood_classifier.py` opera sobre SQLite morto (library.db de maio).
10. **`set_enrichment` é read-modify-write sem lock** (qdrant_client.rs:1379-1418)
    — escritas concorrentes podem perder campo.

### Arquitetura (o que é sólido)

- Embeddings MERT 768d cobrindo 100% do acervo + Recommendations API do Qdrant
  local = fundação boa; autoplay layer 1 (positives ponderados por replay,
  negatives de skip, exclude de recentes, shuffle no top-N) é um design correto.
- `behavioral_signals` (qdrant_client.rs:1220-1308): positives exigem
  listen_pct>=0.9 + (replay>=2 OU pct==1.0), origin != album_seq; negatives
  listen_pct<0.15. Critério positivo apertado mas defensável com 4k eventos.
- play_events tem massa real (4179) e o autoplay é usado (107 origins).

### Ordem de ataque recomendada

1. Fix #1 (station play → setQueue scope "curated") — 1 linha de impacto, feature
   volta a existir.
2. Fix #2 (recommendations lerem enrichments) — Home passa a refletir 910
   play_counts + 65 likes.
3. Re-seed da Your Mix (dedup de seeds + re-semear com signals atuais; considerar
   re-seed periódico ou botão refresh).
4. Fix #4 (stub new-from-current: usar track atual como seed de verdade).
5. Fix #5 (env var na semantic search) + #6 (genre no branch mood).
6. Decidir produto: pipeline de enrichment (rodar de novo? automatizar no scan?)
   e UI de degradação (indicar quando autoplay caiu pra shuffle).

## 3. Contexto operacional

- Subagente `rustify-player-dev` REESCRITO nesta sessão
  (`.claude/agents/rustify-player-dev.md`) — antes descrevia stack morta (vanilla
  JS/cpal/EasyEffects/SQLite). Usuário vai iniciar sessões com
  `claude --agent rustify-player-dev`.
- v0.2.38+ instalada? conferir `dpkg -l rustify-player` na cmr-auto (pendência da
  sessão anterior: validar extração de cor v2 + 9 fixes).
- Renderings do design system continuam GATED no usuário (pickup prompt dele).
- CMR-112 (tech debt themes) segue no Linear.
