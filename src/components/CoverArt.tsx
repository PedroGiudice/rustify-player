/* ============================================================
   components/CoverArt.tsx — pastel-toned album cover with
   optional real <img> overlay.

   Strategy:
     - Always render the pastel tone + hairline glyph as fallback.
     - If `src` is provided AND loads, the <img> covers it.
     - If `src` is null OR fails, the glyph stays visible.

   Sizes: 'sm' (40), 'md' (default ~card-sized), 'lg' (200 NP).
   ============================================================ */

import { Show } from "solid-js";
import { Icon } from "./Icon";
import { toneFor, glyphFor, glyphIcon, type Tone, type Glyph } from "../tones";

export interface CoverArtProps {
  /** Seed string used to derive deterministic tone+glyph (e.g. album title, track id). */
  seed: string | null | undefined;
  /** Optional real cover image URL. Falls back to glyph if missing/error. */
  src?: string | null;
  /** Force a specific tone (overrides hashing). */
  tone?: Tone;
  /** Force a specific glyph (overrides hashing). */
  glyph?: Glyph;
  /** Visual variant: sm (40px), md (responsive aspect-1), lg (200px), xl (NP). */
  size?: "sm" | "md" | "lg" | "xl";
  /** Inline style overrides — typically width/height when 'md'. */
  style?: import("solid-js").JSX.CSSProperties;
  class?: string;
  alt?: string;
}

export function CoverArt(props: CoverArtProps) {
  const tone = () => props.tone ?? toneFor(props.seed);
  const glyph = () => props.glyph ?? glyphFor(props.seed);
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
      class={`${sizeClass()} tone-${tone()}${props.class ? ` ${props.class}` : ""}`}
      style={props.style}
    >
      <Show
        when={props.src}
        fallback={<Icon name={glyphIcon(glyph())} />}
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
