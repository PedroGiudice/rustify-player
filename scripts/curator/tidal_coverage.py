#!/usr/bin/env python3
"""Cobertura do catálogo da Tidal sobre os candidatos do piloto. Só busca; não baixa. Roda NA cmr-auto."""
import json, os, re, time, unicodedata
import tidalapi
from datetime import datetime
def norm(s): return re.sub(r"[^a-z0-9]+", " ", unicodedata.normalize("NFKD", (s or "").lower()).encode("ascii","ignore").decode()).strip()
d = json.load(open(os.path.expanduser("~/.secrets/tidal-session.json")))
sess = tidalapi.Session(); exp = datetime.fromisoformat(d["expiry_time"]) if d.get("expiry_time") else None
assert sess.load_oauth_session(d["token_type"], d["access_token"], d["refresh_token"], exp)
inp = json.load(open(os.path.expanduser("~/.cache/tidal-spike/tidal_cov_in.json")))
out = {"releases": [], "artistas": []}
for c in inp["candidatos"]:
    q = f'{c["artist"]} {c["release"]}'
    try:
        r = sess.search(q, models=[tidalapi.album.Album], limit=5)
        hit = None
        for a in r.get("albums", []):
            if norm(c["release"])[:20] in norm(a.name) or norm(a.name)[:20] in norm(c["release"]):
                hit = {"tidal_id": a.id, "artist": a.artist.name, "title": a.name, "year": a.release_date.year if getattr(a,"release_date",None) else None, "quality": getattr(a,"audio_quality",None), "tracks": getattr(a,"num_tracks",None)}
                break
        out["releases"].append({**c, "tidal": hit})
    except Exception as e:
        out["releases"].append({**c, "tidal": None, "err": str(e)[:80]})
    time.sleep(0.7)
for name in inp["artistas"]:
    try:
        r = sess.search(name, models=[tidalapi.artist.Artist], limit=3)
        arts = r.get("artists", [])
        best = next((a for a in arts if norm(a.name) == norm(name)), arts[0] if arts else None)
        albs = []
        if best:
            try: albs = [{"id": a.id, "title": a.name, "year": a.release_date.year if getattr(a,"release_date",None) else None, "tracks": getattr(a,"num_tracks",None)} for a in best.get_albums(limit=50)]
            except Exception as e: albs = [{"err": str(e)[:60]}]
        out["artistas"].append({"query": name, "match": best.name if best else None, "tidal_artist_id": best.id if best else None, "albums": albs})
    except Exception as e:
        out["artistas"].append({"query": name, "err": str(e)[:80]})
    time.sleep(0.7)
json.dump(out, open(os.path.expanduser("~/.cache/tidal-spike/tidal_coverage.json"), "w"), ensure_ascii=False, indent=1)
hits = sum(1 for r in out["releases"] if r.get("tidal")); print("RELEASES: %d/%d na Tidal" % (hits, len(out["releases"])))
for a in out["artistas"]: print("ARTISTA %-28s -> %s (%d álbuns)" % (a["query"], a.get("match"), len(a.get("albums") or [])))
print("FIM")
