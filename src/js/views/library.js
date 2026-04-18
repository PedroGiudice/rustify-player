import { renderView } from "./_view.js";

export function render() {
  return renderView({
    title: "Local Library",
    emptyIcon: "library",
    emptyTitle: "No tracks indexed yet",
    emptyHint: "Point to a music folder in Settings",
  });
}
