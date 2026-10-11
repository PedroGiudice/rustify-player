"""Gera o link do Fizzle (https://fizzle.glossing.dev) com o sketch embutido.

O Fizzle guarda o código inteiro no próprio link: deflate cru + base64
url-safe depois de `#z=`. Uso: python3 fizzle_link.py tinta.fizzle.js

Nunca redigitar o link à mão numa mensagem: são ~2.000 caracteres
aleatórios e a cópia sai corrompida (aconteceu em 11/10).
"""
import base64
import sys
import zlib


def link(code: str) -> str:
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    raw = c.compress(code.encode()) + c.flush()
    z = base64.b64encode(raw).decode().replace("+", "-").replace("/", "_").rstrip("=")
    back = zlib.decompress(base64.urlsafe_b64decode(z + "=" * (-len(z) % 4)), -15).decode()
    assert back == code, "o link não volta igual ao arquivo"
    return f"https://fizzle.glossing.dev/#z={z}"


if __name__ == "__main__":
    print(link(open(sys.argv[1], encoding="utf-8").read()))
