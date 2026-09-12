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
check("dry-run e o padrao (sem --apply nada e apagado)",
      "--apply" in pathlib.Path(m.__file__).read_text())

if FALHAS:
    print("FALHOU:")
    for f in FALHAS:
        print("  -", f)
    sys.exit(1)
print("ok — rels_do_find (filtro do .rustify e do lixo) e guardas")
