/* ============================================================
   components/GlBackground.tsx — fundo WebGL do app.

   Alternativa ao SpectrumCanvas (Canvas 2D): mesmo lugar no DOM
   (.app-bg), mesmo sinal (audio-fft), mesma paleta (CSS vars do
   tema/capa/Tweaks). O que muda é o motor — aqui quem desenha é
   a GPU, via as quatro cenas de gl/scenes.ts.

   Ligado/desligado pelo Tweaks (bgEngine). Os dois motores nunca
   rodam juntos: App.tsx monta UM dos dois, então só existe um rAF
   e um contexto GL vivos.

   Degradação: se o browser não der contexto WebGL, o status vai
   pra `glStatus` com o erro e o App cai de volta pro 2D sozinho —
   o usuário vê o motivo no Tweaks, não uma tela preta.

   Orçamento medido no próprio app: `glStatus().fps` é atualizado
   1x/s e aparece no painel. É o gate de performance da feature,
   não um enfeite: se cair abaixo de ~30 na cmr-auto, o caminho é
   trocar de cena (Nébula é a mais barata) ou voltar pro 2D.
   ============================================================ */

import { onCleanup, onMount } from "solid-js";
import { onAudioFft, spectrumSubscribe, type FftPayload } from "../tauri";
import { tweaks } from "../store/tweaks";
import { GlStage } from "../gl/scenes";
import { setGlStatus } from "../gl/meta";
import { readGlPalette, type GlPalette, type Rgb } from "../gl/palette";
import { createGlSignal, stepGlSignal, type GlCfg } from "../gl/signal";
import { stepRgbLerp } from "../lib/rgbLerp";

/** Tempo (ms) sem frame de FFT antes de considerar o stream parado. */
const FFT_STALE_MS = 250;

/** Tau (s) do morph de cor — mesmo do SpectrumCanvas: troca de faixa
    responde rápido, ciclo de paleta é deriva ambiental. */
const INK_TAU = 0.35;

/** De quantos em quantos frames reamostrar as CSS vars (getComputedStyle
    é caro; ~3x/s é o suficiente e é a cadência que o 2D já usa). */
const VAR_SAMPLE_EVERY = 20;

function cfgFromTweaks(): GlCfg {
  const t = tweaks();
  return {
    bassGain: t.bgBassGain,
    midGain: t.bgMidGain,
    trebleGain: t.bgTrebleGain,
    smoothing: t.bgSmoothing,
    speed: t.bgSpeed,
    beatMode: t.bgBeatMode,
    beatDepth: t.bgBeatDepth,
  };
}

export function GlBackground() {
  let canvas!: HTMLCanvasElement;
  let raf = 0;

  onMount(() => {
    let stage: GlStage;
    try {
      stage = new GlStage(canvas, tweaks().bgScene);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGlStatus({ ok: false, renderer: "", error: msg, fps: 0 });
      console.error("[gl] contexto WebGL indisponível:", e);
      return;
    }
    setGlStatus({ ok: true, renderer: stage.rendererName(), error: "", fps: 0 });

    // Uma única chamada de getComputedStyle por amostragem, com as 5
    // leituras agrupadas no mesmo tick — ler var a var custaria cinco
    // reflows em janelas onde o style não está warm (mesmo cuidado
    // documentado no SpectrumCanvas).
    const sampleVars = (): GlPalette => {
      const cs = getComputedStyle(document.documentElement);
      return readGlPalette((name) => cs.getPropertyValue(name).trim());
    };

    // Paleta: alvo amostrado a ~3Hz, corrente interpolada por frame.
    let tgt: GlPalette = sampleVars();
    const cur: GlPalette = {
      canvas: { ...tgt.canvas },
      ink: { ...tgt.ink },
      ink2: { ...tgt.ink2 },
      soft: { ...tgt.soft },
    };
    stage.setPalette(cur);

    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      stage.resize(Math.round(r.width), Math.round(r.height), 1);
    });
    ro.observe(canvas);
    const r0 = canvas.getBoundingClientRect();
    stage.resize(Math.round(r0.width), Math.round(r0.height), 1);

    // Sinal de áudio — mesmo feed do SpectrumCanvas.
    let lastLow = 0, lastMid = 0, lastHigh = 0, lastFftAt = 0;
    let unlistenFft: (() => void) | undefined;
    onAudioFft((p: FftPayload) => {
      lastLow = p.low_band_mag ?? 0;
      lastMid = p.mid_band_mag ?? 0;
      lastHigh = p.high_band_mag ?? 0;
      lastFftAt = performance.now();
    }).then((un) => { unlistenFft = un; });
    spectrumSubscribe().catch(() => {});

    const sig = createGlSignal();
    let lastMs = performance.now();
    let tick = 0;
    let frames = 0, acc = 0;

    function frame() {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !canvas.isConnected) return;

      const nowMs = performance.now();
      const dt = Math.max(0, Math.min(0.1, (nowMs - lastMs) * 0.001));
      lastMs = nowMs;

      if (++tick % VAR_SAMPLE_EVERY === 0) tgt = sampleVars();
      stepRgbLerp(cur.canvas as Rgb, tgt.canvas, dt, INK_TAU);
      stepRgbLerp(cur.ink as Rgb, tgt.ink, dt, INK_TAU);
      stepRgbLerp(cur.ink2 as Rgb, tgt.ink2, dt, INK_TAU);
      stepRgbLerp(cur.soft as Rgb, tgt.soft, dt, INK_TAU);
      stage.setPalette(cur);

      const fresh = lastFftAt !== 0 && nowMs - lastFftAt < FFT_STALE_MS;
      stepGlSignal(sig, dt, fresh, { low: lastLow, mid: lastMid, high: lastHigh }, cfgFromTweaks());

      stage.setScene(tweaks().bgScene);
      stage.frame(sig, dt);

      frames++;
      acc += dt;
      if (acc >= 1) {
        const fps = Math.round(frames / acc);
        frames = 0;
        acc = 0;
        setGlStatus((s) => (s.fps === fps ? s : { ...s, fps }));
      }
    }
    raf = requestAnimationFrame(frame);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      try { unlistenFft?.(); } catch {}
      stage.dispose();
    });
  });

  return <canvas ref={canvas} class="app-bg__canvas" aria-hidden="true" />;
}
