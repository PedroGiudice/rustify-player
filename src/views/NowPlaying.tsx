/* ============================================================
   views/NowPlaying.tsx — Spectrum bg + cover + meta + lyrics.

   Lyrics from libGetLyrics(track.id); synced to player.positionSecs.
   Shape/renderer state via useShape()/useRenderer() (SpectrumCanvas).
   Seletores empilhados no canto inferior-direito: renderer em cima,
   shape embaixo. Atalhos: [ ] shape, , . renderer. Só existem com o
   fundo 2D; com o WebGL a cena se escolhe no Tweaks (botão de ajustes),
   e na cena Relevo , . ciclam o estilo de linhas (reliefLines).
   ============================================================ */

import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import { player } from "../store/player";
import { dsp } from "../store/dsp";
import { Icon, ICONS } from "../components/Icon";
import { CoverArt } from "../components/CoverArt";
import { useRenderer, useShape } from "../components/SpectrumCanvas";
import { libGetLyrics, libListHistory, coverUrl, type LyricLine, type Track } from "../tauri";
import { tweaks, setTweaksOpen, updateTweak } from "../store/tweaks";
import { RELIEF_LINE_KEYS, glEngineWanted, glStatus } from "../gl/meta";
import { GL_CANVAS, parseColor, type Rgb } from "../gl/palette";
import { cssColorToRgb } from "../lib/color";
import { glassSurface, lyricsInk, type LyricsInkVar } from "../lib/lyricsInk";
import { navigate } from "../router";
import { isTypingContext } from "../lib/keyboard";
import { openTrackMenu } from "../store/contextMenu";
import { qualityBadge } from "../lib/quality";
import { createSwapKey } from "../lib/motion";
import { playAlone, shuffleAll } from "../lib/quickPlay";

/** Acima disto o título do Now Playing para em 3 linhas (np__title--long). */
const LONG_TITLE = 40;

/** Now Playing sem faixa (A20): o que fazer em vez de um título vazio. */
function EmptyMeta() {
  // Só busca com o Now Playing vazio. initialValue + .latest: ler o resource
  // pendente ligaria o Suspense do router e derrubaria a view.
  const [history] = createResource(
    () => (player.currentTrack ? null : "vazio"),
    async () => {
      try { return await libListHistory(1); } catch { return [] as Track[]; }
    },
    { initialValue: [] as Track[] },
  );
  const last = () => history.latest[0];
  return (
    <div class="np__empty">
      <h1 class="np__title np__title--empty">Nada tocando</h1>
      <p class="np__empty-hint">Retome a última faixa ou deixe o acervo escolher.</p>
      <div class="np__empty-actions">
        <Show when={last()}>
          {(t) => (
            <button
              type="button"
              class="np__action np__action--primary"
              title={t().artist_name ? `${t().title} · ${t().artist_name}` : t().title}
              onClick={() => playAlone(t())}
            >
              <Icon name={ICONS.play} size={14} />
              <span class="np__action-label">Continuar “{t().title}”</span>
            </button>
          )}
        </Show>
        <button type="button" class="np__action" onClick={() => void shuffleAll()}>
          <Icon name={ICONS.shuffle} size={14} />
          <span class="np__action-label">Aleatório no acervo</span>
        </button>
      </div>
    </div>
  );
}

export default function NowPlaying() {
  // Selo da capa e ficha técnica: a qualidade medida no conteúdo vence o "24/44" do arquivo.
  const badge = () => qualityBadge(player.techInfo, player.currentTrack);
  // Troca de faixa calma: o bloco título/artista/ficha aparece subindo 3 px
  // (data-swap) e a capa faz crossfade (CoverArt). Em rajada, corte seco.
  const swapKey = createSwapKey(() => player.currentTrack?.id);
  const shape = useShape();
  const renderer = useRenderer();
  // Shape/renderer só existem no fundo 2D. Com as cenas WebGL montadas
  // (mesma condição do App.tsx), os seletores e os atalhos [ ] , . mudariam
  // índices que ninguém lê — a cena WebGL se escolhe no Tweaks. Memo: o
  // glStatus muda 1x/s (fps) e só o booleano interessa aqui.
  const glActive = createMemo(() => glEngineWanted(tweaks().bgEngine) && glStatus().ok !== false);

  // Botão de ajustes do fundo: abre o Tweaks já na seção "Fundo" (motor e
  // cena), marcada com data-tweaks-section em Tweaks.tsx. O painel fica em
  // display:none fechado — só dá pra medir a posição no quadro seguinte.
  function openBgSettings() {
    setTweaksOpen(true);
    requestAnimationFrame(() => {
      const sec = document.querySelector<HTMLElement>('[data-tweaks-section="fundo"]');
      const body = sec?.closest<HTMLElement>(".tweaks__body");
      if (!sec || !body) return;
      body.scrollTop += sec.getBoundingClientRect().top - body.getBoundingClientRect().top;
    });
  }
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

  // Letra da faixa atual. A view roda dentro do <Suspense> do router: ler
  // `resource()` com a busca pendente liga o fallback "Loading…" e derruba
  // o Now Playing inteiro a cada troca de faixa. Com initialValue o resource
  // já nasce resolvido e `.latest` devolve o último valor sem suspender —
  // durante os milissegundos do IPC fica a letra anterior, depois troca.
  const [lyricsRes] = createResource(
    () => player.currentTrack?.id ?? null,
    async (id) => (id ? await libGetLyrics(id).catch(() => [] as LyricLine[]) : [] as LyricLine[]),
    { initialValue: [] as LyricLine[] },
  );
  const lyrics = () => lyricsRes.latest;

  // Letra SEM sincronismo chega com t=0 em todas as linhas (lyrics_from_embedded
  // faz esse fallback quando o texto não tem timestamps — caso de tag ID3 com
  // letra corrida, 73 faixas do acervo em 08/2026). Tratá-la como sincronizada
  // trava o card: `activeLine` elege a ÚLTIMA linha já em pos=0 e o rail fixa o
  // scroll no fim durante a música inteira, anunciando "synced".
  const isSynced = createMemo(() => lyrics().some((l) => l.t > 0));

  // Find the active lyric index based on positionSecs
  const activeLine = createMemo(() => {
    const ls = lyrics();
    if (ls.length === 0 || !isSynced()) return -1;
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

  // ── Contraste do card: a escala de texto segue a luminância REAL do
  // vidro (lib/lyricsInk.ts). Atrás do card está o canvas do tema no
  // fundo 2D; no WebGL, o preto fixo E as tintas que a cena pinta por cima
  // dele (--bg-ink-rgb e --primary, as mesmas de gl/palette.ts): cada tom
  // passa contra o vidro sobre as três (A3). Alpha/brightness vêm do slider
  // Lyrics glass (ou do tema, ou dos fallbacks do CSS). Re-mede quando o
  // store de Tweaks avisa que escreveu as vars do vidro
  // (rustify:tweaks-applied), e não no signal: a escrita do store roda num
  // rAF próprio, e medir pelo signal podia ler o passo anterior do slider.
  //
  // Sem getComputedStyle na medição (cfg-15): durante o arrasto ela roda
  // por quadro, logo depois de o store escrever no :root, e forçaria o
  // recálculo de estilo da árvore. As vars do vidro só existem inline no
  // <html> (store ou tema; o CSS só tem os fallbacks). --bg-canvas,
  // --bg-ink-rgb e --primary também são inline quando há tema ou capa —
  // sem eles vêm do :root do CSS, que só muda com rustify:theme-applied,
  // então são lidos uma vez por tema.
  const [ink, setInk] = createSignal<Partial<Record<LyricsInkVar, string>>>({});
  const sheetVars = new Map<string, string>();
  const inlineVar = (name: string) => document.documentElement.style.getPropertyValue(name).trim();
  function rootVar(name: string): string {
    const inline = inlineVar(name);
    if (inline) return inline;
    let v = sheetVars.get(name);
    if (v === undefined) {
      v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      sheetVars.set(name, v);
    }
    return v;
  }
  function measureInk() {
    const html = document.documentElement;
    const alpha = parseFloat(inlineVar("--lyrics-bg-alpha"));
    const brightness = parseFloat(inlineVar("--lyrics-bg-brightness"));
    const glass = (backdrop: Rgb) => glassSurface({
      backdrop,
      alpha: Number.isFinite(alpha) ? alpha : 0.193,
      brightness: html.dataset.lyricsSolid === "on" ? null : Number.isFinite(brightness) ? brightness : 0.82,
    });
    if (glActive()) {
      const paints = ["--bg-ink-rgb", "--primary"]
        .map((name) => parseColor(rootVar(name)))
        .filter((c): c is Rgb => c !== null);
      setInk(lyricsInk([GL_CANVAS, ...paints].map(glass)));
      return;
    }
    const backdrop = cssColorToRgb(rootVar("--bg-canvas"));
    if (!backdrop) { setInk({}); return; }
    setInk(lyricsInk(glass(backdrop)));
  }
  let inkRaf = 0;
  const scheduleInk = () => {
    cancelAnimationFrame(inkRaf);
    inkRaf = requestAnimationFrame(measureInk);
  };
  createEffect(() => {
    glActive();
    scheduleInk();
  });
  const onThemeApplied = () => {
    sheetVars.clear();
    scheduleInk();
  };
  // Capa nova muda ink e accent (adaptiveInk/adaptiveAccent): o store avisa
  // depois de escrever. Só o WebGL mede contra eles.
  const onInkApplied = () => { if (glActive()) scheduleInk(); };
  onMount(() => {
    window.addEventListener("rustify:tweaks-applied", scheduleInk);
    window.addEventListener("rustify:theme-applied", onThemeApplied);
    window.addEventListener("rustify:ink-applied", onInkApplied);
    onCleanup(() => {
      cancelAnimationFrame(inkRaf);
      window.removeEventListener("rustify:tweaks-applied", scheduleInk);
      window.removeEventListener("rustify:theme-applied", onThemeApplied);
      window.removeEventListener("rustify:ink-applied", onInkApplied);
    });
  });

  const [box, setBox] = createSignal<Box>({ x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H });
  // Sinal de drag/resize ativo: durante interacao, o card vira solid + sem
  // backdrop-filter pra nao matar o WebKit recalculando blur/saturate/
  // brightness por cima do spectrum animado a cada mousemove (60+fps).
  const [interacting, setInteracting] = createSignal(false);

  let railEl!: HTMLDivElement;
  let railViewportEl!: HTMLDivElement;
  let cardEl!: HTMLElement;
  let npEl!: HTMLDivElement;
  let leftEl!: HTMLDivElement;
  let metaEl!: HTMLDivElement;

  const longTitle = () => (player.currentTrack?.title?.length ?? 0) > LONG_TITLE;
  const cardShown = createMemo(() => !!tweaks().lyricsVisible && lyrics().length > 0);

  // ── O título cede ao card (A4) ──
  // A posição do card é do dono (salva no arraste); quem se ajusta é o
  // título: com o card em cima do bloco capa + título, o .np__left encolhe
  // até a borda do card e o text-wrap: balance quebra o título em linhas.
  // Mede ao soltar o arraste/resize, no resize do .np e do bloco (troca de
  // faixa, fonte) e quando o card aparece ou some — nunca por quadro.
  const LEFT_MAX = 880; // max-width do .np__left em extractor-lab.css
  const TITLE_GAP = 28; // mesmo respiro do gap capa/título
  const TITLE_MIN = 280; // largura mínima da coluna do título

  /** Bloco capa + título em coordenadas do .np; `natural` é a largura sem
      o ajuste (o max-width do CSS ou o que couber no .np). */
  function titleBlock() {
    const np = npEl.getBoundingClientRect();
    const l = leftEl.getBoundingClientRect();
    const left = l.left - np.left;
    return {
      left,
      top: l.top - np.top,
      bottom: l.bottom - np.top,
      metaOffset: metaEl.getBoundingClientRect().left - l.left,
      natural: Math.min(LEFT_MAX, np.width - 2 * left),
    };
  }

  function fitTitle() {
    if (!npEl || !leftEl || !metaEl) return;
    const b = box();
    const t = titleBlock();
    const covers = cardShown()
      && b.y < t.bottom && b.y + b.h > t.top
      && b.x < t.left + t.natural && b.x + b.w > t.left;
    if (!covers) {
      leftEl.style.removeProperty("max-width");
      return;
    }
    const room = b.x - t.left - TITLE_GAP;
    const width = Math.min(LEFT_MAX, Math.max(t.metaOffset + TITLE_MIN, room));
    leftEl.style.maxWidth = `${Math.round(width)}px`;
  }

  /** Primeira abertura, sem caixa salva: o card nasce na coluna livre à
      direita do bloco do título; sem ela, embaixo do bloco; sem espaço
      nenhum, no canto direito de sempre (e o título cede). */
  function firstBox(np: DOMRect): Box {
    const t = titleBlock();
    const colX = t.left + t.natural + TITLE_GAP;
    const colW = np.width - t.left - colX;
    if (colW >= MIN_W) {
      const w = Math.min(DEFAULT_W, colW);
      return { x: np.width - t.left - w, y: 32, w, h: DEFAULT_H };
    }
    const belowY = t.bottom + 24;
    const belowH = np.height - belowY - 24;
    if (belowH >= MIN_H) {
      return { x: t.left, y: belowY, w: DEFAULT_W, h: Math.min(DEFAULT_H, belowH) };
    }
    return { x: Math.max(0, np.width - DEFAULT_W - 40), y: 32, w: DEFAULT_W, h: DEFAULT_H };
  }

  onMount(() => {
    const rect = npEl.getBoundingClientRect();
    setBox(clamp(loadBox() ?? firstBox(rect), rect.width, rect.height));
    fitTitle();

    // Reclamp quando o .np muda de tamanho — não só no resize da janela:
    // cinema e sidebar em ícones mudam --sidebar-w sem evento de janela, e
    // o card ficava cortado pelo overflow do .np (alça de resize escondida).
    // O bloco do título também é observado: título novo ou fonte trocada
    // mudam a altura dele, e o ajuste do título depende disso.
    const ro = new ResizeObserver(() => {
      const r = npEl.getBoundingClientRect();
      setBox((b) => clamp(b, r.width, r.height));
      fitTitle();
    });
    ro.observe(npEl);
    ro.observe(leftEl);
    onCleanup(() => ro.disconnect());
  });
  createEffect(on(cardShown, () => fitTitle(), { defer: true }));

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
      fitTitle();
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
      fitTitle();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Auto-scroll: centro do RAIL VIEWPORT, nao do card todo (header sticky nao conta).
  // Mede só quando a linha ativa ou a letra mudam, e quando o viewport muda
  // de tamanho (ResizeObserver no ref) — antes era um rAF eterno lendo
  // offsetTop a cada quadro (A22).
  function placeRail() {
    if (!railEl || !railViewportEl) return;
    const i = activeLine();
    if (i < 0) {
      // Sem linha ativa (letra não sincronizada, antes do primeiro verso ou
      // faixa sem letra): zera o deslocamento — senão o rail herda o offset
      // da faixa anterior e o texto nasce cortado.
      if (railEl.style.transform) railEl.style.transform = "";
      return;
    }
    const line = railEl.children[i] as HTMLElement | undefined;
    if (!line) return;
    const offset = line.offsetTop + line.offsetHeight / 2 - railViewportEl.clientHeight / 2;
    railEl.style.transform = `translateY(${-Math.max(0, offset)}px)`;
  }
  createEffect(on([activeLine, lyrics], placeRail));
  function attachViewport(el: HTMLDivElement) {
    railViewportEl = el;
    const ro = new ResizeObserver(placeRail);
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  }

  // Keyboard: [ ] cicla shape e , . cicla renderer (fundo 2D); com o
  // WebGL na cena Relevo, , . ciclam o estilo de linhas (com volta);
  // F cinema mode em qualquer motor.
  function cycleReliefLines(step: 1 | -1) {
    const keys = RELIEF_LINE_KEYS;
    const i = keys.indexOf(tweaks().reliefLines);
    updateTweak("reliefLines", keys[(i + step + keys.length) % keys.length]);
  }
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingContext(e)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const bg2d = !glActive();
      const relief = !bg2d && tweaks().bgScene === "relief";
      if (bg2d && e.key === "[") { e.preventDefault(); shape.prev(); }
      else if (bg2d && e.key === "]") { e.preventDefault(); shape.next(); }
      else if (bg2d && e.key === ",") { e.preventDefault(); renderer.prev(); }
      else if (bg2d && e.key === ".") { e.preventDefault(); renderer.next(); }
      else if (relief && e.key === ",") { e.preventDefault(); cycleReliefLines(-1); }
      else if (relief && e.key === ".") { e.preventDefault(); cycleReliefLines(1); }
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
          <button title="Spectrum settings" onClick={openBgSettings}>
            <Icon name={ICONS.settings} size={14} />
          </button>
          <button
            title="More"
            disabled={!player.currentTrack}
            onClick={(e) => { if (player.currentTrack) openTrackMenu(e, player.currentTrack); }}
          >
            <Icon name={ICONS.more} size={14} />
          </button>
        </div>

        <div class="np__chrome">
          <div class="np__left" ref={leftEl!}>
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
                  crossfade
                >
                  <Show when={player.techInfo.sampleRate}>
                    <span class="badge-fmt" title={badge().title ?? undefined}>{badge().label}</span>
                  </Show>
                </CoverArt>
              )}
            </Show>

            <div class="np__meta" ref={metaEl!} data-swap={swapKey()}>
              <Show when={player.currentTrack} fallback={<EmptyMeta />}>
                <div class="np__tags">
                  <span class="np__tag-playing"><span class="dot" />Now Playing</span>
                </div>
                <h1
                  class="np__title"
                  classList={{ "np__title--long": longTitle() }}
                  title={longTitle() ? player.currentTrack?.title : undefined}
                >
                  {player.currentTrack?.title}
                </h1>
                {/* Artista e álbum levam à página DA entidade (mesmas rotas do
                    menu de contexto e da paleta), não à grade genérica; são
                    <button> pra entrarem na ordem de Tab. */}
                <Show when={player.currentTrack?.artist_name} fallback={<p class="np__artist">—</p>}>
                  {(name) => (
                    <button
                      type="button"
                      class="np__artist"
                      onClick={() => navigate(`/artist/${encodeURIComponent(name())}`)}
                    >
                      {name()}
                    </button>
                  )}
                </Show>
                <Show when={player.currentTrack?.album_title} fallback={<p class="np__album">—</p>}>
                  {(title) => (
                    <button
                      type="button"
                      class="np__album"
                      onClick={() => navigate(`/album/${encodeURIComponent(title())}`)}
                    >
                      {title()}{player.currentTrack?.album_year ? ` · ${player.currentTrack.album_year}` : ""}
                    </button>
                  )}
                </Show>

                <Show when={player.techInfo.sampleRate}>
                  <div class="np__specs">
                    <span><b>{Math.round((player.techInfo.sampleRate ?? 0) / 1000)}</b> kHz</span>
                    {/* Faixa com qualidade medida diferente do arquivo (MP3 disfarçado,
                        upsample de CD): o rótulo real no lugar do "24 bits". */}
                    <Show when={badge().title} fallback={<span><b>{player.techInfo.bitDepth}</b> bits</span>}>
                      <span title={badge().title ?? undefined}><b>{badge().label}</b></span>
                    </Show>
                    <span>{player.techInfo.format}</span>
                    <span>{player.techInfo.channels === 1 ? "mono" : "estéreo"}</span>
                  </div>
                  <div class="np__specs np__specs--line2">
                    <span>Saída <b>PipeWire</b></span>
                    <Show
                      when={!dsp.bypass && (dsp.eq.enabled || dsp.limiter.enabled || dsp.bass.enabled)}
                      fallback={<span>DSP <b>{dsp.bypass ? "BYPASS" : "OFF"}</b></span>}
                    >
                      <span>
                        DSP
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
              </Show>
            </div>
          </div>

          <Show when={cardShown()}>
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
                ...ink(),
              }}
            >
              <div class="np__lyrics-head" onMouseDown={startDrag} title="Arraste pra mover">
                <span class="np__lyrics-label">
                  Lyrics{isSynced() ? " · synced" : ""}
                </span>
                <span class="np__lyrics-source mono">
                  {isSynced() ? "aligned" : "unsynced"}
                </span>
              </div>
              <div
                class="np__lyrics-viewport"
                classList={{ "is-unsynced": !isSynced() }}
                ref={attachViewport}
              >
                <div class="np__lyrics-rail" ref={railEl!}>
                  <For each={lyrics()}>
                    {(line, i) => {
                      // Sem linha ativa (a = -1) só há "próxima" na letra
                      // sincronizada antes do primeiro verso: as três primeiras
                      // linhas já se leem como o que vem (A3). Na letra sem
                      // sincronismo nenhuma linha é próxima.
                      const base = line.header ? "np__lyric is-header" : "np__lyric";
                      const cls = () => {
                        const a = activeLine();
                        if (a < 0) return isSynced() && i() < 3 ? `${base} is-near` : base;
                        if (i() === a) return `${base} is-active`;
                        if (Math.abs(i() - a) === 1) return `${base} is-near`;
                        return base;
                      };
                      // Linha só com timestamp (interlúdio) vira "…" em vez de
                      // um <p> vazio que some do destaque — paridade com o mobile.
                      return <p class={cls()}>{line.line || "…"}</p>;
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

        {/* Seletores empilhados: renderer (como pintar) em cima,
            shape (campo) embaixo. Mesmo estilo ‹ nome ›. Só no fundo 2D. */}
        <Show when={!glActive()}>
          <div class="np__viz-nav">
            <div class="np__nav-row">
              <button title="Previous renderer (,)" onClick={() => renderer.prev()}>
                <Icon name={ICONS.chevronLeft} size={14} />
              </button>
              <span class="np__nav-name" onClick={() => renderer.next()}>
                render · <b>{renderer.name()}</b>
              </span>
              <button title="Next renderer (.)" onClick={() => renderer.next()}>
                <Icon name={ICONS.chevronRight} size={14} />
              </button>
            </div>
            <div class="np__nav-row">
              <button title="Previous shape ([)" onClick={() => shape.prev()}>
                <Icon name={ICONS.chevronLeft} size={14} />
              </button>
              <span class="np__nav-name" onClick={() => shape.next()}>
                shape · <b>{shape.name()}</b>
              </span>
              <button title="Next shape (])" onClick={() => shape.next()}>
                <Icon name={ICONS.chevronRight} size={14} />
              </button>
            </div>
          </div>
        </Show>
      </div>
    </article>
  );
}
