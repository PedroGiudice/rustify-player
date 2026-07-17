# Contexto: Beat-sync PLL→Speed/Pulse + paleta alternante + chip de origem + leva de curadoria

**Data:** 2026-07-17
**Sessão:** main (rolling dev release, commits diretos)
**Duração:** sessão longa, 5 releases (0.2.53 → 0.2.57) + curadoria + saga do download

---

## O que foi feito

### 1. Beat Sync Lab implementado — v0.2.53
O usuário desenhou no projeto /design (`c5cabb56-e85e-4944-a8af-65fbe978188b`)
o `Beat Sync Lab.html` + `PATCH-beat-sync-PLL.md` (ambos espelhados em
`docs/design-refs/design_handoff_persistent_background/`). Implementação fiel:
`src/lib/beatPll.ts` (puro, TDD 14 testes) — onset detection (ratio sobre média
móvel) + PLL (correção proporcional de fase 0.5 + integral de período 0.06) +
pulso "thump" na AMPLITUDE. Tweaks: `bgBeatDepth` Off/Subtle/Default/Pulse.
`beatBoost.ts` (expandKick/BEAT_GAIN do speed antigo) deletado — depois
ressuscitado na v0.2.56 (ver §5).

### 2. Regressão diagnosticada POR MEDIÇÃO — fix da cadência do audio-fft (v0.2.54)
Usuário reportou bg sem reagir ao BPM pós-0.2.53. Probes via MCP bridge no app
real: o evento `audio-fft` chegava a **7-8.5 Hz** em vez de ~60. Causa: o dedup
do spectrum-emitter (`src-tauri/src/lib.rs`) usava "hash" de só o 1º e o último
byte do FFT — estáveis em música real (kick satura o 1º bin) → emissões puladas.
Fix: campo `.0` do `spectrum_buf` virou contador de geração (produtor
`pw_capture.rs` incrementa por janela; pausa = sem gen = sem emissão) e o
emitter compara geração. Validado pós-release: **62 Hz**.

### 3. Chip de origem da fila na PlayerBar (v0.2.54)
`queueContext ("station"|null)` generalizado em `QueueSource {kind, name?}`
(station/playlist/album/radio; null = solta) em `store/player.ts`. Todas as
call sites de `setQueue` passam a proveniência; `contOrigin()` (logging Fase 0)
intacto. Chip `.pb-src` na linha do artista (mono micro uppercase, nome no
tooltip, station/radio com accent). Validado no app real via MCP.

### 4. Paleta alternante do bg (v0.2.55)
`dominant_palette(source, max)` em `cover.rs`: eleição multi-pico no histograma
de hue da v3 — separação mínima 45° (3 bins), piso 22% dos votos da vencedora;
item 0 == `dominant_color` (que virou wrapper). 5 testes novos. IPC
`get_track_palette` com cache lazy `dominant_palette_v4` (escreve
`dominant_color_v3` junto). Frontend (`lib/adaptiveInk.ts`): busca a paleta,
deriva CADA cor pelo piso de contraste 4:1, cicla o ink do bg a cada 40s
(`INK_CYCLE_MS`, crossfade nativo das props registradas), sempre
começando/voltando pela dominante. Accent da UI FIXO na dominante. Knob
`bgInkCycle` (Alterna/Fixa, default alterna).

### 5. Feedback do usuário → modos Speed/Pulse (v0.2.56)
Usuário: "a versão anterior era melhor na sintonização dos bpms... mais
agressivo, mas melhor" e corrigiu explicitamente: refere-se ao **SPEED** (kick
acelerando o movimento, v0.2.52), não ao pulso. Fato novo a favor: o speed
antigo rodava sobre o sinal colapsado (7 Hz) — com 62 Hz fica melhor ainda.
Implementado: `bgBeatMode` off/speed/pulse (**speed default**) + `bgBeatDepth`
só intensidade (Subtle/Default/Strong; 0.55 → ganho 1.5 calibrado). Migrações
v1 (bool) e v2 (depth 0 = off) preservadas. Vars: `--bg-beat-sync`,
`--bg-beat-mode` (0/1/2), `--bg-beat-depth`.

**Pulse recalibrado com série real**: gravei 105s de `low_band_mag` @ 61.9 Hz
("So It Goes") via MCP e simulei 5 variantes de detector offline. Melhor:
sinal EXPANDIDO (expandKick), ratio 1.4, floor 0.20 → 47 onsets/min e lockMean
0.175 (vs 20/0.113 da calibração do lab). **Conclusão honesta: o lock é parcial
por natureza** — o envelope da low band com bass sustentado não entrega trem de
onsets limpo; detecção robusta exigiria spectral flux no backend (não vale
agora). O gate (0.4+0.6·lock) protege o pulso.

### 5b. Deriva suave no ciclo da paleta (v0.2.57)
Feedback ao vivo: "a transição de cores é muito bruta". O ciclo usava o lerp
padrão do canvas (tau 0.35s, desenhado pra troca de faixa/tema) — numa
superfície do tamanho do bg lê como evento. Fix: tau do lerp virou dinâmico
via `--bg-ink-morph` — o tick do ciclo anuncia tau 3.5s (cor migra ao longo de
~10s) e `applyDerived` (faixa/tema) remove a var, voltando ao rápido. Padrão
CSS-var-como-contrato; sem stepper de setTimeout (anti-padrão banido).
**Pendente de validação subjetiva pelo usuário** (release publicada no
fechamento da sessão).

### 6. Leva de curadoria: 4 gêneros (61 itens) + saga do download
Workflow (scout sonnet + 4 curadores **Opus** + consolidador Opus, por ordem do
usuário): trap BR 13 · funk 16 (2 flancos) · jazz 16 · rock 16. Motores
determinísticos tiveram recall ~zero pros 4 gêneros (perfil seedado por
rap/eletrônica) — curadoria por adjacência de acervo validada no MusicBrainz;
check anti-duplicata 0/32. Relatório:
`docs/curadoria/2026-07-17-leva-trap-funk-jazz-rock.md`. Usuário aprovou TUDO.

CSV montado do journal do workflow (fonte estruturada): 32 faixas + 29 álbuns
expandidos via `expand_albums.py` (316 faixas; BRIME! recuperado com artista
"Febem"; **Oklin — Dialeto Delinquente fora**: não existe no MusicBrainz) =
**359 faixas** em `cmr-auto:~/leva-curadoria-0717.csv`.

**Saga do download** (script `~/baixar_soulseek_teste.py` na cmr-auto):
1. Run 1 morreu sem log (morte por sinal; nohup não segurou a queda do canal ssh).
2. Run 2: 615× **409 Conflict** — slskd tinha **1270 searches acumuladas**
   (persiste em disco; restart não limpa). Limpei via API (`searches.delete`).
3. Run 3 (setsid + `--retry-all` + PYTHONUNBUFFERED): buscas passaram (Nautilus
   7 candidatos, 1 ENQUEUED), mas em seguida a **rede Soulseek passou a devolver
   0 respostas** (penalidade por burst; até busca manual com sleep 12s = 0
   responses com server Connected/LoggedIn). ~376 "sem candidatos" em vazio.
4. Run parada (pkill com truque do colchete). **Re-rodar quando a penalidade
   expirar** — gotchas todos documentados no CLAUDE.md (seção music-curator).

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/lib/beatPll.ts` (+.test) | Criado | PLL + onset (recalibrado) + expandKick/speedBoostGain/BEAT_TAU |
| `src/lib/beatBoost.ts` (+.test) | Deletado | lógica reabsorvida em beatPll.ts |
| `src/components/SpectrumCanvas.tsx` | Modificado | modos speed/pulse, PLL com relógio real, inkBoost pro contour |
| `src-tauri/src/lib.rs` | Modificado | emitter dedup por geração; `get_track_palette` |
| `src-tauri/crates/audio-engine/src/output/pw_capture.rs` | Modificado | gen counter no spectrum_buf |
| `src-tauri/crates/library-indexer/src/cover.rs` | Modificado | `dominant_palette` multi-pico (5 testes); dominant_color = wrapper |
| `src/store/player.ts` | Modificado | `QueueSource {kind,name?}` substitui queueContext |
| `src/components/PlayerBar.tsx` (+.test) | Modificado | chip .pb-src, contOrigin via queueSource, queueSourceLabel |
| `src/views/{Stations,Playlist,Album,Albums,Artist,Home}.tsx` | Modificado | setQueue com proveniência |
| `src/lib/adaptiveInk.ts` | Modificado | paleta + ciclo 40s; accent fixo na dominante |
| `src/store/tweaks.ts` (+.test) | Modificado | bgBeatMode/bgBeatDepth/bgInkCycle + migrações v1/v2 |
| `src/views/Tweaks.tsx` | Modificado | Beat sync (Off/Speed/Pulse) + Beat depth + Ink cycle |
| `src/styles/extractor-lab.css` | Modificado | .pb-src |
| `docs/design-refs/design_handoff_persistent_background/` | Criado | espelho: PATCH-beat-sync-PLL.md + Beat Sync Lab.html |
| `docs/curadoria/2026-07-17-leva-trap-funk-jazz-rock.md` | Criado | relatório da leva (61 itens, aprovado) |
| `CLAUDE.md` | Modificado | gotchas slskd (409/throttle/pkill) |
| `cmr-auto:~/leva-curadoria-0717.csv` | Criado (fora do git) | 359 faixas pra slskd |

## Commits desta sessão

```
a4f4bb4 feat(bg): beat-sync com modos Speed/Pulse — Speed default restaura o clássico (v0.2.56)
8c58d0a feat(bg): paleta alternante da capa — top-3 cores com ciclo de 40s (v0.2.55)
66fae79 docs(curadoria): leva trap BR + funk + jazz + rock — 61 itens consolidados
c2e4aae fix(bg)+feat(playerbar): cadência real do audio-fft + chip de origem da fila (v0.2.54)
0a2ae7c feat(bg): beat-sync via PLL — onset lock, pulso na amplitude (v0.2.53)
```

## Decisões tomadas

- **Speed volta como DEFAULT do beat-sync**: preferência explícita do usuário
  pós-uso ("mais agressivo, mas melhor" + correção "refiro-me à SPEED"). O
  patch PLL condenava speed como jank, mas foi julgado com o emitter quebrado
  (7 Hz) — fato novo legitima a revisão. PLL vira modo "pulse" opcional.
- **Diagnóstico por medição, sempre**: 3 probes via MCP + série real gravada +
  simulação offline de variantes ANTES de recalibrar. A causa raiz (cadência)
  era invisível sem medir.
- **Pulse não persegue lock perfeito**: detector ratio-based sobre envelope com
  bass sustentado tem teto (~47 onsets/min em faixa de 130 BPM). Spectral flux
  no Rust seria o caminho — custo não justificado com Speed atendendo o usuário.
- **Paleta v4 com item 0 == v3**: `dominant_color` vira wrapper de
  `dominant_palette(_,1)` — consistência garantida por teste; accent da UI não
  cicla (UI mudando sozinha = ruído; bg é ambiental).
- **QueueSource em vez de segundo campo**: generalizou queueContext sem quebrar
  o contrato de logging da Fase 0 (contOrigin só lê kind).
- **Curadoria por adjacência**: motores usados como prova de recall-zero pros
  gêneros novos; álbuns dominam onde o formato pede (jazz/rock/funk clássico).
- **Download é decisão humana, execução minha**: usuário aprovou "baixa tudo";
  CSV montado do journal estruturado do workflow (não do markdown).

## Métricas

| Métrica | Valor |
|---------|-------|
| Cadência audio-fft antes → depois | 7-8.5 Hz → 62 Hz |
| Onset detector (série real, melhor variante) | 47 onsets/min, lockMean 0.175 |
| low_band_mag real ("So It Goes") | p50 0.435, p90 0.632, max 0.824 |
| Curadoria | 61 itens (29 álbuns + 32 faixas), 0/32 duplicatas |
| CSV da leva | 359 faixas (Oklin fora — sem MusicBrainz) |
| slskd searches acumuladas (causa dos 409) | 1270 → 0 |
| Testes | vitest 208, library-indexer 135, audio-engine 31 |
| Versão instalada na cmr-auto | 0.2.55 (**0.2.57 publicada, aguarda dpkg**) |

## Pendências identificadas

1. **Design "app full pro" — auth, JWT, etc.** (ALTA — pedido explícito; ver
   prompt de retomada, é a tarefa 1 da próxima sessão).
2. **Instalar v0.2.57 + validar modo Speed E a deriva suave do ciclo** (ALTA) —
   usuário está na 0.2.55; Speed default + Beat depth Strong é o provável ponto
   dele; a transição do ciclo (tau 3.5s) precisa do aval subjetivo dele.
3. **Re-rodar a leva de downloads** (ALTA) — rede Soulseek penalizada por burst;
   testar 1 busca manual antes (0 responses = esperar mais). Comando pronto no
   prompt de retomada. Considerar pacing/lotes no futuro.
4. **Paleta alternante: validar o ciclo no app real** (MÉDIA) — observar
   `--bg-ink-rgb` trocando após 40s em capa multi-cor (probe via MCP).
5. **Oklin — Dialeto Delinquente** (BAIXA) — fora do CSV; baixar manual via
   slskd UI ou expandir tracklist via web.
6. **Session-awareness Fases 1-3** (herdada, MÉDIA) — spec em
   `docs/superpowers/specs/2026-07-12-session-awareness-design.md`.
7. **Validar motor v2/mood stations com dados reais** (herdada, MÉDIA) — usuário
   já reportou qualitativamente que as stations melhoraram ("funcionou").
8. **Pulse: spectral flux no backend** (BAIXA) — só se o modo pulse virar
   prioridade; documentado em beatPll.ts.
