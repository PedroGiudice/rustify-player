#!/usr/bin/env python3
"""Busca letra no lrclib.net para as faixas que ainda nao tem: recupera sidecars orfaos
(lrc_path=None no Qdrant), grava `.lrc` ao lado do FLAC quando a letra e SINCRONIZADA e,
quando so existe letra sem tempo, grava `lyrics_text` no payload (mesmo contrato do sink do
Crate: sidecar so com timestamps; texto puro vai pro payload e alimenta o vetor `lyrics`).
Marca `lyrics_status` (synced | plain | instrumental | none) para a regua medir cobertura.
Roda NA cmr-auto (caminhos locais + Qdrant do app). Dry-run por default; --apply grava.
Env: SYNC_QDRANT (default http://localhost:6333). O vetor e gerado depois pelo backfill do app.
"""
import json, os, re, sys, unicodedata, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

APPLY = "--apply" in sys.argv
ONLY_RAP = "--rap" in sys.argv
Q = os.environ.get("SYNC_QDRANT", "http://localhost:6333") + "/collections/rustify_tracks"
LRCLIB = "https://lrclib.net/api"
UA = "RustifyPlayer/0.1.0 (https://github.com/PedroGiudice/rustify-player)"

def qpost(path, body):
    r = urllib.request.Request(Q + path, data=json.dumps(body).encode(),
                               headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=30))

TS = re.compile(r"\[\d{1,2}:\d{2}")
def synced_text(t):       # texto LRC com timestamps?
    return bool(t and TS.search(t))

MIN_LYRICS_CHARS = 40  # mesmo piso do sink do Crate (letra menor que isso e lixo)

def has_text(pl):
    """Ja tem letra em algum lugar (sidecar valido, tag ou texto puro) ou e instrumental: nada a buscar."""
    if has_sync(pl):
        return True
    t = pl.get("lyrics_text") or ""
    return len(t.strip()) > MIN_LYRICS_CHARS or pl.get("lyrics_status") == "instrumental"

def has_sync(pl):
    lrc = pl.get("lrc_path")
    if lrc and os.path.isfile(lrc):
        try:
            if synced_text(open(lrc, encoding="utf-8", errors="ignore").read()):
                return True
        except Exception:
            pass
    return synced_text(pl.get("embedded_lyrics"))

def destyle(title):
    """ 'm y . l i f e' -> 'my life'; 'a m a r i' -> 'amari'. """
    if not title or not re.search(r"(?:\b\w\s){3,}", title):
        return title
    t = title.replace("‘", "'").replace("’", "'")
    words = re.split(r"\s*\.\s*", t)
    return " ".join("".join(re.findall(r"\w", w)) for w in words).strip()

def scroll_all():
    out, off = [], None
    while True:
        b = {"limit": 1000, "with_payload": True, "with_vector": False}
        if off:
            b["offset"] = off
        r = qpost("/points/scroll", b)
        out += r["result"]["points"]
        off = r["result"].get("next_page_offset")
        if not off:
            break
    return out

def lrclib_get(title, artist, album, dur_s):
    p = urllib.parse.urlencode({"track_name": title, "artist_name": artist,
                                "album_name": album, "duration": dur_s})
    try:
        req = urllib.request.Request(f"{LRCLIB}/get?{p}", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=12) as r:
            if r.status == 200:
                return json.loads(r.read())
    except Exception:
        pass
    return None

def lrclib_search(title, artist):
    p = urllib.parse.urlencode({"q": f"{artist} {title}"})
    try:
        req = urllib.request.Request(f"{LRCLIB}/search?{p}", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=12) as r:
            if r.status == 200:
                res = json.loads(r.read())
                if res:
                    return res[0]
    except Exception:
        pass
    return None

def process(pid, pl):
    path = pl.get("path")
    if not path or not os.path.isfile(path):
        return ("nopath", pid, None)
    sidecar = os.path.splitext(path)[0] + ".lrc"
    # 1. sidecar orfao no disco (lrc_path None no Qdrant): se synced, so apontar
    if os.path.isfile(sidecar):
        try:
            if synced_text(open(sidecar, encoding="utf-8", errors="ignore").read()):
                return ("orphan_sidecar", pid, sidecar)
        except Exception:
            pass
    # 2. buscar lrclib
    title = pl.get("title") or ""
    artist = pl.get("artist") or ""
    album = pl.get("album_title") or ""
    dur_s = (pl.get("duration_ms") or 0) // 1000
    data = lrclib_get(title, artist, album, dur_s) or lrclib_search(title, artist)
    dt = destyle(title)
    if not data and dt != title:
        data = lrclib_get(dt, artist, album, dur_s) or lrclib_search(dt, artist)
    if data and data.get("syncedLyrics") and synced_text(data["syncedLyrics"]):
        if APPLY:
            with open(sidecar, "w", encoding="utf-8") as f:
                f.write(data["syncedLyrics"])
        return ("synced", pid, sidecar)
    if data and data.get("instrumental") is True:
        return ("instrumental", pid, None)
    plain = (data or {}).get("plainLyrics") or ""
    if len(plain.strip()) > MIN_LYRICS_CHARS:
        return ("plain", pid, plain.strip())
    return ("miss", pid, None)

pts = scroll_all()
def is_rap(pl):
    return "Rap & Hip-Hop" in (pl.get("path") or "")
nosync = [(p["id"], p["payload"]) for p in pts
          if not has_text(p["payload"]) and (not ONLY_RAP or is_rap(p["payload"]))]
print(f"total={len(pts)}  sem_letra={len(nosync)}  mode={'APPLY' if APPLY else 'DRY-RUN'}"
      f"{'  (rap only)' if ONLY_RAP else ''}")

res = {"synced": 0, "plain": 0, "instrumental": 0, "miss": 0, "nopath": 0, "orphan_sidecar": 0}
to_set, misses, plains, flags = [], [], [], []
with ThreadPoolExecutor(max_workers=8) as ex:
    futs = {ex.submit(process, pid, pl): (pid, pl) for pid, pl in nosync}
    for fut in as_completed(futs):
        pid, pl = futs[fut]
        try:
            kind, pid2, sidecar = fut.result()
        except Exception:
            res["miss"] += 1; continue
        res[kind] += 1
        if kind in ("synced", "orphan_sidecar"):
            to_set.append((pid2, sidecar))
        elif kind == "plain":
            plains.append((pid2, sidecar))  # aqui o 3o campo carrega o TEXTO
        elif kind in ("instrumental", "miss"):
            flags.append((pid2, "instrumental" if kind == "instrumental" else "none"))
            if kind == "miss":
                misses.append((pl.get("artist"), pl.get("title")))

# atualiza lrc_path no Qdrant
applied = 0
if APPLY:
    for pid, sidecar in to_set:
        qpost("/points/payload", {"payload": {"lrc_path": sidecar, "lyrics_status": "synced"}, "points": [pid]})
        applied += 1
    for pid, text in plains:
        qpost("/points/payload", {"payload": {"lyrics_text": text, "lyrics_status": "plain"}, "points": [pid]})
        applied += 1
    for pid, st in flags:
        qpost("/points/payload", {"payload": {"lyrics_status": st}, "points": [pid]})

print(json.dumps(res))
print(f"sidecars synced/orfaos: {len(to_set)} | letra sem tempo (lyrics_text): {len(plains)} | aplicados: {applied}")
print(f"\nmisses (lrclib nao tem synced) — {len(misses)}; amostra:")
for a, t in misses[:25]:
    print(f"  {a} - {t}")
