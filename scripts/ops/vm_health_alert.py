#!/usr/bin/env python3
"""Vigia dos endpoints da VM que o app da cmr-auto consome, com aviso por e-mail (Resend).

Por que existe: em 22/10/2026 a VM reiniciou (kernel novo), a fila da Tidal (que vivia num tmux) morreu
e ninguém soube por 4 dias; o app só mostrou "fila indisponível" quando o CEO abriu a aba. MERT e letra
falham em silêncio (`embedding_status=failed`, backfill de letra com timeout): nenhum alarme (CMR-296).

O que faz, a cada 5 min (timer `rustify-health.timer`, usuário opc):
  - sonda as URLs EXATAS que o app usa (não o loopback): fila da Tidal pela tailnet, MERT pelo
    Tailscale Serve, vetor de letra (cogmem) pela tailnet. Uma falha é reconfirmada 5 s depois antes
    de contar (timeout transitório não vira e-mail).
  - compara com o estado anterior (`~/.local/state/rustify-health/state.json`) e manda UM e-mail só
    na transição (caiu / voltou), com o quadro completo. Sem transição, não manda nada.
  - a chave do Resend vem de `~/.secrets/resend-api-key.txt` (a mesma do extractor-lab); remetente
    `no-reply@aidvlabs.com` (domínio verificado lá). Nunca imprime a chave.

Limite: se a VM inteira cair, ninguém manda e-mail (quem avisaria é a própria VM). O que cobre é
reboot com serviço que não voltou, serviço que caiu, Tailscale Serve que perdeu a rota.

Uso:
  vm_health_alert.py            # um tique (o timer chama isto)
  vm_health_alert.py --status   # imprime o quadro, não grava estado nem envia
  vm_health_alert.py --teste    # manda um e-mail de teste com o quadro atual
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

SECRETS = Path.home() / ".secrets"
STATE = Path.home() / ".local/state/rustify-health/state.json"
TOKEN_FILE = SECRETS / "telemetria-token.txt"
RESEND_KEY_FILE = SECRETS / "resend-api-key.txt"
RESEND_URL = "https://api.resend.com/emails"
REMETENTE = "Rustify VM <no-reply@aidvlabs.com>"
DESTINO = os.environ.get("RUSTIFY_ALERT_TO", "pedrogr1707@gmail.com")
TIMEOUT_S = 10
RECONFIRMA_S = 5


def servicos() -> list[dict]:
    """As URLs que o APP usa (desktop.rs / sources.rs), na ordem em que aparecem para o CEO."""
    token = TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else ""
    return [
        {"nome": "fila da Tidal (aba Tidal do Crate)", "url": f"http://100.64.242.118:8470/{token}/api/fila",
         "mostra": "http://100.64.242.118:8470/<token>/api/fila", "unit": "rustify-tidal-fila.service"},
        {"nome": "MERT (vetor de som das faixas novas)", "url": "https://extractlab.cormorant-alpha.ts.net:8448/health",
         "unit": "rustify-embed.service"},
        {"nome": "vetor de letra (cogmem)", "url": "http://100.64.242.118:3939/api/health",
         "unit": "cogmem.service"},
    ]


def sonda(url: str) -> str | None:
    """None = ok (HTTP 2xx); senão o motivo em texto curto."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "rustify-health"}), timeout=TIMEOUT_S) as r:
            return None if 200 <= r.status < 300 else f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"
    except Exception as e:  # timeout, conexão recusada, TLS, DNS
        return type(e).__name__ + (f": {e}" if str(e) else "")


def mede(svcs: list[dict], sondar=sonda, espera=time.sleep) -> dict[str, dict]:
    """Quadro atual. Falha é reconfirmada uma vez depois de RECONFIRMA_S."""
    quadro = {}
    for s in svcs:
        erro = sondar(s["url"])
        if erro is not None:
            espera(RECONFIRMA_S)
            erro = sondar(s["url"])
        # `mostra` = URL sem segredo: é o que vai para o e-mail e para o estado em disco (o token da fila nunca sai)
        quadro[s["nome"]] = {"ok": erro is None, "erro": erro, "url": s.get("mostra", s["url"]), "unit": s["unit"]}
    return quadro


def transicoes(anterior: dict[str, dict], atual: dict[str, dict]) -> list[tuple[str, str]]:
    """Pura. [(nome, "caiu"|"voltou")] para cada serviço cujo `ok` mudou. Serviço sem estado anterior
    só gera evento se estiver caído (primeiro tique com tudo ok não manda e-mail)."""
    ev = []
    for nome, st in atual.items():
        antes = anterior.get(nome)
        if antes is None:
            if not st["ok"]:
                ev.append((nome, "caiu"))
        elif antes["ok"] != st["ok"]:
            ev.append((nome, "voltou" if st["ok"] else "caiu"))
    return ev


def corpo(quadro: dict[str, dict], eventos: list[tuple[str, str]], agora: str) -> tuple[str, str]:
    """Pura. (assunto, texto). Assunto diz o que mudou; o texto traz o quadro inteiro e o que fazer."""
    caiu = [n for n, e in eventos if e == "caiu"]
    voltou = [n for n, e in eventos if e == "voltou"]
    if caiu and voltou:
        assunto = f"[Rustify VM] caiu: {', '.join(caiu)}; voltou: {', '.join(voltou)}"
    elif caiu:
        assunto = f"[Rustify VM] fora do ar: {', '.join(caiu)}"
    elif voltou:
        assunto = f"[Rustify VM] voltou: {', '.join(voltou)}"
    else:
        assunto = "[Rustify VM] teste do vigia: quadro atual"
    linhas = [f"Medido na VM em {agora}.", ""]
    for nome, st in quadro.items():
        marca = "OK  " if st["ok"] else "FORA"
        linhas.append(f"{marca}  {nome}" + ("" if st["ok"] else f"  ({st['erro']})"))
        linhas.append(f"      {st['url']}")
    fora = [st for st in quadro.values() if not st["ok"]]
    if fora:
        linhas += ["", "O que isso significa no app:",
                   "- fila da Tidal fora: a aba Tidal do Crate fica em \"fila indisponível\"; nada baixa.",
                   "- MERT fora: faixa nova entra sem vetor de som (embedding_status=failed) e não é recomendada;",
                   "  o app refaz no próximo boot quando o serviço voltar.",
                   "- letra fora: faixa nova fica sem vetor de letra; o backfill do boot refaz.",
                   "", "Na VM, para cada serviço fora: systemctl --user restart <unit>",
                   *[f"  {st['unit']}" for st in fora]]
    return assunto, "\n".join(linhas) + "\n"


def envia(assunto: str, texto: str) -> None:
    chave = RESEND_KEY_FILE.read_text().strip()
    payload = json.dumps({"from": REMETENTE, "to": [DESTINO], "subject": assunto, "text": texto}).encode()
    req = urllib.request.Request(RESEND_URL, data=payload, method="POST",
                                 headers={"Authorization": f"Bearer {chave}", "Content-Type": "application/json",
                                          # sem User-Agent próprio o Cloudflare do Resend devolve 403 (error code 1010)
                                          "User-Agent": "rustify-health/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        resp = json.load(r)
    print(f"e-mail enviado para {DESTINO}: id {resp.get('id')} | {assunto}")


def carrega_estado() -> dict:
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {}


def grava_estado(quadro: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(quadro, ensure_ascii=False, indent=1))
    tmp.replace(STATE)


def main(argv: list[str]) -> int:
    agora = datetime.now().strftime("%d/%m/%Y %H:%M")
    quadro = mede(servicos())
    if "--status" in argv:
        print(corpo(quadro, [], agora)[1])
        return 0 if all(s["ok"] for s in quadro.values()) else 1
    if "--teste" in argv:
        envia(*corpo(quadro, [], agora))
        return 0
    ev = transicoes(carrega_estado(), quadro)
    if ev:
        assunto, texto = corpo(quadro, ev, agora)
        try:
            envia(assunto, texto)
        except Exception as e:
            print(f"falha ao enviar e-mail ({type(e).__name__}: {e}); estado NÃO gravado, tenta no próximo tique",
                  file=sys.stderr)
            return 2
    grava_estado(quadro)
    fora = [n for n, s in quadro.items() if not s["ok"]]
    print(f"{agora} " + ("tudo ok" if not fora else "fora: " + ", ".join(fora)) + (f" | eventos: {ev}" if ev else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
