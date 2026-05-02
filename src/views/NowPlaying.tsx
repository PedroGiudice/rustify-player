/* ============================================================
   views/NowPlaying.tsx — Migra now-playing.js para Solid.
   Video de fundo via HTTP media server local (workaround WebKitGTK).
   ============================================================ */

import { createSignal, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import { player } from "../store/player";
import { libGetLyrics, coverUrl, channelLabel, onPlayerState } from "../tauri";
import { navigate } from "../router";
import type { LyricLine } from "../tauri";

const { invoke } = window.__TAURI__.core;

export default function NowPlaying() {
  const [bgUrl, setBgUrl] = createSignal("");
  const [lyrics, setLyrics] = createSignal<LyricLine[]>([]);
  const [activeLyric, setActiveLyric] = createSignal(-1);
  const [lyricsMode, setLyricsMode] = createSignal<"timed" | "plain" | "empty">("empty");

  // Background video served by the fixed-port local media server
  onMount(() => {
    setBgUrl("http://127.0.0.1:19876/bg-video.mp4");
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
      {/* Video background via HTTP local server */}
      <Show when={bgUrl()}>
        <div class="np-bg-video">
          <video
            class="np-bg-video__el"
            src={bgUrl()}
            autoplay
            loop
            muted
            playsinline
          />
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
                const id = player.currentTrack?.artist_id;
                if (id) navigate(`/artist/${id}`);
              }}
            >
              {player.currentTrack?.artist_name ?? "—"}
            </div>

            <div
              class="np__album"
              onClick={() => {
                const id = player.currentTrack?.album_id;
                if (id) navigate(`/album/${id}`);
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
