/* ============================================================
   EmptyState.test.tsx — vazio, erro e carregando se anunciam
   diferente e o erro sempre oferece saída.
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("./Icon", () => ({
  Icon: (p: { name: string }) => <span data-icon={p.name} />,
  ICONS: { alert: "lucide:triangle-alert", albums: "lucide:disc-3" },
}));

import { EmptyState } from "./EmptyState";

afterEach(cleanup);

describe("EmptyState", () => {
  it("vazio mostra título, texto e as ações como botões", () => {
    const go = vi.fn();
    const { getByRole, getByText, container } = render(() => (
      <EmptyState tone="vazio" title="Nenhum álbum" text="Entra pelo Crate." actions={[{ label: "Abrir o Crate", onClick: go }]} />
    ));
    expect(getByText("Nenhum álbum")).toBeTruthy();
    expect(getByText("Entra pelo Crate.")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Abrir o Crate" }));
    expect(go).toHaveBeenCalledTimes(1);
    const box = container.firstElementChild as HTMLElement;
    expect(box.getAttribute("data-tone")).toBe("vazio");
    expect(box.getAttribute("role")).toBeNull();
  });

  it("erro é um alerta", () => {
    const { getByRole } = render(() => (
      <EmptyState tone="erro" title="Não consegui ler o acervo agora." actions={[{ label: "Tentar de novo", onClick: () => {} }]} />
    ));
    expect(getByRole("alert").textContent).toContain("Não consegui ler o acervo agora.");
  });

  it("carregando é um status ocupado, sem ações", () => {
    const { getByRole } = render(() => <EmptyState tone="carregando" title="Carregando o acervo…" />);
    const s = getByRole("status");
    expect(s.getAttribute("aria-busy")).toBe("true");
    expect(s.querySelector("button")).toBeNull();
  });

  it("a primeira ação marcada como primária leva a classe do botão primário", () => {
    const { getByRole } = render(() => (
      <EmptyState tone="vazio" title="x" actions={[{ label: "Tocar", onClick: () => {}, primary: true }, { label: "Outra", onClick: () => {} }]} />
    ));
    expect(getByRole("button", { name: "Tocar" }).classList.contains("pl-action-btn--primary")).toBe(true);
    expect(getByRole("button", { name: "Outra" }).classList.contains("pl-action-btn--primary")).toBe(false);
  });
});
