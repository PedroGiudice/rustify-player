/* ============================================================
   views/NowPlaying.tsx
   ============================================================ */

import { createSignal, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import { player } from "../store/player";
import { libGetLyrics, coverUrl, channelLabel, getTrackColor, listShapes } from "../tauri";
import { navigate } from "../router";
import SpectrumBackground from "../components/SpectrumBackground";
import type { LyricLine } from "../tauri";

const SHAPES_BASE = "http://127.0.0.1:19876/shapes";

export default function NowPlaying() {
  const [lyrics, setLyrics] = createSignal<LyricLine[]>([]);
  const [shapes, setShapes] = createSignal<string[]>([]);
  const [shapeIdx, setShapeIdx] = createSignal(0);
  const [activeLyric, setActiveLyric] = createSignal(-1);
  const [lyricsMode, setLyricsMode] = createSignal<"timed" | "plain" | "empty">("empty");

  const shapeUrl = () => {
    const s = shapes();
    if (!s.length) return null;
    return `${SHAPES_BASE}/${s[shapeIdx() % s.length]}`;
  };

  const prevShape = () => {
    const s = shapes();
    if (s.length < 2) return;
    const idx = (shapeIdx() - 1 + s.length) % s.length;
    setShapeIdx(idx);
    localStorage.setItem("rustify-shape-idx", String(idx));
  };

  const nextShape = () => {
    const s = shapes();
    if (s.length < 2) return;
    const idx = (shapeIdx() + 1) % s.length;
    setShapeIdx(idx);
    localStorage.setItem("rustify-shape-idx", String(idx));
  };

  onMount(async () => {
    try {
      const s = await listShapes();
      setShapes(s);
      const saved = localStorage.getItem("rustify-shape-idx");
      if (saved) setShapeIdx(Math.min(Number(saved), s.length - 1));
    } catch {}
  });

  // Load lyrics when track changes
  createEffect(async () => {
    const track = player.currentTrack;
    if (!track?.id) {
      setLyrics([]);
      setLyricsMode("empty");
      return;
    }
    try {
      const lines = await libGetLyrics(track.id);
      if (!lines?.length) { setLyricsMode("empty"); setLyrics([]); return; }
      const allZero = lines.every((l) => (l.t ?? 0) === 0);
      setLyricsMode(allZero ? "plain" : "timed");
      setLyrics(lines);
    } catch {
      setLyricsMode("empty");
      setLyrics([]);
    }
  });

  // Update active lyric line based on position
  createEffect(() => {
    const secs = player.positionSecs;
    if (lyricsMode() !== "timed") return;
    const lines = lyrics();
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i].t ?? 0) <= secs) idx = i;
      else break;
    }
    if (idx !== activeLyric()) {
      setActiveLyric(idx);
      // Auto-scroll active line into view
      const el = document.querySelector("#np-lyrics .np__lyrics-line.is-active");
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });

  const depth  = () => player.currentTrackInfo?.bit_depth ? `${player.currentTrackInfo.bit_depth}-bit` : "—";
  const rate   = () => player.currentTrackInfo?.sample_rate ? `${player.currentTrackInfo.sample_rate / 1000} kHz` : "—";
  const chanStr = () => channelLabel(player.currentTrackInfo?.channels ?? null);

  return (
    <article class="view view--hero">
      <div class="np-bg">
        <SpectrumBackground shapeUrl={shapeUrl()} />
      </div>

      <Show when={shapes().length > 1}>
        <div class="np-shape-nav">
          <button class="np-shape-nav__btn" onClick={prevShape} title="Previous shape">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button class="np-shape-nav__btn" onClick={nextShape} title="Next shape">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </Show>

      <Show
        when={player.currentTrack}
        fallback={
          <div class="empty-state">
            <svg class="empty-state__icon" aria-hidden="true">
              <use href="#icon-music-note" />
            </svg>
            <p class="empty-state__title">Nothing playing</p>
            <p class="empty-state__hint">Pick a track to start</p>
          </div>
        }
      >
        <div class="np">
          {/* Cover */}
          <div class="np__cover">
            <Show when={player.currentTrack?.album_cover_path}>
              {(path) => <img src={coverUrl(path())} alt="" />}
            </Show>
          </div>

          {/* Metadata */}
          <div class="np__body">
            <div class="np__eyebrow">
              <span class="np__eyebrow-tag">Now Playing</span>
              <span>Local · PipeWire</span>
            </div>

            <h1 class="np__title">{player.currentTrack?.title ?? "—"}</h1>

            <div
              class="np__artist"
              onClick={() => {
                const name = player.currentTrack?.artist_name;
                if (name) navigate(`/artist/${encodeURIComponent(name)}`);
              }}
            >
              {player.currentTrack?.artist_name ?? "—"}
            </div>

            <div
              class="np__album"
              onClick={() => {
                const title = player.currentTrack?.album_title;
                if (title) navigate(`/album/${encodeURIComponent(title)}`);
              }}
            >
              {player.currentTrack?.album_title ?? "—"}
            </div>

            {/* Tech strip */}
            <div class="np__tech-strip">
              <span class="np__tech-val">{rate()}</span>
              <span class="np__tech-sep">·</span>
              <span class="np__tech-val">{depth()}</span>
              <span class="np__tech-sep">·</span>
              <span class="np__tech-val">FLAC</span>
              <span class="np__tech-sep">·</span>
              <span class="np__tech-val">{chanStr()}</span>
              <span class="np__tech-sep">·</span>
              <span class="np__tech-val">PipeWire</span>
            </div>

            {/* Lyrics */}
            <div class="np__lyrics">
              <span class="np__tech-label">Lyrics</span>
              <div class="np__lyrics-scroll" id="np-lyrics">
                <Show
                  when={lyrics().length > 0}
                  fallback={<p class="np__lyrics-empty">No lyrics available</p>}
                >
                  <For each={lyrics()}>
                    {(line, i) => (
                      <p
                        class={`np__lyrics-line${line.header ? " np__lyrics-line--header" : ""}${activeLyric() === i() ? " is-active" : ""}`}
                      >
                        {line.line}
                      </p>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </article>
  );
}
