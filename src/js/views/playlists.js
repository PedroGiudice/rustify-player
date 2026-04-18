import { renderView } from "./_view.js";

export function render() {
  const view = renderView({
    title: "Playlists",
    emptyIcon: "queue-music",
    emptyTitle: "No playlists yet",
    emptyHint: "Local playlists coming soon",
  });

  const hint = view.querySelector(".empty-state__hint");
  if (hint) {
    hint.insertAdjacentHTML("afterend", `<span class="badge--soon">Coming soon</span>`);
  }
  return view;
}
