/* ============================================================
   store.ts — estado da UI mobile.

   Princípio do v0: a fila e o avanço automático vivem no Kotlin.
   Este store REFLETE o estado do serviço (eventos do plugin +
   get_state) e mantém um ESPELHO da fila só para desenhar (o
   plugin não expõe leitura da fila). Quem manda é sempre o
   serviço; o espelho nunca decide o que tocar.

   Não há log de escuta aqui: o journal do service é a verdade.
   ============================================================ */

import { createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import * as ipc from "./ipc";
import { deriveAlbums, deriveArtists, shuffled } from "./derive";
import type { Folder, Origin, PlaybackState, StationMeta, Track } from "./types";

const QUEUE_KEY = "kv-mobile-queue";

// ── Biblioteca ────────────────────────────────────────────────

const [tracks, setTracks] = createSignal<Track[]>([]);
const [folders, setFolders] = createSignal<Folder[]>([]);
const [libReady, setLibReady] = createSignal(false);
const [libError, setLibError] = createSignal<string | null>(null);

export { tracks, folders, libReady, libError };

export const albums = createMemo(() => deriveAlbums(tracks()));
export const artists = createMemo(() => deriveArtists(tracks()));

const byId = createMemo(() => {
  const m = new Map<string, Track>();
  for (const t of tracks()) m.set(t.id, t);
  return m;
});

// ── Inteligência local (CMR-190) ──────────────────────────────
// Alimentada pelos artefatos de .rustify/ — sem eles, listas vazias
// e as seções somem da UI. Carga best-effort pós-boot.

const [stations, setStations] = createSignal<StationMeta[]>([]);
const [favorites, setFavorites] = createSignal<Track[]>([]);

export { stations, favorites };

async function loadIntel() {
  try {
    const [st, fav] = await Promise.all([ipc.libListStations(), ipc.libTastePositives()]);
    setStations(st ?? []);
    setFavorites(fav ?? []);
  } catch (e) {
    console.warn("[mobile] carga de stations/favorites falhou:", e);
  }
}

// ── Playback (espelho do serviço) ─────────────────────────────

const [pb, setPb] = createStore<PlaybackState>({
  status: "idle",
  index: -1,
  trackId: null,
  positionMs: 0,
  durationMs: 0,
  isPlaying: false,
});

const [queue, setQueue] = createSignal<Track[]>([]);
const [queueOrigin, setQueueOrigin] = createSignal<Origin>("manual");
const [resolved, setResolved] = createSignal<Track | null>(null);

export { pb, queue, queueOrigin };

export const current = createMemo<Track | null>(() => {
  const q = queue();
  const i = pb.index;
  const at = i >= 0 && i < q.length ? q[i] : null;
  if (at && (!pb.trackId || at.id === pb.trackId)) return at;
  if (pb.trackId) {
    const inQueue = q.find((t) => t.id === pb.trackId);
    if (inQueue) return inQueue;
    const inLib = byId().get(pb.trackId);
    if (inLib) return inLib;
  }
  return resolved();
});

export const hasPlayback = createMemo(() => current() != null);

// ── Toast ─────────────────────────────────────────────────────

const [toast, setToast] = createSignal<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export { toast };
export function showToast(msg: string) {
  setToast(msg);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToast(null), 1600);
}

// ── Espelho da fila (persistido) ──────────────────────────────

function persistQueue(list: Track[], origin: Origin) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify({ ids: list.map((t) => t.id), origin }));
  } catch {
    /* sem persistência é degradação aceitável */
  }
}

function rehydrateQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { ids?: unknown; origin?: unknown };
    if (!Array.isArray(saved.ids)) return;
    const map = byId();
    const list = saved.ids
      .filter((id): id is string => typeof id === "string")
      .map((id) => map.get(id))
      .filter((t): t is Track => t != null);
    if (list.length) {
      setQueue(list);
      setQueueOrigin((saved.origin as Origin) ?? "manual");
    }
  } catch {
    /* espelho corrompido: o serviço segue sendo a verdade */
  }
}

// ── Aplicação de estado vindo do serviço ──────────────────────

let resolving: string | null = null;

function applyState(s: Partial<PlaybackState> | null | undefined) {
  if (!s) return;
  // Merge por chave PRESENTE: os eventos são best-effort e o tick de
  // `position` pode chegar enxuto. Preencher o que falta com default
  // zeraria índice/faixa 2x por segundo.
  const patch: Partial<PlaybackState> = {};
  if (typeof s.status === "string") patch.status = s.status;
  if (typeof s.index === "number") patch.index = s.index;
  if (s.trackId !== undefined) patch.trackId = s.trackId ?? null;
  if (typeof s.positionMs === "number") patch.positionMs = s.positionMs;
  if (typeof s.durationMs === "number") patch.durationMs = s.durationMs;
  if (typeof s.isPlaying === "boolean") patch.isPlaying = s.isPlaying;
  setPb(patch);

  // WebView reiniciou com o serviço tocando: o espelho pode não ter a
  // faixa. Resolve pelo id para o mini player não ficar mudo.
  const id = s.trackId;
  if (id && !queue().some((t) => t.id === id) && !byId().has(id) && resolving !== id) {
    resolving = id;
    ipc
      .libGetTracksByIds([id])
      .then((list) => {
        if (list && list[0]) setResolved(list[0]);
      })
      .catch(() => {})
      .finally(() => {
        resolving = null;
      });
  }
}

export async function syncState() {
  try {
    applyState(await ipc.playerGetState());
  } catch (e) {
    console.warn("[mobile] get_state falhou:", e);
  }
}

// ── Ações ─────────────────────────────────────────────────────

/**
 * Único caminho para começar a tocar. `origin` vai cru para o
 * contrato — os nomes são os que o motor de sinal entende.
 */
export async function playList(
  list: Track[],
  startIndex: number,
  origin: Origin,
  contextId: string | null = null,
) {
  if (!list.length) {
    showToast("Nada para tocar aqui");
    return;
  }
  const start = Math.max(0, Math.min(startIndex, list.length - 1));
  setQueue(list);
  setQueueOrigin(origin);
  persistQueue(list, origin);
  // Otimista: o serviço confirma pelos eventos em seguida.
  setPb({ index: start, trackId: list[start].id, positionMs: 0, durationMs: list[start].duration_ms, isPlaying: true });
  try {
    await ipc.playerSetQueue({
      items: ipc.toQueueItems(list),
      startIndex: start,
      origin,
      contextId,
      playNow: true,
    });
  } catch (e) {
    console.error("[mobile] set_queue falhou:", e);
    showToast("Falha ao iniciar a reprodução");
    await syncState();
  }
}

export const playTrackFrom = (list: Track[], index: number) => playList(list, index, "manual");
export const playFolder = (list: Track[], name: string) => playList(list, 0, "playlist", name);
export const playAlbum = (list: Track[], key: string) => playList(list, 0, "album_seq", key);
export const shuffleList = (list: Track[]) => playList(shuffled(list), 0, "shuffle");
export const shuffleAll = () => shuffleList(tracks());

/** Toca uma station: lote do pool precomputado + re-rank local.
 *  origin `station` — o sinal v3 desconta origem passiva. */
export async function playStation(st: StationMeta) {
  try {
    const batch = await ipc.libPlayStation(st.id, 40);
    if (!batch.length) {
      showToast("Station sem faixas no acervo");
      return;
    }
    await playList(batch, 0, "station", st.id);
  } catch (e) {
    console.error("[mobile] lib_play_station falhou:", e);
    showToast("Falha ao iniciar a station");
  }
}

/** Rádio da faixa: vizinhos por similaridade viram a fila.
 *  Requer vectors.bin no aparelho — sem ele, toast e nada muda. */
export async function playSimilar(track: Track) {
  try {
    const similar = await ipc.libSimilarTracks(track.id, 30);
    if (!similar.length) {
      showToast("Sem vetores no aparelho — rode o export");
      return;
    }
    await playList(similar, 0, "station", `similar:${track.id}`);
    showToast(`Rádio: ${track.title}`);
  } catch (e) {
    console.error("[mobile] lib_similar_tracks falhou:", e);
    showToast("Falha ao montar o rádio");
  }
}

export async function toggle() {
  try {
    if (pb.isPlaying) await ipc.playerPause();
    else await ipc.playerPlay();
    setPb("isPlaying", !pb.isPlaying);
  } catch (e) {
    console.warn("[mobile] play/pause falhou:", e);
    await syncState();
  }
}

export async function next() {
  try {
    await ipc.playerNext();
  } catch (e) {
    console.warn("[mobile] next falhou:", e);
  }
}

export async function previous() {
  try {
    await ipc.playerPrevious();
  } catch (e) {
    console.warn("[mobile] previous falhou:", e);
  }
}

export async function seek(positionMs: number) {
  const ms = Math.max(0, Math.round(positionMs));
  setPb("positionMs", ms);
  try {
    await ipc.playerSeekTo(ms);
  } catch (e) {
    console.warn("[mobile] seek_to falhou:", e);
    await syncState();
  }
}

export async function skipToIndex(index: number) {
  setPb("index", index);
  try {
    await ipc.playerSkipToIndex(index);
  } catch (e) {
    console.warn("[mobile] skip_to_index falhou:", e);
    await syncState();
  }
}

const [rescanning, setRescanning] = createSignal(false);
export { rescanning };

export async function rescan() {
  if (rescanning()) return;
  setRescanning(true);
  try {
    const count = await ipc.libRescan();
    await loadLibrary();
    await loadIntel();
    showToast(`Biblioteca re-indexada · ${count} faixas`);
  } catch (e) {
    console.error("[mobile] lib_rescan falhou:", e);
    showToast("Falha ao re-indexar");
  } finally {
    setRescanning(false);
  }
}

// ── Boot ──────────────────────────────────────────────────────

async function loadLibrary() {
  const [t, f] = await Promise.all([ipc.libListTracks(), ipc.libListFolders()]);
  setTracks(t ?? []);
  setFolders(f ?? []);
}

// Invoke disparado no boot frio pode se perder antes de a bridge nativa do
// WebView anexar — a promise nunca liquida e pendura o boot inteiro
// (visto no S24 em 14/08: "Carregando biblioteca…" eterno; reload quente
// funcionava). Corrida com timeout + retry resolve os dois casos: mensagem
// perdida (re-invoca) e lentidão real (segunda chance).
async function bootCall<T>(
  label: string,
  call: () => Promise<T>,
  timeoutMs: number,
  tries = 3,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`${label}: timeout ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
    } catch (e) {
      if (i >= tries) throw e;
      console.warn(`[mobile] ${label} tentativa ${i}:`, e);
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
}

export async function bootStore() {
  // initialize PRECISA vir antes de qualquer outra chamada ao plugin.
  try {
    await bootCall("initialize", () => ipc.playerInitialize(), 3000);
  } catch (e) {
    console.error("[mobile] initialize falhou:", e);
  }

  try {
    await bootCall("loadLibrary", loadLibrary, 6000);
    setLibError(null);
  } catch (e) {
    console.error("[mobile] carga da biblioteca falhou:", e);
    setLibError(String(e));
  } finally {
    setLibReady(true);
  }

  rehydrateQueue();
  await syncState();
  void loadIntel();

  ipc.onStateChanged(applyState).catch((e) => console.warn("[mobile] listener state_changed:", e));
  ipc.onTrackChanged(applyState).catch((e) => console.warn("[mobile] listener track_changed:", e));
  ipc.onPosition(applyState).catch((e) => console.warn("[mobile] listener position:", e));

  // O WebView do Android é suspenso em background: ao voltar, o estado
  // pode ter andado (a fila avançou sozinha). Re-sincroniza.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void syncState();
  });
  window.addEventListener("focus", () => void syncState());
}
