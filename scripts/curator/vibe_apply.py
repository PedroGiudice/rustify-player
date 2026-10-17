#!/usr/bin/env python3
"""Aplica o resultado de um workflow de vibe: valida, mapeia path (pelo n do TSV) -> track_id no Qdrant
(túnel 16333), grava o JSON em data/enrichments e faz upsert com merge em track_enrichments.

  python3 vibe_apply.py <saida_do_workflow.json> <entrada.tsv> <data/enrichments/arquivo.json>
"""
import json
import statistics
import sys
import urllib.request
from collections import Counter

Q = "http://127.0.0.1:16333"
MOODS = {'aggressive', 'anxious', 'bittersweet', 'chill', 'confident', 'dark', 'dreamy', 'driving', 'energetic', 'ethereal', 'focus', 'groovy', 'intense', 'melancholic', 'nostalgic', 'peaceful', 'playful', 'raw', 'rebellious', 'romantic', 'sensual', 'social', 'triumphant', 'uplifting'}
ACTS = {'chill', 'cleaning', 'commute', 'cooking', 'driving', 'focus', 'gaming', 'meditation', 'party', 'romance', 'sleep', 'social', 'study', 'workout'}


def q(path, body=None, method=None):
    req = urllib.request.Request(f"{Q}{path}", data=json.dumps(body).encode() if body is not None else None,
                                 method=method, headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=60))["result" if method != "PUT" and method != "POST" else "status"]


def main(out_file, tsv_file, dest_json):
    d = json.load(open(out_file))
    res = d["result"] if "result" in d else d
    ann = res["annotations"]
    tsv = {int(l.split("\t")[0]): l.split("\t")[1] for l in open(tsv_file).read().splitlines()[1:]}
    print(f"anotações: {len(ann)} de {len(tsv)} | distintas: {res.get('distinct')} | não resolvidas: {[u for u in res.get('unresolved', []) if u.get('bad') or u.get('missing')]}")
    for n in res.get("notes", []):
        print("  nota:", n[:200].replace("\n", " "))
    pts, offset = [], None
    while True:
        body = {"limit": 1000, "with_payload": ["path"], "with_vector": False}
        if offset:
            body["offset"] = offset
        r = q("/collections/rustify_tracks/points/scroll", body)
        pts += r["points"]
        offset = r.get("next_page_offset")
        if not offset:
            break
    by_path = {p["payload"]["path"]: p["id"] for p in pts}
    out, problems, seen, conf = {}, [], set(), Counter()
    for a in ann:
        real = tsv.get(a["n"])
        if real is None:
            problems.append(("n desconhecido", a["n"])); continue
        if a["path"] != real:
            print(f"  caminho alterado pelo anotador em n={a['n']}: usei o do TSV")
        tid = by_path.get("/home/cmr-auto/Music/" + real)
        if tid is None:
            problems.append(("sem id no Qdrant", real)); continue
        if a["n"] in seen:
            problems.append(("n repetido", a["n"])); continue
        seen.add(a["n"])
        bad = (set(a["mood_tags"]) - MOODS) | (set(a["activity_tags"]) - ACTS)
        if bad or not (0 <= a["energy"] <= 1 and 0 <= a["valence"] <= 1) or not (2 <= len(a["mood_tags"]) <= 5) or not (1 <= len(a["activity_tags"]) <= 4):
            problems.append(("inválida", real, bad)); continue
        conf[a["annotation_confidence"]] += 1
        out[str(tid)] = {"energy": a["energy"], "valence": a["valence"], "mood_tags": a["mood_tags"], "activity_tags": a["activity_tags"],
                         "annotated_by": a["annotated_by"], "annotation_confidence": a["annotation_confidence"]}
    print(f"válidas com id: {len(out)} | problemas: {problems[:6]} | confiança: {dict(conf)}")
    print("faltam n:", sorted(set(tsv) - seen))
    if out:
        print("energy média %.2f | valence média %.2f | moods: %s" % (statistics.mean(v["energy"] for v in out.values()), statistics.mean(v["valence"] for v in out.values()),
                                                                      Counter(t for v in out.values() for t in v["mood_tags"]).most_common(6)))
    json.dump(out, open(dest_json, "w"), ensure_ascii=False, indent=1)
    ids = [int(k) for k in out]
    existing = {p["id"] for p in q("/collections/track_enrichments/points", {"ids": ids, "with_payload": False, "with_vector": False})}
    new_pts = [{"id": int(k), "vector": [0.0], "payload": v} for k, v in out.items() if int(k) not in existing]
    if new_pts:
        print("PUT novos:", len(new_pts), q("/collections/track_enrichments/points?wait=true", {"points": new_pts}, "PUT"))
    for k, v in out.items():
        if int(k) in existing:
            q("/collections/track_enrichments/points/payload?wait=true", {"points": [int(k)], "payload": v}, "POST")
    print("merge em existentes:", len(existing))
    got = q("/collections/track_enrichments/points", {"ids": ids, "with_payload": ["energy"], "with_vector": False})
    print("gravados com energy:", sum(1 for p in got if p["payload"].get("energy") is not None), "de", len(ids))


if __name__ == "__main__":
    main(*sys.argv[1:4])
