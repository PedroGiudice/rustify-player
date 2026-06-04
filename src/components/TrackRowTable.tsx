// src/components/TrackRowTable.tsx — linha de track para listas .tracks (Família A).
// Uso: dentro de <div class="tracks"> ou <div class="tracks tracks--with-cover">.
// O container pai gerencia o grid; este componente emite filhos com display:contents.
import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { player } from "../store/player";
import { NowPlayingIndicator } from "./NowPlayingIndicator";
import type { Track } from "../tauri";
import { fmtDur } from "../lib/format";

interface TrackRowTableProps {
  track: Track;
  /** Número exibido em .tracks__idx quando não é a track atual. */
  index: number;
  onClick: () => void;
  /**
   * Slot para coluna de capa — usado APENAS em Playlist (.tracks--with-cover).
   * Quando fornecido, ocupa a 2ª coluna do grid (44px).
   * Quando ausente (undefined), a célula não é renderizada e o grid tem 5 colunas.
   */
  coverSlot?: JSX.Element;
  /**
   * Colunas após .tracks__title. Default quando ausente: album + genre.
   * Passado explicitamente para customizar (ex: remover genre em alguma view futura).
   */
  extraCols?: JSX.Element;
}

export function TrackRowTable(props: TrackRowTableProps) {
  const isCurrent = () => player.currentTrack?.id === props.track.id;

  return (
    <div
      class="tracks__row"
      classList={{ "tracks__row--current": isCurrent() }}
      onClick={props.onClick}
      style={{ display: "contents" }}
      role="row"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") props.onClick(); }}
    >
      {/* Célula índice: NPI quando current, número formatado quando não */}
      <div class="tracks__idx">
        <Show when={isCurrent()} fallback={String(props.index).padStart(2, "0")}>
          <NowPlayingIndicator trackId={props.track.id} variant="idx" />
        </Show>
      </div>

      {/* Cover slot opcional (apenas Playlist) */}
      <Show when={props.coverSlot !== undefined}>
        {props.coverSlot}
      </Show>

      {/* Título + artista */}
      <div class="tracks__title">
        <b>{props.track.title || "—"}</b>
        <small>{props.track.artist_name || "—"}</small>
      </div>

      {/* Colunas extras — default: album + genre */}
      <Show
        when={props.extraCols !== undefined}
        fallback={
          <>
            <div class="tracks__cell">{props.track.album_title ?? "—"}</div>
            <div class="tracks__cell">{props.track.genre_name ?? "—"}</div>
          </>
        }
      >
        {props.extraCols}
      </Show>

      {/* Duração — sempre última coluna */}
      <div class="tracks__mono">{fmtDur(props.track.duration_ms)}</div>
    </div>
  );
}
