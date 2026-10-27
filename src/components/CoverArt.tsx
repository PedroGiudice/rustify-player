/* ============================================================
   components/CoverArt.tsx — album cover with cassette fallback.

   Strategy:
     - If `src` is provided AND loads, the real <img> covers everything.
     - If `src` is null OR fails, render the cassette icon on a neutral
       paper background. Same look across every fallback — signals
       "no art" cleanly.
   ============================================================ */

import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { isCalmChange, now, type SwapKey } from "../lib/motion";
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
  /** Troca de capa com crossfade (barra e Now Playing): a anterior fica por
      baixo até a nova carregar e aparecer. Só fora de rajada de pulos
      (lib/motion.ts); em rajada, corte seco. */
  crossfade?: boolean;
}

/** Teto de espera pelo load da capa nova antes de soltar a de baixo. */
const UNDER_MAX_MS = 1200;

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

  // Crossfade: `under` = capa anterior, desenhada por baixo; `swap` alterna
  // a cada load para o keyframe de entrada recomeçar.
  const [under, setUnder] = createSignal<string | null>(null);
  const [swap, setSwap] = createSignal<SwapKey>("off");
  const [loaded, setLoaded] = createSignal(false);
  let underTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(underTimer));
  if (props.crossfade) {
    let last = now();
    // `on` com defer não entrega o valor anterior na primeira troca: guarda à mão.
    let prev = liveSrc();
    createEffect(
      on(
        liveSrc,
        (next) => {
          const old = prev;
          prev = next;
          if (next === old) return;
          clearTimeout(underTimer);
          const at = now();
          const calm = isCalmChange(last, at);
          last = at;
          if (!calm || !old || !next) {
            setUnder(null);
            setSwap("off");
            return;
          }
          setUnder(old);
          // Load que nunca chega (arquivo lento, erro silencioso) não deixa a
          // capa velha presa por baixo.
          underTimer = setTimeout(() => setUnder(null), UNDER_MAX_MS);
        },
        { defer: true },
      ),
    );
  }
  const onLoad = () => {
    setLoaded(true);
    if (!under()) return;
    clearTimeout(underTimer);
    setSwap((k) => (k === "a" ? "b" : "a"));
  };
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
          <>
            <Show when={under()}>
              {(old) => <img class="cover__under" src={old()} alt="" aria-hidden="true" />}
            </Show>
            <img
              class="cover__img"
              classList={{ "cover__img--over": !!under() }}
              src={src()}
              alt={props.alt ?? ""}
              loading="lazy"
              decoding="async"
              data-loaded={loaded() ? "" : undefined}
              data-swap={swap()}
              onLoad={onLoad}
              onAnimationEnd={() => setUnder(null)}
              onError={() => { setUnder(null); setFailedSrc(src()); }}
            />
          </>
        )}
      </Show>
      {props.children}
    </div>
  );
}
