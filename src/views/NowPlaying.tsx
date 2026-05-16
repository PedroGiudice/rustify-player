/* ============================================================
   views/NowPlaying.tsx — Spectrum bg + cover + meta + lyrics.

   Lyrics from libGetLyrics(track.id); synced to player.positionSecs.
   Shape state read via useShape() from SpectrumCanvas.
   ============================================================ */

import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { player } from "../store/player";
import { Icon, ICONS } from "../components/Icon";
import { CoverArt } from "../components/CoverArt";
import { SpectrumCanvas, useShape } from "../components/SpectrumCanvas";
import { libGetLyrics, coverUrl, type LyricLine } from "../tauri";
import { navigate } from "../router";

export default function NowPlaying() {
  const shape = useShape();
  const [cinema, setCinema] = createSignal(false);

  // Cinema mode toggles a data-attr on the .app shell
  function toggleCinema() {
    const next = !cinema();
    setCinema(next);
    document.getElementById("rustify-app")?.setAttribute("data-cinema", next ? "true" : "false");
  }

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

  // Auto-scroll lyrics rail so active line stays centered
  let railEl!: HTMLDivElement;
  let cardEl!: HTMLElement;
  onMount(() => {
    const apply = () => {
      const i = activeLine();
      if (i < 0 || !railEl || !cardEl) return;
      const line = railEl.children[i] as HTMLElement | undefined;
      if (!line) return;
      const offset = line.offsetTop + line.offsetHeight / 2 - cardEl.clientHeight / 2;
      railEl.style.transform = `translateY(${-Math.max(0, offset)}px)`;
    };
    // Track changes through a tiny rAF loop — cheap, only runs when NP visible
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
      <div class="np">
        <SpectrumCanvas />

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
                  <span><em>bit-perfect</em></span>
                </div>
                <div class="np__specs np__specs--line2">
                  <span>PipeWire → Bifrost 2/64</span>
                  <span>DSP <b>EQ · LIM</b></span>
                  <span>ReplayGain −3.4 dB</span>
                </div>
              </Show>
            </div>
          </div>

          <Show when={(lyrics() ?? []).length > 0}>
            <aside class="np__lyrics-card" ref={cardEl!}>
              <div class="np__lyrics-head">
                <span class="np__lyrics-label">Lyrics · synced</span>
                <span class="np__lyrics-source mono">aligned</span>
              </div>
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
