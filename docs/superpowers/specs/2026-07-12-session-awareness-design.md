# Session-awareness do motor de recomendação — design (CMR-123 item 4)

**Data:** 2026-07-12
**Método:** workflow multi-agente (3 propostas independentes: backend-minimal,
event-sourced, product-first × 3 juízes: engenharia, produto, dados × síntese).
**Status:** Fase 0 (fix de medição: origin="station" nas continuações +
negatives globais na station) IMPLEMENTADA na v0.2.51. Fases 1+ pendentes.

## Resumo executivo

O motor de recomendação de stations hoje gera a leva inteira (até 40 tracks) numa única chamada e a trata como playlist congelada — skips dentro da audição não realimentam nada, e pior: `generate_station_tracks` chama `client.recommend` com `negatives` sempre vazio (nem os negativos GLOBAIS que o autoplay já usa desde o motor v2 chegam a station), enquanto quase toda continuação de fila é logada com `origin="album_seq"`/`"queue"` — excluída por `behavioral_signals()`, que descarta justamente `origin != "album_seq"`. A correção shippa em fases pequenas e mensuráveis: primeiro conserta a atribuição de origin e liga os negativos globais que já deveriam estar ativos (ganho imediato, risco desprezível), depois converte a station em fila incremental com sinal de sessão client-side (`radioSession`) injetado como negativo real no `recommend`, e por fim reage ao skip truncando a cauda não tocada e rebuscando na hora — fechando literalmente o gap descrito na missão ("skipar 3 faixas ensina a 4ª"). Nenhuma fase exige schema novo em `rustify_tracks`/`track_enrichments`, nenhuma introduz estado de sessão persistente no backend, e cada uma é validável isoladamente contra a régua de skip-rate já estabelecida na auditoria de 2026-07-09/12.

## Decisão e racional

Dos três designs avaliados por três juízes independentes, **a proposta "leva incremental client-driven, negatives explícitos" venceu em 2 de 3 vereditos** (a terceira colocou-a em segundo lugar próximo, 24 vs 26 pontos). Ela foi a única que:

1. **Isolou e verificou no código um bug real e barato de corrigir**: `generate_station_tracks` (`src-tauri/src/lib.rs:3365`) chama `client.recommend(&[sid], &[], &[], per_seed_fetch)` — o segundo argumento (`negatives`) é **sempre** `&[]`, mesmo os negativos globais de `behavioral_signals()` que `lib_autoplay_next` já consome desde o motor v2 (`lib.rs:470`). Ligar isso é uma correção de paridade de 3-4 linhas, sem infraestrutura nova, e deveria ser sentida imediatamente — os três juízes concordam que é o maior retorno/menor risco do conjunto.
2. **Conectou o diagnóstico de dados ao diagnóstico de código**: `behavioral_signals()` (`qdrant_client.rs:1214`) exclui `origin != "album_seq"` tanto em positives quanto em negatives — e hoje só a *primeira* track de uma station carrega `origin="station"` (`Stations.tsx:204`); toda continuação (natural ou por skip) é logada com `"album_seq"`/`"queue"` hardcoded no `PlayerBar.tsx`. Ou seja: quase toda a escuta de uma station é hoje invisível ao motor global, e a métrica "station n=1" do baseline está sub-contando por design, não por falta de uso. Corrigir isso é pré-requisito de medição, não só de comportamento — daí virar Fase 0.
3. **Usa o mecanismo mais fiel ao enunciado literal da missão**: ao skipar, a proposta trunca a cauda ainda não tocada da fila e rebusca imediatamente (não só faz "topup perto do fim") — é o único dos três designs em que a 2ª/3ª faixa (não só a 7ª+) pode refletir um skip que acabou de acontecer.
4. **Mantém o estado de sessão inteiramente no cliente** (Solid store efêmero, sem `Mutex`/`Arc` novo no backend), generalizando um padrão que já existe (`recentlyPlayedIds` em `PlayerBar.tsx:39`) em vez de introduzir uma camada nova de concorrência no processo Rust.

Os juízes identificaram lacunas reais nessa proposta e apontaram enxertos concretos das outras duas, todos incorporados neste documento:

- **Continuidade do cap por artista entre lotes** (da proposta "SessionSignals em memória"): sem isso, o cap de 2/artista aplicado por chamada não impede repetição entre o lote inicial e o topup. Resolvido generalizando a função real já em produção (`cap_per_artist_soft`, `rerank.rs:156`) para aceitar contagem inicial.
- **Persistência de `context_id` para medição por posição dentro da rodada** (da proposta "session_id + context_id"): a métrica mais direta e falseável de que o mecanismo funciona é o skip-rate por posição (1ª, 2ª, 3ª... faixa da mesma rodada) — isso exige um campo aditivo em `play_events`, mesmo que a lógica de recomendação em tempo real não dependa dele.
- **Fallback em camadas quando negativos esvaziam o pool** (da proposta "SessionSignals em memória", inspirado no próprio `lib_autoplay_next`): mesma resiliência que já existe no autoplay (pool duplo → similar puro → shuffle) aplicada à station.
- **Threshold de rejeição de sessão explícito e mais frouxo que o hard-skip global** (0.35 vs 0.15): a proposta vencedora registrava todo skip como rejeição, sem diferenciar "larguei no segundo 3" de "larguei no segundo 178 de uma faixa de 180". Corrigido com um limiar de posição relativa.

## Arquitetura

### Onde o estado vive

| Estado | Local | Persistência | Escopo |
|---|---|---|---|
| `queueOrigin` (origem real da fila ativa) | `src/store/player.ts` (`PlayerStore`) | Não (recalculado a cada `setQueue`) | Processo do app |
| `radioSession` (seenIds, skippedIds, contextId) | novo `src/store/radioSession.ts` | Não — efêmero, morre no reload ou troca de contexto | Uma rodada de audição de UMA station |
| `context_id` (auditoria/medição) | payload de `play_events` no Qdrant sidecar | Sim, aditivo | Uma rodada de audição (nasce no `handleResume`) |
| Negativos globais de longo prazo | `behavioral_signals()` (já existe) | Sim (via `play_events`) | Todo o histórico do usuário |

Não há `Mutex`/`Arc` novo no backend Rust. Nenhuma collection nova no Qdrant. Nenhum campo novo em `Station`/`StationStats` (o aprendizado da sessão é 100% client-side e não é persistido no arquivo da station).

### Fluxo do sinal (skip → próxima recomendação)

1. Usuário abre uma station (`Stations.tsx::handleResume`) → gera `contextId = station:<id>:<timestamp>`, chama `libPlayStation(id, 8)` (lote pequeno, não 40), `setQueue(tracks, 0, "curated", "station")`, `registerSeen(ids)`, toca a 1ª faixa com origin `"station"` e o `contextId`.
2. Faixa toca. Backend grava `current_context_id`/`current_origin="station"` no `PlayerSnapshot`.
3. Usuário skipa (botão next, MPRIS, ou clique na queue) **enquanto `queueOrigin === "station"`**: se a posição relativa (`positionSecs/durationSecs`) estava abaixo de 0.35, `radioSession.registerSkipIfEarly` registra o `track_id` como rejeição da rodada.
4. `player_play`/`player_stop` (já existentes) chamam `flush_play_event`, que grava o `play_event` com `origin="station"` (fix de Fase 0) e `context_id` (aditivo) — sem nenhuma lógica de recomendação em tempo real dependendo desse dado.
5. O handler de avanço trunca a cauda não tocada da fila (se houver) e chama `lib_station_next(stationId, seenIds, skippedIds, limit)` **imediatamente**, não só perto do fim.
6. Backend: `generate_station_batch` funde `session_negatives` (do frontend) com os negativos **globais** de `behavioral_signals()` (já ligados desde a Fase 1) e chama `client.recommend(&[seed], &combined_negatives, &exclude_ids, per_seed_fetch)` — com fallback em camadas se o pool vier vazio. Resultado passa por `rerank_by_seed_vibe` e `cap_per_artist_soft_seeded` (cap contínuo entre lotes).
7. Frontend recebe o novo lote, estende a fila, `registerSeen` das novas tracks.

### Diagrama textual

```
handleResume(stationId)
    -> contextId = "station:<id>:<ts>"
    -> radioSession.start(stationId, contextId)
    -> libPlayStation(id, 8) ---------------------------> generate_station_batch
                                                            (exclude=[], session_neg=[], seed_counts={})
                                                            recommend(seed, GLOBAL_negatives, [], fetch)
    -> setQueue(tracks, 0, "curated", "station")
    -> playTrack(tracks[0], "station", contextId) ------> player_play(ctx_id) -> PlayerSnapshot.current_context_id

[faixa toca] --skip early (pos/dur < 0.35)--> radioSession.registerSkipIfEarly(trackId)
                                                     |
                                                     v
                                          trunca cauda nao tocada da queue
                                                     |
                                                     v
                                    libStationNext(stationId, seenIds, skippedIds, 6)
                                                     |
                                                     v
                          generate_station_batch(exclude=seenIds,
                                                  session_neg=skippedIds,
                                                  seed_counts=<artistas ja na fila>)
                          combined_negatives = skippedIds ++ behavioral_signals().negatives
                          recommend(seed, combined_negatives, seenIds, fetch)
                                 |-- pool vazio? retry so com globais
                                 |-- ainda vazio? retry sem negatives (== hoje)
                          rerank_by_seed_vibe -> cap_per_artist_soft_seeded
                                                     |
                                                     v
                     setQueue([...tocadas, ...novoBatch], idx, "curated", "station")
                     radioSession.registerSeen(novoBatch)

[em paralelo, sempre] flush_play_event -> insert_play_event(origin="station", context_id=ctx)
                                           (so para log/auditoria — nao realimenta em tempo real)
```

## Mudanças por arquivo

### Backend (Rust)

**`src-tauri/crates/library-indexer/src/qdrant_client.rs`**
- `insert_play_event` (linha 1094): novo parâmetro `context_id: Option<&str>`, gravado condicionalmente no payload JSON (`"context_id": context_id` só quando `Some`). Pontos antigos continuam sem o campo — comportamento correto, não recebem migração.
- `create_play_events_indices` (linha 917): nova entrada de índice `keyword` para `context_id`, criada no boot via `ensure_play_events_collection` (linha 866) — cobertura 100% desde o primeiro ponto escrito com o campo (evita o problema de índice parcial pós-dados já documentado em `~/.claude/rules/qdrant-bulk-ops.md`).
- `behavioral_signals` (linha 1214): **sem mudança de lógica**. Passa a enxergar corretamente o volume de eventos de station assim que a Fase 0 (retag de origin) estiver no ar — hoje esses eventos são descartados pelo filtro `origin != "album_seq"`.

**`src-tauri/crates/library-indexer/src/rerank.rs`**
- Nova função `cap_per_artist_soft_seeded(tracks: Vec<Track>, cap: usize, min_len: usize, seed_counts: &HashMap<String, usize>) -> Vec<Track>` — mesma lógica de `cap_per_artist_soft` (linha 156), mas o `HashMap` de contagem começa com `seed_counts.clone()` em vez de vazio.
- `cap_per_artist_soft` (linha 156) vira wrapper: `cap_per_artist_soft_seeded(tracks, cap, min_len, &HashMap::new())` — zero mudança de comportamento para os chamadores atuais.
- Testes existentes (`cap_per_artist_soft_completa_ate_o_piso_com_os_cortados`, `cap_per_artist_soft_sem_deficit_e_identico_ao_cap`, linhas ~495-535) continuam válidos como critério de não regressão, sem alteração.

**`src-tauri/src/lib.rs`**
- `PlayerSnapshot` (linha 77): novo campo `current_context_id: Option<String>`.
- `flush_play_event` (linha 94): repassa `snap.current_context_id.clone()` para `insert_play_event`; limpa o campo junto dos demais no sucesso (perto da linha 127-130).
- `player_play` (linha 1373): novo parâmetro opcional `context_id: Option<String>`, gravado em `s.current_context_id` (ao lado de `current_origin`/`current_track_id`, linha ~1388).
- `player_set_origin` (linha 1400): mesmo parâmetro novo `context_id: Option<String>`.
- `generate_station_tracks` (linha 3347) refatorada por **extração** em `generate_station_batch(station: &Station, lib: &Library, exclude_ids: &[u64], session_negatives: &[u64], seed_counts: &HashMap<String, usize>, limit: usize) -> Vec<Track>`. `generate_station_tracks` vira wrapper fino: `generate_station_batch(station, lib, &[], &[], &HashMap::new(), limit)` — usado por `lib_get_station` (3441) e pela chamada inicial de `lib_play_station` (3510), comportamento idêntico ao atual para quem não passa exclude/negatives.
  - Branch `StationKind::Seed` (linha 3349-3395): troca `client.recommend(&[sid], &[], &[], per_seed_fetch)` (linha 3365, negatives sempre vazio — **o bug confirmado**) por `client.recommend(&[sid], &combined_negatives, exclude_ids, per_seed_fetch)`, onde `combined_negatives` é a união (deduplicada) de `session_negatives` com os negativos globais de uma ÚNICA chamada a `lib.handle.behavioral_signals()` feita **antes** do loop de seeds (evita N chamadas redundantes ao Qdrant, uma por seed).
  - Fallback em camadas por seed, mesmo espírito do pool duplo de `lib_autoplay_next` (linha 466-536): se `recommend` com `combined_negatives` vier vazio, retry só com os negativos globais; se ainda vazio, retry sem negativos (== comportamento de hoje) antes de desistir daquele seed.
  - `cap_per_artist_soft(tracks, 2, limit)` (linha 3392) vira `cap_per_artist_soft_seeded(tracks, 2, limit, seed_counts)`.
  - Branch `StationKind::Mood` (linha 3396-3429): `exclude_ids` passa a ser aplicado no mesmo laço client-side que já filtra por `genre_filter` (linha 3419-3423). `session_negatives` não se aplica (scroll não é vetorial) — ver "Fora de escopo".
- Novo comando:
  ```rust
  #[tauri::command]
  fn lib_station_next(
      lib: State<Library>,
      station_id: String,
      exclude_ids: Vec<String>,
      session_negative_ids: Vec<String>,
      limit: Option<usize>,
  ) -> Result<Vec<Track>, String> {
      let stations = read_all_stations(&lib.data_dir);
      let station = stations.into_iter().find(|s| s.id == station_id)
          .ok_or_else(|| format!("station '{station_id}' nao encontrada"))?;
      let exclude: Vec<u64> = exclude_ids.iter().filter_map(|s| s.parse().ok()).collect();
      let negatives: Vec<u64> = session_negative_ids.iter().filter_map(|s| s.parse().ok()).collect();
      let seed_counts = resolve_artist_counts(&lib, &exclude); // via lib.handle.track(id), mesmo
                                                                 // padrao de lib_get_tracks_by_ids (linha 1977)
      Ok(generate_station_batch(&station, &lib, &exclude, &negatives, &seed_counts, limit.unwrap_or(6)))
  }
  ```
  Registrado em `generate_handler![...]` (linha 3084+), junto de `lib_autoplay_next`/`lib_play_station`.
- `lib_play_station` (linha 3510) e `lib_get_station` (linha 3441): **assinatura Rust inalterada**. Só o valor do `limit` passado pelo frontend muda de call-site (ver abaixo).

### Frontend (TypeScript/Solid)

**`src/store/player.ts`**
- `PlayerStore` (linha 33): novo campo `queueOrigin: string | null` (default `null`, linha ~66).
- `setQueue` (linha 130): novo 4º parâmetro opcional `origin: string | null = null`, grava em `queueOrigin`. Todos os call-sites existentes (Playlist, Album, `restoreSession`, `prefetchRadio`, `doAutoplay`) continuam passando 2-3 args sem quebrar — `queueOrigin` vira `null` implicitamente para eles.

**`src/store/radioSession.ts` (novo módulo)**
```ts
const SESSION_REJECT_RATIO = 0.35; // mais frouxo que o hard-skip global (0.15
                                     // usado em behavioral_signals) -- aqui o
                                     // objetivo e reatividade de curto prazo,
                                     // nao pureza do sinal de longo prazo.
const SKIPPED_CAP = 15;

interface RadioSession {
  stationId: string | null;
  contextId: string | null;
  seenIds: string[];
  skippedIds: string[]; // mais recente primeiro, cap 15
}

export function startRadioSession(stationId: string): string { /* gera contextId, reseta */ }
export function registerSeen(ids: string[]): void { /* seenIds.push, sem dedup agressivo */ }
export function registerSkipIfEarly(trackId: string, positionSecs: number, durationSecs: number): void {
  if (durationSecs > 0 && positionSecs / durationSecs < SESSION_REJECT_RATIO) {
    // unshift + cap SKIPPED_CAP
  }
}
export function resetRadioSession(): void { /* ... */ }
export function currentSession(): RadioSession { /* readonly snapshot */ }
```

**`src/views/Stations.tsx`** (`handleResume`, linha 196-211)
- `const contextId = startRadioSession(id);`
- `const tracks = await libPlayStation(id, STATION_INITIAL_BATCH);` (novo 2º arg — const local `STATION_INITIAL_BATCH = 8`, em vez do default 40 do wrapper)
- `setQueue(tracks, 0, "curated", "station");` (4º arg novo)
- `registerSeen(tracks.map(t => t.id).filter((x): x is string => !!x));`
- `playTrack(tracks[0], "station", contextId);` (3º arg novo)

**`src/components/PlayerBar.tsx`**
- `playTrack` (linha 594): novo 3º parâmetro opcional `contextId?: string`, repassado a `playerPlay(track.path, origin, track.id ?? null, contextId ?? null)` (linha 609).
- Handler `TrackEnded` (linha 113-137): antes de `advanceQueue()`, se `player.queueOrigin === "station"` e restam menos de 2 tracks não tocadas, chama `topUpStation()`. Troca `playTrack(next, "album_seq")` (linha 125, hardcoded) por `playTrack(next, player.queueOrigin ?? "album_seq", currentSession().contextId ?? undefined)` — **Fase 0**: origin real da fila, não literal fixo.
- Handler MPRIS "next" (linha 141-145) e clique manual "next" (linha 497): mesma troca de `"queue"` hardcoded por `player.queueOrigin ?? "queue"`. **Antes** de `advanceQueue()`, se `player.queueOrigin === "station"`: chama `registerSkipIfEarly(player.currentTrack.id, player.positionSecs, player.durationSecs)`, trunca a cauda não tocada (`setPlayer("queue", q => q.slice(0, player.queueIndex + 1))`) e dispara `topUpStation()` **imediatamente** (não espera chegar perto do fim) — este é o mecanismo central da Fase 3.
- Novo helper, mesmo espírito de `prefetchRadio` (linha 248-260):
  ```ts
  async function topUpStation() {
    const session = currentSession();
    if (!session.stationId) return;
    try {
      const tracks = await libStationNext(session.stationId, session.seenIds, session.skippedIds, 6);
      if (!tracks.length) return;
      setQueue([...player.queue, ...tracks], player.queueIndex, "curated", "station");
      registerSeen(tracks.map((t) => t.id).filter((x): x is string => !!x));
    } catch (e) {
      console.error("[station] topup failed:", e);
    }
  }
  ```

**`src/tauri.ts`**
- `playerPlay` (linha 82): novo 4º parâmetro opcional `contextId: string | null = null`, repassado no invoke.
- `playerSetOrigin` (linha 91): novo 3º parâmetro opcional `contextId: string | null = null`.
- `libPlayStation` (linha 396): **assinatura inalterada** (`limit?: number` já existe) — só o valor passado por `Stations.tsx` muda.
- Novo wrapper:
  ```ts
  export const libStationNext = (
    stationId: string, excludeIds: string[], sessionNegativeIds: string[], limit?: number,
  ) => invoke<Track[]>("lib_station_next", { stationId, excludeIds, sessionNegativeIds, limit: limit ?? 6 });
  ```

## Contratos IPC

| Comando | Antes | Depois | Tipo de mudança |
|---|---|---|---|
| `player_play` | `(path, origin?, track_id?)` | `(path, origin?, track_id?, context_id?)` | Aditiva, backward-compatible |
| `player_set_origin` | `(origin, track_id?)` | `(origin, track_id?, context_id?)` | Aditiva, backward-compatible |
| `lib_play_station` | `(id, limit?)` | **sem mudança** | Só o valor do call-site muda |
| `lib_get_station` | `(id, limit?)` | **sem mudança** | Nenhuma |
| `lib_station_next` | não existe | `(station_id, exclude_ids, session_negative_ids, limit?) -> Result<Vec<Track>, String>` | Comando novo |
| `setQueue` (store, não IPC) | `(tracks, startIndex, scope?)` | `(tracks, startIndex, scope?, origin?)` | Aditiva, backward-compatible |
| `playTrack` (store, não IPC) | `(track, origin?)` | `(track, origin?, contextId?)` | Aditiva, backward-compatible |

Nenhum comando existente muda de nome, tipo de retorno, ou shape de payload de `Track[]`.

## Fases de entrega

**Fase 0 — retag de origin (pré-requisito de medição, zero risco de comportamento)**
`setQueue` ganha `origin?`; `PlayerStore.queueOrigin`; `Stations.tsx` passa `"station"`; `PlayerBar.tsx` usa `player.queueOrigin ?? "album_seq"`/`"queue"` em vez dos literais hardcoded nos três handlers de avanço (TrackEnded, MPRIS next, botão next). **Sem isso, nenhuma fase seguinte é mensurável** — hoje quase toda faixa 2..N de uma station cai em `album_seq`, excluída de `behavioral_signals()`.

**Fase 1 — ligar negativos globais no recommend de station (1 correção, zero infra nova)**
`generate_station_tracks` (branch `Seed`) passa a chamar `client.recommend` com os negativos de `behavioral_signals()` em vez de `&[]` fixo. Sem novo IPC, sem novo estado, sem mudança de assinatura. **Mensurável imediatamente após a Fase 0** — é a correção de maior retorno/menor risco do conjunto, isolável do resto.

**Fase 2 — fila incremental + sinal de sessão client-side**
Lote inicial reduzido (`STATION_INITIAL_BATCH = 8`); extração de `generate_station_batch` com `exclude_ids`/`session_negatives`/`seed_counts`; `cap_per_artist_soft_seeded` para continuidade do cap entre lotes; `context_id` aditivo em `play_events` (`insert_play_event`, `create_play_events_indices`, `PlayerSnapshot`, `player_play`/`player_set_origin`); novo comando `lib_station_next`; `radioSession.ts` (só `seenIds` por enquanto); topup disparado quando `queueIndex >= queue.length - 2 && queueOrigin === "station"`, chamando `lib_station_next` em vez de `libAutoplayNext`.

**Fase 3 — o fix central do produto: reação a skip em tempo real**
`radioSession.registerSkipIfEarly` real (limiar 0.35); truncamento da cauda não tocada + `topUpStation()` **imediato** no handler de skip (next manual, MPRIS next, clique em item da queue) enquanto `queueOrigin === "station"`. A partir daqui, skipar dentro da mesma audição realimenta a próxima recomendação — o fechamento literal do gap da missão.

**Fase 4 — calibração e refinamentos opcionais (só após medir 1-3 contra a régua)**
Fallback em camadas explícito quando `combined_negatives` esvazia o pool (se ainda não suficiente); down-weight do seed mais associado aos rejects em stations multi-seed (em vez de tratar todos os seeds igualmente); camada de penalidade suave por `vibe_similarity` complementando os negativos duros do Qdrant (candidatos parecidos ao rejeitado mas não excluídos ainda); extensão de `session_negatives`/`exclude_ids` ao branch `StationKind::Mood`; recalibração dos números v1 (`SESSION_REJECT_RATIO=0.35`, `SKIPPED_CAP=15`, `STATION_INITIAL_BATCH=8`, topup=6) contra dados reais; avaliação de `session_id` por execução do app (aditivo, só auditoria) se fizer falta análises além do escopo de uma rodada.

## Métricas e validação contra a régua

Reaproveita a régua já estabelecida na auditoria (`docs/contexto/09072026-intel-engine-audit.md`), sem inventar métrica nova.

1. **Baseline já registrado**: autoplay 66.4% skip / 57% hard-skip (n=107); `album_seq` 42.5% é o teto de aceitação; station n=1 (métrica hoje contaminada, corrigida pela Fase 0). Meta explícita herdada: **≤55% skip, hard-skip <40%** para `origin=station`.
2. **Corte temporal obrigatório**: anotar o timestamp Unix de cada fase liberada. A partir da Fase 0, o bucket `album_seq` deixa de incluir continuações de station — comparações antes/depois desse corte não são *like-for-like* para `album_seq`; documentar a data de corte em toda consulta.
3. **Query de validação por fase**: agrupar `play_events` por `origin`, calcular `count(listen_pct<0.15)/count(*)` (hard-skip) e `count(event_type="track_skipped")/count(*)` (skip amplo) para `origin="station"`, filtrando `started_at >= <timestamp da fase>`. Comparar Fase 0 (sem mudança de motor) → Fase 1 (negativos globais ligados) → Fase 3 (session-awareness completa), isolando o efeito de cada uma.
4. **Métrica mais direta e falseável (graft prioritário)**: skip-rate por **posição dentro da rodada** — agrupar eventos por `context_id`, ordenar por `started_at`, comparar skip-rate da 1ª/2ª/3ª faixa contra a 4ª/5ª/6ª+ da mesma rodada. Se o mecanismo funciona, essa curva **cai** ao longo da rodada; sem essa queda, a promessa central da missão não está sendo cumprida, independente do agregado por origin.
5. **Smoke test manual antes de esperar volume**: instrumentar `tracing::debug!` em `generate_station_batch` (contagem de `session_negatives` recebidos) e inspecionar via log durante uma sessão manual — skipar 3 faixas de uma vibe e confirmar que a 4ª/5ª sugerida evita candidatos vibe-similares às rejeitadas, antes de esperar dados agregados de uso real.
6. **Sem endpoint de analytics dedicado** nesta entrega — consultas ad-hoc via `scroll_play_events` filtrado por `context_id`/`origin`, no mesmo padrão dos scripts de migração já existentes, rodadas manualmente ao final de cada fase.

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Truncar a cauda da queue no skip pode colidir com o preload gapless (`playerEnqueueNext` já carrega o `.path` da próxima faixa no engine antes do truncamento, linha 100-101 do `PlayerBar.tsx`) | Validar explicitamente antes de liberar a Fase 3: truncar só a partir do índice atual +1 (nunca a posição já pré-carregada no engine); se colidir, adiar o truncamento para o próximo `TrackStarted` em vez de fazê-lo síncrono ao clique |
| `combined_negatives` esvazia o pool candidato (anisotropia do espaço MERT já documentada na auditoria) | Fallback em camadas por seed: retry só com negativos globais, depois sem negativos nenhum, antes de desistir — mesmo padrão de resiliência do `lib_autoplay_next` |
| Cap de artista sem continuidade entre lote inicial e topup | `cap_per_artist_soft_seeded` recebe a contagem de artistas já na fila (resolvida via `lib.handle.track(id)` sobre `exclude_ids`, mesmo custo de `lib_get_tracks_by_ids`) |
| Números v1 não calibrados (`0.35`, `15`, `8`, `6`) | Fase 4 revisita contra dados reais de 1-2 semanas de uso; nenhum é hardcoded em lógica que dependa de precisão fina |
| Mudar a composição do bucket `album_seq` quebra comparabilidade histórica direta do skip-rate desse bucket | Documentar timestamp de corte por fase (ver seção de métricas); não é motivo para reverter — a mudança é estritamente melhor para medição futura |
| Reduzir o lote inicial de 40 para 8 deixa a "Up Next" (`Queue.tsx`/`QueueDrawer.tsx`) visivelmente mais curta logo após abrir uma station | Trade-off aceito: espelha a UX que o modo radio/shuffle aberto já tem hoje via `prefetchRadio` — não é uma UX nova sendo introduzida |
| Dados legados (~4200 eventos sem `context_id`) ficam fora de qualquer análise por posição-na-rodada | Correto por design — não faz sentido atribuir rodada retroativamente; scripts de análise devem tratar isso como corte, não como lacuna a preencher |
| `StationKind::Mood` não recebe `session_negatives` (scroll não é vetorial) | Escopo menor, aceito nesta entrega — `exclude_ids` ainda se aplica como filtro duro; extensão de negatives para Mood fica em "Fora de escopo" |

## Fora de escopo

- **Persistência do sinal de sessão no backend ou sobrevivência a restart do app.** `radioSession` é deliberadamente efêmero e client-side; perder o estado no reload é premissa aceita.
- **`session_id` por execução do app** (identificador de "esta abertura do app", distinto de `context_id` de rodada) — aditivo de baixo custo mencionado pelos juízes, mas não necessário para o mecanismo central; avaliar em Fase 4 se análises futuras precisarem agrupar múltiplas rodadas de uma mesma sessão de uso.
- **`session_negatives` para `StationKind::Mood`** — mood search é scroll, não vetorial; negativos reais não se aplicam da mesma forma. Só `exclude_ids` (hard filter) é estendido a Mood nesta entrega.
- **Down-weight de seed específico em stations multi-seed** (identificar qual seed está sendo mais rejeitado e reduzir seu peso no round-robin) — refinamento de calibração, não bloqueia o ganho central; fica para Fase 4.
- **Extensão do mecanismo de session-awareness ao autoplay puro / shuffle-radio genérico** — autoplay já opera em lookahead-1 recalculado a cada chamada (não sofre do mesmo problema estrutural de station); fora do foco desta missão.
- **Recalibração dos pesos de `rerank.rs`** (`vibe_similarity`: energy/valence/mood_tags/genre) — já rotulados como calibráveis na própria doc do módulo; não é pré-requisito para o fix de session-awareness.
- **Dashboard de analytics dedicada** — medição via scripts ad-hoc contra o Qdrant sidecar, não uma superfície de produto nova.
- **Migração retroativa de `play_events` sem `context_id`/`origin` correto** — dado antigo permanece como está; nenhum backfill.