import { describe, it, expect } from "vitest";
import type { Track } from "../tauri";
import {
  classifyTidalInput, estimateSelection, formatSize, formatEta, formatTrackTime, formatListTime,
  buildOwnedIndex, findOwned, defaultSelection, orderedSelection, latestOnly, titleKey, MAX_SELECTION,
} from "./tidalSearch";

function lib(title: string, artist: string): Track {
  return {
    id: `${artist}-${title}`, title, artist_name: artist, album_title: null, album_cover_path: null,
    album_year: null, duration_ms: 0, path: "", lrc_path: null,
  };
}

describe("classifyTidalInput", () => {
  it("link da Tidal (todas as formas que a fila aceita)", () => {
    expect(classifyTidalInput("https://tidal.com/browse/mix/0001b8")).toBe("link");
    expect(classifyTidalInput("  https://listen.tidal.com/album/123 ")).toBe("link");
    expect(classifyTidalInput("http://www.tidal.com/track/9?u")).toBe("link");
  });
  it("outro endereço também não vira busca", () => {
    expect(classifyTidalInput("https://soundcloud.com/x")).toBe("link");
  });
  it("texto: vazio, curto e busca", () => {
    expect(classifyTidalInput("   ")).toBe("empty");
    expect(classifyTidalInput("a")).toBe("short");
    expect(classifyTidalInput(" o ")).toBe("short");
    expect(classifyTidalInput("or")).toBe("text");
    expect(classifyTidalInput("tidal.com/mix/abc")).toBe("text"); // sem esquema = texto
  });
});

describe("estimativa da seleção", () => {
  it("6 MB/min em CD, 12 MB/min em hi-res, 17 s por faixa", () => {
    const e = estimateSelection([{ duracao_s: 180, hires: false }, { duracao_s: 120, hires: true }]);
    expect(e.count).toBe(2);
    expect(e.bytes).toBe(18_000_000 + 24_000_000);
    expect(e.seconds).toBe(34);
  });
  it("18 faixas de ~3 min: ~0,3 GB e ~5 min", () => {
    const e = estimateSelection(Array.from({ length: 18 }, () => ({ duracao_s: 200, hires: false })));
    expect(formatSize(e.bytes)).toBe("~360 MB");
    expect(formatEta(e.seconds)).toBe("~5 min");
  });
  it("formatos", () => {
    expect(formatSize(0)).toBe("0 MB");
    expect(formatSize(1_100_000_000)).toBe("~1,1 GB");
    expect(formatSize(400_000)).toBe("~1 MB");
    expect(formatEta(0)).toBe("0 min");
    expect(formatEta(30)).toBe("<1 min");
    expect(formatEta(100 * 17)).toBe("~28 min");
    expect(formatEta(4800)).toBe("~1 h 20 min");
    expect(formatTrackTime(182)).toBe("3:02");
    expect(formatTrackTime(3723)).toBe("1:02:03");
    expect(formatListTime(19955)).toBe("5 h 33 min");
    expect(formatListTime(1500)).toBe("25 min");
  });
});

describe("no acervo", () => {
  const idx = buildOwnedIndex([
    lib("Mitsubishi", "Orochi"),
    lib("Balão", "Orochi, Kayblack"),
    lib("Orochi", "Fulano"),
  ]);
  it("casa por artista + título (versão entre parênteses não atrapalha)", () => {
    expect(findOwned({ titulo: "Mitsubishi (Remastered)", artistas: ["Orochi"] }, idx)?.title).toBe("Mitsubishi");
    expect(findOwned({ titulo: "Balão", artistas: ["Kayblack"] }, idx)?.title).toBe("Balão");
  });
  it("título igual de outro artista não conta", () => {
    expect(findOwned({ titulo: "Mitsubishi", artistas: ["Outro"] }, idx)).toBeNull();
  });
  it("faixa com o nome do artista não marca o artista inteiro", () => {
    expect(findOwned({ titulo: "Celebridade", artistas: ["Orochi"] }, idx)).toBeNull();
  });

  describe("mesma chave do baixador (falsos positivos da revisão)", () => {
    const i2 = buildOwnedIndex([
      lib("HUMBLE.", "Kendrick Lamar"),
      lib("Mitsubishi", "Orochi"),
      lib("Love", "Kendrick Lamar"),
      lib("Foo (feat. Rihanna)", "Drake"),
      lib("Balão", "Orochi"),
    ]);
    it("remix, ao vivo e título maior não casam", () => {
      expect(findOwned({ titulo: "HUMBLE. (Skrillex Remix)", artistas: ["Kendrick Lamar"] }, i2)).toBeNull();
      expect(findOwned({ titulo: "Mitsubishi (Ao Vivo)", artistas: ["Orochi"] }, i2)).toBeNull();
      expect(findOwned({ titulo: "Love Me Now", artistas: ["Kendrick Lamar"] }, i2)).toBeNull();
      for (const v of ["Foo (Live)", "Foo (Acústico)", "Foo - Radio Edit", "Foo (Versão Estendida)", "Foo (Instrumental)"]) {
        expect(findOwned({ titulo: v, artistas: ["Drake"] }, buildOwnedIndex([lib("Foo", "Drake")])), v).toBeNull();
      }
    });
    it("verdadeiros positivos: feat. de um lado, caixa e acento", () => {
      expect(findOwned({ titulo: "HUMBLE.", artistas: ["kendrick lamar"] }, i2)?.title).toBe("HUMBLE.");
      expect(findOwned({ titulo: "Foo", artistas: ["Drake"] }, i2)?.title).toBe("Foo (feat. Rihanna)");
      expect(findOwned({ titulo: "Foo [ft. Rihanna]", artistas: ["Drake"] }, i2)?.title).toBe("Foo (feat. Rihanna)");
      expect(findOwned({ titulo: "BALAO", artistas: ["OROCHI"] }, i2)?.title).toBe("Balão");
      expect(findOwned({ titulo: "Love", artistas: ["Kendrick Lamar"] }, i2)?.title).toBe("Love");
    });
    it("titleKey: créditos e Remastered saem, versão fica", () => {
      expect(titleKey("Foo - Remastered 2011")).toBe(titleKey("Foo"));
      expect(titleKey("Foo feat. Bar")).toBe(titleKey("Foo (Remastered)"));
      expect(titleKey("Foo (Remix)")).not.toBe(titleKey("Foo"));
      expect(titleKey("Stay (With You)")).not.toBe(titleKey("Stay"));
      expect(titleKey("日本語")).toBe(""); // vazia nunca casa (igual ao baixador)
      expect(findOwned({ titulo: "日本語", artistas: ["Orochi"] }, buildOwnedIndex([lib("日本語", "Orochi")]))).toBeNull();
    });
  });
});

describe("seleção padrão", () => {
  const tracks = [{ id: 1 }, { id: 2 }, { id: 3 }];
  it("desmarca o que está no acervo", () => {
    expect([...defaultSelection(tracks, (id) => id === 2)].sort()).toEqual([1, 3]);
  });
  it("nunca passa de 200: marca as 200 primeiras novas", () => {
    const many = Array.from({ length: 350 }, (_, i) => ({ id: i + 1 }));
    const sel = defaultSelection(many, (id) => id <= 10);
    expect(sel.size).toBe(MAX_SELECTION);
    expect(sel.has(10)).toBe(false);
    expect(sel.has(11)).toBe(true);
    expect(sel.has(210)).toBe(true);
    expect(sel.has(211)).toBe(false);
  });
  it("ordem da lista no pedido", () => {
    expect(orderedSelection(tracks, new Set([3, 1]))).toEqual([1, 3]);
  });
});

describe("latestOnly", () => {
  it("descarta a resposta de um pedido mais antigo", () => {
    const seq = latestOnly();
    const a = seq.next();
    const b = seq.next();
    expect(seq.isCurrent(a)).toBe(false);
    expect(seq.isCurrent(b)).toBe(true);
    seq.cancel();
    expect(seq.isCurrent(b)).toBe(false);
  });
});
