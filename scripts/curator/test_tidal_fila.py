#!/usr/bin/env python3
"""Testes da API da fila da Tidal sem rede (rodar: uv run --with tidalapi --with mutagen --with numpy python3 scripts/curator/test_tidal_fila.py).
A sessão da Tidal é trocada por objetos falsos; nenhum teste fala com a Tidal nem com a cmr-auto."""
import datetime as dt
import json
import os
import sys
import tempfile
import threading
import time
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


class Concorrencia(Base):
    def test_lock_ocupado_devolve_503_sem_chamar_a_tidal(self):
        orig = tf.LOCK_TIMEOUT
        tf.LOCK_TIMEOUT = 0.05
        tf.tidal_session = lambda: (_ for _ in ()).throw(AssertionError("não devia abrir sessão"))
        tf.TIDAL_LOCK.acquire()  # uma conexão pendurada segurando a vez
        try:
            t0 = time.time()
            code, body = tf.api_get("busca", {"q": ["orochi"]})
            self.assertLess(time.time() - t0, 2)
        finally:
            tf.TIDAL_LOCK.release()
            tf.LOCK_TIMEOUT = orig
        self.assertEqual((code, body["error"]), (503, "Tidal ocupada, tente de novo"))
        self.assertFalse(tf.TIDAL_LOCK.locked())

    def test_lock_e_liberado_depois_de_erro(self):
        class S:
            def search(self, q, limit=10):
                raise RuntimeError("x")
        tf.tidal_session = lambda: S()
        self.assertEqual(tf.api_get("busca", {"q": ["orochi"]})[0], 502)
        self.assertFalse(tf.TIDAL_LOCK.locked())

    def test_duas_buscas_iguais_ao_mesmo_tempo_vao_uma_vez_a_tidal(self):
        class Lenta(FakeSession):
            def search(self, q, limit=10):
                time.sleep(0.2)
                return super().search(q, limit)
        fake = Lenta()
        tf.tidal_session = lambda: fake
        out = []
        ths = [threading.Thread(target=lambda: out.append(tf.api_get("busca", {"q": ["orochi"]})[0])) for _ in range(2)]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        self.assertEqual(out, [200, 200])
        self.assertEqual(fake.calls, 1)

    def test_limpeza_do_cache_com_lock_proprio(self):
        tf.CACHE.clear()
        velho = time.time() - tf.CACHE_TTL - 1
        for i in range(501):
            tf.CACHE[("k", i)] = (velho, i)
        tf._cache_put(("novo",), 1)
        self.assertEqual(list(tf.CACHE), [("novo",)])

    def test_timeout_de_rede_em_toda_chamada_da_sessao(self):
        class RS:
            def __init__(self):
                self.visto = None

            def request(self, method, url, **kw):
                self.visto = kw
                return "ok"

        class S:
            request_session = RS()
        s = tf.aplica_timeout(S())
        self.assertEqual(s.request_session.request("GET", "u", params={}), "ok")
        self.assertEqual(s.request_session.visto["timeout"], (5, 7))
        s.request_session.request("GET", "u", timeout=1)  # quem passa o próprio timeout mantém o dele
        self.assertEqual(s.request_session.visto["timeout"], 1)


class Login(Base):
    def sessao(self, resp):
        class R:
            def __init__(self, ok, code):
                self.ok, self.status_code = ok, code

        class Req:
            def basic_request(_, m, path):
                if isinstance(resp, Exception):
                    raise resp
                return R(resp == 200, resp)

        class U:
            id = 7

        class S:
            request, user = Req(), U()
        return S()

    def test_rede_e_502_e_login_recusado_e_503(self):
        tf.confere_login(self.sessao(200))
        for exc in (ConnectionError("x"), TimeoutError("y")):
            with self.assertRaises(tf.TidalErro) as c:
                tf.confere_login(self.sessao(exc))
            self.assertEqual(c.exception.code, 502)
            self.assertIn("Tidal sem resposta", c.exception.msg)
        with self.assertRaises(tf.TidalErro) as c:
            tf.confere_login(self.sessao(503))  # servidor fora do ar: não é sessão expirada
        self.assertEqual(c.exception.code, 502)
        for code in (401, 403):
            with self.assertRaises(tf.TidalErro) as c:
                tf.confere_login(self.sessao(code))
            self.assertEqual((c.exception.code, c.exception.msg), (503, tf.SESSAO_EXPIRADA))


class NomesNulos(Base):
    def test_nome_nulo_da_tidal_nao_derruba_a_resposta(self):
        sem_nome = Artist(9, None)
        alb = Album(5, None, sem_nome)
        f = tf.faixa_json(Track(1, None, alb, [sem_nome]))
        self.assertEqual((f["titulo"], f["album"], f["artistas"]), ("", "", []))
        self.assertEqual(tf.album_json(alb)["titulo"], "")
        self.assertEqual(tf.artista_json(sem_nome)["nome"], "")
        self.assertEqual(tf.playlist_json(Playlist(UUID, None))["titulo"], "")
        json.dumps([f, tf.album_json(alb)])


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
        for ruim in ("²", "١٢٣", "1" * 20):
            self.assertEqual(tf.api_get(f"artista/{ruim}", {})[0], 400, ruim)
        for ruim in ("album:²", "album:" + "1" * 20, "faixa:١٢٣"):
            self.assertEqual(tf.api_get("previa", {"ref": [ruim]})[0], 400, ruim)
        self.assertEqual(tf.api_get("nada", {})[0], 404)


class Selecao(unittest.TestCase):
    def test_valida(self):
        err, sel = tf.valida_selecao({"faixas": [3, "1", 3], "titulo": "  Rádio   Orochi ", "origem": "mix:abc<>", "playlist": "Rap"})
        self.assertIsNone(err)
        self.assertEqual(sel, {"faixas": [3, 1], "titulo": "Rádio Orochi", "origem": "mix:abc", "playlist": "Rap"})

    def test_recusa(self):
        casos = [{}, {"faixas": []}, {"faixas": "1,2", "playlist": "x"}, {"faixas": [1, "a"], "playlist": "x"},
                 {"faixas": [True], "playlist": "x"}, {"faixas": [0], "playlist": "x"}, {"faixas": [1], "playlist": "  "},
                 {"faixas": list(range(1, tf.MAX_FAIXAS + 2)), "playlist": "x"},
                 {"faixas": ["²"], "playlist": "x"}, {"faixas": ["١٢٣"], "playlist": "x"},
                 {"faixas": [10 ** 19], "playlist": "x"}, {"faixas": ["1" * 20], "playlist": "x"}]
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
                         ["--ids=1,2", "--titulo=T", "--origem=mix:a"])
        # valor que começa com "-" vai colado ao nome da opção (o argparse não o toma por outra opção)
        self.assertEqual(tf.alvo_do_job({"url": "", "faixas": [1], "titulo": "-x", "origem": "--y"}),
                         ["--ids=1", "--titulo=-x", "--origem=--y"])

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


class FilaEmDisco(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.orig = (tf.FILA, tf.LOGS)
        tf.FILA, tf.LOGS = Path(self.d.name) / "fila.json", Path(self.d.name) / "logs"

    def tearDown(self):
        tf.FILA, tf.LOGS = self.orig
        self.d.cleanup()

    def test_post_de_link_devolve_o_id_do_proprio_job(self):
        code, r = tf.api_post_fila({"url": "https://tidal.com/browse/mix/abc", "playlist": "Rap"})
        self.assertEqual(code, 200)
        # outro pedido entra logo depois: o id devolvido continua sendo o do primeiro
        code2, r2 = tf.api_post_fila({"faixas": [1], "playlist": "Rap"})
        self.assertNotEqual(r["id"], r2["id"])
        self.assertEqual(tf.load_fila()[0]["id"], r["id"])
        self.assertEqual(tf.enfileira("https://tidal.com/browse/mix/abc", "Rap"), ("esse link já está na fila", None))
        self.assertEqual(tf.enfileira("lixo", "Rap")[1], None)

    def _log(self, texto):
        p = Path(self.d.name) / "job.log"
        p.write_text(texto, encoding="utf-8")
        return p

    def test_resumo_mostra_recusadas_lossy(self):
        log = self._log("MIX: Mix X | 4 faixas\n  1 A | Art | LOSSLESS 16/44100 3.0 MB em 5.0s -> a/b.flac\n"
                        "  2 B RECUSADA (lossy por dentro, corte 16,0 kHz)\n  3 C JÁ RECUSADA (lossy por dentro)\n"
                        "  4 D JÁ NO ACERVO (x)\nNOVAS 1 | PULADAS 1 | FALHAS 0 | LETRAS 0 | relatório r.json\n"
                        "RECUSADAS 2 (lossy por dentro)\nENVIADAS 1 para h:Music; staging limpo\nFIM\n")
        r = tf.resumo_do_log(log)
        self.assertIn("1 novas, 1 já no acervo, 0 falhas de 4", r)
        self.assertIn("2 recusadas (lossy por dentro)", r)
        self.assertIn("1 na cmr-auto", r)

    def test_resumo_sem_recusadas_nao_menciona(self):
        log = self._log("MIX: M | 1 faixas\nNOVAS 0 | PULADAS 0 | FALHAS 0 | LETRAS 0 | relatório r\nRECUSADAS 0 (lossy por dentro)\nFIM\n")
        self.assertNotIn("recusadas", tf.resumo_do_log(log))

    def test_job_so_com_recusadas_termina_ok_e_o_baixador_leva_numpy(self):
        # recusada não muda o rc do baixador (0): o job fecha ok; rc 2 continua parcial
        self.assertEqual(tf.status_final(0, True), "ok")
        self.assertEqual(tf.status_final(2, True), "parcial")
        self.assertEqual(tf.status_final(0, False), "falhou")
        self.assertEqual(tf.status_final(1, True), "falhou")
        cmd = tf.comando_do_job({"url": "https://tidal.com/browse/mix/abc", "playlist": "Rap"})
        self.assertEqual(cmd[1:9], ["run", "--with", "tidalapi", "--with", "mutagen", "--with", "numpy", "python3"])
        self.assertEqual(cmd[-2:], ["https://tidal.com/browse/mix/abc", "--playlist=Rap"])

    def test_resumo_do_log_ausente_e_string_vazia(self):
        self.assertEqual(tf.resumo_do_log(Path(self.d.name) / "nao-existe.log"), "")

    def _selecao(self, status, **extra):
        code, r = tf.api_post_fila({"faixas": [5, 6], "titulo": "T", "origem": "mix:a", "playlist": "Rap"})
        jobs = tf.load_fila()
        jobs[-1].update(status=status, resumo="3 NÃO chegaram", inicio="14/10 10:00", fim="14/10 10:05", **extra)
        tf.save_fila(jobs)
        return r["id"]

    def test_reenviar_selecao_parcial_ou_que_falhou(self):
        for status in ("parcial", "falhou"):
            jid = self._selecao(status)
            self.assertEqual(tf.reenvia(jid), (200, {"ok": True, "id": jid}))
            job = next(j for j in tf.load_fila() if j["id"] == jid)
            self.assertEqual((job["status"], job["resumo"], job["faixas"]), ("fila", "", [5, 6]))
            self.assertNotIn("fim", job)
            jobs = tf.load_fila()
            for j in jobs:
                j["status"] = "ok"
            tf.save_fila(jobs)

    def test_reenviar_recusa(self):
        self.assertEqual(tf.reenvia("nada")[0], 404)
        jid = self._selecao("ok")
        self.assertEqual(tf.reenvia(jid)[0], 400)  # concluída: nada a reenviar
        _, r = tf.api_post_fila({"url": "https://tidal.com/browse/mix/abc", "playlist": "Rap"})
        jobs = tf.load_fila()
        jobs[-1]["status"] = "falhou"
        tf.save_fila(jobs)
        self.assertEqual(tf.reenvia(r["id"])[0], 400)  # link: reenvia-se colando o link
        jid2 = self._selecao("falhou")
        tf.api_post_fila({"faixas": [5, 6], "titulo": "T", "origem": "mix:a", "playlist": "Rap"})  # mesma seleção já na fila
        self.assertEqual(tf.reenvia(jid2), (400, {"error": "essa seleção já está na fila"}))

    def test_rota_http_de_reenviar(self):
        import urllib.request
        from http.server import ThreadingHTTPServer
        orig_token = tf.TOKEN
        tf.TOKEN = "tok"
        jid = self._selecao("parcial")
        srv = ThreadingHTTPServer(("127.0.0.1", 0), tf.H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{srv.server_port}/tok/api/fila/{jid}/reenviar"
            with urllib.request.urlopen(urllib.request.Request(url, data=b"", method="POST")) as r:
                self.assertEqual(json.load(r), {"ok": True, "id": jid})
            self.assertEqual(tf.load_fila()[0]["status"], "fila")
        finally:
            srv.shutdown()
            srv.server_close()
            tf.TOKEN = orig_token


if __name__ == "__main__":
    unittest.main()
