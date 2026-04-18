import { renderView } from "./_view.js";

export function render() {
  return renderView({
    title: "Home",
    emptyIcon: "folder-music",
    emptyTitle: "Nothing to listen to yet",
    emptyHint: "Point to a music folder in Settings",
  });
}
