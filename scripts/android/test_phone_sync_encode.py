#!/usr/bin/env python3
"""Testes das funcoes de decisao do transcode pro celular.

Regressao guardada aqui: `duration_ok` e o unico ponto que separa "faixa boa",
"faixa recuperada pelo GStreamer" e "natimorto de 202 bytes". Errar o limiar
tem custo nos dois sentidos — folgado demais deixa passar arquivo mudo pro
celular; apertado demais reprova recuperacao boa e a faixa some.
"""

import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location(
    "phone_sync_encode", pathlib.Path(__file__).with_name("phone_sync_encode.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

FALHAS = []


def check(nome, cond):
    if not cond:
        FALHAS.append(nome)


# Natimorto: o ffmpeg saiu com codigo 0 e escreveu so o header. Reprova em
# qualquer limiar — foi o bug que mandou faixa muda pro S24.
check("natimorto reprova (gatilho)",
      not m.duration_ok(121.8, 0.0, m.MIN_DURATION_RATIO))
check("natimorto reprova (aceitacao)",
      not m.duration_ok(121.8, 0.0, m.RECOVERED_MIN_RATIO))

# Encode limpo: mediana medida no acervo real foi 1.00003. O arredondamento do
# frame de 20ms + resample 44.1k->48k pode tirar fracao de segundo.
check("encode limpo passa", m.duration_ok(121.8, 121.85, m.MIN_DURATION_RATIO))
check("perda de 1s em 122s ainda passa no gatilho",
      m.duration_ok(121.8, 120.8, m.MIN_DURATION_RATIO))

# Recuperado: o GStreamer entra depois do lixo e perde o comeco (casos reais:
# 205.2s de 217.2s, 86.9s de 92.2s). Tem que DISPARAR o fallback e ser ACEITO.
check("recuperado dispara o fallback",
      not m.duration_ok(217.2, 205.2, m.MIN_DURATION_RATIO))
check("recuperado e aceito", m.duration_ok(217.2, 205.2, m.RECOVERED_MIN_RATIO))
check("recuperado curto e aceito", m.duration_ok(92.2, 86.9, m.RECOVERED_MIN_RATIO))

# Truncamento grosseiro nao passa nem como recuperacao.
check("truncado em 10% reprova", not m.duration_ok(200.0, 20.0, m.RECOVERED_MIN_RATIO))

# Origem ilegivel (mutagen falhou): sem referencia, basta ter audio.
check("sem referencia aceita audio", m.duration_ok(0.0, 120.0, m.MIN_DURATION_RATIO))
check("sem referencia reprova vazio", not m.duration_ok(0.0, 0.0, m.MIN_DURATION_RATIO))

def canon_stem(rel: str) -> str:
    """Replica de `canon_stem` (src-tauri/src/mobile_library.rs) — o app casa
    manifest x arquivo do celular por aqui. Se a sanitizacao do destino mudar
    o stem, a faixa some da biblioteca."""
    if "." in rel:
        stem, ext = rel.rsplit(".", 1)
        if 0 < len(ext) <= 5 and ext.isalnum() and ext.isascii():
            rel = stem
    out, last_space = [], False
    for c in rel.lower():
        c = " " if c in ':*?"<>|_-' else c
        if c == " ":
            if not last_space:
                out.append(" ")
            last_space = True
        else:
            out.append(c)
            last_space = False
    return "".join(out).strip()


# O caso que quebrou o push de verdade: `:` no nome do album faz o adb push
# responder "Operation not permitted" e derrubar a leva inteira.
ORIGINAL = ("Funk & Soul/Otis Redding/Complete & Unbelievable: The Otis Redding "
            "Dictionary of Soul/Otis Redding - 05 - Try A Little Tenderness.flac")
destino = str(m.safe_rel(pathlib.PurePath(ORIGINAL).with_suffix(".opus")))

check("destino sem char recusado pelo Android",
      not any(c in m.ILLEGAL_CHARS for c in destino))
check("sanitizacao preserva o stem canonico — a faixa continua resolvendo",
      canon_stem(ORIGINAL) == canon_stem(destino))
check("nome limpo passa intacto",
      str(m.safe_rel(pathlib.PurePath("Rock/Album/01 - Faixa.opus")))
      == "Rock/Album/01 - Faixa.opus")
check("separador de diretorio sobrevive",
      len(m.safe_rel(pathlib.PurePath(ORIGINAL)).parts) == 4)

if FALHAS:
    print("FALHOU:")
    for f in FALHAS:
        print("  -", f)
    sys.exit(1)
print("ok — duration_ok (limiares) e safe_rel (contrato com canon_stem)")
