// src/components/TrackRowList.tsx — linha de track para listas com cover (Família B/C).
// Família B: .row (Home, History, Queue). Família C: .qrow (QueueDrawer).
import { Show, onMount } from "solid-js";
import { coverUrl, type Track } from "../tauri";
import { player } from "../store/player";
import { CoverArt } from "./CoverArt";
import { NowPlayingIndicator } from "./NowPlayingIndicator";
import { fmtDur } from "../lib/format";
import { openTrackMenu } from "../store/contextMenu";
import {
  focusList, isSelected, menuSelection, rangeToTrack, rowClick, rowMouseDown, selectionCount, toggleTrack,
} from "../store/selection";
import { Icon, ICONS } from "./Icon";

interface TrackRowListProps {
  track: Track;
  onClick: () => void;
  /** "default" → .row (Home, History, Queue). "compact" → .qrow (QueueDrawer). Default: "default". */
  size?: "default" | "compact";
  /**
   * Texto da coluna de contexto temporal ("2 min ago").
   * Só renderiza quando fornecido E size != "compact".
   * History e Home passam este campo; Queue não passa.
   */
  whenText?: string;
  /**
   * Quando true, aplica grid-template-columns: "40px 1fr auto" inline,
   * sobrescrevendo o padrão CSS de 5 colunas do .row.
   * Usar apenas em Queue.tsx (que historicamente tinha esse override).
   */
  noWhen?: boolean;
  /** Reduz opacidade para 0.55 — usado em Queue para tracks já reproduzidas. */
  muted?: boolean;
  /** Lista circundante — habilita o item Shuffle no menu de contexto. */
  contextList?: Track[];
}

export function TrackRowList(props: TrackRowListProps) {
  const isCompact = () => props.size === "compact";
  const isCurrent = () => player.currentTrack?.id === props.track.id;
  const coverPx = () => isCompact() ? "36px" : "40px";
  // Seleção múltipla: só linhas da família B que conhecem a lista.
  const selectable = () => !isCompact() && props.contextList !== undefined;
  const selected = () => selectable() && isSelected(props.track.id);
  onMount(() => { if (selectable()) focusList(props.contextList!); });

  return (
    <div
      // Um unico classList: misturar `class` dinamico com classList no mesmo
      // elemento e footgun do Solid (o re-run do class reescreve className
      // inteiro e o diff do classList nao re-aplica).
      classList={{
        qrow: isCompact(),
        "qrow--current": isCompact() && isCurrent(),
        row: !isCompact(),
        "is-current": !isCompact() && isCurrent(),
        "is-selected": selected(),
        "is-sel-mode": selectable() && selectionCount() > 0,
      }}
      aria-selected={selectable() ? selected() : undefined}
      onClick={(e) => rowClick(e, selectable() ? props.contextList : undefined, props.track.id, props.onClick)}
      onMouseDown={(e) => rowMouseDown(e, selectable() ? props.contextList : undefined)}
      onFocus={() => { if (selectable()) focusList(props.contextList!); }}
      onContextMenu={(e) =>
        openTrackMenu(e, props.track, {
          list: props.contextList,
          onPlay: props.onClick,
          selection: selectable() ? menuSelection(props.contextList!, props.track) : undefined,
        })}
      style={{
        opacity: props.muted ? 0.55 : 1,
        ...(props.noWhen ? { "grid-template-columns": "40px 1fr auto" } : {}),
      }}
      role="row"
      tabIndex={0}
      onKeyDown={(e) => {
        // preventDefault: sem ele o Espaço também rola o contêiner da view
        // (inclusive no auto-repeat). !e.repeat: segurar a tecla re-tocaria a
        // faixa a cada repetição — play_count inflado e track_skipped perto de
        // 0 s da própria faixa escolhida.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!e.repeat) props.onClick();
        }
      }}
    >
      {/* Cover com NPI overlay quando current */}
      <div style={{ position: "relative", width: coverPx(), height: coverPx(), flex: "none" }}>
        <CoverArt
          seed={props.track.album_title || props.track.id}
          src={coverUrl(props.track.album_cover_path)}
          size="sm"
          class={isCompact() ? "qrow__cover" : "row__cover"}
          style={{ width: coverPx(), height: coverPx() }}
        />
        <Show when={isCurrent()}>
          <NowPlayingIndicator trackId={props.track.id} variant="overlay" />
        </Show>
        <Show when={selectable()}>
          <span
            class="sel-check sel-check--cover"
            role="checkbox"
            aria-checked={selected()}
            aria-label="Selecionar faixa"
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

      {/* Meta: título + artista/álbum */}
      <div class={isCompact() ? "qrow__meta" : "row__meta"}>
        <div
          class={isCompact() ? "qrow__title" : "row__title"}
          style={{ color: !isCompact() && isCurrent() ? "var(--blue-fg)" : undefined }}
        >
          {props.track.title || "—"}
        </div>
        <div class={isCompact() ? "qrow__sub" : "row__sub"}>
          {props.track.artist_name || "—"}
          {props.track.album_title && <> · {props.track.album_title}</>}
        </div>
      </div>

      {/* Coluna temporal — apenas Família B e quando whenText fornecido */}
      <Show when={props.whenText !== undefined && !isCompact()}>
        <div class="row__when">{props.whenText}</div>
      </Show>

      {/* Duração */}
      <div class={isCompact() ? "qrow__time" : "row__time"}>
        {fmtDur(props.track.duration_ms)}
      </div>
    </div>
  );
}
