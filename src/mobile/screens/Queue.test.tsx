/* ============================================================
   Queue.test.tsx — a fila abre na faixa atual (mobile-5).

   "Já tocadas" vem antes de "Tocando agora" e só cresce com a
   continuidade ligada: aberta no topo, a tela mostrava o passado e
   "A seguir" ficava abaixo da dobra.
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
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
  return { list: [1, 2, 3, 4, 5, 6].map(mk), index: 3 };
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
