/* ============================================================
   layout-modes.test.ts — Modos de layout do Tweaks contra o CSS REAL.

   O jsdom aplica o extractor-lab.css injetado e computa a cascata
   (seletores de atributo, :not, especificidade), então dá para travar
   o que só existe no CSS:

   - data-density="compact" tem que REDUZIR espaço que existe no modo
     normal, nas classes que as telas usam. A versão antiga dava padding
     ao .view (que não tem nenhum), descolava os cabeçalhos full-bleed
     e mirava .track-table__*, classes que nenhum TSX renderiza.
   - data-sidebar="icons" esconde o rótulo do nav-item só visualmente:
     display:none tirava o texto da árvore de acessibilidade (link sem
     nome) e sumia com o contador de downloads do Crate.
   - A tabela de faixas alcança as células das linhas, que são netas de
     .tracks (wrapper .tracks__row com display:contents).
   ============================================================ */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { screen } from "@solidjs/testing-library";

beforeAll(async () => {
  // Leitura direta do arquivo: o vitest esvazia imports de CSS (inclusive
  // ?raw). O projeto nao tem @types/node, dai o import por string (any).
  const NODE_FS = "node:fs";
  const { readFileSync } = await import(/* @vite-ignore */ NODE_FS);
  const root: string = (globalThis as any).process.cwd();
  const style = document.createElement("style");
  style.textContent = expandVarShorthands(readFileSync(`${root}/src/styles/extractor-lab.css`, "utf8"));
  document.head.appendChild(style);
});

/* O jsdom não resolve var(): um `padding` em shorthand com var() vira "0"
   no computado, e o longhand devolve o texto cru ("var(--space-top)").
   Os espaços vêm de tokens desde o A48, então o teste (1) abre os
   shorthands de padding com var() em longhands antes de injetar o CSS e
   (2) resolve var() e calc() simples lendo as custom properties do próprio
   elemento, que o jsdom herda pela cascata (inclusive sob data-density). */
function expandVarShorthands(css: string): string {
  return css.replace(/(^|[;{\s])padding:\s*([^;}]*var\([^;}]*)(?=[;}])/g, (_m, pre: string, val: string) => {
    const parts = val.trim().match(/(?:calc\((?:[^()]|\([^()]*\))*\)|var\([^()]*\)|[^\s]+)/g) ?? [];
    const [t, r = t, b = t, l = r] = parts;
    return `${pre}padding-top: ${t}; padding-right: ${r}; padding-bottom: ${b}; padding-left: ${l}`;
  });
}
let resolveEl: Element = document.documentElement;
function resolve(v: string): string {
  let out = v;
  for (let i = 0; i < 5 && out.includes("var("); i++) {
    out = out.replace(/var\((--[\w-]+)\)/g, (_m, name: string) =>
      getComputedStyle(resolveEl).getPropertyValue(name).trim() || "0px");
  }
  return out.replace(/calc\(([^()]*)\)/g, (_m, expr: string) => {
    const terms = expr.match(/[+-]?\s*[\d.]+px/g) ?? [];
    return `${terms.reduce((a, t) => a + parseFloat(t.replace(/\s/g, "")), 0)}px`;
  });
}

afterEach(() => {
  delete document.documentElement.dataset.density;
  delete document.documentElement.dataset.sidebar;
  document.body.innerHTML = "";
});

const px = (v: string) => parseFloat(resolve(v || "0")) || 0;

function mount(html: string) {
  document.body.innerHTML = html;
}
function styleOf(sel: string) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`sem elemento ${sel}`);
  resolveEl = el;
  return getComputedStyle(el);
}
function inBoth(sel: string, read: (s: CSSStyleDeclaration) => number) {
  delete document.documentElement.dataset.density;
  const normal = read(styleOf(sel));
  document.documentElement.dataset.density = "compact";
  const compact = read(styleOf(sel));
  return { normal, compact };
}
const padY = (s: CSSStyleDeclaration) => px(s.paddingTop) + px(s.paddingBottom);
const padX = (s: CSSStyleDeclaration) => px(s.paddingLeft) + px(s.paddingRight);
// O jsdom guarda o shorthand `gap` sem expandir para row-gap.
const rowGap = (s: CSSStyleDeclaration) => px(resolve(s.getPropertyValue("gap")).split(" ")[0]);

const PAGE = `
  <article class="view">
    <header class="view__head"><div><h1>X</h1></div></header>
    <nav class="tabs"><button class="tab active">A</button></nav>
    <div class="view__body">
      <div class="section__head"><h2 class="section__title">S</h2></div>
      <div class="tracks">
        <div class="tracks__head tracks__idx">#</div>
        <div class="tracks__row" style="display: contents" role="row">
          <div class="tracks__idx">01</div>
          <div class="tracks__title"><b>T</b><small>A</small></div>
          <div class="tracks__cell">Album</div>
          <div class="tracks__cell">Genre</div>
          <div class="tracks__mono">3:00</div>
        </div>
      </div>
      <div class="row-list"><div class="row">r</div></div>
      <div class="card-grid"><div class="card"><div class="cover card__cover"></div></div></div>
    </div>
  </article>
  <div class="view__body crate-body"></div>
  <div class="coll"></div>
  <div class="sig"></div>
  <div class="set"><div class="set-panel"><div class="set-panel__head"></div><div class="set-row"></div></div></div>
  <div class="tweaks__body"></div>
`;

describe("tabela de faixas", () => {
  it("células das linhas recebem padding, separador e flex (apesar do display:contents)", () => {
    mount(PAGE);
    const idx = styleOf(".tracks__row > .tracks__idx");
    // (o separador usa border com var(), que o jsdom não expande)
    expect(px(idx.paddingTop)).toBeGreaterThan(0);
    expect(idx.display).toBe("flex");
    expect(styleOf(".tracks__row > .tracks__mono").display).toBe("flex");
    // título e texto seguem block: b/small empilhados e ellipsis funcionando
    expect(styleOf(".tracks__row > .tracks__title").display).toBe("block");
    expect(styleOf(".tracks__row > .tracks__cell").display).toBe("block");
  });
});

describe('data-density="compact"', () => {
  it("não dá padding ao .view (ele não tem nenhum no normal)", () => {
    mount(PAGE);
    const { normal, compact } = inBoth(".view", (s) => padY(s) + padX(s));
    expect(normal).toBe(0);
    expect(compact).toBe(0);
  });

  const SHRINK: Array<[string, string, (s: CSSStyleDeclaration) => number]> = [
    [".view__head", "padding vertical", padY],
    [".view__head", "padding lateral", padX],
    [".view > .view__body", "padding vertical", padY],
    [".view > .view__body", "padding lateral", padX],
    [".view > .view__body", "gap", rowGap],
    [".tabs", "padding lateral", padX],
    [".tracks__head", "padding (cabeçalho da tabela)", padY],
    [".tracks__row > .tracks__title", "padding (célula de linha)", padY],
    [".row", "padding", padY],
    [".card-grid", "gap", rowGap],
    [".section__head", "margem", (s) => px(s.marginBottom)],
    [".coll", "padding", padY],
    [".sig", "padding", padY],
    [".set", "padding", padY],
    [".set-row", "padding", padY],
    [".set-panel__head", "padding", padY],
    [".tweaks__body", "gap", rowGap],
  ];
  for (const [sel, what, read] of SHRINK) {
    it(`reduz ${what} de ${sel}`, () => {
      mount(PAGE);
      const { normal, compact } = inBoth(sel, read);
      expect(normal).toBeGreaterThan(0);
      expect(compact).toBeLessThan(normal);
    });
  }

  it("não mexe no corpo do Crate (que desenha o próprio espaçamento)", () => {
    mount(PAGE);
    const { normal, compact } = inBoth(".crate-body", (s) => padY(s) + padX(s));
    expect(normal).toBe(0);
    expect(compact).toBe(0);
  });
});

describe("espaço por papel (A48)", () => {
  const CRATE = `
    <article class="view">
      <header class="view__head"><h1>Crate</h1></header>
      <nav class="tabs"><button class="tab active">Buscar</button></nav>
      <div class="view__body crate-body">
        <div class="crate-toolbar"></div>
        <div class="crate-list"></div>
        <div class="crate-tidal"></div>
      </div>
    </article>`;

  for (const sel of [".crate-toolbar", ".crate-list", ".crate-tidal"]) {
    it(`o Crate encolhe o gutter no compacto (${sel})`, () => {
      mount(CRATE);
      const { normal, compact } = inBoth(sel, (s) => px(s.paddingLeft));
      expect(normal).toBe(40);
      expect(compact).toBe(24);
    });
  }

  it("o texto da primeira aba cai no gutter da vista, nas duas densidades", () => {
    mount(CRATE);
    for (const dens of [undefined, "compact"]) {
      if (dens) document.documentElement.dataset.density = dens;
      else delete document.documentElement.dataset.density;
      const edge = px(styleOf(".tabs").paddingLeft) + px(styleOf(".tab").paddingLeft);
      expect(edge).toBe(px(styleOf(".view__head").paddingLeft));
    }
  });

  it("o bloco compacto não reescreve o padding dos containers: troca os tokens", () => {
    const css = document.head.querySelector("style")!.textContent ?? "";
    const offenders = css
      .split("}")
      .filter((r) => /html\[data-density="compact"\][^{]*\.(view__head|view__body|tabs|coll|sig|set)\s*\{/.test(r))
      .filter((r) => /padding(-top|-right|-bottom|-left)?\s*:|gap\s*:\s*\d/.test(r.split("{")[1] ?? ""))
      .filter((r) => !/\.view__head\s*\{\s*gap: 20px/.test(r));
    expect(offenders).toEqual([]);
  });
});

describe('data-sidebar="icons"', () => {
  const NAV = `
    <nav>
      <a class="nav-item" href="#/"><iconify-icon></iconify-icon><span>Home</span><span class="nav-item__kbd">⌘1</span></a>
      <a class="nav-item" href="#/crate"><iconify-icon></iconify-icon><span>Crate</span><span class="nav-item__badge">3</span></a>
    </nav>`;

  it("o link mantém o nome acessível com o rótulo escondido", () => {
    mount(NAV);
    document.documentElement.dataset.sidebar = "icons";
    expect(screen.getByRole("link", { name: /^Home/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Crate/ })).toBeTruthy();
    // rótulo fora do fluxo visual (a sidebar tem 56px)
    const label = document.querySelector('a[href="#/"] > span:not([class])')!;
    expect(getComputedStyle(label).position).toBe("absolute");
  });

  it("o contador de downloads do Crate continua visível", () => {
    mount(NAV);
    document.documentElement.dataset.sidebar = "icons";
    expect(styleOf(".nav-item__badge").display).not.toBe("none");
    expect(styleOf(".nav-item__kbd").display).toBe("none");
  });
});

describe("barra do player na densidade compacta (A41)", () => {
  const BAR = `<footer class="playerbar"><div class="playerbar__grid">
    <div class="pb-center"><div class="pb-transport"><button class="pb-btn pb-btn--primary"></button></div></div>
  </div></footer>`;

  it("o centro perde folga vertical: padding 2 px e gap 4 px", () => {
    mount(BAR);
    const { normal, compact } = inBoth(".pb-center", (s) => padY(s));
    expect(normal).toBe(16);
    expect(compact).toBe(4);
    expect(rowGap(styleOf(".pb-center"))).toBe(4);
  });

  it("o play encolhe para 32 px (cabe com o seek nos 60 px da barra)", () => {
    mount(BAR);
    const { normal, compact } = inBoth(".pb-btn--primary", (s) => px(s.width));
    expect(normal).toBe(36);
    expect(compact).toBe(32);
  });
});

// O jsdom não avalia @container: trava-se o texto das regras (B23).
describe("reflow por largura da barra e do Crate (B23)", () => {
  let css = "";
  beforeAll(() => { css = document.head.querySelector("style")!.textContent ?? ""; });
  const block = (head: string) => {
    const i = css.indexOf(head);
    if (i < 0) return "";
    return css.slice(i, css.indexOf("\n}\n", i));
  };

  it("a barra e o lado esquerdo são containers de largura", () => {
    expect(css).toMatch(/\.playerbar\s*\{[^}]*container:\s*pb\s*\/\s*inline-size/);
    expect(css).toMatch(/\.pb-left\s*\{[^}]*container:\s*pbl\s*\/\s*inline-size/);
  });

  it("abaixo de 1.500 px some o medidor; de 1.300, o resumo do DSP; de 1.100, o volume vai a 72 px", () => {
    expect(block("@container pb (max-width: 1499.98px)")).toMatch(/\.pb-meter\s*\{\s*display:\s*none/);
    expect(block("@container pb (max-width: 1299.98px)")).toMatch(/\.pb-tech__dsp[^{]*\{\s*display:\s*none/);
    expect(block("@container pb (max-width: 1099.98px)")).toMatch(/\.pb-vol\s*\{\s*min-width:\s*72px/);
  });

  it("o lado esquerdo corta o selo antes do artista", () => {
    expect(block("@container pbl (max-width: 339.98px)")).toMatch(/\.pb-src__rest\s*\{\s*display:\s*none/);
    expect(block("@container pbl (max-width: 259.98px)")).toMatch(/\.pb-src\s*\{\s*display:\s*none/);
  });

  it("colunas do Crate cedem: título e destino com minmax, sem rolagem lateral", () => {
    mount(`<div class="crate-row"></div>`);
    const cols = styleOf(".crate-row").gridTemplateColumns;
    expect(cols).toContain("minmax(160px, 1fr)");
    expect(cols).toContain("minmax(120px, 186px)");
    expect(css).toMatch(/\.crate-body\s*\{[^}]*container:\s*crate\s*\/\s*inline-size/);
    expect(block("@container crate (max-width: 1049.98px)")).toMatch(/\.crate-r-dur\s*\{\s*display:\s*none/);
    expect(block("@container crate (max-width: 759.98px)")).toMatch(/\.crate-r-main\s*\{\s*grid-column:\s*1\s*\/\s*-1/);
  });
});
