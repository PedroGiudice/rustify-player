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
  style.textContent = readFileSync(`${root}/src/styles/extractor-lab.css`, "utf8");
  document.head.appendChild(style);
});

afterEach(() => {
  delete document.documentElement.dataset.density;
  delete document.documentElement.dataset.sidebar;
  document.body.innerHTML = "";
});

const px = (v: string) => parseFloat(v || "0") || 0;

function mount(html: string) {
  document.body.innerHTML = html;
}
function styleOf(sel: string) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`sem elemento ${sel}`);
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
const rowGap = (s: CSSStyleDeclaration) => px(s.getPropertyValue("gap").split(" ")[0]);

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
