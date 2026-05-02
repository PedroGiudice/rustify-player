/* ============================================================
   views/NowPlaying.tsx
   ============================================================ */

import { createSignal, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import { player } from "../store/player";
import { libGetLyrics, coverUrl, channelLabel, getTrackColor } from "../tauri";
import { navigate } from "../router";
import type { LyricLine } from "../tauri";

const MEDIA_BASE = "http://127.0.0.1:19876/bg";

type PaletteMap = Record<string, [number, number, number]>;

let paletteCache: [string, number, number, number][] | null = null;

async function loadPalette(): Promise<[string, number, number, number][]> {
  if (paletteCache) return paletteCache;
  try {
    const resp = await fetch(`${MEDIA_BASE}/palette.json`);
    const map: PaletteMap = await resp.json();
    paletteCache = Object.entries(map).map(([name, rgb]) => [
      `${MEDIA_BASE}/${name}.webp`, rgb[0], rgb[1], rgb[2],
    ]);
  } catch {
    paletteCache = [];
  }
  return paletteCache;
}

function pickBg(palette: [string, number, number, number][], hex: string): string | null {
  if (!palette.length || !hex) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [, pr, pg, pb] = palette[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return palette[best][0];
}

export default function NowPlaying() {
  const [bgUrl, setBgUrl] = createSignal("");
  const [lyrics, setLyrics] = createSignal<LyricLine[]>([]);
  const [activeLyric, setActiveLyric] = createSignal(-1);
  const [lyricsMode, setLyricsMode] = createSignal<"timed" | "plain" | "empty">("empty");

  createEffect(async () => {
    const track = player.currentTrack;
    const palette = await loadPalette();
    if (!palette.length) return;
    if (!track?.id) {
      setBgUrl(palette[0][0]);
      return;
    }
    try {
      const hex = await getTrackColor(track.id);
      setBgUrl(hex ? pickBg(palette, hex) ?? palette[0][0] : palette[0][0]);
    } catch {
      setBgUrl(palette[0][0]);
    }
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
        <img class="np-bg__el" src={bgUrl()} alt="" />
      </div>

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
