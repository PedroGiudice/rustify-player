#!/usr/bin/env python3
"""Testes das funções puras do tidal_mix_dl (rodar: uv run --with tidalapi --with mutagen python3 scripts/curator/test_tidal_mix_dl.py)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pathlib import Path

from tidal_mix_dl import CMR_SSH, LRC_TS, TUNNEL_PORT, sidecar_for, vm_defaults  # noqa: E402


class VmDefaults(unittest.TestCase):
    def test_na_vm_envio_e_o_padrao(self):
        d = vm_defaults("extractlab", {})
        self.assertTrue(d["on_vm"])
        self.assertEqual(d["music"], "~/tidal-out")
        self.assertEqual(d["qdrant"], f"http://127.0.0.1:{TUNNEL_PORT}")
        self.assertEqual(d["push"], f"{CMR_SSH}:Music")

    def test_na_cmr_auto_acervo_local_sem_envio(self):
        d = vm_defaults("cmrlinuxmachine", {})
        self.assertFalse(d["on_vm"])
        self.assertEqual(d["music"], "~/Music")
        self.assertEqual(d["qdrant"], "http://127.0.0.1:6333")
        self.assertEqual(d["push"], "")

    def test_env_sobrepoe(self):
        d = vm_defaults("extractlab", {"TIDAL_MUSIC_ROOT": "/x", "TIDAL_QDRANT": "http://q:1", "TIDAL_PUSH": "h:dir"})
        self.assertEqual((d["music"], d["qdrant"], d["push"]), ("/x", "http://q:1", "h:dir"))

    def test_tidal_push_off_desliga(self):
        for v in ("off", "OFF", "0", "no", "none"):
            self.assertEqual(vm_defaults("extractlab", {"TIDAL_PUSH": v})["push"], "", v)


class Letra(unittest.TestCase):
    def test_sidecar_ao_lado_do_flac(self):
        self.assertEqual(sidecar_for(Path("/m/Jazz/A/B [tidal]/06 Peace Piece.flac")), Path("/m/Jazz/A/B [tidal]/06 Peace Piece.lrc"))

    def test_so_letra_com_timestamp_conta_como_sincronizada(self):
        self.assertTrue(LRC_TS.search("[00:12.30] primeira linha"))
        self.assertFalse(LRC_TS.search("primeira linha sem tempo"))


if __name__ == "__main__":
    unittest.main()
