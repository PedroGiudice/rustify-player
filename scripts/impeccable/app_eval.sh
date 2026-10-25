#!/usr/bin/env bash
# Avaliação de design no app real da cmr-auto (roda na VM). Descobre a porta da
# ponte (9223, ou 9224 quando a 9223 ficou presa), abre o túnel SSH se faltar e
# chama app_eval.mjs.
#
#   scripts/impeccable/app_eval.sh capture [full]   -> PNG em .impeccable/captures/
#   scripts/impeccable/app_eval.sh detect           -> achados em .impeccable/captures/detect-<ts>.json
#   scripts/impeccable/app_eval.sh js '<corpo>'     -> resultado do JS (use `return`)
#
# Pré-requisito: app aberto na cmr-auto. Nada aparece na tela do CEO.
set -euo pipefail

HOST=cmr-auto@100.102.249.9
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$REPO/.impeccable/captures"
mkdir -p "$OUT"

port=$(ssh -o ConnectTimeout=5 "$HOST" "ss -tlnp 2>/dev/null | grep rustify-player | grep -oE '127\.0\.0\.1:922[0-9]' | head -1 | cut -d: -f2" || true)
if [ -z "$port" ]; then
  echo "ponte do app não encontrada na cmr-auto (o app está aberto?)" >&2
  exit 1
fi
if ! ss -tln | grep -q "127.0.0.1:$port "; then
  ssh -f -N -o ExitOnForwardFailure=yes -L "127.0.0.1:$port:localhost:$port" "$HOST"
fi

mode="${1:-}"; shift || true
case "$mode" in
  capture)
    res=$(node "$HERE/app_eval.mjs" "$port" capture "${1:-}")
    remote=$(printf '%s' "$res" | python3 -c 'import json,sys; print(json.load(sys.stdin)["path"])')
    scp -q "$HOST:$remote" "$OUT/"
    echo "$OUT/$(basename "$remote") $res"
    ;;
  detect)
    # O detector do navegador só é servido pelo live-server do Impeccable:
    # sobe, baixa o script uma vez por versão e derruba (sem tocar no HTML).
    imp=$(ls -d "$HOME"/.claude/plugins/cache/impeccable/impeccable/*/skills/impeccable/scripts/impeccable | sort -V | tail -1)
    ver=$(basename "$(dirname "$(dirname "$(dirname "$(dirname "$imp")")")")")
    det="$HOME/.cache/rustify-impeccable/detect-$ver.js"
    if [ ! -s "$det" ]; then
      mkdir -p "$(dirname "$det")"
      lport=$("$imp" live-server --background | python3 -c 'import json,sys; print(json.load(sys.stdin)["port"])')
      curl -sf -o "$det" "http://localhost:$lport/detect.js" || { "$imp" live-server stop --keep-inject >/dev/null; exit 1; }
      "$imp" live-server stop --keep-inject >/dev/null
    fi
    f="$OUT/detect-$(date +%Y%m%d-%H%M%S).json"
    node "$HERE/app_eval.mjs" "$port" detect "$det" > "$f"
    echo "$f"
    ;;
  js)
    node "$HERE/app_eval.mjs" "$port" js "$1"
    ;;
  *)
    echo "uso: $0 capture [full] | detect | js '<script>'" >&2
    exit 2
    ;;
esac
