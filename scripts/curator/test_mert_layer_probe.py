#!/usr/bin/env python3
"""Testes das funções puras de mert_layer_probe (sem pytest).

Rodar: python3 scripts/curator/test_mert_layer_probe.py
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mert_layer_probe as P


def check(nome, got, want):
    assert got == want, f"{nome}: obtido {got!r}, esperado {want!r}"


def test_center_window():
    # mesmo contrato do take_center_window do app (Rust): centro de 0..100 com 10 = 45..54
    v = list(range(100))
    out = P.center_window(v, 10)
    check("len", len(out), 10)
    check("ini", out[0], 45)
    check("fim", out[-1], 54)
    check("curta", P.center_window([1, 2, 3], 10), [1, 2, 3])
    check("exata", P.window_start(10, 10), 0)
    check("start_30s", P.window_start(P.MAX_SAMPLES + 2), 1)


def test_window_start_seconds():
    check("longa", P.window_start_seconds(100.0), 15.0)  # centro dos primeiros 60 s
    check("media", P.window_start_seconds(50.0), 10.0)   # centro da faixa inteira
    check("sessenta", P.window_start_seconds(60.0), 15.0)
    check("curta", P.window_start_seconds(12.5), 0.0)
    check("exata", P.window_start_seconds(30.0), 0.0)


def test_balanced_accuracy():
    true = ["a"] * 8 + ["b"] * 2
    pred = ["a"] * 8 + ["a", "b"]
    bal, rec = P.balanced_accuracy(true, pred)
    check("recall_a", rec["a"], 1.0)
    check("recall_b", rec["b"], 0.5)
    check("bal", bal, 0.75)
    check("simples", P.plain_accuracy(true, pred), 0.9)  # a classe grande engana
    check("vazio", P.balanced_accuracy([], [])[0], 0.0)


def test_sample_by_artist():
    itens = [{"path": f"/x/{a}/{i}.flac", "artist_dir": a}
             for a in ("A", "B", "C") for i in range(10)]
    s = P.sample_by_artist(itens, 7, 3, seed=1)
    check("n", len(s), 7)
    from collections import Counter
    assert max(Counter(i["artist_dir"] for i in s).values()) <= 3
    check("determinismo", [i["path"] for i in s],
          [i["path"] for i in P.sample_by_artist(list(reversed(itens)), 7, 3, seed=1)])
    # teto por artista limita o total
    check("teto", len(P.sample_by_artist(itens, 50, 3, seed=1)), 9)
    assert [i["path"] for i in s] != [i["path"] for i in P.sample_by_artist(itens, 7, 3, seed=2)]


def test_cosine_gaps():
    # dois rótulos bem separados; artista a1/a2 no rótulo x, b1/b2 em y
    X = P.l2([[1, 0.1], [1, -0.1], [0.5, 0.9], [-1, 0.1], [-1, -0.1]])
    lab = ["x", "x", "x", "y", "y"]
    grp = ["a1", "a1", "a2", "b1", "b2"]
    g = P.cosine_gaps(X, lab, grp)
    assert g["mesmo_artista"] > g["mesmo_rotulo_outro_artista"] > 0 > g["rotulos_diferentes"]
    assert abs(g["gap_estilo"] - (g["mesmo_rotulo_outro_artista"] - g["rotulos_diferentes"])) < 1e-12


def test_center_normalize():
    V = np.array([[2.0, 0.0], [0.0, 2.0], [1.0, 0.0], [0.0, 0.0]])
    X = P.center_normalize(V)
    assert np.allclose(np.linalg.norm(X, axis=1), 1.0)
    # a direção comum (média) some: a linha centrada é proporcional a V - média
    c = V - V.mean(axis=0)
    assert np.allclose(X[0], c[0] / np.linalg.norm(c[0]))


def main():
    for nome, fn in sorted(globals().items()):
        if nome.startswith("test_"):
            fn()
            print("ok", nome)


if __name__ == "__main__":
    main()
