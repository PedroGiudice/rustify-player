#!/usr/bin/env python3
"""Testes das funcoes puras de discover_tracks (filtro de biblioteca + tier).

Sem pytest: asserts puros + runner. Cobre os bugs que motivaram o rebuild:
  - family ties: collab credit do ListenBrainz ('Baby Keem & Kendrick Lamar')
    nao casava com o acervo (artist_exact='Baby Keem') no filtro exato.
  - J. Cole == J Cole: pontuacao varia entre grafias.
  - tier de profundidade: hit/mid/deep por posicao na discografia do artista.

Rodar: python3 scripts/curator/test_discover_tracks.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discover_tracks as T


def check(name, got, want):
    status = "ok" if got == want else "FAIL"
    if got != want:
        check.failed += 1
        print(f"  [{status}] {name}\n        got:  {got!r}\n        want: {want!r}")
    else:
        print(f"  [{status}] {name}")


check.failed = 0


def test_split_credit():
    print("split_credit:")
    check("solo", T.split_credit("Drake"), ["Drake"])
    check("ampersand", T.split_credit("Baby Keem & Kendrick Lamar"),
          ["Baby Keem", "Kendrick Lamar"])
    check("feat.", T.split_credit("Kanye West feat. Jay-Z"),
          ["Kanye West", "Jay-Z"])
    check("ft sem ponto", T.split_credit("Metro Boomin ft Future"),
          ["Metro Boomin", "Future"])
    check("virgula + amp", T.split_credit("Future, Young Thug & Drake"),
          ["Future", "Young Thug", "Drake"])
    check("vazio", T.split_credit(""), [])
    check("nao splita hifen interno", T.split_credit("Tyler, The Creator"),
          ["Tyler", "The Creator"])  # virgula divide; cada parte fica limpa


def test_build_library_index():
    print("build_library_index:")
    idx = T.build_library_index([
        ("Baby Keem", "family ties"),
        ("J. Cole", "ATM"),
        ("Astrix & Captain Hook", "Sahara"),
    ])
    check("titulo->artista", idx.get("family ties"), {"baby keem"})
    check("norm tira ponto", idx.get("atm"), {"j cole"})
    check("acervo collab splitado", idx.get("sahara"),
          {"astrix", "captain hook"})


def test_is_owned():
    print("is_owned (filtro de biblioteca):")
    idx = T.build_library_index([
        ("Baby Keem", "family ties"),
        ("J. Cole", "ATM"),
    ])
    # O bug central: ListenBrainz credita a collab inteira; o acervo so o principal.
    check("family ties collab credit -> ja tem",
          T.is_owned("family ties", "Baby Keem & Kendrick Lamar", idx), True)
    check("J Cole == J. Cole",
          T.is_owned("ATM", "J Cole", idx), True)
    check("faixa nova -> nao tem",
          T.is_owned("FE!N", "Travis Scott", idx), False)
    check("mesmo titulo, artista diferente -> nao tem",
          T.is_owned("family ties", "Some Other Band", idx), False)


def test_label_tier():
    print("label_tier:")
    disco = [1000, 500, 200, 100, 50]
    check("mais tocada = hit", T.label_tier(1000, disco), "hit")
    check("menos tocada = deep", T.label_tier(50, disco), "deep")
    check("meio = mid", T.label_tier(200, disco), "mid")
    check("abaixo da cauda = deep", T.label_tier(0, disco), "deep")
    check("sem discografia = unknown", T.label_tier(0, []), "unknown")


def test_merge_pool():
    print("merge_pool (uniao das fontes; tier atribuido depois):")
    a = {"m1": {"recording_mbid": "m1", "sources": ["trackgraph"],
                "sim_score": 0.5, "overlap": 1}}
    b = {"m1": {"recording_mbid": "m1", "sources": ["popularity"],
                "sim_score": 0.0, "overlap": 0},
         "m2": {"recording_mbid": "m2", "sources": ["popularity"],
                "sim_score": 0.0, "overlap": 0}}
    pool = T.merge_pool(a, b)
    check("dedup m1 + inclui m2", ("m1" in pool and "m2" in pool), True)
    check("faixa nas duas fontes une sources", set(pool["m1"]["sources"]),
          {"trackgraph", "popularity"})


def test_tail_picks():
    print("tail_picks (cauda real do artista, nao top-N fixo):")
    # 10 faixas desc; top 30% (t0-t2) sao hits do artista; floor corta <200.
    recs = [{"recording_name": f"t{i}", "total_listen_count": lc}
            for i, lc in enumerate(
                [90000, 80000, 70000, 5000, 4000, 3000, 2000, 150, 100, 50])]
    picks = T.tail_picks(recs, skip_top_pct=0.30, floor=200, k=3)
    names = [r["recording_name"] for r in picks]
    check("pula o top do artista (hits dele)",
          all(n not in names for n in ("t0", "t1", "t2")), True)
    check("corta abaixo do floor",
          all(n not in names for n in ("t7", "t8", "t9")), True)
    check("pega o topo da cauda", names, ["t3", "t4", "t5"])
    # dedup por titulo (fragmentacao)
    dup = [{"recording_name": "X", "total_listen_count": 5000},
           {"recording_name": "x", "total_listen_count": 4000},
           {"recording_name": "Y", "total_listen_count": 3000}]
    pd = T.tail_picks(dup, skip_top_pct=0.0, floor=0, k=5)
    check("dedup por titulo normalizado", [r["recording_name"] for r in pd], ["X", "Y"])


def test_tier_by_pool_percentil():
    print("tier por percentil do pool (label_tier sobre listens do pool):")
    # o tier agora compara a faixa contra os listens de TODO o pool (popularidade
    # absoluta via /popularity/recording), nao contra a discografia do artista.
    pool_listens = [64705, 28395, 21840, 5000, 1200, 300, 40]
    check("faixa popular do pool -> hit", T.label_tier(64705, pool_listens), "hit")
    check("faixa do fundo do pool -> deep", T.label_tier(40, pool_listens), "deep")
    check("faixa do meio -> mid", T.label_tier(5000, pool_listens), "mid")


def test_compose():
    print("compose (estratificacao por tier):")
    pool = {}
    for i, (tier, lc) in enumerate(
            [("hit", 100)] * 5 + [("mid", 50)] * 5 + [("deep", 10)] * 5):
        pool[f"m{i}"] = {"recording_mbid": f"m{i}", "tier": tier,
                         "overlap": 1, "sim_score": 1.0, "listen_count": lc}
    out = T.compose(pool, "mix", 9)
    check("nunca excede size", len(out) <= 9, True)
    check("so faixas do pool",
          all(c["recording_mbid"] in pool for c in out), True)
    check("sem duplicata",
          len({c["recording_mbid"] for c in out}) == len(out), True)
    check("mix cobre os 3 tiers",
          {c["tier"] for c in out} >= {"hit", "mid", "deep"}, True)
    outd = T.compose(pool, "deep", 9)
    nd = sum(1 for c in outd if c["tier"] == "deep")
    nh = sum(1 for c in outd if c["tier"] == "hit")
    check("modo deep pesa o fundo (deep > hit)", nd > nh, True)
    # diversidade de fonte: faixas de B (overlap 0) nao podem ser soterradas
    # pelas de A em todo tier — a cauda traz variedade lateral.
    poolab = {}
    for i in range(20):
        poolab[f"a{i}"] = {"recording_mbid": f"a{i}", "tier": "mid", "overlap": 3,
                           "sim_score": 2.0, "listen_count": 5000,
                           "sources": ["trackgraph"]}
    for i in range(20):
        poolab[f"b{i}"] = {"recording_mbid": f"b{i}", "tier": "mid", "overlap": 0,
                           "sim_score": 0.0, "listen_count": 4000,
                           "sources": ["popularity"]}
    outab = T.compose(poolab, "mix", 20)
    nb = sum(1 for c in outab if "popularity" in c["sources"])
    check("fonte B (cauda) representada apesar de overlap 0", nb >= 1, True)
    # pool hit-pesado (30 hit, 10 deep, 0 mid): o fallback NAO pode inflar hit
    # alem da cota (era o bug que dava 50% hit num mix).
    pool2 = {}
    for i in range(30):
        pool2[f"h{i}"] = {"recording_mbid": f"h{i}", "tier": "hit",
                          "overlap": 1, "sim_score": 1.0, "listen_count": 1000}
    for i in range(10):
        pool2[f"d{i}"] = {"recording_mbid": f"d{i}", "tier": "deep",
                          "overlap": 1, "sim_score": 1.0, "listen_count": 5}
    out2 = T.compose(pool2, "mix", 20)
    n_hit = sum(1 for c in out2 if c["tier"] == "hit")
    check("mix nao deixa hit estourar a cota (round(20*.3)=6)", n_hit <= 6, True)


def main():
    for t in (test_split_credit, test_build_library_index,
              test_is_owned, test_label_tier, test_tail_picks,
              test_tier_by_pool_percentil, test_merge_pool, test_compose):
        t()
    print()
    if check.failed:
        print(f"FALHOU: {check.failed} assercao(oes)")
        sys.exit(1)
    print("todos os testes passaram")


if __name__ == "__main__":
    main()
