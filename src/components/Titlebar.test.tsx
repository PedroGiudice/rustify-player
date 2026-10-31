/* ============================================================
   Titlebar.test.tsx — semáforo neutro em repouso (B26).

   Os três pontos de croma pleno ficavam sempre à vista, fixos por
   style inline. Contrato: nenhum ponto leva cor inline (a cor vem do
   CSS, que só a acende com o ponteiro ou o foco no grupo) e cada um
   tem a classe do seu papel e o nome acessível da ação.
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

vi.mock("../js/components/resources.js", () => ({
  mountResources: vi.fn(),
  toggleResources: vi.fn(),
}));

import { Titlebar } from "./Titlebar";

afterEach(() => cleanup());

describe("Titlebar: semáforo", () => {
  it("os pontos não carregam cor inline e têm a classe do papel", () => {
    const { container } = render(() => <Titlebar />);
    const dots = Array.from(container.querySelectorAll<HTMLButtonElement>(".tl-dot"));
    expect(dots.map((d) => d.getAttribute("aria-label"))).toEqual(["Fechar", "Minimizar", "Maximizar"]);
    for (const d of dots) expect(d.style.background).toBe("");
    expect(dots[0].classList.contains("tl-dot--close")).toBe(true);
    expect(dots[1].classList.contains("tl-dot--min")).toBe(true);
    expect(dots[2].classList.contains("tl-dot--max")).toBe(true);
  });
});
