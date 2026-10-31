/* ============================================================
   Sidebar.test.tsx — o cartão "tocando agora" usa o indicador real
   (NowPlayingIndicator, nível medido); até 31/10/2026 era um medidor
   sorteado por setInterval a cada 220 ms (A5).

   Modo sidebar=icons (auditoria de UI 25/09, shell-22): o rótulo
   some da tela, então cada item precisa de tooltip. O nome
   acessível continua vindo do texto do rótulo (o CSS o esconde só
   visualmente).
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri")>();
  return {
    ...actual,
    slskJobs: vi.fn(async () => []),
    onSlskJobs: vi.fn(async (_cb: (jobs: import("../tauri").DownloadJob[]) => void) => () => {}),
  };
});

// O nível real vem do audio-fft (lib/levels); aqui só importa que o cartão
// assina o mesmo laço das listas, sem timer próprio.
const levelSubs = vi.hoisted(() => ({ n: 0 }));
vi.mock("../lib/levels", () => ({
  subscribeLevels: vi.fn(() => { levelSubs.n++; return () => { levelSubs.n--; }; }),
}));

import * as tauriApi from "../tauri";
import { Sidebar } from "./Sidebar";
import { setPlayer } from "../store/player";
import { bootCrateStore, __resetForTests } from "../store/crate";
import { setTweaksOpen, updateTweak } from "../store/tweaks";
import type { Track, DownloadJob } from "../tauri";

const TRACK: Track = {
  id: "t1",
  title: "Song",
  artist_name: "Artist",
  album_title: "Album",
  album_cover_path: null,
  album_year: null,
  duration_ms: 180_000,
  path: "/music/song.flac",
  lrc_path: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  __resetForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setPlayer({ currentTrack: null, isPlaying: false });
});

describe("Sidebar — indicador do cartão tocando agora (A5)", () => {
  it("é o indicador real das listas, não um medidor sorteado", () => {
    setPlayer({ currentTrack: TRACK, isPlaying: true });
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const { container } = render(() => <Sidebar />);

    const vu = container.querySelector(".np-mini .npi");
    expect(vu).toBeTruthy();
    expect(vu!.querySelectorAll("span").length).toBe(3);
    vi.advanceTimersByTime(220 * 3);
    // Nada de altura sorteada por style inline nem timer próprio.
    vu!.querySelectorAll("span").forEach((el) => expect((el as HTMLElement).style.height).toBe(""));
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(levelSubs.n).toBe(1);
  });

  it("pausado, o indicador fica parado e diz que está pausado", () => {
    setPlayer({ currentTrack: TRACK, isPlaying: false });
    const { container } = render(() => <Sidebar />);
    const vu = container.querySelector(".np-mini .npi")!;
    expect(vu.classList.contains("npi--paused")).toBe(true);
    expect(vu.getAttribute("aria-label")).toBe("Pausado");
  });
});

function job(id: string, kind: DownloadJob["state"]["kind"]): DownloadJob {
  return {
    job_id: id,
    source: { kind: "soulseek", username: "peer", remote_filename: "Artist - Title.flac", size: 1000 },
    meta: { artist: "", title: "", album: "", year: null, label: null },
    artwork_url: null,
    format_in: null,
    tracks: 1,
    display: "Artist - Title",
    dest_playlist: "Rap & Hip-Hop",
    state: { kind } as DownloadJob["state"],
    quality_label: "FLAC 16/44",
    alternates: [],
    tried_source_ids: [],
    created_at: 0,
    attempt: 1,
  };
}

describe("Sidebar — badge do Crate (jobs ativos)", () => {
  it("some quando activeCount é 0", async () => {
    const { container } = render(() => <Sidebar />);
    const crateItem = Array.from(container.querySelectorAll(".nav-item")).find((el) =>
      el.textContent?.includes("Crate"),
    )!;
    await bootCrateStore();
    expect(crateItem.querySelector(".nav-item__badge")).toBeFalsy();
  });

  it("mostra a contagem de jobs não-terminais e atualiza com o evento slsk-jobs", async () => {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(tauriApi.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    const { container } = render(() => <Sidebar />);
    await bootCrateStore();
    expect(emit).not.toBeNull();

    emit!([job("a", "downloading"), job("b", "queued"), job("c", "ready")]);

    const crateItem = Array.from(container.querySelectorAll(".nav-item")).find((el) =>
      el.textContent?.includes("Crate"),
    )!;
    expect(crateItem.querySelector(".nav-item__badge")?.textContent).toBe("2");
  });
});

// cfg-9: nada na sidebar indicava que o painel Tweaks estava aberto.
describe("Sidebar: gatilho do Tweaks", () => {
  it("expõe aria-expanded/aria-controls seguindo o estado do painel", () => {
    setTweaksOpen(false);
    const { getByText } = render(() => <Sidebar />);
    const btn = getByText("Tweaks").closest("button")!;
    expect(btn.getAttribute("aria-controls")).toBe("tweaks-panel");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    setTweaksOpen(true);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    setTweaksOpen(false);
  });

  it("mostra estado visual ativo enquanto o painel está aberto, coerente com aria-expanded", () => {
    setTweaksOpen(false);
    const { getByText } = render(() => <Sidebar />);
    const btn = getByText("Tweaks").closest("button")!;
    expect(btn.classList.contains("active")).toBe(false);
    setTweaksOpen(true);
    expect(btn.classList.contains("active")).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    setTweaksOpen(false);
    expect(btn.classList.contains("active")).toBe(false);
  });
});

describe("Sidebar — modo icons (shell-22)", () => {
  afterEach(() => updateTweak("sidebar", "labels"));

  // B23: o tooltip é o .nav-tip próprio (400 ms, com atalho), não o title
  // nativo, que demora e apareceria em dobro.
  it("no modo icons todo item de navegação tem tooltip com o rótulo", () => {
    updateTweak("sidebar", "icons");
    const { container } = render(() => <Sidebar />);
    const items = Array.from(container.querySelectorAll<HTMLElement>(".nav-item"));
    expect(items.length).toBeGreaterThan(0);
    for (const el of items) {
      const label = el.querySelector("span:not(.nav-item__kbd):not(.nav-item__badge)")?.textContent;
      expect(label).toBeTruthy();
      const tip = el.querySelector(".nav-tip");
      expect(tip?.getAttribute("aria-hidden")).toBe("true");
      expect(tip?.textContent?.startsWith(label!)).toBe(true);
      expect(el.getAttribute("title")).toBeNull();
    }
  });

  it("o tooltip mostra o atalho do item (Ctrl+K, H, L, N)", () => {
    updateTweak("sidebar", "icons");
    const { container } = render(() => <Sidebar />);
    const kbdOf = (label: string) =>
      Array.from(container.querySelectorAll<HTMLElement>(".nav-item"))
        .find((el) => el.querySelector(".nav-tip")?.textContent?.startsWith(label))
        ?.querySelector(".nav-tip__kbd")?.textContent;
    expect(kbdOf("Search")).toBe("Ctrl+K");
    expect(kbdOf("Home")).toBe("H");
    expect(kbdOf("Library")).toBe("L");
    expect(kbdOf("Now Playing")).toBe("N");
  });

  it("no modo labels o rótulo está visível e não há tooltip redundante", () => {
    updateTweak("sidebar", "labels");
    const { container } = render(() => <Sidebar />);
    const crate = Array.from(container.querySelectorAll<HTMLElement>(".nav-item"))
      .find((el) => el.textContent?.includes("Crate"))!;
    expect(crate.getAttribute("title")).toBeNull();
    expect(container.querySelector(".nav-tip")).toBeNull();
  });
});

// B8: faixa que chega com o dono fora do Crate acende um ponto até ele
// abrir o Crate. O board reidratado no boot não conta.
describe("Sidebar — chegadas do Crate (B8)", () => {
  afterEach(() => {
    window.location.hash = "";
    window.dispatchEvent(new Event("hashchange"));
  });

  async function setup(initial: DownloadJob[] = []) {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(tauriApi.slskJobs).mockResolvedValueOnce(initial);
    vi.mocked(tauriApi.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    const r = render(() => <Sidebar />);
    await bootCrateStore();
    const crate = () =>
      Array.from(r.container.querySelectorAll<HTMLElement>(".nav-item"))
        .find((el) => el.textContent?.includes("Crate"))!;
    return { emit: (j: DownloadJob[]) => emit!(j), crate };
  }

  it("faixa pronta nesta sessão acende o ponto com o texto; abrir o Crate apaga", async () => {
    const { emit, crate } = await setup();
    emit([job("a", "downloading")]);
    expect(crate().querySelector(".nav-item__new")).toBeFalsy();

    emit([job("a", "ready"), job("b", "ready")]);
    const dot = crate().querySelector(".nav-item__new")!;
    expect(dot).toBeTruthy();
    expect(dot.getAttribute("title")).toBe("2 faixas novas no acervo");

    window.location.hash = "#/crate";
    window.dispatchEvent(new Event("hashchange"));
    expect(crate().querySelector(".nav-item__new")).toBeFalsy();
  });

  it("o que já estava pronto no boot não acende", async () => {
    const { crate } = await setup([job("old", "ready")]);
    expect(crate().querySelector(".nav-item__new")).toBeFalsy();
  });

  it("com download em andamento o contador manda, sem ponto", async () => {
    const { emit, crate } = await setup();
    emit([job("a", "ready"), job("b", "downloading")]);
    expect(crate().querySelector(".nav-item__badge")?.textContent).toBe("1");
    expect(crate().querySelector(".nav-item__new")).toBeFalsy();
  });
});

describe("Sidebar — chip do now playing por teclado (ds-2)", () => {
  afterEach(() => { window.location.hash = ""; });

  it("Enter e Espaço no .np-mini abrem o Now Playing, como o clique", () => {
    vi.useRealTimers();
    setPlayer({ currentTrack: TRACK, isPlaying: false });
    const { container } = render(() => <Sidebar />);
    const chip = container.querySelector(".np-mini") as HTMLElement;
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(window.location.hash).toBe("#/now-playing");
    window.location.hash = "";
    fireEvent.keyDown(chip, { key: " " });
    expect(window.location.hash).toBe("#/now-playing");
  });
});

// ds-2 / nav: a rota ativa só aparecia pela classe .active — o leitor de
// tela não sabia em que página o usuário estava.
describe("Sidebar — rota ativa (ds-2)", () => {
  afterEach(() => {
    window.location.hash = "";
    window.dispatchEvent(new Event("hashchange"));
  });

  it("o link da rota ativa leva aria-current=page, e só ele", () => {
    window.location.hash = "#/library";
    window.dispatchEvent(new Event("hashchange"));
    const { container } = render(() => <Sidebar />);
    const current = Array.from(container.querySelectorAll("[aria-current]"));
    expect(current.map((el) => el.textContent)).toEqual(["Library"]);
    expect(current[0].getAttribute("aria-current")).toBe("page");
    expect(current[0].classList.contains("active")).toBe(true);

    window.location.hash = "#/settings";
    window.dispatchEvent(new Event("hashchange"));
    const now = Array.from(container.querySelectorAll("[aria-current]"));
    expect(now.map((el) => el.textContent)).toEqual(["Settings"]);
  });
});

// shell-13: fora do Mac o atalho é Ctrl, e a dica dizia ⌘K (o jsdom
// reporta plataforma vazia, que não é Mac).
describe("Sidebar — dica de atalho da busca (shell-13)", () => {
  it("fora do Mac mostra Ctrl+K, não ⌘K", () => {
    const { container } = render(() => <Sidebar />);
    const kbd = Array.from(container.querySelectorAll(".nav-item__kbd")).map((el) => el.textContent);
    expect(kbd).toContain("Ctrl+K");
    expect(kbd.join(" ")).not.toContain("⌘");
  });
});
