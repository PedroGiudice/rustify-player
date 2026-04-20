#!/usr/bin/env bash
# Build .deb on the VM and publish as a rolling GH release tagged "dev".
# The cmr-auto pulls with:
#   gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
#   sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb

set -euo pipefail

cd "$(dirname "$0")/.."

REPO="PedroGiudice/rustify-player"
TAG="dev"
DEB="src-tauri/target/release/bundle/deb/rustify-player_0.1.0_amd64.deb"

COMMIT="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
NOTES="Branch: $BRANCH  ·  Commit: $COMMIT  ·  $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Write the build metadata into a file the .deb bundles to /usr/share, so
# the installed app can report which commit it is (matches the format used
# by rustify-update's remote latest_version: "0.1.0 · <sha>"). Must exist
# BEFORE `cargo tauri build` runs — the bundler reads it during packaging.
mkdir -p src-tauri/build-metadata
echo "0.1.0 · $COMMIT" > src-tauri/build-metadata/VERSION

echo "[release] build"
cargo tauri build --bundles deb >/dev/null

test -f "$DEB" || { echo "[release] missing $DEB"; exit 1; }

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "[release] updating existing tag $TAG"
  gh release upload "$TAG" "$DEB" -R "$REPO" --clobber
  gh release edit "$TAG" -R "$REPO" --notes "$NOTES" >/dev/null
else
  echo "[release] creating tag $TAG"
  gh release create "$TAG" "$DEB" -R "$REPO" --title "dev" --notes "$NOTES"
fi

echo "[release] done"
echo "[release] cmr-auto: gh release download -R $REPO -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb"
