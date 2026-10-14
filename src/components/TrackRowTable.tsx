// src/components/TrackRowTable.tsx — linha de track para listas .tracks (Família A).
// Uso: dentro de <div class="tracks"> ou <div class="tracks tracks--with-cover">.
// O container pai define as colunas; a linha é um grid com subgrid (ver .tracks__row).
import { Show, createEffect, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { player } from "../store/player";
import { NowPlayingIndicator } from "./NowPlayingIndicator";
import type { Track } from "../tauri";
import { fmtDur } from "../lib/format";
import { openTrackMenu } from "../store/contextMenu";
import {
  claimList, focusList, isSelected, menuSelection, rangeToTrack, rowClick, rowMouseDown, selectionActive, toggleTrack,
} from "../store/selection";
import { Icon, ICONS } from "./Icon";

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
  /** Lista circundante — habilita o item Shuffle no menu de contexto. */
  contextList?: Track[];
}

export function TrackRowTable(props: TrackRowTableProps) {
  const isCurrent = () => player.currentTrack?.id === props.track.id;
  // Seleção múltipla só existe quando a linha sabe a lista a que pertence.
  const selectable = () => props.contextList !== undefined;
  const selected = () => selectable() && isSelected(props.track.id);
  createEffect(() => {
    const l = props.contextList;
    if (l) onCleanup(claimList(l));
  });

  return (
    <div
      class="tracks__row"
      classList={{
        "tracks__row--current": isCurrent(),
        "tracks__row--selected": selected(),
        "tracks__row--sel-mode": selectable() && selectionActive(),
      }}
      aria-selected={selectable() ? selected() : undefined}
      onClick={(e) => rowClick(e, props.contextList, props.track.id, props.onClick)}
      onMouseDown={(e) => rowMouseDown(e, props.contextList)}
      onFocus={() => { if (props.contextList) focusList(props.contextList); }}
      onContextMenu={(e) =>
        openTrackMenu(e, props.track, {
          list: props.contextList,
          onPlay: props.onClick,
          selection: props.contextList ? menuSelection(props.contextList, props.track) : undefined,
        })}
      role="row"
      tabIndex={0}
      onKeyDown={(e) => {
        // preventDefault: sem ele o Espaço também rola o contêiner da view
        // (inclusive no auto-repeat). !e.repeat: segurar a tecla re-tocaria a
        // faixa a cada repetição — play_count inflado e track_skipped perto de
        // 0 s da própria faixa escolhida.
        // Shift+Espaço alterna a marca da faixa (a caixa não é focável);
        // Espaço sozinho continua tocando.
        if (e.key === " " && e.shiftKey && selectable()) {
          e.preventDefault();
          if (!e.repeat) toggleTrack(props.contextList!, props.track.id);
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!e.repeat) props.onClick();
        }
      }}
    >
      {/* Célula índice: NPI quando current, número formatado quando não */}
      <div class="tracks__idx" classList={{ "tracks__idx--sel": selectable() }}>
        <Show
          when={selectable()}
          fallback={
            <Show when={isCurrent()} fallback={String(props.index).padStart(2, "0")}>
              <NowPlayingIndicator trackId={props.track.id} variant="idx" />
            </Show>
          }
        >
          <span class="tracks__num">
            <Show when={isCurrent()} fallback={String(props.index).padStart(2, "0")}>
              <NowPlayingIndicator trackId={props.track.id} variant="idx" />
            </Show>
          </span>
          <span
            class="sel-check"
            data-checked={selected() ? "true" : "false"}
            aria-hidden="true"
            aria-label={`Selecionar ${props.track.title || "faixa"}`}
            onClick={(e) => {
              e.stopPropagation();
              if (e.shiftKey) rangeToTrack(props.contextList!, props.track.id);
              else toggleTrack(props.contextList!, props.track.id);
            }}
          >
            <Icon name={ICONS.check} size={12} />
          </span>
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
