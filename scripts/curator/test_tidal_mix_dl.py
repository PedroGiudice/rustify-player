#!/usr/bin/env python3
"""Testes das funções puras do tidal_mix_dl (rodar: uv run --with tidalapi --with mutagen python3 scripts/curator/test_tidal_mix_dl.py)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pathlib import Path

from tidal_mix_dl import CMR_SSH, LRC_TS, MAX_IDS, TUNNEL_PORT, comment_for, parse_ids, parse_ref, sidecar_for, vm_defaults  # noqa: E402


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


class Referencia(unittest.TestCase):
    def test_links(self):
        self.assertEqual(parse_ref("https://tidal.com/browse/mix/0001b809ea81351041184b7589d612"), ("mix", "0001b809ea81351041184b7589d612"))
        self.assertEqual(parse_ref("https://tidal.com/album/135615427"), ("album", "135615427"))
        self.assertEqual(parse_ref("https://tidal.com/browse/album/135615427/track/135615431?u"), ("track", "135615431"))
        self.assertEqual(parse_ref("https://listen.tidal.com/playlist/2fee16d8-2d83-4d07-acd1-64a83ebff23e"),
                         ("playlist", "2fee16d8-2d83-4d07-acd1-64a83ebff23e"))

    def test_forma_curta_da_fila(self):
        self.assertEqual(parse_ref("mix:abc123"), ("mix", "abc123"))
        self.assertEqual(parse_ref("album:42"), ("album", "42"))
        self.assertEqual(parse_ref("faixa:7"), ("track", "7"))
        self.assertEqual(parse_ref("radio-faixa:7"), ("radio-track", "7"))
        self.assertEqual(parse_ref("playlist:2fee16d8-2d83-4d07-acd1-64a83ebff23e")[0], "playlist")

    def test_ids_crus_seguem_valendo(self):
        self.assertEqual(parse_ref("2fee16d8-2d83-4d07-acd1-64a83ebff23e")[0], "playlist")
        self.assertEqual(parse_ref("0001b809ea81351041184b7589d612"), ("mix", "0001b809ea81351041184b7589d612"))
        self.assertEqual(parse_ref("135615427"), ("album", "135615427"))

    def test_recusa_lixo(self):
        for bad in ("", "orochi", "album:abc", "radio-faixa:x1", "playlist:nao-e-uuid", "https://soundcloud.com/x"):
            with self.assertRaises(ValueError, msg=bad):
                parse_ref(bad)


class Selecao(unittest.TestCase):
    def test_ids_em_ordem_sem_repetir(self):
        self.assertEqual(parse_ids("3, 1,3,,2"), [3, 1, 2])

    def test_ids_invalidos(self):
        for bad in ("", " , ", "1,a", "-1", "1.5"):
            with self.assertRaises(ValueError, msg=bad):
                parse_ids(bad)

    def test_teto_de_ids(self):
        self.assertEqual(len(parse_ids(",".join(str(i) for i in range(1, MAX_IDS + 1)))), MAX_IDS)
        with self.assertRaises(ValueError):
            parse_ids(",".join(str(i) for i in range(1, MAX_IDS + 2)))

    def test_comment(self):
        self.assertEqual(comment_for("HI_RES_LOSSLESS", "https://tidal.com/mix/x", None), "source: tidal hi_res_lossless; mix https://tidal.com/mix/x")
        self.assertEqual(comment_for("LOSSLESS", None, "mix:abc"), "source: tidal lossless; selecao mix:abc")
        self.assertEqual(comment_for("LOSSLESS", None, None), "source: tidal lossless; selecao manual")


if __name__ == "__main__":
    unittest.main()
