#!/usr/bin/env python3
"""Testes da decisão pura do portão (lossless_gate.refusal_reason).

    uv run --with numpy python3 scripts/curator/test_lossless_gate.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lossless_gate import refusal_reason  # noqa: E402


class Portao(unittest.TestCase):
    def test_lossless_de_cd_entra(self):
        self.assertIsNone(refusal_reason({"sr": 44100, "bits": 16, "cutoff_hz": None}))
        self.assertIsNone(refusal_reason({"sr": 96000, "bits": 24, "cutoff_hz": 21879}))  # upsample de CD entra

    def test_corte_de_lossy_recusa(self):
        self.assertEqual(refusal_reason({"sr": 44100, "bits": 16, "cutoff_hz": 16075}), "lossy por dentro, corte 16,1 kHz")

    def test_abaixo_de_cd_recusa_mesmo_sem_corte(self):
        # Nyquist de 11 kHz: o detector não acha corte, o piso 16/44 do CEO recusa pelo cabeçalho
        self.assertEqual(refusal_reason({"sr": 22050, "bits": 16, "cutoff_hz": None}), "abaixo de CD (22,05 kHz)")
        self.assertEqual(refusal_reason({"sr": 44100, "bits": 8, "cutoff_hz": None}), "abaixo de CD (8 bit)")


class Dependencia(unittest.TestCase):
    def test_sem_numpy_require_derruba(self):
        # A fila chama o baixador por subprocess: sem numpy ele tem que cair no
        # início (job "falhou"), não baixar tudo e marcar cada faixa como falha.
        import subprocess
        code = ("import sys; sys.modules['numpy'] = None; sys.path.insert(0, %r); "
                "import lossless_gate; lossless_gate.require()") % str(Path(__file__).parent)
        r = subprocess.run([sys.executable, "-c", code], capture_output=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertRegex(r.stderr, rb"(ModuleNotFound|Import)Error: import of numpy", r.stderr[-300:])


if __name__ == "__main__":
    unittest.main(verbosity=1)
