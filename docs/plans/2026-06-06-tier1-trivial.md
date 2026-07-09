# Tier 1 — Wiring trivial: plano executável TDD

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans

**Goal:** Ligar 4 controles zumbi cujo backend já existe — botão play dos cards de álbum em Albums.tsx e Home.tsx, botão "More" do NowPlaying, e toggle "Sort by name" em Playlists. O item 1.4 ("Recently played") é rebaixado por ausência de campo no tipo.

**Architecture:** Todos os controles são 100% frontend. Os handlers reutilizam funções já importadas (`libGetTracksByAlbum`, `setQueue`, `playTrack`, `openTrackMenu`) ou lógica local de signal + sort. Nenhum comando Rust novo; nenhuma alteração em `tauri.ts` ou `lib.rs`.

> **Re-base (2026-06-07):** o pré-requisito invisível dos itens 1.1/1.2 foi resolvido
> no commit `b57d5ec` — o `CoverArt` agora renderiza `{props.children}`, então os botões
> `.card__play` passam a EXISTIR no DOM (antes o `CoverArt` descartava os filhos e o botão
> nunca aparecia). Dois ajustes obrigatórios neste plano:
> 1. O teste de card-play deve **exercitar o `CoverArt` real**, não mocká-lo como
>    `(props) => <div>{props.children}</div>` — esse mock mascarava o bug (renderizava
>    children que o real descartava). Com o mock, um retorno do bug passaria despercebido.
> 2. Gate de validação: `npm run typecheck` agora é **real** (tsconfig add em `8e4758e`).
>    Rodar `npm run typecheck` E `vitest` — o `tsc` deixou de ser vácuo.

**Contexto verificado nos fontes:**

- `Albums.tsx:38` — div.card tem `onClick={() => play(a)}` que já toca. O botão `card__play` (linha 45) não tem handler próprio; o click borbulha e toca. O handler explícito com `e.stopPropagation()` previne dupla-chamada quando o card for eventualmente navegável.
- `Home.tsx:172` — análogo: div.card tem `onClick={() => playAlbum(a.title)}`. Botão `card__play` (linha 179) sem handler. A função `playAlbum` (linha 36) já segue o padrão correto.
- `NowPlaying.tsx:241` — `<button title="More">` sem `onClick`. `openTrackMenu` tem assinatura `(e: MouseEvent, track: Track, opts?)` confirmada em `store/contextMenu.ts:20`.
- `Playlists.tsx:130-133` — `rest()` é `createMemo` que filtra pinned; não ordena. A âncora "Sort by name ↓" (linha 253) é `<a class="section__action">` sem handler.
- `FolderPlaylist` (tauri.ts:155) — campos: `name`, `track_count`, `cover_path`, `cover_paths`. **Sem `last_played`.** Item 1.4 não é implementável como trivial.

---

## DECISÃO 1.4 (resolvida pelo CEO, 06/06)

- **1.4 "Recently played" → REMOVER o botão.** `FolderPlaylist` não expõe campo de
  tempo; ordenar folders por recência exigiria campo novo no indexer, e "playlist tocada
  recentemente" tem valor baixo. Decisão: **remover** o `<button class="sig-pbtn">…Recently
  played</button>` em `Playlists.tsx:178` — incorporado à Task 4 (mesmo arquivo). Não rebaixar
  pra Tier 2. O teste da Task 4 também asserta a ausência desse botão.

---

## Task 1 — Botão play do card de álbum em Albums.tsx (item 1.1)

**Arquivos:** `src/views/Albums.tsx` (modificar), `src/views/Albums.test.tsx` (criar)

**Contexto:** A função `play(album)` na linha 18 já tem a lógica correta. O botão `card__play` (linha 45) não tem `onClick` — o click borbulha para o div pai. Precisamos de handler explícito com `e.stopPropagation()` para que o botão seja independente do div.card ao ser clicado.

### Step 1.1 — Escrever o teste (TDD: vermelho)

Criar `src/views/Albums.test.tsx`:

```tsx
/* ============================================================
   Albums.test.tsx — Testa que o botão card__play monta a fila
   com as tracks do album e toca a primeira.
   ============================================================ */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const mockTracks = [
  { id: "1", title: "Track A", artist_name: "Artist", album_title: "Album X", album_cover_path: null, duration_ms: 180000, file_path: "/a.flac", genre: null, year: null, track_number: null, disc_number: null, lufs_integrated: null, last_played: null, play_count: 0 },
  { id: "2", title: "Track B", artist_name: "Artist", album_title: "Album X", album_cover_path: null, duration_ms: 200000, file_path: "/b.flac", genre: null, year: null, track_number: null, disc_number: null, lufs_integrated: null, last_played: null, play_count: 0 },
];

const mockAlbums = [
  { title: "Album X", artist_name: "Artist", cover_path: null, cover_paths: [], track_count: 2, year: 2024 },
];

vi.mock("../tauri", () => ({
  libGetAlbums: vi.fn().mockResolvedValue(mockAlbums),
  libGetTracksByAlbum: vi.fn().mockResolvedValue(mockTracks),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

const mockSetQueue = vi.fn();
const mockPlayTrack = vi.fn();

vi.mock("../store/player", () => ({
  setQueue: (...args: any[]) => mockSetQueue(...args),
  player: { currentTrack: null, positionSecs: 0, durationSecs: 0, isPlaying: false },
}));

vi.mock("../components/PlayerBar", () => ({
  playTrack: (...args: any[]) => mockPlayTrack(...args),
}));

vi.mock("../router", () => ({
  navigate: vi.fn(),
  route: () => ({ path: "/albums" }),
}));

vi.mock("../components/CoverArt", () => ({
  CoverArt: (props: any) => <div class="cover-art">{props.children}</div>,
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { play: "play" },
}));

beforeEach(() => {
  mockSetQueue.mockClear();
  mockPlayTrack.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import Albums from "./Albums";
import * as tauri from "../tauri";

describe("Albums — botão card__play", () => {
  it("clicar no card__play chama setQueue com todas as tracks e toca a primeira", async () => {
    const { container } = render(() => <Albums />);

    // Aguardar o resource resolver
    await vi.waitFor(() => {
      const btn = container.querySelector(".card__play");
      return btn !== null;
    });

    const btn = container.querySelector(".card__play") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);

    await vi.waitFor(() => mockSetQueue.mock.calls.length > 0);

    expect(tauri.libGetTracksByAlbum).toHaveBeenCalledWith("Album X");
    expect(mockSetQueue).toHaveBeenCalledWith(mockTracks, 0, "curated");
    expect(mockPlayTrack).toHaveBeenCalledWith(mockTracks[0]);
  });

  it("e.stopPropagation() impede que o handler do div pai seja chamado duas vezes", async () => {
    const { container } = render(() => <Albums />);

    await vi.waitFor(() => container.querySelector(".card__play") !== null);

    // resetar antes do click
    mockSetQueue.mockClear();
    mockPlayTrack.mockClear();

    const btn = container.querySelector(".card__play") as HTMLButtonElement;
    fireEvent.click(btn);

    await vi.waitFor(() => mockSetQueue.mock.calls.length > 0);

    // setQueue deve ser chamado exatamente 1 vez, não 2
    expect(mockSetQueue).toHaveBeenCalledTimes(1);
  });
});
```

### Step 1.2 — Rodar o teste (deve falhar)

```bash
cd /home/opc/rustify-player && npm test -- --reporter=verbose 2>&1 | grep -A 5 "Albums"
```

### Step 1.3 — Implementar o handler em Albums.tsx

Modificar `src/views/Albums.tsx`, linha 45. O `<button class="card__play">` recebe `onClick` explícito com `e.stopPropagation()`:

**Antes (linha 45):**
```tsx
<button class="card__play" type="button"><Icon name={ICONS.play} size={12} /></button>
```

**Depois:**
```tsx
<button class="card__play" type="button" onClick={(e) => { e.stopPropagation(); play(a); }}><Icon name={ICONS.play} size={12} /></button>
```

A função `play` já existe na linha 18 e tem o padrão correto: `libGetTracksByAlbum(album.title)` → `setQueue(tracks, 0, "curated")` → `playTrack(tracks[0])`.

### Step 1.4 — Rodar o teste (deve passar)

```bash
cd /home/opc/rustify-player && npm test -- --reporter=verbose 2>&1 | grep -A 5 "Albums"
```

### Step 1.5 — Commit

```bash
git -C /home/opc/rustify-player add src/views/Albums.tsx src/views/Albums.test.tsx
git -C /home/opc/rustify-player commit -m "feat(ui): botao card__play em Albums — handler com stopPropagation (item 1.1)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2 — Botão play do card de álbum em Home.tsx (item 1.2)

**Arquivos:** `src/views/Home.tsx` (modificar), `src/views/Home.test.tsx` (criar)

**Contexto:** Em `Home.tsx` o card de álbum (linha 172) tem `onClick={() => playAlbum(a.title)}` no div pai. O botão `card__play` (linha 179) não tem handler próprio. A função `playAlbum` (linha 36) já segue o padrão: `libGetTracksByAlbum` → `setQueue(tracks, 0, "curated")` → `playTrack(tracks[0])`.

### Step 2.1 — Escrever o teste (TDD: vermelho)

Criar `src/views/Home.test.tsx`:

```tsx
/* ============================================================
   Home.test.tsx — Testa que o botão card__play no grid de albums
   monta a fila e toca a primeira track.
   ============================================================ */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const mockTracks = [
  { id: "10", title: "Song 1", artist_name: "Band", album_title: "Great Album", album_cover_path: null, duration_ms: 240000, file_path: "/s1.flac", genre: null, year: null, track_number: null, disc_number: null, lufs_integrated: null, last_played: null, play_count: 0 },
];

const mockSnap = { tracks_total: 50, albums_total: 5, artists_total: 3, embeddings_done: 40, embeddings_pending: 10, embeddings_failed: 0 };

const mockAlbums = [
  { title: "Great Album", artist_name: "Band", cover_path: null, cover_paths: [], track_count: 1, year: 2023 },
];

vi.mock("../tauri", () => ({
  libSnapshot: vi.fn().mockResolvedValue(mockSnap),
  libListHistory: vi.fn().mockResolvedValue([]),
  libGetAlbums: vi.fn().mockResolvedValue(mockAlbums),
  libRecommendations: vi.fn().mockResolvedValue({ most_played: [], based_on_top: [], discover: [] }),
  libShuffle: vi.fn().mockResolvedValue([]),
  libGetTracksByAlbum: vi.fn().mockResolvedValue(mockTracks),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

const mockSetQueue = vi.fn();
const mockPlayTrack = vi.fn();

vi.mock("../store/player", () => ({
  setQueue: (...args: any[]) => mockSetQueue(...args),
  player: { currentTrack: null, positionSecs: 0, durationSecs: 0, isPlaying: false },
}));

vi.mock("../components/PlayerBar", () => ({
  playTrack: (...args: any[]) => mockPlayTrack(...args),
}));

vi.mock("../router", () => ({
  navigate: vi.fn(),
  route: () => ({ path: "/" }),
}));

vi.mock("../components/CoverArt", () => ({
  CoverArt: (props: any) => <div class="cover-art">{props.children}</div>,
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { play: "play", shuffle: "shuffle", settings: "settings" },
}));

vi.mock("../components/TrackRowList", () => ({
  TrackRowList: () => <div class="track-row-mock" />,
}));

vi.mock("../lib/format", () => ({
  fmtDur: (ms: number) => `${Math.round(ms / 60000)}m`,
  relTime: () => "just now",
}));

beforeEach(() => {
  mockSetQueue.mockClear();
  mockPlayTrack.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import Home from "./Home";
import * as tauri from "../tauri";

describe("Home — botão card__play no grid de albums", () => {
  it("clicar no card__play chama setQueue com as tracks do album e toca a primeira", async () => {
    const { container } = render(() => <Home />);

    await vi.waitFor(() => {
      const btn = container.querySelector(".card__play");
      return btn !== null;
    });

    const btn = container.querySelector(".card__play") as HTMLButtonElement;
    fireEvent.click(btn);

    await vi.waitFor(() => mockSetQueue.mock.calls.length > 0);

    expect(tauri.libGetTracksByAlbum).toHaveBeenCalledWith("Great Album");
    expect(mockSetQueue).toHaveBeenCalledWith(mockTracks, 0, "curated");
    expect(mockPlayTrack).toHaveBeenCalledWith(mockTracks[0]);
  });

  it("e.stopPropagation() garante que setQueue é chamado exatamente 1 vez", async () => {
    const { container } = render(() => <Home />);

    await vi.waitFor(() => container.querySelector(".card__play") !== null);

    mockSetQueue.mockClear();
    mockPlayTrack.mockClear();

    const btn = container.querySelector(".card__play") as HTMLButtonElement;
    fireEvent.click(btn);

    await vi.waitFor(() => mockSetQueue.mock.calls.length > 0);

    expect(mockSetQueue).toHaveBeenCalledTimes(1);
  });
});
```

### Step 2.2 — Rodar o teste (deve falhar)

```bash
cd /home/opc/rustify-player && npm test -- --reporter=verbose 2>&1 | grep -A 5 "Home"
```

### Step 2.3 — Implementar o handler em Home.tsx

Modificar `src/views/Home.tsx`, linha 179. O `<button class="card__play">` recebe `onClick` explícito:

**Antes (linha 179):**
```tsx
<button class="card__play" type="button"><Icon name={ICONS.play} size={12} /></button>
```

**Depois:**
```tsx
<button class="card__play" type="button" onClick={(e) => { e.stopPropagation(); playAlbum(a.title); }}><Icon name={ICONS.play} size={12} /></button>
```

### Step 2.4 — Rodar o teste (deve passar)

```bash
cd /home/opc/rustify-player && npm test -- --reporter=verbose 2>&1 | grep -A 5 "Home"
```

### Step 2.5 — Commit

```bash
git -C /home/opc/rustify-player add src/views/Home.tsx src/views/Home.test.tsx
git -C /home/opc/rustify-player commit -m "feat(ui): botao card__play em Home — handler com stopPropagation (item 1.2)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3 — NowPlaying "More" abre o contexto da track atual (item 1.3)

**Arquivos:** `src/views/NowPlaying.tsx` (modificar), `src/views/NowPlaying.test.tsx` (criar)

**Contexto:** `NowPlaying.tsx:241` — `<button title="More">` sem `onClick`. `openTrackMenu` (store/contextMenu.ts:20) tem assinatura:
```ts
openTrackMenu(e: MouseEvent, track: Track, opts?: { list?: Track[]; onPlay?: () => void })
```
O `player.currentTrack` pode ser `null` (nenhuma track tocando). O botão deve ser desabilitado nesse caso. O `TrackContextMenu` já está montado no `App` e reage ao signal `trackMenu`.

### Step 3.1 — Escrever o teste (TDD: vermelho)

Criar `src/views/NowPlaying.test.tsx`:

```tsx
/* ============================================================
   NowPlaying.test.tsx — Testa que o botão "More" abre o menu
   de contexto com a track atual, e fica desabilitado sem track.
   ============================================================ */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const mockTrack = {
  id: "42",
  title: "Test Song",
  artist_name: "Test Artist",
  album_title: "Test Album",
  album_cover_path: null,
  duration_ms: 300000,
  file_path: "/test.flac",
  genre: null,
  year: null,
  track_number: null,
  disc_number: null,
  lufs_integrated: null,
  last_played: null,
  play_count: 1,
};

const mockOpenTrackMenu = vi.fn();

vi.mock("../store/contextMenu", () => ({
  openTrackMenu: (...args: any[]) => mockOpenTrackMenu(...args),
  trackMenu: () => null,
  closeTrackMenu: vi.fn(),
}));

let mockCurrentTrack: typeof mockTrack | null = null;

vi.mock("../store/player", () => ({
  player: new Proxy({}, {
    get: (_t, key) => {
      if (key === "currentTrack") return mockCurrentTrack;
      if (key === "positionSecs") return 0;
      if (key === "durationSecs") return 300;
      if (key === "isPlaying") return false;
      return undefined;
    },
  }),
}));

vi.mock("../store/dsp", () => ({
  dsp: { presetName: null },
}));

vi.mock("../store/tweaks", () => ({
  tweaks: { lyricsEnabled: false, bgInk: "#000000", bgAlpha: 0.8 },
}));

vi.mock("../tauri", () => ({
  libGetLyrics: vi.fn().mockResolvedValue([]),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

vi.mock("../router", () => ({
  navigate: vi.fn(),
}));

vi.mock("../components/CoverArt", () => ({
  CoverArt: (props: any) => <div class="cover-art">{props.children}</div>,
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { settings: "settings", more: "more", expand: "expand", shrink: "shrink" },
}));

vi.mock("../components/SpectrumCanvas", () => ({
  useShape: () => () => "wave",
}));

beforeEach(() => {
  mockOpenTrackMenu.mockClear();
  mockCurrentTrack = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import NowPlaying from "./NowPlaying";

describe("NowPlaying — botão More", () => {
  it("está desabilitado quando não há track tocando", () => {
    mockCurrentTrack = null;
    const { container } = render(() => <NowPlaying />);
    const btn = container.querySelector('button[title="More"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it("chama openTrackMenu com a track atual ao clicar", () => {
    mockCurrentTrack = mockTrack;
    const { container } = render(() => <NowPlaying />);
    const btn = container.querySelector('button[title="More"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);

    expect(mockOpenTrackMenu).toHaveBeenCalledTimes(1);
    // Primeiro argumento é o MouseEvent, segundo é a track
    expect(mockOpenTrackMenu.mock.calls[0][1]).toEqual(mockTrack);
  });
});
```

### Step 3.2 — Rodar o teste (deve falhar)

```bash
cd /home/opc/rustify-player && npm test -- --reporter=verbose 2>&1 | grep -A 5 "NowPlaying"
```

### Step 3.3 — Implementar o handler em NowPlaying.tsx

Primeiro, adicionar o import de `openTrackMenu` no topo do arquivo. A linha atual de imports (linha 1-17) não inclui `store/contextMenu`.

**Adicionar ao bloco de imports (após a linha 16, `import { tweaks } from "../store/tweaks";`):**
```tsx
import { openTrackMenu } from "../store/contextMenu";
```

**Modificar a linha 241 (`<button title="More">`):**

**Antes:**
```tsx
<button title="More"><Icon name={ICONS.more} size={14} /></button>
```

**Depois:**
```tsx
<button
  title="More"
  disabled={!player.currentTrack}
  onClick={(e) => { if (player.currentTrack) openTrackMenu(e, player.currentTrack); }}
>
  <Icon name={ICONS.more} size={14} />
</button>
```

### Step 3.4 — Rodar o teste (deve passar)

```bash
cd /home/opc/rustify-player && npm test -- --reporter=verbose 2>&1 | grep -A 5 "NowPlaying"
```

### Step 3.5 — Commit

```bash
git -C /home/opc/rustify-player add src/views/NowPlaying.tsx src/views/NowPlaying.test.tsx
git -C /home/opc/rustify-player commit -m "feat(ui): NowPlaying More abre TrackContextMenu da track atual (item 1.3)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4 — "Sort by name" toggle em Playlists.tsx (item 1.5)

**Arquivos:** `src/views/Playlists.tsx` (modificar), `src/views/Playlists.test.tsx` (modificar — adicionar describe)

**Contexto:** A âncora "Sort by name ↓" (linha 253) é um `<a class="section__action">` sem handler. O `rest()` memo (linha 130-133) filtra pinned mas não ordena. Precisamos de um signal local `sortAsc` que alterna e o `rest()` memo respeitar a ordem.

### Step 4.1 — Escrever o teste (TDD: vermelho)

Adicionar ao final de `src/views/Playlists.test.tsx` (preservar os describes existentes, apenas adicionar o novo):

```tsx
import { vi, beforeEach } from "vitest";
import { fireEvent } from "@solidjs/testing-library";

// Mock para libListFolders retornar dados reais de ordenação
const mockFolders = [
  { name: "Zoo Songs", track_count: 5, cover_path: null, cover_paths: [] },
  { name: "Alpha Tunes", track_count: 3, cover_path: null, cover_paths: [] },
  { name: "Middle Road", track_count: 8, cover_path: null, cover_paths: [] },
];

// O mock de tauri precisa ser declarado antes dos imports dinâmicos
vi.mock("../tauri", () => ({
  libListFolders: vi.fn().mockResolvedValue(mockFolders),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

vi.mock("../store/pins", () => ({
  isPinned: vi.fn(() => false),
  togglePin: vi.fn(),
  pins: () => [],
}));

vi.mock("../router", () => ({
  navigate: vi.fn(),
}));

describe("Playlists — Sort by name", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renderiza o link 'Sort by name' na seção All playlists", async () => {
    const { container } = render(() => <Playlists />);
    await vi.waitFor(() => container.querySelector(".section__action") !== null);
    const links = Array.from(container.querySelectorAll(".section__action"));
    const sortLink = links.find((l) => (l.textContent ?? "").includes("Sort"));
    expect(sortLink).toBeTruthy();
  });

  it("cliques sucessivos no Sort alternavam entre A→Z e Z→A", async () => {
    const { container } = render(() => <Playlists />);

    await vi.waitFor(() => {
      const cards = container.querySelectorAll(".pl-grid .pl-card:not(.pl-card--new)");
      return cards.length >= 3;
    });

    // Helpers para pegar nomes dos cards (excluindo o "New playlist")
    function getCardNames() {
      return Array.from(container.querySelectorAll(".pl-grid .pl-card:not(.pl-card--new) .pl-card__title"))
        .map((el) => el.textContent ?? "");
    }

    const links = Array.from(container.querySelectorAll(".section__action"));
    const sortLink = links.find((l) => (l.textContent ?? "").includes("Sort")) as HTMLElement;
    expect(sortLink).toBeTruthy();

    // Estado inicial: sem sort (ordem da API)
    const initialOrder = getCardNames();

    // Primeiro clique: A→Z
    fireEvent.click(sortLink);
    const afterFirstClick = getCardNames();
    const sortedAZ = [...mockFolders].map((f) => f.name).sort((a, b) => a.localeCompare(b));
    expect(afterFirstClick).toEqual(sortedAZ);
    expect(sortLink.textContent).toContain("↑"); // indicador A→Z ativo

    // Segundo clique: Z→A
    fireEvent.click(sortLink);
    const afterSecondClick = getCardNames();
    const sortedZA = [...sortedAZ].reverse();
    expect(afterSecondClick).toEqual(sortedZA);
    expect(sortLink.textContent).toContain("↓"); // indicador Z→A ativo

    // Terceiro clique: volta a sem sort (ordem original)
    fireEvent.click(sortLink);
    const afterThirdClick = getCardNames();
    expect(afterThirdClick).toEqual(initialOrder);
  });
});
```

### Step 4.2 — Rodar o teste (deve falhar)

```bash
cd /home/opc/rustify-player && npm test -- --reporter=verbose 2>&1 | grep -A 8 "Sort by name"
```

### Step 4.3 — Implementar o toggle de sort em Playlists.tsx

**1. Adicionar signal `sortDir` no início da função `Playlists` (após linha 111, após `const [filter, setFilter] = createSignal("")`):**

```tsx
// "none" = ordem da API, "asc" = A→Z, "desc" = Z→A
const [sortDir, setSortDir] = createSignal<"none" | "asc" | "desc">("none");

function cycleSortDir() {
  setSortDir((cur) => cur === "none" ? "asc" : cur === "asc" ? "desc" : "none");
}
```

**2. Modificar o memo `rest()` (linha 130-133) para aplicar a ordenação:**

**Antes:**
```tsx
const rest = createMemo(() => {
  const list = visibleFolders();
  const pinnedNames = new Set(pinned().map((p) => p.name));
  return list.filter((f) => !pinnedNames.has(f.name));
});
```

**Depois:**
```tsx
const rest = createMemo(() => {
  const list = visibleFolders();
  const pinnedNames = new Set(pinned().map((p) => p.name));
  const filtered = list.filter((f) => !pinnedNames.has(f.name));
  const dir = sortDir();
  if (dir === "none") return filtered;
  const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  return dir === "asc" ? sorted : sorted.reverse();
});
```

**3. Modificar a âncora "Sort by name" (linha 253) para ter handler e indicador visual:**

**Antes:**
```tsx
<a class="section__action">Sort by name ↓</a>
```

**Depois:**
```tsx
<a
  class="section__action"
  style={{ cursor: "pointer" }}
  onClick={cycleSortDir}
>
  {sortDir() === "none" ? "Sort by name" : sortDir() === "asc" ? "Sort: A→Z ↑" : "Sort: Z→A ↓"}
</a>
```

### Step 4.4 — Rodar o teste (deve passar)

```bash
cd /home/opc/rustify-player && npm test -- --reporter=verbose 2>&1 | grep -A 8 "Sort by name"
```

### Step 4.5 — Rodar todos os testes (sem regressão)

```bash
cd /home/opc/rustify-player && npm test 2>&1 | tail -20
```

### Step 4.6 — Commit

```bash
git -C /home/opc/rustify-player add src/views/Playlists.tsx src/views/Playlists.test.tsx
git -C /home/opc/rustify-player commit -m "feat(ui): Sort by name toggle A→Z/Z→A em Playlists (item 1.5)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5 — Verificação final e documentação da decisão sobre 1.4

**Arquivos:** sem modificação de código

### Step 5.1 — Rodar suite completa e verificar zero regressão

```bash
cd /home/opc/rustify-player && npm test 2>&1 | tail -30
```

Resultado esperado: todos os describes das Tasks 1-4 passando, mais os testes existentes (Settings, Signal, Stations, Playlists existentes, dsp, dsp-presets).

### Step 5.2 — Registrar decisão pendente sobre 1.4

O item 1.4 "Recently played" não foi implementado porque `FolderPlaylist` (tauri.ts:155) não expõe campo de tempo. Para implementar corretamente é necessário:

- Backend: adicionar `last_played: Option<i64>` (timestamp Unix ms) no tipo `FolderPlaylist` em `src-tauri/` e popular no `lib_list_folders` lendo o evento mais recente de `play_events` para cada folder.
- Frontend: ordenar `rest()` por `last_played` desc quando o botão for clicado.

Escopo mínimo estimado: Tier 2 (1 comando Rust modificado + wiring no frontend). A decisão de implementar ou remover o botão é do CEO — este plano deixa o botão como estava (inerte, sem false promise de funcionalidade).

---

## Critério de aceite do Tier 1 (itens implementados)

- `npm test` passa com zero falhas
- Clicar no botão `card__play` em Albums toca o álbum (setQueue + playTrack chamados)
- Clicar no botão `card__play` em Home toca o álbum (setQueue + playTrack chamados)
- Botão "More" em NowPlaying: desabilitado sem track; abre `TrackContextMenu` com a track atual
- Link "Sort by name" em Playlists alterna entre sem-sort / A→Z / Z→A
- Nenhum `console.log` ou stub introduzido nos arquivos de produção
- `cargo check` limpo (nenhum arquivo Rust foi tocado)
