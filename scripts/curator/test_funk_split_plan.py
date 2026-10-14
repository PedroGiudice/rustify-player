#!/usr/bin/env python3
"""Testes do plano de separação (precedência, origem, ids como string). Rodar:
  python3 scripts/curator/test_funk_split_plan.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from funk_split_plan import build_plan, MUSIC  # noqa: E402

SRC = "Rap & Hip-Hop"
ROOT = MUSIC + SRC + "/"
BIG = 18446744073709551000  # u64 acima de 2^53

POINTS = [
    (1, ROOT + "Artista A/Album X/01 a.flac"),
    (2, ROOT + "Artista A/Album X/02 b.flac"),
    (3, ROOT + "Artista A/Album Y/01 c.flac"),
    (4, ROOT + "Artista A/solta.flac"),
    (5, ROOT + "_Compilations/Mix/03 Faixa.flac"),
    (6, ROOT + "_Compilations/Mix/04 Outra.flac"),
    (BIG, ROOT + "Artista B/01 d.flac"),
]


def rows():
    return [
        {"artist_dir": "Artista A", "album_dir": None, "dest": "Rap & Trap Brasileiro", "confidence": "alta"},
        {"artist_dir": "Artista A", "album_dir": "Album X", "dest": SRC, "confidence": "alta"},
        {"artist_dir": "_Compilations", "album_dir": "Mix", "dest": SRC, "confidence": "media"},
        {"artist_dir": "_Compilations", "album_dir": "Mix", "file": "_Compilations/Mix/03 Faixa.flac",
         "dest": "Rap & Trap Brasileiro", "confidence": "alta"},
        {"artist_dir": "Artista B", "album_dir": None, "dest": "Rap & Trap Brasileiro", "confidence": "baixa"},
    ]


class PlanoTest(unittest.TestCase):
    def test_precedencia_file_album_artista(self):
        plan, counts, _ = build_plan(rows(), POINTS, "media", SRC)
        # artista A inteiro vai, exceto Album X (álbum vence artista, e dest = origem não move)
        self.assertEqual(sorted(plan["Rap & Trap Brasileiro"]), sorted(["3", "4", "5"]))
        # a faixa 5 (file) vence a linha do álbum que a deixaria ficar
        self.assertIn("5", plan["Rap & Trap Brasileiro"])
        self.assertNotIn("6", plan.get("Rap & Trap Brasileiro", []))
        self.assertEqual(counts["Rap & Trap Brasileiro"], 3)

    def test_dest_igual_origem_nao_move(self):
        plan, _, _ = build_plan(rows(), POINTS, "media", SRC)
        flat = [i for ids in plan.values() for i in ids]
        for ficou in ("1", "2", "6"):
            self.assertNotIn(ficou, flat)
        self.assertNotIn(SRC, plan)

    def test_confianca_minima_e_ids_string(self):
        plan, _, skipped = build_plan(rows(), POINTS, "media", SRC)
        self.assertEqual(len(skipped), 1)  # Artista B baixa
        self.assertNotIn(str(BIG), plan["Rap & Trap Brasileiro"])
        plan, _, _ = build_plan(rows(), POINTS, "baixa", SRC)
        self.assertIn(str(BIG), plan["Rap & Trap Brasileiro"])
        for ids in plan.values():
            for i in ids:
                self.assertIsInstance(i, str)

    def test_src_padrao_funk(self):
        pts = [(9, MUSIC + "Funk Brasileiro/MC X/01.flac"), (10, MUSIC + "Funk Brasileiro/MC Y/01.flac")]
        r = [{"artist_dir": "MC X", "album_dir": None, "dest": "Mega Funk", "confidence": "alta"},
             {"artist_dir": "MC Y", "album_dir": None, "dest": "Funk Brasileiro", "confidence": "alta"}]
        plan, counts, _ = build_plan(r, pts, "media")
        self.assertEqual(plan, {"Mega Funk": ["9"]})
        self.assertEqual(counts["Mega Funk"], 1)

    def test_file_nao_casa_por_prefixo(self):
        pts = [(1, ROOT + "A/B/01.flac"), (2, ROOT + "A/B/01.flac.bak")]
        r = [{"artist_dir": "A", "album_dir": "B", "file": "A/B/01.flac", "dest": "X", "confidence": "alta"}]
        plan, _, _ = build_plan(r, pts, "media", SRC)
        self.assertEqual(plan, {"X": ["1"]})


if __name__ == "__main__":
    unittest.main()
