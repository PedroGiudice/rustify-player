#!/usr/bin/env python3
"""Fila de downloads da Tidal para o CEO (fora da tailnet), com índice/MERT/vibe e últimos commits.
Gera um HTML a cada 15 s e serve em 127.0.0.1:8470 sob um caminho secreto (token em
~/.secrets/telemetria-token.txt; exposto por `tailscale funnel --https=10000`).
POST /<token>/fila com url+playlist enfileira um download na VM: o worker roda
scripts/curator/tidal_mix_dl.py (um lote por vez), que na VM já envia cada faixa para
cmr-auto:~/Music, apaga o staging e dá touch remoto; o progresso e o resultado aparecem na página.
Rodar na VM:  tmux new -d -s telemetria 'python3 ~/rustify-player/scripts/curator/tidal_fila.py'
"""
import html
import json
import os
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CMR = "cmr-auto@100.102.249.9"
QDRANT = "http://127.0.0.1:16333"
TOKEN = Path(os.path.expanduser("~/.secrets/telemetria-token.txt")).read_text().strip()
PORT = 8470
OUT = Path(os.path.expanduser("~/tidal-out"))
LOGS = OUT / "logs"
FILA = OUT / "fila.json"
SCRIPT = Path(REPO) / "scripts" / "curator" / "tidal_mix_dl.py"
UV = os.path.expanduser("~/.local/bin/uv")
URL_RE = re.compile(r"^https?://(listen\.|www\.)?tidal\.com/(browse/)?(mix|playlist|album|track)/[A-Za-z0-9-]+")
PAGE = {"html": "<p>gerando...</p>"}
LOCK = threading.Lock()
PASTAS = {"at": 0.0, "lista": ["Funk Brasileiro", "Rap & Hip-Hop", "Jazz"]}


def sh(cmd, timeout=20):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout
    except Exception as e:
        return f"erro: {e!r}"


# ---------- fila ----------
def load_fila():
    try:
        return json.load(open(FILA))
    except Exception:
        return []


def save_fila(jobs):
    tmp = FILA.with_suffix(".tmp")
    tmp.write_text(json.dumps(jobs, ensure_ascii=False, indent=1))
    tmp.rename(FILA)


def pastas():
    if time.time() - PASTAS["at"] > 300:
        raw = sh(f"ssh -o ConnectTimeout=8 {CMR} 'ls -1 ~/Music'", 20)
        lista = [l.strip() for l in raw.splitlines() if l.strip() and not l.startswith("_") and not l.startswith(".") and "." not in l[-5:]]
        if lista:
            PASTAS["lista"] = sorted(set(lista), key=str.lower)
            PASTAS["at"] = time.time()
    return PASTAS["lista"]


def enfileira(url, playlist):
    url = url.strip()
    if not URL_RE.match(url):
        return "link não reconhecido: use um link da Tidal de mix, playlist, álbum ou faixa"
    playlist = re.sub(r"[^\w &'\-.]+", " ", playlist, flags=re.U).strip()[:60]
    if not playlist:
        return "pasta vazia"
    with LOCK:
        jobs = load_fila()
        if any(j["url"] == url and j["status"] in ("fila", "baixando") for j in jobs):
            return "esse link já está na fila"
        jid = datetime.now().strftime("%Y%m%d-%H%M%S")
        jobs.append({"id": jid, "url": url, "playlist": playlist, "status": "fila", "added": datetime.now().strftime("%d/%m %H:%M"),
                     "log": str(LOGS / f"{jid}.log"), "resumo": ""})
        save_fila(jobs)
    return None


def resumo_do_log(path):
    try:
        txt = Path(path).read_text(errors="ignore")
    except Exception:
        return "", None
    lines = txt.splitlines()
    titulo = next((l[5:].split(" | ")[0] for l in lines if l.startswith("MIX: ")), "")
    n = sum(1 for l in lines if " -> " in l)
    s = sum(1 for l in lines if "JÁ NO ACERVO" in l or "JÁ BAIXADA" in l or "JÁ NA CMR-AUTO" in l)
    f = sum(1 for l in lines if "FALHOU" in l)
    total = next((l.split("|")[1].strip().split(" ")[0] for l in lines if l.startswith("MIX: ") and "|" in l), "?")
    env = next((l.split(" ")[1] for l in lines if l.startswith("ENVIADAS ")), None)
    nao = next((l.split(" ")[2] for l in lines if l.startswith("NÃO ENVIADAS ")), None)
    txt = f"{titulo}: {n} novas, {s} já no acervo, {f} falhas de {total}"
    if env:
        txt += f"; {env} na cmr-auto"
    if nao:
        txt += f"; {nao} NÃO chegaram (ficaram na VM)"
    return txt


def worker():
    LOGS.mkdir(parents=True, exist_ok=True)
    while True:
        job = None
        with LOCK:
            jobs = load_fila()
            for j in jobs:
                if j["status"] == "baixando":  # sobra de uma queda do servidor
                    j["status"] = "fila"
            job = next((j for j in jobs if j["status"] == "fila"), None)
            if job:
                job["status"] = "baixando"
                job["inicio"] = datetime.now().strftime("%d/%m %H:%M")
            save_fila(jobs)
        if not job:
            time.sleep(5)
            continue
        # Sem flag nem env: na VM o tidal_mix_dl.py já assume staging ~/tidal-out, Qdrant pelo túnel
        # 16333 (abre sozinho), envio faixa a faixa para cmr-auto:~/Music, staging limpo e touch remoto.
        with open(job["log"], "w") as lf:
            rc = subprocess.run([UV, "run", "--with", "tidalapi", "--with", "mutagen", "python3", str(SCRIPT), job["url"],
                                 "--playlist", job["playlist"]], stdout=lf, stderr=subprocess.STDOUT, cwd=str(OUT)).returncode
        resumo = resumo_do_log(job["log"])
        fim = "FIM" in Path(job["log"]).read_text(errors="ignore")
        status = "ok" if rc == 0 and fim else ("parcial" if rc == 2 and fim else "falhou")
        with LOCK:
            jobs = load_fila()
            for j in jobs:
                if j["id"] == job["id"]:
                    j["status"] = status
                    j["resumo"] = resumo or (f"saiu com código {rc}")
                    j["fim"] = datetime.now().strftime("%d/%m %H:%M")
            save_fila(jobs)


def fila_html(msg=""):
    jobs = load_fila()
    opts = "".join(f'<option value="{html.escape(p)}">{html.escape(p)}</option>' for p in pastas())
    form = f"""<form method="post" action="/{TOKEN}/fila" class="fila">
<input type="url" name="url" placeholder="cole o link da Tidal (mix, playlist, álbum ou faixa)" required autocomplete="off">
<select name="playlist">{opts}<option value="__nova__">outra pasta...</option></select>
<input type="text" name="nova" placeholder="nome da pasta nova" autocomplete="off">
<button type="submit">Baixar</button></form>
<p class="dim">Um lote por vez: baixa na VM e cada faixa vai direto para ~/Music da cmr-auto assim que fica pronta (o app precisa estar aberto lá para indexar). O que já está no acervo ou já chegou lá é pulado. "Parcial" = alguma faixa não chegou; mandar o mesmo link de novo reenvia. A vibe das novas é anotada depois pelo CTO.</p>"""
    if msg:
        form += f"<p class='warn'>{html.escape(msg)}</p>"
    rows = []
    for j in reversed(jobs[-12:]):
        st = {"fila": "na fila", "baixando": "baixando", "ok": "na cmr-auto", "parcial": "parcial", "falhou": "falhou"}[j["status"]]
        cls = {"fila": "", "baixando": "run", "ok": "ok", "parcial": "bad", "falhou": "bad"}[j["status"]]
        resumo = j.get("resumo") or (resumo_do_log(j["log"]) if j["status"] == "baixando" else "")
        rows.append(f"<tr><td><span class='st {cls}'>{st}</span></td><td>{html.escape(j['playlist'])}</td><td><a href='{html.escape(j['url'])}' target='_blank' rel='noopener'>{html.escape(j['url'].split('tidal.com/')[-1])}</a><br><small>{html.escape(resumo)}</small></td><td><small>{html.escape(j.get('added', ''))}</small></td></tr>")
    table = "<table><tr><th>Estado</th><th>Pasta</th><th>Link / resultado</th><th>Entrou</th></tr>" + "".join(rows) + "</table>" if rows else "<p class='dim'>fila vazia</p>"
    ativo = next((j for j in jobs if j["status"] == "baixando"), None)
    tail = ""
    if ativo:
        try:
            lines = [l for l in Path(ativo["log"]).read_text(errors="ignore").splitlines() if l.strip()][-8:]
            tail = "<pre>" + html.escape("\n".join(l[:150] for l in lines)) + "</pre>"
        except Exception:
            pass
    return form + table + tail


def acervo():
    try:
        r = json.load(urllib.request.urlopen(f"{QDRANT}/collections/rustify_tracks", timeout=10))["result"]
        total = r["points_count"]
        body = {"limit": 1000, "with_payload": ["embedding_status"], "with_vector": False, "filter": {"must": [{"key": "path", "match": {"text": "[tidal]"}}]}}
        req = urllib.request.Request(f"{QDRANT}/collections/rustify_tracks/points/scroll", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        pts = json.load(urllib.request.urlopen(req, timeout=20))["result"]["points"]
        c = Counter(p["payload"].get("embedding_status") for p in pts)
        ids = [p["id"] for p in pts]
        have = 0
        for i in range(0, len(ids), 500):
            b = json.dumps({"ids": ids[i:i + 500], "with_payload": ["energy"], "with_vector": False}).encode()
            rq = urllib.request.Request(f"{QDRANT}/collections/track_enrichments/points", data=b, headers={"Content-Type": "application/json"})
            have += sum(1 for p in json.load(urllib.request.urlopen(rq, timeout=20))["result"] if p.get("payload", {}).get("energy") is not None)
        return (f"<p>Acervo: <b>{total}</b> faixas. Da Tidal (pastas [tidal]) indexadas: <b>{len(pts)}</b> "
                f"(MERT pronto {c.get('done', 0)}, pendente {c.get('pending', 0) + c.get('running', 0)}, falho {c.get('failed', 0)}; vibe {have}/{len(pts)}).</p>")
    except Exception as e:
        return f"<p class='dim'>Qdrant indisponível (túnel 16333?): {html.escape(repr(e))}</p>"


def git():
    return "<pre>" + html.escape(sh(f"git -C {REPO} log --oneline -8 2>&1")) + "</pre>"


def render(msg=""):
    now = datetime.now().strftime("%d/%m %H:%M:%S")
    return f"""<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Rustify: Tidal</title>
<style>
:root{{--bg:#101214;--fg:#e6e6e6;--dim:#8a8f98;--ok:#7bd88f;--run:#f0c674;--bad:#f28b82;--line:#2a2f36;--acc:#9ecbff}}
body{{background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;max-width:980px}}
h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:17px;margin:22px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}} h3{{font-size:15px;margin:14px 0 4px}}
table{{border-collapse:collapse;width:100%}} td,th{{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--line)}}
.st{{display:inline-block;margin:2px 6px 2px 0;padding:2px 6px;border:1px solid var(--line);border-radius:4px;font-size:13px;white-space:nowrap}}
.st.ok{{border-color:var(--ok);color:var(--ok)}} .st.run{{border-color:var(--run);color:var(--run)}} .st.bad{{border-color:var(--bad);color:var(--bad)}}
pre{{background:#0a0b0d;border:1px solid var(--line);padding:8px;overflow-x:auto;font-size:12.5px;white-space:pre-wrap}}
.dim{{color:var(--dim)}} .warn{{color:var(--bad)}} small{{color:var(--dim)}} ul{{padding-left:18px}} li{{margin:2px 0;font-size:13px}} a{{color:var(--acc)}}
form.fila{{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}} form.fila input[type=url]{{flex:1 1 320px}}
form.fila input,form.fila select{{background:#0a0b0d;color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:8px;font-size:15px}}
form.fila button{{background:var(--acc);color:#000;border:0;border-radius:4px;padding:8px 16px;font-size:15px;font-weight:600}}
</style></head><body>
<h1>Rustify: baixar da Tidal</h1><p class="dim">atualizado {now}; a página recarrega a cada 20 s quando você não está digitando</p>
<h2>Baixar da Tidal</h2>{fila_html(msg)}
<h2>Índice, MERT e vibe</h2>{acervo()}
<h2>Últimos commits</h2>{git()}
<script>
setInterval(function(){{var a=document.activeElement;var typing=a&&(a.tagName==='INPUT'||a.tagName==='SELECT')&&(a.value||a.tagName==='SELECT');var u=document.querySelector('input[name=url]');if(!typing&&!(u&&u.value))location.reload();}},20000);
var s=document.querySelector('select[name=playlist]'),n=document.querySelector('input[name=nova]');function tog(){{n.style.display=s.value==='__nova__'?'':'none';}}s.addEventListener('change',tog);tog();
</script></body></html>"""


def loop():
    while True:
        try:
            PAGE["html"] = render()
        except Exception as e:
            PAGE["html"] = f"<pre>erro no gerador: {html.escape(repr(e))}</pre>"
        time.sleep(15)


class H(BaseHTTPRequestHandler):
    def _send(self, data, code=200, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path != f"/{TOKEN}":
            return self._send(b"", 404)
        self._send(PAGE["html"].encode())

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        if path != f"/{TOKEN}/fila":
            return self._send(b"", 404)
        n = int(self.headers.get("Content-Length") or 0)
        form = urllib.parse.parse_qs(self.rfile.read(n).decode("utf-8", "ignore"))
        url = (form.get("url") or [""])[0]
        playlist = (form.get("playlist") or [""])[0]
        if playlist == "__nova__":
            playlist = (form.get("nova") or [""])[0]
        err = enfileira(url, playlist)
        PAGE["html"] = render(err or "")
        self._send(b"", 303, {"Location": f"/{TOKEN}"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
