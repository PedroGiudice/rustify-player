#!/usr/bin/env python3
"""Semeia `quality_class`/`quality_cutoff_hz` no Qdrant da cmr-auto a partir da auditoria.

O app (0.2.93+) mede o corte espectral na indexação e, no boot, mede as faixas que
ainda não têm o campo (`backfill_missing_quality`, ~0,4 s por faixa). Este script
grava de uma vez o que a auditoria de 15/10 já mediu (`docs/contexto/
15102026-qualidade-auditoria.jsonl`), para o primeiro boot não remedir o acervo
inteiro. O Rust e o Python dão o mesmo resultado (fixture compartilhada
`fixtures/spectral_cliffs.json`; 51/51 referências iguais).

Só toca pontos SEM `quality_class` (não sobrescreve medição do app) e cujo caminho
está na auditoria. Padrão = só mostra o que faria; `--apply` grava.

  ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9
  python3 scripts/curator/quality_seed.py [--apply]
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from quality_audit import classify  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
AUDIT = REPO / "docs" / "contexto" / "15102026-qualidade-auditoria.jsonl"
COLL = "rustify_tracks"


def qdrant(base: str, method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(f"{base}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def payload_for(row: dict) -> dict | None:
    """Pura. Campos do payload a partir de uma linha da auditoria (classe espectral,
    sem o COMMENT, igual ao `spectral::classify` do app). Linha com erro: None."""
    if row.get("class") == "erro" or "sr" not in row:
        return None
    return {"quality_class": classify(row["sr"], row.get("cutoff_hz"), False),
            "quality_cutoff_hz": row.get("cutoff_hz")}


def rel_path(abs_path: str, music_root: str) -> str | None:
    """Pura. Caminho do payload (absoluto na cmr-auto) -> chave da auditoria."""
    root = music_root.rstrip("/") + "/"
    return abs_path[len(root):] if abs_path.startswith(root) else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--qdrant", default="http://127.0.0.1:16333")
    ap.add_argument("--music-root", default="/home/cmr-auto/Music")
    ap.add_argument("--audit", default=str(AUDIT))
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    audit = {}
    for line in Path(a.audit).read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            audit[r["path"]] = r

    points, offset = [], None
    while True:
        body = {"limit": 1000, "with_payload": ["path", "quality_class"], "with_vector": False}
        if offset is not None:
            body["offset"] = offset
        res = qdrant(a.qdrant, "POST", f"/collections/{COLL}/points/scroll", body)["result"]
        points += res["points"]
        offset = res.get("next_page_offset")
        if offset is None:
            break

    groups: dict[str, list] = collections.defaultdict(list)
    ja_medidas = fora = sem_linha = 0
    for p in points:
        pl = p.get("payload") or {}
        if pl.get("quality_class"):
            ja_medidas += 1
            continue
        rel = rel_path(pl.get("path", ""), a.music_root)
        row = audit.get(rel) if rel else None
        if rel is None:
            fora += 1
            continue
        fields = payload_for(row) if row else None
        if fields is None:
            sem_linha += 1
            continue
        groups[json.dumps(fields, sort_keys=True)].append(p["id"])

    n = sum(len(v) for v in groups.values())
    por_classe = collections.Counter()
    for k, ids in groups.items():
        por_classe[json.loads(k)["quality_class"]] += len(ids)
    print(f"pontos {len(points)} | já medidos {ja_medidas} | a semear {n} {dict(por_classe)} | "
          f"sem linha na auditoria {sem_linha} (o app mede no boot) | fora do acervo {fora}")
    if not a.apply:
        print("nada gravado (use --apply)")
        return 0
    for k, ids in groups.items():
        for i in range(0, len(ids), 500):
            qdrant(a.qdrant, "POST", f"/collections/{COLL}/points/payload?wait=true",
                   {"payload": json.loads(k), "points": ids[i:i + 500]})
    print(f"gravados {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
