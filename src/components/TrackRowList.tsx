// src/components/TrackRowList.tsx — linha de track para listas com cover (Família B/C).
// Família B: .row (Home, History, Queue). Família C: .qrow (QueueDrawer).
import { Show } from "solid-js";
import { coverUrl, type Track } from "../tauri";
import { player } from "../store/player";
import { CoverArt } from "./CoverArt";
import { NowPlayingIndicator } from "./NowPlayingIndicator";
import { fmtDur } from "../lib/format";
import { openTrackMenu } from "../store/contextMenu";

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
      }}
      onClick={props.onClick}
      onContextMenu={(e) => openTrackMenu(e, props.track, { list: props.contextList, onPlay: props.onClick })}
      style={{
        opacity: props.muted ? 0.55 : 1,
        ...(props.noWhen ? { "grid-template-columns": "40px 1fr auto" } : {}),
      }}
      role="row"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") props.onClick(); }}
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
