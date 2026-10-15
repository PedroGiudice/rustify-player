#!/usr/bin/env python3
"""Testes das funções puras da régua (recortes da v0.2.92 e familiaridade).

Rodar: python3 scripts/metrics/test_autoplay_regua.py
A fixture de familiaridade é a MESMA que o teste Rust
(`library-indexer/src/familiarity.rs`) lê: se um lado mudar a definição de
aceite/pulo sem o outro, um dos dois quebra.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import autoplay_regua as R  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "familiaridade.json")


def ev(tipo, pos_ms=None, versao=None, **kw):
    e = {"event_type": tipo, "origin": "autoplay", **kw}
    if pos_ms is not None:
        e["end_position_ms"] = pos_ms
    if versao is not None:
        e["app_version"] = versao
    return e


class Familiaridade(unittest.TestCase):
    def test_fixture_compartilhada_com_o_motor(self):
        fx = json.load(open(FIXTURE))
        fam = R.familiaridade(fx["events"])
        liked = set(fx["liked"])
        for k, exp in fx["expected"].items():
            tid = int(k)
            f = fam.get(tid, {"ended": 0, "motor_attempts": 0, "early_skips": 0})
            self.assertEqual(f["ended"], exp["ended"], f"ended de {tid}")
            self.assertEqual(f["motor_attempts"], exp["motor_attempts"], f"motor_attempts de {tid}")
            self.assertEqual(f["early_skips"], exp["early_skips"], f"early_skips de {tid}")
            self.assertEqual(R.is_known(f, tid in liked), exp["known"], f"known de {tid}")
            self.assertEqual(R.never_ends(f, tid in liked), exp["never_ends"], f"never_ends de {tid}")
        com_contagem = {int(k) for k, e in fx["expected"].items() if e["ended"] or e["motor_attempts"]}
        self.assertEqual(set(fam), com_contagem, "texto, não-play e album_seq pulado não criam entrada")

    def test_nunca_termina_so_conta_pulo_cedo(self):
        tarde = ev("track_skipped", 190_000, track_id=1, duration_ms=200_000, listen_pct=0.95)
        cedo = ev("track_skipped", 1_000, track_id=2, duration_ms=200_000, listen_pct=0.005)
        fam = R.familiaridade([tarde] * 3 + [cedo] * 3)
        self.assertEqual(fam[1]["motor_attempts"], 3)
        self.assertFalse(R.never_ends(fam[1], False), "pulo aos 95% não condena")
        self.assertTrue(R.never_ends(fam[2], False))
        self.assertIsNone(R.listen_fraction({"end_position_ms": 0, "duration_ms": 0, "listen_pct": 0.0}))
        self.assertIsNone(R.listen_fraction({"end_position_ms": 10}))
        self.assertEqual(R.listen_fraction({"end_position_ms": 10_000, "duration_ms": 200_000}), 0.05)

    def test_aceite_e_pulo_sao_os_da_regua(self):
        self.assertTrue(R.is_accept({"event_type": "track_ended"}))
        self.assertFalse(R.is_accept({"event_type": "track_skipped"}))
        self.assertTrue(R.is_skip({"event_type": "track_skipped"}))


class Recortes(unittest.TestCase):
    def test_pulo_de_ate_5s_e_navegacao(self):
        self.assertTrue(R.is_nav_skip(ev("track_skipped", 5000)))
        self.assertFalse(R.is_nav_skip(ev("track_skipped", 5001)))
        self.assertTrue(R.is_nav_skip(ev("track_skipped")), "sem posição conta como 0")
        self.assertFalse(R.is_nav_skip(ev("track_ended", 100)), "aceite nunca é navegação")

    def test_versao(self):
        self.assertTrue(R.desde_versao({"app_version": "0.2.92"}))
        self.assertTrue(R.desde_versao({"app_version": "0.2.100"}), "comparação numérica, não de texto")
        self.assertTrue(R.desde_versao({"app_version": "0.3.0"}))
        self.assertFalse(R.desde_versao({"app_version": "0.2.91"}))
        self.assertFalse(R.desde_versao({}), "legado sem versão fica fora")
        self.assertFalse(R.desde_versao({"app_version": "lixo"}))

    def test_recortes_do_autoplay(self):
        evs = [
            ev("track_skipped", 800, "0.2.91"),
            ev("track_skipped", 60_000, "0.2.91"),
            ev("track_ended", 200_000, "0.2.91"),
            ev("track_skipped", 1_000, "0.2.92"),
            ev("track_skipped", 90_000, "0.2.92"),
            ev("track_ended", 200_000, "0.2.92"),
            ev("track_ended", 200_000, "0.2.93"),
        ]
        rec = R.recortes_autoplay(evs)
        # Sem os pulos até 5 s: sobram 2 pulos e 3 aceites.
        self.assertEqual(rec["sem_pulos_5s"]["n"], 5)
        self.assertEqual(rec["sem_pulos_5s"]["skip_rate"], 0.4)
        # Só 0.2.92+: 2 pulos em 4.
        self.assertEqual(rec["desde_0.2.92"]["n"], 4)
        self.assertEqual(rec["desde_0.2.92"]["skip_rate"], 0.5)
        self.assertEqual(rec["desde_0.2.92_sem_pulos_5s"]["n"], 3)
        md = R.recortes_md(rec)
        self.assertIn("não mudam o veredito", md)
        self.assertIn("desde a v0.2.92", md)

    def test_recorte_vazio_nao_quebra(self):
        rec = R.recortes_autoplay([])
        self.assertEqual(rec["desde_0.2.92"], {"n": 0})
        self.assertIn("sem eventos", R.recortes_md(rec))


if __name__ == "__main__":
    unittest.main(verbosity=2)
