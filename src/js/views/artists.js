import { renderView } from "./_view.js";

export function render() {
  return renderView({
    title: "Artists",
    emptyIcon: "person",
    emptyTitle: "No artists loaded yet",
    emptyHint: "Point to a music folder in Settings",
  });
}
