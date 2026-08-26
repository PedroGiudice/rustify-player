#!/usr/bin/env bash
# Build do APK Android na VM e publicação no release rolling "dev" junto com
# o manifest `android-latest.json` que o app consulta para se auto-atualizar
# (spec docs/superpowers/specs/2026-08-24-android-auto-update-design.md).
#
#   ./scripts/release_android.sh            # build + upload
#   ./scripts/release_android.sh --dry-run  # build + manifest, sem upload
#
# NAO bumpa versao: bump manual em src-tauri/tauri.conf.json ANTES (o APK
# carimba versionName/versionCode a partir dela; sem bump o aparelho nao ve
# atualizacao — e o asset da versao anterior seria sobrescrito).
#
# APK = debug, so arm64 (o S24 e arm64), sem debuginfo no .so
# (CARGO_PROFILE_DEV_STRIP): 520 MB (universal, com DWARF) -> ~50 MB.
# Assinatura: ~/.android/debug.keystore da VM (backup em cmr-auto:~/backups).
# Trocar de keystore quebra o update por cima (assinatura divergente).

set -euo pipefail

cd "$(dirname "$0")/.."

REPO="PedroGiudice/rustify-player"
TAG="dev"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

for t in gh jq sha256sum bun cargo python3; do
  command -v "$t" >/dev/null 2>&1 || { echo "[android] falta $t"; exit 2; }
done

VERSION="$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
APK_NAME="rustify-player_${VERSION}.apk"
OUT="src-tauri/target/android-release"
APK_OUT_DIR="src-tauri/gen/android/app/build/outputs/apk"
mkdir -p "$OUT"

echo "[android] frontend (obrigatorio: o dist e embutido no .so)"
bun run build

echo "[android] apk v${VERSION} (arm64, debug, strip=debuginfo)"
# Limpa saidas antigas: sem isso um APK velho poderia ser escolhido abaixo.
rm -rf "$APK_OUT_DIR"
(
  cd src-tauri
  CARGO_PROFILE_DEV_STRIP=debuginfo cargo tauri android build --debug --target aarch64 --apk
)

SRC="$(find "$APK_OUT_DIR" -name '*.apk' -path '*debug*' | head -n 1)"
test -n "$SRC" -a -f "$SRC" || { echo "[android] nenhum APK em $APK_OUT_DIR"; exit 1; }

# Versao carimbada no APK precisa ser a do tauri.conf.json (o tauri.properties
# e regenerado no build; se divergir, algo ficou stale).
BUILT_VER="$(sed -n 's/^tauri.android.versionName=//p' src-tauri/gen/android/app/tauri.properties)"
if [[ "$BUILT_VER" != "$VERSION" ]]; then
  echo "[android] versionName do build ($BUILT_VER) != tauri.conf.json ($VERSION)"; exit 1
fi

cp "$SRC" "$OUT/$APK_NAME"
SHA="$(sha256sum "$OUT/$APK_NAME" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$OUT/$APK_NAME")"
jq -n \
  --arg v "$VERSION" \
  --arg u "https://github.com/${REPO}/releases/download/${TAG}/${APK_NAME}" \
  --arg s "$SHA" \
  --argjson z "$SIZE" \
  '{version: $v, apk_url: $u, sha256: $s, size: $z}' > "$OUT/android-latest.json"

echo "[android] $APK_NAME  $((SIZE / 1048576)) MB  sha256=$SHA"
cat "$OUT/android-latest.json"

if [[ "$DRY" == "1" ]]; then
  echo "[android] dry-run: nada publicado"
  exit 0
fi

gh release view "$TAG" -R "$REPO" >/dev/null 2>&1 || { echo "[android] release $TAG nao existe (rode release.sh primeiro)"; exit 1; }
echo "[android] upload -> $REPO@$TAG"
gh release upload "$TAG" "$OUT/$APK_NAME" "$OUT/android-latest.json" -R "$REPO" --clobber
echo "[android] publicado. O aparelho ve a versao no proximo check (Settings > Atualizacao)."
