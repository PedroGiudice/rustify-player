// src/components/LevelMeter.tsx — medidor estéreo da barra do player: VU
// (barra) e pico retido (marca) por canal, em dBFS de -48 a 0, lidos da
// saída real (lib/levels.ts). Escreve direto no DOM, sem signal: 60
// atualizações por segundo não passam pelo Solid. E só escreve quando o passo
// visível (1/80, lib/meter.ts quantFrac) ou o clip mudam (A24).
// Só assina enquanto toca; com movimento reduzido fica parado. Sem faixa, some
// guardando os 40 px (a coluna da direita não pula ao começar a tocar).
import { createEffect, onCleanup } from "solid-js";
import { player } from "../store/player";
import { subscribeLevels } from "../lib/levels";
import { toFrac, quantFrac, METER_FLOOR_DB } from "../lib/meter";

/** Pico acima disto (dBFS) acende a marca no sinal de erro: perto de clipar. */
const CLIP_DB = -0.5;

export function LevelMeter() {
  const ch: HTMLElement[] = [];
  const fill: HTMLElement[] = [];
  const peak: HTMLElement[] = [];
  const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  createEffect(() => {
    if (!player.isPlaying || reduced()) return;
    // Último valor escrito por canal: NaN força a primeira escrita.
    const lastFill = [NaN, NaN];
    const lastPeak = [NaN, NaN];
    const lastClip = [false, false];
    const off = subscribeLevels((m) => {
      for (const c of [0, 1]) {
        const f = quantFrac(toFrac(m.vu[c]));
        if (f !== lastFill[c]) {
          lastFill[c] = f;
          fill[c].style.transform = `scaleX(${f})`;
        }
        const p = quantFrac((m.peakDb[c] - METER_FLOOR_DB) / -METER_FLOOR_DB);
        if (p !== lastPeak[c]) {
          lastPeak[c] = p;
          peak[c].style.transform = `translateX(${(p - 1) * 100}%)`;
        }
        // O pico retido segura 1,5 s acima do limite: o canal fica marcado
        // durante a retenção, não só no quadro do clip.
        const clip = m.peakDb[c] > CLIP_DB;
        if (clip !== lastClip[c] || ch[c].dataset.clip === undefined) {
          lastClip[c] = clip;
          ch[c].dataset.clip = clip ? "true" : "false";
        }
      }
    });
    onCleanup(() => {
      off();
      for (const c of [0, 1]) {
        fill[c].style.transform = "scaleX(0)";
        peak[c].style.transform = "translateX(-100%)";
        ch[c].dataset.clip = "false";
      }
    });
  });

  return (
    <div
      class="pb-meter"
      data-empty={player.currentTrack ? undefined : "true"}
      aria-hidden="true"
      title="Nível de saída (L/R), VU e pico"
    >
      {[0, 1].map((c) => (
        <div class="pb-meter__ch" ref={(el) => (ch[c] = el)}>
          <span class="pb-meter__fill" ref={(el) => (fill[c] = el)} />
          <span class="pb-meter__peak" ref={(el) => (peak[c] = el)} />
        </div>
      ))}
    </div>
  );
}
