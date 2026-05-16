/* ============================================================
   views/History.tsx — Listening history (full, scrollable).
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import { libListHistory, coverUrl, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { CoverArt } from "../components/CoverArt";

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function relTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

export default function History() {
  const [tracks] = createResource(async () => {
    try { return await libListHistory(200); } catch { return [] as Track[]; }
  });

  function play(t: Track) {
    const all = tracks() ?? [];
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0);
    playTrack(t);
  }

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>History</h1>
          <p class="view__head-hint">Últimas {tracks()?.length ?? 0} faixas tocadas</p>
        </div>
      </header>

      <div class="view__body">
        <Show
          when={(tracks() ?? []).length > 0}
          fallback={
            <div class="empty-state">
              <p class="empty-state__title">Sem histórico ainda</p>
              <p class="empty-state__hint">Toque algumas faixas e elas vão aparecer aqui.</p>
            </div>
          }
        >
          <div class="row-list">
            <For each={tracks() ?? []}>
              {(t) => (
                <div class="row" onClick={() => play(t)}>
                  <CoverArt
                    seed={t.album_title || t.id}
                    src={coverUrl(t.album_cover_path)}
                    size="sm"
                    class="row__cover"
                    style={{ width: "40px", height: "40px" }}
                  />
                  <div class="row__meta">
                    <div class="row__title">{t.title || "—"}</div>
                    <div class="row__sub">{t.artist_name || "—"}{t.album_title && <> · {t.album_title}</>}</div>
                  </div>
                  <div class="row__tech">FLAC · 24/96</div>
                  <div class="row__when">{relTime(t.last_played)}</div>
                  <div class="row__time">{fmtDur(t.duration_ms)}</div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </article>
  );
}
