// src/components/LevelMeter.tsx — medidor estéreo da barra do player: VU
// (barra) e pico retido (marca) por canal, em dBFS de -48 a 0, lidos da
// saída real (lib/levels.ts). Escreve direto no DOM por quadro (transform),
// sem signal: 60 atualizações por segundo não passam pelo Solid.
// Só assina enquanto toca; com movimento reduzido fica parado.
import { createEffect, onCleanup } from "solid-js";
import { player } from "../store/player";
import { subscribeLevels } from "../lib/levels";
import { toFrac, METER_FLOOR_DB } from "../lib/meter";

/** Pico acima disto (dBFS) acende a marca no sinal de erro: perto de clipar. */
const CLIP_DB = -0.5;

export function LevelMeter() {
  const fill: HTMLElement[] = [];
  const peak: HTMLElement[] = [];
  let root: HTMLDivElement | undefined;
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  createEffect(() => {
    if (!player.isPlaying || reduced()) return;
    const off = subscribeLevels((m) => {
      for (const c of [0, 1]) {
        fill[c].style.transform = `scaleX(${toFrac(m.vu[c])})`;
        const f = (m.peakDb[c] - METER_FLOOR_DB) / -METER_FLOOR_DB;
        peak[c].style.transform = `translateX(${(f - 1) * 100}%)`;
        peak[c].dataset.clip = m.peakDb[c] > CLIP_DB ? "true" : "false";
      }
    });
    onCleanup(() => {
      off();
      for (const c of [0, 1]) {
        fill[c].style.transform = "scaleX(0)";
        peak[c].style.transform = "translateX(-100%)";
      }
    });
  });

  return (
    <div class="pb-meter" ref={root} aria-hidden="true" title="Nível de saída (L/R), VU e pico">
      {[0, 1].map((c) => (
        <div class="pb-meter__ch">
          <span class="pb-meter__fill" ref={(el) => (fill[c] = el)} />
          <span class="pb-meter__peak" ref={(el) => (peak[c] = el)} />
        </div>
      ))}
    </div>
  );
}
