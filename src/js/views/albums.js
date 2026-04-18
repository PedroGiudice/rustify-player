import { renderView } from "./_view.js";

export function render() {
  return renderView({
    title: "Albums",
    emptyIcon: "album",
    emptyTitle: "No albums loaded yet",
    emptyHint: "Point to a music folder in Settings",
  });
}
