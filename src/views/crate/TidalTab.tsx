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
       [ lupa | campo único ............ buscando… ] [pasta v] [Buscar|Baixar]
       aviso de uma linha (foi para a fila / erro)
       home: estado vazio + jobs da fila
       busca: seções (o "top" primeiro) Faixas / Álbuns / Artistas /
              Playlists; linha = capa 40 | título + sub | marcas |
              duração | ações
       artista: [< Busca] foto Nome · contagens [Rádio do artista]
                Populares / Álbuns / EPs e singles
       prévia:  [< voltar] Título · tipo · n faixas · duração
                Marcar todas · Desmarcar todas · Só as novas
                [x] capa | título + sub | marcas | duração
                rodapé fixo: 18 de 100 · ~1,1 GB · ~6 min [pasta v] [Baixar]
   ============================================================ */

import {
  createSignal, createMemo, createEffect, on, For, Show, Switch, Match, onMount, onCleanup, batch,
} from "solid-js";
import {
  crateTidalEnqueue, crateTidalEnqueueSelection, crateTidalSearch, crateTidalArtist, crateTidalPreview,
  crateTidalCover, libGetTracks,
  type TidalJob, type TidalSearch, type TidalTrack, type TidalAlbum, type TidalArtist, type TidalPlaylist,
  type TidalArtistPage, type TidalPreview,
} from "../../tauri";
import {
  shortTidalLink, tidalStatusLabel, tidalStatusTone, loadLastTidalDest, saveLastTidalDest,
} from "../../lib/tidalFila";
import {
  classifyTidalInput, estimateSelection, formatSize, formatEta, formatTrackTime, formatListTime, plural,
  buildOwnedIndex, findOwned, defaultSelection, orderedSelection, latestOnly, SEARCH_DEBOUNCE_MS,
  type OwnedIndex,
} from "../../lib/tidalSearch";
import { pushEscLayer } from "../../lib/escLayers";
import { modCombo } from "../../lib/keyboard";
import { Icon, ICONS } from "../../components/Icon";
import { CopyLinkButton } from "./CopyLinkButton";

interface Props {
  jobs: TidalJob[];
  pastas: string[];
  load: "loading" | "loaded" | "error";
  loadError: string | null;
  refresh: () => void;
  tokenMissing: boolean;
}

type Page =
  | { kind: "artist"; id: number; nome: string }
  | { kind: "preview"; ref: string; titulo: string };

type Flash = { text: string; tone: "ok" | "err" };

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e ?? "erro desconhecido");
}

// ── capa: data URL pelo Rust, cache por URL, no máximo 6 em voo ──────
const coverCache = new Map<string, Promise<string>>();
let coverActive = 0;
const coverWaiting: (() => void)[] = [];

function loadCover(url: string): Promise<string> {
  const hit = coverCache.get(url);
  if (hit) return hit;
  const p = new Promise<void>((res) => {
    if (coverActive < 6) { coverActive++; res(); } else coverWaiting.push(() => { coverActive++; res(); });
  }).then(() => crateTidalCover(url)).finally(() => {
    coverActive--;
    coverWaiting.shift()?.();
  });
  coverCache.set(url, p);
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

function TrackRow(props: {
  t: TidalTrack;
  owned: boolean;
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
      <Marks hires={props.t.hires} owned={props.owned} />
      <span class="tdl-num">{formatTrackTime(props.t.duracao_s)}</span>
      <span class="tdl-acts">
        <button type="button" class="crate-btn crate-btn--quiet" title="Abre a prévia do rádio desta faixa"
          onClick={() => props.onRadio(props.t)}>
          <Icon name={ICONS.stations} size={12} /> Rádio
        </button>
        <button type="button" class="crate-btn" onClick={() => props.onDownload(props.t)}>
          <Icon name={ICONS.download} size={12} /> Baixar
        </button>
      </span>
    </div>
  );
}

const ALBUM_TIPO: Record<string, string> = { album: "Álbum", ep: "EP", single: "Single" };

function AlbumRow(props: { a: TidalAlbum; onOpen: (a: TidalAlbum) => void; onDownload: (a: TidalAlbum) => void }) {
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
        <button type="button" class="crate-btn crate-btn--quiet" onClick={(e) => { e.stopPropagation(); props.onOpen(props.a); }}>
          Escolher faixas
        </button>
        <button type="button" class="crate-btn" onClick={(e) => { e.stopPropagation(); props.onDownload(props.a); }}>
          <Icon name={ICONS.download} size={12} /> Baixar
        </button>
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
      <h3 class="tdl-sec__h">{props.title} <span class="tdl-num">{props.count}</span></h3>
      <div class="tdl-list">{props.children}</div>
      {props.more}
    </section>
  );
}

// ── job da fila (link ou seleção) ──────────────────────────────────
function TidalJobRow(props: { job: TidalJob }) {
  const tone = () => tidalStatusTone(props.job.status);
  const horario = () => props.job.fim ?? props.job.inicio ?? props.job.added;
  const isSel = () => (props.job.n_faixas ?? 0) > 0;
  return (
    <div class="crate-row-wrap">
      <div class="crate-tidal-row">
        <span class={`crate-pill crate-pill--${tone()}`}>{tidalStatusLabel(props.job.status)}</span>
        <span class="crate-chip crate-dest__btn" title="Pasta de destino em ~/Music">
          <Icon name={ICONS.folder} size={12} />
          <span>{props.job.playlist}</span>
        </span>
        <div class="crate-tidal-row__main">
          <Show
            when={isSel()}
            fallback={<CopyLinkButton url={props.job.url} label={shortTidalLink(props.job.url)} hint="Copia o link da Tidal" quiet />}
          >
            <span class="tdl-jobtitle">
              {props.job.titulo || "Seleção"} <span class="tdl-num">{plural(props.job.n_faixas ?? 0, "faixa", "faixas")}</span>
            </span>
          </Show>
          <Show when={props.job.resumo}>
            <p class="crate-tidal-row__resumo">{props.job.resumo}</p>
          </Show>
        </div>
        <span class="crate-r-dur crate-tidal-row__time">{horario()}</span>
      </div>
    </div>
  );
}

// ── seletor de pasta (o mesmo no topo e no rodapé da prévia) ───────
function DestPicker(props: {
  pastas: string[];
  dest: string;
  custom: boolean;
  customName: string;
  disabled: boolean;
  setDest: (v: string) => void;
  setCustom: (v: boolean) => void;
  setCustomName: (v: string) => void;
}) {
  return (
    <>
      <select
        class="crate-tidal-select"
        aria-label="Pasta de destino em ~/Music"
        value={props.custom ? "__nova__" : props.dest}
        disabled={props.disabled}
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (v === "__nova__") { props.setCustom(true); return; }
          props.setCustom(false);
          props.setDest(v);
        }}
      >
        {/* O destino lembrado pode não estar entre as pastas que a VM
            conhece agora: entra como opção própria pra não sumir. */}
        <Show when={!props.dest}>
          <option value="" disabled>Escolha a pasta</option>
        </Show>
        <Show when={props.dest && !props.pastas.includes(props.dest)}>
          <option value={props.dest}>{props.dest}</option>
        </Show>
        <For each={props.pastas}>{(p) => <option value={p}>{p}</option>}</For>
        <option value="__nova__">outra pasta...</option>
      </select>
      <Show when={props.custom}>
        <input
          type="text"
          class="crate-tidal-input crate-tidal-input--dest"
          placeholder="nome da pasta nova"
          value={props.customName}
          onInput={(e) => props.setCustomName(e.currentTarget.value)}
        />
      </Show>
    </>
  );
}

// ── página do artista ──────────────────────────────────────────────
const EPS_VISIBLE = 20;

function ArtistView(props: {
  page: { id: number; nome: string };
  backLabel: string;
  onBack: () => void;
  isOwned: (t: TidalTrack) => boolean;
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
      <header class="tdl-head">
        <button type="button" class="crate-btn crate-btn--quiet" onClick={props.onBack} title="Voltar (Esc)">
          <Icon name={ICONS.chevronLeft} size={12} /> {props.backLabel}
        </button>
        <Cover url={data()?.foto ?? null} round />
        <div class="tdl-main">
          <span class="tdl-title">{data()?.nome ?? props.page.nome}</span>
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
        <div class="crate-banner" data-tone="amber" role="alert">
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
                  {(t) => <TrackRow t={t} owned={props.isOwned(t)} onDownload={props.onTrackDownload} onRadio={props.onTrackRadio} />}
                </For>
              </Section>
            </Show>
            <Show when={d().albuns.length > 0}>
              <Section title="Álbuns" count={d().albuns.length}>
                <For each={d().albuns}>{(a) => <AlbumRow a={a} onOpen={props.onAlbumOpen} onDownload={props.onAlbumDownload} />}</For>
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
                <For each={eps()}>{(a) => <AlbumRow a={a} onOpen={props.onAlbumOpen} onDownload={props.onAlbumDownload} />}</For>
              </Section>
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
  page: { ref: string; titulo: string };
  backLabel: string;
  onBack: () => void;
  owned: OwnedIndex;
  dest: () => string;
  destPicker: any;
  tokenMissing: boolean;
  onEnqueue: (ids: number[], titulo: string, ref: string) => Promise<boolean>;
}) {
  const [data, setData] = createSignal<TidalPreview | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [sel, setSel] = createSignal<Set<number>>(new Set());
  const [touched, setTouched] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  let alive = true;
  let listEl: HTMLDivElement | undefined;
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
  onMount(load);

  function toggle(id: number) {
    setTouched(true);
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  const all = () => { setTouched(true); setSel(new Set((data()?.faixas ?? []).map((t) => t.id))); };
  const none = () => { setTouched(true); setSel(new Set<number>()); };
  const onlyNew = () => { setTouched(true); setSel(defaultSelection(data()?.faixas ?? [], (id) => ownedIds().has(id))); };

  const chosen = createMemo(() => (data()?.faixas ?? []).filter((t) => sel().has(t.id)));
  const est = createMemo(() => estimateSelection(chosen()));

  function onListKey(e: KeyboardEvent) {
    const boxes = listEl ? [...listEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]")] : [];
    const i = boxes.indexOf(document.activeElement as HTMLInputElement);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      e.stopPropagation();
      all();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const next = e.key === "ArrowDown" ? Math.min(boxes.length - 1, i + 1) : Math.max(0, i - 1);
      boxes[next]?.focus();
    }
  }

  async function send() {
    const d = data();
    if (!d || sending()) return;
    const ids = orderedSelection(d.faixas, sel());
    if (!ids.length) return;
    setSending(true);
    try {
      await props.onEnqueue(ids, d.titulo, d.ref);
    } finally {
      if (alive) setSending(false);
    }
  }

  return (
    <div class="tdl-page tdl-page--preview">
      <header class="tdl-head">
        <button type="button" class="crate-btn crate-btn--quiet" onClick={props.onBack} title="Voltar (Esc)">
          <Icon name={ICONS.chevronLeft} size={12} /> {props.backLabel}
        </button>
        <div class="tdl-main">
          <span class="tdl-title">{data()?.titulo ?? props.page.titulo}</span>
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
        <div class="crate-banner" data-tone="amber" role="alert">
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
            <div class="tdl-list" ref={listEl} onKeyDown={onListKey}>
              <For each={d().faixas}>
                {(t) => (
                  <label class="tdl-row tdl-row--pick" data-off={sel().has(t.id) ? undefined : "true"}>
                    <input type="checkbox" checked={sel().has(t.id)} onChange={() => toggle(t.id)} />
                    <Cover url={t.capa} />
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
              <span class="tdl-foot__sum">
                <span class="tdl-num-inline">{est().count} de {d().faixas.length}</span>
                {" · "}<span class="tdl-num-inline">{formatSize(est().bytes)}</span>
                {" · "}<span class="tdl-num-inline">{formatEta(est().seconds)}</span>
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
type SectionKey = "faixas" | "albuns" | "artistas" | "playlists";
const TOP_SECTION: Record<string, SectionKey> = { faixa: "faixas", album: "albuns", artista: "artistas", playlist: "playlists" };

export default function TidalTab(props: Props) {
  const [text, setText] = createSignal("");
  const kind = createMemo(() => classifyTidalInput(text()));
  const [dest, setDest] = createSignal(loadLastTidalDest() ?? "");
  const [customDest, setCustomDest] = createSignal(false);
  const [customName, setCustomName] = createSignal("");
  const resolvedDest = () => (customDest() ? customName().trim() : dest());
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
  const backLabel = () => {
    const s = stack();
    const below = s[s.length - 2];
    if (!below) return "Busca";
    return below.kind === "artist" ? below.nome : below.titulo;
  };

  const [owned, setOwned] = createSignal<OwnedIndex>(new Map());
  onMount(() => {
    libGetTracks({ limit: 100_000 }).then((ts) => setOwned(buildOwnedIndex(ts))).catch(() => {});
  });
  const isOwned = (t: TidalTrack) => findOwned(t, owned()) !== null;

  onCleanup(() => { clearTimeout(debounce); clearTimeout(flashTimer); });

  // Esc com página aberta volta um nível (prévia -> artista -> busca).
  createEffect(() => {
    if (stack().length > 0) {
      const pop = pushEscLayer(goBack);
      onCleanup(pop);
    }
  });

  function goBack() { setStack((s) => s.slice(0, -1)); }
  function push(p: Page) { setStack((s) => [...s, p]); }

  function say(text: string, tone: Flash["tone"] = "ok") {
    setFlash({ text, tone });
    clearTimeout(flashTimer);
    if (tone === "ok") flashTimer = setTimeout(() => setFlash(null), 6000);
  }

  function rememberDest(d: string) {
    saveLastTidalDest(d);
    if (customDest()) {
      batch(() => { setDest(d); setCustomDest(false); setCustomName(""); });
    }
  }

  function onInput(v: string) {
    setText(v);
    clearTimeout(debounce);
    if (stack().length) setStack([]);
    const k = classifyTidalInput(v);
    if (k === "text") {
      debounce = setTimeout(() => void runSearch(v.trim()), SEARCH_DEBOUNCE_MS);
    } else if (k !== "short") {
      seq.cancel();
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
    if (!d) { say("Escolha a pasta de destino antes de baixar.", "err"); return false; }
    try {
      await crateTidalEnqueue(url, d);
      rememberDest(d);
      say(`${label} foi para a fila (${d}).`);
      props.refresh();
      return true;
    } catch (e) {
      say(errText(e), "err");
      return false;
    }
  }

  async function enqueueSelection(ids: number[], titulo: string, ref: string) {
    const d = resolvedDest();
    if (!d) { say("Escolha a pasta de destino antes de baixar.", "err"); return false; }
    try {
      await crateTidalEnqueueSelection(ids, titulo, ref, d);
      rememberDest(d);
      say(`${plural(ids.length, "faixa", "faixas")} de "${titulo}" foram para a fila (${d}).`);
      props.refresh();
      goBack();
      return true;
    } catch (e) {
      say(errText(e), "err");
      return false;
    }
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
  const albumOpen = (a: TidalAlbum) => push({ kind: "preview", ref: `album:${a.id}`, titulo: `${a.artista} - ${a.titulo}` });
  const albumDownload = (a: TidalAlbum) => void enqueueLink(a.url, `"${a.titulo}"`);
  const artistOpen = (a: TidalArtist) => push({ kind: "artist", id: a.id, nome: a.nome });
  const playlistOpen = (p: TidalPlaylist) => push({ kind: "preview", ref: `playlist:${p.id}`, titulo: p.titulo });
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
  const activeJobs = () => props.jobs.filter((j) => j.status === "fila" || j.status === "baixando").length;

  const destPicker = () => (
    <DestPicker
      pastas={props.pastas}
      dest={dest()}
      custom={customDest()}
      customName={customName()}
      disabled={props.tokenMissing}
      setDest={setDest}
      setCustom={setCustomDest}
      setCustomName={setCustomName}
    />
  );

  return (
    <div class="crate-tidal tdl">
      <form class="crate-tidal-form" onSubmit={(e) => void onSubmit(e)}>
        <div class="crate-tidal-form__row">
          <div class="tdl-field" data-busy={searchState() === "loading" ? "true" : undefined}>
            <Icon name={ICONS.search} size={14} />
            <input
              type="text"
              class="crate-tidal-input tdl-field__input"
              placeholder="Busque faixa, álbum, artista ou playlist, ou cole um link da Tidal"
              aria-label="Buscar na Tidal ou colar link"
              value={text()}
              disabled={props.tokenMissing}
              onInput={(e) => onInput(e.currentTarget.value)}
              onKeyDown={onInputKey}
              autocomplete="off"
              spellcheck={false}
            />
            <span class="tdl-field__state" aria-live="polite">
              {searchState() === "loading" ? "buscando…" : ""}
            </span>
          </div>
          {destPicker()}
          <button
            type="submit"
            class="crate-btn crate-btn--primary"
            disabled={
              props.tokenMissing || submitting()
              || (kind() === "link" ? !resolvedDest() : kind() !== "text")
            }
          >
            <Show when={kind() === "link"} fallback={<><Icon name={ICONS.search} size={12} /> Buscar</>}>
              <Icon name={ICONS.download} size={12} /> {submitting() ? "Enviando…" : "Baixar"}
            </Show>
          </button>
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

      <Show when={props.load === "error"}>
        <div class="crate-banner" data-tone="amber">
          <Icon name={ICONS.alert} size={15} />
          <p>{props.loadError ?? "fila indisponível (VM fora?)"}</p>
          <span class="crate-banner__sp" />
          <button type="button" class="crate-banner__act" onClick={props.refresh}>Tentar de novo</button>
        </div>
      </Show>

      <Switch>
        <Match when={page()?.kind === "artist" && (page() as Extract<Page, { kind: "artist" }>)} keyed>
          {(p) => (
            <ArtistView
              page={p}
              backLabel={backLabel()}
              onBack={goBack}
              isOwned={isOwned}
              onTrackDownload={trackDownload}
              onTrackRadio={trackRadio}
              onAlbumOpen={albumOpen}
              onAlbumDownload={albumDownload}
              onPreview={openPreview}
            />
          )}
        </Match>
        <Match when={page()?.kind === "preview" && (page() as Extract<Page, { kind: "preview" }>)} keyed>
          {(p) => (
            <PreviewView
              page={p}
              backLabel={backLabel()}
              onBack={goBack}
              owned={owned()}
              dest={resolvedDest}
              destPicker={destPicker()}
              tokenMissing={props.tokenMissing}
              onEnqueue={enqueueSelection}
            />
          )}
        </Match>
        <Match when={kind() === "text" || kind() === "short" ? result() || searchState() !== "idle" : false}>
          <Show when={activeJobs() > 0}>
            <p class="tdl-sub tdl-queue-note">
              Fila: <span class="tdl-num-inline">{activeJobs()}</span> em andamento.{" "}
              <button type="button" class="tdl-linkbtn" onClick={clearAll}>Ver a fila</button>
            </p>
          </Show>
          <Show when={searchState() === "error"}>
            <div class="crate-banner" data-tone="amber" role="alert">
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
                          {(t) => <TrackRow t={t} owned={isOwned(t)} onDownload={trackDownload} onRadio={trackRadio} />}
                        </For>
                      </Section>
                    </Match>
                    <Match when={key === "albuns" && result()!.albuns.length > 0}>
                      <Section title="Álbuns" count={result()!.albuns.length}>
                        <For each={result()!.albuns}>{(a) => <AlbumRow a={a} onOpen={albumOpen} onDownload={albumDownload} />}</For>
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
          <Show when={props.load !== "loading" || props.jobs.length > 0}>
            <Show when={props.jobs.length === 0}>
              <div class="crate-empty-wrap">
                <div class="crate-empty">
                  <Icon name={ICONS.search} size={26} />
                  <h3>Cole um link da Tidal ou busque por faixa, álbum, artista ou playlist</h3>
                  <p>Rádio, playlist e álbum abrem uma prévia para você escolher as faixas.</p>
                </div>
              </div>
            </Show>
          </Show>
          <Show when={props.load === "loading" && props.jobs.length === 0}>
            <div class="tdl-placeholder" aria-busy="true" />
          </Show>
          <Show when={props.jobs.length > 0}>
            <section class="tdl-sec">
              <h3 class="tdl-sec__h">Fila da VM <span class="tdl-num">{props.jobs.length}</span></h3>
              <div class="crate-list crate-tidal-list">
                <div class="crate-list-inner">
                  <For each={[...props.jobs].reverse()}>{(j) => <TidalJobRow job={j} />}</For>
                </div>
              </div>
            </section>
          </Show>
        </Match>
      </Switch>
    </div>
  );
}
