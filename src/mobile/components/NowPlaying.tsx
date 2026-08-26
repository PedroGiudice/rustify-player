/* ============================================================
   NowPlaying.tsx — overlay do handoff.

   Diferenças do protótipo:
   - letras ENTRARAM (14/08, pedido do CEO): lib_get_lyrics lê o
     sidecar .lrc, a rail sincroniza com positionMs e o estado
     [data-lyr] encolhe a capa como no handoff. Sem sidecar, o
     toggle some e vale a geometria "sem letra";
   - artista e álbum são navegáveis (15/08) e a sheet de "track
     info" existe via long-press na linha da faixa — mas ainda sem
     codec/bitrate, que não estão no shape do Track;
   - sem coração: não há trilho de like (epic C) — o slot do
     cabeçalho antes do rádio fica reservado pra ele (CMR-220);
   - repeat (15/08) off/all/one, com o serviço carimbando origin
     `repeat` nas re-escutas de repeat-one — desceu do cabeçalho pra
     fileira de controles (26/08);
   - shuffle ENTROU (26/08, CMR-218) como ação one-shot "Embaralhar o
     restante": `shuffle_upcoming` permuta só a cauda no Kotlin, sem
     estado nem restauração da ordem, e a UI aplica o snapshot que
     volta. Não é origin — a fila mantém a origem por item. A fileira
     é shuffle | prev | play | next | repeat.
   O seek É real: o contrato tem seek_to.
   ============================================================ */

import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js";
import { Cover } from "./Cover";
import { Icon } from "../icons";
import { back, isNpOpen, navigate, navigateFromNp } from "../nav";
import {
  current,
  cycleRepeat,
  next,
  pb,
  playSimilar,
  previous,
  queueEntries,
  queueOrigin,
  repeat,
  seek,
  showToast,
  shuffleUpcoming,
  toggle,
} from "../store";
import { albumKey, fmtDuration, originLabel, originSrc } from "../derive";
import { canShuffleUpcoming } from "../queueModel";
import { useRenderer, useShape } from "../bg/spectrum";
import { libGetLyrics } from "../ipc";
import type { LyricLine } from "../types";

const LYR_KEY = "kv-mobile-lyrics";

export function NowPlaying() {
  const [scrub, setScrub] = createSignal<number | null>(null);
  let trackEl: HTMLDivElement | undefined;

  // ── Letras (sidecar .lrc via lib_get_lyrics) ────────────────
  const [lyrOn, setLyrOn] = createSignal(localStorage.getItem(LYR_KEY) !== "off");
  const toggleLyrics = () => {
    const on = !lyrOn();
    setLyrOn(on);
    localStorage.setItem(LYR_KEY, on ? "on" : "off");
  };
  const [lyrics] = createResource(
    () => current()?.id ?? null,
    async (id) => (id ? await libGetLyrics(id).catch(() => [] as LyricLine[]) : []),
    { initialValue: [] as LyricLine[] },
  );
  // Sidecar só nasce de letra sincronizada, mas t=0 em tudo = unsynced
  // (mesma detecção do desktop): vira viewport rolável sem linha ativa.
  const isSynced = createMemo(() => lyrics().some((l) => l.t > 0));
  const showLyrics = createMemo(() => lyrOn() && lyrics().length > 0);
  const activeIdx = createMemo(() => {
    if (!isSynced()) return -1;
    const pos = pb.positionMs / 1000;
    let idx = -1;
    for (const [i, l] of lyrics().entries()) {
      if (l.t <= pos) idx = i;
      else break;
    }
    return idx;
  });

  let lyricsEl: HTMLDivElement | undefined;
  let railEl: HTMLDivElement | undefined;
  createEffect(() => {
    const idx = activeIdx();
    if (!railEl || !lyricsEl || !showLyrics()) return;
    if (idx < 0) {
      railEl.style.transform = "translateY(0)";
      return;
    }
    const line = railEl.children[idx] as HTMLElement | undefined;
    if (!line) return;
    // Linha ativa a ~1/3 do viewport (a mask apaga topo e rodapé).
    const target = Math.max(0, line.offsetTop - lyricsEl.clientHeight * 0.32);
    railEl.style.transform = `translateY(${-target}px)`;
  });

  const ratio = () => {
    const s = scrub();
    if (s != null) return s;
    return pb.durationMs > 0 ? Math.min(1, pb.positionMs / pb.durationMs) : 0;
  };
  const shownMs = () => {
    const s = scrub();
    return s != null ? s * pb.durationMs : pb.positionMs;
  };

  const ratioFromX = (clientX: number) => {
    if (!trackEl) return 0;
    const r = trackEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
  };

  const onSeekDown = (e: PointerEvent) => {
    if (pb.durationMs <= 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setScrub(ratioFromX(e.clientX));
  };
  const onSeekMove = (e: PointerEvent) => {
    if (scrub() == null) return;
    setScrub(ratioFromX(e.clientX));
  };
  const onSeekUp = (e: PointerEvent) => {
    const s = scrub();
    if (s == null) return;
    setScrub(null);
    void seek(s * pb.durationMs);
    e.stopPropagation();
  };

  // Arrastar pra baixo fecha (porte do protótipo)
  let ny = 0, nt = 0;
  const onDown = (e: PointerEvent) => {
    ny = e.clientY;
    nt = Date.now();
  };
  const onUp = (e: PointerEvent) => {
    if (scrub() != null) return;
    if (Date.now() - nt < 600 && e.clientY - ny > 60) back();
  };

  return (
    <div
      class="np"
      attr:data-open={isNpOpen() ? "" : undefined}
      attr:data-lyr={showLyrics() ? "" : undefined}
      onPointerDown={onDown}
      onPointerUp={onUp}
    >
      <div class="veil" />
      <div class="inner">
        <div class="grab" />
        <div class="nphead">
          <div class="eyebrow">Now playing</div>
          <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
            <button
              class="shapebtn"
              onClick={() => {
                useRenderer.next();
                showToast("Render · " + useRenderer.name());
              }}
            >
              {useRenderer.name()}
            </button>
            <button
              class="shapebtn"
              onClick={() => {
                useShape.next();
                showToast("Shape · " + useShape.name());
              }}
            >
              {useShape.name()}
            </button>
            <Show when={lyrics().length > 0}>
              <button
                class="iconbtn"
                aria-label="Letra"
                aria-pressed={lyrOn()}
                style={lyrOn() ? { color: "var(--accent)" } : undefined}
                onClick={toggleLyrics}
              >
                <Icon.lyrics />
              </button>
            </Show>
            <Show when={current()}>
              {(t) => (
                <button
                  class="iconbtn"
                  aria-label="Rádio da faixa"
                  onClick={() => void playSimilar(t())}
                >
                  <Icon.radio />
                </button>
              )}
            </Show>
            <button class="iconbtn" aria-label="Fila" onClick={() => navigate("/queue")}>
              <Icon.queue />
            </button>
            <button class="iconbtn" aria-label="Fechar" onClick={() => back()}>
              <Icon.down />
            </button>
          </div>
        </div>

        <Show
          when={current()}
          fallback={
            <div class="empty" style={{ margin: "auto" }}>
              <div class="e1">Nada tocando</div>
              <div class="e2">Escolha uma faixa na biblioteca para começar.</div>
            </div>
          }
        >
          {(t) => (
            <>
              <Cover path={t().album_cover_path} seed={t().id} cls="cover" icon="disc" />
              <div class="title">{t().title}</div>
              <div class="artist">
                <span class="srcbadge" attr:data-src={originSrc(queueOrigin())}>
                  {originLabel(queueOrigin())}
                </span>
                {/* Artista e álbum navegáveis: ouvir algo bom e ir direto ao
                    álbum é o gesto de exploração mais barato que existe. */}
                <span class="npmeta">
                  <Show when={t().artist_name} fallback={<span>—</span>}>
                    {(name) => (
                      <button class="npmeta__link" onClick={() => navigateFromNp("/artist", name())}>
                        {name()}
                      </button>
                    )}
                  </Show>
                  <Show when={t().album_title}>
                    {(album) => (
                      <>
                        <span aria-hidden="true"> · </span>
                        <button
                          class="npmeta__link"
                          onClick={() => navigateFromNp("/album", albumKey(t()))}
                        >
                          {album()}
                        </button>
                      </>
                    )}
                  </Show>
                </span>
              </div>

              <Show when={showLyrics()}>
                <div class="lyrics" ref={lyricsEl} attr:data-static={isSynced() ? undefined : ""}>
                  <div class="lrail" ref={railEl}>
                    <For each={lyrics()}>
                      {(l, i) => (
                        <p
                          attr:data-on={isSynced() && i() === activeIdx() ? "" : undefined}
                          attr:data-header={l.header ? "" : undefined}
                        >
                          {l.line || "…"}
                        </p>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <div class="bar">
                <div
                  class="seek"
                  onPointerDown={onSeekDown}
                  onPointerMove={onSeekMove}
                  onPointerUp={onSeekUp}
                  onPointerCancel={() => setScrub(null)}
                >
                  <div class="track" ref={trackEl}>
                    <i style={{ width: `${ratio() * 100}%` }} />
                  </div>
                </div>
                <div class="times">
                  <span>{fmtDuration(shownMs())}</span>
                  <span>{fmtDuration(pb.durationMs || t().duration_ms)}</span>
                </div>
              </div>

              <div class="ctrls">
                <button
                  class="iconbtn"
                  aria-label="Embaralhar o restante"
                  disabled={!canShuffleUpcoming(queueEntries(), pb.index)}
                  onClick={() => void shuffleUpcoming()}
                >
                  <Icon.shuffle />
                </button>
                <button class="iconbtn" aria-label="Anterior" onClick={() => void previous()}>
                  <Icon.prev />
                </button>
                <button class="fab" aria-label={pb.isPlaying ? "Pausar" : "Tocar"} onClick={() => void toggle()}>
                  <Show when={pb.isPlaying} fallback={<Icon.play />}>
                    <Icon.pause />
                  </Show>
                </button>
                <button class="iconbtn" aria-label="Próxima" onClick={() => void next()}>
                  <Icon.next />
                </button>
                <button
                  class="iconbtn"
                  aria-label="Repetir"
                  aria-pressed={repeat() !== "off"}
                  style={repeat() !== "off" ? { color: "var(--accent)" } : undefined}
                  onClick={() => void cycleRepeat()}
                >
                  <Show when={repeat() === "one"} fallback={<Icon.repeat />}>
                    <Icon.repeatOne />
                  </Show>
                </button>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
