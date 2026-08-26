/* ============================================================
   TrackRow.tsx — linha de faixa (.trk do handoff), nas duas
   variantes que as telas usam: com capa e com número da faixa.

   Segurar a linha abre a sheet de ações (o gesto canônico do
   Android). O click que vem depois do long-press é engolido —
   senão o gesto também tocaria a faixa.
   ============================================================ */

import { Show, onCleanup } from "solid-js";
import { Cover } from "./Cover";
import { openTrackSheet } from "./Sheet";
import { createLongPress } from "../lib/longPress";
import { fmtDuration } from "../derive";
import { pb } from "../store";
import type { Track, TrackContext } from "../types";

export function TrackRow(props: {
  track: Track;
  onPlay: () => void;
  /** Substitui a capa pelo número da faixa (telas de álbum). */
  ordinal?: number;
  /** Segunda linha alternativa (default: artista · álbum). */
  sub?: string;
  right?: string;
  /** Lista em que esta faixa vive — habilita "tocar a partir daqui".
   *  `playlist` (nome da pasta) só quando a lista É uma playlist. */
  context?: TrackContext;
  /** Desliga o long-press (linha da faixa que já está tocando). */
  noSheet?: boolean;
}) {
  const playing = () => pb.trackId != null && pb.trackId === props.track.id;
  const sub = () =>
    props.sub ??
    [props.track.artist_name, props.track.album_title].filter(Boolean).join(" · ");

  const lp = createLongPress({
    onFire: () => {
      if (props.noSheet) return;
      // Vibração curta confirma o gesto às cegas (o dedo cobre a linha).
      navigator.vibrate?.(12);
      openTrackSheet(props.track, props.context);
    },
  });
  onCleanup(lp.dispose);

  return (
    <button
      class="trk"
      onClick={() => {
        if (lp.consumedClick()) return;
        props.onPlay();
      }}
      onPointerDown={lp.handlers.onPointerDown}
      onPointerMove={lp.handlers.onPointerMove}
      onPointerUp={lp.handlers.onPointerUp}
      onPointerCancel={lp.handlers.onPointerCancel}
      // O menu nativo de seleção de texto do WebView compete com o gesto.
      onContextMenu={(e) => e.preventDefault()}
      attr:data-playing={playing() ? "" : undefined}
    >
      <Show
        when={props.ordinal == null}
        fallback={
          <div class="dur" style={{ width: "22px", "text-align": "center" }}>
            {props.ordinal}
          </div>
        }
      >
        <Cover path={props.track.album_cover_path} seed={props.track.id} />
      </Show>
      <div class="info" style={props.ordinal == null ? undefined : { "margin-left": "12px" }}>
        <div class="tt">{props.track.title}</div>
        <div class="ts">{sub()}</div>
      </div>
      <div class="dur">{props.right ?? fmtDuration(props.track.duration_ms)}</div>
    </button>
  );
}
