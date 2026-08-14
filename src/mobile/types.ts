/* ============================================================
   types.ts — shapes do contrato IPC do Android v0
   (docs/android/ipc-contrato-v0.md + o README do
   tauri-plugin-rustify-audio). Sem imports: é o módulo que
   derive.ts pode usar sem arrastar o runtime do Tauri.

   REGRA DURA: `id` / `trackId` são STRING em toda a cadeia. Os ids
   do acervo são u64 hash-based; passar por Number corrompe qualquer
   valor acima de 2^53.
   ============================================================ */

export interface Track {
  id: string;
  title: string;
  artist_name: string | null;
  album_title: string | null;
  album_cover_path: string | null;
  album_year: number | null;
  duration_ms: number;
  path: string;
  lrc_path: string | null;
  track_number: number | null;
  genre_name: string | null;
  /** Hex "#rrggbb" da capa (enrichment do desktop) — ink/accent adaptativos. */
  dominant_color: string | null;
}

export interface Folder {
  name: string;
  track_count: number;
}

/** Origins do contrato — nomes EXATOS, o motor de sinal lê isso. */
export type Origin = "manual" | "playlist" | "album_seq" | "shuffle" | "station";

/** Station exportada do desktop (stations.json). pool_size 0 = sem
 *  candidatos no acervo — a UI mostra desabilitada. */
export interface StationMeta {
  id: string;
  name: string;
  icon: string;
  tone: string;
  desc: string;
  kind: "seed" | "mood";
  query: string | null;
  pool_size: number;
}

/** Linha de letra — mesmo wire do desktop (t em segundos). */
export interface LyricLine {
  t: number;
  line: string;
  header: boolean;
}

export interface QueueItem {
  trackId: string;
  uri: string;
  title: string;
  artist: string;
  album: string;
  artworkUri: string | null;
  durationMs: number;
}

export interface PlaybackState {
  status: "idle" | "buffering" | "ready" | "ended";
  index: number;
  trackId: string | null;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
}

/** Álbum derivado no cliente agrupando o acervo por (artista, álbum). */
export interface DerivedAlbum {
  key: string;
  title: string;
  artist: string | null;
  year: number | null;
  cover: string | null;
  track_count: number;
}

/** Artista derivado no cliente agrupando o acervo por artist_name. */
export interface DerivedArtist {
  name: string;
  track_count: number;
  album_count: number;
  cover: string | null;
}
