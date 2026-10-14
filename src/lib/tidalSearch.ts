/* ============================================================
   lib/tidalSearch.ts — funções puras da busca da aba Tidal do Crate
   (spec 2026-10-14): link x texto, "no acervo", estimativa de
   tamanho/tempo da seleção, seleção padrão e descarte de resposta
   atrasada. A rede (busca, artista, prévia, capa) vive em tauri.ts.
   ============================================================ */

import type { Track, TidalTrack } from "../tauri";

/** Mesma regra do `is_valid_tidal_link` (Rust) e do `URL_RE` da fila. */
const TIDAL_LINK = /^https?:\/\/(listen\.|www\.)?tidal\.com\/(browse\/)?(mix|playlist|album|track)\/[A-Za-z0-9-]/i;
/** Qualquer endereço: não vira busca por texto (link de outro lugar ou da
    Tidal num formato que a fila não aceita cai no erro do Baixar). */
const ANY_URL = /^https?:\/\//i;

export const MIN_QUERY = 2;
export const SEARCH_DEBOUNCE_MS = 500;

export type TidalInput = "empty" | "link" | "short" | "text";

/** O campo único da aba: link -> fluxo de link de sempre; texto com 2+
    caracteres -> busca; menos que isso -> nada. */
export function classifyTidalInput(raw: string): TidalInput {
  const s = raw.trim();
  if (!s) return "empty";
  if (TIDAL_LINK.test(s) || ANY_URL.test(s)) return "link";
  return [...s].length < MIN_QUERY ? "short" : "text";
}

// ── estimativa (spec §3.4) ─────────────────────────────────────────
/** MB por minuto de áudio: qualidade de CD e hi-res (FLAC medido). */
export const MB_PER_MIN_CD = 6;
export const MB_PER_MIN_HIRES = 12;
/** Tempo de download+envio por faixa (Peace Piece, 13/10). */
export const SECONDS_PER_TRACK = 17;

export interface SelectionEstimate {
  count: number;
  bytes: number;
  seconds: number;
}

export function estimateSelection(tracks: Pick<TidalTrack, "duracao_s" | "hires">[]): SelectionEstimate {
  let mb = 0;
  for (const t of tracks) mb += (t.duracao_s / 60) * (t.hires ? MB_PER_MIN_HIRES : MB_PER_MIN_CD);
  return { count: tracks.length, bytes: Math.round(mb * 1_000_000), seconds: tracks.length * SECONDS_PER_TRACK };
}

const nf1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/** "~1,1 GB", "~240 MB"; 0 -> "0 MB". */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const mb = bytes / 1_000_000;
  if (mb >= 1000) return `~${nf1.format(mb / 1000)} GB`;
  return `~${Math.max(1, Math.round(mb))} MB`;
}

/** Tempo estimado de chegada: "<1 min", "~6 min", "~1 h 20 min". */
export function formatEta(seconds: number): string {
  if (seconds <= 0) return "0 min";
  if (seconds < 60) return "<1 min";
  const min = Math.round(seconds / 60);
  if (min < 60) return `~${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `~${h} h ${m} min` : `~${h} h`;
}

/** Duração de faixa "3:02" / "1:02:03". */
export function formatTrackTime(s: number): string {
  const total = Math.max(0, Math.round(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Duração de lista: "32 min", "5 h 32 min". */
export function formatListTime(s: number): string {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function plural(n: number, um: string, varios: string): string {
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;
}

// ── no acervo ─────────────────────────────────────────────────────
/* A MESMA chave do baixador (`tidal_mix_dl.py`: `title_key` + `split_artists` + `loose`), para a
   tela e o "JÁ NO ACERVO" do download concordarem: título igual depois de tirar só o que não é marca
   de versão (créditos "feat." e "Remastered"), e artista sobreposto. Remix, live, ao vivo,
   acústico, versão, edit, mix e instrumental continuam distinguindo a faixa. Mudou aqui? Mude lá. */

/** Mesmo corte de artistas do `split_artists` do baixador. */
const ARTIST_SPLIT = /,|&| e | feat\.? | ft\.? | x /i;
const CREDITO = /^(?:feat|ft|featuring|prod|part|participacao)\b\.?.*$/;
const NEUTRO = /^(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?|explicit|bonus track)$/;

/** `loose` do baixador: caixa, pontuação e "&" x "e" não contam; só a-z e 0-9 sobram. */
function loose(s: string): string {
  return s.toLowerCase().replace(/&/g, " e ").replace(/ and /g, " e ").replace(/[^a-z0-9]+/g, "");
}

function neutro(inner: string): boolean {
  const i = inner.trim();
  return CREDITO.test(i) || NEUTRO.test(i);
}

/** Chave frouxa do título. Vazia (título sem letra latina) nunca casa. */
export function titleKey(title: string): string {
  let t = title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  t = t.replace(/\(([^()]*)\)|\[([^[\]]*)\]/g, (m, a, b) => (neutro(a ?? b) ? " " : m));
  t = t.replace(/\s+-\s+(.*)$/, (m, a) => (neutro(a) ? " " : m));
  t = t.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/, " ");
  return loose(t);
}

function artistKeys(name: string | null | undefined): string[] {
  if (!name) return [];
  return name.split(ARTIST_SPLIT).map(loose).filter(Boolean);
}

export type OwnedIndex = Map<string, Track[]>;

/** Acervo agrupado por artista (cada nome de uma faixa com vários artistas
    entra em todas as chaves). */
export function buildOwnedIndex(tracks: Track[]): OwnedIndex {
  const idx: OwnedIndex = new Map();
  for (const t of tracks) {
    for (const k of new Set(artistKeys(t.artist_name))) {
      const list = idx.get(k);
      if (list) list.push(t);
      else idx.set(k, [t]);
    }
  }
  return idx;
}

const ownedTitleKey = new WeakMap<Track, string>();
function keyOf(t: Track): string {
  let k = ownedTitleKey.get(t);
  if (k === undefined) { k = titleKey(t.title); ownedTitleKey.set(t, k); }
  return k;
}

/** A faixa da Tidal já está no acervo? Candidatas = faixas de algum dos
    artistas dela; vale quem tem o MESMO título (`titleKey`). "HUMBLE." no
    acervo não marca "HUMBLE. (Skrillex Remix)", "Love" não marca "Love Me
    Now", e "Foo (feat. X)" casa com "Foo". */
export function findOwned(t: Pick<TidalTrack, "titulo" | "artistas">, idx: OwnedIndex): Track | null {
  const key = titleKey(t.titulo);
  if (!key) return null;
  for (const a of t.artistas) {
    for (const k of artistKeys(a)) {
      for (const c of idx.get(k) ?? []) if (keyOf(c) === key) return c;
    }
  }
  return null;
}

// ── seleção da prévia ─────────────────────────────────────────────
/** Teto do pedido (o mesmo `MAX_FAIXAS` da fila e `MAX_TRACK_IDS` do Rust). */
export const MAX_SELECTION = 200;

/** Padrão: as primeiras `max` faixas que não estão no acervo, na ordem da lista. */
export function defaultSelection(
  tracks: Pick<TidalTrack, "id">[],
  owned: (id: number) => boolean,
  max: number = MAX_SELECTION,
): Set<number> {
  return new Set(tracks.filter((t) => !owned(t.id)).slice(0, max).map((t) => t.id));
}

/** Ids marcados na ordem da lista (a fila baixa nessa ordem). */
export function orderedSelection(tracks: Pick<TidalTrack, "id">[], sel: Set<number>): number[] {
  return tracks.filter((t) => sel.has(t.id)).map((t) => t.id);
}

// ── resposta atrasada ─────────────────────────────────────────────
/** Ticket por pedido: só a resposta do pedido mais recente vale. Busca
    "oro" que chega depois de "orochi" é descartada. */
export function latestOnly() {
  let n = 0;
  return {
    next: () => ++n,
    isCurrent: (t: number) => t === n,
    /** Invalida o que estiver em voo (ex.: o campo foi limpo). */
    cancel: () => { n++; },
  };
}
