/* ============================================================
   components/LibHero.tsx — cabeçalho único de Álbum, Artista e Playlist
   (B2, varredura de 31/10).

   As três páginas tinham cabeçalhos diferentes: capa de 120 px no Álbum
   (menor que o mosaico de 180 da Playlist), cassete redondo no Artista,
   títulos de 22 e 28 px e ações em ordens diferentes. Agora a mesma
   gramática: capa de 176 px (redonda no Artista), o tipo da página num
   rótulo, título no degrau Feature, números numa linha só e as ações à
   direita com "Tocar" por último.

   O chamador manda o conteúdo da capa (imagem, CoverArt ou mosaico): a
   moldura, o tamanho e o raio são daqui.

   `facts` (B11): segunda linha, mais quieta, com a escuta viva e a
   qualidade medida (components/ListenFacts). Opcional: a Playlist não usa.
   ============================================================ */

import type { JSX } from "solid-js";

export interface LibHeroProps {
  /** Tipo da página, e o que couber junto ("Álbum · 1981"). */
  kicker: string;
  title: string;
  cover: JSX.Element;
  /** Capa redonda (Artista). */
  round?: boolean;
  /** Linha de números: faixas, duração, artista do álbum. */
  stats: JSX.Element;
  /** Linha de fatos sob os números: escuta e qualidade (B11). */
  facts?: JSX.Element;
  /** Botões; o primário ("Tocar") por último. */
  actions: JSX.Element;
}

export function LibHero(props: LibHeroProps) {
  return (
    <header class="view__head lib-hero">
      <div class="lib-hero__main">
        <div class="lib-hero__cover" data-round={props.round ? "true" : undefined}>
          {props.cover}
        </div>
        <div class="lib-hero__meta">
          <div class="lib-hero__kicker">{props.kicker}</div>
          <h1 class="lib-hero__title">{props.title}</h1>
          <p class="lib-hero__stats">{props.stats}</p>
          {props.facts}
        </div>
      </div>
      <div class="lib-hero__actions">{props.actions}</div>
    </header>
  );
}
