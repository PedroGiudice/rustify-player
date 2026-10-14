#!/usr/bin/env python3
"""Testes da API da fila da Tidal sem rede (rodar: uv run --with tidalapi --with mutagen python3 scripts/curator/test_tidal_fila.py).
A sessão da Tidal é trocada por objetos falsos; nenhum teste fala com a Tidal nem com a cmr-auto."""
import datetime as dt
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tidal_fila as tf  # noqa: E402


# Objetos falsos com o MESMO nome de classe do tidalapi (a fila decide o tipo pelo nome).
class Artist:
    def __init__(self, id, name):
        self.id, self.name = id, name

    def image(self, size):
        return f"https://resources.tidal.com/images/a{self.id}/{size}x{size}.jpg"


class Album:
    def __init__(self, id, name, artist, year=2020, tags=("LOSSLESS",), type="ALBUM"):
        self.id, self.name, self.artist = id, name, artist
        self.release_date = dt.datetime(year, 1, 1)
        self.media_metadata_tags = list(tags)
        self.num_tracks, self.duration, self.type = 10, 2400, type

    def image(self, size):
        return f"https://resources.tidal.com/images/b{self.id}/{size}x{size}.jpg"


class Track:
    def __init__(self, id, name, album, artists, duration=180, version=None, tags=("LOSSLESS",)):
        self.id, self.name, self.album, self.artists = id, name, album, artists
        self.artist = artists[0]
        self.duration, self.version, self.media_metadata_tags = duration, version, list(tags)


class Video:
    id, name = 1, "clipe"


class Playlist:
    def __init__(self, id, name):
        self.id, self.name, self.num_tracks, self.duration, self.creator = id, name, 35, 7860, None

    def image(self, size):
        return "https://resources.tidal.com/images/p/320x320.jpg"


OROCHI = Artist(4568627, "Orochi")
CELEB = Album(135615427, "Celebridade", OROCHI, tags=("LOSSLESS", "HIRES_LOSSLESS"))
MITSU = Track(135615431, "Mitsubishi", CELEB, [OROCHI])
UUID = "2fee16d8-2d83-4d07-acd1-64a83ebff23e"


class FakeSession:
    def __init__(self):
        self.calls = 0

    def search(self, q, limit=10):
        self.calls += 1
        return {"artists": [OROCHI], "albums": [CELEB], "tracks": [MITSU, Track(2, "Faixa", CELEB, [OROCHI], version="Remastered")],
                "videos": [Video()], "playlists": [Playlist(UUID, "Rio de Janeiro Hip-Hop")], "top_hit": OROCHI}


class Base(unittest.TestCase):
    def setUp(self):
        tf.CACHE.clear()
        tf.SESS["s"] = None
        self._orig = tf.tidal_session

    def tearDown(self):
        tf.tidal_session = self._orig
        tf.CACHE.clear()


class Busca(Base):
    def test_texto_curto_e_400_sem_tocar_na_tidal(self):
        def nao_chama():
            raise AssertionError("não devia abrir sessão")
        tf.tidal_session = nao_chama
        for q in ("", "a", "  b  "):
            code, body = tf.api_get("busca", {"q": [q]})
            self.assertEqual(code, 400, q)
            self.assertIn("2 caracteres", body["error"])
        self.assertEqual(tf.api_get("busca", {})[0], 400)

    def test_sessao_invalida_e_503(self):
        def expirada():
            raise tf.TidalErro(503, tf.SESSAO_EXPIRADA)
        tf.tidal_session = expirada
        self.assertEqual(tf.api_get("busca", {"q": ["orochi"]}), (503, {"error": "sessão da Tidal expirada"}))

    def test_autenticacao_recusada_no_meio_vira_503_e_descarta_a_sessao(self):
        class AuthenticationError(Exception):
            pass

        class S:
            def search(self, q, limit=10):
                raise AuthenticationError("401")
        tf.SESS["s"] = S()
        tf.tidal_session = lambda: tf.SESS["s"]
        code, body = tf.api_get("busca", {"q": ["orochi"]})
        self.assertEqual((code, body["error"]), (503, tf.SESSAO_EXPIRADA))
        self.assertIsNone(tf.SESS["s"])

    def test_erro_de_rede_vira_502(self):
        class ConnectionError(Exception):
            pass

        class S:
            def search(self, q, limit=10):
                raise ConnectionError("x")
        tf.tidal_session = lambda: S()
        code, body = tf.api_get("busca", {"q": ["orochi"]})
        self.assertEqual(code, 502)
        self.assertIn("Tidal sem resposta", body["error"])

    def test_formato_da_resposta_e_cache(self):
        fake = FakeSession()
        tf.tidal_session = lambda: fake
        code, r = tf.api_get("busca", {"q": ["Orochi"]})
        self.assertEqual(code, 200)
        self.assertEqual(r["top"], {"tipo": "artista", "id": "4568627"})
        self.assertEqual(len(r["faixas"]), 2)
        f = r["faixas"][0]
        self.assertEqual(f, {"id": 135615431, "titulo": "Mitsubishi", "artistas": ["Orochi"], "album": "Celebridade",
                             "album_id": 135615427, "ano": 2020, "duracao_s": 180, "hires": False,
                             "capa": "https://resources.tidal.com/images/b135615427/320x320.jpg",
                             "url": "https://tidal.com/browse/track/135615431"})
        self.assertEqual(r["faixas"][1]["titulo"], "Faixa (Remastered)")
        self.assertTrue(r["albuns"][0]["hires"])
        self.assertEqual(r["albuns"][0]["tipo"], "album")
        self.assertEqual(r["playlists"][0]["id"], UUID)
        self.assertEqual(r["artistas"][0]["nome"], "Orochi")
        self.assertNotIn("videos", r)
        tf.api_get("busca", {"q": ["orochi "]})  # mesma chave (minúsculas, espaço aparado): vem do cache
        self.assertEqual(fake.calls, 1)
        json.dumps(r)  # serializável


class Previa(Base):
    def test_ref_invalida_e_400(self):
        tf.tidal_session = lambda: (_ for _ in ()).throw(AssertionError("não devia abrir sessão"))
        for ref in ("", "orochi", "album:abc", "faixa:", "playlist:123", "artist:1", "https://soundcloud.com/x"):
            code, body = tf.api_get("previa", {"ref": [ref]})
            self.assertEqual(code, 400, ref)
            self.assertTrue(body["error"])

    def test_ref_canonica(self):
        self.assertEqual(tf.ref_da_previa("mix:0001b809ea81351041184b7589d612"), "mix:0001b809ea81351041184b7589d612")
        self.assertEqual(tf.ref_da_previa("https://tidal.com/browse/album/135615427"), "album:135615427")
        self.assertEqual(tf.ref_da_previa("https://tidal.com/browse/album/1/track/135615431"), "faixa:135615431")
        self.assertEqual(tf.ref_da_previa("https://tidal.com/track/9"), "faixa:9")
        self.assertEqual(tf.ref_da_previa(f"https://listen.tidal.com/playlist/{UUID}"), f"playlist:{UUID}")
        self.assertEqual(tf.ref_da_previa("radio-faixa:42"), "radio-faixa:42")

    def test_previa_de_radio_de_faixa(self):
        class Mix:
            mix_type = "TRACK_MIX"

            def items(self):
                return [MITSU, Video(), Track(3, "Outra", CELEB, [OROCHI], duration=200)]

        class T(Track):
            def get_radio_mix(self):
                return Mix()

        class S:
            def track(self, i):
                return T(i, "Mitsubishi", CELEB, [OROCHI])
        tf.tidal_session = lambda: S()
        code, r = tf.api_get("previa", {"ref": ["radio-faixa:135615431"]})
        self.assertEqual(code, 200)
        self.assertEqual((r["tipo"], r["titulo"], r["ref"]), ("radio", "Rádio de Mitsubishi", "radio-faixa:135615431"))
        self.assertEqual([f["id"] for f in r["faixas"]], [135615431, 3])
        self.assertEqual(r["duracao_s"], 380)

    def test_mix_de_artista_vira_radio_pelo_valor_do_enum(self):
        class MixType:  # str() do enum real é "MixType.artist"; o valor é que diz ARTIST_MIX
            value = "ARTIST_MIX"

            def __str__(self):
                return "MixType.artist"

        class Mix:
            mix_type, title = MixType(), "Orochi"

            def items(self):
                return [MITSU]

        class S:
            def mix(self, i):
                return Mix()
        tf.tidal_session = lambda: S()
        code, r = tf.api_get("previa", {"ref": ["mix:abc123"]})
        self.assertEqual((code, r["tipo"], r["titulo"]), (200, "radio", "Rádio de Orochi"))

    def test_artista_id_invalido(self):
        self.assertEqual(tf.api_get("artista/abc", {})[0], 400)
        self.assertEqual(tf.api_get("nada", {})[0], 404)


class Selecao(unittest.TestCase):
    def test_valida(self):
        err, sel = tf.valida_selecao({"faixas": [3, "1", 3], "titulo": "  Rádio   Orochi ", "origem": "mix:abc<>", "playlist": "Rap"})
        self.assertIsNone(err)
        self.assertEqual(sel, {"faixas": [3, 1], "titulo": "Rádio Orochi", "origem": "mix:abc", "playlist": "Rap"})

    def test_recusa(self):
        casos = [{}, {"faixas": []}, {"faixas": "1,2", "playlist": "x"}, {"faixas": [1, "a"], "playlist": "x"},
                 {"faixas": [True], "playlist": "x"}, {"faixas": [0], "playlist": "x"}, {"faixas": [1], "playlist": "  "},
                 {"faixas": list(range(1, tf.MAX_FAIXAS + 2)), "playlist": "x"}]
        for c in casos:
            err, sel = tf.valida_selecao(c)
            self.assertTrue(err, c)
            self.assertIsNone(sel)
        self.assertIsNone(tf.valida_selecao({"faixas": list(range(1, tf.MAX_FAIXAS + 1)), "playlist": "x"})[0])

    def test_padroes(self):
        _, sel = tf.valida_selecao({"faixas": [1], "playlist": "Jazz"})
        self.assertEqual((sel["titulo"], sel["origem"]), ("Seleção", "busca"))

    def test_link_da_origem(self):
        self.assertEqual(tf.link_da_origem("mix:abc"), "https://tidal.com/browse/mix/abc")
        self.assertEqual(tf.link_da_origem("radio-faixa:7"), "https://tidal.com/browse/track/7")
        self.assertEqual(tf.link_da_origem("busca"), "")

    def test_alvo_do_job(self):
        self.assertEqual(tf.alvo_do_job({"url": "https://tidal.com/mix/a"}), ["https://tidal.com/mix/a"])
        self.assertEqual(tf.alvo_do_job({"url": "", "faixas": [1, 2], "titulo": "T", "origem": "mix:a"}),
                         ["--ids", "1,2", "--titulo", "T", "--origem", "mix:a"])

    def test_post_de_selecao_grava_job_e_api_esconde_ids(self):
        with tempfile.TemporaryDirectory() as d:
            orig = (tf.FILA, tf.LOGS)
            tf.FILA, tf.LOGS = Path(d) / "fila.json", Path(d) / "logs"
            try:
                body = {"faixas": [5, 6], "titulo": "Rádio", "origem": "mix:abc", "playlist": "Rap"}
                code, r = tf.api_post_fila(body)
                self.assertEqual(code, 200, r)
                self.assertEqual(tf.api_post_fila(body), (400, {"error": "essa seleção já está na fila"}))
                code2, r2 = tf.api_post_fila({"faixas": [5], "playlist": "Rap"})
                self.assertEqual(code2, 200)
                self.assertNotEqual(r["id"], r2["id"])  # mesmo segundo, ids distintos
                job = tf.load_fila()[0]
                self.assertEqual((job["faixas"], job["url"], job["status"]), ([5, 6], "https://tidal.com/browse/mix/abc", "fila"))
                pub = tf.job_publico(job)
                self.assertNotIn("faixas", pub)
                self.assertNotIn("log", pub)
                self.assertEqual(pub["n_faixas"], 2)
                self.assertEqual(tf.api_post_fila({"url": "lixo", "playlist": "Rap"})[0], 400)
                self.assertEqual(tf.api_post_fila([1])[0], 400)
            finally:
                tf.FILA, tf.LOGS = orig


if __name__ == "__main__":
    unittest.main()
