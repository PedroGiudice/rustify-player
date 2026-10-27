/* ============================================================
   components/GlBackground.tsx — fundo WebGL do app.

   Alternativa ao SpectrumCanvas (Canvas 2D): mesmo lugar no DOM
   (.app-bg), mesmo sinal (audio-fft), mesma paleta (CSS vars do
   tema/capa/Tweaks). O que muda é o motor — aqui quem desenha é
   a GPU, via o motor WebGL2 de gl/engine.ts e as cenas de
   gl/registry.ts. O laço (paleta, sinal, fps, falhas) é o de
   gl/host.ts, o mesmo do mobile.

   Ligado/desligado pelo Tweaks (bgEngine) ou pela medição de cenas
   (glSceneOverride). Ao ligar, o fundo nasce do preto; trocar de cena
   dissolve uma na outra (gl/engine.ts, transição). Os dois motores nunca rodam juntos: App.tsx
   monta UM dos dois, então só existe um rAF e um contexto GL vivos.

   Degradação: sem WebGL2, shader que não compila ou contexto
   perdido → glStatus.ok = false com o motivo, e o App cai de volta
   pro 2D sozinho — o usuário vê o motivo no Tweaks, não uma tela
   preta.

   Orçamento medido no próprio app: `glStatus().fps` é atualizado
   1x/s e aparece no painel, e "Medir cenas" no Tweaks mede todas.
   O critério é 60 fps na cmr-auto.
   ============================================================ */

import { onCleanup, onMount } from "solid-js";
import { onAudioFft, spectrumSubscribe, type FftPayload } from "../tauri";
import { bgCalm, tweaks } from "../store/tweaks";
import { startGlHost } from "../gl/host";
import { glSceneOverride } from "../gl/meta";
import { readGlPalette } from "../gl/palette";
import { calmGlCfg, type GlCfg } from "../gl/signal";

/** Tempo (ms) sem frame de FFT antes de considerar o stream parado. */
const FFT_STALE_MS = 250;

function cfgFromTweaks(): GlCfg {
  const t = tweaks();
  const cfg: GlCfg = {
    bassGain: t.bgBassGain,
    midGain: t.bgMidGain,
    trebleGain: t.bgTrebleGain,
    smoothing: t.bgSmoothing,
    speed: t.bgSpeed,
    beatMode: t.bgBeatMode,
    beatDepth: t.bgBeatDepth,
  };
  // Reduzir movimento do sistema: versão calma (A16, store/tweaks.ts bgCalm).
  return bgCalm(t) ? calmGlCfg(cfg) : cfg;
}

export function GlBackground() {
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    // Sinal de áudio — mesmo feed do SpectrumCanvas.
    const bands = { low: 0, mid: 0, high: 0, fresh: false };
    let lastFftAt = 0;
    let unlistenFft: (() => void) | undefined;
    let alive = true;
    onAudioFft((p: FftPayload) => {
      bands.low = p.low_band_mag ?? 0;
      bands.mid = p.mid_band_mag ?? 0;
      bands.high = p.high_band_mag ?? 0;
      lastFftAt = performance.now();
    }).then((un) => {
      if (alive) unlistenFft = un;
      else un();
    });
    spectrumSubscribe().catch(() => {});

    // Tau do morph de cor anunciado pelo ciclo da paleta (--bg-ink-morph),
    // lido no MESMO getComputedStyle da paleta.
    let morphTau: number | null = null;
    const stop = startGlHost({
      canvas,
      tag: "[gl]",
      scene: () => glSceneOverride() ?? tweaks().bgScene,
      // Uma única chamada de getComputedStyle por amostragem, com as
      // leituras agrupadas no mesmo tick (mesmo cuidado do SpectrumCanvas).
      palette: () => {
        const cs = getComputedStyle(document.documentElement);
        const im = parseFloat(cs.getPropertyValue("--bg-ink-morph"));
        morphTau = Number.isFinite(im) ? im : null;
        return readGlPalette((name) => cs.getPropertyValue(name).trim());
      },
      morphTau: () => morphTau,
      // A medição de cenas troca seco: a dissolução entraria na conta.
      transitions: () => glSceneOverride() === null,
      calm: () => bgCalm(tweaks()),
      cfg: cfgFromTweaks,
      bands: (nowMs) => {
        bands.fresh = lastFftAt !== 0 && nowMs - lastFftAt < FFT_STALE_MS;
        return bands;
      },
    });

    onCleanup(() => {
      alive = false;
      stop();
      try { unlistenFft?.(); } catch {}
    });
  });

  return <canvas ref={canvas} class="app-bg__canvas" aria-hidden="true" />;
}
