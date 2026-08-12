/* ============================================================
   Stations.test.tsx — Testes da view de stations.
   Cobre: feature card (.st-feature) com eyebrow, titulo grande,
   chips de seeds, CTA preto; canvas <StationViz />; grid de 6
   st-cards com card #1 carregando badge .st-card__live.

   Utiliza mock do window.__TAURI__ para simular o backend Rust
   sem precisar do runtime Tauri.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import type { Station } from "../tauri";

// Mocks module-level: tauri.ts captura window.__TAURI__.core.invoke no LOAD
// (test-setup stub, sempre undefined) — substituir invoke em runtime NAO
// funciona. Mockamos os wrappers usados pela view; o resto segue real.
vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn() }));
vi.mock("../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri")>();
  return {
    ...actual,
    libListStations: vi.fn(async () => []),
    libPlayStation: vi.fn(async () => []),
    libCreateStation: vi.fn(async () => null),
    libDeleteStation: vi.fn(async () => true),
    libMoodVocabulary: vi.fn(async () => ({
      moods: ["dark", "uplifting", "chill"],
      activities: ["workout", "study"],
      genres: ["Rap & Hip-Hop", "Rock", "Funk & Soul"],
    })),
  };
});
import * as tauriApi from "../tauri";
import { playTrack } from "../components/PlayerBar";

// ── 6 stations de exemplo (simula resposta do backend) ──────────
const MOCK_STATIONS: Station[] = [
  {
    id: "midnight-1",
    name: "Midnight station",
    icon: "lucide:target",
    tone: "tone-lavender",
    desc: "ambient · drone · sleepless",
    kind: "seed",
    seed_track_ids: ["1", "2", "3"],
    query: null,
    stats: { played: 312, last_played_at: null, match_avg: 0.97 },
  },
  {
    id: "sunday-slow-2",
    name: "Sunday slow",
    icon: "lucide:rainbow",
    tone: "tone-bone",
    desc: "modern classical · acoustic · low tempo",
    kind: "seed",
    seed_track_ids: ["4", "5", "6", "7"],
    query: null,
    stats: { played: 184, last_played_at: null, match_avg: 0.91 },
  },
  {
    id: "bridge-cable-3",
    name: "Bridge cable",
    icon: "ph:dots-nine",
    tone: "tone-paper",
    desc: "field recording · industrial · long form",
    kind: "seed",
    seed_track_ids: ["8", "9"],
    query: null,
    stats: { played: 54, last_played_at: null, match_avg: 0.88 },
  },
  {
    id: "solstice-4",
    name: "Solstice",
    icon: "lucide:mountain",
    tone: "tone-sky",
    desc: "winter strings · cold piano · church reverb",
    kind: "seed",
    seed_track_ids: ["10", "11", "12", "13", "14"],
    query: null,
    stats: { played: 96, last_played_at: null, match_avg: 0.93 },
  },
  {
    id: "pylon-5",
    name: "Pylon",
    icon: "lucide:audio-lines",
    tone: "tone-peach",
    desc: "minimal electronic · krautrock-adjacent",
    kind: "mood",
    seed_track_ids: [],
    query: "minimal electronic",
    stats: { played: 28, last_played_at: null, match_avg: 0.85 },
  },
  {
    id: "halocline-6",
    name: "Halocline",
    icon: "lucide:atom",
    tone: "tone-rose",
    desc: "deep ambient · brackish · slow drone",
    kind: "seed",
    seed_track_ids: ["15", "16", "17"],
    query: null,
    stats: { played: 72, last_played_at: null, match_avg: 0.90 },
  },
];

// ── Setup do ambiente JSDOM ──────────────────────────────────────
beforeEach(() => {
  // Mock do runtime Tauri (invoke via window.__TAURI__.core)
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd: string) => {
        if (cmd === "lib_list_stations") return MOCK_STATIONS;
        if (cmd === "lib_play_station") return [];
        if (cmd === "lib_create_station") return MOCK_STATIONS[0];
        return null;
      }),
      convertFileSrc: (p: string) => p,
    },
    event: {
      listen: vi.fn(async () => () => {}),
    },
  };

  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), bezierCurveTo: vi.fn(),
    closePath: vi.fn(), stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(),
    fillRect: vi.fn(),
    strokeStyle: "", fillStyle: "", lineWidth: 0, lineJoin: "", lineCap: "",
  })) as any;
  HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (globalThis as any).IntersectionObserver = class {
    constructor(_cb: any) {}
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  (globalThis as any).requestAnimationFrame = vi.fn(() => 1);
  (globalThis as any).cancelAnimationFrame = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import Stations, { SeedChips, StationCard } from "./Stations";
import { createSignal } from "solid-js";
import { fireEvent, waitFor } from "@solidjs/testing-library";
import { player, setQueue } from "../store/player";

describe("Stations view", () => {
  it("apagar station chama o backend e recarrega a lista", async () => {
    // Restaura o default da factory mesmo se o teste falhar no meio:
    // clearAllMocks limpa histórico, não implementação, e um mock vazado faz
    // o teste de empty-state deste mesmo describe quebrar.
    onTestFinished(() => {
      vi.mocked(tauriApi.libListStations).mockImplementation(async () => []);
    });
    vi.mocked(tauriApi.libListStations).mockImplementation(async () => MOCK_STATIONS);
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      expect(container.querySelectorAll(".st-card__delete").length).toBeGreaterThan(0);
    });
    const chamadasAntes = vi.mocked(tauriApi.libListStations).mock.calls.length;
    const btn = container.querySelector(".st-card__delete") as HTMLButtonElement;
    fireEvent.click(btn); // arma
    fireEvent.click(btn); // confirma
    await waitFor(() => {
      expect(vi.mocked(tauriApi.libDeleteStation)).toHaveBeenCalledWith("midnight-1");
    });
    // refetch apos apagar (a lista nao pode ficar com a station morta)
    await waitFor(() => {
      expect(vi.mocked(tauriApi.libListStations).mock.calls.length).toBeGreaterThan(chamadasAntes);
    });
  });

  it("renderiza heading + stats", async () => {
    const { getByText, container } = render(() => <Stations />);
    expect(getByText("Stations")).toBeTruthy();
    expect(container.querySelector(".view__stats")).toBeTruthy();
  });

  it("renderiza feature card com eyebrow, titulo grande, seeds chips", async () => {
    // Nota: o stub global de __TAURI__ (test-setup.ts) captura invoke no load
    // do tauri.ts e retorna undefined, entao libListStations resolve vazio e a
    // view renderiza o empty-state (.st-feature fallback). Este teste valida a
    // estrutura compartilhada do feature card (eyebrow, titulo, seed-chips).
    // O botao "Resume station" disabled foi REMOVIDO no Tier 0 — nao se asserta.
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      const feature = container.querySelector(".st-feature");
      expect(feature).toBeTruthy();
    });
    const feature = container.querySelector(".st-feature");
    expect(feature!.querySelector(".st-feature__eyebrow")).toBeTruthy();
    expect(feature!.querySelector(".st-feature__title")).toBeTruthy();
    const seeds = feature!.querySelectorAll(".st-seed-chip");
    expect(seeds.length).toBeGreaterThanOrEqual(1);
  });

  it("feature card contem canvas (StationViz wrapper visual)", async () => {
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      const visual = container.querySelector(".st-feature__visual");
      expect(visual).toBeTruthy();
    });
    const visual = container.querySelector(".st-feature__visual");
    expect(visual!.querySelector("canvas")).toBeTruthy();
  });

  it("renderiza grid com 6 st-cards quando backend retorna 6 stations", async () => {
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      const cards = container.querySelectorAll(".st-card");
      expect(cards.length).toBe(6);
    });
    const grid = container.querySelector(".st-grid");
    expect(grid).toBeTruthy();
    const cards = grid!.querySelectorAll(".st-card");
    expect(cards.length).toBe(6);
  });

  it("primeiro card tem badge Live verde no canto", async () => {
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      const cards = container.querySelectorAll(".st-card");
      expect(cards.length).toBeGreaterThan(0);
    });
    const cards = container.querySelectorAll(".st-card");
    const liveBadge = cards[0].querySelector(".st-card__live");
    expect(liveBadge).toBeTruthy();
    expect(liveBadge!.textContent).toContain("Live");
  });

  it("cards subsequentes nao tem badge Live", async () => {
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      const cards = container.querySelectorAll(".st-card");
      expect(cards.length).toBe(6);
    });
    const cards = container.querySelectorAll(".st-card");
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i].querySelector(".st-card__live")).toBeFalsy();
    }
  });

  it("estado loading mostra fallback antes do backend responder", () => {
    // Invoke com delay para capturar o estado de loading
    (globalThis as any).window.__TAURI__.core.invoke = vi.fn(
      () => new Promise((res) => setTimeout(() => res([]), 200)),
    );
    const { container } = render(() => <Stations />);
    // Durante o loading, o fallback exibe 6 cards placeholder
    const cards = container.querySelectorAll(".st-card");
    expect(cards.length).toBe(6);
  });

  it("0.5 empty-state nao tem o botao disabled Resume station", async () => {
    // Simula backend sem stations (empty-state)
    (globalThis as any).window.__TAURI__.core.invoke = vi.fn(async (cmd: string) => {
      if (cmd === "lib_list_stations") return [];
      return null;
    });
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      // O feature card fallback (empty-state) deve estar visivel
      expect(container.querySelector(".st-feature")).toBeTruthy();
    });
    // Botao "Resume station" (era disabled, agora removido) NAO deve existir
    const allBtns = Array.from(container.querySelectorAll("button"));
    const resumeBtn = allBtns.find((b) => (b.textContent ?? "").includes("Resume station"));
    expect(resumeBtn).toBeUndefined();
    // O texto explicativo do empty-state continua presente
    expect((container.querySelector(".st-feature")?.textContent ?? "")).toContain("Stations aparecem aqui");
  });

  it("moldura .st-feature__visual nao aparece aninhada (dedup do StationViz)", async () => {
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      expect(container.querySelector(".st-feature__visual")).toBeTruthy();
    });
    // Antes o StationViz renderizava um segundo div com a mesma classe
    // dentro do wrapper do LazyStationViz — borda/bg/radius duplicados.
    expect(container.querySelectorAll(".st-feature__visual .st-feature__visual").length).toBe(0);
    expect(container.querySelector(".st-feature__visual canvas")).toBeTruthy();
  });
});

// ── Tracks retornadas pelo lib_play_station (mock) ───────────────
// IDs como STRING: track IDs sao u64 > 2^53 e viajam como string no wire.
const STATION_TRACKS = [
  { id: "3940784406639047387", title: "Alpha", path: "/m/a.flac", duration_ms: 180000, artist_name: null, album_title: null, album_cover_path: null, album_year: null },
  { id: "1655525807613953999", title: "Beta", path: "/m/b.flac", duration_ms: 200000, artist_name: null, album_title: null, album_cover_path: null, album_year: null },
] as any[];

describe("Resume station inicia playback (fix: tracks eram descartadas)", () => {
  afterEach(() => {
    // restaura defaults da factory (clearAllMocks nao remove mockResolvedValue)
    vi.mocked(tauriApi.libListStations).mockImplementation(async () => []);
    vi.mocked(tauriApi.libPlayStation).mockImplementation(async () => []);
  });

  it("coloca as tracks retornadas na fila com scope curated e toca a primeira", async () => {
    vi.mocked(tauriApi.libListStations).mockImplementation(async () => MOCK_STATIONS);
    vi.mocked(tauriApi.libPlayStation).mockImplementation(async () => STATION_TRACKS as any);
    setQueue([], 0); // reset do singleton entre testes
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      expect(container.querySelector(".st-feature__cta")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".st-feature__cta")!);
    await waitFor(() => {
      expect(player.queue.length).toBe(2);
    });
    expect(player.queueScope).toBe("curated");
    // Fase 0 do session-awareness: a fila de station carrega o contexto —
    // continuações logam origin="station" (régua + behavioral_signals).
    expect(player.queueSource?.kind).toBe("station");
    expect(player.currentTrack?.id).toBe("3940784406639047387");
    // Fase 2 do session-awareness: playTrack recebe o contextId da rodada
    // (startRadioSession, formato "station:<id>:<timestamp>") como 3º arg.
    expect(vi.mocked(playTrack)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "3940784406639047387" }),
      "station",
      expect.stringMatching(/^station:midnight-1:\d+$/),
    );
  });

  it("station vazia (0 tracks) nao mexe na fila nem toca", async () => {
    vi.mocked(tauriApi.libListStations).mockImplementation(async () => MOCK_STATIONS);
    vi.mocked(tauriApi.libPlayStation).mockImplementation(async () => []);
    setQueue([], 0);
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      expect(container.querySelector(".st-feature__cta")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".st-feature__cta")!);
    await waitFor(() => {
      expect(vi.mocked(tauriApi.libPlayStation)).toHaveBeenCalled();
    });
    expect(player.queue.length).toBe(0);
    expect(player.currentTrack).toBeNull();
    expect(vi.mocked(playTrack)).not.toHaveBeenCalled();
  });
});

describe("New from current track usa a track atual como seed (fix: stub)", () => {
  afterEach(() => {
    vi.mocked(tauriApi.libListStations).mockImplementation(async () => []);
  });

  it("cria station kind seed com seedTrackIds = [id da track atual] como string", async () => {
    vi.mocked(tauriApi.libListStations).mockImplementation(async () => MOCK_STATIONS);
    setQueue([STATION_TRACKS[0]], 0); // currentTrack = Alpha
    const { getByText } = render(() => <Stations />);
    await waitFor(() => {
      expect(getByText(/New from current track/)).toBeTruthy();
    });
    fireEvent.click(getByText(/New from current track/));
    await waitFor(() => {
      expect(vi.mocked(tauriApi.libCreateStation)).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "seed",
          seedTrackIds: ["3940784406639047387"],
        }),
      );
    });
  });

  it("sem track atual, nao cria station", async () => {
    vi.mocked(tauriApi.libListStations).mockImplementation(async () => MOCK_STATIONS);
    setQueue([], 0); // currentTrack = null
    const { getByText } = render(() => <Stations />);
    await waitFor(() => {
      expect(getByText(/New from current track/)).toBeTruthy();
    });
    fireEvent.click(getByText(/New from current track/));
    // da tempo do handler async rodar
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(tauriApi.libCreateStation)).not.toHaveBeenCalled();
  });
});

describe("SeedChips (reatividade sob parent nao-keyed)", () => {
  it("re-deriva label/tone/icon quando props.station muda in-place", () => {
    const [station, setStation] = createSignal<Station>(MOCK_STATIONS[0]);
    const { container } = render(() => <SeedChips station={station()} />);
    const chip = () => container.querySelector(".st-seed-chip");
    expect(chip()!.textContent).toContain("ambient · drone · sleepless");
    expect(chip()!.querySelector(".st-seed-chip__cover")!.classList.contains("tone-lavender")).toBe(true);

    // Simula o refetch trocando a station sem remontar o componente —
    // com chips como const congelados, o label/tone ficariam na antiga.
    setStation(MOCK_STATIONS[1]);
    expect(chip()!.textContent).toContain("modern classical · acoustic · low tempo");
    expect(chip()!.querySelector(".st-seed-chip__cover")!.classList.contains("tone-bone")).toBe(true);
  });
});

describe("Criacao de mood station", () => {
  afterEach(() => {
    vi.mocked(tauriApi.libListStations).mockImplementation(async () => []);
    vi.mocked(tauriApi.libCreateStation).mockImplementation(async () => null as any);
  });

  it("abre o painel e lista chips de mood/activity do vocabulario mockado", async () => {
    const { getByText, container } = render(() => <Stations />);
    fireEvent.click(getByText(/Nova mood station/));
    await waitFor(() => {
      expect(container.querySelector(".st-mood-create")).toBeTruthy();
    });
    expect(getByText("dark")).toBeTruthy();
    expect(getByText("uplifting")).toBeTruthy();
    expect(getByText("chill")).toBeTruthy();
    expect(getByText("workout")).toBeTruthy();
    expect(getByText("study")).toBeTruthy();
  });

  it("botao de criar fica desabilitado sem nenhum chip selecionado", async () => {
    const { getByText, container } = render(() => <Stations />);
    fireEvent.click(getByText(/Nova mood station/));
    await waitFor(() => {
      expect(container.querySelector(".st-mood-create")).toBeTruthy();
    });
    const createBtn = getByText("Criar mood station") as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });

  it("selecionar 2 chips habilita o botao e chama libCreateStation com kind mood e query com os tokens", async () => {
    vi.mocked(tauriApi.libListStations).mockImplementation(async () => []);
    const { getByText, container } = render(() => <Stations />);
    fireEvent.click(getByText(/Nova mood station/));
    await waitFor(() => {
      expect(container.querySelector(".st-mood-create")).toBeTruthy();
    });
    fireEvent.click(getByText("dark"));
    fireEvent.click(getByText("workout"));
    const createBtn = getByText("Criar mood station") as HTMLButtonElement;
    expect(createBtn.disabled).toBe(false);
    fireEvent.click(createBtn);
    await waitFor(() => {
      expect(vi.mocked(tauriApi.libCreateStation)).toHaveBeenCalled();
    });
    const call = vi.mocked(tauriApi.libCreateStation).mock.calls[0][0];
    expect(call.kind).toBe("mood");
    expect(call.query).toContain("dark");
    expect(call.query).toContain("workout");
  });

  it("genero com '&' (ex: Funk & Soul) e sanitizado pra nao quebrar o bigram do parser Rust", async () => {
    // MoodFilters::parse (Rust) reconhece o genero "Funk & Soul" via bigram
    // "funk soul" (substring sem &). Se a query mandar o "&" cru, o bigram
    // nao bate e os tokens soltos "funk"/"soul" caem no ramo errado
    // (single-token "funk" seta genero pra "Funk Brasileiro" por engano).
    vi.mocked(tauriApi.libListStations).mockImplementation(async () => []);
    const { getByText, container } = render(() => <Stations />);
    fireEvent.click(getByText(/Nova mood station/));
    await waitFor(() => {
      expect(container.querySelector(".st-mood-create")).toBeTruthy();
    });
    fireEvent.click(getByText("dark"));
    const genreSelect = container.querySelector(".st-mood-create__genre") as HTMLSelectElement;
    fireEvent.change(genreSelect, { target: { value: "Funk & Soul" } });
    fireEvent.click(getByText("Criar mood station"));
    await waitFor(() => {
      expect(vi.mocked(tauriApi.libCreateStation)).toHaveBeenCalled();
    });
    const call = vi.mocked(tauriApi.libCreateStation).mock.calls[0][0];
    expect(call.query).not.toContain("&");
    // MoodFilters::parse faz to_lowercase() na query inteira antes de tokenizar
    // — case na origem nao importa pro bigram bater.
    expect(call.query.toLowerCase()).toContain("funk soul");
  });
});

describe("StationCard (reatividade de isFirst/seedLine)", () => {
  it("badge Live segue props.isFirst apos mudanca", () => {
    const [first, setFirst] = createSignal(false);
    const { container } = render(() => (
      <StationCard station={MOCK_STATIONS[0]} isFirst={first()} onResume={() => {}} />
    ));
    expect(container.querySelector(".st-card__live")).toBeFalsy();
    setFirst(true);
    expect(container.querySelector(".st-card__live")).toBeTruthy();
    setFirst(false);
    expect(container.querySelector(".st-card__live")).toBeFalsy();
  });

  it("botao de apagar exige confirmacao e nao dispara o play do card", () => {
    // O card inteiro e clicavel (onResume). O delete e destrutivo, entao
    // pede 2 cliques (arma -> confirma) e nunca pode vazar o clique pro card.
    const onDelete = vi.fn();
    const onResume = vi.fn();
    const { container } = render(() => (
      <StationCard
        station={MOCK_STATIONS[0]}
        isFirst={false}
        onResume={onResume}
        onDelete={onDelete}
      />
    ));
    const btn = container.querySelector(".st-card__delete") as HTMLButtonElement;
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    expect(onDelete).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
    expect(btn.classList.contains("is-armed")).toBe(true);

    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledWith("midnight-1");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("armar o delete e depois trocar a station sob a mesma instancia nao apaga a errada", () => {
    // O <For> do grid nao e keyed: a mesma instancia recebe outra station
    // quando a lista muda (o refetch pos-delete faz isso). Se o estado armado
    // fosse um booleano, o clique seguinte apagaria a station nova.
    const onDelete = vi.fn();
    const [st, setSt] = createSignal<Station>(MOCK_STATIONS[0]);
    const { container } = render(() => (
      <StationCard station={st()} isFirst={false} onResume={() => {}} onDelete={onDelete} />
    ));
    const btn = container.querySelector(".st-card__delete") as HTMLButtonElement;
    fireEvent.click(btn); // arma a station 0
    expect(btn.classList.contains("is-armed")).toBe(true);

    setSt(MOCK_STATIONS[1]); // outra station sob a MESMA instancia
    expect(btn.classList.contains("is-armed")).toBe(false);

    fireEvent.click(btn); // primeiro clique na nova: so arma, nao apaga
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledWith(MOCK_STATIONS[1].id);
  });

  it("seedLine re-deriva quando a station muda de kind", () => {
    const [st, setSt] = createSignal<Station>(MOCK_STATIONS[0]); // seed, 3 tracks
    const { container } = render(() => (
      <StationCard station={st()} isFirst={false} onResume={() => {}} />
    ));
    expect(container.querySelector(".st-card__seed-line")!.textContent).toBe("seed · 3 tracks");
    setSt(MOCK_STATIONS[4]); // mood, query "minimal electronic"
    expect(container.querySelector(".st-card__seed-line")!.textContent).toBe("mood · minimal electronic");
  });
});
