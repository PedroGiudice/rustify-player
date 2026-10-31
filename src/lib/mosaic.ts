// src/lib/mosaic.ts — células do mosaico de capas de uma playlist (A42).
//
// Sempre 4 células deixava pasta com 1 a 3 álbuns com quadrantes pastel
// vazios. Uma capa ocupa o quadro inteiro; duas se cruzam na diagonal;
// três repetem a primeira; o tom só aparece sem capa nenhuma.

export function mosaicCells<T>(covers: readonly T[]): T[] {
  switch (covers.length) {
    case 0: return [];
    case 1: return [covers[0]];
    case 2: return [covers[0], covers[1], covers[1], covers[0]];
    case 3: return [covers[0], covers[1], covers[2], covers[0]];
    default: return covers.slice(0, 4);
  }
}
