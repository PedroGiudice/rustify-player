/* ============================================================
   NowPlaying.tsx — overlay do handoff.

   Diferenças do protótipo, todas por falta de trilho no v0:
   - sem letras (o toggle e o trilho de lyrics saíram; lrc_path
     existe no Track mas exibir é a fase seguinte). Por isso a capa
     já nasce no tamanho do estado "sem letra" do handoff;
   - sem sheet de "track info" (codec/bitrate não existem no shape
     do Track) e sem coração (não há trilho de like);
   - shuffle/repeat saíram dos controles: o plugin não tem command
     para nenhum dos dois. No lugar, o acesso à fila.
   O seek É real: o contrato tem seek_to.
   ============================================================ */

import { Show, createSignal } from "solid-js";
import { Cover } from "./Cover";
import { Icon } from "../icons";
import { back, isNpOpen, navigate } from "../nav";
import { current, next, pb, previous, queueOrigin, seek, showToast, toggle } from "../store";
import { fmtDuration, originLabel, originSrc } from "../derive";
import { useRenderer, useShape } from "../bg/spectrum";

export function NowPlaying() {
  const [scrub, setScrub] = createSignal<number | null>(null);
  let trackEl: HTMLDivElement | undefined;

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
    <div class="np" attr:data-open={isNpOpen() ? "" : undefined} onPointerDown={onDown} onPointerUp={onUp}>
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
                <span>{[t().artist_name, t().album_title].filter(Boolean).join(" · ") || "—"}</span>
              </div>

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
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
