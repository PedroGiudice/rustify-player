/* ============================================================
   CoverArt.test.tsx — Contrato do componente de capa.
   ============================================================ */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { CoverArt } from "./CoverArt";

afterEach(() => {
  cleanup();
});

describe("CoverArt", () => {
  it("capa real carrega sob demanda (a grade de álbuns mostra o acervo inteiro)", () => {
    const { container } = render(() => <CoverArt seed="x" src="/covers/a.webp" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/covers/a.webp");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
  });
});

describe("CoverArt — capa que falha ao carregar", () => {
  it("cai no cassete (o fallback da marca), não numa caixa vazia", () => {
    const { container } = render(() => <CoverArt seed="x" src="/covers/apagada.webp" />);
    fireEvent.error(container.querySelector("img")!);
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs.length).toBe(1);
    expect(imgs[0].classList.contains("cover__cassette")).toBe(true);
  });

  it("trocar de capa depois de uma falha tenta a nova", () => {
    const [src, setSrc] = createSignal("/covers/apagada.webp");
    const { container } = render(() => <CoverArt seed="x" src={src()} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector(".cover__cassette")).toBeTruthy();

    setSrc("/covers/boa.webp");
    const img = container.querySelector("img")!;
    expect(img.classList.contains("cover__cassette")).toBe(false);
    expect(img.getAttribute("src")).toBe("/covers/boa.webp");
  });
});

describe("CoverArt — crossfade na troca de faixa", () => {
  // Relógio controlado: a troca só anima quando a anterior foi há >= 1,5 s.
  let clock = 0;
  afterEach(() => vi.restoreAllMocks());
  const setup = () => {
    clock = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const [src, setSrc] = createSignal("/covers/a.webp");
    const r = render(() => <CoverArt seed="x" src={src()} crossfade />);
    return { ...r, setSrc };
  };
  const main = (c: HTMLElement) => c.querySelector<HTMLImageElement>("img.cover__img")!;
  const under = (c: HTMLElement) => c.querySelector<HTMLImageElement>("img.cover__under");

  it("troca calma: a capa anterior fica por baixo até a nova aparecer", () => {
    const { container, setSrc } = setup();
    clock += 5_000;
    setSrc("/covers/b.webp");
    expect(under(container)?.getAttribute("src")).toBe("/covers/a.webp");
    expect(main(container).getAttribute("src")).toBe("/covers/b.webp");
    expect(main(container).dataset.swap).toBe("off");

    fireEvent.load(main(container));
    expect(main(container).dataset.swap).toBe("a");
    fireEvent.animationEnd(main(container));
    expect(under(container)).toBeNull();
  });

  it("rajada de pulos: corte seco, sem camada por baixo", () => {
    const { container, setSrc } = setup();
    clock += 5_000;
    setSrc("/covers/b.webp");
    clock += 400;
    setSrc("/covers/c.webp");
    expect(under(container)).toBeNull();
    fireEvent.load(main(container));
    expect(main(container).dataset.swap).toBe("off");
  });

  it("sem crossfade (grades): nunca cria camada por baixo", () => {
    clock = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const [src, setSrc] = createSignal("/covers/a.webp");
    const { container } = render(() => <CoverArt seed="x" src={src()} />);
    clock += 5_000;
    setSrc("/covers/b.webp");
    expect(under(container)).toBeNull();
  });

  it("capa nova que falha solta a de baixo e cai no cassete", () => {
    const { container, setSrc } = setup();
    clock += 5_000;
    setSrc("/covers/b.webp");
    fireEvent.error(main(container));
    expect(under(container)).toBeNull();
    expect(container.querySelector(".cover__cassette")).toBeTruthy();
  });
});
