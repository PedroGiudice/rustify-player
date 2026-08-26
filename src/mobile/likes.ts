/* ============================================================
   likes.ts — estado do like no aparelho (CMR-220). Módulo PURO
   (sem Solid, sem Tauri): só a regra e a persistência local.

   Duas fontes, o mais NOVO vence — o mesmo last-write-wins que o
   desktop aplica em track_enrichments por `like_updated_at`:
   - o manifest (`liked_at`/`like_updated_at`), verdade do desktop
     na hora do export;
   - o override local, carimbado com `at` no gesto. Ele existe
     porque o journal → sync → desktop → re-export leva horas e o
     coração precisa refletir o toque na hora, inclusive após um
     reload do WebView.
   O override é descartável: quando o manifest re-exportado chega
   mais novo, ele perde sozinho.
   ============================================================ */

import type { Track } from "./types";

export interface LikeOverride {
  liked: boolean;
  /** Epoch em segundos do gesto — mesma unidade do manifest. */
  at: number;
}

export type LikeOverrides = Record<string, LikeOverride>;

const KEY = "kv-mobile-likes";

/** Carimbo do manifest para o LWW. Manifest sem `like_updated_at` compara
 *  contra o próprio `liked_at` (manifest antigo ou like sem carimbo). */
const manifestStamp = (track: Track) => track.like_updated_at ?? track.liked_at ?? 0;

/** Estado efetivo: override se for mais novo que o carimbo do manifest;
 *  senão, `liked_at` preenchido. */
export function effectiveLiked(track: Track, override: LikeOverride | undefined): boolean {
  if (override && override.at > manifestStamp(track)) return override.liked;
  return track.liked_at != null;
}

/** Poda ao carregar a biblioteca (boot/rescan): fica só o override que ainda
 *  DECIDE algo — mais novo que o carimbo do manifest e de faixa que existe.
 *  O resto o manifest já absorveu (ou a faixa sumiu) e `effectiveLiked` nunca
 *  mais o leria; sem poda o `kv-mobile-likes` só cresce. Biblioteca vazia não
 *  poda: sem manifest não há contra o que comparar (permissão de storage
 *  negada, por exemplo) e o gesto ainda não sincronizado se perderia da tela. */
export function pruneOverrides(overrides: LikeOverrides, tracks: Track[]): LikeOverrides {
  if (!tracks.length) return overrides;
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const out: LikeOverrides = {};
  for (const [id, o] of Object.entries(overrides)) {
    const t = byId.get(id);
    if (t && o.at > manifestStamp(t)) out[id] = o;
  }
  return out;
}

function isOverride(v: unknown): v is LikeOverride {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as LikeOverride).liked === "boolean" &&
    typeof (v as LikeOverride).at === "number" &&
    Number.isFinite((v as LikeOverride).at)
  );
}

/** Lê os overrides; qualquer lixo (JSON inválido, shape errado, storage
 *  bloqueado) vira `{}` — o coração nunca pode derrubar a tela. */
export function loadOverrides(): LikeOverrides {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: LikeOverrides = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isOverride(v)) out[id] = { liked: v.liked, at: v.at };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveOverrides(overrides: LikeOverrides): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(overrides));
  } catch {
    // storage indisponível: o estado vive só na sessão
  }
}
