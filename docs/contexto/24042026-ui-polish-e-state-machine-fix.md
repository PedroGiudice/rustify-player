# Contexto: UI Polish + State Machine Fix + EasyEffects Picker

**Data:** 2026-04-24
**Sessao:** main (working tree nao commitado — 17 arquivos modificados + 5 novos)
**Duracao:** ~2h (discussao conceitual + 4 tarefas + ciclo subagent-review)

---

## O que foi feito

### 1. Discussao conceitual: resampling e stack de audio

Usuario questionou por que Rustify nao usa GStreamer `pipewiresink` como outros players (Strawberry, Lollypop, Rhythmbox). Mapeamento feito:

| Player | Stack real |
|--------|-----------|
| Strawberry/Lollypop/Rhythmbox | GStreamer → pipewiresink → libpipewire |
| Harmonoid | Flutter → media_kit → libmpv → libpipewire |
| mpv | libmpv → ao_pipewire.c → libpipewire |
| Rustify | symphonia → pipewire-rs → libpipewire |

**Conclusao:** todos terminam em libpipewire. Diferenca e o que fica acima. GStreamer traz DLL rate matching, buffer negotiation madura, xrun recovery. Resampling NAO e responsabilidade nossa — PipeWire resolve via graph resampler (speex) ou rate switching automatico.

### 2. Build audio estavel confirmado

Estado INACTIVE + deferred uncork + NODE_LATENCY + NODE_RATE (sem SPA_PARAM_Buffers POD). Usuario: "melhorou muito, nao escutei crackling". SPA_PARAM_Buffers com 1024 frames tinha piorado — sweet spot fica pra watchlist.

### 3. Quatro tarefas de UI/feature polish

Plano executado via subagent-driven-development (4 implementacoes, 4 spec reviews, 4 code quality reviews, re-reviews dos Important flaggados).

#### Tarefa 1: duration_ms padronizacao

**Problema descoberto:** backend ja populava `duration_ms` corretamente. Frontend tinha campo fantasma `duration_secs` em varias views — quebrava display de duration.

**Correcao:** padronizar tudo em `duration_ms` + extrair helper comum.

| Arquivo | Mudanca |
|---------|---------|
| `src/js/utils/format.js` (NOVO) | Export `formatMs(ms)` compartilhado |
| `src/js/views/library.js` | Import formatMs, remove func local |
| `src/js/views/album.js` | Import formatMs, totalMs em ms |
| `src/js/views/queue.js` | Import formatMs, remove fmtDur local |
| `src/js/views/tracks.js` | Import formatMs, remove func local |
| `src/js/views/playlists.js` | Import formatMs, remove func local |
| `src/js/views/now-playing.js` | Remove duration_secs do objeto track |
| `src/js/components/player-bar.js` | Fallbacks `(duration_ms/1000)`, header comment documenta convencao de unidades |
| `src/styles/components.css` | `.queue-row` grid 4→3 colunas (alinha com divs reais) |

#### Tarefa 2: bit_depth + channels na tech strip

**Contexto:** backend ja expunha `TrackInfo.bit_depth` e `channels`. Frontend renderizava bit_depth mas hardcoded "Stereo" e "Bit-Perfect".

**Correcao:** dinamiza via `track.channels` (Mono/Stereo/5.1/7.1/Nch), formato "24-bit" com hyphen, remove "Bit-Perfect" (nao garantido com EasyEffects na cadeia).

Arquivo: `src/js/views/now-playing.js`.

#### Tarefa 3: Bug track switch indo pra pause

**Root cause (engine.rs `cmd_play`):** Fluxo de `player_play(path)` envia Load + Play em sequencia. `cmd_load` seta state = `Loading{play_on_load: false}` mas `self.current` ainda eh a track antiga. `cmd_play` vinha checando `self.current.is_none()` — como nao era None, pulava o branch que seta `play_on_load=true` e setava `state = Playing(track_antiga)`. `install_current` (async) depois fazia match em `PlaybackState::Loading { play_on_load }` — match falhava (state virou Playing) — should_play=false — entrava em Paused.

**Fix em `cmd_play`:** checar `PlaybackState::Loading` ANTES do check de current. Se Loading, seta `play_on_load=true` e return.

**I1 descoberta em review:** `cmd_pause` era assimetrico. Sequencia "Load → Play → Pause-antes-de-prepare" deixava `play_on_load=true`, e install_current depois tocava contra a vontade do usuario.

**Fix em `cmd_pause`:** branch simetrico que detecta Loading, seta `play_on_load=false`, e corka active_stream se existir (elimina janela em que track antiga seguia tocando durante switch mid-playback).

Arquivo: `src-tauri/crates/audio-engine/src/engine.rs` (~30 linhas adicionadas).

#### Tarefa 4: Preset picker EasyEffects

**Backend** — novo modulo `src-tauri/src/easyeffects.rs`:
- `list_presets()` — le `~/.config/easyeffects/output/*.json`, sorted case-insensitive
- `get_current_preset()` — `gsettings get com.github.wwmm.easyeffects last-used-output-preset`, strip quotes
- `apply_preset(name)` — valida (vazio, `\0`, `/`, `-` leading), invoca `easyeffects -p <name>`
- Todas retornam Err se `!is_installed()` (via `which easyeffects`)

**Tauri commands** em `src-tauri/src/lib.rs`: `ee_list_presets`, `ee_get_current_preset`, `ee_apply_preset`.

**Frontend** em `src/js/views/settings.js`: section "EasyEffects" com `hidden` default, `hydrateEEPresets(body)` chamada no final do load. Dropdown + hint do current. Auto-hide se EE nao instalado.

### 4. Ciclo subagent-driven-development

4 spec reviews (paralelos) — todos ✅ compliant. 4 code quality reviews (paralelos) retornaram Important issues:

| Task | Issues flaggadas | Fix aplicado |
|------|------------------|--------------|
| 1 | DRY formatDuration, player-bar semantica mista, queue layout | formatMs extraido, header comment, CSS grid 3 cols |
| 2 | (so Minor) | — |
| 3 | cmd_pause assimetrico, sem teste | Branch simetrico + cork; teste registrado como followup |
| 4 | Flag injection via `-` leading, doc comment mentiroso | Valida starts_with('-'), corrige comment |

Re-reviews dos 3 com Important: todos ✅ approved. Task 3 re-review descobriu I3 acoplado (cork no Loading de cmd_pause) — fix adicional aplicado.

---

## Estado dos arquivos

### Novos (untracked)

| Arquivo | Proposito |
|---------|-----------|
| `src/js/utils/format.js` | Helper `formatMs` compartilhado por 5 views |
| `src-tauri/src/easyeffects.rs` | Modulo EE — list/get/apply presets |

### Modificados (esta sessao)

| Arquivo | Detalhe |
|---------|---------|
| `src-tauri/crates/audio-engine/src/engine.rs` | `cmd_play` detecta Loading antes de current; `cmd_pause` simetrico + cork |
| `src-tauri/src/lib.rs` | `mod easyeffects;` + 3 Tauri commands + registro no invoke_handler |
| `src/js/views/library.js` | Import formatMs, trocar duration_secs → duration_ms |
| `src/js/views/album.js` | Import formatMs, totalMs em ms, /60000 |
| `src/js/views/queue.js` | Import formatMs, duration_ms |
| `src/js/views/tracks.js` | Import formatMs, remove func local |
| `src/js/views/playlists.js` | Import formatMs, remove func local |
| `src/js/views/now-playing.js` | Tech strip dinamico (channels, 24-bit hyphen, remove Bit-Perfect) |
| `src/js/views/settings.js` | Section EasyEffects + hydrateEEPresets |
| `src/js/components/player-bar.js` | Header comment convencao, fallbacks ms/1000 |
| `src/styles/components.css` | `.queue-row` grid 4→3 cols |

### Modificados em sessao anterior (mantidos)

Carry-over das sessoes anteriores (nao commitados ainda): audio-engine pipewire_backend.rs (INACTIVE+uncork), library-indexer (write_pool+recommendations), home.js (sections smart), queue.js (getQueue), player-bar.js (autoplay+shuffle).

---

## Commits desta sessao

Zero. Todo o trabalho esta no working tree. Ultimo commit no main e `365d6d9 fix(now-playing): re-render on TrackStarted/Stopped` (sessao anterior).

Release dev publicada 2x nesta sessao via `./scripts/release.sh` (build apenas, sem git commit).

---

## Decisoes tomadas

- **Manter stack libpipewire direta** (nao migrar pra GStreamer/pipewiresink): controle total, Rust puro, binario pequeno. Custo aceito: reimplementar DLL/buffer negotiation incrementalmente. Descartado: adicionar dep GStreamer (50MB+, tese do projeto perde sentido).
- **Resampling nao e nossa responsabilidade**: PipeWire resolve via graph resampler speex ou rate switching. Correcao de minha resposta anterior que inflava a lista de "falta pra ficar igual".
- **EasyEffects presets via filesystem em vez de `easyeffects -l`**: mais confiavel, nao depende de consistencia de CLI output.
- **cmd_play/cmd_pause: prioridade de state Loading sobre current**: o flag `play_on_load` eh a fonte de verdade durante Loading, nao o conteudo de `self.current`.
- **Teste de regressao e timeout EE**: deferred para followup (tech-debt). Ambos importantes mas nao bloqueiam release.
- **SPA_PARAM_Buffers**: removido definitivamente — 1024 frames piorou, sweet spot entre 1024 e 15053 nao explorado. Se crackling residual voltar em sessao longa, testar 4096 frames.

---

## Metricas

| Metrica | Valor |
|---------|-------|
| Arquivos tocados nesta sessao | 13 (11 M + 2 novos) |
| Linhas adicionadas | ~270 (inclui helper, modulo EE, comments) |
| Duplicacao removida | 5 copias de formatDuration → 1 helper |
| Tarefas executadas | 4 + 1 fix acoplado |
| Spec reviews | 4/4 ✅ compliant |
| Code quality rounds | 2 (rodada 1 flaggou 8 Important, rodada 2 todas ✅) |
| Build time release.sh | ~40s (compile) + ~5s (bundle) na VM |
| Releases publicadas | 2 (dev tag, mesma versao) |

---

## Pendencias identificadas

1. **Teste de regressao do state machine** (media) — matriz minima: `Load→Play→Pause-antes-de-prepare→prepare fires`, `Load→Pause→Play-antes-de-prepare`, `switch-mid-playback + Pause`. Usar mock de `spawn_prepare`. Linear issue vale.
2. **Timeout em `easyeffects -p`** (baixa) — `.status()` bloqueia indefinidamente se daemon EE travar. Fix: `wait_timeout` crate ou thread + channel. Tech-debt.
3. **Commits nao feitos** (media) — working tree tem 17 arquivos modificados + 5 novos. Decidir split: pelo menos 3 commits logicos (audio state machine fix, EE picker, duration_ms refactor + tech strip polish).
4. **Crackling residual em sessao longa** (watchlist) — usuario ainda nao testou sessao longa. Se voltar, proximo passo: SPA_PARAM_Buffers com 4096 frames OU DLL rate matching.
5. **CSS uppercase** (baixa) — reviewer flaggou que `.np__tech-val` pode nao ter `text-transform: uppercase`; se nao tiver, valores ficam mixed-case ("24-bit" ao lado de "FLAC"). Verificar.
6. **Cleanup de scripts/** (baixa) — `scripts/deploy-lyrics.py`, `scripts/fetch-lyrics.py`, `scripts/fetch-lyrics-fast.py` untracked de sessao anterior, revisar se entram no repo.
