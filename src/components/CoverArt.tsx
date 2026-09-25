/* ============================================================
   components/CoverArt.tsx — album cover with cassette fallback.

   Strategy:
     - If `src` is provided AND loads, the real <img> covers everything.
     - If `src` is null OR fails, render the cassette icon on a neutral
       paper background. Same look across every fallback — signals
       "no art" cleanly.
   ============================================================ */

import { createSignal, Show } from "solid-js";
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
  /** Visual variant. So muda o tamanho relativo do cassete (e o raio do sm);
      quem dimensiona e o chamador, via style/class (ex: .card__cover). */
  size?: "sm" | "md" | "lg" | "xl";
  /** Inline style overrides — typically width/height when 'md'. */
  style?: import("solid-js").JSX.CSSProperties;
  class?: string;
  alt?: string;
  /** Conteudo sobreposto ao cover (ex: botao play no hover dos cards). */
  children?: import("solid-js").JSX.Element;
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
  // Capa que falha (cache apagado, arquivo corrompido) cai no cassete, como
  // capa ausente — esconder so o <img> deixava uma caixa vazia. Guarda a URL
  // que falhou: trocar de capa tenta a nova.
  const [failedSrc, setFailedSrc] = createSignal<string | null>(null);
  const liveSrc = () => (props.src && props.src !== failedSrc() ? props.src : null);
  return (
    <div
      class={`${sizeClass()} cover--fallback${props.class ? ` ${props.class}` : ""}`}
      style={props.style}
    >
      <Show
        when={liveSrc()}
        fallback={<img class="cover__cassette" src={cassetteFallback} alt="" />}
      >
        {(src) => (
          <img
            src={src()}
            alt={props.alt ?? ""}
            loading="lazy"
            decoding="async"
            onError={() => setFailedSrc(src())}
          />
        )}
      </Show>
      {props.children}
    </div>
  );
}
