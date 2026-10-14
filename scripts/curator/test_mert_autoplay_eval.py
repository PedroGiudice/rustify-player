#!/usr/bin/env python3
"""Testes das funções puras de mert_autoplay_eval (sem pytest).

Rodar: uv run --with numpy python3 scripts/curator/test_mert_autoplay_eval.py
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mert_autoplay_eval as M

FALHAS = []


def check(nome, got, want):
    ok = got == want if not isinstance(want, float) else abs(got - want) < 1e-9
    if not ok:
        FALHAS.append(f"{nome}: esperado {want!r}, veio {got!r}")


def test_janela_central():
    check("faixa de 200 s começa em 85 s", M.center_start_seconds(200.0), 85.0)
    check("faixa de 30 s começa em 0", M.center_start_seconds(30.0), 0.0)
    check("faixa curta começa em 0", M.center_start_seconds(12.0), 0.0)
    n = M.SR * 100
    check("amostras: centro de 100 s", M.center_start_samples(n), (n - M.MAX_SAMPLES) // 2)
    check("amostras: curta inteira", M.center_start_samples(1000), 0)


def ev(t, tid, tipo="track_ended", origem="manual", dev="d1", **kw):
    return {"timestamp": t, "started_at": t - 10, "track_id": tid, "event_type": tipo,
            "origin": origem, "device_id": dev, **kw}


def test_sessoes_e_semente():
    eventos = [
        ev(1000, 1),                                   # aceite manual: vira semente
        ev(1100, 2, "track_skipped", "autoplay"),      # semente 1
        ev(1200, 3, "track_ended", "autoplay"),        # semente 1 (o skip não é semente)
        ev(1300, 4, "track_skipped", "autoplay"),      # semente 3
        ev(1300 + 31 * 60, 5, "track_skipped", "autoplay"),  # sessão nova, sem aceite: None
        ev(1100, 9, "track_ended", "manual", dev="d2"),      # outro aparelho
        ev(1150, 3, "track_skipped", "station", dev="d2"),   # semente 9 (do d2, não do d1)
        ev(1160, 9, "track_ended", "autoplay", dev="d2"),    # semente = a própria faixa: None
    ]
    s = M.assign_sessions(eventos)
    sess = {(e["device_id"], e["track_id"], e["timestamp"]): e["_sess"] for e in s}
    check("mesma sessão dentro de 30 min", sess[("d1", 1, 1000)], sess[("d1", 4, 1300)])
    check("gap > 30 min abre sessão", sess[("d1", 5, 1300 + 31 * 60)] != sess[("d1", 4, 1300)], True)
    alvos = M.seeds_by_session(s)
    sem = {(e["device_id"], e["track_id"], e["timestamp"]): e["seed"] for e in alvos}
    check("semente = aceite anterior", sem[("d1", 2, 1100)], 1)
    check("skip não vira semente", sem[("d1", 3, 1200)], 1)
    check("aceite do autoplay vira semente", sem[("d1", 4, 1300)], 3)
    check("primeiro da sessão sem semente", sem[("d1", 5, 1300 + 31 * 60)], None)
    check("semente do mesmo aparelho", sem[("d2", 3, 1150)], 9)
    check("semente igual à faixa é descartada", sem[("d2", 9, 1160)], None)
    check("só origens pedidas", len(alvos), 6)
    check("legado sem device_id", M.assign_sessions([{"timestamp": 5, "track_id": 1}])[0]["_sess"], "(legado)#0")


def test_corte_v3():
    check("schema manda", M.is_pos_v3({"signal_schema": 3, "timestamp": 1}), True)
    check("schema antigo", M.is_pos_v3({"signal_schema": 2, "timestamp": M.V3_CUTOFF + 9}), False)
    check("legado por data", M.is_pos_v3({"timestamp": M.V3_CUTOFF}), True)
    check("legado antes", M.is_pos_v3({"started_at": M.V3_CUTOFF - 1}), False)


def test_era_do_radio():
    check("versão", M.version_tuple("0.2.82"), (0, 2, 82))
    check("legado", M.version_tuple(""), (0,))
    check("0.2.75 já é pós-correção", M.is_pos_radio_fix({"app_version": "0.2.75"}), True)
    check("0.2.74 antes", M.is_pos_radio_fix({"app_version": "0.2.74"}), False)
    check("0.2.100 depois", M.is_pos_radio_fix({"app_version": "0.2.100"}), True)
    check("sem versão = antes", M.is_pos_radio_fix({}), False)


def test_auc():
    check("separação perfeita", M.auc([0.9, 0.8, 0.1, 0.2], [1, 1, 0, 0]), 1.0)
    check("invertida", M.auc([0.1, 0.2, 0.9, 0.8], [1, 1, 0, 0]), 0.0)
    check("tudo empatado", M.auc([0.5] * 4, [1, 0, 1, 0]), 0.5)
    # 1 aceite (0,5) contra skips 0,5 (empate) e 0,1 (vence): (0,5 + 1) / 2
    check("empate vale meio", M.auc([0.5, 0.5, 0.1], [1, 0, 0]), 0.75)
    check("uma classe só = NaN", math.isnan(M.auc([1, 2], [1, 1])), True)
    rng = np.random.default_rng(1)
    s, y = rng.normal(size=300), rng.integers(0, 2, 300)
    n1, n0 = y.sum(), (1 - y).sum()
    bruto = sum((a > b) + 0.5 * (a == b) for a in s[y == 1] for b in s[y == 0]) / (n1 * n0)
    check("bate com a contagem de pares", round(M.auc(s, y), 12), round(float(bruto), 12))


def test_bootstrap_por_sessao():
    sess = ["a", "a", "a", "b", "c", "c"]
    rs = M.session_resamples(sess, n_boot=50, seed=7)
    check("50 reamostras", len(rs), 50)
    for ix in rs:
        # sessão entra inteira: "a" aparece em múltiplos de 3, "c" em múltiplos de 2
        check("bloco a inteiro", int(np.isin(ix, [0, 1, 2]).sum()) % 3, 0)
        check("bloco c inteiro", int(np.isin(ix, [4, 5]).sum()) % 2, 0)
        check("3 sessões por reamostra", len(ix) in range(3, 10), True)
    check("semente fixa reproduz", [list(x) for x in M.session_resamples(sess, 5, 3)],
          [list(x) for x in M.session_resamples(sess, 5, 3)])
    sc, y = [0.9, 0.8, 0.7, 0.1, 0.2, 0.3], [1, 1, 1, 0, 0, 0]
    lo, hi = M.bootstrap_auc(sc, y, M.session_resamples(sess, 200, 1))
    check("IC dentro de [0,1]", 0.0 <= lo <= hi <= 1.0, True)
    dlo, dhi, p0 = M.bootstrap_diff(sc, sc, y, M.session_resamples(sess, 50, 1))
    check("diferença de si mesmo = 0", (dlo, dhi, p0), (0.0, 0.0, 1.0))


def test_gosto():
    now = 100 * 86400
    hist = [
        {"track_id": 1, "listen_pct": 1.0, "end_position_ms": 200_000, "origin": "manual",
         "timestamp": now - 50, "started_at": now - 60},
        {"track_id": 2, "listen_pct": 0.0, "end_position_ms": 1000, "origin": "autoplay",
         "timestamp": now - 40, "started_at": now - 50},
        # escuta completa de 30 s: atenção 1/3 -> peso 0,33 < 0,55, não qualifica
        {"track_id": 3, "listen_pct": 1.0, "end_position_ms": 30_000, "origin": "manual",
         "timestamp": now - 30, "started_at": now - 40},
        # depois do momento avaliado: não pode vazar
        {"track_id": 4, "listen_pct": 1.0, "end_position_ms": 200_000, "origin": "manual",
         "timestamp": now + 5, "started_at": now},
        # autoplay inteiro: 1,0 x 0,6 = 0,6 >= 0,55, qualifica
        {"track_id": 5, "listen_pct": 1.0, "end_position_ms": 200_000, "origin": "autoplay",
         "timestamp": now - 20, "started_at": now - 30},
    ]
    likes = [(2, now - 100), (6, now - 100), (7, now + 100)]
    pos = M.taste_positives(hist, likes, now)
    check("positivos em ordem de saldo + like", pos, [1, 5, 6])
    check("sem futuro", 4 in pos, False)


def test_build_reps():
    rng = np.random.default_rng(0)
    app = rng.normal(size=(20, 768))
    lay = rng.normal(size=(20, 13, 768)).astype(np.float16)
    R = M.build_reps(app, lay)
    check("cinco representações", sorted(R), sorted(M.REPS))
    for k, X in R.items():
        check(f"{k} normalizado", bool(np.allclose(np.linalg.norm(X, axis=1), 1.0)), True)
    mid = lay.astype(np.float64)[:, 5:9].mean(axis=1)
    check("mid58c = média 5..8", bool(np.allclose(R["mid58c"], M.center_normalize(mid))), True)


def test_plano():
    tracks = [{"id": i, "path": f"/m/{chr(100 - i)}"} for i in range(5)]
    plano = M.plan_batches(tracks, {"1", "3"}, 2, 7)
    check("lotes numerados de 7", [n for n, _ in plano], [7, 8])
    check("só os que faltam, por caminho", [t["id"] for _, b in plano for t in b], [4, 2, 0])


def main():
    for nome, f in sorted(globals().items()):
        if nome.startswith("test_"):
            f()
    if FALHAS:
        print("\n".join(FALHAS))
        sys.exit(1)
    print("ok")


if __name__ == "__main__":
    main()
