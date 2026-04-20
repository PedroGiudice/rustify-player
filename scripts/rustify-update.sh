#!/usr/bin/env bash
# Rustify Player — update checker + installer.
#
# Two modes:
#   --check-json   Emit a JSON status document on stdout.
#   --install      Download the latest .deb and run `pkexec dpkg -i`.
#
# Invoked by the app itself (Tauri commands `check_for_update` and
# `install_update`) and also usable from the shell.
#
# Dependencies: gh, jq, dpkg-query, stat, pkexec, mktemp, date.
# All of the above are either preinstalled on Ubuntu or already used in the
# project's normal workflow (gh).

set -euo pipefail

REPO="PedroGiudice/rustify-player"
TAG="dev"
PKG="rustify-player"

emit_error_json() {
    # $1 is a short machine-readable error code; $2 is a human-readable
    # message. Both go into the JSON so the caller can decide what to render.
    local code="$1" msg="$2"
    jq -n --arg c "$code" --arg m "$msg" '{error: $c, message: $m}'
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "missing required command: $1" >&2
        exit 2
    }
}

cmd_check_json() {
    require_cmd gh
    require_cmd jq
    require_cmd dpkg-query
    require_cmd stat
    require_cmd date

    local current_ver
    # Prefer the VERSION file the .deb installs (carries the git sha from the
    # build). Fall back to the dpkg package version for installs that predate
    # the VERSION file.
    if [ -r /usr/share/rustify-player/VERSION ]; then
        current_ver=$(head -n 1 /usr/share/rustify-player/VERSION)
    else
        current_ver=$(dpkg-query -W -f='${Version}' "$PKG" 2>/dev/null || echo "unknown")
    fi

    local remote_data
    if ! remote_data=$(gh release view "$TAG" -R "$REPO" --json name,assets,body 2>/dev/null); then
        emit_error_json "github_query_failed" "Could not query GitHub release. Is 'gh' authenticated?"
        return 0
    fi

    local remote_pub remote_url remote_ver remote_body remote_sha
    # Use the .deb asset's updatedAt (rewritten on every upload) instead of
    # the release's publishedAt (set only on creation). With a rolling "dev"
    # tag, publishedAt never advances — updatedAt tracks each new build.
    remote_pub=$(echo "$remote_data" | jq -r '[.assets[] | select(.name | endswith(".deb"))] | .[0].updatedAt // empty')
    remote_url=$(echo "$remote_data" | jq -r '.assets[] | select(.name | endswith(".deb")) | .url' | head -n 1)
    # Extract the short commit SHA from the release notes body (release.sh
    # writes "Branch: X  ·  Commit: <sha>  ·  <ts>"). Combined with the Cargo
    # version gives a friendly diff like "0.1.0 · 0a40f91" in the UI.
    remote_body=$(echo "$remote_data" | jq -r '.body // empty')
    remote_sha=$(echo "$remote_body" | grep -oE 'Commit: [a-f0-9]{7,}' | head -n 1 | awk '{print $2}')
    local remote_name
    remote_name=$(echo "$remote_data" | jq -r '.name // empty')
    if [ -n "$remote_sha" ]; then
        remote_ver="0.1.0 · $remote_sha"
    else
        remote_ver="$remote_name"
    fi

    if [ -z "$remote_pub" ] || [ -z "$remote_url" ]; then
        emit_error_json "no_release_asset" "Release exists but has no .deb asset."
        return 0
    fi

    # Local install timestamp: mtime of dpkg's md5sums file for this package.
    # dpkg rewrites it on every install/upgrade, so it's a reliable proxy for
    # "when was this binary installed on this machine".
    local local_install_ts
    if [ -f "/var/lib/dpkg/info/${PKG}.md5sums" ]; then
        local_install_ts=$(stat -c %Y "/var/lib/dpkg/info/${PKG}.md5sums")
    else
        local_install_ts=0
    fi

    local remote_pub_ts
    remote_pub_ts=$(date -d "$remote_pub" +%s 2>/dev/null || echo 0)

    local update_available="false"
    if [ "$remote_pub_ts" -gt "$local_install_ts" ]; then
        update_available="true"
    fi

    jq -n \
        --arg cv "$current_ver" \
        --arg lv "$remote_ver" \
        --arg pa "$remote_pub" \
        --arg du "$remote_url" \
        --argjson ua "$update_available" \
        '{
            current_version: $cv,
            latest_version: $lv,
            update_available: $ua,
            published_at: $pa,
            download_url: $du
        }'
}

cmd_install() {
    require_cmd gh
    require_cmd pkexec
    require_cmd mktemp

    local tmpdir
    tmpdir=$(mktemp -d -t rustify-update-XXXXXX)
    trap 'rm -rf "$tmpdir"' EXIT

    # gh writes the asset with its original name; --clobber guarantees
    # overwrite if something weird was left behind.
    gh release download "$TAG" -R "$REPO" -p '*.deb' -D "$tmpdir" --clobber

    local deb
    deb=$(find "$tmpdir" -maxdepth 1 -name '*.deb' | head -n 1)
    if [ -z "$deb" ]; then
        echo "download succeeded but no .deb found in $tmpdir" >&2
        exit 3
    fi

    # pkexec drives polkit, which prompts for the user's password in the
    # desktop environment's native dialog. No root subprocess of this script.
    pkexec dpkg -i "$deb"
}

case "${1:-help}" in
    --check-json|check) cmd_check_json ;;
    --install|install)  cmd_install ;;
    *)
        cat <<EOF
usage: rustify-update [--check-json | --install]

  --check-json  Emit a JSON status document on stdout with current and
                latest versions, whether an update is available, and the
                download URL.
  --install     Download the latest .deb from the 'dev' rolling release
                and install it via pkexec (GUI password prompt).
EOF
        ;;
esac
