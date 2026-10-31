// src/lib/albumRoute.ts — rota da página de álbum com o artista (A19).
//
// O álbum é título + artista (query.rs list_albums agrupa por
// `título|artista`). Só com o título, dois "Greatest Hits" viravam uma
// página só e a fila misturava os dois. A rota leva `?artista=`; o título
// vai codificado, então um "?" do título nunca encosta no separador.
// Rota antiga, sem artista, continua abrindo (primeiro álbum com o título).

export function albumHref(title: string, artist: string | null | undefined): string {
  const base = `/album/${encodeURIComponent(title)}`;
  return artist ? `${base}?artista=${encodeURIComponent(artist)}` : base;
}

export function parseAlbumParam(param: string | null | undefined): { title: string | null; artist: string | null } {
  if (!param) return { title: null, artist: null };
  const q = param.indexOf("?");
  const rawTitle = q < 0 ? param : param.slice(0, q);
  const artist = q < 0 ? null : new URLSearchParams(param.slice(q + 1)).get("artista");
  return { title: decodeURIComponent(rawTitle), artist: artist || null };
}

/** Teto de faixas de um álbum (grade, página do álbum e do artista). Bater
    nele = lista (e o "Mover") incompleta, e a página diz isso. */
export const ALBUM_TRACK_LIMIT = 200;
