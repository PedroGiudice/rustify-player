/* ============================================================
   Queue.test.tsx — a fila abre na faixa atual (mobile-5).

   "Já tocadas" vem antes de "Tocando agora" e só cresce com a
   continuidade ligada: aberta no topo, a tela mostrava o passado e
   "A seguir" ficava abaixo da dobra.
   ============================================================ */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import type { Track } from "../types";

const q = vi.hoisted(() => {
  const mk = (id: number) =>
    ({
      id: String(id),
      title: `faixa ${id}`,
      artist_name: "Fulano",
      album_title: null,
      album_cover_path: null,
      album_year: null,
      duration_ms: 1000,
      path: `/m/${id}.opus`,
      lrc_path: null,
      track_number: null,
      genre_name: null,
      dominant_color: null,
      liked_at: null,
      like_updated_at: null,
    }) as Track;
  return { list: [1, 2, 3, 4, 5, 6].map(mk), index: 3, mk };
});

vi.mock("../ipc", () => ({ assetSrc: () => null }));

vi.mock("../store", () => ({
  current: () => q.list[q.index],
  pb: {
    get index() {
      return q.index;
    },
    trackId: null,
    positionMs: 0,
  },
  queue: () => q.list,
  queueContextId: () => null,
  queueOrigin: () => "manual",
  queueRemainingMs: () => 0,
  skipToIndex: vi.fn(),
  libReady: () => true,
  libError: () => null,
  reloadLibrary: vi.fn(),
}));

import { Queue } from "./Queue";
import { contrastRatio, hexToRgb, relLuminance } from "../../lib/color";

/** Sem layout no jsdom: cada bloco declara onde "está" na tela. */
function fakeLayout(tops: Record<string, number>) {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const key = Object.keys(tops).find((sel) => this.matches(sel));
    const top = key ? tops[key] : 0;
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} } as DOMRect;
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Queue", () => {
  it("com histórico, abre rolada até 'Tocando agora'", async () => {
    fakeLayout({ ".view": 100, ".qnow": 1300 });
    const r = render(() => (
      <div class="view">
        <Queue />
      </div>
    ));
    const view = r.container.querySelector(".view") as HTMLElement;
    await Promise.resolve();
    // 1300 - 100 = distância do bloco ao topo da .view, menos um respiro.
    expect(view.scrollTop).toBeGreaterThan(1100);
    expect(view.scrollTop).toBeLessThanOrEqual(1200);
  });

  it("sem histórico, fica no topo", async () => {
    q.index = 0;
    fakeLayout({ ".view": 100, ".qnow": 300 });
    const r = render(() => (
      <div class="view">
        <Queue />
      </div>
    ));
    await Promise.resolve();
    expect((r.container.querySelector(".view") as HTMLElement).scrollTop).toBe(0);
    q.index = 3;
  });
});

// mobile-5 (contraste): o histórico era esmaecido com opacity .62 no bloco
// inteiro; sobre o fundo real (--s-base) a linha secundária (--t3) caía
// para 2,58:1 e a duração (--t4) para 2,17:1. Mesmo critério do desktop
// nas linhas inativas da letra: esmaecido, mas no piso de 3:1.
describe("Queue — contraste do histórico (mobile-5)", () => {
  let tokens: Record<string, string> = {};
  beforeAll(async () => {
    const NODE_FS = "node:fs";
    const { readFileSync } = await import(/* @vite-ignore */ NODE_FS);
    const root: string = (globalThis as any).process.cwd();
    const css: string = readFileSync(`${root}/src/mobile/styles/tokens.css`, "utf8");
    for (const m of css.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) tokens[m[1]] ??= m[2];
  });

  /** Cor composta pelo navegador: opacity mistura em sRGB, canal a canal. */
  function over(fg: string, bg: string, alpha: number): string {
    const f = hexToRgb(fg)!, b = hexToRgb(bg)!;
    const c = (x: number, y: number) => Math.round(alpha * x + (1 - alpha) * y).toString(16).padStart(2, "0");
    return `#${c(f.r, b.r)}${c(f.g, b.g)}${c(f.b, b.b)}`;
  }

  it("esmaecido, mas texto e duração ficam em 3:1 ou mais contra o fundo", () => {
    q.index = 3;
    const r = render(() => <Queue />);
    const past = r.container.querySelector(".rowlist") as HTMLElement;
    expect(past.textContent).toContain("faixa 1");
    const alpha = parseFloat(getComputedStyle(past).opacity);
    expect(alpha).toBeLessThan(1);
    const bg = tokens["--s-base"];
    expect(bg).toBeTruthy();
    for (const role of ["--t3", "--t4"]) {
      const ratio = contrastRatio(relLuminance(over(tokens[role], bg, alpha))!, relLuminance(bg)!);
      expect(ratio, role).toBeGreaterThanOrEqual(3);
    }
  });
});

// A57: "Shuffle all" enfileira o acervo inteiro (~1,7 mil faixas); montar
// tudo de uma vez trava o WebView. As duas listas crescem por sentinela.
describe("Queue — fila grande (A57)", () => {
  it("monta só um lote de 'A seguir' e, de 'Já tocadas', as mais recentes", () => {
    const saved = { list: q.list, index: q.index };
    q.list = Array.from({ length: 1500 }, (_, i) => q.mk(i + 1));
    q.index = 300; // 300 já tocadas, a atual e 1199 a seguir
    try {
      const r = render(() => <Queue />);
      const rows = r.container.querySelectorAll(".trk").length;
      expect(rows).toBeLessThan(200);
      const text = r.container.textContent ?? "";
      // vizinhas da atual aparecem; as pontas distantes, não
      expect(text).toContain("faixa 300"); // última já tocada
      expect(text).toContain("faixa 302"); // primeira a seguir
      expect(text).not.toMatch(/faixa 1(?!\d)/); // a mais antiga fica para depois
      expect(text).not.toContain("faixa 1500");
    } finally {
      q.list = saved.list;
      q.index = saved.index;
    }
  });
});

// A64: a linha da faixa fora do aparelho usava classes do desktop que o
// chunk do S24 não carrega e saía como texto solto.
describe("Queue — faixa fora do acervo (A64)", () => {
  it("vira linha de faixa (.trk) com título e posição", () => {
    const saved = q.list;
    q.list = [q.list[0], q.list[1], q.list[2], q.list[3], null as unknown as Track, q.list[5]];
    try {
      const r = render(() => <Queue />);
      const row = [...r.container.querySelectorAll(".trk")].find((el) =>
        el.textContent?.includes("Faixa fora do acervo"),
      );
      expect(row).toBeTruthy();
      expect(row!.querySelector(".tt")).not.toBeNull();
      expect(row!.querySelector(".ts")!.textContent).toContain("posição 5");
    } finally {
      q.list = saved;
    }
  });
});
