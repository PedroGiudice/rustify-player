#!/usr/bin/env python3
"""Testes das funções puras do classificador do rap BR. Rodar:
  python3 scripts/curator/test_rap_br_classify.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import rap_br_classify as R  # noqa: E402

PT = ("[00:01.00] Eu não vou parar de correr, tô na rua com a minha família\n"
      "[00:05.00] Você sabe que o que eu quero é viver bem, mano, sem dever pra ninguém\n"
      "[00:09.00] A vida é uma só e eu vou aproveitar cada dia, porque ninguém me deu nada\n"
      "[00:13.00] Quando eu era moleque já falavam que eu não ia chegar lá, mas eu cheguei")
EN = ("[00:01.00] I don't know why you keep on calling me when you know that I'm not home\n"
      "[00:05.00] All the money in the world can't buy the things that I want and you got\n"
      "[00:09.00] They said that I would never make it but now I'm here and it's all mine\n"
      "[00:13.00] We been going up and down but this is what it is, you know what I mean")
ES = ("[00:01.00] Yo no sé por qué tú sigues llamando cuando sabes que no estoy en casa\n"
      "[00:05.00] Todo el dinero del mundo no puede comprar lo que quiero y tú tienes\n"
      "[00:09.00] Ellos decían que nunca lo iba a lograr pero ahora estoy aquí y todo es mío\n"
      "[00:13.00] Hemos subido y bajado pero esto es lo que hay, tú sabes lo que quiero decir")


class IdiomaTest(unittest.TestCase):
    def test_detecta_pt_en_es(self):
        self.assertEqual(R.detect_lang(PT)[0], "pt")
        self.assertEqual(R.detect_lang(EN)[0], "en")
        self.assertEqual(R.detect_lang(ES)[0], "es")

    def test_texto_curto_nao_decide(self):
        lang, n = R.detect_lang("[00:01.00] Eu não vou parar")
        self.assertIsNone(lang)
        self.assertLess(n, R.MIN_CHARS)

    def test_sem_margem_nao_decide(self):
        # só palavras sem stopword de nenhum idioma: nenhum passa do piso
        self.assertIsNone(R.detect_lang("zzz qqq www " * 40)[0])

    def test_strip_lrc(self):
        self.assertEqual(R.strip_lrc("[ar:X]\n[00:01.00] oi  mundo\n[01:02.5]  fim"), "oi mundo fim")
        self.assertEqual(R.strip_lrc(""), "")

    def test_titulo(self):
        self.assertEqual(R.title_lang("Não Para"), "pt")
        self.assertEqual(R.title_lang("Love Yourself and Me"), "en")
        self.assertIsNone(R.title_lang("1010"))


class NomeTest(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(R.normalize_name("Emicida"), R.normalize_name("EMICIDA"))
        self.assertEqual(R.normalize_name("Criolo, "), "criolo")
        self.assertEqual(R.normalize_name("Matuê"), "matue")
        self.assertEqual(R.normalize_name("A$AP  Rocky"), R.normalize_name("a$ap rocky"))

    def test_artista_primario(self):
        self.assertEqual(R.primary_artist("Baby Keem & Kendrick Lamar"), "Baby Keem")
        self.assertEqual(R.primary_artist("Djonga feat. Filipe Ret"), "Djonga")
        self.assertEqual(R.primary_artist("Matuê, Teto"), "Matuê")
        self.assertEqual(R.primary_artist("Tyler, The Creator"), "Tyler, The Creator")
        self.assertEqual(R.primary_artist("Jay Rock"), "Jay Rock")


class ConfiancaTest(unittest.TestCase):
    def test_alta(self):
        self.assertEqual(R.decide("pt", "BR", None)[:2], (R.DEST_BR, "alta"))
        self.assertEqual(R.decide("en", "US", None)[:2], (R.SRC, "alta"))
        self.assertEqual(R.decide("es", "PR", None)[:2], (R.SRC, "alta"))
        # letra forte, país não achado, título concorda
        self.assertEqual(R.decide("pt", None, "pt")[:2], (R.DEST_BR, "alta"))

    def test_media(self):
        self.assertEqual(R.decide("pt", None, None)[:2], (R.DEST_BR, "media"))
        self.assertEqual(R.decide("en", None, "pt")[:2], (R.SRC, "media"))
        self.assertEqual(R.decide(None, "BR", None)[:2], (R.DEST_BR, "media"))
        self.assertEqual(R.decide(None, "US", None)[:2], (R.SRC, "media"))

    def test_baixa(self):
        self.assertEqual(R.decide(None, None, None)[:2], (R.SRC, "baixa"))
        self.assertEqual(R.decide(None, None, "pt")[:2], (R.DEST_BR, "baixa"))
        # conflito: letra pt, artista dos EUA (homônimo provável) -> segue a letra, baixa
        self.assertEqual(R.decide("pt", "US", None)[:2], (R.DEST_BR, "baixa"))
        # artista brasileiro cantando em inglês -> segue a letra, baixa
        self.assertEqual(R.decide("en", "BR", None)[:2], (R.SRC, "baixa"))
        # só país de fora, mas título em português: homônimo provável
        self.assertEqual(R.decide(None, "US", "pt")[:2], (R.SRC, "baixa"))
        # rap português de Portugal não é brasileiro
        self.assertEqual(R.decide("pt", "PT", None)[:2], (R.SRC, "baixa"))


def faixa(adir, alb, nome, dest, conf="alta", artista="X"):
    return {"artist_dir": adir, "album_dir": alb, "file": f"{adir}/{alb + '/' if alb else ''}{nome}.flac",
            "dest": dest, "confidence": conf, "canonical_artist": artista, "title": nome,
            "lyrics_lang": "pt", "lyrics_chars": 200, "mb_country": "BR", "title_lang": None, "reason": ""}


class AgregacaoTest(unittest.TestCase):
    def test_pasta_unanime_vira_linha_de_artista(self):
        ts = [faixa("A", "Alb", "1", R.DEST_BR), faixa("A", "Alb2", "2", R.DEST_BR, "media")]
        rows = R.aggregate(ts)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["album_dir"])
        self.assertNotIn("file", rows[0])
        self.assertEqual(rows[0]["confidence"], "media")  # pior confiança manda
        self.assertEqual(rows[0]["n_tracks"], 2)

    def test_artista_misto_divide_por_album(self):
        ts = [faixa("A", "Alb", "1", R.DEST_BR), faixa("A", "Alb", "2", R.DEST_BR),
              faixa("A", "Alb2", "3", R.SRC)]
        rows = R.aggregate(ts)
        self.assertEqual({(r["album_dir"], r["dest"]) for r in rows},
                         {("Alb", R.DEST_BR), ("Alb2", R.SRC)})
        self.assertTrue(all("file" not in r for r in rows))

    def test_album_misto_vira_linhas_por_faixa(self):
        ts = [faixa("_Compilations", "Mix", "1", R.DEST_BR), faixa("_Compilations", "Mix", "2", R.SRC)]
        rows = R.aggregate(ts)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all("file" in r for r in rows))
        self.assertEqual({r["file"]: r["dest"] for r in rows},
                         {"_Compilations/Mix/1.flac": R.DEST_BR, "_Compilations/Mix/2.flac": R.SRC})

    def test_faixas_soltas_na_pasta_do_artista_vao_por_faixa_se_misto(self):
        ts = [faixa("CD 01", None, "1", R.DEST_BR), faixa("CD 01", None, "2", R.SRC)]
        rows = R.aggregate(ts)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r["album_dir"] is None and "file" in r for r in rows))


if __name__ == "__main__":
    unittest.main()
