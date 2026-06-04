// src/components/NowPlayingIndicator.tsx
import { Show } from "solid-js";
import { player } from "../store/player";

interface NowPlayingIndicatorProps {
  trackId: string;
  /** "idx" = substitui número na célula .tracks__idx. "overlay" = sobre a capa. */
  variant?: "idx" | "overlay";
}

export function NowPlayingIndicator(props: NowPlayingIndicatorProps) {
  const isCurrent = () => player.currentTrack?.id === props.trackId;
  const isPlaying = () => player.isPlaying;

  return (
    <Show when={isCurrent()}>
      <span
        class="npi"
        classList={{
          "npi--playing": isPlaying(),
          "npi--paused": !isPlaying(),
          "npi--overlay": props.variant === "overlay",
        }}
        aria-label={isPlaying() ? "Tocando agora" : "Pausado"}
        role="img"
      >
        <span class="npi__bar" />
        <span class="npi__bar" />
        <span class="npi__bar" />
      </span>
    </Show>
  );
}
