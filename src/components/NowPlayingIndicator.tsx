// src/components/NowPlayingIndicator.tsx
// Indicador "tocando agora". Reusa o sprite .np-mini__vu da sidebar para manter
// um unico vocabulario visual no app (uniformidade) — nao inventa um equalizer
// proprio. Os modifiers .npi--* apenas adaptam o contexto (overlay sobre capa,
// pausa). O sprite (3 barras azuis pulsando via @keyframes vu) e definido junto
// com .np-mini__vu em extractor-lab.css.
import { Show } from "solid-js";
import { player } from "../store/player";

interface NowPlayingIndicatorProps {
  trackId: string;
  /** "idx" = na celula do numero (Familia A). "overlay" = sobre a capa (Familia B/C). */
  variant?: "idx" | "overlay";
}

export function NowPlayingIndicator(props: NowPlayingIndicatorProps) {
  const isCurrent = () => player.currentTrack?.id === props.trackId;

  return (
    <Show when={isCurrent()}>
      <span
        class="np-mini__vu npi"
        classList={{
          "npi--overlay": props.variant === "overlay",
          "npi--paused": !player.isPlaying,
        }}
        aria-label={player.isPlaying ? "Tocando agora" : "Pausado"}
        role="img"
      >
        <span />
        <span />
        <span />
      </span>
    </Show>
  );
}
