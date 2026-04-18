import { renderView } from "./_view.js";

export function render() {
  return renderView({
    title: "Playlists",
    emptyIcon: "queue-music",
    emptyTitle: "No playlists yet",
    emptyHint: "Create one from any track selection",
  });
}
