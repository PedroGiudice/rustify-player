#!/usr/bin/env python3
"""CMR-297: versão lossless de verdade, na Tidal, para as faixas do acervo marcadas como lossy por dentro.

Só leitura no acervo: nada aqui move, apaga ou reescreve faixa da cmr-auto. A troca é outro passo,
depois da decisão do CEO. Roda NA VM (túnel 16333 para o Qdrant da cmr-auto, ssh para ler as tags).

  uv run --with tidalapi --with mutagen --with numpy python3 upgrade_tidal.py listar  --out faixas.json
  uv run --with tidalapi --with mutagen --with numpy python3 upgrade_tidal.py buscar  --faixas faixas.json --out candidatas.json
  uv run --with tidalapi --with mutagen --with numpy python3 upgrade_tidal.py lotes   --candidatas candidatas.json
  (baixar cada lote com tidal_mix_dl.py --ids ... --no-dedup --no-push, TIDAL_MUSIC_ROOT=<staging>)
  uv run --with numpy python3 quality_audit.py scan <staging> --out medidas.jsonl
  uv run --with tidalapi --with mutagen --with numpy python3 upgrade_tidal.py juntar --faixas faixas.json \
      --candidatas candidatas.json --relatorios mix_selecao-*.json --medidas medidas.jsonl --staging <staging> --out resultado.json

A mesma gravação = ISRC igual (com duração a até 10 s) OU `title_key` igual + artista em comum +
duração a até 4 s. `title_key` é a chave do "JÁ NO ACERVO" do tidal_mix_dl (remix, ao vivo, edit,
instrumental distinguem; feat. e remaster não). A etiqueta da Tidal (LOSSLESS, HI_RES) não prova nada:
só conta a medida espectral do arquivo baixado (`sem_corte` ou `hires_de_cd`).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize_release import loose  # noqa: E402
from tidal_mix_dl import CMR_SSH, QDRANT, ensure_tunnel, split_artists, title_key, track_title  # noqa: E402

LOSSY = ("lossy", "provavel_lossy")
CLEAN = ("sem_corte", "hires_de_cd")
# "manual" = casamento conferido à mão (título diferente na Tidal); o relatório pede conferência de ouvido
USABLE = ("isrc", "titulo", "manual")
DUR_TOL_S = 4
DUR_TOL_ISRC_S = 10
MAX_CAND = 3
PAUSE_S = 0.4


# ---------------------------------------------------------------- funções puras

def tag(tags: dict, *names: str) -> str:
    """Tag do ffprobe sem depender da caixa (o ffprobe devolve 'artist' em uma e 'ARTIST' em outra)."""
    low = {k.lower(): v for k, v in (tags or {}).items()}
    for n in names:
        v = low.get(n.lower())
        if v:
            return str(v).strip()
    return ""


_ORIGINAL_MIX = re.compile(r"\s*(?:\((?:original|extended original) mix\)|\[(?:original) mix\]|\s-\s+original mix)\s*$", re.I)


def tkey(title: str) -> str:
    """title_key do tidal_mix_dl com uma regra a mais, só desta campanha: "(Original Mix)" é a versão
    padrão, não distingue. A title_key compartilhada com a tela (tidalSearch.ts) não muda."""
    return title_key(_ORIGINAL_MIX.sub("", title or ""))


def isrcs(s: str) -> list[str]:
    """Pura. A tag ISRC às vezes traz vários códigos ('A;B;C' ou 'A/B'): todos valem."""
    return [x for x in (p.strip().upper() for p in re.split(r"[;,/\s]+", s or "")) if len(x) == 12]


def artists_meet(a: set[str], b: set[str]) -> bool:
    """Pura. Artista em comum, aceitando sufixo ('sonnyboywilliamson' x 'sonnyboywilliamsonii')
    quando o nome menor tem 6+ letras: título e duração ainda precisam bater."""
    if a & b:
        return True
    return any(len(min(x, y, key=len)) >= 6 and (x.startswith(y) or y.startswith(x)) for x in a for y in b)


def primary(names: list[str]) -> set[str]:
    """Pura. Artista principal: o primeiro crédito (no funk, o DJ/produtor; o MC convidado repete o
    mesmo verso em produções de outros DJs, então não identifica a gravação)."""
    for s in names:
        if s and loose(s) not in ("various", "variousartists", "va"):
            parts = split_artists(s)
            if parts:
                return {parts[0]}
    return set()


def our_artists(f: dict) -> set[str]:
    out: set[str] = set()
    for s in (f.get("artist"), f.get("album_artist")):
        if s and loose(s) not in ("various", "variousartists", "va"):
            out.update(split_artists(s))
    return out


def match_kind(ours: dict, cand: dict) -> str | None:
    """Pura. 'isrc' | 'titulo' | 'outra_versao' (mesmo título e artista, duração diferente) | None.
    ours: {title, artist, album_artist, isrc, dur_s}; cand: {title, artists[], album_artist, isrc, dur_s}."""
    dd = abs((ours.get("dur_s") or 0) - (cand.get("dur_s") or 0)) if ours.get("dur_s") and cand.get("dur_s") else None
    ci = (cand.get("isrc") or "").upper()
    if ci and ci in isrcs(ours.get("isrc") or "") and (dd is None or dd <= DUR_TOL_ISRC_S):
        return "isrc"
    tk = tkey(ours.get("title") or "")
    if not tk or tk != tkey(cand.get("title") or ""):
        return None
    theirs: set[str] = set()
    for s in list(cand.get("artists") or []) + [cand.get("album_artist") or ""]:
        theirs.update(split_artists(s))
    # o encontro precisa passar pelo principal de um dos lados, não só por um convidado
    ours_all = our_artists(ours)
    p_ours = primary([ours.get("artist") or "", ours.get("album_artist") or ""])
    p_theirs = primary(list(cand.get("artists") or []) + [cand.get("album_artist") or ""])
    if not (artists_meet(p_ours, theirs) or artists_meet(ours_all, p_theirs)):
        return None
    if dd is not None and dd > DUR_TOL_S:
        return "outra_versao"
    return "titulo"


def same_origin(ours: dict, cand: dict) -> bool:
    """Pura. A faixa do acervo veio da Tidal (COMMENT ou pasta `[tidal]`; o caminho do spike não
    gravava o COMMENT) e a candidata é o MESMO lançamento (mesmo álbum e número):
    é o mesmo stream que já medimos lossy, não vale baixar de novo."""
    from_tidal = "source: tidal" in (ours.get("comment") or "").lower() or "[tidal]" in (ours.get("rel") or "")
    return (from_tidal
            and loose(ours.get("album") or "") == loose(cand.get("album") or "")
            and int(ours.get("track_number") or 0) == int(cand.get("track_num") or -1))


def rank(c: dict) -> tuple:
    """Ordem de preferência entre candidatas: ISRC antes de título, depois a duração mais próxima."""
    return ({"isrc": 0, "titulo": 1}.get(c["kind"], 2), c.get("dd") if c.get("dd") is not None else 99)


def outcome(cands: list[dict], measured: dict[int, dict]) -> str:
    """Pura. Resultado de uma faixa a partir das candidatas e das medidas por id da Tidal:
    'limpa' (alguma candidata mediu sem corte), 'lossy' (todas as medidas têm corte),
    'nao_medida' (candidata existe mas nenhuma mediu), 'so_mesma_origem', 'nao_encontrada'."""
    usable = [c for c in cands if c["kind"] in USABLE]
    if not usable:
        return "nao_encontrada"
    if all(c.get("same_origin") for c in usable):
        return "so_mesma_origem"
    classes = [measured[c["id"]]["class"] for c in usable if c["id"] in measured]
    if any(k in CLEAN for k in classes):
        return "limpa"
    if classes and all(k in LOSSY for k in classes):
        return "lossy"
    return "nao_medida"


# ---------------------------------------------------------------- listar

def scroll(col: str, payload) -> list[dict]:
    out, off = [], None
    while True:
        b = {"limit": 2000, "with_payload": payload, "with_vector": False}
        if off is not None:
            b["offset"] = off
        req = urllib.request.Request(f"{QDRANT}/collections/{col}/points/scroll", data=json.dumps(b).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            res = json.load(r)["result"]
        out += res["points"]
        off = res.get("next_page_offset")
        if off is None:
            return out


def remote_tags(paths: list[str]) -> dict[str, dict]:
    """Tags reais dos arquivos na cmr-auto (o payload guarda 'Various' como artista de coletânea)."""
    script = ('while IFS= read -r f; do printf "%s\\t" "$f"; '
              'ffprobe -v error -show_entries format_tags -of json "$f" 2>/dev/null | tr -d "\\n"; echo; done')
    out = subprocess.run(["ssh", "-o", "BatchMode=yes", CMR_SSH, script], input="".join(p + "\n" for p in paths),
                         capture_output=True, text=True, timeout=600, check=True).stdout
    res = {}
    for line in out.splitlines():
        p, _, j = line.partition("\t")
        try:
            res[p] = (json.loads(j or "{}").get("format") or {}).get("tags") or {}
        except ValueError:
            res[p] = {}
    return res


def cmd_listar(a) -> None:
    ensure_tunnel()
    pts = scroll("rustify_tracks", ["path", "title", "artist", "album_title", "track_number", "duration_ms",
                                     "quality_class", "quality_cutoff_hz", "bit_depth", "sample_rate"])
    bad = [p for p in pts if (p["payload"] or {}).get("quality_class") in LOSSY]
    enr = {e["id"]: e["payload"] or {} for e in scroll("track_enrichments", ["liked_at", "energy"])}
    plays: dict[int, int] = {}
    for e in scroll("play_events", ["track_id"]):
        t = (e["payload"] or {}).get("track_id")
        plays[t] = plays.get(t, 0) + 1
    tags = remote_tags([p["payload"]["path"] for p in bad])
    out = []
    for p in bad:
        pl, tg = p["payload"], tags.get(p["payload"]["path"], {})
        rel = pl["path"].split("/Music/", 1)[-1]
        out.append({
            "track_id": p["id"], "path": pl["path"], "rel": rel, "playlist": rel.split("/", 1)[0],
            "title": tag(tg, "title") or pl.get("title"), "artist": tag(tg, "artist") or pl.get("artist"),
            "album_artist": tag(tg, "album_artist", "albumartist"), "album": tag(tg, "album") or pl.get("album_title"),
            "track_number": pl.get("track_number"), "isrc": tag(tg, "isrc", "tsrc"), "comment": tag(tg, "comment", "description"),
            "dur_s": round((pl.get("duration_ms") or 0) / 1000, 1), "bits": pl.get("bit_depth"), "sr": pl.get("sample_rate"),
            "quality_class": pl.get("quality_class"), "cutoff_hz": pl.get("quality_cutoff_hz"),
            "liked": bool((enr.get(p["id"]) or {}).get("liked_at")), "plays": plays.get(p["id"], 0),
        })
    out.sort(key=lambda f: f["rel"])
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"{len(out)} faixas marcadas -> {a.out}")


# ---------------------------------------------------------------- buscar

def cand_of(t) -> dict:
    alb = t.album
    return {"id": t.id, "title": track_title(t), "artists": [x.name for x in (t.artists or [])] or [t.artist.name],
            "album_artist": getattr(getattr(alb, "artist", None), "name", "") or "", "album": getattr(alb, "name", ""),
            "album_id": getattr(alb, "id", None), "track_num": t.track_num, "isrc": getattr(t, "isrc", "") or "",
            "dur_s": t.duration, "tier": str(getattr(t, "audio_quality", "")),
            "tags": list(getattr(t, "media_metadata_tags", None) or [])}


def search_track(sess, f: dict) -> list[dict]:
    import tidalapi

    seen: dict[int, dict] = {}
    found = []
    for code in isrcs(f.get("isrc") or ""):
        try:
            found += list(sess.get_tracks_by_isrc(code))
        except Exception:  # ObjectNotFound: o ISRC não está no catálogo
            pass
        time.sleep(PAUSE_S)
    title_q = f["title"].split(" (")[0].split(" [")[0]
    first = (f.get("artist") or "").split(",")[0].split("&")[0].strip()
    queries = [f"{first} {title_q}".strip()] if first and loose(first) not in ("various", "variousartists") else []
    queries.append(title_q)
    for q in queries:
        try:
            res = sess.search(q, models=[tidalapi.Track], limit=15)
            found += list(res.get("tracks") or [])
        except Exception as e:
            print(f"    busca falhou ({q!r}): {e!r}", flush=True)
        time.sleep(PAUSE_S)
        if any(match_kind(f, cand_of(t)) for t in found):
            break
    for t in found:
        if t.id in seen:
            continue
        c = cand_of(t)
        k = match_kind(f, c)
        if not k:
            continue
        c["kind"] = k
        c["dd"] = round(abs((f.get("dur_s") or 0) - (c["dur_s"] or 0)), 1) if f.get("dur_s") else None
        c["same_origin"] = same_origin(f, c)
        seen[t.id] = c
    cands = sorted(seen.values(), key=rank)
    good = [c for c in cands if c["kind"] != "outra_versao"]
    # até MAX_CAND candidatas, preferindo álbuns diferentes (lançamentos diferentes = masters diferentes)
    pick, albums = [], set()
    for c in good:
        if c["album_id"] in albums and len(good) > MAX_CAND:
            continue
        pick.append(c)
        albums.add(c["album_id"])
        if len(pick) >= MAX_CAND:
            break
    return pick + [c for c in cands if c["kind"] == "outra_versao"][:2]


def cmd_buscar(a) -> None:
    from tidal_mix_dl import load_session

    faixas = json.loads(Path(a.faixas).read_text())
    sess = load_session()
    out = []
    for i, f in enumerate(faixas, 1):
        cands = search_track(sess, f)
        usable = [c for c in cands if c["kind"] in USABLE]
        tag_s = (f"{len(usable)} candidata(s): " + ", ".join(f"{c['kind']}{' MESMA' if c['same_origin'] else ''} {c['tier']}" for c in usable)) if usable else (
            "só outra versão" if cands else "NÃO ENCONTRADA")
        print(f"{i:3d} {f['title'][:40]:40s} | {(f.get('artist') or '')[:25]:25s} | {tag_s}", flush=True)
        out.append({"track_id": f["track_id"], "candidatas": cands})
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"-> {a.out}")


# ---------------------------------------------------------------- lotes

def cmd_lotes(a) -> None:
    """Ids a baixar, por playlist de origem (o tidal_mix_dl grava em <staging>/<playlist>/...)."""
    faixas = {f["track_id"]: f for f in json.loads(Path(a.faixas).read_text())}
    by_pl: dict[str, list[int]] = {}
    for r in json.loads(Path(a.candidatas).read_text()):
        pl = faixas[r["track_id"]]["playlist"]
        for c in r["candidatas"]:
            if c["kind"] in USABLE and not c["same_origin"]:
                by_pl.setdefault(pl, [])
                if c["id"] not in by_pl[pl]:
                    by_pl[pl].append(c["id"])
    Path(a.out).write_text(json.dumps(by_pl, ensure_ascii=False, indent=1))
    for pl, ids in by_pl.items():
        print(f"{pl}: {len(ids)} ids")
    print(f"total {sum(len(v) for v in by_pl.values())} -> {a.out}")


# ---------------------------------------------------------------- juntar

def cmd_juntar(a) -> None:
    faixas = json.loads(Path(a.faixas).read_text())
    cands = {r["track_id"]: r["candidatas"] for r in json.loads(Path(a.candidatas).read_text())}
    staging = Path(os.path.expanduser(a.staging))
    by_rel = {}
    for line in Path(a.medidas).read_text().splitlines():
        if line.strip():
            m = json.loads(line)
            by_rel[m["path"]] = m
    measured: dict[int, dict] = {}
    for rp in a.relatorios:
        rep = json.loads(Path(rp).read_text())
        for n in rep.get("new", []):
            rel = str(Path(n["path"]).relative_to(staging))
            m = by_rel.get(rel)
            if m:
                measured[n["id"]] = {"class": m["class"], "cutoff_hz": m.get("cutoff_hz"), "bits": n.get("bits"),
                                     "sr": n.get("sr"), "tier": n.get("quality"), "rel": rel}
        for r in rep.get("recusadas", []):  # o portão apagou o arquivo; a classe sai do corte (faixas do quality_audit)
            cut = r.get("cutoff_hz")
            k = "provavel_lossy" if cut and cut >= 19500 else "lossy"
            measured.setdefault(r["id"], {"class": k, "cutoff_hz": cut, "rel": None, "gate": True})
    out = []
    for f in faixas:
        cs = cands.get(f["track_id"], [])
        for c in cs:
            c["medida"] = measured.get(c["id"])
        res = outcome(cs, measured)
        best = None
        if res == "limpa":
            best = sorted((c for c in cs if c.get("medida") and c["medida"]["class"] in CLEAN), key=rank)[0]
        out.append({**f, "resultado": res, "troca": best, "candidatas": cs})
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=1))
    tot: dict[str, int] = {}
    for r in out:
        tot[r["resultado"]] = tot.get(r["resultado"], 0) + 1
    print(tot, "->", a.out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("listar")
    s.add_argument("--out", required=True)
    s = sp.add_parser("buscar")
    s.add_argument("--faixas", required=True)
    s.add_argument("--out", required=True)
    s = sp.add_parser("lotes")
    s.add_argument("--faixas", required=True)
    s.add_argument("--candidatas", required=True)
    s.add_argument("--out", required=True)
    s = sp.add_parser("juntar")
    s.add_argument("--faixas", required=True)
    s.add_argument("--candidatas", required=True)
    s.add_argument("--relatorios", nargs="+", required=True)
    s.add_argument("--medidas", required=True)
    s.add_argument("--staging", required=True)
    s.add_argument("--out", required=True)
    a = ap.parse_args()
    {"listar": cmd_listar, "buscar": cmd_buscar, "lotes": cmd_lotes, "juntar": cmd_juntar}[a.cmd](a)


if __name__ == "__main__":
    main()
