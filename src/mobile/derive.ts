/* ============================================================
   derive.ts — funções puras da UI mobile.

   O v0 tem só três leituras de biblioteca (lib_list_folders,
   lib_list_folder_tracks, lib_list_tracks). Álbuns e artistas NÃO
   têm command próprio no mobile: são derivados aqui, agrupando o
   acervo que já está em memória. Mesma escolha da busca — client
   side, como no desktop.

   Nada aqui toca IPC/DOM: é o que os testes cobrem.
   ============================================================ */

import type { DerivedAlbum, DerivedArtist, Origin, Track } from "./types";

export const TONES = ["mint", "sky", "peach", "rose", "lav", "butter", "bone", "paper"] as const;

/** Tom de placeholder estável por chave (o mock do handoff usava o índice). */
export function toneFor(seed: string | number): string {
  if (typeof seed === "number") return TONES[((seed % 8) + 8) % 8];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return TONES[((h % 8) + 8) % 8];
}

/** duration_ms (int) → "M:SS". O mock do handoff já vinha formatado. */
export function fmtDuration(ms: number | null | undefined): string {
  if (!Number.isFinite(ms as number) || (ms as number) < 0) return "0:00";
  const total = Math.floor((ms as number) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Soma de durações → "1 h 24 min" / "47 min". */
export function fmtTotal(msList: number[]): string {
  const total = Math.floor(msList.reduce((a, b) => a + (b || 0), 0) / 60000);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  return `${h} h ${total % 60} min`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString("pt-BR");
}

/** Acentos fora, caixa baixa — mesmo espírito do normalize da busca desktop. */
export function normalize(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function albumKey(t: Pick<Track, "album_title" | "artist_name">): string {
  return `${normalize(t.artist_name)}\u0000${normalize(t.album_title)}`;
}

export function deriveAlbums(tracks: Track[]): DerivedAlbum[] {
  const map = new Map<string, DerivedAlbum>();
  for (const t of tracks) {
    if (!t.album_title) continue;
    const key = albumKey(t);
    const cur = map.get(key);
    if (cur) {
      cur.track_count++;
      if (!cur.cover && t.album_cover_path) cur.cover = t.album_cover_path;
      if (cur.year == null && t.album_year != null) cur.year = t.album_year;
    } else {
      map.set(key, {
        key,
        title: t.album_title,
        artist: t.artist_name,
        year: t.album_year,
        cover: t.album_cover_path,
        track_count: 1,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
}

export function deriveArtists(tracks: Track[]): DerivedArtist[] {
  const map = new Map<string, { a: DerivedArtist; albums: Set<string> }>();
  for (const t of tracks) {
    if (!t.artist_name) continue;
    const key = normalize(t.artist_name);
    let cur = map.get(key);
    if (!cur) {
      cur = {
        a: { name: t.artist_name, track_count: 0, album_count: 0, cover: null },
        albums: new Set<string>(),
      };
      map.set(key, cur);
    }
    cur.a.track_count++;
    if (!cur.a.cover && t.album_cover_path) cur.a.cover = t.album_cover_path;
    if (t.album_title) cur.albums.add(normalize(t.album_title));
    cur.a.album_count = cur.albums.size;
  }
  return [...map.values()]
    .map((v) => v.a)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export function tracksOfAlbum(tracks: Track[], key: string): Track[] {
  return tracks
    .filter((t) => t.album_title && albumKey(t) === key)
    .sort((a, b) => (a.track_number ?? 1e9) - (b.track_number ?? 1e9));
}

export function tracksOfArtist(tracks: Track[], name: string): Track[] {
  const k = normalize(name);
  return tracks.filter((t) => normalize(t.artist_name) === k);
}

/** Busca client-side: substring normalizada em título/artista/álbum. */
export function searchTracks(tracks: Track[], query: string, limit = 120): Track[] {
  const q = normalize(query);
  if (!q) return [];
  const out: Track[] = [];
  for (const t of tracks) {
    if (
      normalize(t.title).includes(q) ||
      normalize(t.artist_name).includes(q) ||
      normalize(t.album_title).includes(q)
    ) {
      out.push(t);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/* Badge de origem do handoff (rádio/playlist/solta). O v0 não tem
   rádio nem station, então os rótulos seguem os origins reais do
   contrato — o badge diz de onde a fila veio, não inventa modo. */
export function originLabel(o: Origin): string {
  switch (o) {
    case "playlist": return "playlist";
    case "album_seq": return "álbum";
    case "shuffle": return "shuffle";
    case "station": return "station";
    default: return "solta";
  }
}

/** data-src do .srcbadge: só playlist e álbum têm cor própria. */
export function originSrc(o: Origin): string | undefined {
  if (o === "playlist") return "playlist";
  if (o === "album_seq") return "album";
  return undefined;
}

/** Raiz comum dos caminhos do acervo — mostrada em Settings. */
export function commonRoot(paths: string[]): string | null {
  if (!paths.length) return null;
  const split = paths.map((p) => p.split("/"));
  const first = split[0];
  let i = 0;
  outer: for (; i < first.length - 1; i++) {
    for (const parts of split) {
      if (parts[i] !== first[i]) break outer;
    }
  }
  const root = first.slice(0, i).join("/");
  return root || "/";
}

/** Fisher-Yates — não muta a entrada. */
export function shuffled<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
