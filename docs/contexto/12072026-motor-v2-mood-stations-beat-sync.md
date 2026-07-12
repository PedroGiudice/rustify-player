# Contexto: Motor v2 + mood stations + beat-sync + Fase 0 session-awareness

**Data:** 2026-07-12
**Sessão:** main (rolling dev release, commits diretos)
**Duração:** sessão longa, 5 releases (0.2.48 → 0.2.52)

---

## O que foi feito

### 1. Mood das 72 novatas anotadas — cobertura 1378/1378
Pipeline Opus replicado de 09/07: 3 subagentes (batches de 25, índice LOCAL,
vocabulário FECHADO 24 moods/14 activities inglês), validação 72/72, upsert no
Qdrant da cmr-auto (63 pontos novos + 9 `set_payload` merge preservando
play_count). Operação de dados — efeito imediato, sem release.
Artifact: `data/enrichments/2026-07-11-opus-mood-annotations-leva72.json`.

### 2. Motor v2 (CMR-123 itens 2+3+5) — v0.2.49
Baseline medido em 4577 play_events reais (a régua): **autoplay 66.4% skip /
57% hard-skip** (n=107); album_seq 42.5% é o teto de aceitação; queue 87% é
browsing (não comparável); station n=1 (recém-nascida). Meta: ≤55% skip.

Descoberta central (A/B empírico no Qdrant real, seed psytrance Astrix): o
espaço MERT é **anisotrópico** — sims intra-cluster rap chegam a 0.744+ vs
~0.599 do melhor techno contra seed techno. Logo (a) average_vector colapsa no
cluster dominante (0/15 eletrônica), (b) best_score global TAMBÉM não resgata a
vibe do seed (0/15), (c) o score MERT só vale como RANK, nunca valor absoluto.

Implementado: `strategy: best_score` no recommend; **pool duplo no autoplay**
(vizinhança pura do seed ∪ gosto global, `mert_norm = melhor rank entre pools`,
dedup por id) → 0/15 vira **7/15 eletrônica** no cenário Astrix, rap segue
coerente (11/15); re-rank híbrido pela vibe do seed
(`0.5·mert_norm + 0.5·vibe`, vibe = 0.35·energy + 0.25·valence + 0.30·jaccard(moods)
+ 0.10·genre, dado ausente = 0.5 neutro); cap de 2 por artista (grafia
normalizada "J. Cole"=="J Cole").

### 3. Beat-sync do bg — v0.2.49, calibrado na v0.2.52
Kick (low_band_mag) modula a DERIVADA do relógio virtual (velocidade), contínuo,
sem salto de fase. Toggle `bgBeatSync` em Tweaks. **Calibração por medição real
via MCP** (216 amostras/4s no app): low_band_mag tem p50 0.32, p90 0.62, max
0.68 — nunca chega a 1.0. Fórmula antiga `1+0.9·low` usava ~40% do range =
imperceptível. `expandKick` (lib/beatBoost.ts, pura + testada) remapeia
[0.10,0.60]→[0,1]; BEAT_GAIN 0.9→1.5. Boost típico ~1.3x → ~1.6-2.0x.

### 4. Review adversarial (workflow) — 6 fixes na v0.2.50
13 findings brutos → painel cético 3-lentes → 6 confirmados, 7 refutados.
Fixes: station nunca vem curta (`cap_per_artist_soft` completa com cortados);
`dt` clampado em 100ms no SpectrumCanvas (retorno de foreground não salta fase);
autoplay pula taste-pool sem histórico (era chamada dupla idêntica); 3 testes
reforçados (shuffle_prefix provava permutação mas não que embaralhava;
desempate estável do rerank; vibe_similarity assimétrico).

### 5. Session-awareness (CMR-123 item 4) — design + Fase 0 na v0.2.51
Workflow de design (3 propostas × 3 juízes × síntese) →
`docs/superpowers/specs/2026-07-12-session-awareness-design.md`. O painel achou
2 bugs de Fase 0 que travavam a MEDIÇÃO: (a) só a 1ª faixa de uma station
logava `origin="station"` — continuações entravam como album_seq/queue,
subcontando a régua e tornando a escuta invisível ao `behavioral_signals` (que
exclui album_seq dos positives); (b) `generate_station_tracks` chamava recommend
com negatives SEMPRE vazio. Fix: `queueContext` no player store + `contOrigin()`
nas 5 continuações do PlayerBar; negatives globais ligados na station.

### 6. Mood stations por chips + fix vocabulário PT→EN — v0.2.52
Bug de fundo: `MoodFilters::parse` emitia tags PT (`malhar`, `sombrio`) mas os
enrichments são EN (`workout`, `dark`); filtro Qdrant é match exato → busca por
mood retornava 0 silenciosamente (só coincidências PT==EN como "sensual"
funcionavam). Reescrito: `MOOD_VOCAB`/`ACTIVITY_VOCAB` consts (24+14 EN),
passthrough canônico mood-primeiro (resolve os 4 tokens ambíguos
chill/driving/focus/social), aliases PT/EN → token EN correto. UI:
`MoodStationCreator` na Stations.tsx (chips multi-select + gênero opcional +
autoname). Comando `lib_mood_vocabulary`. Bônus: gênero com `&` ("Funk & Soul")
quebrava o bigram do parser → sanitizado no frontend.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/crates/library-indexer/src/rerank.rs` | Criado | VibeProfile, vibe_similarity, hybrid_rerank_pools, cap_per_artist(_soft) |
| `src-tauri/crates/library-indexer/src/qdrant_client.rs` | Modificado | best_score, get_enrichments_batch, MOOD/ACTIVITY_VOCAB, parse reescrito |
| `src-tauri/src/lib.rs` | Modificado | autoplay pool duplo, station negatives+soft cap, lib_mood_vocabulary, rerank_by_seed_vibe_pools |
| `src-tauri/crates/library-indexer/src/query.rs` | Modificado | recommendations Home com cap + over-fetch |
| `src/lib/beatBoost.ts` (+.test) | Criado | expandKick, BEAT_GAIN — calibração do beat-sync |
| `src/components/SpectrumCanvas.tsx` | Modificado | beat-sync (expandKick), dt clamp 100ms, fresh antes do clock |
| `src/store/player.ts` | Modificado | queueContext ("station"\|null) no setQueue |
| `src/components/PlayerBar.tsx` | Modificado | contOrigin() nas 5 continuações |
| `src/store/tweaks.ts` + `views/Tweaks.tsx` | Modificado | bgBeatSync toggle |
| `src/views/Stations.tsx` (+.test) | Modificado | MoodStationCreator, queueContext no resume |
| `src/tauri.ts` | Modificado | libMoodVocabulary, MoodVocabulary, queueContext |
| `docs/superpowers/specs/2026-07-12-session-awareness-design.md` | Criado | design faseado do item 4 |
| `docs/contexto/09072026-intel-engine-audit.md` | Modificado | seção Motor v2 + update mood 1378 |
| `.claude/agents/rustify-player-dev.md` | Modificado | frontmatter block scalar (estava quebrado) |

## Commits desta sessão

```
97210db fix(bg): beat-sync calibrado com a faixa real do kick (v0.2.52)
12c893d merge(stations): mood station por chips + fix vocabulário PT->EN
8e2f0dc feat(stations): cria mood stations pela UI com vocabulario real
104d6be feat(stations): Fase 0 do session-awareness (v0.2.51)
ddb0aa5 fix(review): 6 findings do review adversarial (v0.2.50)
d015503 release: v0.2.49 — motor v2 + beat-sync
0efad7a feat(autoplay): pool duplo no layer 1 (CMR-123)
7469aca / ca7c5e1 feat(recommend): motor v2 best_score + re-rank + cap
3d8f52f feat(bg): beat-sync do bg motion + toggle Tweaks
a4912ea fix(agents): frontmatter do rustify-player-dev
46a77b6 data(enrichments): 72 novatas anotadas — mood 1378/1378
```

## Decisões tomadas

- **Pool duplo no autoplay** em vez de best_score puro. Motivo: A/B provou que
  best_score global não traz a vizinhança de seed fora do cluster dominante
  (anisotropia). Descartado: só best_score (0/15 eletrônica), só vizinhança do
  seed (4/15 com ruído).
- **Score MERT como RANK, nunca valor**. Motivo: anisotropia medida. A vibe vem
  dos enrichments (cobertura 100%), não do score.
- **Chips em vez de texto livre** na criação de mood station. Motivo: o parser
  de texto é frágil (vocabulário fixo, retorna vazio silencioso); chips só
  deixam selecionar o que existe nos dados.
- **Fix do vocabulário PT→EN entrou junto** com a UI de mood station. Motivo:
  UI sobre parser quebrado = stations vazias; não dá pra separar.
- **Beat-sync calibrado por medição, não palpite**. Motivo: princípio medir-não-
  presumir; o low_band_mag real satura em 0.68, não 1.0.
- **Estado de sessão 100% client-side** (design do item 4). Motivo: evitar
  Mutex/Arc novo no backend; generaliza padrão que já existe (recentlyPlayedIds).
- **Subagentes em Sonnet** desde 2026-07-12 (ordem do usuário).

## Métricas

| Métrica | Valor |
|---------|-------|
| Acervo indexado (Qdrant rustify_tracks) | 1378 tracks |
| Cobertura de mood (track_enrichments) | 1378/1378 |
| Baseline autoplay skip-rate | 66.4% (n=107); hard-skip 57% |
| Meta v2 autoplay/station | ≤55% skip, <40% hard-skip |
| Autoplay Astrix (eletrônica no top-15) | antes 0/15 → v2 7/15 |
| low_band_mag real (kick) | p50 0.32, p90 0.62, max 0.68 |
| Testes | library-indexer 127, root 23, vitest 186 |

## Pendências identificadas

1. **Avaliar melhorias novas do /design** (ALTA — pedido explícito do usuário) —
   ele editou o projeto claude.ai/design (persistent background) direto; a
   próxima sessão puxa e avalia. Ver prompt de retomada.
2. **Session-awareness Fases 1-3** (ALTA) — fila incremental (lote 8), radioSession
   client-side (skips viram negatives ao vivo), skip re-fetch. Design pronto em
   `docs/superpowers/specs/2026-07-12-session-awareness-design.md`.
3. **Validar motor v2/mood stations no uso real** (ALTA) — a régua (skip-rate por
   origin com station agora medida) precisa de dados de uso pra confirmar <55%.
4. **Mood station: AND over-constrain** (MÉDIA) — filtro é AND entre tags; muitos
   chips → interseção vazia. Validação só barra seleção zero. Considerar contador
   "X faixas" ao vivo ou OR.
5. **Calibrar pesos do re-rank contra play_events** (MÉDIA) — pesos 0.5/0.5 e
   0.35/0.25/0.30/0.10 são v1; há ~4.6k eventos rotulados pra regressão offline.
6. **Beat-sync intensidade como slider** (BAIXA) — se o ganho fixo 1.5 não agradar,
   virar knob no Tweaks.
7. Menores do audit ainda abertos: #7 (UI degradação autoplay), #8 (match_avg
   nunca escrito), #10 (set_enrichment sem lock).
