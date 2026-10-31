/* ============================================================
   lib/quickPlay.ts — atalhos de "tocar alguma coisa" sem escolher
   faixa: aleatório no acervo (Home) e retomar a última faixa do
   histórico (Now Playing vazio).
   ============================================================ */

import { libShuffle, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { failNotice } from "./failNotice";

/** 50 faixas sorteadas do acervo viram a fila. Falha no sorteio avisa (B5);
    a falha de tocar a primeira avisa pelo próprio playTrack. */
export async function shuffleAll() {
  let tracks: Track[];
  try {
    tracks = await libShuffle(50);
  } catch (e) {
    failNotice("Não consegui sortear faixas do acervo.", e, () => { void shuffleAll(); });
    return;
  }
  if (tracks.length) { setQueue(tracks, 0); playTrack(tracks[0]); }
}

/** Toca uma faixa sozinha na fila (o rádio continua depois dela). */
export function playAlone(track: Track) {
  setQueue([track], 0);
  playTrack(track);
}
