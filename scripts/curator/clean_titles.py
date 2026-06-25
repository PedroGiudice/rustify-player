#!/usr/bin/env python3
"""Limpa títulos estilizados (letras espaçadas) -> legível.
Atualiza a tag TITLE no FLAC + o title no Qdrant. Dry-run por default; --apply grava.
"""
import json, os, re, sys, urllib.request
from mutagen import File as MutaFile

APPLY = "--apply" in sys.argv
Q = "http://localhost:6333/collections/rustify_tracks"
def qpost(path, body):
    r = urllib.request.Request(Q + path, data=json.dumps(body).encode(),
                               headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=30))

SPACED = re.compile(r"(?:\b\w\s){3,}")
def destyle(title):
    if not title or not SPACED.search(title):
        return title
    words = re.split(r"\s*\.\s*", title)
    out = []
    for w in words:
        chars = re.findall(r"[\w'’‘]", w)
        out.append("".join(chars).replace("‘", "'").replace("’", "'"))
    return " ".join(x for x in out if x).strip()

def scroll_all():
    out, off = [], None
    while True:
        b = {"limit": 1000, "with_payload": ["title", "path"], "with_vector": False}
        if off:
            b["offset"] = off
        r = qpost("/points/scroll", b)
        out += r["result"]["points"]
        off = r["result"].get("next_page_offset")
        if not off:
            break
    return out

pts = scroll_all()
targets = []
for p in pts:
    pl = p["payload"]
    old = pl.get("title") or ""
    new = destyle(old)
    if new != old:
        targets.append((p["id"], pl.get("path"), old, new))

print(f"títulos estilizados a limpar: {len(targets)}  mode={'APPLY' if APPLY else 'DRY-RUN'}\n")
done_tag = done_q = 0
for pid, path, old, new in targets:
    print(f"  {old!r}\n    -> {new!r}")
    if APPLY:
        # 1. tag FLAC
        try:
            if path and os.path.isfile(path):
                f = MutaFile(path, easy=True)
                f["title"] = new
                f.save()
                done_tag += 1
        except Exception as e:
            print(f"    [erro tag: {e}]")
        # 2. Qdrant title
        try:
            qpost("/points/payload", {"payload": {"title": new}, "points": [pid]})
            done_q += 1
        except Exception as e:
            print(f"    [erro qdrant: {e}]")

if APPLY:
    print(f"\nTags FLAC atualizadas: {done_tag}  | Qdrant title atualizados: {done_q}")
