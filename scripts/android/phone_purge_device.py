#!/usr/bin/env python3
"""Lista (e opcionalmente remove) arquivos orfaos NO CELULAR.

`adb push --sync` so copia: nunca apaga no destino. Entao musica deletada ou
pasta renomeada no acervo deixa a copia antiga no aparelho pra sempre. Em
10/09/2026 eram 571 arquivos acumulados desde que o sync existe — o
`purge_orphans` do phone_sync_encode.py limpou o STAGING, mas as copias no
S24 seguem lá ocupando espaco.

Orfao nao aparece no app (a biblioteca vem do manifest, e arquivo sem entrada
correspondente e ignorado) — e peso morto, nao faixa fantasma.

Roda na cmr-auto (onde estao o acervo e o adb). Por padrao SO LISTA:

    python3 phone_purge_device.py              # lista, nao apaga nada
    python3 phone_purge_device.py --apply      # apaga o que foi listado

`.rustify/` (manifest, vetores, capas, taste, stations) e do
export_manifest.py e NUNCA entra na conta.
"""

import argparse
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

DEVICE_ROOT = "/storage/emulated/0/Music"
DEVICE_TMP = "/data/local/tmp/rustify-purge.txt"
# Guarda contra catastrofe: se a comparacao der errado (gather vazio, adb
# devolvendo lixo), um bug apagaria o acervo inteiro do aparelho. Acima disso
# o script para e manda conferir na mao.
MAX_FRACAO_ORFAOS = 0.30


def carrega_sync_module():
    """phone_sync_encode.py vive ao lado (repo) ou no home (deploy cmr-auto)."""
    for base in (Path(__file__).resolve().parent, Path.home()):
        candidato = base / "phone_sync_encode.py"
        if candidato.exists():
            spec = importlib.util.spec_from_file_location("pse", candidato)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    sys.exit("phone_sync_encode.py nao encontrado (nem ao lado, nem no home)")


def adb(*args, **kw) -> str:
    r = subprocess.run(["adb", *args], capture_output=True, timeout=kw.pop("timeout", 300))
    if r.returncode != 0:
        sys.exit(f"adb {' '.join(args)[:60]} falhou: {r.stderr.decode()[:200]}")
    return r.stdout.decode(errors="replace")


def exige_device():
    linhas = [l for l in adb("devices").splitlines()[1:] if l.strip()]
    prontos = [l.split()[0] for l in linhas if l.split()[-1] == "device"]
    if not prontos:
        sys.exit("nenhum device pronto no adb — conecte o S24 por USB "
                 "(e desbloqueie a tela)")
    return prontos[0]


def rels_do_find(saida: str) -> list[str]:
    """Paths relativos a DEVICE_ROOT. Descarta linha fora do root (erro do
    find vem no mesmo stream) e `.rustify/`, que e de outro pipeline."""
    rels = []
    for linha in saida.splitlines():
        p = linha.strip()
        if not p or not p.startswith(DEVICE_ROOT + "/"):
            continue
        rel = p[len(DEVICE_ROOT) + 1:]
        if any(part.startswith(".") for part in rel.split("/")[:-1]):
            continue
        rels.append(rel)
    return rels


def lista_device() -> list[str]:
    return rels_do_find(adb("shell", f"find {DEVICE_ROOT} -type f"))


def tamanhos(rels: list[str]) -> dict[str, int]:
    """stat em lote; se o toybox do aparelho nao colaborar, segue sem tamanho."""
    if not rels:
        return {}
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False,
                                     encoding="utf-8") as fh:
        for rel in rels:
            fh.write(f"{DEVICE_ROOT}/{rel}\n")
        local = fh.name
    try:
        adb("push", local, DEVICE_TMP)
        saida = adb("shell",
                    f'while IFS= read -r f; do stat -c "%s|%n" "$f"; done < {DEVICE_TMP}')
    except SystemExit:
        return {}
    finally:
        Path(local).unlink(missing_ok=True)
    out = {}
    for linha in saida.splitlines():
        tam, _, caminho = linha.strip().partition("|")
        if caminho.startswith(DEVICE_ROOT + "/") and tam.isdigit():
            out[caminho[len(DEVICE_ROOT) + 1:]] = int(tam)
    return out


def remove(rels: list[str]):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False,
                                     encoding="utf-8") as fh:
        for rel in rels:
            fh.write(f"{DEVICE_ROOT}/{rel}\n")
        local = fh.name
    try:
        # Lista por arquivo evita montar uma linha de shell por nome — os
        # titulos tem aspas, parenteses, &, acento e chaves.
        adb("push", local, DEVICE_TMP)
        adb("shell", f'while IFS= read -r f; do rm -f "$f"; done < {DEVICE_TMP}')
        adb("shell", f"rm -f {DEVICE_TMP}")
        # -empty/-delete podem nao existir no toybox; falha aqui e inofensiva.
        subprocess.run(["adb", "shell",
                        f"find {DEVICE_ROOT} -type d -empty -delete"],
                       capture_output=True, timeout=300)
    finally:
        Path(local).unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="apaga de verdade (o padrao e so listar)")
    ap.add_argument("--amostra", type=int, default=40,
                    help="quantos nomes imprimir (default 40)")
    args = ap.parse_args()

    m = carrega_sync_module()
    serial = exige_device()
    print(f"device: {serial}", flush=True)

    esperados = {str(d.relative_to(m.DST)) for _, _, d in m.gather()}
    if not esperados:
        sys.exit("gather() devolveu vazio — acervo nao montado? abortando")

    no_device = lista_device()
    orfaos = sorted(set(no_device) - esperados)
    print(f"no aparelho: {len(no_device)} | esperados: {len(esperados)} | "
          f"orfaos: {len(orfaos)}", flush=True)

    if not orfaos:
        print("nada a remover", flush=True)
        return 0

    fracao = len(orfaos) / len(no_device)
    if fracao > MAX_FRACAO_ORFAOS:
        sys.exit(f"ABORTADO: {fracao:.0%} do aparelho apareceu como orfao "
                 f"(limite {MAX_FRACAO_ORFAOS:.0%}). Isso tem cara de bug de "
                 f"comparacao, nao de lixo acumulado — conferir na mao.")

    tam = tamanhos(orfaos)
    total = sum(tam.values())
    for rel in orfaos[:args.amostra]:
        mb = tam.get(rel, 0) / 1e6
        print(f"  {mb:7.1f} MB  {rel}", flush=True)
    if len(orfaos) > args.amostra:
        print(f"  ... +{len(orfaos) - args.amostra}", flush=True)
    if total:
        print(f"espaco a recuperar: {total / 1e9:.2f} GB", flush=True)

    if not args.apply:
        print("\n(dry-run — nada foi apagado; use --apply)", flush=True)
        return 0

    remove(orfaos)
    restantes = sorted(set(lista_device()) - esperados)
    print(f"removidos: {len(orfaos) - len(restantes)} | ainda orfaos: "
          f"{len(restantes)}", flush=True)
    return 0 if not restantes else 1


if __name__ == "__main__":
    sys.exit(main())
