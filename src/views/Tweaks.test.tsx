/* ============================================================
   Tweaks.test.tsx — o painel se comporta como overlay (cfg-9).

   Antes: só o × de 22px fechava; o Esc global do App só saía do
   cinema mode. Contrato: Esc fecha o painel aberto e o evento sai
   consumido (defaultPrevented), então o App não sai do cinema no
   mesmo toque.

   Revisão da fase 0 (25/09): a primeira correção escutava em captura
   no window com stopPropagation e roubava o Esc de quem estava POR
   CIMA do painel (⌘K, fila, menu de contexto) e do input do Fader em
   edição, que confirmava o valor no blur seguinte. O Tweaks agora é
   uma camada da pilha de lib/escLayers: fecha só quando é a camada de
   cima e ninguém tratou o Esc antes.
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@solidjs/testing-library";

vi.mock("../components/PlayerBar", () => ({
  playTrack: vi.fn(),
  playQueueUpcoming: vi.fn(),
}));
vi.mock("../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri")>();
  return {
    ...actual,
    libSearch: vi.fn(async () => ({ tracks: [], albums: [], artists: [] })),
    libIsLiked: vi.fn(async () => false),
  };
});

import { Tweaks } from "./Tweaks";
import { tweaksOpen, setTweaksOpen } from "../store/tweaks";
import { QueueDrawer, QUEUE_EVENT } from "../components/QueueDrawer";
import { CommandPalette, CMD_PALETTE_EVENT } from "../components/CommandPalette";
import { TrackContextMenu } from "../components/TrackContextMenu";
import { openTrackMenu, trackMenu, closeTrackMenu } from "../store/contextMenu";
import { Fader } from "../components/dsp/Fader";
import type { Track } from "../tauri";
import { GL_BENCH_EVENT, cancelGlBench, glBenchProgress } from "../gl/bench";
import { glSceneOverride } from "../gl/meta";

afterEach(() => {
  cleanup();
  setTweaksOpen(false);
  closeTrackMenu();
});

function esc(target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe("Tweaks: Esc", () => {
  it("fecha o painel aberto", () => {
    render(() => <Tweaks />);
    setTweaksOpen(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(tweaksOpen()).toBe(false);
  });

  it("o Esc que fecha o painel sai consumido; fechado, o Esc volta a ser do app", () => {
    render(() => <Tweaks />);
    setTweaksOpen(true);
    expect(esc().defaultPrevented).toBe(true);
    expect(esc().defaultPrevented).toBe(false);
  });

  it("o painel tem id para o aria-controls do gatilho", () => {
    render(() => <Tweaks />);
    expect(document.getElementById("tweaks-panel")).toBeTruthy();
  });
});

describe("Tweaks: overlays por cima ficam com o Esc", () => {
  it("fila aberta depois do painel fecha primeiro; o segundo Esc fecha o painel", () => {
    const { container } = render(() => (<><Tweaks /><QueueDrawer /></>));
    setTweaksOpen(true);
    window.dispatchEvent(new CustomEvent(QUEUE_EVENT, { detail: { open: true } }));
    const drawer = container.querySelector(".queue-drawer")!;

    esc();
    expect(drawer.getAttribute("data-open")).toBe("false");
    expect(tweaksOpen()).toBe(true);

    esc();
    expect(tweaksOpen()).toBe(false);
  });

  it("⌘K aberta por cima fecha e o painel continua aberto", () => {
    render(() => (<><Tweaks /><CommandPalette /></>));
    setTweaksOpen(true);
    window.dispatchEvent(new CustomEvent(CMD_PALETTE_EVENT));
    const scrim = document.querySelector(".palette-scrim")!;
    expect(scrim.getAttribute("data-open")).toBe("true");

    esc(document.querySelector(".palette__input")!);
    expect(scrim.getAttribute("data-open")).toBe("false");
    expect(tweaksOpen()).toBe(true);
  });

  it("menu de contexto aberto por cima fecha e o painel continua aberto", () => {
    render(() => (<><Tweaks /><TrackContextMenu /></>));
    setTweaksOpen(true);
    const track = { id: 1, title: "t", path: "/x.flac" } as unknown as Track;
    openTrackMenu(new MouseEvent("contextmenu", { clientX: 10, clientY: 10 }), track);
    expect(trackMenu()).not.toBeNull();

    esc();
    expect(trackMenu()).toBeNull();
    expect(tweaksOpen()).toBe(true);
  });

  it("Esc no input do Fader em edição cancela a edição e não fecha o painel", () => {
    const onChange = vi.fn();
    const { container } = render(() => (
      <>
        <Tweaks />
        <Fader bandIdx={0} freq={1000} gainDb={2} active={true} onActivate={() => {}} onChange={onChange} />
      </>
    ));
    setTweaksOpen(true);
    const val = container.querySelector<HTMLElement>(".fader__val")!;
    val.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const input = container.querySelector<HTMLInputElement>("input.fader__input")!;
    input.value = "12";

    esc(input);
    expect(container.querySelector("input.fader__input")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(tweaksOpen()).toBe(true);
  });
});

/* Medição de cenas (gl/bench.ts): o painel sai da frente enquanto mede,
   um selo mostra a cena, e o fim (ou o Esc) devolve o painel. O motor
   de verdade não monta no jsdom — aqui só o fluxo da UI importa. */
describe("Tweaks: Medir cenas", () => {
  afterEach(() => cancelGlBench());

  it("o botão fecha o painel e mostra o selo; Esc cancela, restaura e reabre", async () => {
    render(() => <Tweaks />);
    setTweaksOpen(true);
    fireEvent.click(screen.getByRole("button", { name: "Medir cenas" }));
    expect(tweaksOpen()).toBe(false);
    await vi.waitFor(() =>
      expect(document.querySelector(".gl-bench-badge")?.textContent).toMatch(/Medindo Poeira 1\/\d+/),
    );
    expect(glSceneOverride()).toBe("dust");

    esc();
    await vi.waitFor(() => expect(tweaksOpen()).toBe(true));
    expect(document.querySelector(".gl-bench-badge")).toBeNull();
    expect(glSceneOverride()).toBeNull();
  });

  it("o evento rustify:gl-bench (ponte MCP) dispara a mesma medição", async () => {
    render(() => <Tweaks />);
    window.dispatchEvent(new CustomEvent(GL_BENCH_EVENT));
    await vi.waitFor(() => expect(glBenchProgress()?.key).toBe("dust"));
    cancelGlBench();
    await vi.waitFor(() => expect(glBenchProgress()).toBeNull());
  });
});
