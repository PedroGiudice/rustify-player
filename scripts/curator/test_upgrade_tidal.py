#!/usr/bin/env python3
"""Testes das funções puras do upgrade_tidal (rodar: uv run --with tidalapi --with mutagen --with numpy python3 scripts/curator/test_upgrade_tidal.py)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from upgrade_tidal import isrcs, match_kind, outcome, same_origin, tag  # noqa: E402

OURS = {"title": "Rave da Chinesa (feat. Dj Jeffinho & Dj Ricardinho)", "artist": "Dj Jeffinho, Dj Pivete, Dj Ricardinho",
        "album_artist": "Various", "isrc": "QZNWU2001949", "dur_s": 104.5}


def cand(**kw):
    c = {"title": "Rave da Chinesa", "artists": ["Dj Pivete"], "album_artist": "Dj Pivete", "isrc": "", "dur_s": 105}
    c.update(kw)
    return c


class Match(unittest.TestCase):
    def test_isrc_igual_casa_mesmo_com_titulo_diferente(self):
        self.assertEqual(match_kind(OURS, cand(title="Rave Da China", isrc="qznwu2001949")), "isrc")

    def test_isrc_igual_com_duracao_muito_diferente_nao_e_isrc(self):
        self.assertIsNone(match_kind(OURS, cand(title="Outra", isrc="QZNWU2001949", dur_s=200)))

    def test_titulo_artista_e_duracao(self):
        self.assertEqual(match_kind(OURS, cand()), "titulo")

    def test_various_nao_conta_como_artista_em_comum(self):
        o = dict(OURS, artist="Various", album_artist="Various Artists", isrc="")
        self.assertIsNone(match_kind(o, cand(artists=["Various"], album_artist="Various")))

    def test_duracao_diferente_e_outra_versao(self):
        self.assertEqual(match_kind(OURS, cand(dur_s=140)), "outra_versao")

    def test_remix_distingue(self):
        self.assertIsNone(match_kind(OURS, cand(title="Rave da Chinesa (Remix)")))

    def test_varios_isrc_na_tag(self):
        o = dict(OURS, title="Stars (DJ Caio Prince & Adame DJ remix)", artist="PinkPantheress", isrc="GBAYE2501223;GBAYE2501380;GBAYE2501421", dur_s=167)
        self.assertEqual(isrcs(o["isrc"]), ["GBAYE2501223", "GBAYE2501380", "GBAYE2501421"])
        self.assertEqual(match_kind(o, cand(title="Stars + DJ Caio Prince + Adame DJ", artists=["PinkPantheress"], isrc="GBAYE2501421", dur_s=167)), "isrc")

    def test_artista_com_sufixo_ii(self):
        o = {"title": "Help Me", "artist": "Sonny Boy Williamson", "dur_s": 191}
        self.assertEqual(match_kind(o, cand(title="Help Me", artists=["Sonny Boy Williamson II"], album_artist="", dur_s=188)), "titulo")
        self.assertIsNone(match_kind({"title": "Help Me", "artist": "Anna", "dur_s": 191}, cand(title="Help Me", artists=["Annabel"], album_artist="", dur_s=191)))

    def test_original_mix_e_a_versao_padrao(self):
        o = {"title": "Hidden Beauties (original mix)", "artist": "ANNA", "dur_s": 436.4}
        self.assertEqual(match_kind(o, cand(title="Hidden Beauties", artists=["ANNA"], album_artist="", dur_s=436)), "titulo")
        self.assertIsNone(match_kind(o, cand(title="Hidden Beauties (Radio Edit)", artists=["ANNA"], album_artist="", dur_s=436)))

    def test_mesmo_mc_com_outro_dj_nao_e_a_mesma_gravacao(self):
        o = {"title": "Meu Carro Nao Tem Porta Luva (Remastered 2024)", "artist": "DJ NATAN 22, MC Rodrigo do CN, DJ DN do Dick", "dur_s": 160}
        self.assertIsNone(match_kind(o, cand(title="Meu carro não tem porta luva", artists=["Dj Mathy 044", "MC Rodrigo do CN", "MIDNIGHT PM"], album_artist="Dj Mathy 044", dur_s=157)))
        self.assertEqual(match_kind({"title": "Bruxaria do Beco da Morte", "artist": "MAC10TA", "dur_s": 100},
                                    cand(title="Bruxaria do Beco da Morte", artists=["MC GW", "MAC10TA"], album_artist="MC GW", dur_s=100)), "titulo")

    def test_artista_sem_relacao(self):
        self.assertIsNone(match_kind(OURS, cand(artists=["MC Fulano"], album_artist="MC Fulano")))


class Origem(unittest.TestCase):
    def test_mesma_origem_so_quando_veio_da_tidal_e_mesmo_lancamento(self):
        o = {"comment": "source: tidal lossless; mix abc", "album": "Baile Da China", "track_number": 17}
        self.assertTrue(same_origin(o, {"album": "Baile da China", "track_num": 17}))
        self.assertFalse(same_origin(o, {"album": "Baile da China (Deluxe)", "track_num": 17}))
        self.assertFalse(same_origin(dict(o, comment=""), {"album": "Baile Da China", "track_num": 17}))
        sem_comment = {"comment": "", "rel": "Funk Brasileiro/DJ K/Panico no Submundo [tidal]/02 X.flac", "album": "Panico no Submundo", "track_number": 2}
        self.assertTrue(same_origin(sem_comment, {"album": "PANICO NO SUBMUNDO", "track_num": 2}))


class Resultado(unittest.TestCase):
    def test_classes(self):
        a, b = {"id": 1, "kind": "isrc", "same_origin": False}, {"id": 2, "kind": "titulo", "same_origin": False}
        self.assertEqual(outcome([], {}), "nao_encontrada")
        self.assertEqual(outcome([{"id": 9, "kind": "outra_versao"}], {}), "nao_encontrada")
        self.assertEqual(outcome([dict(a, same_origin=True)], {}), "so_mesma_origem")
        self.assertEqual(outcome([a, b], {1: {"class": "lossy"}, 2: {"class": "sem_corte"}}), "limpa")
        self.assertEqual(outcome([a, b], {1: {"class": "lossy"}, 2: {"class": "provavel_lossy"}}), "lossy")
        self.assertEqual(outcome([a, b], {1: {"class": "lossy"}}), "lossy")
        self.assertEqual(outcome([a], {}), "nao_medida")
        self.assertEqual(outcome([a], {1: {"class": "hires_de_cd"}}), "limpa")

    def test_tag_sem_caixa(self):
        self.assertEqual(tag({"ARTIST": " X "}, "artist"), "X")
        self.assertEqual(tag({"album_artist": "Y"}, "albumartist", "album_artist"), "Y")
        self.assertEqual(tag({}, "isrc"), "")


if __name__ == "__main__":
    unittest.main()
