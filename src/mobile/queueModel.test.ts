import { describe, expect, it } from "vitest";
import { canShuffleUpcoming, remainingMs, resolveQueue, skipReport, splitQueue } from "./queueModel";
import type { QueueEntry, QueueSnapshot, Track } from "./types";

function track(id: string, durationMs = 180_000): Track {
  return {
    id,
    title: `t${id}`,
    artist_name: null,
    album_title: null,
    album_cover_path: null,
    album_year: null,
    duration_ms: durationMs,
    path: `/m/${id}.opus`,
    lrc_path: null,
    track_number: null,
    genre_name: null,
    dominant_color: null,
  };
}

function entry(trackId: string, durationMs = 180_000, origin = "manual"): QueueEntry {
  return { trackId, origin, contextId: null, durationMs };
}

function snapshot(ids: string[], index: number): QueueSnapshot {
  return { items: ids.map((id) => entry(id)), index };
}

const lib = (ids: string[]) => new Map(ids.map((id) => [id, track(id)]));

describe("resolveQueue", () => {
  it("resolve cada entry contra a biblioteca preservando a ordem do serviço", () => {
    const r = resolveQueue(snapshot(["a", "b", "c"], 1), lib(["a", "b", "c"]));
    expect(r.items.map((t) => t?.id)).toEqual(["a", "b", "c"]);
    expect(r.index).toBe(1);
  });

  it("devolve null na posição da faixa ausente do manifest, sem encurtar a lista", () => {
    // Caso real: acervo do celular divergiu do manifest (sync parcial).
    // Encurtar a lista desalinharia TODOS os índices contra o serviço.
    const r = resolveQueue(snapshot(["a", "sumiu", "c"], 2), lib(["a", "c"]));
    expect(r.items).toHaveLength(3);
    expect(r.items[1]).toBeNull();
    expect(r.index).toBe(2);
  });

  it("tolera snapshot vazio e índice -1", () => {
    const r = resolveQueue({ items: [], index: -1 }, lib([]));
    expect(r.items).toEqual([]);
    expect(r.index).toBe(-1);
  });

  it("clampa índice fora de faixa vindo do serviço", () => {
    expect(resolveQueue(snapshot(["a"], 7), lib(["a"])).index).toBe(0);
    expect(resolveQueue(snapshot(["a"], -3), lib(["a"])).index).toBe(-1);
  });
});

describe("splitQueue", () => {
  it("separa passado, atual e próximas", () => {
    const items = [track("a"), track("b"), track("c"), track("d")];
    const s = splitQueue(items, 1);
    expect(s.past.map((t) => t?.id)).toEqual(["a"]);
    expect(s.current?.id).toBe("b");
    expect(s.upcoming.map((t) => t?.id)).toEqual(["c", "d"]);
  });

  it("index -1 (nada tocando) põe tudo em upcoming", () => {
    const items = [track("a"), track("b")];
    const s = splitQueue(items, -1);
    expect(s.past).toEqual([]);
    expect(s.current).toBeNull();
    expect(s.upcoming.map((t) => t?.id)).toEqual(["a", "b"]);
  });

  it("index no último item deixa upcoming vazio", () => {
    const items = [track("a"), track("b")];
    const s = splitQueue(items, 1);
    expect(s.past.map((t) => t?.id)).toEqual(["a"]);
    expect(s.current?.id).toBe("b");
    expect(s.upcoming).toEqual([]);
  });

  it("índice além do fim não inventa faixa corrente", () => {
    const s = splitQueue([track("a")], 5);
    expect(s.current).toBeNull();
    expect(s.upcoming).toEqual([]);
  });
});

describe("remainingMs", () => {
  it("desconta a posição corrente e soma o resto da fila", () => {
    const entries = [entry("a", 100_000), entry("b", 200_000), entry("c", 300_000)];
    // tocando 'b' aos 50s: restam 150s de b + 300s de c
    expect(remainingMs(entries, 1, 50_000)).toBe(450_000);
  });

  it("nada tocando soma a fila inteira", () => {
    const entries = [entry("a", 100_000), entry("b", 200_000)];
    expect(remainingMs(entries, -1, 0)).toBe(300_000);
  });

  it("posição além da duração não gera valor negativo", () => {
    const entries = [entry("a", 100_000), entry("b", 200_000)];
    expect(remainingMs(entries, 0, 999_000)).toBe(200_000);
  });

  it("duração desconhecida (0) não quebra a soma", () => {
    const entries = [entry("a", 0), entry("b", 60_000)];
    expect(remainingMs(entries, 0, 0)).toBe(60_000);
  });

  it("fila vazia é zero", () => {
    expect(remainingMs([], -1, 0)).toBe(0);
  });
});

describe("canShuffleUpcoming (CMR-218)", () => {
  const fila = ["a", "b", "c", "d"].map((id) => entry(id));

  it("precisa de pelo menos 2 faixas DEPOIS da corrente", () => {
    expect(canShuffleUpcoming(fila, 0)).toBe(true); // 3 a seguir
    expect(canShuffleUpcoming(fila, 1)).toBe(true); // 2 a seguir
    expect(canShuffleUpcoming(fila, 2)).toBe(false); // 1 a seguir: nada a permutar
    expect(canShuffleUpcoming(fila, 3)).toBe(false); // última
  });

  it("sem faixa corrente (index -1) não há 'restante'", () => {
    expect(canShuffleUpcoming(fila, -1)).toBe(false);
  });

  it("fila vazia ou índice além do fim", () => {
    expect(canShuffleUpcoming([], -1)).toBe(false);
    expect(canShuffleUpcoming([], 0)).toBe(false);
    expect(canShuffleUpcoming(fila, 9)).toBe(false);
  });
});

describe("skipReport", () => {
  const pb = { index: 3, trackId: "42", positionMs: 12_345.6, durationMs: 200_000 };

  it("reporta quando o pulo é para frente", () => {
    expect(skipReport(pb, 4)).toEqual({ trackId: "42", positionMs: 12_346, durationMs: 200_000 });
  });

  it("reporta o 'próxima' (sem alvo), que é avanço por definição", () => {
    expect(skipReport(pb)?.trackId).toBe("42");
  });

  it("NÃO reporta replay: voltar é repetir, não recusar", () => {
    expect(skipReport(pb, 2)).toBeNull();
    expect(skipReport(pb, 0)).toBeNull();
    // re-tocar a própria faixa corrente também não é rejeição
    expect(skipReport(pb, 3)).toBeNull();
  });

  it("sem faixa corrente não há o que reportar", () => {
    expect(skipReport({ ...pb, trackId: null }, 4)).toBeNull();
  });
});
