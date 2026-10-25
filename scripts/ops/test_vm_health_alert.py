import unittest

import vm_health_alert as vh


def q(**estados):
    return {n: {"ok": ok, "erro": None if ok else "timeout", "url": f"http://{n}", "unit": f"{n}.service"} for n, ok in estados.items()}


class Transicoes(unittest.TestCase):
    def test_primeiro_tique_tudo_ok_nao_gera_evento(self):
        self.assertEqual(vh.transicoes({}, q(a=True, b=True)), [])

    def test_primeiro_tique_com_servico_fora_avisa(self):
        self.assertEqual(vh.transicoes({}, q(a=True, b=False)), [("b", "caiu")])

    def test_so_a_mudanca_vira_evento(self):
        antes = q(a=True, b=False)
        self.assertEqual(vh.transicoes(antes, q(a=True, b=False)), [])
        self.assertEqual(vh.transicoes(antes, q(a=False, b=True)), [("a", "caiu"), ("b", "voltou")])

    def test_servico_que_sumiu_do_quadro_nao_gera_evento(self):
        self.assertEqual(vh.transicoes(q(a=True, velho=True), q(a=True)), [])


class Corpo(unittest.TestCase):
    def test_assunto_e_texto_de_queda(self):
        quadro = q(**{"fila da Tidal": False, "MERT": True})
        assunto, texto = vh.corpo(quadro, [("fila da Tidal", "caiu")], "26/10/2026 01:00")
        self.assertEqual(assunto, "[Rustify VM] fora do ar: fila da Tidal")
        self.assertIn("FORA  fila da Tidal  (timeout)", texto)
        self.assertIn("OK    MERT", texto)
        self.assertIn("systemctl --user restart", texto)
        self.assertIn("fila da Tidal.service", texto)

    def test_assunto_de_volta_e_misto(self):
        self.assertEqual(vh.corpo(q(a=True), [("a", "voltou")], "x")[0], "[Rustify VM] voltou: a")
        self.assertEqual(vh.corpo(q(a=True, b=False), [("a", "voltou"), ("b", "caiu")], "x")[0],
                         "[Rustify VM] caiu: b; voltou: a")

    def test_teste_sem_eventos_nao_lista_remedio(self):
        assunto, texto = vh.corpo(q(a=True), [], "x")
        self.assertIn("teste do vigia", assunto)
        self.assertNotIn("systemctl", texto)


class Mede(unittest.TestCase):
    def test_falha_e_reconfirmada_e_transitoria_nao_conta(self):
        respostas = iter(["timeout", None])
        esperas = []
        quadro = vh.mede([{"nome": "a", "url": "u", "unit": "a.service"}], sondar=lambda u: next(respostas), espera=esperas.append)
        self.assertTrue(quadro["a"]["ok"])
        self.assertEqual(esperas, [vh.RECONFIRMA_S])

    def test_falha_persistente_conta_com_o_motivo(self):
        quadro = vh.mede([{"nome": "a", "url": "u", "unit": "a.service"}], sondar=lambda u: "HTTP 503", espera=lambda s: None)
        self.assertEqual((quadro["a"]["ok"], quadro["a"]["erro"]), (False, "HTTP 503"))

    def test_url_com_segredo_sai_redigida(self):
        quadro = vh.mede([{"nome": "a", "url": "http://h/SEGREDO/api", "mostra": "http://h/<token>/api", "unit": "a.service"}],
                         sondar=lambda u: None, espera=lambda s: None)
        self.assertEqual(quadro["a"]["url"], "http://h/<token>/api")
        self.assertNotIn("SEGREDO", vh.corpo(quadro, [], "x")[1])

    def test_servicos_reais_nao_expoem_o_token(self):
        for s in vh.servicos():
            if "<token>" in s.get("mostra", ""):
                self.assertNotIn(vh.TOKEN_FILE.read_text().strip(), s["mostra"])

    def test_ok_nao_espera(self):
        esperas = []
        vh.mede([{"nome": "a", "url": "u", "unit": "a.service"}], sondar=lambda u: None, espera=esperas.append)
        self.assertEqual(esperas, [])


if __name__ == "__main__":
    unittest.main()
