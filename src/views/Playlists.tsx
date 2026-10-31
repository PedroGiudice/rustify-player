/* ============================================================
   views/Playlists.tsx — Folders reais + mosaico 2x2 de capas.

   Fonte de dados:
   - "All playlists" = lib_list_folders() — folders do disco com
     mosaico 2x2 das primeiras 4 covers distintas.
   - Sem smart playlists, "New playlist" nem reorder das fixadas: eram
     mock e controles sem acao (auditoria 25/09, lib-9). Voltam quando
     existirem de verdade (triagem D1/D6/item 2.5).
   - "Pinned" = lista persistida em localStorage via store/pins.ts.
     Toggle via icon no canto sup. dir. do card.

   Click no card -> navega pra /playlist/<name> (Playlist.tsx). Abrir é
   um <button> próprio (o nome), irmão do de fixar: o card como
   role=button deixava o fixar aninhado, e Enter no fixar subia até o
   card, navegava e o preventDefault engolia o fixar. O ::after do botão
   cobre o card inteiro (extractor-lab.css), mesmo padrão do card de
   station.
   Pin toggle -> store/pins, sem navegar.

   Mosaico (lib/mosaic.ts, A42): uma capa ocupa o quadro inteiro, duas ou
   três repetem; o placeholder colorido (tones do extractor-lab) só
   aparece em pasta sem capa nenhuma.
   ============================================================ */

import { createMemo, createResource, createSignal, For, Match, Show, Switch, type JSX } from "solid-js";
import { libListFolders, coverUrl, type FolderPlaylist } from "../tauri";
import { togglePin, pins } from "../store/pins";
import { libraryRevision } from "../store/moveDialog";
import { navigate } from "../router";
import { EmptyState } from "../components/EmptyState";
import { ICONS } from "../components/Icon";
import { plural } from "../lib/count";
import { dataOf, listState, peek, settle } from "../lib/loaded";
import { mosaicCells } from "../lib/mosaic";
import { truncTipEvent } from "../lib/truncTip";

function openPlaylist(folder: FolderPlaylist) {
  navigate(`/playlist/${encodeURIComponent(folder.name)}`);
}

// ── Tones de fallback (vide tokens em extractor-lab.css) ─────────
type Tone =
  | "tone-lavender" | "tone-mint" | "tone-peach" | "tone-sky"
  | "tone-rose" | "tone-butter" | "tone-paper" | "tone-bone";

const TONES: Tone[] = [
  "tone-lavender", "tone-mint", "tone-peach", "tone-sky",
  "tone-rose", "tone-butter", "tone-paper", "tone-bone",
];

// Hash deterministico (folder name -> tone idx) pra o mesmo folder
// sempre cair na mesma combinacao de cores quando precisar de fallback.
function toneFor(folder: string, offset: number): Tone {
  let h = 0;
  for (let i = 0; i < folder.length; i++) h = (h * 31 + folder.charCodeAt(i)) | 0;
  return TONES[Math.abs(h + offset) % TONES.length];
}

// ── Mosaico de covers reais; tom colorido só sem capa nenhuma ────
function CoverMosaic(props: { folder: FolderPlaylist }) {
  const cells = createMemo((): Array<{ src: string | null; tone: Tone; full: boolean }> => {
    const covers = mosaicCells(props.folder.cover_paths ?? []);
    if (covers.length === 0) {
      return Array.from({ length: 4 }, (_, i) => ({ src: null, tone: toneFor(props.folder.name, i), full: false }));
    }
    return covers.map((c, i) => ({ src: coverUrl(c), tone: toneFor(props.folder.name, i), full: covers.length === 1 }));
  });
  return (
    <>
      <For each={cells()}>
        {(c) => (
          <Show
            when={c.src}
            fallback={
              <div class={`pl-card__quad ${c.tone}`}>
                {/* @ts-ignore */}
                <iconify-icon icon="lucide:disc-3" noobserver />
              </div>
            }
          >
            <div class="pl-card__quad pl-card__quad--cover" classList={{ "pl-card__quad--full": c.full }}>
              <img src={c.src!} alt="" loading="lazy" />
            </div>
          </Show>
        )}
      </For>
    </>
  );
}

// ── Card ────────────────────────────────────────────────────────
// O fixar fica no nível do card (fora da capa): a capa ganha transform no
// hover, o que a tornaria um contexto de empilhamento e deixaria o fixar
// por baixo do ::after do botão de abrir.
function PlaylistCard(props: { folder: FolderPlaylist; children?: JSX.Element }) {
  const pinned = createMemo(() => pins().includes(props.folder.name));
  return (
    <div class="pl-card" onPointerEnter={truncTipEvent}>
      <div class="pl-card__cover">
        <CoverMosaic folder={props.folder} />
      </div>
      <button type="button" class="pl-card__title pl-card__open" data-trunc onFocus={truncTipEvent} onClick={() => openPlaylist(props.folder)}>
        {props.folder.name}
      </button>
      {/* Depois do abrir na ordem de Tab (nome primeiro); a posição é absoluta. */}
      <button
        type="button"
        class="pl-card__pin"
        classList={{ "is-pinned": pinned() }}
        title={pinned() ? "Desafixar" : "Fixar"}
        aria-label={pinned() ? `Desafixar ${props.folder.name}` : `Fixar ${props.folder.name}`}
        onClick={() => togglePin(props.folder.name)}
      >
        {/* @ts-ignore */}
        <iconify-icon icon="lucide:pin" noobserver />
      </button>
      {props.children}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────
function fmtTracks(n: number): string {
  return plural(n, "faixa", "faixas");
}

export default function Playlists() {
  const [filter, setFilter] = createSignal("");
  // libraryRevision na chave: contagens/capas mudam depois de "Mover para playlist…".
  const [foldersRes, { refetch }] = createResource(() => ({ rev: libraryRevision() }), () => settle(libListFolders()));
  const folders = () => dataOf(peek(foldersRes));
  const state = () => listState(peek(foldersRes));

  // "none" = ordem da API, "asc" = A→Z, "desc" = Z→A. Toggle ciclico.
  const [sortDir, setSortDir] = createSignal<"none" | "asc" | "desc">("none");
  function cycleSortDir() {
    setSortDir((cur) => (cur === "none" ? "asc" : cur === "asc" ? "desc" : "none"));
  }

  const visibleFolders = createMemo(() => {
    const list = folders();
    const q = filter().trim().toLowerCase();
    if (!q) return list;
    return list.filter((f) => f.name.toLowerCase().includes(q));
  });

  // Pinned: lista persistida em localStorage (store/pins.ts). Reativo a pins().
  // Ordem segue a ordem em pins() — primeiro pinado = primeiro card.
  // Parte das pastas ja filtradas: o filtro vale pras fixadas tambem.
  const pinned = createMemo(() => {
    const list = visibleFolders();
    const pinSet = pins();
    return pinSet
      .map((n) => list.find((f) => f.name === n))
      .filter((f): f is FolderPlaylist => !!f);
  });
  const rest = createMemo(() => {
    const list = visibleFolders();
    const pinnedNames = new Set(pins());
    const filtered = list.filter((f) => !pinnedNames.has(f.name));
    const dir = sortDir();
    if (dir === "none") return filtered;
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    return dir === "asc" ? sorted : sorted.reverse();
  });

  const totalPlaylists = () => folders().length;
  const totalTracks    = () => folders().reduce((sum, f) => sum + f.track_count, 0);

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Playlists</h1>
          <p class="view__head-hint">Coleções pessoais — uma pasta do acervo por playlist.</p>
        </div>
        <div class="view__stats">
          <span><b>{totalPlaylists()}</b> {totalPlaylists() === 1 ? "playlist" : "playlists"}</span>
          <span><b>{totalTracks()}</b> {totalTracks() === 1 ? "faixa" : "faixas"} no total</span>
        </div>
      </header>

      <div class="coll">
        {/* ── Toolbar ──────────────────────────────────── */}
        <div class="coll-toolbar">
          <div class="coll-search">
            {/* @ts-ignore */}
            <iconify-icon icon="lucide:search" noobserver />
            <input
              type="text"
              placeholder="Filtrar playlists…"
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          </div>
        </div>

        <Switch>
          <Match when={state() === "carregando"}>
            <EmptyState tone="carregando" title="Carregando o acervo…" />
          </Match>
          <Match when={state() === "erro"}>
            <EmptyState
              tone="erro"
              title="Não consegui ler o acervo agora."
              text="O índice não respondeu. As pastas continuam no disco."
              actions={[{ label: "Tentar de novo", onClick: () => void refetch(), icon: ICONS.refresh }]}
            />
          </Match>
          <Match when={state() === "vazio"}>
            <EmptyState
              icon={ICONS.playlists}
              title="Nenhuma playlist ainda."
              text="Cada pasta de primeiro nível em ~/Music vira uma playlist."
            />
          </Match>
          <Match when={visibleFolders().length === 0}>
            <EmptyState
              compact
              title={`Nenhuma playlist com "${filter().trim()}".`}
              actions={[{ label: "Limpar filtro", onClick: () => setFilter("") }]}
            />
          </Match>
          <Match when={state() === "pronto"}>
            {/* ── Pinned ───────────────────────────────────── */}
            <Show when={pinned().length > 0}>
              <section>
                <div class="section__head">
                  <h2 class="section__title">Fixadas</h2>
                </div>
                <div class="pl-grid">
                  <For each={pinned()}>
                    {(p) => (
                      <PlaylistCard folder={p}>
                        <div class="pl-card__sub">{fmtTracks(p.track_count)}</div>
                      </PlaylistCard>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            {/* ── All playlists ────────────────────────────── */}
            <Show when={rest().length > 0}>
              <section>
                <div class="section__head">
                  <h2 class="section__title">Todas as playlists · {rest().length}</h2>
                  <button type="button" class="section__action" onClick={cycleSortDir}>
                    {sortDir() === "none" ? "Ordenar por nome" : sortDir() === "asc" ? "Ordem: nome A–Z" : "Ordem: nome Z–A"}
                  </button>
                </div>
                <div class="pl-grid">
                  <For each={rest()}>
                    {(p) => (
                      <PlaylistCard folder={p}>
                        <div class="pl-card__sub">{fmtTracks(p.track_count)}</div>
                      </PlaylistCard>
                    )}
                  </For>
                </div>
              </section>
            </Show>
          </Match>
        </Switch>
      </div>
    </article>
  );
}
