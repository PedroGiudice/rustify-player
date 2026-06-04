/* ============================================================
   components/Icon.tsx — Wrapper para Iconify web component.
   Uso: <Icon name="lucide:home" size={16} />
   ============================================================ */

import type { JSX } from "solid-js";

export interface IconProps {
  name: string;
  size?: number | string;
  /** Overrides the default opacity (some icons need full opacity in dark areas). */
  opacity?: number;
  class?: string;
  style?: JSX.CSSProperties;
  title?: string;
}

export function Icon(props: IconProps) {
  const dim = () => (typeof props.size === "number" ? `${props.size}px` : props.size);
  return (
    // @ts-ignore — custom element provided by iconify-icon script tag
    <iconify-icon
      icon={props.name}
      width={dim()}
      height={dim()}
      class={props.class}
      style={{ ...(props.opacity != null ? { opacity: props.opacity } : {}), ...(props.style ?? {}) }}
      title={props.title}
      noobserver
    />
  );
}

/** Conventional icon name aliases — single source of truth across the app. */
export const ICONS = {
  flask:        "lucide:flask-conical",
  home:         "lucide:house",
  search:       "lucide:search",
  library:      "lucide:library-big",
  playlists:    "lucide:list-music",
  stations:     "lucide:radio",
  music:        "lucide:disc",
  signal:       "lucide:audio-waveform",
  settings:     "lucide:settings",
  queue:        "lucide:list-end",
  lyrics:       "lucide:mic-vocal",
  history:      "lucide:history",
  artists:      "lucide:user-round",
  albums:       "lucide:disc-3",
  tracks:       "lucide:music",
  prev:         "lucide:skip-back",
  next:         "lucide:skip-forward",
  play:         "lucide:play",
  pause:        "lucide:pause",
  shuffle:      "lucide:shuffle",
  repeat:       "lucide:repeat",
  repeatOne:    "lucide:repeat-1",
  heart:        "lucide:heart",
  heartFilled:  "ph:heart-fill",
  more:         "lucide:more-horizontal",
  volume:       "lucide:volume-2",
  volumeMute:   "lucide:volume-x",
  expand:       "lucide:maximize-2",
  shrink:       "lucide:minimize-2",
  close:        "lucide:x",
  chevronLeft:  "lucide:chevron-left",
  chevronRight: "lucide:chevron-right",
  arrowRight:   "lucide:arrow-right",
  bolt:         "lucide:zap",
  timer:        "lucide:timer",
  check:        "lucide:check",
  plus:         "lucide:plus",
} as const;
