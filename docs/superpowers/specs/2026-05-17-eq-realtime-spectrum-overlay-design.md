# Spec: Real-time post-DSP spectrum overlay no EqCanvas

**Data:** 2026-05-17
**Owner:** frontend (EqCanvas) + Tweaks hub
**Status:** aprovado para implementacao
**Branch alvo:** main (continuacao da serie de polish v0.2.x)

---

## 1. Problema

O canvas do EQ (`src/components/dsp/EqCanvas.tsx`) desenha apenas a curva
parametrica calculada a partir dos parametros das 16 bandas. Ele nao mostra
o que o audio esta realmente fazendo. O usuario quer ver o spectrum REAL
do sinal apos o DSP aplicado, sobreposto a curva, no mesmo plano visual.

"Apos o DSP aplicado" significa: o sinal medido tem que estar depois de
LSP Para EQ → volume → LSP Limiter → Calf Bass Enhancer (a cadeia inteira
de `output/dsp.rs`). Nao adianta medir o sinal cru.

## 2. Dado fonte (ja existe, nao precisa backend novo)

`src-tauri/crates/audio-engine/src/output/pw_capture.rs` captura o monitor
do nosso sink PipeWire, ou seja, o sinal **pos-DSP**. FFT 2048 samples,
janela Hanning, ~60 Hz de refresh. Publica via evento Tauri `audio-fft`:

```ts
interface FftPayload {
  stream_time_ms: number;     // posicao do track (ms)
  magnitudes: number[];       // 1024 bins, dB-mapped em u8 [0..255]
  low_band_mag: number;       // envelope 20-150 Hz, 0..1
  rms_energy: number;         // RMS slow-averaged, 0..1
}
```

**Mapping dB ↔ u8 (do emissor):** `DB_FLOOR = -80.0`, `DB_RANGE = 80.0`.
Decoding no frontend: `db = (u8 / 255) * 80 - 80` (source range [-80, 0] dB).

**Display range x source range:** o backend transporta [-80, 0] dB
(toda a dinamica audivel ate digital full scale). O canvas do EQ usa um
range visual mais apertado [-60, 0] dB pra que as barras tenham
amplitude visivel — abaixo de -60 dB o sinal e silencio funcional pra
visualizacao audiophile. Clamp e cosmetico; nao altera dado.

**Sample rate:** vem do PipeWire negotiation. Default 48000 ate primeiro
frame trazer a taxa real. `bin_hz = sample_rate / FFT_SIZE`.

**Subscribe:** `spectrumSubscribe()` ja e chamado pelo SpectrumCanvas e e
idempotente no backend. EqCanvas pode chamar tambem sem efeito colateral
(refcount no spectrum-emitter).

## 3. Decisoes de design (fixadas no brainstorming)

| Decisao | Valor |
|---|---|
| Tipo de visualizacao | barras verticais com peak-hold |
| Resolucao | 1/3 oitava ISO, 31 bandas (20 Hz a 20 kHz) |
| Cor | herda `--bg-ink-rgb` (CSS var ja controlada pelo Tweaks) |
| Toggle | `eqSpectrumOverlay: boolean` no Tweaks, default `true` |
| A-weighting | nao aplicado — queremos ver o efeito do DSP direto |
| Estrategia render | tudo dentro do EqCanvas existente (Approach 1) |

### 3.1 Centros ISO 1/3 oitava (31 bandas)

```
20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
12500, 16000, 20000
```

**Edges:** banda `i` cobre `[f_center / 2^(1/6), f_center * 2^(1/6)]`.
Constante: `2^(1/6) ≈ 1.122462`.

**Agregacao:** `band_db = max(db_of_bin) for bin in [edge_low, edge_high)`.
Max e nao mean — convencao RTA, capta picos transientes melhor e e o que
faz a barra "respirar" com a musica.

### 3.2 Smoothing

One-pole IIR por banda, dois tempos (attack rapido, release lento):

```
attack_tau = 30 ms
release_tau = 150 ms

dt = tempo desde ultimo audio-fft (≈16ms)
target = max_db_da_banda
if target > bandMags[b]:
    bandMags[b] += (target - bandMags[b]) * (1 - exp(-dt/attack_tau))
else:
    bandMags[b] += (target - bandMags[b]) * (1 - exp(-dt/release_tau))
```

### 3.3 Peak-hold

Por banda:

```
hold_time = 1.5 s
decay_rate = 18 dB/s

if bandMags[b] > bandPeaks[b]:
    bandPeaks[b] = bandMags[b]
    bandPeakAge[b] = 0
else:
    bandPeakAge[b] += dt
    if bandPeakAge[b] > hold_time:
        bandPeaks[b] -= decay_rate * dt
        if bandPeaks[b] < bandMags[b]:
            bandPeaks[b] = bandMags[b]
```

## 4. Arquitetura

```
audio-fft event (60Hz, pos-DSP)
    └── EqCanvas.tsx (NOVO consumidor)
        ├── createEffect ouve player.isPlaying + tweaks.eqSpectrumOverlay
        ├── liga/desliga listener via onAudioFft
        ├── liga/desliga rAF loop (draw em 60Hz quando ativo)
        ├── estado fora do Solid signal (mesmo padrao do SpectrumCanvas):
        │   - bandMags: Float32Array(31)
        │   - bandPeaks: Float32Array(31)
        │   - bandPeakAge: Float32Array(31)
        │   - lastFftAt: number
        │   - bandBinRanges: precomputado, recalcula on sample_rate change
        └── draw() em ordem z:
            1. grid horizontal (hairline)
            2. ticks verticais (decadas)
            3. spectrum bars (NOVO)
            4. spectrum peaks (NOVO)
            5. curve fill (carbono 5%)
            6. curve stroke (carbono 72%)
            7. dots por banda
            8. eixo Y labels (HTML por cima)
```

## 5. Mudancas por arquivo

### 5.1 `src/store/tweaks.ts`

Adicionar:
- Campo `eqSpectrumOverlay: boolean` no schema TweaksState
- Default `true` em DEFAULTS
- Migration: aceitar ausencia do campo (`tweaks.eqSpectrumOverlay ?? true`)
- `applyTweaks` seta `data-eq-spectrum="on"|"off"` no `<html>` (apenas
  pra debug/inspecao; o EqCanvas le o signal direto, nao a CSS var)

### 5.2 `src/views/Tweaks.tsx`

Adicionar `<Segmented label="EQ spectrum overlay" options={["On","Off"]}>`
proximo ao bg-ink picker — sao da mesma familia (visualizacoes do app).

### 5.3 `src/components/dsp/EqCanvas.tsx`

Mudancas:

1. **Imports:** `onAudioFft`, `spectrumSubscribe` de `../../tauri`.
   Tambem importar o signal `player` (de `../../store/player`, ja existe)
   e `tweaks` (de `../../store/tweaks`).

2. **Estado modular (fora do componente, escopo arquivo):**
   ```ts
   const NUM_BANDS = 31;
   const ISO_CENTERS = [20, 25, 31.5, /* ... 31 valores */];
   const SIXTH_OCT = Math.pow(2, 1/6);
   const ATTACK_TAU_S = 0.030;
   const RELEASE_TAU_S = 0.150;
   const PEAK_HOLD_S = 1.5;
   const PEAK_DECAY_DBS = 18;
   const FFT_SIZE = 2048;
   const NUM_BINS = 1024;
   const DEFAULT_SR = 48000;
   const SPECTRUM_DB_MIN = -60;
   const SPECTRUM_DB_MAX = 0;
   ```

3. **Estado interno do componente (refs, nao signals):**
   ```ts
   const bandMags = new Float32Array(NUM_BANDS).fill(-80);
   const bandPeaks = new Float32Array(NUM_BANDS).fill(-80);
   const bandPeakAge = new Float32Array(NUM_BANDS);
   let bandBinRanges: Array<[number,number]> = computeBinRanges(DEFAULT_SR);
   let cachedSampleRate = DEFAULT_SR;
   let lastFftAt = 0;
   let lastDrawAt = 0;
   let raf = 0;
   let unlisten: (() => void) | null = null;
   ```

4. **Function `computeBinRanges(sampleRate)`:**
   Pra cada centro ISO, calcula `[startBin, endBin)` onde
   `bin_hz = sampleRate / FFT_SIZE`. Retorna array de 31 ranges.

5. **Function `decodeDb(u8)`:** `(u8 / 255) * 80 - 80`.

6. **Listener handler `onFft(payload)`:**
   ```
   if payload.sample_rate != cachedSampleRate:
       cachedSampleRate = payload.sample_rate
       bandBinRanges = computeBinRanges(cachedSampleRate)
   now = performance.now()
   dt = (now - lastFftAt) / 1000  (clamp em [0.001, 0.1] na primeira frame)
   pra cada banda b em 0..31:
       maxDb = -80
       pra cada bin em bandBinRanges[b]:
           db = decodeDb(payload.magnitudes[bin])
           if db > maxDb: maxDb = db
       aplica IIR attack/release em bandMags[b] com target=maxDb
       atualiza bandPeaks[b] / bandPeakAge[b] conforme regras 3.3
   lastFftAt = now
   ```
   O campo `sample_rate` no payload e novo — adicionado nesta spec.
   Default cachedSampleRate inicia em 48000 e e substituido no primeiro
   frame real. Mudanca de SR mid-stream (ex: 44.1 → 48) recomputa ranges
   sem perder estado.

7. **rAF loop `frame(now)`:**
   ```
   dtDraw = (now - lastDrawAt) / 1000
   lastDrawAt = now
   // decay peak hold tambem entre fft frames pra suavidade visual:
   pra cada banda: peakAge += dtDraw; aplicar decay se age > hold
   draw()
   if tweaks.eqSpectrumOverlay && player.isPlaying:
       raf = requestAnimationFrame(frame)
   ```

8. **`createEffect` rege ciclo de vida:**
   - Reage a `tweaks.eqSpectrumOverlay`, `player.isPlaying`, e props.bands
   - Quando overlay=true && isPlaying: garante unlisten existente,
     chama `spectrumSubscribe()`, registra `onAudioFft` se nao tem,
     inicia rAF loop
   - Quando overlay=false ou !isPlaying: cancela raf, drena listener,
     desenha uma frame estatica (so a curva, sem barras)
   - Mudancas em props.bands: trigga redraw imediato (mesmo padrao atual)

9. **`onCleanup`:** desinscreve listener, cancela raf, disconnect observer.

10. **`draw()`:** insere entre o passo de ticks verticais e o passo de
    curve fill duas novas etapas:

    ```ts
    // ── Spectrum bars (NOVO) ──
    if (tweaks.eqSpectrumOverlay && bandMags.length) {
      const inkRgb = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-ink-rgb').trim() || '23,23,23';
      const bottom = h - 4;  // 4px margem inferior
      const top = 4;          // 4px margem superior
      const usableH = bottom - top;
      const dbRange = SPECTRUM_DB_MAX - SPECTRUM_DB_MIN;  // 60

      const barDbToY = (db: number) => {
        const norm = (Math.max(SPECTRUM_DB_MIN, Math.min(SPECTRUM_DB_MAX, db))
                      - SPECTRUM_DB_MIN) / dbRange;
        return bottom - norm * usableH;
      };

      ctx.fillStyle = `rgba(${inkRgb}, 0.22)`;
      for (let i = 0; i < NUM_BANDS; i++) {
        const f = ISO_CENTERS[i];
        const xCenter = freqToX(f, PAD_X, innerW);
        // largura: 70% do espaco ate o proximo centro
        const xNext = i < NUM_BANDS - 1
          ? freqToX(ISO_CENTERS[i+1], PAD_X, innerW)
          : xCenter + (xCenter - freqToX(ISO_CENTERS[i-1], PAD_X, innerW));
        const slotW = xNext - xCenter;
        const barW = Math.max(2, slotW * 0.7);
        const x = xCenter - barW / 2;
        const yTop = barDbToY(bandMags[i]);
        ctx.fillRect(x, yTop, barW, bottom - yTop);
      }

      // peaks (hairline horizontal)
      ctx.fillStyle = `rgba(${inkRgb}, 0.55)`;
      for (let i = 0; i < NUM_BANDS; i++) {
        const f = ISO_CENTERS[i];
        const xCenter = freqToX(f, PAD_X, innerW);
        const xNext = /* mesmo calculo */;
        const slotW = xNext - xCenter;
        const barW = Math.max(2, slotW * 0.7);
        const x = xCenter - barW / 2;
        const yPeak = barDbToY(bandPeaks[i]);
        ctx.fillRect(x, yPeak, barW, 1.5);
      }
    }
    ```

### 5.4 `src-tauri/src/lib.rs`

Adicionar campo `sample_rate: u32` ao `FftPayload`. Preencher no
emissor do spectrum (busca o `sample_rate_pub` que ja vive no
audio-engine). Retrocompativel — o frontend ate hoje nao usa esse campo.

### 5.5 `src-tauri/crates/audio-engine/src/lib.rs`

Expor o `sample_rate_pub` no `AudioEngineState` (ou similar). Provavel
que ja exista um getter — se nao, adicionar.

### 5.6 `src/tauri.ts`

Atualizar interface `FftPayload` adicionando `sample_rate: number`.

## 6. Performance budget

| Etapa | Frequencia | Custo estimado |
|---|---|---|
| onFft handler | 60 Hz | <0.15 ms (31 bandas × ~32 bins/banda) |
| frame() rAF | 60 Hz quando overlay+playing | <0.5 ms (62 fillRect + decay loop) |
| getComputedStyle('--bg-ink-rgb') | 60 Hz | <0.02 ms (uma var, sem reflow) |
| draw() completo | 60 Hz | <2 ms total no canvas pequeno |

Bem dentro do orcamento de 16 ms/frame. Sem alocacoes per frame (todos
arrays sao preallocated).

## 7. Testes (TDD)

### 7.1 Unit tests (Vitest, sem canvas)

**`src/components/dsp/__tests__/spectrum-bands.test.ts` (NOVO)**

```ts
describe('computeBinRanges', () => {
  test('returns 31 ranges for 48kHz', () => { ... });
  test('20Hz band starts at bin 1, not 0 (DC excluded)', () => { ... });
  test('20kHz band end clamps to NUM_BINS', () => { ... });
  test('ranges are monotonically increasing', () => { ... });
  test('44.1kHz produces different ranges than 48kHz', () => { ... });
});

describe('decodeDb', () => {
  test('u8=0 -> -80 dB', () => { ... });
  test('u8=255 -> 0 dB', () => { ... });
  test('u8=128 -> ~-40 dB (mid)', () => { ... });
});

describe('IIR smoothing', () => {
  test('attack reaches 63% in ~30ms', () => { ... });
  test('release reaches 37% in ~150ms', () => { ... });
});

describe('peak-hold', () => {
  test('peak above current mag stays for 1.5s', () => { ... });
  test('decay at 18 dB/s after hold expires', () => { ... });
  test('peak never drops below current mag', () => { ... });
});
```

### 7.2 Component test

**`EqCanvas.test.tsx` (atualizar)**

- Quando `tweaks.eqSpectrumOverlay = false`: draw apenas curva (mocar
  getContext, verificar que fillRect nao foi chamado pra barras)
- Quando `tweaks.eqSpectrumOverlay = true` e isPlaying e payload mock
  com magnitudes nao-zero: fillRect chamado 31 vezes (barras) + 31 vezes
  (peaks)
- Toggle off durante play: rAF cancelado, listener removido

## 8. Error handling / fallback

- **Sem audio-fft nos ultimos 250ms:** barras decaem via release ao -80 dB
  e ficam invisiveis. Sem fake fallback.
- **`spectrumSubscribe` rejeita:** `.catch(() => {})` silent (mesmo
  padrao do SpectrumCanvas).
- **`magnitudes.length !== NUM_BINS`:** ignore frame, log warn 1x.
- **Sample rate 0 ou invalid:** mantem `cachedSampleRate` anterior.

## 9. Edge cases

| Caso | Comportamento |
|---|---|
| Track muda | listener continua, bandMags continuam de onde estavam, decay natural |
| Pause | createEffect cancela rAF; barras congelam no ultimo estado por 1 frame, depois canvas redesenha apenas a curva |
| Toggle off com som tocando | desinscreve listener, redraw imediato so com curva |
| Sample rate muda mid-stream (44.1 -> 48) | recompute bandBinRanges no proximo frame onde `payload.sample_rate != cachedSampleRate` |
| Resize do canvas | ResizeObserver dispara redraw normal; estado de barras preservado |
| Canvas com largura zero | early return (ja existente em `draw()`) |

## 10. Out of scope

- A-weighting / C-weighting (nao audiofilo nesse contexto — queremos ver o
  DSP, nao a curva auditiva)
- Banda critica Bark (1/3 oitava ja e bom proxy perceptual)
- Spectrum em logaritmo de magnitude vs linear (ja decidido: log dB)
- Histograma temporal / waterfall (fora do escopo deste spec)
- Peak hold por banda independente vs global (decidido: por banda)
- Spectrum salvo entre sessoes (efemero)

## 11. Criterios de aceite

1. Com track tocando e overlay on, vejo 31 barras verticais sob a curva
   do EQ, com peaks hairline acima de cada barra.
2. As barras respondem ao DSP: se eu subo +12 dB em 1 kHz no EQ, a banda
   1 kHz do spectrum sobe proporcionalmente. Mute na banda derruba-a.
3. As barras herdam a cor de `--bg-ink-rgb` — mudar a cor no Tweaks muda
   a cor das barras imediatamente.
4. Toggle "EQ spectrum overlay" em Tweaks oculta as barras (apenas a
   curva permanece).
5. Sem audio tocando, as barras desaparecem (decay natural) e o canvas
   redesenha apenas a curva.
6. Performance: nenhum frame drop visivel durante reproducao normal.

## 12. Versao e release

- Bump patch: `0.2.22 -> 0.2.23`
- Branch: continuar em `main`
- Release via `./scripts/release.sh` apos verificacao

## 13. Riscos

| Risco | Mitigacao |
|---|---|
| Adicionar `sample_rate` ao FftPayload quebra deserializacao antiga | Nao quebra — serde aceita campos extras por default; e o frontend ja vai consumir |
| rAF loop competindo com SpectrumCanvas | Ambos sao 60Hz mas o canvas do EQ e pequeno — overhead absoluto baixo |
| Bg-ink muito escuro torna barras invisiveis | Default e visivel; user controla via Tweaks. Se ficar problema, fallback minimo de alpha (clamp em 0.10) |
| 31 barras + 16 dots na curva poluem demais | Layering testado: barras atras, curva no topo. Dots ativos sao 4px (legivel) |
