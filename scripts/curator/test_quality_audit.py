#!/usr/bin/env python3
"""Testes das funções puras de quality_audit.py (sem ffmpeg).

python3 scripts/curator/test_quality_audit.py
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import quality_audit as qa  # noqa: E402

SR = 44_100


def noise(seconds: float = 6.0, sr: int = SR, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.standard_normal((int(seconds * sr), 2)).astype(np.float32) * 0.1


def brickwall(x: np.ndarray, cut_hz: float, sr: int = SR, floor: float = 0.0) -> np.ndarray:
    """Passa-baixa ideal por FFT (o que o MP3 faz, visto de longe) + piso opcional."""
    out = np.empty_like(x)
    for c in range(x.shape[1]):
        X = np.fft.rfft(x[:, c])
        f = np.fft.rfftfreq(x.shape[0], 1 / sr)
        X[f > cut_hz] = 0
        out[:, c] = np.fft.irfft(X, n=x.shape[0])
    if floor:
        out += np.random.default_rng(9).standard_normal(out.shape).astype(np.float32) * floor
    return out


def tilt(x: np.ndarray, db_per_khz: float, sr: int = SR) -> np.ndarray:
    """Queda suave (música real perde agudo aos poucos)."""
    out = np.empty_like(x)
    for c in range(x.shape[1]):
        X = np.fft.rfft(x[:, c])
        f = np.fft.rfftfreq(x.shape[0], 1 / sr)
        X *= 10 ** (-(db_per_khz * f / 1000) / 20)
        out[:, c] = np.fft.irfft(X, n=x.shape[0])
    return out


def cutoff_of(x: np.ndarray, sr: int = SR) -> dict:
    f, rel = qa.frame_spectra(x, sr)
    assert rel.shape[0] > 0
    return qa.find_cutoff(f, rel)


class FindCutoff(unittest.TestCase):
    def test_corte_em_16k_e_achado(self):
        r = cutoff_of(brickwall(noise(), 16_000, floor=1e-6))
        self.assertIsNotNone(r["cutoff_hz"])
        self.assertLess(abs(r["cutoff_hz"] - 16_000), 150, r)

    def test_corte_em_19k5_e_achado(self):
        r = cutoff_of(brickwall(noise(), 19_500, floor=1e-6))
        self.assertLess(abs(r["cutoff_hz"] - 19_500), 150, r)

    def test_banda_cheia_com_queda_suave_nao_tem_corte(self):
        r = cutoff_of(tilt(noise(), 2.0))  # 44 dB de 0 a 22 kHz, sem degrau
        self.assertIsNone(r["cutoff_hz"], r)

    def test_filtro_do_conversor_perto_de_nyquist_nao_conta(self):
        r = cutoff_of(brickwall(noise(), 21_600, floor=1e-6))
        self.assertEqual(qa.classify(SR, r["cutoff_hz"], False), "sem_corte", r)

    def test_hires_de_cd_tem_corte_em_22k(self):
        sr = 96_000
        r = cutoff_of(brickwall(noise(sr=sr), 22_000, sr=sr, floor=1e-6), sr)
        self.assertLess(abs(r["cutoff_hz"] - 22_000), 200, r)

    def test_saturacao_em_parte_dos_quadros_nao_apaga_o_corte(self):
        # MP3 de master no talo: o decodificador satura e os quadros saturados
        # espalham ruído largo acima do corte. A média perdia o degrau; a mediana não.
        # Agudo caindo como em música (1,5 dB/kHz), corte em 16 kHz, e 1 em cada 6
        # hops ceifado em ±1 com o sinal 8x acima disso (quadros têm 2 hops: ~1/3
        # dos quadros saturados).
        x = brickwall(tilt(noise(), 1.5), 16_000, floor=1e-6)
        x = x / np.abs(x).max() * 8
        hop = qa.fft_size(SR) // 2
        for k in range(0, len(x) // hop, 6):
            seg = x[k * hop:(k + 1) * hop]
            np.clip(seg, -1, 1, out=seg)
        r = cutoff_of(x)
        self.assertLess(abs(r["cutoff_hz"] - 16_000), 150, r)
        # o método antigo (média da potência linear) perde o degrau neste sinal
        f, rel = qa.frame_spectra(x, SR)
        antigo, _ = qa.find_cliff(f, 10 * np.log10(np.mean(10 ** (rel / 10), axis=0)))
        self.assertIsNone(antigo)

    def test_silencio_nao_entra_na_media(self):
        x = brickwall(noise(), 16_000, floor=1e-6)
        x[: len(x) // 2] = 0  # metade muda: espectro igual
        r = cutoff_of(x)
        self.assertLess(abs(r["cutoff_hz"] - 16_000), 150, r)


class Classify(unittest.TestCase):
    def test_classes_por_corte(self):
        self.assertEqual(qa.classify(SR, None, False), "sem_corte")
        self.assertEqual(qa.classify(SR, 16_000, False), "lossy")
        self.assertEqual(qa.classify(SR, 18_700, False), "lossy")
        self.assertEqual(qa.classify(SR, 20_100, False), "provavel_lossy")
        self.assertEqual(qa.classify(SR, 21_400, False), "sem_corte")  # filtro do conversor

    def test_declarado_vence(self):
        self.assertEqual(qa.classify(SR, 16_000, True), "lossy_declarado")

    def test_hires(self):
        self.assertEqual(qa.classify(96_000, 22_000, False), "hires_de_cd")
        self.assertEqual(qa.classify(48_000, 22_000, False), "sem_corte")
        self.assertEqual(qa.classify(96_000, 40_000, False), "sem_corte")
        self.assertEqual(qa.classify(96_000, None, False), "sem_corte")
        self.assertEqual(qa.classify(96_000, 16_000, False), "lossy")

    def test_fonte_pelas_tags(self):
        self.assertEqual(qa.source_hint({"comment": "source: tidal lossless; mix x"}), "tidal")
        self.assertEqual(qa.source_hint({"comment": "downloaded from lucida.to: https://soundcloud.com/a"}),
                         "lucida,soundcloud")


if __name__ == "__main__":
    unittest.main(verbosity=1)
