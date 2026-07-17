# Patch: beat-sync via PLL (phase-locked) — `SpectrumCanvas.tsx`

## Por que trocar

O beat-sync atual empurra a **derivada do relógio** (`bgClock += dt*speed*(1 + BEAT_GAIN*beatEnv)`).
Modular velocidade = solavanco a cada kick — lê como jank, não ritmo. E `low_band_mag`
é magnitude contínua (reativa, atrasada, borrada em música constante).

A troca: **detectar onsets → travar um oscilador em fase (PLL) no tempo da música →
modular AMPLITUDE** (nunca velocidade, nunca fase do shape). O PLL dá suavidade
(senoide limpa) + trava (corrige contra os onsets reais). Preditivo, não reativo.

Validado em `Beat Sync Lab.html` (bancada com os 4 modos + scope de lock).

## Invariante mantida

A regra do cabeçalho continua: **envelope só modula amplitude**. A exceção antiga
(beat modula derivada do clock) é REMOVIDA — agora nada toca em fase/velocidade.
Ink density ganha um lift sutil do pulso (opcional, `INK_PULSE`).

---

## Diff

### 1. Constantes — substituir o bloco `BEAT_*`

```ts
// REMOVER: BEAT_GAIN (0.9) e BEAT_TAU — não modulamos mais velocidade.

// ── Onset detection (espelha FluidBackground.tsx) ──
const ONSET_RATIO   = 1.6;   // mag/avg acima disto = candidato a onset
const ONSET_FLOOR   = 0.25;  // mag mínima absoluta (ignora ruído de fundo)
const ONSET_COOLDOWN = 0.20; // s — refratário entre onsets (evita double-trigger)
const ONSET_AVG_TAU = 0.35;  // s — janela da média móvel do nível

// ── PLL ──
const PLL_PHASE_GAIN = 0.5;   // correção proporcional de fase por onset (0..1)
const PLL_TEMPO_GAIN = 0.06;  // correção integral (lenta) do período
const PLL_PERIOD_MIN = 0.30;  // s  (200 BPM)
const PLL_PERIOD_MAX = 1.20;  // s  (50 BPM)
const PLL_LOCK_RISE  = 0.30;  // suavização da confiança de lock
const PLL_LOCK_TAU   = 2.5;   // s — decay do lock sem onsets

// ── Pulso → amplitude ──
const BEAT_DEPTH = 0.55;  // quanto o pulso levanta amplitude no lock pleno
const INK_PULSE  = 0.5;   // lift sutil de ink density (0 = desliga)
```

### 2. Estado (junto dos outros `let` do componente)

```ts
// Onset
let avgMag = 0, lastOnsetT = -1;
// PLL
let pllPeriod = 0.5, pllPhase = 0, pllLocked = 0;
```

Remover `beatEnv` (não é mais usado).

### 3. No frame loop — SUBSTITUIR o bloco beat-boost + avanço do clock

**Antes** (o que existe hoje):
```ts
const beatTarget = fresh && beatSync > 0.5 ? lastLow : 0;
const kBeat = 1 - Math.exp(-dt / BEAT_TAU);
beatEnv += (beatTarget - beatEnv) * kBeat;
bgClock += dt * speed * (1 + BEAT_GAIN * beatEnv);
```

**Depois**:
```ts
// Onset detection sobre a low band (kick). Só quando o stream está vivo.
let onset = false;
if (fresh) {
  avgMag += (lastLow - avgMag) * (1 - Math.exp(-dt / ONSET_AVG_TAU));
  const ratio = lastLow / (avgMag + 1e-4);
  onset = ratio > ONSET_RATIO && lastLow > ONSET_FLOOR && (t - lastOnsetT) > ONSET_COOLDOWN;
  if (onset) lastOnsetT = t;   // t aqui = relógio real em s; use performance.now()*0.001
}

// PLL: avança fase; em cada onset corrige fase (rápido) e período (lento).
pllPhase += dt / pllPeriod;
if (pllPhase >= 1) pllPhase -= 1;
if (onset) {
  let e = pllPhase; if (e > 0.5) e -= 1;      // erro assinado p/ batida mais próxima
  pllPhase -= e * PLL_PHASE_GAIN;
  if (pllPhase < 0) pllPhase += 1;
  pllPeriod *= (1 + e * PLL_TEMPO_GAIN);
  pllPeriod = Math.min(PLL_PERIOD_MAX, Math.max(PLL_PERIOD_MIN, pllPeriod));
  pllLocked += (Math.max(0, Math.min(1, 1 - Math.abs(e) * 3)) - pllLocked) * PLL_LOCK_RISE;
} else {
  pllLocked *= Math.exp(-dt / PLL_LOCK_TAU);
}

// Relógio da animação: SEMPRE velocidade nominal. Beat não toca mais nisto.
bgClock += dt * speed;
```

### 4. Pulso → amplitude (onde hoje se calcula `reactive`/`amp`)

```ts
// Pulso do PLL (só quando beat-sync ligado e travando). Attack rápido + decay
// exponencial = "kick". Escala pela confiança de lock p/ não pulsar no escuro.
let beatPulse = 0;
if (beatSync > 0.5) {
  const ph = pllPhase;
  const shaped = ph < 0.04 ? ph / 0.04 : Math.exp(-(ph - 0.04) * 6.5);
  beatPulse = BEAT_DEPTH * shaped * (0.4 + 0.6 * pllLocked);
}

// Amplitude: breath (contínuo) × envelope contínuo × pulso do beat (discreto).
const reactive = 1 + ENV_GAIN * smoothedEnv + beatPulse;
const amp = h * 0.17 * breath * reactive;

// Ink density ganha um lift sutil do pulso (passe adiante pro renderer se ele aceitar).
const inkBoost = 1 + INK_PULSE * (beatPulse / (BEAT_DEPTH || 1));
```

> Se os renderers não recebem `inkBoost`, ignore-o (item opcional). O ganho real
> está na amplitude — é o que dá o pulso legível sem solavanco.

---

## Tweaks / CSS var

`--bg-beat-sync` continua sendo o liga/desliga (0/1). O slider de intensidade,
se existir, mapeia pra `BEAT_DEPTH` (não mais pra `BEAT_GAIN` de velocidade).
Sugestão de mapa Off/Subtle/Default/Pulse → `BEAT_DEPTH` 0 / 0.3 / 0.55 / 0.85.

## Notas de tempo

- `t` no detector/PLL deve ser **relógio real em segundos** (`performance.now()*0.001`),
  não o `bgClock` virtual — senão o lock deriva quando `bgSpeed ≠ 1`.
- `dt` já vem clampado em 100ms no loop (invariante de foreground). Mantém.
- Custo: ~10 operações/frame. Zero impacto no orçamento 60fps.

## Fallback sem áudio

Sem FFT fresco (`!fresh`): não há onsets, `pllLocked` decai, `beatPulse → 0`.
A animação volta ao breath contínuo puro. Nenhum fallback time-driven é preciso —
o bg segue vivo pela respiração base.
