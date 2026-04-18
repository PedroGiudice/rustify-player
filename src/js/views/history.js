import { renderView } from "./_view.js";

export function render() {
  return renderView({
    title: "History",
    emptyIcon: "history",
    emptyTitle: "No playback history yet",
    emptyHint: "Tracks you play will appear here",
  });
}
