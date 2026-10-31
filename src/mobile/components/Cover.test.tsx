/* ============================================================
   Cover.test.tsx — a falha de UMA capa não pode valer para a
   próxima (mobile-6).

   No mini player e no NP o Cover vive dentro de um <Show> não
   keyed: a instância sobrevive à troca de faixa e só o `path`
   muda. O "falhou" ficava grudado e todas as capas seguintes
   apareciam como placeholder.
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

vi.mock("../ipc", () => ({
  assetSrc: (p: string | null | undefined) => (p ? `asset://${p}` : null),
}));

import { Cover } from "./Cover";

afterEach(cleanup);

describe("Cover", () => {
  it("capa que falhou vira placeholder, e a da faixa seguinte volta a carregar", () => {
    const [path, setPath] = createSignal<string | null>("/covers/a.jpg");
    const r = render(() => <Cover path={path()} seed="x" />);
    const img = r.container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("asset:///covers/a.jpg");

    fireEvent.error(img);
    expect(r.container.querySelector("img")).toBeNull();

    setPath("/covers/b.jpg");
    const next = r.container.querySelector("img");
    expect(next).not.toBeNull();
    expect(next!.getAttribute("src")).toBe("asset:///covers/b.jpg");
  });

  it("a mesma capa que falhou não é re-tentada em loop", () => {
    const [path] = createSignal<string | null>("/covers/a.jpg");
    const r = render(() => <Cover path={path()} seed="x" />);
    fireEvent.error(r.container.querySelector("img")!);
    expect(r.container.querySelector("img")).toBeNull();
  });
});

// A61: a capa aparece por opacidade quando carrega; na troca de faixa a
// nova não estala por cima da anterior.
describe("Cover — entrada da capa (A61)", () => {
  it("só marca carregada depois do load, e a troca de capa zera a marca", () => {
    const [path, setPath] = createSignal<string | null>("/covers/a.jpg");
    const r = render(() => <Cover path={path()} seed="x" />);
    const img = r.container.querySelector("img")!;
    expect(img.hasAttribute("data-loaded")).toBe(false);
    fireEvent.load(img);
    expect(img.hasAttribute("data-loaded")).toBe(true);
    setPath("/covers/b.jpg");
    expect(r.container.querySelector("img")!.hasAttribute("data-loaded")).toBe(false);
  });
});
