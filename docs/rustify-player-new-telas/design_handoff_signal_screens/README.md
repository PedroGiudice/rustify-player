# Handoff: Signal · Playlists · Stations · Settings + Now Playing beat-sync

Implementação das 4 telas faltantes do `rustify-player` em Solid + integração mínima da animação Now Playing com o stream de áudio.

---

## TL;DR pra começar

1. Abra **`Rustify ExtractorLab.html`** no navegador. Esse arquivo é a referência visual de **todas as 4 telas novas** + da animação reativa do Now Playing. Use Tweaks (toolbar) pra navegar entre telas e ajustar beat sync.
2. O arquivo é **hi-fi**: cores, tipografia, espaçamentos e interações já são finais. Recriar pixel-perfeito em Solid usando os tokens já definidos em `src/styles/extractor-lab.css`.
3. Os 5 entregáveis são, em ordem de prioridade:
   - **Signal** — porta integral do `src/js/views/signal.js` (vanilla, 1119 linhas, **já funcionando**) pra Solid (`src/views/Signal.tsx` hoje é stub com TODO).
   - **Playlists** — UI nova, **espera backend** (`lib_list_playlists` não existe).
   - **Stations** — UI nova, **espera backend** (sem command de stations).
   - **Settings** — substituir `src/views/Settings.tsx` minimal pela nova versão.
   - **Now Playing beat-sync** — adicionar envelope reativo na `src/components/SpectrumCanvas.tsx` (ou equivalente).

---

## Sobre os arquivos deste pacote

O HTML neste pacote é uma **referência de design feita em vanilla HTML/CSS/JS** — protótipo mostrando look final e comportamento, **não código pra copiar direto**. A tarefa é **recriar essas telas em Solid** usando os padrões já estabelecidos no codebase:

- Store reativo em `src/store/dsp.ts` (já tem toda a tipagem + mutações + persist + applyFullDspState — não duplicar)
- IPC via `src/tauri.ts` (já tem `dspSetEqBand`, `dspSetLimiterThreshold`, etc.)
- Tokens CSS em `src/styles/extractor-lab.css` (já definidos: `--fg-1`, `--bg-paper`, `--blue-fg`, `--font-mono`, `--radius-md`, `--ease-out`, etc.)

Não introduzir libs novas (radix, shadcn, framer, etc.). Solid + CSS puro, igual ao resto do app.

---

## Fidelidade

**Hi-fi.** O HTML referência usa exatamente os tokens de `extractor-lab.css`, então cores e tipografia já estão certos. Layout: copiar dimensões e gaps do HTML literal (`grid-template-columns`, `padding`, etc.). Interações: descritas abaixo.

---

## Estado do codebase relevante

### Backend (`src-tauri/`)

A pipeline real, em `src-tauri/crates/audio-engine/src/output/dsp.rs`:

```
audioconvert → LSP Para EQ x16 Stereo → norm_gain (volume) → LSP Limiter → Calf Bass Enhancer → audioconvert
```

**Existe hoje no backend, totalmente wirado:**
- EQ x16 bands: `dsp_set_eq_band`, `dsp_set_eq_filter_type`, `dsp_set_eq_filter_mode`, `dsp_set_eq_slope`, `dsp_set_eq_solo`, `dsp_set_eq_mute`, `dsp_set_eq_gain`, `dsp_set_eq_mode`, `dsp_set_eq_enabled`
- Limiter: `dsp_set_limiter_enabled`, `dsp_set_limiter_threshold`, `dsp_set_limiter_mode`, `dsp_set_limiter_oversampling`, `dsp_set_limiter_dither`, `dsp_set_limiter_knee`, `dsp_set_limiter_lookahead`, `dsp_set_limiter_attack`, `dsp_set_limiter_release`, `dsp_set_limiter_sc_preamp`, `dsp_set_limiter_stereo_link`, `dsp_set_limiter_boost`, `dsp_set_limiter_gain`, `dsp_set_limiter_alr`, `dsp_set_limiter_alr_attack`, `dsp_set_limiter_alr_release`
- Bass Enhancer: `dsp_set_bass_bypass`, `dsp_set_bass_amount`, `dsp_set_bass_drive`, `dsp_set_bass_blend`, `dsp_set_bass_freq`, `dsp_set_bass_floor`, `dsp_set_bass_floor_active`, `dsp_set_bass_listen`, `dsp_set_bass_levels`
- Master bypass: `dsp_set_bypass`
- ReplayGain normalize: `norm_get_state`, `norm_set_enabled`

**Não existe hoje no backend (mockup mostra como `Roadmap`):**
- Multiband Compressor
- Crossfeed (bs2b)
- Convolver / IR loader
- Maximizer, Gate, Stereo tools, Loudness, Crystalizer, DeEsser, RNNoise, Pitch shift, Reverb
- `lib_list_playlists`, `lib_create_playlist`, smart playlists
- `lib_get_stations`, station seeding/generation

**Não tentar implementar essas no backend nesta tarefa.** A UI já marca tudo claramente como "Roadmap" / "not in chain".

### Frontend Solid (em migração)

| Arquivo | Estado |
|---|---|
| `src/views/Home.tsx` | OK |
| `src/views/NowPlaying.tsx` | OK — precisa só do beat-sync (item 5 abaixo) |
| `src/views/Library.tsx`, `Albums.tsx`, `Artists.tsx`, `Tracks.tsx`, `Album.tsx`, `Artist.tsx`, `History.tsx` | OK |
| `src/views/Signal.tsx` | **Stub** — só stat tiles + master toggles. Editor de bandas é um TODO no JSX. Substituir integralmente. |
| `src/views/Playlists.tsx` | Empty-state — substituir |
| `src/views/Stations.tsx` | Static mock — substituir |
| `src/views/Settings.tsx` | Versão minimal — substituir |
| `src/store/dsp.ts` | **Pronto** — usar como fonte da verdade, não duplicar |
| `src/components/SpectrumBackground*.tsx`, `SpectrumCanvas.tsx`, `FluidBackground.tsx`, `SDFBackground.tsx` | Existem várias variantes do canvas. Item 5 abaixo. |
| `src/js/views/signal.js` (vanilla legacy) | **1119 linhas, funcionando** — é a referência canônica da lógica. Portar pra Solid, não deletar antes de portar. |

---

## Entregáveis

### 1. Signal — `src/views/Signal.tsx` (prioridade alta)

**Esse é o maior entregável.** A referência visual completa está no HTML, screen `data-screen="signal"`. A lógica completa está no vanilla `src/js/views/signal.js`.

Quatro painéis em ordem vertical:

#### 1.1 Top section (acima dos painéis)
- **Master bypass bar** (`.sig-master-bar`): toggle conectado a `toggleBypass()` do `store/dsp.ts`. Subtitle muda dinamicamente baseado em `dsp.bypass`.
- **Stat row** (`.sig-stat-row`): 4 tiles — EQ, Limiter, Bass, Normalize. Cada tile tem `data-on="true|false"` controlando dot azul. Valores derivados de `dsp.eq.enabled`, `dsp.limiter.threshold`, `dsp.bass.enabled`, `normGetState()`.
- **Chain flow** (`.sig-chain`): nodes com `data-on="true"` quando a stage tá ativa. Estático visualmente — só atualiza os `data-on`.
- **Preset bar** (`.sig-presets`): chips de preset (pressed = aria-pressed="true"). Botões Save/Rename/Delete/Import/Export wirados pros mesmos prompts/dialogs que o `signal.js` legacy usa (incluindo `parseEasyEffects` e `toEasyEffects` — copiar essas funções como helpers, ou melhor: extrair pra `src/store/dsp-presets.ts`).

#### 1.2 Parametric Equalizer panel (`.sig-panel` com título "Parametric Equalizer")

Esse é o core. Estrutura:

1. **Canvas da curva** (`.eq-canvas-wrap > #eq-canvas`): 180px de altura. Renderizar com `createEffect` reagindo a `dsp.eq.bands` e `dsp.activeBand`. Lógica de desenho no HTML referência (função `draw()` dentro de `signalEq` IIFE) — log-scale eixo X (20 Hz → 20 kHz), curva Catmull-Rom → Bezier suavizada, fill carbono 5%, dots por banda (azul pra ativa, carbono escuro pras usadas, cinza dim pras zero). **Importante:** o HTML referência usa magnitude em dB linear sobre eixo Y; em produção considerar curva de magnitude real (somar resposta das 16 bands em log freq) — mas pode portar a versão dB-linear primeiro, é o que o `signal.js` legacy faz.

2. **16 faders verticais** (`.faders` > `.fader`): pegar `freq`/`gain_db` de cada `dsp.eq.bands[i]`. Suportar:
   - Click no fader → seta `dsp.activeBand = i` (chama `setActiveBand(i)`)
   - Drag no thumb → atualiza `gain_db` via `setEqBandGain(i, newDb)`. Range −36 → +36 dB. Step 0.1.
   - Double-click no valor → input numérico inline (lógica em `signal.js:559-602`).

3. **Band detail editor** (`.band-detail`): mostra valores da `dsp.eq.bands[dsp.activeBand]`. Três selects:
   - **Type** — `FILTER_TYPES` (já exportado de `store/dsp.ts`), onChange chama `setEqBandType`
   - **Mode** — `FILTER_MODES`, onChange chama `setEqBandMode`
   - **Slope** — `SLOPES`, novo helper a adicionar em `store/dsp.ts` (segue padrão de `setEqBandType`)
   - **Q** read-only por enquanto (display only)
   - **Solo/Mute** buttons (`.sm-toggle`) — chamam `dspSetEqSolo(bandIdx, !solo)` / `dspSetEqMute`. Visual: solo = blue-fg + blue-bg; mute = amber-fg + amber-bg.

4. **Footer EQ** (`.eq-footer`): mode group (IIR/FIR/FFT/SPM) chamando `dspSetEqMode`. Input/output gain sliders chamando `dspSetEqGain(input, output)`.

#### 1.3 Limiter panel

Idêntico em estrutura ao painel do `signal.js` legacy:
- Top: selects Mode/Oversampling/Dither + toggle Boost
- 9 `param-row` sliders: threshold, knee, lookahead, attack, release, sc_preamp, stereo_link, input_gain, output_gain (cada um com seu min/max/unit do HTML referência)
- Subsection ALR: toggle + 2 sliders (alr_attack, alr_release)

Cada slider é um `.param-row` (label + track + value). Implementar como component reutilizável `<ParamRow>` em Solid:

```tsx
// src/components/dsp/ParamRow.tsx
interface ParamRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  decimals?: number;
  onInput: (v: number) => void;
}
```

Comportamento de drag: pointerdown no track captura `setPointerCapture`, calcula `pct = (clientX - rect.left) / rect.width`, value = lerp(min, max, pct). Debounce IPC via `ipcDebounced` do `store/dsp.ts`.

#### 1.4 Bass Enhancer panel

Mesma estrutura: 2 toggles (Listen, Floor) no topo + 7 param-rows (amount, drive, blend, freq, floor, input_gain, output_gain). Conectar com `dsp.bass.*` e `dspSetBass*` IPC.

#### 1.5 Roadmap panel

**Static visual only.** 8 plugin cards (Multiband compressor, Compressor, Maximizer, Gate, Crossfeed, Convolver, Stereo tools, Loudness) sem conexão a backend. Click no card flipa `data-on` localmente e muda o texto "not in chain" → "in chain · last stage" — é demo de UI, sem efeito real. Deixar comentário `// TODO: backend support pending` em cada `onClick`.

### 2. Playlists — `src/views/Playlists.tsx`

UI nova (referência: HTML screen `data-screen="playlists"`). Backend não tem ainda; renderizar **mock data estático** com comentário explícito:

```tsx
// MOCK: backend ainda não expõe lib_list_playlists / lib_create_playlist.
// Quando expor, trocar PINNED_PLAYLISTS / ALL_PLAYLISTS por createResource.
const PINNED_PLAYLISTS = [...]
```

Três seções:
- **Pinned** (3 cards de exemplo, cada cover é grid 2×2 de cover-tones)
- **Smart playlists** (`smart-tbl`) — table com rule mono, updated, tracks, length
- **All playlists** (grid) com primeiro card sendo "New playlist" (dashed border)

Toolbar no topo: search input + botões "New playlist" / "New smart playlist" / "Recently played".

### 3. Stations — `src/views/Stations.tsx`

UI nova (referência: HTML screen `data-screen="stations"`). Substituir o array estático atual. Mantém comentário MOCK até `lib_get_stations` existir.

- **Feature card** (`.st-feature`) — eyebrow "Live · streaming now", título grande "Midnight station", description, chips de seeds, CTA preto "Resume station". Lado direito: canvas `#station-canvas` com viz simulada (3 seed dots azuis pulsando + 28 generated dots cinza conectados por hairlines). Lógica do canvas no HTML referência (`stationViz` IIFE).
- **Grid de st-cards** — 6 stations com cover tone, seed line mono, descrição, stats. Card #1 tem badge "Live" verde no top-right.

### 4. Settings — `src/views/Settings.tsx`

Substituir o arquivo atual (que tem só Crossfade slider + Scrobble toggle + folder picker básico).

Quatro `.set-panel`s:

- **Appearance** — Theme segmented (Light/Dark/Auto), Compact sidebar toggle, Cinema mode kbd display
- **Playback** — Crossfade slider, Gapless toggle, Output device button "Change…", Resume on launch toggle, Scrobble connect button
- **Library** — Music folder + "Trocar…", Re-scan button (accent: `set-folder-btn--accent`), Generate embeddings + count, qdrant restart
- **About** — Grid 6 items mono: Version, Tauri, Backend, Identifier, Branch, License

Hint: "Music folder" mostra `~/Music/library` em mono. Quando trocar, chamar comando Tauri equivalente (não existe ainda — manter botão como visual only e logar TODO).

### 5. Now Playing — Beat-sync envelope (prioridade média)

Hoje o `SpectrumCanvas` (ou `FluidBackground`/`SDFBackground` dependendo da variante ativa) é 100% time-driven (`Math.sin(t * 0.18)` etc). Adicionar envelope reativo seguindo o modelo do HTML mockup (search por `fakeKick` / `fakeEnergy` / `SYNC_STRENGTH` em `Rustify ExtractorLab.html`).

**Regra crítica de fluidez:** o envelope só modula amplitude e ink density. **Nunca toca em fase.** Isso mantém a evolução suave das shapes — sem isso vira screensaver Winamp.

Implementação:

```ts
// Em SpectrumCanvas.tsx (ou onde mora o frame loop):

// 1. Receber dois sinais do backend (já existem via pw_capture.rs spectrum:frame event):
//    - lowBandMag: magnitude média do bin FFT 20–150 Hz, com envelope follower
//                  (attack ~5ms, release ~100ms) aplicado já no Rust
//    - rmsEnergy: RMS slow-averaged (lowpass ~2 Hz) sobre a soma de todas as bands
//
// Se pw_capture.rs ainda não expõe esses campos, adicionar no payload do event
// e fazer envelope follower no Rust (mais barato que JS).

interface SpectrumFrame {
  bins: Float32Array;     // existe hoje
  lowBandMag: number;     // adicionar (0..1, já com follower)
  rmsEnergy: number;      // adicionar (0..1, slow average)
}

// 2. No frame loop:
const SYNC_STRENGTH = 0.55; // expor como setting no Settings.tsx
const breath = 0.85 + 0.15 * Math.sin(t * 0.4);  // mantém o macro
const reactive = 1 + SYNC_STRENGTH * ((rmsEnergy - 0.7) + lowBandMag * 0.32);
const amp = h * 0.17 * breath * reactive;  // amplitude final

const inkAlpha = 0.10 + SYNC_STRENGTH * lowBandMag * 0.05;
ctx.strokeStyle = `rgba(23, 23, 23, ${inkAlpha})`;
```

**Settings tweak associado:** adicionar em Settings.tsx → Appearance section uma row "Beat sync" com segmented (Off / Subtle / Default / Pulse). Persistir em localStorage `rustify-mock-sync` (já é a chave que o mockup usa).

Quando `pw_capture.rs` não está ativo (DSP bypass on, ou track ainda carregando), fallback pra `fakeKick`/`fakeEnergy` time-driven (90 BPM default) — assim a animação continua viva mesmo sem stream real.

---

## Padrões de implementação (do codebase, não negociáveis)

### Solid + Tauri patterns

- **Store mutations:** chamar funções exportadas de `store/dsp.ts` (`setEqBandGain`, `toggleEq`, etc.). **Não chamar `setDsp` direto** das views — quebra o invariant de IPC debounce + persist.
- **IPC:** via wrappers em `src/tauri.ts`. Nunca `invoke()` direto nas views.
- **createResource:** pra dados que vêm de comando Tauri assíncrono (ex: `normGetState`). Pattern em `views/Signal.tsx` atual.
- **createEffect:** pra efeitos colaterais (redraw canvas quando `dsp.eq.bands` mudar).
- **Não usar JSX className condicional via libs externas.** Apenas `class={...}` com template strings ou `classList={...}` de Solid.

### Estilo

- Comentários em **português** seguem o padrão dos arquivos `dsp.ts`, `player.ts`, `Library.tsx` existentes. Comentários técnicos curtos em inglês também aceitáveis (ver `dsp.rs`).
- **Tokens CSS:** sempre `var(--*)`. Nunca hard-code de cores. Lista canônica de tokens disponíveis em `src/styles/extractor-lab.css`.
- **Mono:** `var(--font-mono)` + `font-variant-numeric: tabular-nums` em qualquer valor numérico que possa "dançar" (timestamps, dB, Hz, contadores, sample rates).
- **Espaçamento:** views top-level usam `padding: 28px 40px 56px`. Não inventar. Side gutter de 40px é load-bearing.
- **Motion:** uma curva só, `cubic-bezier(0.4, 0, 0.2, 1)` (`--ease-out`). Durações: 150ms (`--dur-base`), 180ms (`--dur-med`), 250ms pra view transitions. Nada bouncing.

### Iconografia

- **Iconify** via `<iconify-icon icon="lucide:NAME">` web component (já carregado no shell).
- Coleções permitidas: `lucide:` (primeira escolha) e `ph:` (Phosphor, pra ícones não-lucide). Não misturar outras.
- Ícones em UI cinza por default (color: `var(--fg-5)`), `currentColor` herdando.

---

## Validação

Após implementar, validar:

```bash
# 1. Type check (Solid + TS)
bun run check         # ou tsc --noEmit se não tiver script

# 2. Build do app inteiro
cargo check --manifest-path src-tauri/Cargo.toml

# 3. Dev mode
bun run tauri dev
```

**Smoke test manual:**

1. Abrir Signal — confirmar que os 16 faders renderizam com gains corretos vindos do `localStorage`/`store/dsp.ts`
2. Drag em um fader → conferir no `journalctl --user -u <unit>` ou console que IPC foi chamado
3. Click em "Master bypass" → confirmar que os 4 stat tiles + chain nodes refletem o estado
4. Preset chips: importar o JSON `uploads/rap-X600-BT-v1-math.json` (incluído no projeto original) e confirmar que as 16 primeiras bands são carregadas (preset tem 32 bands, downsampled pras primeiras 16 — comportamento atual do `signal.js`)
5. Playlists/Stations: confirmar que as MOCK data renderizam sem erro de import/runtime
6. Settings: trocar tema Light↔Dark, confirmar que `document.body[data-theme]` muda
7. Now Playing: ligar Tweaks → Beat sync → Pulse, confirmar que a respiração da animação fica mais marcada (sem trepidar/perder fluidez)

---

## Arquivos referência neste pacote

- `Rustify ExtractorLab.html` — **prototipo único** com todas as 5 telas + beat sync funcionando. Use Tweaks (toolbar Edit/Tweaks toggle) pra navegar entre telas e ver todos os estados.

## Arquivos no codebase a editar

- `src/views/Signal.tsx` — substituir integralmente
- `src/views/Playlists.tsx` — substituir
- `src/views/Stations.tsx` — substituir
- `src/views/Settings.tsx` — substituir
- `src/components/SpectrumCanvas.tsx` (ou variante ativa) — adicionar envelope reativo
- `src/store/dsp.ts` — adicionar `setEqBandSlope`, `setEqBandSolo`, `setEqBandMute`, `setEqMode`, `setEqGain`, e setters de Limiter/Bass que faltarem (segue padrão de `setEqBandGain`)
- `src/components/dsp/ParamRow.tsx` — **criar** (componente reutilizável)
- `src/components/dsp/EqCanvas.tsx` — **criar** (curva)
- `src/components/dsp/Fader.tsx` — **criar** (fader vertical individual)

## Arquivos no codebase a deletar (após validar)

- `src/js/views/signal.js` — substituído pelo Signal.tsx novo
- `src/js/views/playlists.js`, `stations.js`, `settings.js` — substituídos
