/* ============================================================
   FolderPicker.test.tsx — o seletor de pasta único do Crate (B7):
   filtra como o Mover, cria pasta só com o nome limpo, fecha com
   clique fora e Esc devolvendo o foco ao chip.
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { FolderPicker, mergeFolders } from "./FolderPicker";

afterEach(() => cleanup());

function setup(folders = ["Jazz", "Funk Brasileiro", "Rap & Hip-Hop"]) {
  const onPick = vi.fn();
  const [open, setOpen] = createSignal(false);
  render(() => (
    <FolderPicker
      variant="toolbar"
      value={null}
      placeholder="destino padrão"
      folders={folders}
      open={open()}
      onToggle={() => setOpen((o) => !o)}
      onClose={() => setOpen(false)}
      onPick={(f) => { onPick(f); setOpen(false); }}
    />
  ));
  const chip = () => document.querySelector<HTMLButtonElement>(".crate-dest__btn")!;
  const filter = () => document.querySelector<HTMLInputElement>(".crate-dest__filter");
  return { onPick, chip, filter, open };
}

describe("FolderPicker", () => {
  it("filtra a lista e o Enter escolhe a primeira", () => {
    const { onPick, chip, filter } = setup();
    fireEvent.click(chip());
    fireEvent.input(filter()!, { target: { value: "fun" } });
    expect(Array.from(document.querySelectorAll(".crate-dest__opt")).map((b) => b.textContent)).toEqual(["Funk Brasileiro", "Nova pasta “fun”"]);
    fireEvent.keyDown(filter()!, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("Funk Brasileiro");
  });

  it("pasta nova aparece com o nome já limpo e só com clique ou Enter explícito", () => {
    const { onPick, chip, filter } = setup();
    fireEvent.click(chip());
    fireEvent.input(filter()!, { target: { value: "Trap: BR" } });
    const nova = screen.getByRole("option", { name: /Nova pasta “Trap_ BR”/ });
    fireEvent.click(nova);
    expect(onPick).toHaveBeenCalledWith("Trap_ BR");
  });

  it("nome que só difere na caixa de uma pasta existente não vira pasta nova", () => {
    const { chip, filter } = setup();
    fireEvent.click(chip());
    fireEvent.input(filter()!, { target: { value: "jazz" } });
    expect(screen.queryByRole("option", { name: /Nova pasta/ })).toBeNull();
    expect(screen.getByRole("option", { name: "Jazz" })).toBeTruthy();
  });

  it("Esc fecha e devolve o foco ao chip; clique fora fecha", async () => {
    const { chip, filter } = setup();
    fireEvent.click(chip());
    await Promise.resolve();
    filter()!.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(filter()).toBeNull();
    expect(document.activeElement).toBe(chip());
    fireEvent.click(chip());
    expect(filter()).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(filter()).toBeNull();
  });
});

describe("mergeFolders", () => {
  it("junta as pastas locais e as da VM sem repetir, em ordem alfabética", () => {
    expect(mergeFolders(["Jazz", "Rap"], ["Rap", "Funk"])).toEqual(["Funk", "Jazz", "Rap"]);
  });
});
