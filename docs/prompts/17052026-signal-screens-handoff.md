# Retomada: Handoff Signal/Playlists/Stations/Settings + Beat-sync

## Contexto rapido

Sessao anterior executou handoff completo de 10 tasks (T1-T10) do Claude Design pra produzir as 4 telas novas do Rustify Player: **Signal** (DSP chain full editor com 16 faders + curva log + 4 paineis), **Playlists** (toolbar + pinned + smart + all), **Stations** (feature card animada + grid), **Settings** (4 paineis re-style). Plus **beat-sync envelope** no backend Rust (SpectrumEnvelope com envelope follower IIR + RMS lowpass) consumido pelo SpectrumCanvas frontend.

Executado por agent-team de 3 (opus): rust-dev, frontend-dev (cascata T2-T9), code-reviewer. T7-T9 finalizados por subagent solo apos kill do team na resume. Fix pos-handoff portou preset CRUD real (vinha como hardcoded copiado do mockup) e removeu auto-open dos devtools no startup.

3 releases publicadas: v0.2.7 (T6+T10), v0.2.8 (T7-T9 + preset fix), v0.2.9 (devtools fix). Branch `main` atual em `7cb22f0`, sincronizada com `origin/main`. 56/56 tests frontend + 29/29 backend verdes.

## Arquivos principais

- `docs/contexto/17052026-signal-screens-handoff.md` — contexto detalhado desta sessao
- `docs/rustify-player-new-telas/design_handoff_signal_screens/README.md` — handoff original do Claude Design
- `src/store/dsp.ts` — store reativo DSP com 28 setters novos
- `src/store/dsp-presets.ts` — CRUD presets + parseEasyEffects + toEasyEffects + applyPresetToStore
- `src/components/dsp/{ParamRow,Fader,EqCanvas,StationViz}.tsx` — primitivas DSP
- `src/views/{Signal,Playlists,Stations,Settings}.tsx` — 4 telas novas
- `src-tauri/crates/audio-engine/src/output/pw_capture.rs` — SpectrumEnvelope backend
- `src/components/SpectrumCanvas.tsx` — frontend beat-sync consumer

## Proximos passos (por prioridade)

### 1. Validar v0.2.9 na cmr-auto e confirmar smoke tests
**Onde:** sessao do usuario na cmr-auto
**O que:** Apos `dpkg -i rustify-player_0.2.9_amd64.deb`, abrir o app e checar:
- Console nao abre sozinho (devtools fix)
- Signal: 16 faders renderizam com gains do localStorage, drag funciona, EqCanvas atualiza, preset chips reais (vazio se nunca salvou; "Flat" + outros se ja salvou), Save/Import/Export wirados
- Stations: feature card com viz pulsando, grid de 6 cards, RAF pausa quando card sai do viewport
- Playlists: 3 pinned + smart table + all grid (mock data ate backend expor lib_list_playlists)
- Settings: 4 paineis, update flow funciona (check + install), library stats renderizam, beat sync segmented persiste em localStorage
- Now Playing: animacao spectrum responde ao audio (low band + RMS), fase fluida sem trepidar
**Por que:** confirmacao final do handoff antes de declarar done
**Verificar:**
```bash
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_0.2.9_amd64.deb
```

### 2. Decidir: deletar `src/js/views/{signal,playlists,stations,settings}.js` legacy
**Onde:** `src/js/views/`
**O que:** spec do handoff dizia "deletar apos validar". Apos confirmacao no passo 1, deletar os 4 arquivos JS legacy e qualquer import morto.
**Por que:** dead code, ja portado pra Solid. signal.js (1118L) particularmente pesado.
**Verificar:**
```bash
grep -rn "from.*js/views/signal" src/ # deve dar 0 matches
bun run test && bun run build
```

### 3. Auditoria de funcionalidades perdidas — fechar items restantes
**Onde:** sessao anterior listou 12 items na auditoria; apos handoff Signal+T7-T9 restam:
- Home: render `recs.based_on_top` + `discover` (dead code em libRecommendations) + Genre chips
- Context menu (right-click) nas listas (Tracks/Album/History/Queue) — `showTrackMenu` foi removido
- Sidebar nav: adicionar Artists/Albums/Tracks/Queue/History (sumiram, hoje so tem Home/Search/Library/Playlists/Stations)
- Queue: click nao atualiza queueIndex
- Album: Shuffle button + duracao total + back button
- SearchBar context-modes (filtro inline Library/History/Queue)
- Tracks: more-button + cover thumb por row
**O que:** priorizar Sidebar nav + context menu primeiro (afetam descobribilidade), Queue/Album/Tracks depois, Home recs e SearchBar por ultimo.
**Por que:** completar restauracao pos-redesign Extractor Lab.
**Verificar:** dev mode + smoke manual.

### 4. Restaurar mais opcoes no Tweaks (se usuario pedir)
**Onde:** `src/js/components/tweaks.js`
**O que:** legacy tinha accent, density, sidebar layout, npLayout, type, glow, 4 scales separadas. Hoje so fontUI/fontMono/fontScale/zoom. Restauracao depende de quais opcoes ainda fazem sentido com novo design system.
**Por que:** usuario mencionou "Tweaks ainda nao tem todas as coisas que tinha antes". Nao bloqueante; restaurar conforme demanda.

### 5. Validar idempotencia de spectrumSubscribe no backend (flag do reviewer T10)
**Onde:** `src-tauri/crates/audio-engine/src/output/pw_capture.rs`, comando `spectrum_subscribe`
**O que:** confirmar que multiplas chamadas a `spectrumSubscribe` no backend nao duplicam fluxo de frames (SpectrumCanvas chama auto no mount sem unsubscribe).
**Por que:** se nao for idempotente, vaza subscribers em navegacao repetida.
**Verificar:** `cargo test -p audio-engine`, inspecionar logica de subscribe.

## Como verificar

```bash
# Tests
cd /home/opc/rustify-player
bun run test                # 56/56 verde
cargo test -p audio-engine  # 29/29 verde

# Build (sanity check, nao publica)
cargo check --manifest-path src-tauri/Cargo.toml

# Branch/commit
git log --oneline -5  # topo deve ser 7cb22f0 chore(release): v0.2.9
git status            # working tree clean (so untracked docs/)
```

## Restricoes

- **NAO compilar localmente na cmr-auto** (i5 8th gen, lento). Sempre via `release.sh` na VM Contabo.
- **NAO compilar a cada edit** — acumular mudancas, compilar uma vez no final (CLAUDE.md do projeto).
- **NAO chamar `invoke()` direto nas views** — sempre via wrappers de `src/tauri.ts`.
- **NAO chamar `setDsp` direto nas views** — sempre via setters de `src/store/dsp.ts` (quebra invariant de debounce + persist).
- **NAO mexer no signal.js legacy** ate decidir delete-lo no passo 2.
- **Booleans no DSP devem ser imediatos** (sem ipcDebounced) — convencao validada por reviewer.
- **Devtools nao deve abrir automaticamente** no startup — manter assim. Pra debug agressivo, `#[cfg(debug_assertions)]` opcional ja documentado em `src-tauri/src/lib.rs:2450`.
- **Canvas RGBA hardcoded** (EqCanvas, StationViz): aceito como tech-debt. Nao "consertar" inventando tokens; valores casam 1:1 com tokens correspondentes.
