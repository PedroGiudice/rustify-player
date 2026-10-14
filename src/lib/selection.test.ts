import { describe, it, expect } from "vitest";
import {
  EMPTY_SEL, toggleId, selectRange, selectAll, pruneTo, pickSelected, selLabel, moveLabel, withoutIds,
} from "./selection";

const L = ["a", "b", "c", "d", "e"];

describe("seleção múltipla (lógica pura)", () => {
  it("toggleId marca, desmarca e move a âncora", () => {
    const s1 = toggleId(EMPTY_SEL, "b");
    expect([...s1.ids]).toEqual(["b"]);
    expect(s1.anchor).toBe("b");
    const s2 = toggleId(s1, "d");
    expect([...s2.ids].sort()).toEqual(["b", "d"]);
    const s3 = toggleId(s2, "b");
    expect([...s3.ids]).toEqual(["d"]);
    expect(s3.anchor).toBe("b");
    expect(EMPTY_SEL.ids.size).toBe(0); // imutável
  });

  it("selectRange cobre âncora..alvo nos dois sentidos e preserva a âncora", () => {
    const a = toggleId(EMPTY_SEL, "b");
    const fwd = selectRange(a, L, "d");
    expect([...fwd.ids].sort()).toEqual(["b", "c", "d"]);
    expect(fwd.anchor).toBe("b");
    const back = selectRange(a, L, "a");
    expect([...back.ids].sort()).toEqual(["a", "b"]);
  });

  it("selectRange soma ao que já estava marcado", () => {
    let s = toggleId(EMPTY_SEL, "a");
    s = toggleId(s, "d");
    const r = selectRange(s, L, "e");
    expect([...r.ids].sort()).toEqual(["a", "d", "e"]);
  });

  it("selectRange sem âncora marca só a clicada; id fora da lista é ignorado", () => {
    const r = selectRange(EMPTY_SEL, L, "c");
    expect([...r.ids]).toEqual(["c"]);
    expect(r.anchor).toBe("c");
    expect(selectRange(r, L, "zzz")).toBe(r);
  });

  it("selectAll e pruneTo", () => {
    const all = selectAll(L);
    expect(all.ids.size).toBe(5);
    const pruned = pruneTo(all, ["b", "c", "x"]);
    expect([...pruned.ids].sort()).toEqual(["b", "c"]);
    expect(pruned.anchor).toBe(null); // "a" saiu
    expect(pruneTo(all, L)).toBe(all); // nada mudou: mesma referência
    expect(selectAll([]).anchor).toBe(null);
  });

  it("ids u64 grandes ficam como string e não colidem", () => {
    const hi = "18446744073709551615";
    const near = "18446744073709551614"; // Number() colapsaria os dois
    const list = [near, hi];
    expect(Number(hi)).toBe(Number(near));
    const s = toggleId(EMPTY_SEL, hi);
    expect(s.ids.has(hi)).toBe(true);
    expect(s.ids.has(near)).toBe(false);
    expect(pickSelected(s, list.map((id) => ({ id })))).toEqual([{ id: hi }]);
    const r = selectRange(toggleId(EMPTY_SEL, near), list, hi);
    expect(r.ids.size).toBe(2);
  });

  it("pickSelected respeita a ordem da lista, não a dos cliques", () => {
    let s = toggleId(EMPTY_SEL, "d");
    s = toggleId(s, "b");
    expect(pickSelected(s, L.map((id) => ({ id }))).map((t) => t.id)).toEqual(["b", "d"]);
  });

  it("rótulos", () => {
    expect(selLabel(1)).toBe("1 selecionada");
    expect(selLabel(12)).toBe("12 selecionadas");
    expect(moveLabel(1)).toBe("Mover para playlist…");
    expect(moveLabel(12)).toBe("Mover 12 faixas para playlist…");
  });
});

describe("withoutIds", () => {
  it("tira só os ids dados e mantém o resto; âncora removida zera", () => {
    const s = { ids: new Set(["a", "b", "c"]), anchor: "b" };
    const r = withoutIds(s, ["b", "zz"]);
    expect([...r.ids]).toEqual(["a", "c"]);
    expect(r.anchor).toBeNull();
    expect(withoutIds(s, ["zz"])).toBe(s);
  });
});
