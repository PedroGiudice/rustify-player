/* Aviso transitório com Desfazer (B4 da varredura de 31/10). */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { Toast } from "./Toast";
import { dismissToast, showToast, toast } from "../store/toast";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { dismissToast(); cleanup(); vi.useRealTimers(); });

describe("Toast", () => {
  it("mostra a mensagem e some sozinho depois do prazo", () => {
    const { container } = render(() => <Toast />);
    showToast({ message: "Fila limpa" });
    expect(container.textContent).toContain("Fila limpa");
    vi.advanceTimersByTime(5999);
    expect(toast()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(toast()).toBeNull();
    expect(container.querySelector(".toast")).toBeNull();
  });

  it("Desfazer roda a ação uma vez e fecha o aviso", () => {
    const run = vi.fn();
    const { getByText } = render(() => <Toast />);
    showToast({ message: "Tirou X", action: { label: "Desfazer", run } });
    fireEvent.click(getByText("Desfazer"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(toast()).toBeNull();
  });

  it("ponteiro em cima segura o prazo; ao sair, segue", () => {
    const { container } = render(() => <Toast />);
    showToast({ message: "Fila limpa" });
    vi.advanceTimersByTime(4000);
    fireEvent.pointerEnter(container.querySelector(".toast")!);
    vi.advanceTimersByTime(20_000);
    expect(toast()).not.toBeNull();
    fireEvent.pointerLeave(container.querySelector(".toast")!);
    vi.advanceTimersByTime(2000);
    expect(toast()).toBeNull();
  });

  it("aviso novo substitui o anterior e o prazo do velho não derruba o novo", () => {
    render(() => <Toast />);
    showToast({ message: "um", duration: 1000 });
    vi.advanceTimersByTime(900);
    showToast({ message: "dois" });
    vi.advanceTimersByTime(200);
    expect(toast()?.message).toBe("dois");
  });

  it("Ctrl+Z aciona o Desfazer (a gaveta modal prende o Tab longe do botão)", () => {
    const run = vi.fn();
    render(() => <Toast />);
    showToast({ message: "Fila limpa", action: { label: "Desfazer", run } });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true }));
    expect(run).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a região viva existe antes do primeiro aviso (o leitor de tela anuncia)", () => {
    const { container } = render(() => <Toast />);
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  });
});
