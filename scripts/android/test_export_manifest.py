#!/usr/bin/env python3
"""Testes das funções puras de export_manifest (sem Qdrant).

Sem pytest: asserts puros + runner, no padrão de scripts/curator/
test_discover_tracks.py. Cobre o estado do like no manifest (CMR-220):
  - build_manifest emite `liked_at`/`like_updated_at` por track — presente
    quando o desktop tem o like, `null` quando ausente (e nas chamadas antigas
    sem like_state).
  - fetch_like_state pagina o scroll de track_enrichments e mapeia por
    track_id string (qpost substituído por um fake em memória).
E as capas por álbum-key (CMR-212):
  - cover_rel troca `covers/<sha1>.webp` (cache do desktop) por
    `covers/<sha1>.jpg` (relativo a `.rustify/` no aparelho).
  - build_manifest emite `cover` por track (mesmo cover_path → mesmo cover).
  - cover_jobs separa a primeira capa por pasta (cover.jpg de fallback) do
    conjunto de capas DISTINTAS (uma conversão por álbum-key).

Rodar: python3 scripts/android/test_export_manifest.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import export_manifest as E


def check(name, got, want):
    status = "ok" if got == want else "FAIL"
    if got != want:
        check.failed += 1
        print(f"  [{status}] {name}\n        got:  {got!r}\n        want: {want!r}")
    else:
        print(f"  [{status}] {name}")


check.failed = 0


def point(tid, rel):
    return {"id": tid, "payload": {"path": E.MUSIC_ROOT + rel, "title": f"t{tid}",
                                   "duration_ms": 1000}}


def test_build_manifest_like_state():
    print("build_manifest (liked_at/like_updated_at):")
    points = [point(1, "A/a.flac"), point(2, "A/b.flac"), point(3, "A/c.flac")]
    like_state = {
        "1": (1_700_000_000, 1_700_000_100),   # curtida
        "3": (None, 1_700_000_200),            # descurtida (LWW precisa do carimbo)
    }
    m = E.build_manifest(points, like_state)
    by_id = {t["track_id"]: t for t in m["tracks"]}
    check("curtida: liked_at + like_updated_at",
          (by_id["1"]["liked_at"], by_id["1"]["like_updated_at"]),
          (1_700_000_000, 1_700_000_100))
    check("ausente: os dois null",
          (by_id["2"]["liked_at"], by_id["2"]["like_updated_at"]), (None, None))
    check("descurtida: liked_at null, like_updated_at presente",
          (by_id["3"]["liked_at"], by_id["3"]["like_updated_at"]),
          (None, 1_700_000_200))
    # chamada antiga (sem like_state): as chaves EXISTEM e são null — o
    # ManifestTrack do Rust tolera ausência, mas o shape fica estável.
    m2 = E.build_manifest(points)
    check("sem like_state: chaves presentes e null",
          all("liked_at" in t and "like_updated_at" in t
              and t["liked_at"] is None and t["like_updated_at"] is None
              for t in m2["tracks"]), True)
    check("track_id continua string", type(m["tracks"][0]["track_id"]), str)


def test_fetch_like_state_pagina_e_mapeia():
    print("fetch_like_state:")
    pages = [
        {"points": [
            {"id": 1, "payload": {"liked_at": 10, "like_updated_at": 11}},
            {"id": 2, "payload": {"liked_at": 20}},                # sem carimbo
            {"id": "uuid-nao-u64", "payload": {"liked_at": 30}},  # id fora do acervo
        ], "next_page_offset": 3},
        {"points": [
            {"id": 3, "payload": {"like_updated_at": 31}},         # unlike
            {"id": 4, "payload": {}},                              # sem nada: fora
        ], "next_page_offset": None},
    ]
    calls = []

    def fake_qpost(base_url, path, body):
        calls.append((path, body.get("offset")))
        return pages[len(calls) - 1]

    real = E.qpost
    E.qpost = fake_qpost
    try:
        state = E.fetch_like_state("http://fake")
    finally:
        E.qpost = real
    check("duas páginas, offset da 2ª = next_page_offset da 1ª",
          [c[1] for c in calls], [None, 3])
    check("scroll na collection de enrichments",
          all(c[0] == f"/collections/{E.ENRICHMENTS}/points/scroll" for c in calls), True)
    check("curtida com carimbo", state.get("1"), (10, 11))
    check("curtida sem carimbo", state.get("2"), (20, None))
    check("unlike: só o carimbo", state.get("3"), (None, 31))
    check("id não-inteiro ignorado", "uuid-nao-u64" in state, False)
    check("ponto sem like nem carimbo fica fora", "4" in state, False)
    check("chaves são string", all(isinstance(k, str) for k in state), True)


def point_cover(tid, rel, cover):
    p = point(tid, rel)
    if cover is not None:
        p["payload"]["cover_path"] = cover
    return p


def test_cover_rel_troca_webp_por_jpg():
    print("cover_rel:")
    sha = "a" * 40
    check("webp do cache vira jpg relativo a .rustify/",
          E.cover_rel(f"covers/{sha}.webp"), f"covers/{sha}.jpg")
    check("vazio → None", E.cover_rel(""), None)
    check("None → None", E.cover_rel(None), None)


def test_build_manifest_emite_cover_por_track():
    print("build_manifest (cover):")
    sha_x, sha_y = "x" * 40, "y" * 40
    points = [
        point_cover(1, "A/a.flac", f"covers/{sha_x}.webp"),
        point_cover(2, "A/b.flac", f"covers/{sha_x}.webp"),   # mesmo álbum-key
        point_cover(3, "B/c.flac", f"covers/{sha_y}.webp"),
        point_cover(4, "B/d.flac", None),                     # sem capa no desktop
    ]
    m = E.build_manifest(points, {"1": (1_700_000_000, 1_700_000_100)})
    by_id = {t["track_id"]: t for t in m["tracks"]}
    check("cover relativo a .rustify/", by_id["1"]["cover"], f"covers/{sha_x}.jpg")
    check("mesmo cover_path → mesmo cover", by_id["1"]["cover"], by_id["2"]["cover"])
    check("álbum-key distinto → cover distinto", by_id["3"]["cover"], f"covers/{sha_y}.jpg")
    check("sem cover_path → null", by_id["4"]["cover"], None)
    check("os campos do CMR-220 continuam",
          (by_id["1"]["liked_at"], by_id["1"]["like_updated_at"], by_id["4"]["liked_at"]),
          (1_700_000_000, 1_700_000_100, None))


def test_cover_jobs_deduplica_capas_e_mantem_primeira_por_pasta():
    print("cover_jobs:")
    sha_x, sha_y = "x" * 40, "y" * 40
    points = [
        point_cover(1, "A/a.flac", f"covers/{sha_x}.webp"),
        point_cover(2, "A/b.flac", f"covers/{sha_y}.webp"),   # 2ª capa na mesma pasta
        point_cover(3, "B/c.flac", f"covers/{sha_x}.webp"),   # capa repetida, outra pasta
        point_cover(4, "C/d.flac", None),                     # sem capa: fora dos dois mapas
        {"id": 5, "payload": {"path": "/outro/root/e.flac", "cover_path": f"covers/{sha_y}.webp"}},
    ]
    dir_cover, distinct = E.cover_jobs(points)
    check("pasta fica com a PRIMEIRA capa (setdefault)",
          dir_cover, {"A": f"covers/{sha_x}.webp", "B": f"covers/{sha_x}.webp"})
    check("capas distintas deduplicadas, jpg → webp do cache",
          distinct, {f"{sha_x}.jpg": f"covers/{sha_x}.webp", f"{sha_y}.jpg": f"covers/{sha_y}.webp"})


def main():
    for t in (test_build_manifest_like_state, test_fetch_like_state_pagina_e_mapeia,
              test_cover_rel_troca_webp_por_jpg, test_build_manifest_emite_cover_por_track,
              test_cover_jobs_deduplica_capas_e_mantem_primeira_por_pasta):
        t()
    print()
    if check.failed:
        print(f"FALHOU: {check.failed} assercao(oes)")
        sys.exit(1)
    print("todos os testes passaram")


if __name__ == "__main__":
    main()
