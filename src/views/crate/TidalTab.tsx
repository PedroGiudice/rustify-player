/* ============================================================
   views/crate/TidalTab.tsx — aba Tidal do Crate: um campo só (link
   OU busca por texto), página de artista e prévia com seleção.
   Spec: docs/superpowers/specs/2026-10-14-crate-tidal-busca-design.md.
   O app nunca fala com a Tidal: tudo passa pela fila da VM
   (slsk/tidal_fila.rs -> scripts/curator/tidal_fila.py).

   Design (tokens do extractor-lab.css):
   - Cor: texto --fg-1 (título), --fg-5 (secundário), --fg-6
     (números, "no acervo"); divisórias --line-2; hover/foco de linha
     --bg-soft; capa vazia --bg-tint. Um acento só: --blue-ring (caixa
     marcada e anel de foco). Botão principal = --fg-1 (crate-btn--
     primary). Erro e fila fora usam o banner âmbar que o Crate já tem.
   - Tipo (Instrument Sans): 13,5 px/600 título de linha, de seção e
     de página; 12 px/400 secundário e botões (botão 600, padrão do
     Crate); 11,5 px tabular-nums para duração e contagens.
   - Layout:
       [ lupa | campo único ............ buscando… ] [Buscar|Baixar] [→ pasta v]
       (ordem da aba Buscar, A36)
       aviso de uma linha (foi para a fila / erro)
       home: estado vazio (os jobs moram na aba Fila desde 31/10, B6)
       busca: seções (o "top" primeiro) Faixas / Álbuns / Artistas /
              Playlists; linha = capa 40 | título + sub | marcas |
              duração | ações
       artista: [< Busca]
                foto 120 (cartaz, B27) Nome 18 · contagens [Rádio do artista]
                Populares / Álbuns / EPs e singles
       prévia:  [< voltar] (álbum e playlist: capa 120 em cartaz)
                Título · tipo · n faixas · duração
                Marcar todas · Desmarcar todas · Só as novas
                [x] capa | título + sub | marcas | duração  (álbum: nº no lugar da capa)
                rodapé fixo: 18 de 100 · ~1,1 GB · ~6 min [pasta v] [Baixar]
       Seleção em massa (B27): arrastar pela coluna das caixas pinta as
       linhas com o estado da primeira; Shift+clique marca o intervalo. Mais
       de 200 marcadas = vários pedidos de até 200 (o teto da fila e do Rust).
   - Linha com job (A16): a pílula do job fica no lugar dos botões; em voo,
     "Enviando…" desligado (dois cliques não viram dois jobs); faixa que já
     está no acervo só oferece Tocar.
   ============================================================ */

import {
  createSignal, createMemo, createEffect, on, For, Show, Switch, Match, onMount, onCleanup, batch,
} from "solid-js";
import {
  crateTidalEnqueue, crateTidalEnqueueSelection, crateTidalSearch, crateTidalArtist, crateTidalPreview,
  crateTidalCover, libGetTracks,
  type TidalJob, type TidalSearch, type TidalTrack, type TidalAlbum, type TidalArtist, type TidalPlaylist,
  type TidalArtistPage, type TidalPreview, type Track,
} from "../../tauri";
import { tidalStatusLabel, tidalStatusTone, isTidalActive } from "../../lib/tidalFila";
import { loadLastDest, saveLastDest } from "../../store/crate";
import { libraryRevision } from "../../store/moveDialog";
import { playTrack } from "../../components/PlayerBar";
import { FolderPicker, mergeFolders } from "./FolderPicker";
import {
  classifyTidalInput, estimateSelection, formatSize, formatEta, formatTrackTime, formatListTime, plural,
  buildOwnedIndex, findOwned, defaultSelection, orderedSelection, latestOnly, SEARCH_DEBOUNCE_MS, MAX_SELECTION,
  chunkIds, partTitle, rangeIds,
  type OwnedIndex,
} from "../../lib/tidalSearch";
import { pushEscLayer } from "../../lib/escLayers";
import { modCombo } from "../../lib/keyboard";
import { Icon, ICONS } from "../../components/Icon";

interface Props {
  jobs: TidalJob[];
  /** Pastas que a fila da VM conhece; somam-se às do acervo local (B7). */
  pastas: string[];
  /** Pastas de 1º nível do acervo local (lib_list_folders). */
  folders?: string[];
  load: "loading" | "loaded" | "error";
  loadError: string | null;
  refresh: () => void;
  tokenMissing: boolean;
  /** A aba fica montada e oculta ao trocar de aba do Crate: só a ativa pega o Esc. */
  active?: boolean;
  /** Os jobs moram na aba Fila do Crate (B6): o atalho troca de aba sem apagar a busca. */
  onShowQueue?: () => void;
  /** Busca pedida de fora (B28, "Buscar na Tidal" do Soulseek): `n` muda a cada pedido. */
  request?: { q: string; n: number } | null;
}

type Page =
  | { kind: "artist"; id: number; nome: string }
  | { kind: "preview"; ref: string; titulo: string; capa?: string | null };

type Flash = { text: string; tone: "ok" | "err" };

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e ?? "erro desconhecido");
}

// ── capa: data URL pelo Rust, cache por URL, no máximo 6 em voo ──────
const COVER_CACHE_MAX = 300;
/** LRU simples: a ordem de inserção do Map é a de uso (acerto reinsere). Promessa que falhou sai do cache. */
const coverCache = new Map<string, Promise<string>>();
let coverActive = 0;
const coverWaiting: (() => void)[] = [];

function loadCover(url: string): Promise<string> {
  const hit = coverCache.get(url);
  if (hit) {
    coverCache.delete(url);
    coverCache.set(url, hit);
    return hit;
  }
  const p = new Promise<void>((res) => {
    if (coverActive < 6) { coverActive++; res(); } else coverWaiting.push(() => { coverActive++; res(); });
  }).then(() => crateTidalCover(url)).finally(() => {
    coverActive--;
    coverWaiting.shift()?.();
  });
  coverCache.set(url, p);
  p.catch(() => { if (coverCache.get(url) === p) coverCache.delete(url); });
  while (coverCache.size > COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value as string);
  return p;
}

function Cover(props: { url: string | null; round?: boolean; size?: "lg" }) {
  const [src, setSrc] = createSignal<string | null>(null);
  createEffect(on(() => props.url, (u) => {
    setSrc(null);
    if (!u) return;
    loadCover(u).then((s) => { if (props.url === u) setSrc(s); }).catch(() => {});
  }));
  return (
    <span class="tdl-cover" data-round={props.round ? "true" : undefined} data-size={props.size}>
      <Show when={src()}>{(s) => <img src={s()} alt="" />}</Show>
    </span>
  );
}

// ── linhas ─────────────────────────────────────────────────────────
function Marks(props: { hires: boolean; owned: boolean }) {
  return (
    <span class="tdl-marks">
      <Show when={props.owned}>
        <span class="tdl-owned" title="Já está no acervo"><Icon name={ICONS.check} size={12} /> no acervo</span>
      </Show>
      <Show when={props.hires}>
        <span class="tdl-hires" title="Disponível em hi-res (24 bits)">Hi-Res</span>
      </Show>
    </span>
  );
}

function trackSub(t: TidalTrack): string {
  const parts = [t.artistas.join(", ")];
  if (t.album) parts.push(t.ano ? `${t.album} · ${t.ano}` : t.album);
  return parts.filter(Boolean).join(" · ");
}

/** O que a linha mostra no lugar dos botões: job da fila para este link
    (a pílula dele), envio em voo, ou nada. */
export type RowJob = { kind: "job"; job: TidalJob } | { kind: "sending" } | { kind: "sent" } | null;

function JobPill(props: { state: Exclude<RowJob, null> }) {
  return (
    <Show
      when={props.state.kind === "job" ? props.state.job : null}
      fallback={
        <Show when={props.state.kind === "sending"} fallback={<span class="crate-pill crate-pill--sub">na fila</span>}>
          <button type="button" class="crate-btn" disabled>Enviando…</button>
        </Show>
      }
    >
      {(j) => (
        <span class={`crate-pill crate-pill--${tidalStatusTone(j().status)}`} title={j().resumo || undefined}>
          {tidalStatusLabel(j().status)}
        </span>
      )}
    </Show>
  );
}

/** Em voo ou com job ativo, a linha não oferece Baixar de novo. */
function rowBusy(r: RowJob): boolean {
  return r != null && (r.kind !== "job" || isTidalActive(r.job.status));
}

function TrackRow(props: {
  t: TidalTrack;
  owned: Track | null;
  job: RowJob;
  onDownload: (t: TidalTrack) => void;
  onRadio: (t: TidalTrack) => void;
}) {
  return (
    <div class="tdl-row">
      <Cover url={props.t.capa} />
      <div class="tdl-main">
        <span class="tdl-title">{props.t.titulo}</span>
        <span class="tdl-sub">{trackSub(props.t)}</span>
      </div>
      <Marks hires={props.t.hires} owned={!!props.owned} />
      <span class="tdl-num">{formatTrackTime(props.t.duracao_s)}</span>
      <span class="tdl-acts">
        <Show when={props.job}>{(st) => <JobPill state={st()} />}</Show>
        <Show when={!rowBusy(props.job)}>
          {/* O rádio é descoberta, não download: fica também na faixa que já está no acervo. */}
          <button type="button" class="crate-btn crate-btn--quiet tdl-act--hover" title="Abre a prévia do rádio desta faixa"
            onClick={() => props.onRadio(props.t)}>
            <Icon name={ICONS.stations} size={12} /> Rádio
          </button>
          <Show
            when={props.owned}
            fallback={
              <button type="button" class="crate-btn crate-btn--lead" onClick={() => props.onDownload(props.t)}>
                <Icon name={ICONS.download} size={12} /> Baixar
              </button>
            }
          >
            {(tr) => (
              <button type="button" class="crate-btn crate-btn--lead" title="Já está no acervo" onClick={() => void playTrack(tr(), "crate")}>
                <Icon name={ICONS.play} size={12} /> Tocar
              </button>
            )}
          </Show>
        </Show>
      </span>
    </div>
  );
}

const ALBUM_TIPO: Record<string, string> = { album: "Álbum", ep: "EP", single: "Single" };

function AlbumRow(props: { a: TidalAlbum; job: RowJob; onOpen: (a: TidalAlbum) => void; onDownload: (a: TidalAlbum) => void }) {
  const sub = () => [props.a.artista, props.a.ano, ALBUM_TIPO[props.a.tipo] ?? "Álbum", plural(props.a.n_faixas, "faixa", "faixas")]
    .filter(Boolean).join(" · ");
  return (
    <div class="tdl-row tdl-row--link" onClick={() => props.onOpen(props.a)}>
      <Cover url={props.a.capa} />
      <div class="tdl-main">
        <span class="tdl-title">{props.a.titulo}</span>
        <span class="tdl-sub">{sub()}</span>
      </div>
      <Marks hires={props.a.hires} owned={false} />
      <span class="tdl-num">{formatListTime(props.a.duracao_s)}</span>
      <span class="tdl-acts">
        <Show when={props.job}>{(st) => <JobPill state={st()} />}</Show>
        <Show when={!rowBusy(props.job)}>
          <button type="button" class="crate-btn crate-btn--quiet tdl-act--hover" onClick={(e) => { e.stopPropagation(); props.onOpen(props.a); }}>
            Escolher faixas
          </button>
          <button type="button" class="crate-btn crate-btn--lead" onClick={(e) => { e.stopPropagation(); props.onDownload(props.a); }}>
            <Icon name={ICONS.download} size={12} /> Baixar
          </button>
        </Show>
      </span>
    </div>
  );
}

function ArtistRow(props: { a: TidalArtist; onOpen: (a: TidalArtist) => void }) {
  return (
    <button type="button" class="tdl-row tdl-row--link tdl-row--btn" onClick={() => props.onOpen(props.a)}>
      <Cover url={props.a.foto} round />
      <span class="tdl-main">
        <span class="tdl-title">{props.a.nome}</span>
        <span class="tdl-sub">Artista</span>
      </span>
      <span />
      <span />
      <span class="tdl-acts"><Icon name={ICONS.chevronRight} size={14} /></span>
    </button>
  );
}

function PlaylistRow(props: { p: TidalPlaylist; onOpen: (p: TidalPlaylist) => void }) {
  const sub = () => [plural(props.p.n_faixas, "faixa", "faixas"), props.p.autor].filter(Boolean).join(" · ");
  return (
    <button type="button" class="tdl-row tdl-row--link tdl-row--btn" onClick={() => props.onOpen(props.p)}>
      <Cover url={props.p.capa} />
      <span class="tdl-main">
        <span class="tdl-title">{props.p.titulo}</span>
        <span class="tdl-sub">{sub()}</span>
      </span>
      <span />
      <span class="tdl-num">{formatListTime(props.p.duracao_s)}</span>
      <span class="tdl-acts"><Icon name={ICONS.chevronRight} size={14} /></span>
    </button>
  );
}

function Section(props: { title: string; count: number; children: any; more?: any }) {
  return (
    <section class="tdl-sec">
      <h3 class="tdl-sec__h">{props.title} <span class="tdl-sec__n">{props.count}</span></h3>
      <div class="tdl-list">{props.children}</div>
      {props.more}
    </section>
  );
}

// ── página do artista ──────────────────────────────────────────────
const EPS_VISIBLE = 20;

function ArtistView(props: {
  page: { id: number; nome: string };
  backLabel: string;
  onBack: () => void;
  ownedOf: (t: TidalTrack) => Track | null;
  jobOf: (url: string) => RowJob;
  onTrackDownload: (t: TidalTrack) => void;
  onTrackRadio: (t: TidalTrack) => void;
  onAlbumOpen: (a: TidalAlbum) => void;
  onAlbumDownload: (a: TidalAlbum) => void;
  onPreview: (ref: string, titulo: string) => void;
}) {
  const [data, setData] = createSignal<TidalArtistPage | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [allEps, setAllEps] = createSignal(false);
  let alive = true;
  onCleanup(() => { alive = false; });
  function load() {
    setErr(null);
    crateTidalArtist(props.page.id).then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setErr(errText(e)); });
  }
  onMount(load);
  const eps = () => (allEps() ? data()?.eps_singles ?? [] : (data()?.eps_singles ?? []).slice(0, EPS_VISIBLE));
  return (
    <div class="tdl-page">
      <header class="tdl-head" data-poster="true">
        <div class="tdl-head__back">
          <button type="button" class="crate-btn crate-btn--quiet" onClick={props.onBack} title="Voltar (Esc)">
            <Icon name={ICONS.chevronLeft} size={12} /> {props.backLabel}
          </button>
        </div>
        <Cover url={data()?.foto ?? null} round size="lg" />
        <div class="tdl-main">
          <span class="tdl-title tdl-title--page">{data()?.nome ?? props.page.nome}</span>
          <span class="tdl-sub tdl-num-inline">
            <Show when={data()} fallback="carregando…">
              {(d) => `${plural(d().albuns.length, "álbum", "álbuns")} · ${plural(d().eps_singles.length, "EP ou single", "EPs e singles")}`}
            </Show>
          </span>
        </div>
        <Show when={data()?.radio}>
          {(r) => (
            <button type="button" class="crate-btn"
              onClick={() => props.onPreview(`mix:${r().mix_id}`, `Rádio de ${data()!.nome}`)}>
              <Icon name={ICONS.stations} size={12} /> Rádio do artista
              <span class="tdl-num">{r().n_faixas}</span>
            </button>
          )}
        </Show>
      </header>

      <Show when={err()}>
        <div class="crate-banner" data-tone="rose" role="alert">
          <Icon name={ICONS.alert} size={15} />
          <p>{err()}</p>
          <span class="crate-banner__sp" />
          <button type="button" class="crate-banner__act" onClick={load}>Tentar de novo</button>
        </div>
      </Show>

      <Show when={data()} fallback={<Show when={!err()}><div class="tdl-placeholder" aria-busy="true" /></Show>}>
        {(d) => (
          <>
            <Show when={d().populares.length > 0}>
              <Section title="Populares" count={d().populares.length}>
                <For each={d().populares}>
                  {(t) => <TrackRow t={t} owned={props.ownedOf(t)} job={props.jobOf(t.url)} onDownload={props.onTrackDownload} onRadio={props.onTrackRadio} />}
                </For>
              </Section>
            </Show>
            <Show when={d().albuns.length > 0}>
              <Section title="Álbuns" count={d().albuns.length}>
                <For each={d().albuns}>{(a) => <AlbumRow a={a} job={props.jobOf(a.url)} onOpen={props.onAlbumOpen} onDownload={props.onAlbumDownload} />}</For>
              </Section>
            </Show>
            <Show when={d().eps_singles.length > 0}>
              <Section
                title="EPs e singles"
                count={d().eps_singles.length}
                more={
                  <Show when={!allEps() && d().eps_singles.length > EPS_VISIBLE}>
                    <button type="button" class="crate-btn crate-btn--quiet tdl-more" onClick={() => setAllEps(true)}>
                      Mostrar todos <span class="tdl-num">{d().eps_singles.length}</span>
                    </button>
                  </Show>
                }
              >
                <For each={eps()}>{(a) => <AlbumRow a={a} job={props.jobOf(a.url)} onOpen={props.onAlbumOpen} onDownload={props.onAlbumDownload} />}</For>
              </Section>
            </Show>
            <Show when={!d().populares.length && !d().albuns.length && !d().eps_singles.length}>
              <div class="crate-empty">
                <Icon name={ICONS.search} size={26} />
                <h3>A Tidal não tem faixas deste artista</h3>
                <p>Nem populares, nem álbuns, nem EPs. Volte à busca e tente outro nome.</p>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

// ── prévia com seleção ─────────────────────────────────────────────
const TIPO_LABEL: Record<TidalPreview["tipo"], string> = {
  radio: "Rádio", mix: "Mix", playlist: "Playlist", album: "Álbum", faixa: "Faixa",
};

function PreviewView(props: {
  page: { ref: string; titulo: string; capa?: string | null };
  backLabel: string;
  onBack: () => void;
  owned: OwnedIndex;
  dest: () => string;
  destPicker: any;
  tokenMissing: boolean;
  /** Um pedido (até 200 faixas). Devolve null se foi para a fila, ou o texto do erro. */
  onEnqueue: (ids: number[], titulo: string, ref: string) => Promise<string | null>;
  /** Todos os pedidos foram: aviso e volta. */
  onSent: (count: number, titulo: string, parts: number) => void;
}) {
  const [data, setData] = createSignal<TidalPreview | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [sel, setSel] = createSignal<Set<number>>(new Set());
  const [touched, setTouched] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [sendErr, setSendErr] = createSignal<string | null>(null);
  let alive = true;
  let listEl: HTMLDivElement | undefined;
  let rootEl: HTMLDivElement | undefined;
  onCleanup(() => { alive = false; });

  const ownedIds = createMemo(() => {
    const ids = new Set<number>();
    for (const t of data()?.faixas ?? []) if (findOwned(t, props.owned)) ids.add(t.id);
    return ids;
  });
  // Seleção padrão = tudo menos o acervo; refeita se o índice do acervo
  // chegar depois da prévia, enquanto o CEO não mexeu em nada.
  createEffect(() => {
    const d = data();
    const owned = ownedIds();
    if (d && !touched()) setSel(defaultSelection(d.faixas, (id) => owned.has(id)));
  });

  function load() {
    setErr(null);
    crateTidalPreview(props.page.ref).then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setErr(errText(e)); });
  }
  onMount(() => {
    load();
    rootEl?.focus({ preventScroll: true }); // o Ctrl+A da prévia vale logo, sem clicar numa caixa
  });

  /** Marca (`on`) ou desmarca as `ids` de uma vez. */
  function setMany(ids: number[], on: boolean) {
    setTouched(true);
    setSendErr(null);
    setSel((s) => {
      const n = new Set(s);
      for (const id of ids) if (on) n.add(id); else n.delete(id);
      return n;
    });
  }

  // ── seleção em massa (B27) ──
  // Shift+clique: intervalo da última caixa clicada até esta, com o estado
  // novo da clicada. Arrastar: começa na coluna da caixa (pointerdown), e
  // cada linha em que o ponteiro entra recebe o estado oposto ao da primeira;
  // linha pulada num movimento rápido entra junto (intervalo desde a última
  // pintada). Um clique simples, sem sair da linha, segue o caminho normal.
  let anchor: number | null = null;
  let shiftDown = false;
  let drag: { start: number; on: boolean; last: number; painted: boolean } | null = null;
  let swallowClick = false;
  const faixas = () => data()?.faixas ?? [];

  function onBoxClick(e: MouseEvent & { currentTarget: HTMLInputElement }, id: number) {
    const shift = e.shiftKey || shiftDown;
    shiftDown = false;
    if (swallowClick) {
      // O arrasto já pintou esta caixa: o clique que fecha o gesto não desfaz.
      e.preventDefault();
      swallowClick = false;
      return;
    }
    const on = e.currentTarget.checked;
    setMany(shift && anchor != null ? rangeIds(faixas(), anchor, id) : [id], on);
    anchor = id;
  }

  function onPickDown(e: PointerEvent, id: number) {
    if (e.button > 0) return; // só o botão principal (ou toque)
    drag = { start: id, on: !sel().has(id), last: id, painted: false };
  }

  function onRowEnter(e: PointerEvent, id: number) {
    if (!drag) return;
    if (e.buttons === 0) { drag = null; return; } // soltou fora da janela
    if (id === drag.last) return;
    if (!drag.painted) {
      drag.painted = true;
      setMany([drag.start], drag.on);
    }
    setMany(rangeIds(faixas(), drag.last, id), drag.on);
    drag.last = id;
    anchor = id;
  }

  function endDrag() {
    if (drag?.painted) {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 0);
    }
    drag = null;
  }
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  onCleanup(() => {
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
  });
  const all = () => { setTouched(true); setSendErr(null); setSel(new Set((data()?.faixas ?? []).map((t) => t.id))); };
  const none = () => { setTouched(true); setSendErr(null); setSel(new Set<number>()); };
  const onlyNew = () => { setTouched(true); setSendErr(null); setSel(defaultSelection(data()?.faixas ?? [], (id) => ownedIds().has(id))); };

  const chosen = createMemo(() => (data()?.faixas ?? []).filter((t) => sel().has(t.id)));
  const est = createMemo(() => estimateSelection(chosen()));
  /** Pedidos que o Baixar vai mandar (B27): até 200 faixas cada. */
  const parts = () => Math.ceil(est().count / MAX_SELECTION);
  /** Álbum: todas as linhas teriam a mesma capa; o número da faixa ocupa o lugar. */
  const noRowCover = () => data()?.tipo === "album";
  const posterUrl = () => props.page.capa ?? (data()?.tipo === "album" ? data()?.faixas[0]?.capa ?? null : null);
  const poster = () => !!props.page.capa || data()?.tipo === "album" || data()?.tipo === "playlist";

  /** Ctrl/Cmd+A em qualquer ponto da prévia marca todas, menos dentro de um campo de texto ou
      seletor (ali é o do próprio campo). */
  function onPageKey(e: KeyboardEvent) {
    if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a")) return;
    const el = e.target as HTMLElement | null;
    const campo = el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || !!el?.isContentEditable
      || (el instanceof HTMLInputElement && el.type !== "checkbox");
    if (campo) return;
    e.preventDefault();
    e.stopPropagation();
    all();
  }

  function onListKey(e: KeyboardEvent) {
    const boxes = listEl ? [...listEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]")] : [];
    const i = boxes.indexOf(document.activeElement as HTMLInputElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const next = e.key === "ArrowDown" ? Math.min(boxes.length - 1, i + 1) : Math.max(0, i - 1);
      boxes[next]?.focus();
    }
  }

  /** Manda a seleção em pedidos de até 200, um depois do outro. Se um falha,
      o que já foi sai da seleção e o resto fica marcado para tentar de novo. */
  async function send() {
    const d = data();
    if (!d || sending()) return;
    const ids = orderedSelection(d.faixas, sel());
    if (!ids.length) return;
    const lotes = chunkIds(ids);
    setSending(true);
    setSendErr(null);
    try {
      const sent: number[] = [];
      for (let i = 0; i < lotes.length; i++) {
        const err = await props.onEnqueue(lotes[i], partTitle(d.titulo, i, lotes.length), d.ref);
        if (err) {
          if (!alive) return;
          if (sent.length) setMany(sent, false);
          setSendErr(sent.length
            ? `${i} de ${lotes.length} pedidos foram para a fila (${plural(sent.length, "faixa", "faixas")}); as que faltam continuam marcadas. ${err}`
            : err);
          return;
        }
        sent.push(...lotes[i]);
      }
      if (alive) props.onSent(ids.length, d.titulo, lotes.length);
    } finally {
      if (alive) setSending(false);
    }
  }

  return (
    <div class="tdl-page tdl-page--preview" ref={rootEl} tabindex="-1" onKeyDown={onPageKey}>
      <header class="tdl-head" data-poster={poster() ? "true" : undefined}>
        <div class="tdl-head__back">
          <button type="button" class="crate-btn crate-btn--quiet" onClick={props.onBack} title="Voltar (Esc)">
            <Icon name={ICONS.chevronLeft} size={12} /> {props.backLabel}
          </button>
        </div>
        <Show when={poster()}>
          <Cover url={posterUrl()} size="lg" />
        </Show>
        <div class="tdl-main">
          <span class="tdl-title" classList={{ "tdl-title--page": poster() }}>{data()?.titulo ?? props.page.titulo}</span>
          <span class="tdl-sub">
            <Show when={data()} fallback="carregando…">
              {(d) => (
                <>
                  {TIPO_LABEL[d().tipo] ?? "Lista"} · <span class="tdl-num-inline">{plural(d().faixas.length, "faixa", "faixas")}</span>
                  {" · "}<span class="tdl-num-inline">{formatListTime(d().duracao_s)}</span>
                </>
              )}
            </Show>
          </span>
        </div>
      </header>

      <Show when={err()}>
        <div class="crate-banner" data-tone="rose" role="alert">
          <Icon name={ICONS.alert} size={15} />
          <p>{err()}</p>
          <span class="crate-banner__sp" />
          <button type="button" class="crate-banner__act" onClick={load}>Tentar de novo</button>
        </div>
      </Show>

      <Show when={data()} fallback={<Show when={!err()}><div class="tdl-placeholder" aria-busy="true" /></Show>}>
        {(d) => (
          <>
            <div class="tdl-tools">
              <button type="button" class="crate-btn crate-btn--quiet" onClick={all} title={`Marcar todas (${modCombo("A")})`}>
                Marcar todas
              </button>
              <button type="button" class="crate-btn crate-btn--quiet" onClick={none}>Desmarcar todas</button>
              <button type="button" class="crate-btn crate-btn--quiet" onClick={onlyNew}>Só as novas</button>
              <span class="tdl-tools__sp" />
              <Show when={ownedIds().size > 0}>
                <span class="tdl-sub"><span class="tdl-num-inline">{ownedIds().size}</span> já no acervo</span>
              </Show>
            </div>
            <Show when={d().faixas.length === 0}>
              <div class="crate-empty">
                <Icon name={ICONS.search} size={26} />
                <h3>Nenhuma faixa disponível nesta lista</h3>
                <p>A Tidal devolveu a lista vazia: as faixas podem ter saído do catálogo.</p>
              </div>
            </Show>
            <div class="tdl-list" ref={listEl} onKeyDown={onListKey} data-nocover={noRowCover() ? "true" : undefined}>
              <For each={d().faixas}>
                {(t, i) => (
                  <label
                    class="tdl-row tdl-row--pick"
                    data-off={sel().has(t.id) ? undefined : "true"}
                    onPointerDown={(e) => { shiftDown = e.shiftKey; }}
                    onPointerEnter={(e) => onRowEnter(e, t.id)}
                  >
                    <span class="tdl-pick" onPointerDown={(e) => onPickDown(e, t.id)}>
                      <input type="checkbox" checked={sel().has(t.id)} onClick={(e) => onBoxClick(e, t.id)} />
                    </span>
                    <Show when={!noRowCover()} fallback={<span class="tdl-pos">{i() + 1}</span>}>
                      <Cover url={t.capa} />
                    </Show>
                    <span class="tdl-main">
                      <span class="tdl-title">{t.titulo}</span>
                      <span class="tdl-sub">{trackSub(t)}</span>
                    </span>
                    <Marks hires={t.hires} owned={ownedIds().has(t.id)} />
                    <span class="tdl-num">{formatTrackTime(t.duracao_s)}</span>
                  </label>
                )}
              </For>
            </div>
            <footer class="tdl-foot">
              <Show when={sendErr()}>
                {(e) => (
                  <p class="tdl-flash tdl-foot__err" data-tone="err" role="alert"><Icon name={ICONS.alert} size={12} />{e()}</p>
                )}
              </Show>
              <span class="tdl-foot__sum">
                <span class="tdl-num-inline">{est().count} de {d().faixas.length}</span>
                {" · "}<span class="tdl-num-inline">{formatSize(est().bytes)}</span>
                {" · "}<span class="tdl-num-inline">{formatEta(est().seconds)}</span>
                <Show when={parts() > 1}>
                  {" · "}<span class="tdl-foot__parts">vai em {parts()} pedidos de até {MAX_SELECTION}</span>
                </Show>
              </span>
              <span class="tdl-tools__sp" />
              {props.destPicker}
              <button
                type="button"
                class="crate-btn crate-btn--primary"
                disabled={sending() || est().count === 0 || !props.dest() || props.tokenMissing}
                onClick={() => void send()}
              >
                <Icon name={ICONS.download} size={12} />
                {sending() ? "Enviando…" : est().count === 0 ? "Baixar" : `Baixar ${est().count}`}
              </button>
            </footer>
          </>
        )}
      </Show>
    </div>
  );
}

// ── aba ────────────────────────────────────────────────────────────
/** Mesmo texto de `OFFLINE_MSG` em src-tauri/src/slsk/tidal_fila.rs (fallback quando o erro vem vazio). */
const FILA_OFFLINE = "A fila da Tidal na VM não respondeu. Sem ela não dá para baixar.";
type SectionKey = "faixas" | "albuns" | "artistas" | "playlists";
const TOP_SECTION: Record<string, SectionKey> = { faixa: "faixas", album: "albuns", artista: "artistas", playlist: "playlists" };

export default function TidalTab(props: Props) {
  const [text, setText] = createSignal("");
  const kind = createMemo(() => classifyTidalInput(text()));
  // Memória única do Crate (B7): a mesma pasta da aba Buscar.
  const [dest, setDest] = createSignal(loadLastDest() ?? "");
  const [destOpen, setDestOpen] = createSignal<"top" | "foot" | null>(null);
  const resolvedDest = () => dest();
  const allFolders = createMemo(() => mergeFolders(props.pastas, props.folders ?? []));
  const [submitting, setSubmitting] = createSignal(false);
  const [flash, setFlash] = createSignal<Flash | null>(null);

  const [result, setResult] = createSignal<TidalSearch | null>(null);
  const [searchState, setSearchState] = createSignal<"idle" | "loading" | "done" | "error">("idle");
  const [searchError, setSearchError] = createSignal<string | null>(null);
  const seq = latestOnly();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const [stack, setStack] = createSignal<Page[]>([]);
  const page = () => stack()[stack().length - 1] ?? null;
  // A página do artista que originou a prévia continua montada (oculta): "Mostrar todos" e a
  // rolagem sobrevivem ao ir e voltar.
  const artistRoot = () => {
    const f = stack()[0];
    return f?.kind === "artist" ? f : null;
  };
  let rootEl: HTMLDivElement | undefined;
  let savedScroll = 0;
  /** Quem rola a aba: o ancestral com overflow-y auto/scroll mais próximo. */
  function scroller(): HTMLElement | null {
    for (let el = rootEl?.parentElement ?? null; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") return el;
    }
    return null;
  }
  const backLabel = () => {
    const s = stack();
    const below = s[s.length - 2];
    if (!below) return "Busca";
    return below.kind === "artist" ? below.nome : below.titulo;
  };

  // "No acervo" (A16): recarrega quando a biblioteca muda (Mover) e quando
  // um job da Tidal termina (o que chegou deixa de ser "novo"). Falha não
  // some em silêncio: sem o índice, tudo pareceria novo.
  const [owned, setOwned] = createSignal<OwnedIndex>(new Map());
  const [ownedFailed, setOwnedFailed] = createSignal(false);
  const doneJobs = createMemo(() => props.jobs.filter((j) => j.status === "ok" || j.status === "parcial").length);
  let ownedSeq = 0;
  createEffect(on([libraryRevision, doneJobs], () => {
    const seq = ++ownedSeq;
    libGetTracks({ limit: 100_000 })
      .then((ts) => { if (seq === ownedSeq) batch(() => { setOwned(buildOwnedIndex(ts)); setOwnedFailed(false); }); })
      .catch(() => { if (seq === ownedSeq) setOwnedFailed(true); });
  }));
  const ownedOf = (t: TidalTrack) => findOwned(t, owned());

  // Linha com job (A16): envio em voo por link, até o job aparecer na fila.
  const [sendingUrls, setSendingUrls] = createSignal<ReadonlyMap<string, "sending" | "sent">>(new Map());
  const markUrl = (url: string, st: "sending" | "sent" | null) =>
    setSendingUrls((m) => { const n = new Map(m); if (st) n.set(url, st); else n.delete(url); return n; });
  const jobByUrl = createMemo(() => {
    const m = new Map<string, TidalJob>();
    for (const j of props.jobs) if (j.url) m.set(j.url, j); // a mais nova vence (lista vem da mais antiga)
    return m;
  });
  createEffect(() => {
    const m = jobByUrl();
    for (const [url, st] of sendingUrls()) if (st === "sent" && m.has(url)) markUrl(url, null);
  });
  const jobOf = (url: string): RowJob => {
    const st = sendingUrls().get(url);
    if (st) return { kind: st };
    const j = jobByUrl().get(url);
    return j ? { kind: "job", job: j } : null;
  };

  onCleanup(() => { clearTimeout(debounce); clearTimeout(flashTimer); });

  // Esc com página aberta volta um nível (prévia -> artista -> busca).
  createEffect(() => {
    if (stack().length > 0 && props.active !== false) {
      const pop = pushEscLayer(goBack);
      onCleanup(pop);
    }
  });

  function goBack() {
    const volta = stack()[stack().length - 2];
    setStack((s) => s.slice(0, -1));
    if (volta?.kind === "artist") requestAnimationFrame(() => { const sc = scroller(); if (sc) sc.scrollTop = savedScroll; });
  }
  function push(p: Page) {
    if (page()?.kind === "artist") savedScroll = scroller()?.scrollTop ?? 0;
    setStack((s) => [...s, p]);
    requestAnimationFrame(() => { const sc = scroller(); if (sc) sc.scrollTop = 0; });
  }

  function say(text: string, tone: Flash["tone"] = "ok") {
    setFlash({ text, tone });
    clearTimeout(flashTimer);
    if (tone === "ok") flashTimer = setTimeout(() => setFlash(null), 6000);
  }

  function rememberDest(d: string) {
    saveLastDest(d);
  }

  function onInput(v: string) {
    setText(v);
    clearTimeout(debounce);
    seq.cancel(); // resposta em voo é de um texto que já não é o do campo
    if (stack().length) setStack([]);
    const k = classifyTidalInput(v);
    if (k === "text") {
      debounce = setTimeout(() => void runSearch(v.trim()), SEARCH_DEBOUNCE_MS);
    } else {
      // vazio, link ou curto demais: some o resultado velho (e o "buscando…" de quem foi descartado)
      batch(() => { setResult(null); setSearchState("idle"); setSearchError(null); });
    }
  }

  async function runSearch(q: string) {
    clearTimeout(debounce);
    const t = seq.next();
    setSearchState("loading");
    setSearchError(null);
    try {
      const r = await crateTidalSearch(q);
      if (!seq.isCurrent(t)) return; // resposta de uma busca já trocada
      batch(() => { setResult(r); setSearchState("done"); });
    } catch (e) {
      if (!seq.isCurrent(t)) return;
      batch(() => { setSearchError(errText(e)); setSearchState("error"); });
    }
  }

  function clearAll() {
    clearTimeout(debounce);
    seq.cancel();
    batch(() => {
      setText(""); setResult(null); setSearchState("idle"); setSearchError(null); setStack([]);
    });
  }

  async function enqueueLink(url: string, label: string) {
    const d = resolvedDest();
    if (!d) { say("Escolha a pasta de destino antes de baixar.", "err"); setDestOpen("top"); return false; }
    if (sendingUrls().get(url) === "sending") return false;
    markUrl(url, "sending");
    try {
      await crateTidalEnqueue(url, d);
      rememberDest(d);
      markUrl(url, "sent");
      say(`${label} foi para a fila (${d}).`);
      props.refresh();
      return true;
    } catch (e) {
      markUrl(url, null);
      say(errText(e), "err");
      return false;
    }
  }

  /** Um pedido de seleção (até 200). null = foi para a fila; texto = erro, que a
      prévia mostra junto do rodapé (o aviso do topo fica fora da vista). */
  async function enqueueSelection(ids: number[], titulo: string, ref: string): Promise<string | null> {
    const d = resolvedDest();
    if (!d) return "Escolha a pasta de destino antes de baixar.";
    try {
      await crateTidalEnqueueSelection(ids, titulo, ref, d);
      rememberDest(d);
      props.refresh();
      return null;
    } catch (e) {
      return errText(e);
    }
  }

  function selectionSent(count: number, titulo: string, parts: number) {
    const em = parts > 1 ? ` em ${parts} pedidos` : "";
    say(`${plural(count, "faixa", "faixas")} de "${titulo}" foram para a fila${em} (${resolvedDest()}).`);
    goBack();
  }

  async function onSubmit(e: Event) {
    e.preventDefault();
    const k = kind();
    if (k === "text") { void runSearch(text().trim()); return; }
    if (k !== "link" || submitting()) return;
    setSubmitting(true);
    const ok = await enqueueLink(text().trim(), "O link");
    setSubmitting(false);
    if (ok) setText("");
  }

  function onInputKey(e: KeyboardEvent) {
    if (e.key === "Escape" && stack().length === 0 && text()) {
      e.preventDefault();
      clearAll();
    }
  }

  // ações das linhas
  const trackDownload = (t: TidalTrack) => void enqueueLink(t.url, `"${t.titulo}"`);
  const trackRadio = (t: TidalTrack) => push({ kind: "preview", ref: `radio-faixa:${t.id}`, titulo: `Rádio de ${t.titulo}` });
  const albumOpen = (a: TidalAlbum) => push({ kind: "preview", ref: `album:${a.id}`, titulo: `${a.artista} - ${a.titulo}`, capa: a.capa });
  const albumDownload = (a: TidalAlbum) => void enqueueLink(a.url, `"${a.titulo}"`);
  const artistOpen = (a: TidalArtist) => push({ kind: "artist", id: a.id, nome: a.nome });
  const playlistOpen = (p: TidalPlaylist) => push({ kind: "preview", ref: `playlist:${p.id}`, titulo: p.titulo, capa: p.capa });
  const openPreview = (ref: string, titulo: string) => push({ kind: "preview", ref, titulo });

  const sectionOrder = createMemo<SectionKey[]>(() => {
    const base: SectionKey[] = ["faixas", "albuns", "artistas", "playlists"];
    const top = result()?.top?.tipo;
    const first = top ? TOP_SECTION[top] : undefined;
    return first ? [first, ...base.filter((k) => k !== first)] : base;
  });
  const isEmptyResult = () => {
    const r = result();
    return !!r && !r.faixas.length && !r.albuns.length && !r.artistas.length && !r.playlists.length;
  };
  const activeJobs = () => props.jobs.filter((j) => isTidalActive(j.status)).length;
  /** Os jobs moram na aba Fila (B6): aqui só a contagem e o atalho, que não apaga a busca. */
  const queueNote = () => (
    <Show when={activeJobs() > 0 || ownedFailed()}>
      <p class="tdl-sub tdl-queue-note">
        <Show when={activeJobs() > 0}>
          <span class="tdl-num-inline">{plural(activeJobs(), "download da Tidal", "downloads da Tidal")}</span> em andamento.{" "}
          <Show when={props.onShowQueue}>
            <button type="button" class="tdl-linkbtn" onClick={() => props.onShowQueue?.()}>Ver na Fila</button>
          </Show>
        </Show>
        <Show when={ownedFailed()}>
          {" "}Não consegui ler o acervo: o “no acervo” pode faltar nas linhas.
        </Show>
      </p>
    </Show>
  );
  /** A fila da VM não respondeu: um banner só (a busca passa pela mesma fila), campo apagado. */
  const offline = () => props.load === "error";
  const locked = () => props.tokenMissing || offline();
  /** "Tentar de novo" do banner da fila: refaz o poll e, se havia texto de busca, a última busca. */
  function retryFila() {
    props.refresh();
    if (kind() === "text") void runSearch(text().trim());
  }

  const destPicker = (where: "top" | "foot") => (
    <FolderPicker
      variant="toolbar"
      value={dest() || null}
      placeholder="escolher pasta"
      warn={!dest()}
      title="Pasta de destino em ~/Music"
      folders={allFolders()}
      disabled={locked()}
      open={destOpen() === where}
      onToggle={() => setDestOpen((o) => (o === where ? null : where))}
      onClose={() => setDestOpen(null)}
      onPick={(f) => { batch(() => { setDest(f); setDestOpen(null); }); saveLastDest(f); }}
    />
  );

  // Pedido de busca de fora (B28): o texto entra no campo e a busca sai já.
  createEffect(on(() => props.request, (r) => {
    if (!r || !r.q.trim()) return;
    setStack([]);
    setText(r.q);
    if (classifyTidalInput(r.q) === "text") void runSearch(r.q.trim());
  }));

  return (
    <div class="crate-tidal tdl" ref={rootEl}>
      <form class="crate-tidal-form" onSubmit={(e) => void onSubmit(e)}>
        <div class="crate-tidal-form__row">
          <div class="tdl-field" data-busy={searchState() === "loading" ? "true" : undefined}>
            <Icon name={ICONS.search} size={16} />
            <input
              type="text"
              class="crate-tidal-input tdl-field__input"
              placeholder="Busque faixa, álbum, artista ou playlist, ou cole um link da Tidal"
              aria-label="Buscar na Tidal ou colar link"
              value={text()}
              disabled={locked()}
              onInput={(e) => onInput(e.currentTarget.value)}
              onKeyDown={onInputKey}
              autocomplete="off"
              spellcheck={false}
            />
            <span class="tdl-field__state" aria-live="polite">
              {searchState() === "loading" ? "buscando…" : ""}
            </span>
          </div>
          <button
            type="submit"
            class="crate-btn crate-btn--primary"
            disabled={
              locked() || submitting()
              || (kind() === "link" ? !resolvedDest() : kind() !== "text")
            }
          >
            <Show when={kind() === "link"} fallback={<><Icon name={ICONS.search} size={12} /> Buscar</>}>
              <Icon name={ICONS.download} size={12} /> {submitting() ? "Enviando…" : "Baixar"}
            </Show>
          </button>
          {destPicker("top")}
        </div>
        <Show when={flash()}>
          {(f) => (
            <p class="tdl-flash" data-tone={f().tone} role={f().tone === "err" ? "alert" : "status"}>
              <Icon name={f().tone === "err" ? ICONS.alert : ICONS.check} size={12} />
              {f().text}
            </p>
          )}
        </Show>
      </form>

      <Show when={props.tokenMissing}>
        <div class="crate-banner" data-tone="amber">
          <Icon name={ICONS.alert} size={15} />
          <p>
            Sem token da fila: configure <code>~/.secrets/telemetria-token.txt</code>{" "}
            (ou <code>RUSTIFY_TIDAL_FILA_TOKEN_FILE</code> para outro caminho).
          </p>
        </div>
      </Show>

      <Show when={offline()}>
        <div class="crate-banner" data-tone="rose" role="alert" title="Endereço da fila e motivo no log do app">
          <Icon name={ICONS.alert} size={15} />
          <p>{props.loadError ?? FILA_OFFLINE}</p>
          <span class="crate-banner__sp" />
          <button type="button" class="crate-banner__act" onClick={retryFila}>Tentar de novo</button>
        </div>
      </Show>

      <Show when={artistRoot()} keyed>
        {(p) => (
          <div style={{ display: page() === p ? "contents" : "none" }}>
            <ArtistView
              page={p}
              backLabel="Busca"
              onBack={goBack}
              ownedOf={ownedOf}
              jobOf={jobOf}
              onTrackDownload={trackDownload}
              onTrackRadio={trackRadio}
              onAlbumOpen={albumOpen}
              onAlbumDownload={albumDownload}
              onPreview={openPreview}
            />
          </div>
        )}
      </Show>

      <Switch>
        <Match when={page()?.kind === "preview" && (page() as Extract<Page, { kind: "preview" }>)} keyed>
          {(p) => (
            <PreviewView
              page={p}
              backLabel={backLabel()}
              onBack={goBack}
              owned={owned()}
              dest={resolvedDest}
              destPicker={destPicker("foot")}
              tokenMissing={props.tokenMissing}
              onEnqueue={enqueueSelection}
              onSent={selectionSent}
            />
          )}
        </Match>
        <Match when={stack().length > 0}>{null}</Match>
        <Match when={kind() === "text" || kind() === "short" ? result() || searchState() !== "idle" : false}>
          {queueNote()}
          <Show when={searchState() === "error" && !offline()}>
            <div class="crate-banner" data-tone="rose" role="alert">
              <Icon name={ICONS.alert} size={15} />
              <p>{searchError()}</p>
              <span class="crate-banner__sp" />
              <button type="button" class="crate-banner__act" onClick={() => void runSearch(text().trim())}>
                Tentar de novo
              </button>
            </div>
          </Show>
          <Show when={isEmptyResult()}>
            <div class="crate-empty-wrap">
              <div class="crate-empty">
                <Icon name={ICONS.search} size={26} />
                <h3>Nada encontrado para "{result()!.q}"</h3>
                <p>Confira a grafia, tente só o nome do artista ou cole o link da Tidal.</p>
              </div>
            </div>
          </Show>
          <Show when={!result() && searchState() === "loading"}>
            <div class="tdl-placeholder" aria-busy="true" />
          </Show>
          <Show when={result() && !isEmptyResult()}>
            <div class="tdl-results" data-stale={searchState() === "loading" ? "true" : undefined}>
              <For each={sectionOrder()}>
                {(key) => (
                  <Switch>
                    <Match when={key === "faixas" && result()!.faixas.length > 0}>
                      <Section title="Faixas" count={result()!.faixas.length}>
                        <For each={result()!.faixas}>
                          {(t) => <TrackRow t={t} owned={ownedOf(t)} job={jobOf(t.url)} onDownload={trackDownload} onRadio={trackRadio} />}
                        </For>
                      </Section>
                    </Match>
                    <Match when={key === "albuns" && result()!.albuns.length > 0}>
                      <Section title="Álbuns" count={result()!.albuns.length}>
                        <For each={result()!.albuns}>{(a) => <AlbumRow a={a} job={jobOf(a.url)} onOpen={albumOpen} onDownload={albumDownload} />}</For>
                      </Section>
                    </Match>
                    <Match when={key === "artistas" && result()!.artistas.length > 0}>
                      <Section title="Artistas" count={result()!.artistas.length}>
                        <For each={result()!.artistas}>{(a) => <ArtistRow a={a} onOpen={artistOpen} />}</For>
                      </Section>
                    </Match>
                    <Match when={key === "playlists" && result()!.playlists.length > 0}>
                      <Section title="Playlists" count={result()!.playlists.length}>
                        <For each={result()!.playlists}>{(p) => <PlaylistRow p={p} onOpen={playlistOpen} />}</For>
                      </Section>
                    </Match>
                  </Switch>
                )}
              </For>
            </div>
          </Show>
        </Match>
        <Match when={true}>
          {/* Convite só com o campo usável (A25): com a VM fora ou sem token,
              o banner acima já diz o que falta. */}
          <Show when={!locked()}>
            <Show when={props.load !== "loading" || props.jobs.length > 0} fallback={<div class="tdl-placeholder" aria-busy="true" />}>
              <div class="crate-empty-wrap">
                <div class="crate-empty">
                  <Icon name={ICONS.search} size={26} />
                  <h3>Cole um link da Tidal ou busque por faixa, álbum, artista ou playlist</h3>
                  <p>Rádio, playlist e álbum abrem uma prévia para você escolher as faixas.</p>
                </div>
              </div>
            </Show>
          </Show>
          {queueNote()}
        </Match>
      </Switch>
    </div>
  );
}
