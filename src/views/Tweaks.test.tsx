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

import { Tweaks, glFpsView } from "./Tweaks";
import { tweaksOpen, setTweaksOpen, tweaks, updateTweak, resetTweaks } from "../store/tweaks";
import { QueueDrawer, QUEUE_EVENT } from "../components/QueueDrawer";
import { CommandPalette, CMD_PALETTE_EVENT } from "../components/CommandPalette";
import { TrackContextMenu } from "../components/TrackContextMenu";
import { openTrackMenu, trackMenu, closeTrackMenu } from "../store/contextMenu";
import { Fader } from "../components/dsp/Fader";
import type { Track } from "../tauri";
import { GL_BENCH_EVENT, cancelGlBench, glBenchProgress } from "../gl/bench";
import { glSceneOverride, glStatus, setGlStatus, resetGlStatus } from "../gl/meta";

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

/* Varredura de 31/10: B17 (Fundo primeiro + âncoras), B18 (Cor do fundo),
   A30 (dependências, radiogroups, Scale ao soltar), A33 (WebGL que não
   iniciou), B4 (Redefinir tudo arma e confirma). */
describe("Tweaks: organização e controles (31/10)", () => {
  afterEach(() => {
    resetTweaks();
    resetGlStatus();
  });

  it("seções na ordem Fundo, Áudio, Aparência, Controle remoto, com âncoras no topo", () => {
    render(() => <Tweaks />);
    const heads = Array.from(document.querySelectorAll(".tweaks__body .tweaks__divider")).map((h) => h.textContent);
    expect(heads).toEqual(["Fundo", "Áudio", "Aparência", "Controle remoto"]);
    const nav = screen.getByRole("navigation", { name: "Seções do Tweaks" });
    expect(Array.from(nav.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "Fundo", "Áudio", "Aparência", "Remoto",
    ]);
  });

  it("segmentados são radiogroups que dizem o ativo (inclusive a Ponte MCP)", () => {
    render(() => <Tweaks />);
    const ponte = screen.getByRole("radiogroup", { name: "Ponte MCP" });
    const off = Array.from(ponte.querySelectorAll('[role="radio"]')).find((b) => b.textContent === "Off")!;
    expect(off.getAttribute("aria-checked")).toBe("true");
  });

  it("Cor do fundo: um seletor de quatro modos; Manual mostra o seletor de cor", () => {
    render(() => <Tweaks />);
    const group = screen.getByRole("radiogroup", { name: "Cor do fundo" });
    const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(radios.map((r) => r.textContent)).toEqual(["Da capa, alterna", "Da capa, fixa", "Do tema", "Manual"]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".tweaks__color")).toBeNull();
    fireEvent.click(radios[3]);
    expect(radios[3].getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".tweaks__color")).toBeTruthy();
    fireEvent.click(radios[2]);
    expect(tweaks().adaptiveInk).toBe(false);
    expect(document.querySelector(".tweaks__color")).toBeNull();
  });

  it("filho de pai desligado diz de quem depende e não muda", () => {
    updateTweak("bgBeatMode", "off");
    render(() => <Tweaks />);
    expect(screen.getByText("Depende de Beat sync ligado")).toBeTruthy();
    const depth = screen.getByRole("slider", { name: "Beat depth" }) as HTMLInputElement;
    expect(depth.disabled).toBe(true);
    updateTweak("bgBeatMode", "speed");
    expect(screen.queryByText("Depende de Beat sync ligado")).toBeNull();
    expect(depth.disabled).toBe(false);
  });

  it("Scale só aplica ao soltar; o valor exibido acompanha o arrasto", () => {
    render(() => <Tweaks />);
    const scale = screen.getByRole("slider", { name: "Scale" }) as HTMLInputElement;
    scale.value = "1.1";
    fireEvent.input(scale);
    expect(tweaks().scale).toBe(1);
    expect(scale.getAttribute("aria-valuetext")).toBe("110%");
    fireEvent.change(scale);
    expect(tweaks().scale).toBe(1.1);
  });

  it("WebGL que não iniciou: frase de leigo, o motivo no title e Tentar de novo", () => {
    updateTweak("bgEngine", "webgl");
    render(() => <Tweaks />);
    setGlStatus({ ok: false, renderer: "", error: "shader x falhou", fps: 0 });
    const fail = document.querySelector<HTMLElement>(".tweaks__gl-fail")!;
    expect(fail.textContent).toContain("O fundo WebGL não iniciou; o 2D está no ar.");
    expect(fail.textContent).not.toContain("shader x falhou");
    expect(fail.title).toBe("shader x falhou");
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(glStatus().ok).toBeNull();
  });

  it("B19: as variantes do Relevo moram num Avançado recolhido; o valor salvo fica", () => {
    updateTweak("bgEngine", "webgl");
    updateTweak("bgScene", "relief");
    const salvo = tweaks().reliefLines;
    render(() => <Tweaks />);
    setTweaksOpen(true);
    const adv = document.querySelector<HTMLDetailsElement>("details.tweaks__advanced")!;
    expect(adv).toBeTruthy();
    expect(adv.open).toBe(false);
    expect(adv.querySelector("summary")!.textContent).toContain("Avançado");
    // Os três eixos ficam dentro do grupo, não soltos no painel.
    const linhas = screen.getByRole("radiogroup", { name: "Linhas" });
    expect(adv.contains(linhas)).toBe(true);
    expect(tweaks().reliefLines).toBe(salvo);
    resetTweaks();
  });

  it("B19: a Nébula leva a marca 'fora do critério de 60 fps' no seletor de cena", () => {
    updateTweak("bgEngine", "webgl");
    updateTweak("bgScene", "nebula");
    render(() => <Tweaks />);
    setTweaksOpen(true);
    const cena = screen.getByRole("radiogroup", { name: "Cena" });
    const neb = Array.from(cena.querySelectorAll("button")).find((b) => b.textContent!.startsWith("Nébula"))!;
    expect(neb.getAttribute("aria-label")).toContain("fora do critério de 60 fps");
    expect(neb.querySelector(".segmented__mark")).toBeTruthy();
    // Selecionada, a dica embaixo diz por extenso.
    expect(document.querySelector(".tweaks__panel, .tweaks")!.textContent).toContain("Fora do critério de 60 fps");
    const relevo = Array.from(cena.querySelectorAll("button")).find((b) => b.textContent === "Relevo")!;
    expect(relevo.querySelector(".segmented__mark")).toBeNull();
    resetTweaks();
  });

  it("fps 0 é 'medindo…' sem âmbar; abaixo de 58 é aviso", () => {
    expect(glFpsView(0)).toEqual({ text: "medindo…", low: false });
    expect(glFpsView(42)).toEqual({ text: "42 fps", low: true });
    expect(glFpsView(60)).toEqual({ text: "60 fps", low: false });
  });

  it("Redefinir tudo pede o segundo clique", () => {
    updateTweak("density", "compact");
    render(() => <Tweaks />);
    fireEvent.click(screen.getByRole("button", { name: "Redefinir tudo" }));
    expect(tweaks().density).toBe("compact");
    fireEvent.click(screen.getByRole("button", { name: "Clique de novo para redefinir tudo" }));
    expect(tweaks().density).toBe("normal");
  });
});
