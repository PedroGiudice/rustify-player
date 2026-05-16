/* ============================================================
   components/CoverArt.tsx — album cover with cassette fallback.

   Strategy:
     - If `src` is provided AND loads, the real <img> covers everything.
     - If `src` is null OR fails, render the cassette icon on a neutral
       paper background. Same look across every fallback — signals
       "no art" cleanly.
   ============================================================ */

import { Show } from "solid-js";
import type { Tone, Glyph } from "../tones";
import cassetteFallback from "../assets/cassette-fallback.png";

export interface CoverArtProps {
  /** Seed string (kept in the API for callers; no longer drives visuals). */
  seed: string | null | undefined;
  /** Optional real cover image URL. Falls back to cassette if missing/error. */
  src?: string | null;
  /** Kept for back-compat with old call sites. Ignored. */
  tone?: Tone;
  /** Kept for back-compat with old call sites. Ignored. */
  glyph?: Glyph;
  /** Visual variant: sm (40px), md (responsive aspect-1), lg (200px), xl (NP). */
  size?: "sm" | "md" | "lg" | "xl";
  /** Inline style overrides — typically width/height when 'md'. */
  style?: import("solid-js").JSX.CSSProperties;
  class?: string;
  alt?: string;
}

export function CoverArt(props: CoverArtProps) {
  const sizeClass = () => {
    switch (props.size) {
      case "sm": return "cover cover--sm";
      case "lg": return "cover cover--lg";
      case "xl": return "cover cover--xl";
      default:   return "cover";
    }
  };
  return (
    <div
      class={`${sizeClass()} cover--fallback${props.class ? ` ${props.class}` : ""}`}
      style={props.style}
    >
      <Show
        when={props.src}
        fallback={<img class="cover__cassette" src={cassetteFallback} alt="" />}
      >
        {(src) => (
          <img
            src={src()}
            alt={props.alt ?? ""}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        )}
      </Show>
    </div>
  );
}
