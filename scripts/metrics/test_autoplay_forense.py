#!/usr/bin/env python3
"""Testes das funções puras de autoplay_forense (sem pytest).

Rodar: uv run --with numpy python3 scripts/metrics/test_autoplay_forense.py
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import autoplay_forense as F  # noqa: E402

M = F.M
FALHAS = []


def check(nome, got, want):
    if isinstance(want, float):
        ok = (math.isnan(want) and math.isnan(got)) or abs(got - want) < 1e-9
    else:
        ok = got == want
    if not ok:
        FALHAS.append(f"{nome}: got {got!r}, want {want!r}")


def test_pastas():
    p = "/home/cmr-auto/Music/Rap & Trap Brasileiro/Artista/Álbum/01 X.flac"
    check("top", F.top_folder(p), "Rap & Trap Brasileiro")
    check("rel", F.rel_sem_playlist(p), "Artista/Álbum/01 X.flac")
    check("fora do acervo", F.top_folder("/tmp/x.flac"), None)
    check("arquivo solto na raiz", F.top_folder("/home/cmr-auto/Music/x.flac"), None)
    moves = {("Artista/Álbum/01 X.flac", "Rap & Trap Brasileiro"): ("Rap & Hip-Hop", 1000)}
    check("antes do lote: pasta antiga", F.folder_at(p, 999, moves), "Rap & Hip-Hop")
    check("depois do lote: pasta nova", F.folder_at(p, 1000, moves), "Rap & Trap Brasileiro")
    outra = "/home/cmr-auto/Music/Funk Brasileiro/Artista/Álbum/01 X.flac"
    check("mesmo rel em outra pasta não casa", F.folder_at(outra, 1, moves), "Funk Brasileiro")


def test_lotes_reais():
    moves = F.load_moves(F.LOTES)
    check("lotes carregados", len(moves) > 200, True)
    de, ts = next(iter(moves.values()))
    check("ts do lote em 14/10", ts > 1791936000, True)


def test_artista():
    check("colab conta", F.same_artist("Baby Keem & Kendrick Lamar", "Kendrick Lamar"), True)
    check("feat conta", F.same_artist("Drake feat. Future", "future"), True)
    check("acento e caixa", F.same_artist("Matuê", "MATUE"), True)
    check("diferente", F.same_artist("Drake", "Future"), False)
    check("various artists não casa", F.same_artist("Various Artists", "Various Artists"), False)
    check("vazio", F.same_artist("", ""), False)


def test_contagens():
    evs = [{"track_id": 1, "timestamp": t} for t in (100, 200, 300, 10_000)]
    idx = F.index_by_track(evs)
    check("antes de 300 (exclui o próprio)", F.count_before(idx, 1, 300), 2)
    check("janela de 150 s antes de 300", F.count_before(idx, 1, 300, 150), 1)
    check("faixa sem histórico", F.count_before(idx, 2, 300), 0)


def ev(t, tid, tipo="track_skipped", origem="autoplay", dev="d1", end=0):
    return {"timestamp": t, "started_at": t - 10, "track_id": tid, "event_type": tipo,
            "origin": origem, "device_id": dev, "end_position_ms": end}


def test_sessao():
    evs = M.assign_sessions([ev(100, 1), ev(200, 2), ev(300, 1), ev(100 + 4000, 3)])
    sf = F.session_features(evs)
    a, b, c, d = evs
    check("posição 1", sf[id(a)]["pos"], 1)
    check("posição 3", sf[id(c)]["pos"], 3)
    check("repetição na sessão", sf[id(c)]["rep_sessao"], 1)
    check("primeira vez", sf[id(a)]["rep_sessao"], 0)
    check("duração da sessão em min", sf[id(a)]["dur_sessao_min"], (300 - 90) / 60.0)
    check("sessão nova após 30 min", sf[id(d)]["pos"], 1)


def test_hora():
    # 2026-10-12 06:24:31 UTC = 03:24 em São Paulo (UTC-3), segunda-feira
    h, dow = F.local_hour_dow(1791786271)
    check("hora local", h, 3)
    check("dia da semana", dow, 0)
    check("faixas", [F.hour_bin(x) for x in (0, 6, 12, 18, 23)],
          ["madrugada", "manha", "tarde", "noite", "noite"])


def test_navegacao_e_rajadas():
    check("pulo em 5 s é navegação", F.is_nav_skip(ev(1, 1, end=5000)), True)
    check("pulo em 5,1 s não é", F.is_nav_skip(ev(1, 1, end=5100)), False)
    check("aceite nunca é", F.is_nav_skip(ev(1, 1, tipo="track_ended", end=0)), False)
    rows = [{"nav_skip": n, "sess": s} for n, s in
            [(True, "a"), (True, "a"), (False, "a"), (True, "a"), (True, "b"), (True, "b"), (True, "b")]]
    check("rajadas", F.burst_lengths(rows), [2, 2, 0, 1, 3, 3, 3])


def test_auc_rapida_igual_a_original():
    rng = np.random.default_rng(1)
    for _ in range(20):
        s = rng.integers(0, 6, 50).astype(float)  # muitos empates
        y = rng.random(50) < 0.3
        check("auc_fast == M.auc", F.auc_fast(s, y), M.auc(s, y))
    check("uma classe só", F.auc_fast([1, 2], [True, True]), float("nan"))


def test_diferenca_de_taxa():
    f = np.array([1, 1, 0, 0, 0], dtype=bool)
    y = np.array([1, 0, 0, 0, 1], dtype=bool)
    check("dif", F.rate_diff(f, y), 0.5 - 1 / 3)
    check("grupo vazio", F.rate_diff(np.ones(3, bool), y[:3]), float("nan"))


def test_top_sessoes():
    rows = [{"sess": s} for s in "aaabbc"]
    resto, top = F.drop_top_sessions(rows, 1)
    check("top", top, ["a"])
    check("resto", [r["sess"] for r in resto], list("bbc"))


def test_derivadas():
    r = F.derived({"plays_antes": 0, "rep_sessao": 2, "hora": 19, "dow": 6, "device": "s24"})
    check("nova", r["nova"], True)
    check("repetida na sessão", r["rep_na_sessao"], True)
    check("noite", r["noite"], True)
    check("fim de semana", r["fim_de_semana"], True)
    check("s24", r["s24"], True)


def main():
    for nome, fn in list(globals().items()):
        if nome.startswith("test_") and callable(fn):
            fn()
    if FALHAS:
        print("\n".join(FALHAS))
        sys.exit(1)
    print("ok")


if __name__ == "__main__":
    main()
