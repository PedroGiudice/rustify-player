/* ============================================================
   styles.test.ts — regras de CSS do S24 que o jsdom não aplica.

   Lê tokens.css e app.css como texto e confere o que importa no
   aparelho: contraste do texto (A54), piso de 11 px (A63), alvos de
   toque (A59). Cada regra é procurada pelo seletor EXATO, no começo
   de linha; mudar o seletor sem atualizar aqui faz o teste acusar.
   ============================================================ */

import { beforeAll, describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb, relLuminance } from "../../lib/color";

let tokens: Record<string, string> = {};
let css = "";

beforeAll(async () => {
  const NODE_FS = "node:fs";
  const { readFileSync } = await import(/* @vite-ignore */ NODE_FS);
  const root: string = (globalThis as any).process.cwd();
  const t: string = readFileSync(`${root}/src/mobile/styles/tokens.css`, "utf8");
  const a: string = readFileSync(`${root}/src/mobile/styles/app.css`, "utf8");
  css = `${t}\n${a}`;
  for (const m of t.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[m[1]] ??= m[2].trim();
});

/** Corpo de TODAS as regras cujo seletor (lista inteira) é `sel`. */
function rules(src: string, sel: string): string[] {
  const out: string[] = [];
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`, "g");
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

function prop(sel: string, name: string): string | null {
  let v: string | null = null;
  for (const body of rules(css, sel)) {
    const m = new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+);`).exec(body);
    if (m) v = m[1].trim();
  }
  return v;
}

/** Resolve `var(--x)` para o hex do token. */
function hex(v: string | null): string {
  const m = /var\((--[\w-]+)\)/.exec(v ?? "");
  const raw = m ? tokens[m[1]] : v;
  if (!raw || !/^#[0-9a-f]{3,6}$/i.test(raw)) throw new Error(`cor não resolvida: ${v}`);
  return raw.length === 4 ? `#${[...raw.slice(1)].map((c) => c + c).join("")}` : raw;
}

function over(fg: string, bg: string, alpha: number): string {
  const f = hexToRgb(fg)!, b = hexToRgb(bg)!;
  const c = (x: number, y: number) => Math.round(alpha * x + (1 - alpha) * y).toString(16).padStart(2, "0");
  return `#${c(f.r, b.r)}${c(f.g, b.g)}${c(f.b, b.b)}`;
}

const ratio = (fg: string, bg: string) => contrastRatio(relLuminance(fg)!, relLuminance(bg)!);

describe("contraste do texto no S24 (A54)", () => {
  // Texto que se lê de relance, cada um com a superfície em que aparece.
  const TEXT: Array<[string, string]> = [
    [".trk .dur", "--s-c"],
    [".tab", "--s-low"],
    [".searchfield input::placeholder", "--s-c"],
    [".stile__l", "--s-c"],
    [".aitem__l", "--s-c"],
    [".stcard__tags", "--s-c"],
  ];
  for (const [sel, surface] of TEXT) {
    it(`${sel} fica em 4,5:1 ou mais sobre ${surface}`, () => {
      expect(ratio(hex(prop(sel, "color")), hex(`var(${surface})`))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("segmentado inativo em 4,5:1 sobre --s-high", () => {
    expect(ratio(hex(prop(".seg button", "color")), hex("var(--s-high)"))).toBeGreaterThanOrEqual(4.5);
  });

  it("letra inativa em 4,5:1 sobre o véu (~#050505), com a opacidade aplicada", () => {
    const veil = "#050505";
    const a = parseFloat(prop(".np .lrail p", "opacity") ?? "1");
    const fg = over(hex(prop(".np .lrail p", "color")), veil, a);
    expect(ratio(fg, veil)).toBeGreaterThanOrEqual(4.5);
  });
});

/** Valor em px, resolvendo `var(--x)` para o token. */
function px(v: string | null): number {
  const m = /var\((--[\w-]+)\)/.exec(v ?? "");
  const raw = m ? tokens[m[1]] : v;
  const n = parseFloat(raw ?? "");
  if (!Number.isFinite(n)) throw new Error(`px não resolvido: ${v}`);
  return n;
}

/** padding-top explícito ou o 1º valor do atalho `padding`. */
const padTop = (sel: string) => px(prop(sel, "padding-top") ?? (prop(sel, "padding") ?? "").split(/\s+/)[0]);

describe("alvos de toque no S24 (A59)", () => {
  it("o token do alvo mínimo é 44 px", () => {
    expect(px("var(--tap-min)")).toBe(44);
  });

  for (const sel of [".iconbtn", ".iconbtn.sm"]) {
    it(`${sel} tem 44x44`, () => {
      expect(px(prop(sel, "width"))).toBeGreaterThanOrEqual(44);
      expect(px(prop(sel, "height"))).toBeGreaterThanOrEqual(44);
    });
  }

  it("segmentado com 40 px de botão (o contêiner fecha 44)", () => {
    expect(px(prop(".seg button", "min-height"))).toBeGreaterThanOrEqual(40);
  });

  it("botão de seleção com 44 px", () => {
    expect(px(prop(".selbtn", "min-height"))).toBeGreaterThanOrEqual(44);
  });

  it("chip estende o alvo por ::after sem crescer a pílula", () => {
    expect(rules(css, ".chip::after").length).toBe(1);
    expect(prop(".chip", "position")).toBe("relative");
  });

  it("link do cabeçalho de seção e artista/álbum do Now Playing têm alvo vertical", () => {
    expect(padTop(".sec-head .sec-head-link")).toBeGreaterThanOrEqual(14);
    expect(padTop(".np .npmeta__link")).toBeGreaterThanOrEqual(12);
  });
});

describe("movimento do S24 (A60)", () => {
  it("tokens do desktop: curvas e durações", () => {
    expect(tokens["--ease-out"]).toBe("cubic-bezier(0.16, 1, 0.3, 1)");
    expect(tokens["--ease-in"]).toBe("cubic-bezier(0.4, 0, 1, 1)");
    for (const [k, v] of [["--dur-base", "0.15s"], ["--dur-med", "0.18s"], ["--dur-enter", "0.24s"],
      ["--dur-screen", "0.36s"], ["--dur-press", "0.08s"]]) expect(tokens[k], k).toBe(v);
    // a curva Material saiu
    expect(css).not.toContain("cubic-bezier(0.4, 0, 0.2, 1)");
  });

  it("Now Playing sobe em --dur-screen e desce em --dur-med com --ease-in", () => {
    expect(prop(".np", "transition")).toBe("transform var(--dur-med) var(--ease-in)");
    expect(prop(".np[data-open]", "transition-duration")).toBe("var(--dur-screen)");
    expect(prop(".np[data-open]", "transition-timing-function")).toBe("var(--ease-out)");
  });

  it("o trilho da letra desliza em --dur-screen, não em 600 ms", () => {
    expect(prop(".np .lrail", "transition")).toBe("transform var(--dur-screen) var(--ease-out)");
  });

  it("toque afunda aba, chip e cards; o transporte não anima", () => {
    expect(prop(".tab:active", "transform")).toBe("scale(0.96)");
    expect(prop(".chip:active", "transform")).toBe("scale(0.96)");
    expect(prop(".qs:active", "transform")).toBe("scale(0.985)");
    expect(css).not.toMatch(/\.fab:active|\.ctrls \.iconbtn:active/);
  });
});

describe("escala de texto e raio do S24 (A63)", () => {
  it("escala --fs-* declarada", () => {
    expect(tokens["--fs-label"]).toBe("11px");
    expect(tokens["--fs-meta"]).toBe("11.5px");
    expect(tokens["--fs-body"]).toBe("13.5px");
    expect(tokens["--fs-lead"]).toBe("17px");
    expect(tokens["--fs-stat"]).toBe("19px");
    expect(tokens["--fs-title"]).toBe("23px");
    expect(tokens["--fs-display"]).toBe("28px");
  });

  it("nenhum texto abaixo do piso de 11 px", () => {
    const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
    const shorthand = [...css.matchAll(/\bfont:\s*[^;]*?(\d+(?:\.\d+)?px)/g)].map((m) => m[1]);
    for (const v of [...sizes, ...shorthand]) {
      const n = v.startsWith("var(") ? px(v) : parseFloat(v);
      if (Number.isFinite(n)) expect(n, v).toBeGreaterThanOrEqual(11);
    }
  });

  it("raio só por token (pílula para barras finas, --r-2xl na folha)", () => {
    const lits = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const v of lits) expect(v, v).toMatch(/^(var\(--r-[\w-]+\)\s*)+(0\s*)*$|^var\(--r-[\w-]+\) var\(--r-[\w-]+\) 0 0$/);
  });

  it("regras mortas saíram", () => {
    for (const sel of [".sec-title", ".scroll", ".ico18 .icon", ".rowitem .rv"]) {
      expect(rules(css, sel), sel).toHaveLength(0);
    }
  });
});
