#!/usr/bin/env python3
"""Transforma a proposta de separação do Funk Brasileiro (CMR-299) em lotes de ids para o
comando `lib_move_tracks` do app (CMR-298). Lê o JSON da proposta, consulta o Qdrant da cmr-auto
(túnel 16333) pelos caminhos sob `~/Music/Funk Brasileiro/<artist_dir>[/<album_dir>]` e escreve
um plano `{dest: [ids...]}` com contagens. NÃO move nada: a execução é pelo app (ponte MCP, lotes
de 10), que migra histórico, vetores e letra. Uso:
  python3 scripts/curator/funk_split_plan.py docs/contexto/13102026-funk-classificacao-proposta.json \
      --out /tmp/funk-plan.json [--min-confidence media] [--qdrant http://127.0.0.1:16333]
"""
import argparse
import json
import urllib.request
from collections import Counter, defaultdict

ORDER = {"alta": 3, "media": 2, "média": 2, "baixa": 1}
SRC = "/home/cmr-auto/Music/Funk Brasileiro/"


def scroll_paths(qdrant: str) -> list[tuple[int, str]]:
    out, off = [], None
    while True:
        body = {"limit": 1000, "with_payload": ["path"], "with_vector": False,
                "filter": {"must": [{"key": "path", "match": {"text": "Funk Brasileiro"}}]}}
        if off is not None:
            body["offset"] = off
        req = urllib.request.Request(f"{qdrant}/collections/rustify_tracks/points/scroll",
                                     data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        res = json.load(urllib.request.urlopen(req, timeout=60))["result"]
        out += [(p["id"], p["payload"]["path"]) for p in res["points"]]
        off = res.get("next_page_offset")
        if off is None:
            break
    return out


def build_plan(rows: list[dict], points: list[tuple[int, str]], min_conf: str) -> tuple[dict, Counter, list]:
    plan, counts, skipped = defaultdict(list), Counter(), []
    rows = sorted(rows, key=lambda r: 0 if r.get("album_dir") else 1)  # álbum específico antes do "todos"
    used: set[int] = set()
    for r in rows:
        if ORDER.get(r["confidence"], 0) < ORDER[min_conf]:
            skipped.append(r)
            continue
        prefix = SRC + r["artist_dir"] + "/" + (r["album_dir"] + "/" if r.get("album_dir") else "")
        for pid, path in points:
            if pid in used or not path.startswith(prefix):
                continue
            if r["dest"] == "Funk Brasileiro":
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
    ap.add_argument("--min-confidence", default="media", choices=["alta", "media", "baixa"])
    ap.add_argument("--qdrant", default="http://127.0.0.1:16333")
    a = ap.parse_args()
    rows = json.load(open(a.proposta))
    pts = scroll_paths(a.qdrant)
    plan, counts, skipped = build_plan(rows, pts, a.min_confidence)
    json.dump({"plan": plan, "counts": counts, "skipped_low_confidence": skipped}, open(a.out, "w"), ensure_ascii=False, indent=1)
    print(f"faixas no índice sob Funk Brasileiro: {len(pts)}")
    for d, n in counts.most_common():
        print(f"  {d}: {n}")
    print(f"linhas puladas por confiança < {a.min_confidence}: {len(skipped)}; plano em {a.out}")
