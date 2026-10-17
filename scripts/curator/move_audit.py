#!/usr/bin/env python3
"""Auditoria EXTERNA do "Mover para playlist" (CMR-298), independente do código do app.

Esquema real (confirmado em qdrant_client.rs / relocate.rs e no Qdrant da cmr-auto):
  - `rustify_tracks`: ponto = faixa, id u64 = hash do caminho; vetores nomeados `mert` (768d)
    e `lyrics` (1024d); payload com path, filename, title, artist, album_title, genre,
    lrc_path, lyrics_text, lyrics_status.
  - `track_enrichments`: MESMO id u64 da faixa (like = `liked_at`; energy, valence, mood_tags,
    activity_tags, play_count, last_played, dominant_color*...).
  - `play_events`: ponto com UUID; a faixa vem em `payload.track_id` (integer). Um u64 acima de
    i64::MAX não filtra no índice integer, então a contagem é feita NO CLIENTE (scroll só do campo).

Uso (o Qdrant da cmr-auto pelo túnel 16333; nada é escrito, nem no Qdrant nem na cmr-auto):
  move_audit.py snapshot (--ids id1,id2 | --plan plano.json) --out snap.json
  move_audit.py verify --snap snap.json [--dest <playlist> | --dest :sem-tidal]
O `--plan` é a saída do funk_split_plan.py (`{"plan": {dest: [ids]}, ...}`; também aceita
`{dest: [ids]}` puro) e grava o destino esperado por id.
"""
import argparse
import json
import math
import os
import subprocess
import sys
import urllib.request

ROOT = "/home/cmr-auto/Music/"
QDRANT = "http://127.0.0.1:16333"
SSH = ["ssh", "-o", "BatchMode=yes", "cmr-auto@100.102.249.9"]
VEC_NAMES = ("mert", "lyrics")
VEC_TOL = 1e-5
# Mudam legitimamente se o CEO tocar a faixa entre o snapshot e a verificação: viram AVISO, não falha.
SOFT_ENRICH_FIELDS = {"play_count", "last_played"}


# --------------------------------------------------------------------------- funções puras

UNMARK_TIDAL = ":sem-tidal"  # `--dest` do `lib_unmark_tidal`: mesma playlist, pasta do álbum sem " [tidal]"
TIDAL_MARK = " [tidal]"


def expected_path(path: str, dest: str) -> str:
    """Troca SÓ a pasta de 1º nível depois de ROOT pelo destino; com `UNMARK_TIDAL`, a playlist fica
    e as pastas entre ela e o arquivo perdem o " [tidal]" do fim (o nome do arquivo não muda)."""
    if not path.startswith(ROOT):
        raise ValueError(f"caminho fora de {ROOT}: {path}")
    rest = path[len(ROOT):]
    if "/" not in rest:
        raise ValueError(f"caminho sem pasta de playlist: {path}")
    if dest == UNMARK_TIDAL:
        parts = rest.split("/")
        for i in range(1, len(parts) - 1):
            base = parts[i][: -len(TIDAL_MARK)] if parts[i].endswith(TIDAL_MARK) else parts[i]
            if base.strip():
                parts[i] = base
        return ROOT + "/".join(parts)
    return ROOT + dest + "/" + rest.split("/", 1)[1]


def playlist_of(path: str) -> str:
    return path[len(ROOT):].split("/", 1)[0]


def lrc_sibling(flac_path: str) -> str:
    return os.path.splitext(flac_path)[0] + ".lrc"


def vec_summary(vec) -> dict:
    return {"dim": len(vec), "head": [round(float(x), 7) for x in vec[:4]],
            "norm": round(math.sqrt(sum(float(x) ** 2 for x in vec)), 7),
            "sum": round(sum(float(x) for x in vec), 6)}


def vec_equal(a: dict, b: dict, tol: float = VEC_TOL) -> bool:
    if a["dim"] != b["dim"]:
        return False
    if any(abs(x - y) > tol for x, y in zip(a["head"], b["head"])):
        return False
    return abs(a["norm"] - b["norm"]) <= tol and abs(a["sum"] - b["sum"]) <= tol * max(1, a["dim"])


def compare_enrichment(old: dict, new: dict, soft=SOFT_ENRICH_FIELDS) -> tuple[list, list]:
    """(diferenças duras, diferenças moles). Compara campo a campo; ausente != presente."""
    hard, softd = [], []
    for k in sorted(set(old) | set(new)):
        if old.get(k, "<ausente>") != new.get(k, "<ausente>"):
            msg = f"{k}: {old.get(k, '<ausente>')!r} -> {new.get(k, '<ausente>')!r}"
            (softd if k in soft else hard).append(msg)
    return hard, softd


def verdict(rec: dict, dest: str, new: dict | None, old_exists: bool, disk: dict) -> tuple[list, list]:
    """Falhas e avisos de UMA faixa. `new` = {point, enrich, plays, vectors} do ponto novo (ou None).
    `rec` = registro do snapshot. `disk` = existência de old_flac/new_flac/old_lrc/new_lrc."""
    fails, warns = [], []
    exp = expected_path(rec["path"], dest)
    if old_exists:
        fails.append("ponto antigo ainda existe")
    if new is None:
        fails.append(f"ponto novo não encontrado por path exato: {exp}")
    else:
        pl = new["point"]["payload"]
        if new["lyrics_len"] != rec.get("lyrics_text_len", 0):
            fails.append(f"lyrics_text mudou de tamanho: {rec.get('lyrics_text_len', 0)} -> {new['lyrics_len']}")
        if pl.get("lyrics_status") != rec.get("lyrics_status"):
            fails.append(f"lyrics_status: {rec.get('lyrics_status')!r} -> {pl.get('lyrics_status')!r}")
        for f in ("title", "artist", "album_title"):
            if pl.get(f) != rec.get(f):
                fails.append(f"{f} mudou: {rec.get(f)!r} -> {pl.get(f)!r}")
        if rec.get("lrc_path"):
            exp_lrc = expected_path(rec["lrc_path"], dest) if rec["lrc_path"].startswith(ROOT) else None
            if exp_lrc and pl.get("lrc_path") != exp_lrc:
                fails.append(f"lrc_path esperado {exp_lrc!r}, veio {pl.get('lrc_path')!r}")
        if set(new["vectors"]) != set(rec["vectors"]):
            fails.append(f"vetores presentes: {sorted(rec['vectors'])} -> {sorted(new['vectors'])}")
        else:
            for n, s in rec["vectors"].items():
                if not vec_equal(s, new["vectors"][n]):
                    fails.append(f"vetor {n} diferente")
        hard, softd = compare_enrichment(rec.get("enrichment") or {}, new["enrich"] or {})
        fails += [f"enrichment {d}" for d in hard]
        warns += [f"enrichment {d}" for d in softd]
        if new["plays"] < rec["plays"]:
            fails.append(f"plays no id novo {new['plays']} < {rec['plays']} do antigo")
    if rec.get("plays_old_now", 0):
        fails.append(f"{rec['plays_old_now']} plays ainda no id antigo")
    if not disk.get("new_flac"):
        fails.append("FLAC ausente no caminho novo")
    if disk.get("old_flac"):
        fails.append("FLAC ainda existe no caminho antigo")
    if rec.get("lrc_on_disk"):
        if not disk.get("new_lrc"):
            fails.append(".lrc não acompanhou (ausente no destino)")
        if disk.get("old_lrc"):
            fails.append(".lrc ainda existe na origem")
    return fails, warns


# --------------------------------------------------------------------------- Qdrant / ssh

def qcall(path: str, body: dict | None = None, base: str = QDRANT):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=120))["result"]


def get_points(ids: list[int], base: str = QDRANT) -> dict[int, dict]:
    out = {}
    for i in range(0, len(ids), 50):
        for p in qcall("/collections/rustify_tracks/points",
                       {"ids": ids[i:i + 50], "with_payload": True, "with_vector": list(VEC_NAMES)}, base):
            out[int(p["id"])] = p
    return out


def get_enrichments(ids: list[int], base: str = QDRANT) -> dict[int, dict]:
    out = {}
    for i in range(0, len(ids), 50):
        for p in qcall("/collections/track_enrichments/points",
                       {"ids": ids[i:i + 50], "with_payload": True, "with_vector": False}, base):
            out[int(p["id"])] = p.get("payload") or {}
    return out


def count_plays(ids: set[int], base: str = QDRANT) -> dict[int, int]:
    """Compara o track_id NO CLIENTE (u64 > i64::MAX não filtra no índice integer)."""
    counts, off = {i: 0 for i in ids}, None
    while True:
        body = {"limit": 5000, "with_payload": ["track_id"], "with_vector": False}
        if off is not None:
            body["offset"] = off
        r = qcall("/collections/play_events/points/scroll", body, base)
        for p in r["points"]:
            t = (p.get("payload") or {}).get("track_id")
            # Só track_id inteiro, como o mover. Os 11 eventos legados com track_id em texto
            # (search_click/queue_add de versões antigas, sem device_id) não são plays e o mover não os
            # reaponta; contá-los gerava falso "plays ainda no id antigo" (lote do rap, 14/10).
            if isinstance(t, int) and t in counts:
                counts[t] += 1
        off = r.get("next_page_offset")
        if off is None:
            return counts


def find_by_paths(paths: list[str], base: str = QDRANT) -> dict[str, dict]:
    out = {}
    for i in range(0, len(paths), 30):
        chunk = paths[i:i + 30]
        r = qcall("/collections/rustify_tracks/points/scroll",
                  {"filter": {"must": [{"key": "path", "match": {"any": chunk}}]}, "limit": len(chunk) + 10,
                   "with_payload": True, "with_vector": list(VEC_NAMES)}, base)
        for p in r["points"]:
            out[p["payload"]["path"]] = p
    return out


def disk_exists(paths: list[str]) -> dict[str, bool]:
    """UMA chamada ssh para a lista toda (caminhos por stdin, um por linha; sai 1/0 na mesma ordem)."""
    uniq = list(dict.fromkeys(paths))
    if not uniq:
        return {}
    remote = 'while IFS= read -r p; do if [ -e "$p" ]; then echo 1; else echo 0; fi; done'
    r = subprocess.run(SSH + [remote], input="\n".join(uniq) + "\n", capture_output=True, text=True, timeout=120)
    lines = r.stdout.split()
    if r.returncode != 0 or len(lines) != len(uniq):
        raise RuntimeError(f"ssh falhou (rc={r.returncode}): {r.stderr.strip()[:200]}")
    return {p: l == "1" for p, l in zip(uniq, lines)}


def summarize(point: dict) -> dict:
    vec = point.get("vector") or {}
    return {n: vec_summary(vec[n]) for n in VEC_NAMES if isinstance(vec.get(n), list) and vec[n]}


# --------------------------------------------------------------------------- comandos

def cmd_snapshot(a):
    dests: dict[int, str | None] = {}
    if a.ids:
        dests = {int(x): None for x in a.ids.split(",") if x.strip()}
    else:
        plan = json.load(open(a.plan))
        plan = plan.get("plan", plan)
        for d, ids in plan.items():
            for i in ids:
                dests[int(i)] = d
    ids = list(dests)
    pts, enr = get_points(ids), get_enrichments(ids)
    plays = count_plays(set(ids))
    missing = [i for i in ids if i not in pts]
    if missing:
        sys.exit(f"ids ausentes em rustify_tracks: {missing}")
    paths = []
    for i in ids:
        pl = pts[i]["payload"]
        paths.append(pl["path"])
        paths.append(lrc_sibling(pl["path"]))
    disk = disk_exists(paths)
    recs = {}
    for i in ids:
        pl = pts[i]["payload"]
        lt = pl.get("lyrics_text") or ""
        recs[str(i)] = {
            "id": str(i), "dest": dests[i], "path": pl["path"], "title": pl.get("title"), "artist": pl.get("artist"),
            "album_title": pl.get("album_title"), "genre": pl.get("genre"), "lrc_path": pl.get("lrc_path"),
            "lyrics_text_len": len(lt), "lyrics_status": pl.get("lyrics_status"),
            "vectors": summarize(pts[i]), "enrichment": enr.get(i, {}), "plays": plays[i],
            "flac_on_disk": disk[pl["path"]], "lrc_on_disk": disk[lrc_sibling(pl["path"])],
        }
    json.dump({"qdrant": QDRANT, "records": recs}, open(a.out, "w"), ensure_ascii=False, indent=1)
    print(f"snapshot de {len(recs)} faixas em {a.out}")
    for r in recs.values():
        print(f"  {r['id']}  {playlist_of(r['path'])} | {r['artist']} - {r['title']} | plays={r['plays']} "
              f"like={'sim' if (r['enrichment'].get('liked_at') or 0) > 0 else 'nao'} "
              f"lrc={'sim' if r['lrc_on_disk'] else 'nao'} lyrics_text={r['lyrics_text_len']} vetores={sorted(r['vectors'])}")


def cmd_verify(a):
    snap = json.load(open(a.snap))["records"]
    for r in snap.values():
        r["dest_eff"] = r.get("dest") or a.dest
        if not r["dest_eff"]:
            sys.exit("--dest é obrigatório: o snapshot veio de --ids")
    old_ids = [int(i) for i in snap]
    old_pts = get_points(old_ids)
    exp = {i: expected_path(r["path"], r["dest_eff"]) for i, r in snap.items()}
    new_by_path = find_by_paths(list(exp.values()))
    new_ids = {i: int(new_by_path[p]["id"]) for i, p in exp.items() if p in new_by_path}
    enr_new = get_enrichments(list(new_ids.values()))
    plays = count_plays(set(old_ids) | set(new_ids.values()))
    paths = []
    for i, r in snap.items():
        paths += [r["path"], exp[i], lrc_sibling(r["path"]), lrc_sibling(exp[i])]
    disk = disk_exists(paths)
    bad = 0
    print(f"{'id antigo':<20} {'resultado':<8} faixa")
    for i, r in snap.items():
        oid = int(i)
        new = None
        if i in new_ids:
            p = new_by_path[exp[i]]
            new = {"point": p, "vectors": summarize(p), "enrich": enr_new.get(new_ids[i], {}),
                   "plays": plays[new_ids[i]], "lyrics_len": len(p["payload"].get("lyrics_text") or "")}
        r["plays_old_now"] = plays[oid]
        d = {"old_flac": disk[r["path"]], "new_flac": disk[exp[i]],
             "old_lrc": disk[lrc_sibling(r["path"])], "new_lrc": disk[lrc_sibling(exp[i])]}
        fails, warns = verdict(r, r["dest_eff"], new, oid in old_pts, d)
        bad += bool(fails)
        print(f"{i:<20} {'FALHOU' if fails else 'ok':<8} {r['artist']} - {r['title']}  [{playlist_of(r['path'])} -> {r['dest_eff']}]")
        for f in fails:
            print(f"    falha: {f}")
        for w in warns:
            print(f"    aviso: {w}")
    print(f"\nresumo: {len(snap) - bad} ok, {bad} com falha, de {len(snap)}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--qdrant", default=QDRANT)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot")
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--ids")
    g.add_argument("--plan")
    s.add_argument("--out", required=True)
    v = sub.add_parser("verify")
    v.add_argument("--snap", required=True)
    v.add_argument("--dest")
    args = ap.parse_args()
    QDRANT = args.qdrant
    (cmd_snapshot if args.cmd == "snapshot" else cmd_verify)(args)
