#!/usr/bin/env python3
"""Testes das funções puras de funk_mert_classify.py (CMR-299).

Rodar: python3 scripts/curator/test_funk_mert_classify.py
(precisa de numpy; se faltar no python do sistema: uv run --with numpy python3 ...)
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import funk_mert_classify as F  # noqa: E402


def test_norm_key_agrupa_grafias():
    assert F.norm_key("DJ Anderson do Paraíso") == F.norm_key("Dj  Anderson do Paraiso")
    assert F.norm_key("Mc Jacaré") == "mc jacare"


def test_voto_ponderado_soma_similaridade_dos_k_vizinhos():
    sims = np.array([0.9, 0.8, 0.1, 0.7, -0.5])
    labels = ["A", "B", "A", "A", "B"]
    s = F.weighted_vote(sims, labels, k=3)  # vizinhos: 0.9 A, 0.8 B, 0.7 A
    assert set(s) == {"A", "B"}
    assert abs(s["A"] - 1.6) < 1e-9 and abs(s["B"] - 0.8) < 1e-9


def test_voto_ignora_similaridade_negativa():
    s = F.weighted_vote(np.array([-0.2, -0.3]), ["A", "B"], k=2)
    assert all(v <= 1e-6 for v in s.values())


def test_voto_balanceado_divide_pelo_tamanho_da_classe():
    s = F.weighted_vote(np.array([0.5, 0.5]), ["A", "B"], k=2, prior={"A": 10, "B": 1})
    assert s["B"] > s["A"]


def test_margem_unanime_e_empate():
    best, second, m, share = F.vote_margin({"A": 2.0})
    assert best == "A" and second is None and m == 1.0 and share == {"A": 1.0}
    best, second, m, _ = F.vote_margin({"A": 1.0, "B": 1.0})
    assert m == 0.0 and {best, second} == {"A", "B"}
    best, _, m, _ = F.vote_margin({"A": 3.0, "B": 1.0})
    assert best == "A" and abs(m - 0.5) < 1e-9


def test_calibracao_acha_menor_limiar_que_bate_a_meta():
    margens = [0.1] * 10 + [0.5] * 10 + [0.9] * 10
    certo = [False] * 10 + [True] * 8 + [False] * 2 + [True] * 10
    t_alta, t_media = F.calibrate_thresholds(margens, certo, 0.95, 0.80, min_n=10)
    assert t_alta == 0.9          # só a faixa de 0.9 tem 100%
    assert t_media == 0.5         # >= 0.5: 18/20 = 90%
    assert F.confidence_of(0.95, t_alta, t_media) == "alta"
    assert F.confidence_of(0.6, t_alta, t_media) == "media"
    assert F.confidence_of(0.2, t_alta, t_media) == "baixa"


def test_calibracao_sem_meta_alcancavel_vira_tudo_baixa():
    t_alta, t_media = F.calibrate_thresholds([0.2, 0.9] * 10, [True, False] * 10)
    assert t_alta is None and t_media is None
    assert F.confidence_of(1.0, t_alta, t_media) == "baixa"


def test_leave_one_artist_out_tira_o_artista_inteiro():
    # artista "x" tem 2 faixas idênticas rotuladas A; o resto é B e aponta para outro lado.
    v = np.array([[1, 0], [1, 0], [0.9, 0.1], [0, 1]], dtype=float)
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    labels = ["A", "A", "B", "B"]
    groups = ["x", "x", "y", "z"]
    pred = [r[0] for r in F.leave_one_group_out(v, labels, groups, k=1)]
    # sem o próprio artista, o vizinho mais próximo das faixas de "x" é a de "y" (B):
    assert pred[0] == "B" and pred[1] == "B"
    # leave-one-TRACK-out acertaria (vazamento): a gêmea do mesmo artista está lá
    loto = [r[0] for r in F.leave_one_group_out(v, labels, ["a", "b", "c", "d"], k=1)]
    assert loto[0] == "A"


def test_agregacao_por_diretorio_e_divisao():
    res = [("A", 1.0, {"A": 1.0}), ("A", 0.5, {"A": 0.75, "B": 0.25}), ("B", 1.0, {"B": 1.0})]
    ag = F.aggregate(res)
    assert ag["dest"] == "A" and ag["n_tracks"] == 3
    assert abs(ag["margin"] - (1.75 - 1.25) / 3) < 1e-3
    assert ag["split"] == {"A": 2, "B": 1} and ag["dividido"]
    assert not F.aggregate([("A", 1.0, {"A": 1.0})])["dividido"]


def test_assign_rows_album_vence_linha_do_artista():
    rows = [{"artist_dir": "DJ Guuga", "album_dir": None},
            {"artist_dir": "DJ Guuga", "album_dir": "MEGA ELETRO FUNK - Last Night [tidal]"}]
    paths = [F.SRC + "DJ Guuga/MEGA ELETRO FUNK - Last Night [tidal]/01 x.flac",
             F.SRC + "DJ Guuga/Casamento/01 y.flac",
             F.SRC + "DJ Guugax/Outro/01 z.flac"]
    assert F.assign_rows(rows, paths) == [1, 0, None]


def test_rel_dirs():
    assert F.rel_dirs(F.SRC + "A/B/01.flac") == ("A", "B")
    assert F.rel_dirs(F.SRC + "A/01.flac") == ("A", None)


if __name__ == "__main__":
    testes = [(n, f) for n, f in globals().items() if n.startswith("test_") and callable(f)]
    for nome, fn in testes:
        fn()
        print(f"ok  {nome}")
    print(f"{len(testes)} testes passaram")
