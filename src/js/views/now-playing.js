// Now Playing — hero view with cover art, tech info grid, seek bar.
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

    const track = state.current_track;
    let coverHTML = "";
    if (track.album_id) {
      try {
        const album = await invoke("lib_get_album", { id: track.album_id });
        if (album?.cover_path) {
          coverHTML = `<img src="${convertFileSrc(album.cover_path)}" alt="">`;
        }
      } catch (_) {}
    }

    const depth = track.bit_depth ? `${track.bit_depth}bit` : "\u2014";
    const rate = track.sample_rate ? `${track.sample_rate / 1000}kHz` : "\u2014";
    const dur = track.duration_secs || 0;

    root.innerHTML = `
      <div class="np__cover">
        ${coverHTML}
        <div class="np__cover-badge">FLAC \u2022 ${depth}</div>
      </div>
      <div class="np__body">
        <div class="np__eyebrow">
          <span class="np__eyebrow-tag">Now Playing</span>
          <span>Local \u2022 PipeWire</span>
        </div>
        <h1 class="np__title">${esc(track.title || "\u2014")}</h1>
        <div class="np__artist" id="np-artist">${esc(track.artist_name || "\u2014")}</div>
        <div class="np__album" id="np-album">${esc(track.album_title || "\u2014")}</div>
        <div class="np__seek">
          <div class="progress" id="np-progress">
            <div class="progress__fill" id="np-fill" style="width:0%"></div>
            <div class="progress__thumb" id="np-thumb" style="left:0%"></div>
          </div>
          <div class="np__seek-times">
            <span id="np-time-cur">0:00</span>
            <span id="np-time-total">${fmtDur(dur)}</span>
          </div>
        </div>
        <div class="np__info-grid">
          <div class="np__tech">
            ${techCell("Sample Rate", rate)}
            ${techCell("Bit Depth", depth)}
            ${techCell("Format", "FLAC")}
            ${techCell("Channels", "2 \u2022 Stereo")}
            ${techCell("DSP", "Bit-Perfect")}
            ${techCell("Output", "PipeWire")}
          </div>
          <div class="np__lyrics">
            <span class="np__tech-label">Lyrics</span>
            <div class="np__lyrics-scroll" id="np-lyrics">
              <p class="np__lyrics-empty">Loading lyrics...</p>
            </div>
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

    // Live position updates
    const fill = view.querySelector("#np-fill");
    const thumb = view.querySelector("#np-thumb");
    const timeCur = view.querySelector("#np-time-cur");

    if (positionUnlisten) positionUnlisten();
    positionUnlisten = await listen("player-state", (e) => {
      const payload = e.payload;
      if (payload.Position) {
        const secs = payload.Position.samples_played / payload.Position.sample_rate;
        if (dur > 0) {
          const pct = Math.min(100, (secs / dur) * 100);
          fill.style.width = `${pct}%`;
          thumb.style.left = `${pct}%`;
          timeCur.textContent = fmtDur(secs);
        }
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

function techCell(label, value) {
  return `<div class="np__tech-cell"><span class="np__tech-label">${label}</span><span class="np__tech-value">${value}</span></div>`;
}

function fmtDur(secs) {
  if (!secs) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
