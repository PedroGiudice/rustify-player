# Vistoria do autoplay + sinal v3 (2026-08-12)

**Estado:** vistoria completa (4 auditores paralelos: algoritmo, dados,
enrichments, frontend) + correções implementadas na mesma sessão.

## A régua (dados reais, 6263 play_events, W18-W32)

- **Autoplay: 78,9% skip agregado (n=190), 73,2% skip precoce (<10%).**
  O agregado engana: W19 tinha 17% (lua de mel), de W22 em diante roda a
  80-100%. A meta v2 (<=55%) NÃO foi batida.
- **Streak de aceitação ~zero:** mediana 0, média 0.14 — em 89,5% dos
  ciclos o usuário skipa a sugestão sem aceitar nenhuma track.
- **Escuta é bimodal em U extremo:** 67% dos eventos com listen_pct<0.1,
  21,6% com >0.9. O usuário decide nos primeiros segundos.
- **album_seq é o único modo engajado** (41% skip, mediana lp=1.0);
  queue é garimpo (88,5% skip, piorando).
- 220 tracks "nunca aceitas" (3+ eventos, 0 completion) seguiam
  reaparecendo (ex.: Suicidal Thoughts skipada 21x).
- Cobertura do acervo: 59,6% (1040/1746 com evento).

**PORÉM: a régua estava torta.** O radio mode (fila abastecida pelo
autoplay) logava continuações como `album_seq` (avanço natural) e `queue`
(skip). Como behavioral_signals EXCLUI album_seq dos positives, toda
escuta completa em radio era invisível pro perfil enquanto os skips
contavam contra — o motor era cego pros próprios acertos e os 190 eventos
"autoplay" eram só a 1ª track de cada ciclo. Parte da "piora" medida é
artefato disso; a régua limpa começa agora.

## O que foi corrigido (nesta sessão)

### Coleta de sinal (frontend, PlayerBar.tsx)
1. `contOrigin`: radio→`autoplay`, playlist→`playlist` (novo origin,
   positivo com desconto passivo). Station/album inalterados.
2. `doAutoplay`/`prefetchRadio` marcam a fila com `{kind:"radio"}` — o
   chip não vira mais "solta" e o contOrigin enxerga o contexto.
3. `libRecordPlay` duplicado removido do TrackEnded (play_count dobrava
   em toda escuta completa; agora 1x no playTrack).
4. Skips manuais (pb-next, MPRIS, pulo na fila) entram em
   `recentlyPlayedIds` — track rejeitada não volta como sugestão. Nota:
   o hook precisa ficar nos call-sites ANTES de `advanceQueue`
   (advanceQueue/setQueue já trocam currentTrack).
5. `pb-next` no fim da fila dispara autoplay (paridade MPRIS).
6. **Repeat one/all funcionam de verdade** (eram no-op: `cycle_repeat`
   nunca existiu no backend; removido de tauri.ts). Repeat-one loga
   origin `repeat` (positivo pleno) e o preload gapless é repeat-aware.

### Backend (behavioral_signals v3, qdrant_client.rs)
Derivação extraída pra função pura testável `derive_behavioral_signals`:
- **Positives DISTINTOS** — o weight por repetição min(count,5) era
  matematicamente inócuo sob `strategy: best_score` (score = melhor match
  individual; repetição não muda o max).
- **Decay temporal** (meia-vida 14 dias) + desempate determinístico por
  recência e track_id (antes: ordem de HashMap).
- **Desconto 0.6 pra origens passivas** (autoplay/station/playlist) —
  anti-feedback-loop: escuta passiva do que o próprio autoplay tocou vale
  menos que escolha ativa.
- **Likes explícitos** (top-10 por liked_at) apendados aos positives —
  76 likes reais existiam e o autoplay os ignorava. Cap total 35.
- **Negatives: lp<0.30 (era 0.15), janela 300 (era 200), cap 40 (era
  30)** — com a distribuição em U, o meio é raro mas direcionalmente
  negativo.
- **Conflito pos/neg** resolvido pela recência do evento mais recente.

### Backend (lib_autoplay_next, lib.rs)
- Retry do seed_pool SEM negatives quando vazio (paridade com stations —
  antes o resultado ignorava o seed em silêncio).
- `weighted_pick_prefix` substitui o shuffle uniforme: sorteio ponderado
  geométrico (r=0.7) sobre top-8 — rank-1 vence ~30%, cauda participa.
  O uniforme dava a mesma chance ao rank-1 e ao rank-3. Gotcha: xorshift
  PRECISA de scrambling multiplicativo (xorshift*) — seeds pequenas
  degeneram em "rank-1 sempre" (pego por teste).
- Flush do play_event pendente no `CloseRequested` — a última track de
  toda sessão morria sem evento.

### Dados (Qdrant cmr-auto)
- **368 tracks sem vibe anotadas** (workflow, 15 anotadores, vocabulário
  fechado 24 moods/14 activities, 368/368 válidas, 262 high confidence).
  Upsert com merge preservando play_count/cores. **Cobertura de vibe:
  1746/1746 = 100% de novo.** Artifact:
  `data/enrichments/2026-08-12-fable-vibe-annotations-368.json`.
  As tracks pós-25/07 (levas Crate) competiam com vibe neutra 0.5.

## Fatos novos sobre os dados (pra próxima análise)
- Origins novos a partir desta versão: `playlist`, `repeat`; continuações
  de radio agora logam `autoplay` (o skip rate de autoplay vai MUDAR de
  significado — não comparar cru com o histórico pré-v3).
- 257 eventos de W18-W19 sem `timestamp` (usar fallback started_at);
  62 eventos auxiliares (search_query/click, queue_add) na mesma
  collection com schema próprio — filtrar por event_type antes de
  estatística; search_click/queue_add gravam track_id como STRING.
- liked_at NÃO é mais "sempre 0" — 76+ likes reais nos enrichments.

## Deferidos (registrados no Linear)
- Double-load no fim natural (engine gapless + playTrack recarrega).
- Station Mood sem cap por artista/shuffle/negatives.
- GC dos 9 enrichments órfãos + anotação automática de vibe no Crate.
- Aversion list persistente (nunca-aceitas além da janela de 300).
- Restore de sessão não restaura queueSource (playerSetOrigin órfão).

## Meta pra próxima medição
Com a régua limpa (origins corretos), medir por 2-3 semanas e comparar:
skip rate de `autoplay` (agora ciclo completo) vs a meta <=55%, e streak
de aceitação (hoje mediana 0). Decay/pesos são tunables em
`qdrant_client.rs` (HALF_LIFE_DAYS, PASSIVE_WEIGHT, thresholds).
