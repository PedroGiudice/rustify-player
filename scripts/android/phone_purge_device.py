#!/usr/bin/env python3
"""Lista (e opcionalmente remove) arquivos orfaos NO CELULAR.

`adb push --sync` so copia: nunca apaga no destino. Entao musica deletada ou
pasta renomeada no acervo deixa a copia antiga no aparelho pra sempre. Em
11/09/2026 eram 24 arquivos (~130 MB), a maioria duplicata da mudanca de
sanitizacao de nome — nao os "571" que um bug de comparacao apontou primeiro.

Orfao nao aparece no app (a biblioteca vem do manifest, e arquivo sem entrada
correspondente e ignorado) — e peso morto, nao faixa fantasma. Por isso o
dry-run e o default: o ganho e espaco em disco, e o risco de errar a
comparacao e apagar musica boa.

A comparacao aqui e CASE-INSENSITIVE (`ignorar_caixa=True`): o storage do
Android nao distingue caixa, e pasta renomeada so na capitalizacao
(`Dj GBR` -> `DJ GBR`) aparece no `find` com o nome fisico antigo. Comparar
case-sensitive marcava musica legitima como orfa, apagava, e o push seguinte
recriava — loop.

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


def remove(rels: list[str]) -> int:
    """Remove uma passada e devolve quantos o `rm` confirmou ter apagado.

    `rm -v` em vez de `rm -f`: silenciar o erro foi o que produziu um
    relatorio falso em 11/09 ("ainda orfaos: 0" com 7 arquivos no aparelho).
    Quem chama confere pela re-listagem e repete — a fonte da verdade e o
    estado do aparelho, nunca o exit code do lote."""
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False,
                                     encoding="utf-8") as fh:
        for rel in rels:
            fh.write(f"{DEVICE_ROOT}/{rel}\n")
        local = fh.name
    try:
        # Lista por arquivo evita montar uma linha de shell por nome — os
        # titulos tem aspas, parenteses, &, acento e chaves.
        adb("push", local, DEVICE_TMP)
        saida = adb("shell",
                    f'while IFS= read -r f; do rm -v "$f"; done < {DEVICE_TMP}')
        adb("shell", f"rm -f {DEVICE_TMP}")
        # -empty/-delete podem nao existir no toybox; falha aqui e inofensiva.
        subprocess.run(["adb", "shell",
                        f"find {DEVICE_ROOT} -type d -empty -delete"],
                       capture_output=True, timeout=300)
        return sum(1 for l in saida.splitlines() if l.startswith("rm "))
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
    # Mesma regra do staging (preserva `.rustify/` e a capa por pasta que o
    # export deploya) — importada, nao reescrita.
    orfaos = m.orfaos_entre(no_device, esperados, ignorar_caixa=True)
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

    # Passadas com re-listagem entre elas: a primeira versao confiava num
    # unico `find` pos-remocao e reportou 0 tendo 7 no aparelho.
    restantes = orfaos
    for passada in range(1, 4):
        confirmados = remove(restantes)
        antes = len(restantes)
        restantes = m.orfaos_entre(lista_device(), esperados, ignorar_caixa=True)
        print(f"passada {passada}: rm confirmou {confirmados}/{antes}; "
              f"o aparelho ainda mostra {len(restantes)}", flush=True)
        if not restantes:
            break
    if restantes:
        print(f"NAO REMOVIDOS ({len(restantes)}) — conferir na mao:", flush=True)
        for rel in restantes[:20]:
            print(f"  {rel}", flush=True)
        return 1
    print("aparelho sem orfaos", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
