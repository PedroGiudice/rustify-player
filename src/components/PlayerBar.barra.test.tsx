/* ============================================================
   PlayerBar.barra.test.tsx — segunda varredura do Impeccable (31/10)
   na barra do player.

   - A2/B16: um selo só na linha do artista. No rádio, o grau de
     familiaridade entra no próprio selo ("rádio · 1ª escuta",
     "rádio · descoberta", "rádio"); fora dele, "1ª escuta" segue à
     parte; álbum e fila solta não ganham selo.
   - A3: com as três etapas de DSP, a pílula diz "DSP 3".
   - A4: a pílula é imagem com rótulo, não botão.
   - A13: botão direito não arrasta o seek; pointercancel encerra o
     gesto sem buscar; a troca de faixa não apaga o contorno antes
     de o perfil novo chegar; a máscara usa dpr x zoom do Tweaks.
   - A14/B16: o botão de letra só existe no Now Playing e diz se a
     faixa não tem letra ou se a busca falhou.
   - A15: "Próxima" no fim da fila não se diz indisponível (ela segue
     no rádio); familiaridade ainda sem cache é perguntada de novo.
   - B35: Play sem faixa retoma a última do histórico; sem histórico,
     sorteia do acervo; acervo vazio avisa.
   ============================================================ */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../tauri", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../tauri")>();
  return {
    ...orig,
    onPlayerState: async () => () => {},
    onMprisCommand: async () => () => {},
    playerPlay: vi.fn(async () => {}),
    playerPause: vi.fn(async () => {}),
    playerResume: vi.fn(async () => {}),
    playerSeek: vi.fn(async () => {}),
    playerEnqueueNext: vi.fn(async () => {}),
    persistLoadState: vi.fn(async () => null),
    persistSaveState: vi.fn(async () => {}),
    libRecordPlay: vi.fn(async () => {}),
    libIsLiked: vi.fn(async () => false),
    libTrackFamiliarity: vi.fn(async () => null),
    libTrackProfile: vi.fn(async () => null),
    libGetLyrics: vi.fn(async () => []),
    libListHistory: vi.fn(async () => []),
    libShuffle: vi.fn(async () => []),
  };
});

vi.mock("./waveMask", () => ({ makeWaveMask: vi.fn(() => "data:image/png;base64,AA") }));

import { PlayerBar } from "./PlayerBar";
import { makeWaveMask } from "./waveMask";
import { player, setPlayer, setQueue, enqueueNext } from "../store/player";
import { resetRadioSession } from "../store/radioSession";
import { setDsp } from "../store/dsp";
import { updateTweak } from "../store/tweaks";
import {
  libTrackFamiliarity, libTrackProfile, libGetLyrics, libListHistory, libShuffle,
  playerPlay, playerSeek, playerResume,
} from "../tauri";
import type { Track } from "../tauri";

const T = (id: string, extra: Partial<Track> = {}) => ({
  id, title: `Faixa ${id}`, artist_name: "Artista", album_title: "Disco",
  album_cover_path: null, album_year: null, duration_ms: 180_000, path: `/${id}`, lrc_path: null,
  ...extra,
} as Track);

const flush = () => new Promise((r) => setTimeout(r, 0));

async function goTo(path: string) {
  window.location.hash = `#${path}`;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await flush();
}

beforeEach(async () => { await goTo("/home"); });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  setQueue([], 0);
  setPlayer({ positionSecs: 0, durationSecs: 0, isPlaying: false, isScrubbing: false });
  resetRadioSession();
});

describe("selo da linha do artista (A2, B16)", () => {
  it("descoberta nunca ouvida até o fim: um selo só, 'rádio · 1ª escuta'", async () => {
    vi.mocked(libTrackFamiliarity).mockResolvedValue({ full_listens: 0, liked: false });
    setQueue([T("d0", { autoplay_pick: { kind: "discovery", ended: 0, liked: false } })], 0, "open", { kind: "radio" });
    const { container } = render(() => <PlayerBar />);
    await flush();
    const chips = container.querySelectorAll(".pb-src");
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toBe("rádio · 1ª escuta");
    // O pick já traz o número de fins: não pergunta ao motor.
    expect(vi.mocked(libTrackFamiliarity)).not.toHaveBeenCalled();
  });

  it("descoberta ouvida 1-2 vezes: 'rádio · descoberta'; conhecida: 'rádio'", async () => {
    setQueue([T("d2", { autoplay_pick: { kind: "discovery", ended: 2, liked: false } })], 0, "open", { kind: "radio" });
    const { container } = render(() => <PlayerBar />);
    expect(container.querySelector(".pb-src")!.textContent).toBe("rádio · descoberta");
    cleanup();
    setQueue([T("k7", { autoplay_pick: { kind: "known", ended: 7, liked: false } })], 0, "open", { kind: "radio" });
    const { container: c2 } = render(() => <PlayerBar />);
    expect(c2.querySelector(".pb-src")!.textContent).toBe("rádio");
  });

  it("rádio sem pick (semente, S24) usa a familiaridade do motor no mesmo selo", async () => {
    vi.mocked(libTrackFamiliarity).mockResolvedValue({ full_listens: 0, liked: false });
    setQueue([T("seed")], 0, "open", { kind: "radio" });
    const { container } = render(() => <PlayerBar />);
    await vi.waitFor(() => {
      expect(container.querySelector(".pb-src")!.textContent).toBe("rádio · 1ª escuta");
    });
    expect(container.querySelectorAll(".pb-src").length).toBe(1);
  });

  it("fora do rádio, '1ª escuta' segue à parte do selo de origem", async () => {
    vi.mocked(libTrackFamiliarity).mockResolvedValue({ full_listens: 0, liked: false });
    setQueue([T("st")], 0, "curated", { kind: "station", name: "Neon" });
    const { container } = render(() => <PlayerBar />);
    await vi.waitFor(() => {
      expect(container.querySelector(".pb-src--first")).toBeTruthy();
    });
    const texts = [...container.querySelectorAll(".pb-src")].map((e) => e.textContent);
    expect(texts).toEqual(["station", "1ª escuta"]);
  });

  it("álbum e fila solta não ganham selo de origem", async () => {
    setQueue([T("al")], 0, "curated", { kind: "album", name: "Disco" });
    const { container } = render(() => <PlayerBar />);
    expect(container.querySelector(".pb-src")).toBeNull();
    cleanup();
    setQueue([T("so")], 0);
    const { container: c2 } = render(() => <PlayerBar />);
    expect(c2.querySelector(".pb-src")).toBeNull();
  });

  it("o artista vive num span próprio, que encolhe com reticências", () => {
    setQueue([T("ar")], 0, "curated", { kind: "playlist", name: "Rap" });
    const { container } = render(() => <PlayerBar />);
    const txt = container.querySelector(".pb-artist__text")!;
    expect(txt.textContent).toBe("Artista · Disco");
  });
});

describe("familiaridade com cache frio (A15)", () => {
  it("resposta nula é perguntada de novo em 3, 10 e 30 s", async () => {
    vi.useFakeTimers();
    vi.mocked(libTrackFamiliarity).mockResolvedValue(null);
    setQueue([T("cold")], 0, "curated", { kind: "playlist", name: "Rap" });
    const { container } = render(() => <PlayerBar />);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(libTrackFamiliarity)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.mocked(libTrackFamiliarity)).toHaveBeenCalledTimes(2);
    vi.mocked(libTrackFamiliarity).mockResolvedValue({ full_listens: 0, liked: false });
    await vi.advanceTimersByTimeAsync(7000);
    expect(vi.mocked(libTrackFamiliarity)).toHaveBeenCalledTimes(3);
    expect(container.querySelector(".pb-src--first")).toBeTruthy();
    // Já respondeu: a tentativa dos 30 s não acontece.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(libTrackFamiliarity)).toHaveBeenCalledTimes(3);
  });
});

describe("pílula técnica (A3, A4)", () => {
  it("com EQ, limitador e grave ligados, diz 'DSP 3' e a lista vai no rótulo", () => {
    setDsp("bypass", false);
    setDsp("eq", "enabled", true);
    setDsp("limiter", "enabled", true);
    setDsp("bass", "enabled", true);
    setPlayer({ techInfo: { format: "FLAC", bitDepth: 16, sampleRate: 44100, channels: 2 } });
    setQueue([T("dsp")], 0);
    const { container } = render(() => <PlayerBar />);
    const pill = container.querySelector("#pb-tech")!;
    expect(pill.textContent).toContain("DSP 3");
    expect(pill.getAttribute("aria-label")).toMatch(/EQ, limitador e reforço de grave ligados/);
    expect(pill.getAttribute("role")).toBe("img");
    setDsp("bass", "enabled", false);
    expect(pill.textContent).toContain("EQ · LIM");
  });
});

describe("seek (A13)", () => {
  function seekBar(container: HTMLElement) {
    const el = container.querySelector("#pb-progress") as HTMLElement;
    el.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 14, right: 100, bottom: 14, x: 0, y: 0, toJSON() {} });
    return el;
  }

  it("botão direito no trilho não começa a arrastar", () => {
    setQueue([T("rb")], 0);
    setPlayer({ durationSecs: 180 });
    const { container } = render(() => <PlayerBar />);
    fireEvent.pointerDown(seekBar(container), { button: 2, clientX: 50 });
    expect(player.isScrubbing).toBe(false);
    expect(player.positionSecs).toBe(0);
  });

  it("pointercancel encerra o gesto sem buscar", () => {
    setQueue([T("pc")], 0);
    setPlayer({ durationSecs: 180 });
    const { container } = render(() => <PlayerBar />);
    fireEvent.pointerDown(seekBar(container), { button: 0, clientX: 50 });
    expect(player.isScrubbing).toBe(true);
    fireEvent(window, new Event("pointercancel"));
    expect(player.isScrubbing).toBe(false);
    expect(vi.mocked(playerSeek)).not.toHaveBeenCalled();
  });

  it("perder o foco da janela também encerra o gesto", () => {
    setQueue([T("bl")], 0);
    setPlayer({ durationSecs: 180 });
    const { container } = render(() => <PlayerBar />);
    fireEvent.pointerDown(seekBar(container), { button: 0, clientX: 50 });
    fireEvent(window, new Event("blur"));
    expect(player.isScrubbing).toBe(false);
  });

  it("a troca de faixa mantém o contorno até o perfil novo chegar", async () => {
    vi.mocked(libTrackProfile).mockResolvedValueOnce([10, 200, 30]);
    setQueue([T("w1"), T("w2")], 0);
    const { container } = render(() => <PlayerBar />);
    const bar = () => container.querySelector("#pb-progress")!;
    await vi.waitFor(() => expect(bar().classList.contains("progress--wave")).toBe(true));
    let resolve!: (p: number[] | null) => void;
    vi.mocked(libTrackProfile).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    setPlayer({ currentTrack: player.queue[1], queueIndex: 1 });
    await flush();
    expect(bar().classList.contains("progress--wave")).toBe(true);
    resolve(null);
    await vi.waitFor(() => expect(bar().classList.contains("progress--wave")).toBe(false));
  });

  it("a máscara é desenhada na densidade real: dpr x zoom do Tweaks", async () => {
    updateTweak("scale", 1.15);
    vi.mocked(libTrackProfile).mockResolvedValueOnce([10, 200, 30]);
    setQueue([T("dpr")], 0);
    render(() => <PlayerBar />);
    await vi.waitFor(() => expect(vi.mocked(makeWaveMask)).toHaveBeenCalled());
    const dpr = vi.mocked(makeWaveMask).mock.calls.at(-1)![3];
    expect(dpr).toBeCloseTo((window.devicePixelRatio || 1) * 1.15);
    updateTweak("scale", 1);
  });
});

describe("botão de letra (A14, B16)", () => {
  it("fora do Now Playing não aparece", async () => {
    setQueue([T("ly")], 0);
    const { container } = render(() => <PlayerBar />);
    expect(container.querySelector("#pb-lyrics")).toBeNull();
    await goTo("/now-playing");
    expect(container.querySelector("#pb-lyrics")).toBeTruthy();
  });

  it("faixa sem letra: botão apagado, não alterna, diz por quê", async () => {
    await goTo("/now-playing");
    vi.mocked(libGetLyrics).mockResolvedValue([]);
    setQueue([T("sem")], 0);
    const { container } = render(() => <PlayerBar />);
    const btn = () => container.querySelector("#pb-lyrics")!;
    await vi.waitFor(() => expect(btn().getAttribute("aria-disabled")).toBe("true"));
    expect(btn().getAttribute("title")).toBe("Sem letra nesta faixa");
    const before = btn().getAttribute("aria-pressed");
    fireEvent.click(btn());
    expect(btn().getAttribute("aria-pressed")).toBe(before);
  });

  it("busca que falhou: clicar tenta de novo", async () => {
    await goTo("/now-playing");
    vi.mocked(libGetLyrics).mockRejectedValueOnce(new Error("qdrant"));
    setQueue([T("err")], 0);
    const { container } = render(() => <PlayerBar />);
    const btn = () => container.querySelector("#pb-lyrics")!;
    await vi.waitFor(() => expect(btn().getAttribute("title")).toMatch(/tentar de novo/));
    vi.mocked(libGetLyrics).mockResolvedValueOnce([{ t: 1, line: "oi" }]);
    fireEvent.click(btn());
    await vi.waitFor(() => expect(btn().getAttribute("aria-disabled")).toBeNull());
    expect(vi.mocked(libGetLyrics).mock.calls.filter((c) => c[0] === "err").length).toBe(2);
  });
});

describe("transporte (A15, B35)", () => {
  it("'Próxima' no fim da fila não se anuncia indisponível (segue no rádio)", () => {
    setQueue([T("end")], 0);
    const { container } = render(() => <PlayerBar />);
    expect(container.querySelector("#pb-next")!.getAttribute("aria-disabled")).not.toBe("true");
    expect(container.querySelector("#pb-prev")!.getAttribute("aria-disabled")).toBe("true");
  });

  it("Play sem faixa retoma a última do histórico, sem fingir que toca", async () => {
    const last = T("last");
    vi.mocked(libListHistory).mockResolvedValueOnce([last]);
    const { container } = render(() => <PlayerBar />);
    fireEvent.click(container.querySelector("#pb-play-pause")!);
    expect(player.isPlaying).toBe(false);
    expect(vi.mocked(playerResume)).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(vi.mocked(playerPlay)).toHaveBeenCalled());
    expect(vi.mocked(playerPlay).mock.calls[0][0]).toBe(last.path);
    expect(player.queue.map((t) => t.id)).toEqual(["last"]);
  });

  it("sem histórico, sorteia do acervo", async () => {
    vi.mocked(libShuffle).mockResolvedValueOnce([T("s1"), T("s2")]);
    const { container } = render(() => <PlayerBar />);
    fireEvent.click(container.querySelector("#pb-play-pause")!);
    await vi.waitFor(() => expect(vi.mocked(playerPlay)).toHaveBeenCalled());
    expect(vi.mocked(playerPlay).mock.calls[0][0]).toBe("/s1");
    expect(player.queue.length).toBe(2);
  });

  it("acervo vazio avisa em vez de calar", async () => {
    const { container } = render(() => <PlayerBar />);
    fireEvent.click(container.querySelector("#pb-play-pause")!);
    await vi.waitFor(() => {
      expect(container.querySelector(".pb-notice")?.textContent).toBe("Nada no acervo para tocar");
    });
    expect(vi.mocked(playerPlay)).not.toHaveBeenCalled();
  });
});

describe("enfileirar a faixa que já toca (A15)", () => {
  it("o aviso da fila diz 'já está tocando' em vez de calar", async () => {
    const cur = T("cur");
    setQueue([cur], 0);
    const { container } = render(() => <PlayerBar />);
    expect(enqueueNext(cur)).toBe(0);
    await vi.waitFor(() => {
      expect(container.querySelector(".pb-queue__ack")?.textContent).toBe("já está tocando");
    });
  });
});
