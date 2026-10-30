// src/components/NowPlayingIndicator.tsx
// Indicador "tocando agora" das listas: três barras que leem o nível real da
// saída (lib/levels.ts): canal esquerdo, pico, canal direito. Até 30/10/2026
// era um loop de CSS que não media nada. Pausado ou com movimento reduzido,
// as barras ficam paradas em alturas fixas (CSS).
import { Show, createEffect, onCleanup } from "solid-js";
import { player } from "../store/player";
import { subscribeLevels } from "../lib/levels";
import { toFrac } from "../lib/meter";

interface NowPlayingIndicatorProps {
  trackId: string;
  /** "idx" = na celula do numero (Familia A). "overlay" = sobre a capa (Familia B/C). */
  variant?: "idx" | "overlay";
}

export function NowPlayingIndicator(props: NowPlayingIndicatorProps) {
  const isCurrent = () => player.currentTrack?.id === props.trackId;
  const bars: HTMLElement[] = [];
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  createEffect(() => {
    if (!isCurrent() || !player.isPlaying || reduced()) return;
    const off = subscribeLevels((m) => {
      const l = toFrac(m.vu[0]);
      const r = toFrac(m.vu[1]);
      const pk = toFrac(10 ** (Math.max(m.peakDb[0], m.peakDb[1]) / 20));
      const v = [l, pk, r];
      for (let i = 0; i < 3; i++) if (bars[i]) bars[i].style.transform = `scaleY(${0.15 + 0.85 * v[i]})`;
    });
    onCleanup(() => {
      off();
      for (const b of bars) if (b) b.style.transform = "";
    });
  });

  return (
    <Show when={isCurrent()}>
      <span
        class="np-mini__vu npi"
        classList={{
          "npi--overlay": props.variant === "overlay",
          "npi--paused": !player.isPlaying,
          "npi--live": player.isPlaying && !reduced(),
        }}
        aria-label={player.isPlaying ? "Tocando agora" : "Pausado"}
        role="img"
      >
        <span ref={(el) => (bars[0] = el)} />
        <span ref={(el) => (bars[1] = el)} />
        <span ref={(el) => (bars[2] = el)} />
      </span>
    </Show>
  );
}
