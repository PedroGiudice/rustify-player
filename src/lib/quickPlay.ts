/* ============================================================
   lib/quickPlay.ts — atalhos de "tocar alguma coisa" sem escolher
   faixa: aleatório no acervo (Home) e retomar a última faixa do
   histórico (Now Playing vazio).
   ============================================================ */

import { libShuffle, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";

/** 50 faixas sorteadas do acervo viram a fila. */
export async function shuffleAll() {
  const tracks = await libShuffle(50);
  if (tracks.length) { setQueue(tracks, 0); playTrack(tracks[0]); }
}

/** Toca uma faixa sozinha na fila (o rádio continua depois dela). */
export function playAlone(track: Track) {
  setQueue([track], 0);
  playTrack(track);
}
