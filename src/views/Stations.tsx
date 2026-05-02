/* ============================================================
   views/Stations.tsx — Mood stations (AI-generated radios).
   List view + detail view (track table).
   Markup identico ao stations.js vanilla.
   ============================================================ */

import { createResource, createSignal, Show, For } from "solid-js";
import { libListMoods, libListMoodTracks, libAutoplayNext, coverUrl } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { showTrackMenu } from "../js/components/context-menu.js";
import type { Track } from "../tauri";

function formatMs(ms: number | null): string {
  if (!ms) return "—";
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Stations() {
  const [stations] = createResource(() => libListMoods());
  const [activeStation, setActiveStation] = createSignal<any>(null);
  const [stationTracks, setStationTracks] = createSignal<Track[]>([]);

  async function openStation(station: any) {
    try {
      const tracks = await libListMoodTracks(station.id);
      setActiveStation(station);
      setStationTracks(tracks);
    } catch (err) {
      console.error("[stations] load tracks failed:", err);
      setStationTracks([]);
    }
  }

  function goBack() {
    setActiveStation(null);
    setStationTracks([]);
  }

  async function playStation(stationId: number) {
    try {
      const tracks = await libListMoodTracks(stationId);
      if (tracks.length > 0) {
        // Shuffle
        for (let i = tracks.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
        }
        setQueue(tracks, 0);
        playTrack(tracks[0]);
      }
    } catch (err) {
      console.error("[stations] play failed:", err);
    }
  }

  async function startSmartStation() {
    try {
      const tracks = await libAutoplayNext(0, [], 5);
      if (tracks.length > 0) {
        setQueue(tracks, 0);
        playTrack(tracks[0]);
      }
    } catch (err) {
      console.error("[stations] smart station failed:", err);
    }
  }

  function handleTrackClick(idx: number) {
    const tracks = stationTracks();
    if (idx >= 0 && idx < tracks.length) {
      setQueue(tracks, idx);
      playTrack(tracks[idx]);
    }
  }

  return (
    <article class="view">
      <Show when={!activeStation()}>
        {/* List view */}
        <header class="view__header">
          <h1 class="view__title">Stations</h1>
          <div class="view__stats">
            <span>{stations()?.length ?? 0} stations</span>
            <span class="view__stats-sep">{"•"}</span>
            <span>AI generated moods</span>
          </div>
        </header>

        <div class="view__body">
          <Show when={stations()} fallback={<p class="empty-state__hint">Loading...</p>}>
            {(list) => (
              <div class="station-grid">
                {/* Smart station (Your Mix) */}
                <div class="station-card" style="--station-color: var(--accent)" onClick={startSmartStation}>
                  <div class="station-card__info">
                    <div class="station-card__title">Your Mix</div>
                    <div class="station-card__count">{"Infinite · Based on your taste"}</div>
                  </div>
                  <button class="station-card__play" onClick={(e) => { e.stopPropagation(); startSmartStation(); }} aria-label="Play Your Mix">
                    <svg class="icon icon--filled"><use href="#icon-play" /></svg>
                  </button>
                </div>

                <For each={list()}>
                  {(s: any) => (
                    <div
                      class="station-card"
                      style={s.accent_color ? `--station-color: ${s.accent_color}` : undefined}
                      onClick={() => openStation(s)}
                    >
                      <div class="station-card__info">
                        <div class="station-card__title">{s.name}</div>
                        <div class="station-card__count">{s.track_count} tracks</div>
                      </div>
                      <button class="station-card__play" onClick={(e) => { e.stopPropagation(); playStation(s.id); }} aria-label={`Play ${s.name}`}>
                        <svg class="icon icon--filled"><use href="#icon-play" /></svg>
                      </button>
                    </div>
                  )}
                </For>
              </div>
            )}
          </Show>
        </div>
      </Show>

      <Show when={activeStation()}>
        {(s) => (
          <>
            {/* Detail view */}
            <header class="view__header">
              <div style="display:flex;align-items:center;gap:var(--space-3)">
                <button class="icon-btn" onClick={goBack} aria-label="Back to stations">
                  <svg class="icon"><use href="#icon-chevron-left" /></svg>
                </button>
                <h1 class="view__title">{s().name}</h1>
              </div>
              <div class="view__stats">
                <span>{s().track_count} tracks</span>
                <span class="view__stats-sep">{"•"}</span>
                <span>Station</span>
              </div>
            </header>

            <div class="view__body">
              <table class="track-table">
                <thead>
                  <tr>
                    <th class="track-table__th track-table__th--cover"></th>
                    <th class="track-table__th track-table__th--num">#</th>
                    <th class="track-table__th">Title</th>
                    <th class="track-table__th">Artist</th>
                    <th class="track-table__th">Album</th>
                    <th class="track-table__th track-table__th--dur">Duration</th>
                    <th class="track-table__th track-table__th--more"></th>
                  </tr>
                </thead>
                <tbody>
                  <For each={stationTracks()}>
                    {(t, i) => (
                      <tr
                        class="track-row"
                        onClick={() => handleTrackClick(i())}
                        onContextMenu={(e) => { e.preventDefault(); showTrackMenu(e, t, stationTracks(), i()); }}
                      >
                        <td class="track-table__td track-table__td--cover">
                          <Show when={t.album_cover_path}>
                            {(p) => <img src={coverUrl(p())!} loading="lazy" alt="" />}
                          </Show>
                        </td>
                        <td class="track-table__td track-table__td--num">{i() + 1}</td>
                        <td class="track-table__td track-table__td--title">{t.title}</td>
                        <td class="track-table__td">{t.artist_name || "—"}</td>
                        <td class="track-table__td">{t.album_title || "—"}</td>
                        <td class="track-table__td track-table__td--dur">{formatMs(t.duration_ms)}</td>
                        <td class="track-table__td track-table__td--more">
                          <button class="more-btn" aria-label="More" onClick={(e) => { e.stopPropagation(); showTrackMenu(e, t, stationTracks(), i()); }}>
                            <svg class="icon icon--sm"><use href="#icon-more-vertical" /></svg>
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </>
        )}
      </Show>
    </article>
  );
}
