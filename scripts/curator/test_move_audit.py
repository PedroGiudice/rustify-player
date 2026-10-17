#!/usr/bin/env python3
"""Testes das funções puras de move_audit.py. Rodar: python3 scripts/curator/test_move_audit.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import move_audit as m  # noqa: E402

R = m.ROOT


class CaminhoEsperado(unittest.TestCase):
    def test_troca_so_a_playlist(self):
        self.assertEqual(m.expected_path(R + "Funk Brasileiro/MC X/2020 - Álbum/01 Faixa.flac", "Funk Carioca"),
                         R + "Funk Carioca/MC X/2020 - Álbum/01 Faixa.flac")

    def test_pasta_tidal_preservada(self):
        p = R + "Rap/Kendrick Lamar/2022 - Mr. Morale [tidal]/03 N95.flac"
        self.assertEqual(m.expected_path(p, "Hip Hop"), R + "Hip Hop/Kendrick Lamar/2022 - Mr. Morale [tidal]/03 N95.flac")

    def test_acentos_e_destino_com_espaco(self):
        p = R + "MPB/Elis Regina/1995 - Elis ao Vivo/0915 - Cadeira Vazia.flac"
        self.assertEqual(m.expected_path(p, "Música Brasileira [x]"),
                         R + "Música Brasileira [x]/Elis Regina/1995 - Elis ao Vivo/0915 - Cadeira Vazia.flac")

    def test_sem_marca_tidal_mesma_playlist(self):
        # `--dest :sem-tidal` confere o `lib_unmark_tidal` (17/10/2026): só a pasta do álbum perde a marca.
        p = R + "Funk Brasileiro/DJ K/Panico no Submundo [tidal]/02 Puta de Silicone.flac"
        self.assertEqual(m.expected_path(p, m.UNMARK_TIDAL), R + "Funk Brasileiro/DJ K/Panico no Submundo/02 Puta de Silicone.flac")
        self.assertEqual(m.expected_path(R + "Jazz/A/B [tidal]/CD2/01 Live [tidal].lrc", m.UNMARK_TIDAL),
                         R + "Jazz/A/B/CD2/01 Live [tidal].lrc")

    def test_nome_da_playlist_repetido_no_resto_nao_e_trocado(self):
        p = R + "Rock/Rock/Rock/01 Rock.flac"
        self.assertEqual(m.expected_path(p, "Pop"), R + "Pop/Rock/Rock/01 Rock.flac")

    def test_fora_da_raiz_ou_sem_pasta(self):
        with self.assertRaises(ValueError):
            m.expected_path("/tmp/a.flac", "X")
        with self.assertRaises(ValueError):
            m.expected_path(R + "so.flac", "X")

    def test_playlist_e_lrc(self):
        self.assertEqual(m.playlist_of(R + "A/B/c.flac"), "A")
        self.assertEqual(m.lrc_sibling(R + "A/B/c.d.flac"), R + "A/B/c.d.lrc")


class Vetores(unittest.TestCase):
    def test_resumo_e_igualdade(self):
        v = [0.1, 0.2, 0.3, 0.4, 0.5]
        s = m.vec_summary(v)
        self.assertEqual(s["dim"], 5)
        self.assertTrue(m.vec_equal(s, m.vec_summary(list(v))))
        w = list(v)
        w[4] += 0.01
        self.assertFalse(m.vec_equal(s, m.vec_summary(w)))
        self.assertFalse(m.vec_equal(s, m.vec_summary(v[:4])))


class Enrichment(unittest.TestCase):
    def test_igual(self):
        self.assertEqual(m.compare_enrichment({"a": 1, "liked_at": 5}, {"a": 1, "liked_at": 5}), ([], []))

    def test_like_perdido_e_dura(self):
        hard, soft = m.compare_enrichment({"liked_at": 5, "energy": 0.3}, {"energy": 0.3})
        self.assertEqual(len(hard), 1)
        self.assertIn("liked_at", hard[0])
        self.assertEqual(soft, [])

    def test_play_count_e_mole(self):
        hard, soft = m.compare_enrichment({"play_count": 3}, {"play_count": 4})
        self.assertEqual(hard, [])
        self.assertEqual(len(soft), 1)

    def test_listas_comparadas_em_ordem(self):
        hard, _ = m.compare_enrichment({"mood_tags": ["a", "b"]}, {"mood_tags": ["b", "a"]})
        self.assertEqual(len(hard), 1)


def rec(**kw):
    base = {"path": R + "Rap/A/B/01 x.flac", "title": "x", "artist": "A", "album_title": "B", "lrc_path": R + "Rap/A/B/01 x.lrc",
            "lyrics_text_len": 100, "lyrics_status": "synced", "vectors": {"mert": m.vec_summary([1.0, 2.0]), "lyrics": m.vec_summary([3.0])},
            "enrichment": {"liked_at": 9, "energy": 0.5}, "plays": 4, "lrc_on_disk": True}
    base.update(kw)
    return base


def novo(**kw):
    base = {"point": {"payload": {"title": "x", "artist": "A", "album_title": "B", "lrc_path": R + "Pop/A/B/01 x.lrc",
                                  "lyrics_status": "synced"}},
            "vectors": {"mert": m.vec_summary([1.0, 2.0]), "lyrics": m.vec_summary([3.0])},
            "enrich": {"liked_at": 9, "energy": 0.5}, "plays": 4, "lyrics_len": 100}
    base.update(kw)
    return base


DISK_OK = {"old_flac": False, "new_flac": True, "old_lrc": False, "new_lrc": True}


class Veredito(unittest.TestCase):
    def test_tudo_certo(self):
        self.assertEqual(m.verdict(rec(), "Pop", novo(), False, DISK_OK), ([], []))

    def test_ponto_novo_ausente_e_antigo_vivo(self):
        f, _ = m.verdict(rec(), "Pop", None, True, DISK_OK)
        self.assertEqual(len(f), 2)

    def test_vetor_e_plays(self):
        n = novo(vectors={"mert": m.vec_summary([9.0, 2.0])}, plays=3)
        f, _ = m.verdict(rec(), "Pop", n, False, DISK_OK)
        txt = " | ".join(f)
        self.assertIn("vetores presentes", txt)
        self.assertIn("plays no id novo", txt)

    def test_vetor_diferente_com_mesmos_nomes(self):
        n = novo(vectors={"mert": m.vec_summary([9.0, 2.0]), "lyrics": m.vec_summary([3.0])})
        f, _ = m.verdict(rec(), "Pop", n, False, DISK_OK)
        self.assertEqual(f, ["vetor mert diferente"])

    def test_plays_a_mais_no_novo_ok_e_aviso_de_play_count(self):
        r = rec(enrichment={"liked_at": 9, "energy": 0.5, "play_count": 1})
        n = novo(plays=6, enrich={"liked_at": 9, "energy": 0.5, "play_count": 2})
        f, w = m.verdict(r, "Pop", n, False, DISK_OK)
        self.assertEqual(f, [])
        self.assertEqual(len(w), 1)

    def test_plays_restantes_no_id_antigo(self):
        f, _ = m.verdict(rec(plays_old_now=2), "Pop", novo(), False, DISK_OK)
        self.assertEqual(len(f), 1)

    def test_letra(self):
        n = novo(lyrics_len=0)
        n["point"]["payload"]["lyrics_status"] = "none"
        f, _ = m.verdict(rec(), "Pop", n, False, DISK_OK)
        self.assertEqual(len(f), 2)

    def test_disco(self):
        f, _ = m.verdict(rec(), "Pop", novo(), False, {"old_flac": True, "new_flac": False, "old_lrc": True, "new_lrc": False})
        self.assertEqual(len(f), 4)

    def test_sem_lrc_no_disco_nao_exige(self):
        r = rec(lrc_on_disk=False, lrc_path=None)
        f, _ = m.verdict(r, "Pop", novo(), False, {**DISK_OK, "new_lrc": False})
        self.assertEqual(f, [])

    def test_lrc_path_errado(self):
        n = novo()
        n["point"]["payload"]["lrc_path"] = R + "Rap/A/B/01 x.lrc"
        f, _ = m.verdict(rec(), "Pop", n, False, DISK_OK)
        self.assertEqual(len(f), 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
