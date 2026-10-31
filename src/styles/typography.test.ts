/* ============================================================
   typography.test.ts — escala tipográfica contra o CSS REAL (A43, A45, B32).

   Lê o texto do extractor-lab.css (o CSSOM do jsdom descarta
   propriedades que não conhece, como font-variant-numeric) e trava:

   - Regra do Número Tabular: toda regra em var(--font-mono) declara
     tabular-nums (o mono do Tweaks aceita qualquer fonte, inclusive
     proporcional; a Instrument Sans embarcada também tem `tnum`).
   - Regra do Piso de 11 e escala por papel: fora do html/body, nenhum
     font-size literal em px; tudo passa por um token --fs-*.
   - Receita de rótulo: regra em caixa-alta usa --fs-label.
   ============================================================ */
import { describe, it, expect, beforeAll } from "vitest";

type Rule = { sel: string; body: string };
let css = "";
let rules: Rule[] = [];

beforeAll(async () => {
  const NODE_FS = "node:fs";
  const { readFileSync } = await import(/* @vite-ignore */ NODE_FS);
  const root: string = (globalThis as any).process.cwd();
  css = readFileSync(`${root}/src/styles/extractor-lab.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1].trim().replace(/\s+/g, " "),
    body: m[2],
  }));
});

const decl = (body: string, prop: string) =>
  body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`))?.[1].trim();

describe("Regra do Número Tabular", () => {
  it("toda regra em fonte mono declara tabular-nums", () => {
    const missing = rules
      .filter((r) => decl(r.body, "font-family") === "var(--font-mono)")
      .filter((r) => !/font-variant-numeric\s*:\s*[^;]*tabular-nums/.test(r.body))
      .map((r) => r.sel);
    expect(missing).toEqual([]);
  });
});

describe("escala por papel", () => {
  it("o :root declara os degraus da escala", () => {
    for (const t of ["--fs-label", "--fs-meta", "--fs-small", "--fs-title-sm", "--fs-body",
                     "--fs-title", "--fs-title-lg", "--fs-subhead", "--fs-lead", "--fs-headline",
                     "--fs-feature"]) {
      expect(css).toMatch(new RegExp(`${t}\\s*:\\s*[\\d.]+px`));
    }
  });

  it("nenhum font-size literal em px fora do html/body", () => {
    const literal = rules
      .filter((r) => r.sel !== "html, body")
      .filter((r) => /font-size\s*:\s*[\d.]+px/.test(r.body))
      .map((r) => `${r.sel} { font-size: ${decl(r.body, "font-size")} }`);
    expect(literal).toEqual([]);
  });

  it("rótulo em caixa-alta usa --fs-label", () => {
    const off = rules
      .filter((r) => /text-transform\s*:\s*uppercase/.test(r.body))
      .filter((r) => decl(r.body, "font-size") !== "var(--fs-label)")
      .map((r) => r.sel);
    expect(off).toEqual([]);
  });
});
