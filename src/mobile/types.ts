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

/** Lista em que uma faixa vive (linha de uma tela, sheet aberta dela).
 *  `playlist` = nome da pasta de 1º nível quando a lista É uma playlist: tudo
 *  que refaz a fila a partir dela (linha tocada, "Tocar agora", "Tocar a
 *  partir daqui") herda o contexto e a continuidade OFF do Play da pasta.
 *  Álbum/artista/acervo/shelf não preenchem — mantêm o default (radio). */
export interface TrackContext {
  list: Track[];
  index: number;
  playlist?: string;
}

/** Origins do contrato — vocabulário EXATO do sinal v3 do desktop; o motor
 *  lê isso. "shuffle" não existe aqui de propósito: estava fora do vocabulário
 *  do motor e entrava com peso CHEIO no saldo — sequência escolhida pela
 *  máquina (shuffle, "tocar a partir daqui", tender) loga `autoplay`, que tem
 *  o desconto de origem passiva. Decisão do CEO no plano de paridade: mapear
 *  aqui, sem mexer em dado já gravado. */
export type Origin =
  | "manual"
  | "playlist"
  | "album_seq"
  | "station"
  | "autoplay"
  | "repeat";

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
  /** Override de origem POR ITEM; ausente herda a da fila. */
  origin?: Origin;
  contextId?: string | null;
}

/** Item da fila NATIVA, como o serviço a enxerga. `origin`/`contextId`
 *  são por ITEM: uma faixa enfileirada à mão dentro de uma station
 *  carrega a própria origem e o journal registra a verdade. */
export interface QueueEntry {
  trackId: string;
  origin: string;
  contextId: string | null;
  durationMs: number;
}

/** Resposta de `get_queue`. `index` -1 = fila vazia/nada tocando. */
export interface QueueSnapshot {
  items: QueueEntry[];
  index: number;
}

/** Resposta de `next`/`previous`: `moved: false` = a fila acabou. */
export interface StepResult {
  moved: boolean;
}

export interface PlaybackState {
  status: "idle" | "buffering" | "ready" | "ended";
  index: number;
  trackId: string | null;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  /** Itens na fila nativa — é assim que se sabe que ela está secando. */
  count: number;
}

export type RepeatMode = "off" | "one" | "all";

/** De onde saiu o lote de rádio — `vector` é o modo bom, os outros degradam. */
export type RadioLayer = "vector" | "artistFolder" | "library";

export interface RadioStart {
  tracks: Track[];
  layer: RadioLayer;
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

/** Resposta de `updater_check` (decisão `available` é do Kotlin). */
export interface UpdateCheck {
  installed: string;
  latest: string;
  available: boolean;
  apkUrl: string | null;
  sha256: string | null;
  size: number;
  /** false = falta o toggle "instalar apps desconhecidos" para o app. */
  canInstall: boolean;
}

export type UpdaterPhase =
  | "downloading"
  | "verifying"
  | "installing"
  /** App estava invisível ao chegar a confirmação; o plugin dispara no resume. */
  | "confirm_pending"
  | "confirming"
  | "done"
  | "failed";

/** Evento `updater_progress` do plugin. */
export interface UpdaterProgress {
  phase: UpdaterPhase;
  bytes?: number;
  total?: number;
  message?: string;
}
