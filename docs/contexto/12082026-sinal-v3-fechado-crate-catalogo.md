# Contexto: Sinal v3 fechado (vistoria → balanço líquido) + proposta Crate catálogo

**Data:** 2026-08-12
**Sessão:** main (commits diretos, releases 0.2.66 → 0.2.67 → 0.2.68)
**Duração:** sessão longa (vistoria multi-agente + 3 rodadas de implementação + review adversarial)

---

## O que foi feito

### 1. Vistoria do autoplay (4 auditores paralelos + análise dos 6263 play_events)
Régua medida: autoplay 78,9% skip (n=190), streak de aceitação mediana 0,
80-100% de skip desde W22 — meta v2 (<=55%) não batida. Descoberta central:
**a coleta estava torta** — radio mode logava continuações como `album_seq`
(excluído dos positives) e skips como `queue`: o motor era cego pros
próprios acertos. Diagnóstico completo, números e decisões em
`docs/contexto/12082026-autoplay-vistoria-sinal-v3.md` (NÃO duplicado aqui).

### 2. Sinal v3 em três rodadas (a v3 final = balanço líquido)
A derivação final (`derive_behavioral_signals`, pura, 15 testes) evoluiu na
sessão por 2 decisões de produto do CEO:
- **Rodada 1**: decay 14d, desconto passivo 0.6, likes top-10, positives
  distintos, negatives alargados, conflito por recência.
- **Rodada 2 (CEO: "60% vale muito")**: sinal contínuo
  `clamp((lp−0.30)/0.50)`, qualificação por peso acumulado >= 0.55.
- **Rodada 3 (CEO: "percentual geral da track / duração específica")**:
  **BALANÇO LÍQUIDO** — peso `clamp((lp−0.30)/0.50, −0.6, 1.0)` por evento,
  somado num saldo único por track (escutas somam, skips subtraem, decay
  sobre tudo); saldo decide o lado (positives = saldo>0 + raw>=0.55;
  negatives = saldo<=−0.30); **piso de atenção 90s** no lado positivo
  (full de skit de 40s = 0.44, sem bonificar faixas longas). Substituiu a
  regra de conflito por recência. Skip único expira sozinho em ~2 semanas.
Validação com dados reais (simulação python sobre os 6263 eventos): perfil
resultante coerente (Astrix/Djonga/SICKO MODE/Doechii no topo); **104/300
eventos da janela positiva são escutas parciais que antes valiam zero**.

### 3. Coleta consertada no frontend + repeat + persistência
`contOrigin` radio→autoplay/playlist→playlist; fila radio estampada
`{kind:"radio"}` (doAutoplay/prefetchRadio, prefetch condicionado a kind
radio); record_play 1x; exclusões do autoplay no choke point do store
(setters de fila) com FIFO refresh; repeat one/all reais (origin `repeat`,
gapless repeat-aware, re-enqueue no toggle); pb-next paridade MPRIS;
queueSource/scope persistidos no state.json (restore não rebaixa mais radio
a "solta"); flush de play_event no CloseRequested como `session_interrupted`
(fora de positives E negatives).

### 4. Review adversarial + anotação de vibe
`/code-review high` achou 10; 9 corrigidos (truncate vs conflito, prefetch
re-estampando álbum, MSRV is_none_or, FIFO refresh, flush síncrono/negativo
espúrio, recent_likes payload, choke point, queueSource persistido), 1
refutado. Workflow de 15 anotadores: 368 tracks sem vibe anotadas
(vocabulário fechado, 368/368 válidas), upsert merge → **cobertura
1746/1746**. Artifact: `data/enrichments/2026-08-12-fable-vibe-annotations-368.json`.

### 5. Régua automática (resposta à cobrança do CEO: "esse veredito já existe há meses")
A promessa "medir depois" da v2 nunca foi cumprida — virou mecanismo:
`scripts/metrics/autoplay_regua.py` (skip por origin pós-cutoff v3, streak,
semanas; veredito vs meta 55%) + systemd user timer `rustify-regua.timer`
DIÁRIO 09:00 na VM (CEO rejeitou semanal) + hook SessionStart em
`.claude/settings.json` do repo que injeta `docs/metrics/regua-latest.md`
em toda sessão. Cutoff v3 hardcoded no script: `V3_CUTOFF = 1786500000`.

### 6. Proposta: Crate "como o Spotify" (busca por catálogo) — NÃO implementada
Pergunta do CEO: busca+download com mais resultados que a busca literal.
Diagnóstico: o Crate busca ARQUIVOS em peers; o Spotify busca num CATÁLOGO
e resolve o arquivo depois. Desenho proposto (aceito em espírito pelo CEO,
que notou que capas são fáceis): MusicBrainz como catálogo (artista →
release-groups → recordings, busca entidade), Cover Art Archive pras capas
(URL direta por MBID, sem scraping), ListenBrainz pra similares/
popularidade, badge "no acervo"/"faltando" contra rustify_tracks, e o
Soulseek vira só backend de aquisição (busca slskd disparada com query
canônica ao clicar). Bônus: REDUZ buscas na rede Soulseek (que pune burst).
Fase 1 = busca artista/faixa + discografia + capas + badge + download 1
clique; Fase 2 = similares, popularidade, álbum inteiro (conversa com o
"Fase 2 = album inteiro" pendente da spec do Crate).

## Estado dos arquivos (commits da sessão, tudo pushed)

```
d3245b6 feat(signals): behavioral_signals v3 — decay, passivo, likes, conflito
0eb62f2 feat(autoplay): retry sem negatives, sorteio ponderado, flush fechamento
1be5903 feat(player): coleta de sinal correta — origins, choke point, repeat
8cdbf03 chore: bump v0.2.66 — vistoria, anotações 368/368, docs
12c8453 feat(signals): sinal contínuo + régua automática — bump v0.2.67
88cc1b6 docs: régua diária (não semanal)
5e59a1d feat(signals): balanço líquido + piso de atenção 90s — bump v0.2.68
```

| Área | Arquivos-chave |
|------|----------------|
| Derivação do sinal | `src-tauri/crates/library-indexer/src/qdrant_client.rs` (consts tunáveis no topo de `derive_behavioral_signals`; 15 testes `derive_`) |
| Autoplay | `src-tauri/src/lib.rs` (`lib_autoplay_next`, `weighted_pick_prefix`, on_window_event) |
| Coleta frontend | `src/components/PlayerBar.tsx`, `src/store/player.ts` (choke point), `src/components/PlayerBar.signal.test.tsx` (16 testes) |
| Persistência | `src-tauri/src/persistence.rs` (+queue_scope/source), `src/tauri.ts` |
| Régua | `scripts/metrics/autoplay_regua.py`, `.claude/settings.json` (hook), `~/.config/systemd/user/rustify-regua.{service,timer}` (VM, fora do repo) |

## Decisões (além das já documentadas na doc da vistoria)

- **Balanço líquido em vez de listas independentes + conflito**: pedido
  explícito do CEO ("percentual geral de cada track"). Não voltar atrás.
- **Skip sem desconto de origem**: rejeição de sugestão é o erro que o
  autoplay precisa aprender. | Descartado: descontar negativos passivos.
- **Piso de atenção 90s só no lado positivo**: pune skit, não pune skip
  rápido em dobro. | Descartado: ponderar por minutos absolutos (enviesaria
  o perfil pro cluster eletrônico de faixas longas).
- **Régua DIÁRIA**: CEO questionou o gap semanal; custo ~zero. O script
  protege contra amostra pequena (n<50 = "aguardar").
- **v0.2.66/67 nunca foram instaladas** — a 0.2.68 substitui as duas.

## Métricas

| Métrica | Valor |
|---------|-------|
| Testes Rust workspace | 310 passed, 0 failed |
| Testes frontend | 273 passed (31 files) |
| Cobertura de vibe | 1746/1746 |
| Eventos na banda 0.3-0.9 (janela positiva atual) | 104/300 (antes: peso zero) |
| Linear | CMR-177 (double-load), CMR-178 (anotação auto), CMR-179 (follow-ups) |

## Pendências

1. **(bloqueador da régua) CEO instalar v0.2.68 na cmr-auto** — sem ela a
   coleta nova não roda: `gh release download -R PedroGiudice/rustify-player
   -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.2.68_amd64.deb`.
2. **(alta) Crate catálogo Fase 1** — próximo trabalho combinado (ver prompt
   de retomada com o mesmo slug).
3. **(alta, "crucial" — diretiva do CEO no fechamento) Backend + automação
   dos embeddings de letras e música pra track nova**: o download do
   catálogo só fecha o ciclo se a track entrar no motor completa e sozinha.
   Estado conhecido: MERT 1746/1746 (aparenta automático no ingest —
   VERIFICAR o caminho embed_client/serviço :8448 e falhas silenciosas);
   lyrics vector 1233/1746 = 70,6% (sidecar .lrc via lrclib existe no Crate;
   o EMBEDDING da letra depende de RUSTIFY_LYRICS_EMBED_URL → cogmem :3939
   na VM — dependência de tailnet, provável causa do gap); vibe = batch
   manual (CMR-178). A retomada audita o pipeline e fecha a automação
   ponta-a-ponta.
4. (média) CMR-177 double-load gapless; CMR-178 anotação automática de vibe
   no Crate (o gap de vibe REABRE a cada leva — sobe de prioridade como
   parte da pendência 3).
5. (baixa) CMR-179: station Mood sem cap/shuffle; aversion list de janela
   larga (parcialmente mitigada pelo balanço líquido — reavaliar antes).
