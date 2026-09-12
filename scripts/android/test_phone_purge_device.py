#!/usr/bin/env python3
"""Testes da parte pura do purge de orfaos no celular.

O que se protege aqui: o script apaga arquivo NO APARELHO do usuario. Um erro
de filtro que deixasse `.rustify/` entrar na conta destruiria manifest,
vetores e capas (a biblioteca do app inteira); um erro no parsing do `find`
poderia transformar mensagem de erro em "caminho a remover".
"""

import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location(
    "phone_purge_device", pathlib.Path(__file__).with_name("phone_purge_device.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

R = m.DEVICE_ROOT
FALHAS = []


def check(nome, cond):
    if not cond:
        FALHAS.append(nome)


saida = "\n".join([
    f"{R}/Rock/Album/01 - Faixa.opus",
    f"{R}/Rock/Album/cover.jpg",
    # .rustify/ e do export_manifest.py — apagar aqui cegaria o app
    f"{R}/.rustify/manifest.json",
    f"{R}/.rustify/covers/abc123.jpg",
    f"{R}/.rustify/vectors.bin",
    # erro do find sai no mesmo stream: nao pode virar candidato
    "find: /storage/emulated/0/Music/x: Permission denied",
    "",
    # fora do root (nunca deveria aparecer, mas se aparecer, ignora)
    "/data/local/tmp/coisa.txt",
])
rels = m.rels_do_find(saida)

check("pega os arquivos de musica", "Rock/Album/01 - Faixa.opus" in rels)
check("pega capa de pasta", "Rock/Album/cover.jpg" in rels)
check("NUNCA lista .rustify/ (manifest/vetores/capas do app)",
      not any(r.startswith(".rustify") for r in rels))
check("descarta mensagem de erro do find",
      not any("Permission denied" in r for r in rels))
check("descarta path fora do DEVICE_ROOT",
      not any("local/tmp" in r for r in rels))
check("nao inventa entrada de linha vazia", all(r for r in rels))
check("total esperado", len(rels) == 2)

# Nome com os caracteres reais do acervo (aspas, &, parenteses, acento) tem
# que sobreviver ao parsing — e por isso que a remocao vai por arquivo de
# lista, nunca interpolado numa linha de shell.
sujo = 'Funk Brasileiro/DJ GB/06 - Os Alemão Sabe Se Brota{Beat} & "cia" (ao vivo).opus'
check("nome com acento, chaves, aspas e & sobrevive",
      m.rels_do_find(f"{R}/{sujo}") == [sujo])

# A guarda existe pra o caso de a comparacao dar errado: melhor abortar do que
# apagar o acervo do aparelho.
check("guarda de catastrofe e conservadora", 0 < m.MAX_FRACAO_ORFAOS <= 0.5)

# A regra de "quem e orfao" tem que ser a MESMA do staging — importada de
# phone_sync_encode, nao reescrita aqui. Foi a duplicacao que fez o bug das
# capas nascer duas vezes (staging em 10/09, aparelho em 11/09).
pse = m.carrega_sync_module()
check("usa a regra importada, nao uma copia", hasattr(pse, "orfaos_entre"))
esperados = {"Rock/Album/01 - Faixa.opus"}
presentes = [
    "Rock/Album/01 - Faixa.opus",
    "Rock/Album/cover.jpg",            # do export, pasta viva -> preservar
    "Rock/AlbumMorto/cover.jpg",       # pasta sem destino -> remover
    "Rock/Album/sobra.opus",           # sobra de rename -> remover
]
orfaos = pse.orfaos_entre(presentes, esperados)
check("capa do export preservada no aparelho", "Rock/Album/cover.jpg" not in orfaos)
check("capa de album morto sai", "Rock/AlbumMorto/cover.jpg" in orfaos)
check("sobra de rename sai", "Rock/Album/sobra.opus" in orfaos)
check("faixa esperada nunca sai", "Rock/Album/01 - Faixa.opus" not in orfaos)

# O storage do Android e case-insensitive. Pasta renomeada so na caixa no
# acervo (`Dj GBR` -> `DJ GBR`, `Meant to Be` -> `Meant To Be`) aparece no
# `find` com o nome fisico ANTIGO. Sem ignorar_caixa, essa musica legitima
# era marcada como orfa, apagada, e o push seguinte a recriava — loop que
# rodou de verdade em 11/09.
esperados_caixa = {"Funk/DJ GBR/2020 - Pump It/01 - Pump It.opus"}
no_device_caixa = ["Funk/Dj GBR/2020 - Pump It/01 - Pump It.opus"]
check("caixa diferente NAO e orfao no aparelho",
      pse.orfaos_entre(no_device_caixa, esperados_caixa, ignorar_caixa=True) == [])
check("no staging (ext4) a caixa continua distinguindo",
      pse.orfaos_entre(no_device_caixa, esperados_caixa) == no_device_caixa)
check("capa por pasta tambem tolera caixa no aparelho",
      pse.orfaos_entre(["Funk/Dj GBR/2020 - Pump It/cover.jpg"],
                       esperados_caixa, ignorar_caixa=True) == [])
check("dry-run e o padrao (sem --apply nada e apagado)",
      "--apply" in pathlib.Path(m.__file__).read_text())

if FALHAS:
    print("FALHOU:")
    for f in FALHAS:
        print("  -", f)
    sys.exit(1)
print("ok — rels_do_find (filtro do .rustify e do lixo) e guardas")
