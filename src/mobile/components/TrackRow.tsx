/* ============================================================
   TrackRow.tsx — linha de faixa (.trk do handoff), nas duas
   variantes que as telas usam: com capa e com número da faixa.
   ============================================================ */

import { Show } from "solid-js";
import { Cover } from "./Cover";
import { fmtDuration } from "../derive";
import { pb } from "../store";
import type { Track } from "../types";

export function TrackRow(props: {
  track: Track;
  onPlay: () => void;
  /** Substitui a capa pelo número da faixa (telas de álbum). */
  ordinal?: number;
  /** Segunda linha alternativa (default: artista · álbum). */
  sub?: string;
  right?: string;
}) {
  const playing = () => pb.trackId != null && pb.trackId === props.track.id;
  const sub = () =>
    props.sub ??
    [props.track.artist_name, props.track.album_title].filter(Boolean).join(" · ");
  return (
    <button class="trk" onClick={props.onPlay} attr:data-playing={playing() ? "" : undefined}>
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
