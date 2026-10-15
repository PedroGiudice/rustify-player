#!/usr/bin/env python3
"""Testes das funções puras de quality_seed.py.  python3 scripts/curator/test_quality_seed.py"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from quality_seed import payload_for, rel_path  # noqa: E402


class Seed(unittest.TestCase):
    def test_classe_espectral_ignora_o_comment(self):
        row = {"sr": 44100, "cutoff_hz": 16075, "class": "lossy_declarado"}
        self.assertEqual(payload_for(row), {"quality_class": "lossy", "quality_cutoff_hz": 16075})
        self.assertEqual(payload_for({"sr": 96000, "cutoff_hz": 21879, "class": "hires_de_cd"})["quality_class"], "hires_de_cd")
        self.assertEqual(payload_for({"sr": 44100, "cutoff_hz": None, "class": "sem_corte"}),
                         {"quality_class": "sem_corte", "quality_cutoff_hz": None})
        self.assertIsNone(payload_for({"class": "erro", "error": "x"}))

    def test_caminho_relativo(self):
        self.assertEqual(rel_path("/home/cmr-auto/Music/Jazz/a.flac", "/home/cmr-auto/Music"), "Jazz/a.flac")
        self.assertIsNone(rel_path("/outro/Jazz/a.flac", "/home/cmr-auto/Music"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
