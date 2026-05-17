# Contexto: Handoff Signal/Playlists/Stations/Settings + Beat-sync

**Data:** 2026-05-17
**Sessao:** main (handoff `feature/signal-screens-handoff` + `feature/signal-screens-t7-t9` mergeadas)
**Duracao:** ~6h (cascata de ~20 commits)
**Releases publicadas:** v0.2.7, v0.2.8, v0.2.9

---

## O que foi feito

### 1. Icone novo + cover-art fallback (pre-handoff)
- Substituicao do app icon por cassete paper-outline (1024x1024 source, gerado via Pillow + `tauri icon` pra todos os formatos).
- `CoverArt.tsx` agora usa o mesmo cassete como fallback quando track/album nao tem arte. Background neutro `--bg-soft` por baixo.

### 2. Handoff Signal-screens (10 tasks T1-T10) executado por agent-team de 3 teammates (opus)

Team `signal-screens`:
- **frontend-dev** (opus, worktree isolada) — cascata T2-T9
- **rust-dev** (opus, worktree isolada) — T10 standalone
- **code-reviewer** (opus, read-only) — revisao continua por commit

T1 (setters DSP) executado por um subagent solo ANTES do team. T7-T9 finalizados por subagent solo (frontend-developer em worktree) APOS team-lead matar o team. Code-review de T2-T5/T10 cobertos pelo reviewer; T6-T9 cobertos por mim post-merge.

**Tasks:**

| Task | Arquivo principal | Commit |
|------|-------------------|--------|
| T1   | `src/store/dsp.ts` (+28 setters EQ/Limiter/Bass)                            | 3f8133e |
| T1-fix | `src/store/dsp.ts` (booleans imediatos, sem debounce)                     | 2a0645e |
| T2   | `src/components/dsp/ParamRow.tsx` (slider drag reutilizavel)                | 5b9fafd |
| T3   | `src/components/dsp/Fader.tsx` (fader vertical EQ, dblclick edit)           | 98e93d7 |
| T4   | `src/components/dsp/EqCanvas.tsx` (curva log-scale Catmull-Rom→Bezier)      | 7364374 |
| T5   | `src/components/dsp/StationViz.tsx` (canvas seeds + generated dots, RAF)    | 927af25 |
| T10  | `src-tauri/.../pw_capture.rs` + `SpectrumCanvas.tsx` (beat-sync envelope)   | b1df9ba |
| T6   | `src/views/Signal.tsx` (full impl + 4 paineis + preset bar + dsp-presets.ts) | e32abff |
| T7   | `src/views/Playlists.tsx` (toolbar + Pinned + Smart + All)                  | 1b7b3e8 |
| T8   | `src/views/Stations.tsx` (feature card + StationViz + grid + Live badge)    | 47b3623 |
| T9   | `src/views/Settings.tsx` (4 paineis re-style, preservou update flow + lib stats) | 75ca3b1 |
| close | `chore: encerra handoff signal-screens (T2-T10)`                            | 52d276d |

### 3. Fix post-handoff: presets do Signal realmente wirados
T6 do subagent deixou `PRESETS = ["Flat","Aki Yamamura·v3","HD600",...]` hardcoded do mockup Claude Design + botoes Save/Rename/Delete/Import/Export como "not wired". Portado do `signal.js` legacy:

- `store/dsp-presets.ts` ganhou `loadPresets`/`savePresets`/`getActivePresetName`/`setActivePresetName`/`snapshotCurrentDsp`/`applyPresetToStore`
- `views/Signal.tsx` agora le presets reais do localStorage `rustify-dsp-presets` e `rustify-dsp-active-preset` (mesmas chaves do legacy)
- "Flat" e sempre o primeiro chip → `resetToFlat()`. Os outros sao salvos pelo user.
- Save (prompt nome), Rename, Delete (Flat protegido), Import .json (parseEasyEffects), Export .json (toEasyEffects → Blob download)
- Commit: 3d402c0

### 4. Fix devtools auto-open
`src-tauri/src/lib.rs:2452` chamava `w.open_devtools()` no setup. Removido (comentado, com snippet preservado pra debug via `#[cfg(debug_assertions)]` opcional). Devtools agora so abre via Ctrl+Shift+I.
- Commit: fcf4ad3

### 5. Diagnostico de "desfoque ligeiro" (false alarm)
Hipotese inicial: XWayland + fractional scaling. Diagnostico via SSH na cmr-auto confirmou:
- Sessao Wayland + mutter com `x11-randr-fractional-scaling`
- Display Dell SE2222H 1920×1080
- Rustify rodando via XWayland (esperado, sem `GDK_BACKEND=wayland`)

Causa real revelada pelo usuario apos teste: era a **fonte** que ele tinha mudado no Tweaks. Fix `GDK_BACKEND=wayland` NAO foi implementado. Fica como nota futura caso o sintoma reapareca legitimamente.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/store/dsp.ts` | Modificado | +28 setters; uniformizacao boolean imediato |
| `src/store/dsp.test.ts` | Criado | 3 smoke tests (EQ/Limiter/Bass) |
| `src/store/dsp-presets.ts` | Criado | parseEasyEffects + toEasyEffects + CRUD + applyPresetToStore |
| `src/store/dsp-presets.test.ts` | Criado | 4 smoke tests (load/save/active/apply) |
| `src/components/dsp/ParamRow.tsx` + test | Criado | Slider drag reutilizavel |
| `src/components/dsp/Fader.tsx` + test | Criado | Fader vertical EQ, dblclick edit |
| `src/components/dsp/EqCanvas.tsx` + test | Criado | Canvas log-scale curve |
| `src/components/dsp/StationViz.tsx` + test | Criado | RAF canvas seeds+generated |
| `src/components/SpectrumCanvas.tsx` | Modificado | Consome lowBandMag/rmsEnergy do payload, formula beat-sync |
| `src/tauri.ts` | Modificado | FftPayload estendida |
| `src/views/Signal.tsx` | Reescrito | Stub 147L → 679L com presets reais wirados |
| `src/views/Signal.test.tsx` | Criado | 5 tests TDD (red→green) |
| `src/views/Playlists.tsx` + test | Reescrito | Toolbar + Pinned + Smart + All |
| `src/views/Stations.tsx` + test | Reescrito | Feature card + StationViz + grid |
| `src/views/Settings.tsx` + test | Reescrito | 4 paineis re-style, preservou update flow + lib stats |
| `src/styles/extractor-lab.css` | Modificado | +1257L (CSS das views + components T2-T9 + sig-pbtn:disabled) |
| `src/assets/cassette-fallback.png` | Criado | 1024x1024 cassete pra CoverArt fallback |
| `index.html` | Modificado | Adiciona Iconify CDN |
| `src-tauri/crates/audio-engine/src/output/pw_capture.rs` | Modificado | SpectrumEnvelope { low_band_mag, rms_energy }, envelope follower IIR + RMS lowpass |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modificado | Pipe envelope buffer pro tauri |
| `src-tauri/crates/audio-engine/src/lib.rs` | Modificado | API publica do envelope |
| `src-tauri/src/lib.rs` | Modificado | FftPayload payload + remove auto open_devtools |
| `vitest.config.ts` + `src/test-setup.ts` | Criado | Vitest + jsdom env + stub window.__TAURI__ |
| `package.json` | Modificado | "test": "vitest run", devDeps vitest + @solidjs/testing-library |
| `src-tauri/icons/*` (todos) | Modificado | Regerados a partir do cassete via `tauri icon` |
| `src/components/CoverArt.tsx` | Modificado | Fallback usa cassete em vez de glyph hairline |

## Commits desta sessao

```
7cb22f0 chore(release): v0.2.9
fcf4ad3 fix(setup): nao abre devtools automaticamente no startup
f84e36a chore(release): v0.2.8
3d402c0 fix(signal): wira presets reais (CRUD + import/export EasyEffects)
52d276d chore: encerra handoff signal-screens (T2-T10)
75ca3b1 feat(settings): T9 re-style hi-fi com 4 paineis + beat sync
47b3623 feat(stations): T8 impl hi-fi com feature card + grid + Live badge
1b7b3e8 feat(playlists): T7 impl hi-fi com pinned/smart/all + toolbar
e32abff feat(signal): Signal.tsx full impl com 4 paineis + presets (T6)
b1df9ba feat(audio): beat-sync envelope (T10)
927af25 feat(dsp): StationViz canvas seeds+generated + tests (T5)
7364374 feat(dsp): EqCanvas curva log-scale + tests (T4)
2a0645e fix(dsp): uniformiza setters boolean para chamada imediata
98e93d7 feat(dsp): Fader vertical EQ + tests (T3)
5b9fafd feat(dsp): ParamRow slider reutilizavel + tests (T2)
3f8133e feat(dsp): adiciona setters faltantes em store/dsp.ts (T1)
33a8a76 feat(brand): cassette paper-outline icon + cover-art fallback
```

## Decisoes tomadas

- **Agent-team de 3 (opus) em vez de subagent solo sequencial**: paralelizou rust + frontend + review, ganho de wall-time. Descartado: subagent-driven-development puro (sequencial estrito) — muito lento pra 10 tasks.
- **Subagent solo retomou T7-T9** apos kill do team na session resume: o trabalho remanescente era curto e independente, respawn do team adicionaria overhead.
- **Code-reviewer formal pelo subagent ate T5/T10 + post-merge review pelo team-lead pra T6-T9**: equilibrio entre rigor e velocidade. Reviewer nao fez fix; reportou findings com severity.
- **T1 nit (boolean debounce) corrigido imediatamente, NAO aceito como tech-debt**: usuario explicito — "É assim que a gente acumula débitos que depois nos fodem".
- **Settings: 4 paineis em vez de 5** (subagent T9): integrou update flow como primeira row de About em vez de criar 5o painel. Decisao do subagent, mantida pos-review. Logica do update preservada integralmente.
- **Settings: Volume + Norm preservados em Playback** (subagent T9): spec nao listou explicitamente mas eram do Settings anterior. Mantidos porque "NAO QUEBRAR".
- **LazyStationViz com IntersectionObserver em T8**: bonus do review do T5, RAF para quando feature card sai do viewport — economia CPU.
- **Canvas RGBA hardcoded (EqCanvas, StationViz)**: aceitavel. Canvas2D nao aceita CSS vars; valores batem 1:1 com tokens (--blue-fg = 37,99,235; --fg-1 = 23,23,23). HTML referencia tambem hardcoda. Documentado como tech-debt caso queiramos tematizar dark/light no canvas.
- **Devtools auto-open removido vs deixar atras de `#[cfg(debug_assertions)]`**: removido com snippet comentado preservado. `release.sh` ja builda em release mode, mas mesmo em `tauri dev` o usuario abre devtools quando quer.
- **Hardcoded presets ("Aki Yamamura·v3" etc) removidos**: tinham vindo do mockup Claude Design via T6 do subagent. Trocados por loadPresets() real do localStorage. signal.js legacy ainda existe mas pode ser deletado em proxima sessao (sub-secao 12 da auditoria de funcionalidades perdidas).

## Metricas

| Metrica | Valor |
|---------|-------|
| Commits desta sessao (handoff + fixes) | 17 |
| Releases publicadas | 3 (v0.2.7, v0.2.8, v0.2.9) |
| Tests frontend (vitest) | 56/56 verdes |
| Tests backend (audio-engine) | 29/29 (+ 2 ignored) |
| Linhas adicionadas em extractor-lab.css | +1257 |
| Linhas adicionadas em Signal.tsx | +679 (vs 147L stub anterior) |
| Tamanho .deb v0.2.9 | 45.0 MiB (47.155.426 bytes) |

## Pendencias identificadas

1. **Auditoria de funcionalidades perdidas pendente** (media) — sessao anterior listou 12 items perdidos entre versoes. Apos handoff Signal+T7-T9, Signal/Playlists/Stations/Settings estao OK. Restam:
   - Home — Based on Favorites + Discover + Genre chips (dead code em libRecommendations)
   - Context menu (right-click) nas listas (Tracks/Album/History/Queue)
   - Sidebar nav — Artists/Albums/Tracks/Queue/History (sumiram)
   - Queue view — click nao atualiza queueIndex
   - Album view — Shuffle/duracao/back button
   - SearchBar context-modes
   - Tracks more-button + cover thumb por row
2. **Tweaks ainda nao tem todas as opcoes do legacy** (media, levantada pelo user) — versao atual tem so fontUI/fontMono/fontScale/zoom. Legacy tinha mais (accent, density, sidebar, npLayout, type, glow, 4 scales separadas). Usuario nao pediu restauracao formal — anotado.
2.1. **Tweaks zoom != 1.0 em WebKitGTK** (baixa) — `html.style.zoom` non-integer pode causar subpixel blur. Hoje nao e blocker; documentar caso reapareca.
3. **`signal.js` legacy ainda existe em src/js/views/** (baixa) — `signal.js`, `playlists.js`, `stations.js`, `settings.js` foram substituidos pelas versoes Solid. Spec do handoff dizia "deletar apos validar". Validacao manual feita parcialmente — usuario testando v0.2.9 agora. Deletar quando ok.
4. **Tech-debt tema dark/light no canvas** (baixa) — EqCanvas e StationViz usam RGBA hardcoded. Pra tematizar precisa parsear `getComputedStyle(canvasEl).getPropertyValue('--blue-fg')` no setup.
5. **Diagnostico desfoque global via XWayland** (descartado) — diagnostico hipotetico, fix nao implementado. Usuario confirmou que era a fonte. Caso reapareca legitimamente, fix e setar `GDK_BACKEND=wayland` em `src-tauri/src/main.rs` antes de iniciar Tauri.
6. **Auto spectrumSubscribe sem unsubscribe em SpectrumCanvas** (baixa, flagged pelo code-reviewer no T10) — rust-dev nao adicionou refcount no backend. Se o backend ja for idempotente (validar), e ok. Se nao, vaza subscribers em navegacao repetida da view.
