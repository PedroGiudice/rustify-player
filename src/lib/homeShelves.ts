// src/lib/homeShelves.ts — a prateleira de álbuns da Home segue a escuta
// (B12, varredura de 31/10). Eram os 12 primeiros do acervo em ordem
// alfabética, sempre os mesmos. Agora: os álbuns do que tocou por último,
// depois os das faixas mais tocadas, e só então o acervo completa a
// prateleira (alfabético, para a grade nunca ficar curta num acervo novo).
//
// O álbum é título + artista (como list_albums agrupa): um "Greatest Hits"
// tocado não puxa o homônimo de outro artista.

interface AlbumLike {
  title: string;
  artist_name: string | null;
}

interface TrackLike {
  album_title: string | null;
  artist_name: string | null;
}

const keyOf = (title: string, artist: string | null) => `${title.toLowerCase()}|${artist ?? ""}`;

export function listenedAlbums<A extends AlbumLike>(
  all: readonly A[],
  recent: readonly TrackLike[],
  mostPlayed: readonly TrackLike[],
  limit: number,
): A[] {
  const byKey = new Map(all.map((a) => [keyOf(a.title, a.artist_name), a] as const));
  const out: A[] = [];
  const seen = new Set<string>();
  const push = (a: A | undefined) => {
    if (!a || out.length >= limit) return;
    const k = keyOf(a.title, a.artist_name);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(a);
  };
  for (const t of [...recent, ...mostPlayed]) {
    if (t.album_title) push(byKey.get(keyOf(t.album_title, t.artist_name)));
  }
  for (const a of all) push(a);
  return out;
}
