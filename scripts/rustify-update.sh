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

    local remote_pub remote_url remote_ver remote_body remote_sha remote_asset_name remote_pkg_ver
    # Use the .deb asset's updatedAt (rewritten on every upload) instead of
    # the release's publishedAt (set only on creation). With a rolling "dev"
    # tag, publishedAt never advances — updatedAt tracks each new build.
    #
    # The release accumulates multiple .deb assets across versions (0.1.0,
    # 0.2.0, ...). Sort by updatedAt desc and pick the most recent one;
    # otherwise we'd report 0.1.0 from April as "latest".
    local latest_asset
    latest_asset=$(echo "$remote_data" \
        | jq -c '[.assets[] | select(.name | endswith(".deb"))]
                 | sort_by(.updatedAt) | reverse | .[0] // empty')
    if [ -z "$latest_asset" ] || [ "$latest_asset" = "null" ]; then
        remote_pub=""
        remote_url=""
        remote_asset_name=""
    else
        remote_pub=$(echo "$latest_asset" | jq -r '.updatedAt // empty')
        remote_url=$(echo "$latest_asset" | jq -r '.url // empty')
        remote_asset_name=$(echo "$latest_asset" | jq -r '.name // empty')
    fi
    # Extract version from the asset filename (e.g. rustify-player_0.2.4_amd64.deb → 0.2.4).
    remote_pkg_ver=$(echo "$remote_asset_name" | sed -nE 's/^rustify-player_([0-9.]+)_.*\.deb$/\1/p')
    # Extract the short commit SHA from the release notes body (release.sh
    # writes "Branch: X  ·  Commit: <sha>  ·  <ts>"). Combined with the package
    # version gives a friendly diff like "0.2.4 · 0a40f91" in the UI.
    remote_body=$(echo "$remote_data" | jq -r '.body // empty')
    remote_sha=$(echo "$remote_body" | grep -oE 'Commit: [a-f0-9]{7,}' | head -n 1 | awk '{print $2}')
    local remote_name
    remote_name=$(echo "$remote_data" | jq -r '.name // empty')
    if [ -n "$remote_pkg_ver" ] && [ -n "$remote_sha" ]; then
        remote_ver="$remote_pkg_ver · $remote_sha"
    elif [ -n "$remote_pkg_ver" ]; then
        remote_ver="$remote_pkg_ver"
    elif [ -n "$remote_sha" ]; then
        remote_ver="$remote_sha"
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
    require_cmd jq
    require_cmd pkexec
    require_cmd mktemp
    require_cmd curl

    local tmpdir
    tmpdir=$(mktemp -d -t rustify-update-XXXXXX)
    # Expand $tmpdir into the trap at registration time (double quotes),
    # not at dispatch time. Single quotes would defer expansion to the
    # global scope on EXIT, where the `local` variable doesn't exist —
    # combined with `set -u` that's an unbound-variable error.
    trap "rm -rf '$tmpdir'" EXIT

    # Discover the latest .deb asset by updatedAt. The release accumulates
    # multiple .debs across versions, so we can't just `gh release download
    # -p '*.deb'` and grab the first hit — it'd pick the oldest. Resolve the
    # exact asset name first, then download only that one.
    local remote_data latest_name
    remote_data=$(gh release view "$TAG" -R "$REPO" --json assets 2>/dev/null) || {
        echo "failed to query release metadata for $REPO@$TAG" >&2
        exit 4
    }
    latest_name=$(echo "$remote_data" \
        | jq -r '[.assets[] | select(.name | endswith(".deb"))]
                 | sort_by(.updatedAt) | reverse | .[0].name // empty')
    if [ -z "$latest_name" ]; then
        echo "no .deb asset on release $REPO@$TAG" >&2
        exit 3
    fi

    # gh download takes a glob in -p; a literal filename works as glob too.
    # --clobber guarantees overwrite if something weird was left behind.
    gh release download "$TAG" -R "$REPO" -p "$latest_name" -D "$tmpdir" --clobber

    local deb="$tmpdir/$latest_name"
    if [ ! -f "$deb" ]; then
        echo "download succeeded but $deb is missing" >&2
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
