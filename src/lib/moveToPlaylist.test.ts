/* ============================================================
   lib/moveToPlaylist.test.ts — regras puras do "Mover para
   playlist…" (CMR-298): seletor de destino, textos, junção dos
   lotes e remapeamento da fila para os ids novos.
   ============================================================ */
import { describe, it, expect } from "vitest";
import {
  chunk, confirmText, createConfirmText, existingFolderMatch, filterPlaylists, isValidPlaylistName, mergeReports,
  undoPlan, undoSummaryText,
  newFolderCandidate, sanitizePlaylistName, summaryText, trackRemapper,
} from "./moveToPlaylist";
import type { MoveReport, Track } from "../tauri";

const names = ["Funk BR", "Rap & Hip-Hop", "Trance"];

function track(id: string, extra: Partial<Track> = {}): Track {
  return {
    id, title: `t${id}`, artist_name: "A", album_title: "B", album_cover_path: null,
    album_year: null, duration_ms: 1, path: `/m/Rap/A/B/${id}.flac`, lrc_path: null,
    genre_name: "Rap", ...extra,
  };
}

describe("seletor de destino", () => {
  it("filtra sem diferenciar caixa e devolve tudo com busca vazia", () => {
    expect(filterPlaylists(names, "  ")).toEqual(names);
    expect(filterPlaylists(names, "fun")).toEqual(["Funk BR"]);
  });

  it("oferece pasta nova só para nome válido e inexistente", () => {
    expect(newFolderCandidate(names, "Favoritas")).toBe("Favoritas");
    expect(newFolderCandidate(names, "  Favoritas ")).toBe("Favoritas");
    expect(newFolderCandidate(names, "funk br")).toBeNull();
    expect(newFolderCandidate(names, "")).toBeNull();
  });

  it("pasta nova sai com o nome FINAL, já sanitizado como no backend", () => {
    expect(sanitizePlaylistName("Treino: pesado")).toBe("Treino_ pesado");
    expect(sanitizePlaylistName("AC/DC  ao vivo")).toBe("AC DC ao vivo");
    // Teto de 120 bytes cortado por code point: 59 bytes ASCII + emojis de
    // 4 bytes. 59 + 15*4 = 119 cabe; o 16º passaria. Nada de surrogate solto.
    const longo = sanitizePlaylistName("a".repeat(59) + "🎧".repeat(20));
    expect(new TextEncoder().encode(longo).length).toBe(119);
    expect(Array.from(longo).filter((c) => c === "🎧")).toHaveLength(15);
    // 117 bytes + emoji (121): cortar uma unidade UTF-16 deixaria um
    // surrogate solto que "cabe" (vira U+FFFD de 3 bytes = 120).
    const borda = sanitizePlaylistName("a".repeat(117) + "🎧");
    expect(borda).toBe("a".repeat(117));
    expect(newFolderCandidate(names, "Treino: pesado")).toBe("Treino_ pesado");
    // Vira algo inválido depois de limpar: recusado.
    expect(newFolderCandidate(names, "?lixo")).toBeNull();
    expect(newFolderCandidate(names, " / ")).toBeNull();
    // Nome existente escrito igual não é "pasta nova", mesmo com caractere proibido.
    expect(newFolderCandidate(["Funk: BR"], "Funk: BR")).toBeNull();
    expect(newFolderCandidate(["Funk: BR"], "FUNK_ br")).toBeNull();
  });

  // A34: colisão não é "nome inválido". O nome digitado bate com uma pasta
  // que já existe (caixa ou forma limpa diferentes): oferecer usar essa.
  it("colisão aponta a pasta existente; nome exato ou novo não colide", () => {
    expect(existingFolderMatch(["Rock_Pop", "Rap"], "Rock:Pop")).toBe("Rock_Pop");
    expect(existingFolderMatch(["Rock_Pop", "Rap"], "rock_pop")).toBe("Rock_Pop");
    expect(existingFolderMatch(["Funk: BR"], "FUNK_ br")).toBe("Funk: BR");
    expect(existingFolderMatch(["Rock_Pop"], "Rock_Pop")).toBeNull();
    expect(existingFolderMatch(["Rock_Pop"], "Jazz")).toBeNull();
    expect(existingFolderMatch(["Rock_Pop"], "  ")).toBeNull();
  });

  it("recusa pastas ocultas, de sistema e com barra", () => {
    for (const bad of [".rustify-incoming", "_Compilations", "a/b", "a\\b", ""]) {
      expect(isValidPlaylistName(bad)).toBe(false);
    }
    expect(isValidPlaylistName("Rap & Hip-Hop")).toBe(true);
  });
});

describe("textos", () => {
  it("confirmação de lote em uma linha", () => {
    expect(confirmText(14, "Esú", "Favoritas")).toBe("Mover 14 faixas de Esú para Favoritas?");
    expect(confirmText(1, null, "Favoritas")).toBe("Mover 1 faixa para Favoritas?");
  });

  it("resumo conta movidas, já presentes e falhas", () => {
    const r = { dest_playlist: "X", moved: 13, already_there: 1, failed: 1, pending: 0, items: [] };
    expect(summaryText(r)).toBe("13 movidas · 1 já estava lá · 1 falhou");
    expect(summaryText({ ...r, moved: 1, already_there: 0, failed: 0 })).toBe("1 movida");
    // Timeout não é falha: segue em andamento.
    expect(summaryText({ ...r, moved: 0, already_there: 0, failed: 0, pending: 4 })).toBe("4 ainda em andamento");
  });

  it("pasta nova sempre confirma, dizendo onde ela nasce (A34)", () => {
    expect(createConfirmText(1, "Rpa & Hip-Hop")).toBe("Criar a pasta ~/Music/Rpa & Hip-Hop e mover 1 faixa?");
    expect(createConfirmText(3, "Treino")).toBe("Criar a pasta ~/Music/Treino e mover 3 faixas?");
  });

  it("resumo do desfazer conta as que voltaram e as que falharam (B4)", () => {
    const r = { dest_playlist: "Rap", moved: 2, already_there: 0, failed: 1, pending: 0, items: [] };
    expect(undoSummaryText(r)).toBe("2 faixas voltaram · 1 falhou");
    expect(undoSummaryText({ ...r, moved: 1, failed: 0 })).toBe("1 faixa voltou");
  });
});

describe("desfazer o mover (B4)", () => {
  const orig = [track("1"), track("2", { genre_name: "Funk BR" }), track("3"), track("4", { genre_name: null })];
  const report: MoveReport = {
    dest_playlist: "Favoritas", moved: 3, already_there: 0, failed: 1, pending: 0,
    items: [
      { track_id: "1", new_track_id: "10", new_path: "/m/Favoritas/A/B/1.flac", new_lrc_path: null, title: null, status: "moved", detail: null },
      { track_id: "2", new_track_id: "20", new_path: "/m/Favoritas/A/B/2.flac", new_lrc_path: null, title: null, status: "moved", detail: null },
      { track_id: "3", new_track_id: null, new_path: null, new_lrc_path: null, title: null, status: "failed", detail: "x" },
      { track_id: "4", new_track_id: "40", new_path: "/m/Favoritas/A/B/4.flac", new_lrc_path: null, title: null, status: "moved", detail: null },
    ],
  };

  it("volta cada movida para a pasta de onde saiu, pelo id NOVO; falhas ficam de fora", () => {
    const plan = undoPlan(report, orig);
    expect(plan.groups).toEqual([
      { dest: "Rap", ids: ["10"] },
      { dest: "Funk BR", ids: ["20"] },
    ]);
    // Sem pasta de origem conhecida não há para onde voltar.
    expect(plan.orphans).toEqual(["40"]);
  });

  it("nada movido = nada a desfazer", () => {
    expect(undoPlan({ ...report, moved: 0, items: [report.items[2]] }, orig).groups).toEqual([]);
  });
});

describe("lotes", () => {
  it("chunk divide sem perder o resto", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
  });

  it("mergeReports soma contagens e concatena itens na ordem", () => {
    const a: MoveReport = { dest_playlist: "X", moved: 2, already_there: 0, failed: 1, pending: 0, items: [] };
    const b: MoveReport = { dest_playlist: "X", moved: 1, already_there: 1, failed: 0, pending: 2, items: [] };
    expect(mergeReports("X", [a, b])).toMatchObject({ moved: 3, already_there: 1, failed: 1, pending: 2 });
  });
});

describe("trackRemapper", () => {
  const report: MoveReport = {
    dest_playlist: "Favoritas", moved: 1, already_there: 0, failed: 1, pending: 0,
    items: [
      {
        track_id: "18446744073709551615", new_track_id: "42", new_path: "/m/Favoritas/A/B/x.flac",
        new_lrc_path: "/m/Favoritas/A/B/x.lrc", title: "x", status: "moved", detail: null,
      },
      { track_id: "7", new_track_id: null, new_path: null, new_lrc_path: null, title: "y", status: "failed", detail: "erro" },
    ],
  };

  it("letra vem do backend: .lrc que não acompanhou fica null, sem inventar caminho", () => {
    const sem = { ...report, items: [{ ...report.items[0], new_lrc_path: null }] };
    const t = track("18446744073709551615", { lrc_path: "/m/Rap/A/B/x.lrc" });
    expect(trackRemapper(sem)(t).lrc_path).toBeNull();
  });

  it("troca id (string u64 sem perder precisão), caminho, letra e pasta da faixa movida", () => {
    const t = track("18446744073709551615", { lrc_path: "/m/Rap/A/B/x.lrc" });
    expect(trackRemapper(report)(t)).toMatchObject({
      id: "42", path: "/m/Favoritas/A/B/x.flac", lrc_path: "/m/Favoritas/A/B/x.lrc", genre_name: "Favoritas",
    });
  });

  it("deixa intactas as que falharam ou não estavam no lote", () => {
    const remap = trackRemapper(report);
    const falhou = track("7");
    const outra = track("9");
    expect(remap(falhou)).toBe(falhou);
    expect(remap(outra)).toBe(outra);
  });
});
