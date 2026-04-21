// Now Playing — hero view with cover art, tech strip, lyrics.
// Layout driven by data-np-layout attribute (left/top/split).

import { navigate } from "../router.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let positionUnlisten = null;
let lyricsState = null; // { lines: [{t, text, header}], mode: "empty" | "plain" | "timed", activeIdx: -1 }

export function render() {
  const view = document.createElement("article");
  view.className = "view view--hero";
  view.innerHTML = `<div class="np" id="np-root"><p class="empty-state__hint">Loading...</p></div>`;
  load(view);
  return view;
}

async function load(view) {
  const root = view.querySelector("#np-root");

  try {
    const state = await invoke("get_state");
    if (!state || !state.current_track) {
      root.innerHTML = `<div class="empty-state">
        <svg class="empty-state__icon" aria-hidden="true"><use href="#icon-music-note"></use></svg>
        <p class="empty-state__title">Nothing playing</p>
        <p class="empty-state__hint">Pick a track to start</p>
      </div>`;
      return;
    }

    // Audio metadata comes from current_track (path, sample_rate, bit_depth, ...)
    // Library metadata (title, artist, album, cover, lyrics) comes from current_library_track.
    const audio = state.current_track;
    const lib = state.current_library_track || null;

    // Build a unified track object so the rest of the view doesn't need to juggle two sources.
    // Fallback: if no library match, derive a title from the audio path's basename.
    const fallbackTitle = (() => {
      const p = audio.path || "";
      const base = p.split(/[\\/]/).pop() || "";
      return base.replace(/\.[^.]+$/, "") || "—";
    })();

    const track = {
      // library fields (may be missing if lib is null)
      id: lib?.id ?? null,
      title: lib?.title ?? fallbackTitle,
      artist_name: lib?.artist_name ?? "—",
      artist_id: lib?.artist_id ?? null,
      album_id: lib?.album_id ?? null,
      album_title: lib?.album_title ?? "—",
      album_cover_path: lib?.album_cover_path ?? null,
      lrc_path: lib?.lrc_path ?? null,
      // audio fields
      sample_rate: audio.sample_rate,
      bit_depth: audio.bit_depth,
      duration_secs: audio.duration_secs || lib?.duration_secs || 0,
    };

    const coverHTML = track.album_cover_path
      ? `<img src="${convertFileSrc(track.album_cover_path)}" alt="">`
      : "";

    const depth = track.bit_depth ? `${track.bit_depth} bit` : "—";
    const rate = track.sample_rate ? `${track.sample_rate / 1000} kHz` : "—";

    root.innerHTML = `
      <div class="np__cover">
        ${coverHTML}
      </div>
      <div class="np__body">
        <div class="np__eyebrow">
          <span class="np__eyebrow-tag">Now Playing</span>
          <span>Local • PipeWire</span>
        </div>
        <h1 class="np__title">${esc(track.title || "—")}</h1>
        <div class="np__artist" id="np-artist">${esc(track.artist_name || "—")}</div>
        <div class="np__album" id="np-album">${esc(track.album_title || "—")}</div>
        <div class="np__tech-strip">
          <span class="np__tech-val">${rate}</span>
          <span class="np__tech-sep">·</span>
          <span class="np__tech-val">${depth}</span>
          <span class="np__tech-sep">·</span>
          <span class="np__tech-val">FLAC</span>
          <span class="np__tech-sep">·</span>
          <span class="np__tech-val">Stereo</span>
          <span class="np__tech-sep">·</span>
          <span class="np__tech-val">Bit-Perfect</span>
          <span class="np__tech-sep">·</span>
          <span class="np__tech-val">PipeWire</span>
        </div>
        <div class="np__lyrics">
          <span class="np__tech-label">Lyrics</span>
          <div class="np__lyrics-scroll" id="np-lyrics">
            <p class="np__lyrics-empty">Loading lyrics...</p>
          </div>
        </div>
      </div>
    `;

    loadLyrics(view, track);

    // Nav links
    view.querySelector("#np-artist")?.addEventListener("click", () => {
      if (track.artist_id) navigate(`/artist/${track.artist_id}`);
    });
    view.querySelector("#np-album")?.addEventListener("click", () => {
      if (track.album_id) navigate(`/album/${track.album_id}`);
    });

    // Player events: re-render the whole hero on TrackStarted (track
    // changed), clear on Stopped/Idle, drive lyrics highlight on Position.
    if (positionUnlisten) positionUnlisten();
    positionUnlisten = await listen("player-state", (e) => {
      const payload = e.payload;
      if (payload.TrackStarted) {
        // New track: re-hydrate from get_state so cover/title/artist/
        // album/tech/lyrics all refresh together.
        load(view);
      } else if (payload.StateChanged === "Idle" || payload.StateChanged === "Stopped") {
        load(view);
      } else if (payload.Position) {
        const secs = payload.Position.samples_played / payload.Position.sample_rate;
        updateLyricsHighlight(view, secs);
      }
    });
  } catch (err) {
    root.innerHTML = `<div class="empty-state"><p class="empty-state__title">Failed to load</p><p class="empty-state__hint">${err}</p></div>`;
  }
}

async function loadLyrics(view, track) {
  const box = view.querySelector("#np-lyrics");
  if (!box) return;

  lyricsState = null;

  // No library match = no lyrics lookup possible
  if (track.id == null) {
    box.innerHTML = `<p class="np__lyrics-empty">No lyrics available</p>`;
    return;
  }

  let lines = [];
  try {
    lines = await invoke("lib_get_lyrics", { trackId: track.id });
  } catch (err) {
    console.error("[lyrics] fetch failed:", err);
    box.innerHTML = `<p class="np__lyrics-empty">No lyrics available</p>`;
    return;
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    box.innerHTML = `<p class="np__lyrics-empty">No lyrics available</p>`;
    return;
  }

  const allZero = lines.every((l) => (l.t ?? 0) === 0);
  const mode = allZero ? "plain" : "timed";

  box.innerHTML = lines
    .map((l) => {
      const cls = l.header
        ? "np__lyrics-line np__lyrics-line--header"
        : "np__lyrics-line";
      const dataT = mode === "timed" ? ` data-t="${l.t}"` : "";
      return `<p class="${cls}"${dataT}>${esc(l.line || "")}</p>`;
    })
    .join("");

  lyricsState = { lines, mode, activeIdx: -1 };
}

function updateLyricsHighlight(view, secs) {
  if (!lyricsState || lyricsState.mode !== "timed") return;
  const { lines } = lyricsState;

  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i].t ?? 0) <= secs) idx = i;
    else break;
  }

  if (idx === lyricsState.activeIdx) return;

  const box = view.querySelector("#np-lyrics");
  if (!box) return;
  const nodes = box.querySelectorAll(".np__lyrics-line");

  if (lyricsState.activeIdx >= 0 && nodes[lyricsState.activeIdx]) {
    nodes[lyricsState.activeIdx].classList.remove("is-active");
  }
  if (idx >= 0 && nodes[idx]) {
    nodes[idx].classList.add("is-active");
    nodes[idx].scrollIntoView({ block: "center", behavior: "smooth" });
  }
  lyricsState.activeIdx = idx;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
