// src/store/moveDialog.ts — estado do diálogo "Mover para playlist…"
// (CMR-298). Singleton como o menu de contexto: um diálogo por vez,
// renderizado por <MoveToPlaylistDialog/> montado no App.
import { createSignal } from "solid-js";
import { playerEnqueueNext, type MoveReport, type Track } from "../tauri";
import { gaplessNext, remapMovedTracks } from "./player";
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
  const before = gaplessNext()?.path;
  remapMovedTracks(trackRemapper(report));
  // O engine consome o next pré-enfileirado sozinho no EOS: se a próxima
  // (ou a atual, no repeat one) foi movida, o preload apontaria para um
  // arquivo que não existe mais — re-enfileira com o caminho novo.
  const next = gaplessNext();
  if (next && next.path !== before) playerEnqueueNext(next.path).catch(console.error);
  bumpLibraryRevision();
}
