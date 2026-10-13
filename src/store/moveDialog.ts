// src/store/moveDialog.ts — estado do diálogo "Mover para playlist…"
// (CMR-298). Singleton como o menu de contexto: um diálogo por vez,
// renderizado por <MoveToPlaylistDialog/> montado no App.
import { createSignal } from "solid-js";
import type { MoveReport, Track } from "../tauri";
import { remapMovedTracks } from "./player";
import { trackRemapper } from "../lib/moveToPlaylist";

export interface MoveRequest {
  tracks: Track[];
  /** Nome do álbum/artista para a confirmação de lote; null = faixa solta. */
  label: string | null;
}

const [moveRequest, setMoveRequest] = createSignal<MoveRequest | null>(null);
export { moveRequest };

export function openMoveDialog(tracks: Track[], label: string | null = null) {
  if (tracks.length === 0) return;
  setMoveRequest({ tracks, label });
}

export function closeMoveDialog() {
  setMoveRequest(null);
}

// Revisão da biblioteca: views que listam faixas por pasta/álbum/artista
// entram com ela na chave do createResource e recarregam depois de mover.
const [libraryRevision, setLibraryRevision] = createSignal(0);
export { libraryRevision };

export function bumpLibraryRevision() {
  setLibraryRevision((n) => n + 1);
}

/** Reação ao evento `lib-tracks-moved` (um por lote enviado ao backend):
    fila/faixa atual passam aos ids novos e as views recarregam. */
export function applyMovedReport(report: MoveReport) {
  if (report.moved === 0) return;
  remapMovedTracks(trackRemapper(report));
  bumpLibraryRevision();
}
