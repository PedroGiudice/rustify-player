/* ============================================================
   focus-ring.test.ts — anel de foco de teclado contra o CSS REAL.

   O anel global é :where(:focus-visible) { outline: var(--focus-outline) }
   com especificidade zero de propósito. Duas formas de furar o
   contrato apareceram na revisão da fase 0 (25/09):

   - regra por classe que repete o anel com valor fixo
     (2px solid var(--blue-ring)): tem especificidade de classe, vence
     o token, e ajustar --focus-outline deixa esses controles de fora;
   - classe que zera o outline sem substituto (.slider): o slider de
     volume do Settings ficava sem nenhuma indicação de foco.
   ============================================================ */
import { describe, it, expect, beforeAll } from "vitest";

let rules: CSSStyleRule[] = [];

function collect(list: CSSRuleList, out: CSSStyleRule[]) {
  for (const r of Array.from(list)) {
    if ((r as CSSStyleRule).selectorText !== undefined) out.push(r as CSSStyleRule);
    const inner = (r as CSSGroupingRule).cssRules;
    if (inner) collect(inner, out);
  }
}

beforeAll(async () => {
  const NODE_FS = "node:fs";
  const { readFileSync } = await import(/* @vite-ignore */ NODE_FS);
  const root: string = (globalThis as any).process.cwd();
  const style = document.createElement("style");
  style.textContent = readFileSync(`${root}/src/styles/extractor-lab.css`, "utf8");
  document.head.appendChild(style);
  collect(style.sheet!.cssRules, rules = []);
});

const outlineOf = (r: CSSStyleRule) => r.style.getPropertyValue("outline").trim();

describe("anel de foco", () => {
  it("regras de :focus-visible usam o token, nunca o valor fixo", () => {
    const fixed = rules
      .filter((r) => r.selectorText.includes(":focus-visible"))
      .filter((r) => {
        const o = outlineOf(r);
        return o !== "" && o !== "var(--focus-outline)" && o !== "0" && o !== "none";
      })
      .map((r) => `${r.selectorText} { outline: ${outlineOf(r)} }`);
    expect(fixed).toEqual([]);
  });

  it(".slider zera o outline e devolve o anel no :focus-visible", () => {
    const ring = rules.find((r) => r.selectorText.split(",").some((s) => s.trim() === ".slider:focus-visible"));
    expect(ring && outlineOf(ring)).toBe("var(--focus-outline)");
  });
});
