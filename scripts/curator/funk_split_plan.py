#!/usr/bin/env python3
"""Transforma uma proposta de separação de playlist (funk CMR-299, rap CMR-300) em lotes de ids para o
comando `lib_move_tracks` do app (CMR-298). Lê o JSON da proposta, consulta o Qdrant da cmr-auto
(túnel 16333) pelos caminhos sob `~/Music/<src>/<artist_dir>[/<album_dir>]` e escreve
um plano `{dest: [ids...]}` com contagens. NÃO move nada: a execução é pelo app (ponte MCP, lotes
de 10), que migra histórico, vetores e letra. Precedência das linhas: `file` (caminho relativo
à playlist) > `album_dir` > só `artist_dir`. Linha cujo `dest` é a própria playlist de origem
fica onde está. Uso:
  python3 scripts/curator/funk_split_plan.py docs/contexto/13102026-funk-classificacao-proposta.json \
      --out /tmp/funk-plan.json [--src "Funk Brasileiro"] [--min-confidence media] [--qdrant http://127.0.0.1:16333]
"""
import argparse
import json
import urllib.request
from collections import Counter, defaultdict

ORDER = {"alta": 3, "media": 2, "média": 2, "baixa": 1}
MUSIC = "/home/cmr-auto/Music/"
DEFAULT_SRC = "Funk Brasileiro"


def scroll_paths(qdrant: str, src: str = DEFAULT_SRC) -> list[tuple[int, str]]:
    out, off = [], None
    while True:
        body = {"limit": 1000, "with_payload": ["path"], "with_vector": False,
                "filter": {"must": [{"key": "path", "match": {"text": src}}]}}
        if off is not None:
            body["offset"] = off
        req = urllib.request.Request(f"{qdrant}/collections/rustify_tracks/points/scroll",
                                     data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        res = json.load(urllib.request.urlopen(req, timeout=60))["result"]
        out += [(p["id"], p["payload"]["path"]) for p in res["points"]]
        off = res.get("next_page_offset")
        if off is None:
            break
    prefix = MUSIC + src + "/"
    return [(i, p) for i, p in out if p.startswith(prefix)]


def row_rank(r: dict) -> int:
    """0 = faixa (file), 1 = álbum, 2 = só artista: o mais específico vence."""
    return 0 if r.get("file") else 1 if r.get("album_dir") else 2


def row_prefix(r: dict, root: str) -> tuple[str, bool]:
    """Devolve (caminho, exato). `exato` = a linha é de uma faixa só."""
    if r.get("file"):
        return root + r["file"], True
    return root + r["artist_dir"] + "/" + (r["album_dir"] + "/" if r.get("album_dir") else ""), False


def build_plan(rows: list[dict], points: list[tuple[int, str]], min_conf: str,
               src: str = DEFAULT_SRC) -> tuple[dict, Counter, list]:
    plan, counts, skipped = defaultdict(list), Counter(), []
    root = MUSIC + src + "/"
    rows = sorted(rows, key=row_rank)  # faixa antes de álbum antes de "todos do artista"
    used: set[int] = set()
    for r in rows:
        if ORDER.get(r["confidence"], 0) < ORDER[min_conf]:
            skipped.append(r)
            continue
        prefix, exact = row_prefix(r, root)
        for pid, path in points:
            if pid in used or not (path == prefix if exact else path.startswith(prefix)):
                continue
            if r["dest"] == src:
                used.add(pid)
                continue  # fica onde está
            plan[r["dest"]].append(str(pid))  # ids como STRING (u64 > 2^53 no JS)
            used.add(pid)
            counts[r["dest"]] += 1
    return dict(plan), counts, skipped


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("proposta")
    ap.add_argument("--out", required=True)
    ap.add_argument("--src", default=DEFAULT_SRC, help="playlist de origem (pasta de 1º nível)")
    ap.add_argument("--min-confidence", default="media", choices=["alta", "media", "baixa"])
    ap.add_argument("--qdrant", default="http://127.0.0.1:16333")
    a = ap.parse_args()
    rows = json.load(open(a.proposta))
    pts = scroll_paths(a.qdrant, a.src)
    plan, counts, skipped = build_plan(rows, pts, a.min_confidence, a.src)
    json.dump({"plan": plan, "counts": counts, "skipped_low_confidence": skipped}, open(a.out, "w"), ensure_ascii=False, indent=1)
    print(f"faixas no índice sob {a.src}: {len(pts)}")
    for d, n in counts.most_common():
        print(f"  {d}: {n}")
    print(f"linhas puladas por confiança < {a.min_confidence}: {len(skipped)}; plano em {a.out}")
