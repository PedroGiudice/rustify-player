/* ============================================================
   views/NowPlaying.tsx — Spectrum bg + cover + meta + lyrics.

   Lyrics from libGetLyrics(track.id); synced to player.positionSecs.
   Shape state read via useShape() from SpectrumCanvas.
   ============================================================ */

import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { player } from "../store/player";
import { dsp } from "../store/dsp";
import { Icon, ICONS } from "../components/Icon";
import { CoverArt } from "../components/CoverArt";
import { useShape } from "../components/SpectrumCanvas";
import { libGetLyrics, coverUrl, type LyricLine } from "../tauri";
import { navigate } from "../router";

export default function NowPlaying() {
  const shape = useShape();
  // Estado inicial lê o data-attr canônico no shell — se o user voltou
  // pra /now-playing com cinema ativo, mantém o ícone correto.
  const [cinema, setCinema] = createSignal(
    document.getElementById("rustify-app")?.getAttribute("data-cinema") === "true",
  );

  // Cinema mode é canônico no App.tsx (pra o background bgMode reagir
  // junto). Emitimos o evento; o App escreve data-attr + signal global.
  // Ouvimos de volta pra ficar em sync caso outro lugar (Esc no App)
  // mude o estado.
  function toggleCinema() {
    window.dispatchEvent(new CustomEvent<boolean>("rustify:cinema", { detail: !cinema() }));
  }

  onMount(() => {
    const onCinema = (e: Event) => setCinema((e as CustomEvent<boolean>).detail);
    window.addEventListener("rustify:cinema", onCinema);
    onCleanup(() => window.removeEventListener("rustify:cinema", onCinema));
  });

  // Lyrics resource keyed by current track id
  const [lyrics] = createResource(
    () => player.currentTrack?.id ?? null,
    async (id) => (id ? await libGetLyrics(id).catch(() => [] as LyricLine[]) : [] as LyricLine[]),
  );

  // Find the active lyric index based on positionSecs
  const activeLine = createMemo(() => {
    const ls = lyrics() ?? [];
    if (ls.length === 0) return -1;
    const pos = player.positionSecs;
    let idx = -1;
    for (let i = 0; i < ls.length; i++) {
      if (ls[i].t <= pos) idx = i;
      else break;
    }
    return idx;
  });

  // ── Lyrics card: draggable + resizable, persistido em localStorage ──
  const LS_KEY = "rustify-lyrics-card";
  const MIN_W = 280, MIN_H = 220;
  const MAX_W = 800, MAX_H = 800;
  const DEFAULT_W = 380, DEFAULT_H = 460;

  type Box = { x: number; y: number; w: number; h: number };

  function clamp(b: Box, vw: number, vh: number): Box {
    const w = Math.min(MAX_W, Math.max(MIN_W, b.w));
    const h = Math.min(MAX_H, Math.max(MIN_H, b.h));
    const x = Math.min(Math.max(0, b.x), Math.max(0, vw - w));
    const y = Math.min(Math.max(0, b.y), Math.max(0, vh - h));
    return { x, y, w, h };
  }

  function loadBox(): Box | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (typeof o?.x === "number" && typeof o?.y === "number" && typeof o?.w === "number" && typeof o?.h === "number") {
        return o as Box;
      }
    } catch {}
    return null;
  }

  function saveBox(b: Box) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(b)); } catch {}
  }

  const [box, setBox] = createSignal<Box>({ x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H });
  // Sinal de drag/resize ativo: durante interacao, o card vira solid + sem
  // backdrop-filter pra nao matar o WebKit recalculando blur/saturate/
  // brightness por cima do spectrum animado a cada mousemove (60+fps).
  const [interacting, setInteracting] = createSignal(false);

  let railEl!: HTMLDivElement;
  let railViewportEl!: HTMLDivElement;
  let cardEl!: HTMLElement;
  let npEl!: HTMLDivElement;

  onMount(() => {
    // Calculo do default — alinhado a direita do np, top 32px (igual ao layout antigo)
    const rect = npEl.getBoundingClientRect();
    const stored = loadBox();
    const initial = stored ?? {
      x: Math.max(0, rect.width - DEFAULT_W - 40),
      y: 32,
      w: DEFAULT_W,
      h: DEFAULT_H,
    };
    setBox(clamp(initial, rect.width, rect.height));

    // Reclamp em resize da janela
    const onResize = () => {
      const r = npEl.getBoundingClientRect();
      setBox((b) => clamp(b, r.width, r.height));
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });

  function startDrag(e: MouseEvent) {
    // Ignora se clicou no botao "x" ou resize handle (caso adicionados depois)
    const target = e.target as HTMLElement;
    if (target.closest(".np__lyrics-resize")) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const start = box();
    const rect = npEl.getBoundingClientRect();
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    setInteracting(true);

    // rAF throttle: mousemove dispara ate 120+ vezes/s; coalescemos pro
    // proximo frame. Sem isso, cada mousemove faz Solid re-renderizar o
    // style inline e o WebKit recalcular o canvas do spectrum + card,
    // travando a UI.
    let pendingFrame = 0;
    let lastEv: MouseEvent | null = null;
    const apply = () => {
      pendingFrame = 0;
      if (!lastEv) return;
      const nx = start.x + (lastEv.clientX - startX);
      const ny = start.y + (lastEv.clientY - startY);
      setBox(clamp({ ...start, x: nx, y: ny }, rect.width, rect.height));
    };
    const onMove = (ev: MouseEvent) => {
      lastEv = ev;
      if (!pendingFrame) pendingFrame = requestAnimationFrame(apply);
    };
    const onUp = () => {
      if (pendingFrame) { cancelAnimationFrame(pendingFrame); apply(); }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setInteracting(false);
      saveBox(box());
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function startResize(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const start = box();
    const rect = npEl.getBoundingClientRect();
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";
    setInteracting(true);

    let pendingFrame = 0;
    let lastEv: MouseEvent | null = null;
    const apply = () => {
      pendingFrame = 0;
      if (!lastEv) return;
      const nw = start.w + (lastEv.clientX - startX);
      const nh = start.h + (lastEv.clientY - startY);
      setBox(clamp({ ...start, w: nw, h: nh }, rect.width, rect.height));
    };
    const onMove = (ev: MouseEvent) => {
      lastEv = ev;
      if (!pendingFrame) pendingFrame = requestAnimationFrame(apply);
    };
    const onUp = () => {
      if (pendingFrame) { cancelAnimationFrame(pendingFrame); apply(); }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setInteracting(false);
      saveBox(box());
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Auto-scroll: centro do RAIL VIEWPORT, nao do card todo (header sticky nao conta)
  onMount(() => {
    const apply = () => {
      const i = activeLine();
      if (i < 0 || !railEl || !railViewportEl) return;
      const line = railEl.children[i] as HTMLElement | undefined;
      if (!line) return;
      const offset = line.offsetTop + line.offsetHeight / 2 - railViewportEl.clientHeight / 2;
      railEl.style.transform = `translateY(${-Math.max(0, offset)}px)`;
    };
    let raf = 0;
    const tick = () => { apply(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  // Keyboard for shape cycling
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "[") { e.preventDefault(); shape.prev(); }
      else if (e.key === "]") { e.preventDefault(); shape.next(); }
      else if (e.key.toLowerCase() === "f") { e.preventDefault(); toggleCinema(); }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <article class="view" style={{ overflow: "hidden", padding: 0 }}>
      <div class="np" ref={npEl!}>
        {/* O canvas vive global em <App> (.app-bg). Aqui o .np é transparent
            pra deixar o bg vazar no modo "focused". */}

        <div class="np__corner">
          <button title="Cinema mode (F)" onClick={toggleCinema}>
            <Icon name={cinema() ? ICONS.shrink : ICONS.expand} size={14} />
          </button>
          <button title="Spectrum settings"><Icon name={ICONS.settings} size={14} /></button>
          <button title="More"><Icon name={ICONS.more} size={14} /></button>
        </div>

        <div class="np__chrome">
          <div class="np__left">
            <Show
              when={player.currentTrack}
              fallback={
                <CoverArt seed="empty" size="lg" class="np__cover" style={{ width: "200px", height: "200px" }} />
              }
            >
              {(t) => (
                <CoverArt
                  seed={t().album_title || t().id}
                  src={coverUrl(t().album_cover_path)}
                  size="lg"
                  class="np__cover"
                  style={{ width: "200px", height: "200px" }}
                >
                  <Show when={player.techInfo.sampleRate}>
                    <span class="badge-fmt">
                      {player.techInfo.format} · {player.techInfo.bitDepth}/{Math.round((player.techInfo.sampleRate ?? 0) / 1000)}
                    </span>
                  </Show>
                </CoverArt>
              )}
            </Show>

            <div class="np__meta">
              <div class="np__tags">
                <span class="np__tag-playing"><span class="dot" />Now Playing</span>
                <span class="np__tag-source"><b>Local</b> · PipeWire</span>
              </div>
              <h1 class="np__title">{player.currentTrack?.title ?? "Nothing playing"}</h1>
              <p class="np__artist" onClick={() => navigate("/artists")}>
                {player.currentTrack?.artist_name ?? "—"}
              </p>
              <p class="np__album" onClick={() => navigate("/albums")}>
                {player.currentTrack?.album_title ?? "—"}{player.currentTrack?.album_year ? ` · ${player.currentTrack.album_year}` : ""}
              </p>

              <Show when={player.techInfo.sampleRate}>
                <div class="np__specs">
                  <span><b>{Math.round((player.techInfo.sampleRate ?? 0) / 1000)}</b> kHz</span>
                  <span><b>{player.techInfo.bitDepth}</b>-bit</span>
                  <span>{player.techInfo.format}</span>
                  <span>{player.techInfo.channels === 1 ? "mono" : "stereo"}</span>
                </div>
                <div class="np__specs np__specs--line2">
                  <span>Sink <b>PipeWire</b></span>
                  <Show
                    when={!dsp.bypass && (dsp.eq.enabled || dsp.limiter.enabled || dsp.bass.enabled)}
                    fallback={<span>DSP <b>{dsp.bypass ? "BYPASS" : "OFF"}</b></span>}
                  >
                    <span>
                      DSP{" "}
                      <b>
                        {[
                          dsp.eq.enabled ? "EQ" : null,
                          dsp.limiter.enabled ? "LIM" : null,
                          dsp.bass.enabled ? "BASS" : null,
                        ].filter(Boolean).join(" · ")}
                      </b>
                    </span>
                  </Show>
                </div>
              </Show>
            </div>
          </div>

          <Show when={(lyrics() ?? []).length > 0}>
            <aside
              class="np__lyrics-card np__lyrics-card--floating"
              classList={{ "is-interacting": interacting() }}
              ref={cardEl!}
              style={{
                left: `${box().x}px`,
                top: `${box().y}px`,
                width: `${box().w}px`,
                height: `${box().h}px`,
                // Glass blur escala com tamanho: caixa maior, blur maior.
                // Range: 10px (min, ~280+220) -> 32px (cap em ~1200+).
                "--lyrics-blur": `${Math.min(32, Math.max(10, (box().w + box().h) * 0.025))}px`,
              }}
            >
              <div class="np__lyrics-head" onMouseDown={startDrag} title="Arraste pra mover">
                <span class="np__lyrics-label">Lyrics · synced</span>
                <span class="np__lyrics-source mono">aligned</span>
              </div>
              <div class="np__lyrics-viewport" ref={railViewportEl!}>
                <div class="np__lyrics-rail" ref={railEl!}>
                  <For each={lyrics() ?? []}>
                    {(line, i) => {
                      const cls = () => {
                        const a = activeLine();
                        if (i() === a) return "np__lyric is-active";
                        if (Math.abs(i() - a) === 1) return "np__lyric is-near";
                        return "np__lyric";
                      };
                      return <p class={cls()}>{line.line}</p>;
                    }}
                  </For>
                </div>
              </div>
              <span
                class="np__lyrics-resize"
                onMouseDown={startResize}
                title="Arraste pra redimensionar"
                aria-hidden="true"
              />
            </aside>
          </Show>
        </div>

        <div class="np__shape-nav">
          <button title="Previous shape ([)" onClick={() => shape.prev()}>
            <Icon name={ICONS.chevronLeft} size={14} />
          </button>
          <span class="np__shape-name" onClick={() => shape.next()}>
            shape · <b>{shape.name()}</b>
          </span>
          <button title="Next shape (])" onClick={() => shape.next()}>
            <Icon name={ICONS.chevronRight} size={14} />
          </button>
        </div>
      </div>
    </article>
  );
}
