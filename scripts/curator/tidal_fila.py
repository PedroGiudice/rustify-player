#!/usr/bin/env python3
"""Fila de downloads da Tidal para o CEO (fora da tailnet), com índice/MERT/vibe e últimos commits.
Gera um HTML a cada 15 s e serve em 127.0.0.1:8470 sob um caminho secreto (token em
~/.secrets/telemetria-token.txt; exposto por `tailscale funnel --https=10000`).
POST /<token>/fila com url+playlist enfileira um download na VM: o worker roda
scripts/curator/tidal_mix_dl.py (um lote por vez), que na VM já envia cada faixa para
cmr-auto:~/Music, apaga o staging e dá touch remoto; o progresso e o resultado aparecem na página.
API JSON para o app (seção Tidal do Crate, pela tailnet em TAILNET_IP:8470, mesmo token):
  GET  /<token>/api/fila                      -> {"jobs":[...], "pastas":[...]}
  POST /<token>/api/fila  {"url","playlist"}  -> {"ok":true,"id":...} | {"error":"..."} (400)
  POST /<token>/api/fila  {"faixas":[ids],"titulo","origem","playlist"}  (seleção da prévia, máx. 200)
  GET  /<token>/api/busca?q=                  -> {q, top, faixas[], albuns[], artistas[], playlists[]}
  GET  /<token>/api/artista/<id>              -> {id, nome, foto, populares[], albuns[], eps_singles[], radio}
  GET  /<token>/api/previa?ref=               -> {tipo, titulo, ref, faixas[], duracao_s}
As rotas de busca/artista/prévia falam com a Tidal (tidalapi, sessão PKCE só lida, nunca regravada)
e guardam a resposta 5 min em memória. Sessão inválida -> 503; texto curto ou ref inválida -> 400.
Rodar na VM (a busca precisa do tidalapi; sem ele a fila segue funcionando e a busca devolve 503):
  tmux new -d -s telemetria 'uv run --with tidalapi --with mutagen python3 ~/rustify-player/scripts/curator/tidal_fila.py'
Instância de teste ao lado da real: --port 8471 --bind 127.0.0.1 --out /tmp/x (fila.json própria).
"""
import argparse
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
TOKEN_FILE = Path(os.path.expanduser("~/.secrets/telemetria-token.txt"))
try:
    TOKEN = TOKEN_FILE.read_text().strip()
except OSError:  # testes importam o módulo sem o segredo; o __main__ exige o token
    TOKEN = ""
PORT = 8470
TAILNET_IP = "100.64.242.118"  # o app na cmr-auto fala por aqui; o Funnel 10000 cobre o loopback
OUT = Path(os.path.expanduser("~/tidal-out"))
LOGS = OUT / "logs"
FILA = OUT / "fila.json"
SCRIPT = Path(REPO) / "scripts" / "curator" / "tidal_mix_dl.py"
UV = os.path.expanduser("~/.local/bin/uv")
URL_RE = re.compile(r"^https?://(listen\.|www\.)?tidal\.com/(browse/)?(mix|playlist|album|track)/[A-Za-z0-9-]+")
PAGE = {"html": "<p>gerando...</p>"}
LOCK = threading.Lock()
PASTAS = {"at": 0.0, "lista": ["Funk Brasileiro", "Rap & Hip-Hop", "Jazz"]}
MAX_FAIXAS = 200
SECRET = Path(os.path.expanduser("~/.secrets/tidal-pkce.json"))
CACHE_TTL = 300


def sh(cmd, timeout=20):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout
    except Exception as e:
        return f"erro: {e!r}"


# ---------- fila ----------
def load_fila():
    try:
        with open(FILA) as f:
            return json.load(f)
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
    playlist = limpa_pasta(playlist)
    if not playlist:
        return "pasta vazia"
    with LOCK:
        jobs = load_fila()
        if any(j["url"] == url and not j.get("faixas") and j["status"] in ("fila", "baixando") for j in jobs):
            return "esse link já está na fila"
        jobs.append(novo_job(jobs, url, playlist))
        save_fila(jobs)
    return None


def novo_job(jobs, url, playlist, **extra):
    """Job novo com id único (dois pedidos no mesmo segundo não dividem o log)."""
    base = datetime.now().strftime("%Y%m%d-%H%M%S")
    ids = {j["id"] for j in jobs}
    jid, n = base, 1
    while jid in ids:
        n += 1
        jid = f"{base}-{n}"
    return {"id": jid, "url": url, "playlist": playlist, "status": "fila", "added": datetime.now().strftime("%d/%m %H:%M"),
            "log": str(LOGS / f"{jid}.log"), "resumo": "", **extra}


def limpa_pasta(playlist):
    return re.sub(r"[^\w &'\-.]+", " ", str(playlist or ""), flags=re.U).strip()[:60]


def valida_selecao(body):
    """Pura. Valida o POST de seleção. Devolve (erro, None) ou (None, {faixas, titulo, origem, playlist})."""
    faixas = body.get("faixas")
    if not isinstance(faixas, list) or not faixas:
        return "nenhuma faixa selecionada", None
    ids = []
    for f in faixas:
        if isinstance(f, bool) or not (isinstance(f, int) or (isinstance(f, str) and f.strip().isdigit())):
            return f"id de faixa inválido: {f!r}", None
        n = int(f)
        if n <= 0:
            return f"id de faixa inválido: {f!r}", None
        if n not in ids:
            ids.append(n)
    if len(ids) > MAX_FAIXAS:
        return f"no máximo {MAX_FAIXAS} faixas por pedido ({len(ids)})", None
    playlist = limpa_pasta(body.get("playlist"))
    if not playlist:
        return "pasta vazia", None
    titulo = re.sub(r"\s+", " ", str(body.get("titulo") or "")).strip()[:120] or "Seleção"
    origem = re.sub(r"[^\w:.\-]+", "", str(body.get("origem") or ""), flags=re.U)[:80] or "busca"
    return None, {"faixas": ids, "titulo": titulo, "origem": origem, "playlist": playlist}


def link_da_origem(origem):
    """Pura. `mix:<id>` etc. -> link da Tidal (página web e "copiar link" do app); outro -> ""."""
    m = re.fullmatch(r"(mix|playlist|album|faixa|radio-faixa):([A-Za-z0-9-]+)", origem or "")
    if not m:
        return ""
    kind = {"faixa": "track", "radio-faixa": "track"}.get(m.group(1), m.group(1))
    return f"https://tidal.com/browse/{kind}/{m.group(2)}"


def enfileira_selecao(body):
    err, sel = valida_selecao(body)
    if err:
        return err, None
    with LOCK:
        jobs = load_fila()
        if any(j.get("faixas") == sel["faixas"] and j["playlist"] == sel["playlist"] and j["status"] in ("fila", "baixando") for j in jobs):
            return "essa seleção já está na fila", None
        job = novo_job(jobs, link_da_origem(sel["origem"]), sel["playlist"], faixas=sel["faixas"], titulo=sel["titulo"],
                       origem=sel["origem"])
        jobs.append(job)
        save_fila(jobs)
    return None, job["id"]


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
    letras = next((l.split("LETRAS ")[1].split(" ")[0] for l in lines if l.startswith("NOVAS") and "LETRAS " in l), None)
    txt = f"{titulo}: {n} novas, {s} já no acervo, {f} falhas de {total}"
    if letras and letras != "0":
        txt += f"; {letras} com letra"
    if env:
        txt += f"; {env} na cmr-auto"
    if nao:
        txt += f"; {nao} NÃO chegaram (ficaram na VM)"
    return txt


def alvo_do_job(job):
    """Pura. Argumentos do baixador: o link (job de link) ou --ids/--titulo/--origem (job de seleção)."""
    if job.get("faixas"):
        return ["--ids", ",".join(str(i) for i in job["faixas"]), "--titulo", job.get("titulo") or "Seleção",
                "--origem", job.get("origem") or "busca"]
    return [job["url"]]


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
            rc = subprocess.run([UV, "run", "--with", "tidalapi", "--with", "mutagen", "python3", str(SCRIPT)] + alvo_do_job(job)
                                + ["--playlist", job["playlist"]], stdout=lf, stderr=subprocess.STDOUT, cwd=str(OUT)).returncode
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


def rotulo_html(j):
    if j.get("faixas"):
        return f"{html.escape(j.get('titulo') or 'Seleção')} <small>({len(j['faixas'])} faixas escolhidas)</small>"
    return f"<a href='{html.escape(j['url'])}' target='_blank' rel='noopener'>{html.escape(j['url'].split('tidal.com/')[-1])}</a>"


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
        rows.append(f"<tr><td><span class='st {cls}'>{st}</span></td><td>{html.escape(j['playlist'])}</td><td>{rotulo_html(j)}<br><small>{html.escape(resumo)}</small></td><td><small>{html.escape(j.get('added', ''))}</small></td></tr>")
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

# ---------- busca na Tidal (aba Tidal do Crate) ----------
TIDAL_LOCK = threading.Lock()  # uma chamada à Tidal por vez: a sessão do tidalapi não é thread-safe no refresh
SESS = {"s": None}
CACHE: dict = {}
SESSAO_EXPIRADA = "sessão da Tidal expirada"


class TidalErro(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


def tidal_session():
    """Sessão PKCE carregada uma vez e reaproveitada. Só LÊ o arquivo: quem renova e regrava é o
    baixador (gravar daqui também poderia corromper o JSON com duas escritas ao mesmo tempo)."""
    if SESS["s"] is not None:
        return SESS["s"]
    try:
        import tidalapi
    except ImportError:
        raise TidalErro(503, "busca indisponível: a fila precisa rodar com uv run --with tidalapi")
    sess = tidalapi.Session()
    try:
        ok = sess.load_session_from_file(SECRET) and sess.check_login()
    except Exception:
        ok = False
    if not ok:
        raise TidalErro(503, SESSAO_EXPIRADA)
    SESS["s"] = sess
    return sess


def _erro_da_tidal(e):
    """Exceção do tidalapi/requests -> TidalErro com código HTTP e texto para a tela."""
    if isinstance(e, TidalErro):
        return e
    nome = type(e).__name__
    resp = getattr(e, "response", None)
    code = getattr(resp, "status_code", None)
    if nome in ("ObjectNotFound",) or code == 404:
        return TidalErro(404, "não encontrado na Tidal")
    if nome in ("AuthenticationError",) or code in (401, 403):
        SESS["s"] = None
        return TidalErro(503, SESSAO_EXPIRADA)
    if nome == "TooManyRequests" or code == 429:
        return TidalErro(503, "a Tidal pediu para esperar (muitas buscas); tente em 1 minuto")
    return TidalErro(502, f"Tidal sem resposta ({nome})")


def com_cache(chave, fn):
    agora = time.time()
    hit = CACHE.get(chave)
    if hit and agora - hit[0] < CACHE_TTL:
        return hit[1]
    with TIDAL_LOCK:
        try:
            val = fn(tidal_session())
        except Exception as e:
            raise _erro_da_tidal(e)
    if len(CACHE) > 500:
        for k in [k for k, (t, _) in CACHE.items() if agora - t >= CACHE_TTL]:
            CACHE.pop(k, None)
    CACHE[chave] = (agora, val)
    return val


def _img(obj, size=320):
    try:
        return obj.image(size) if obj is not None else None
    except Exception:
        return None


def _ano(alb):
    rd = getattr(alb, "release_date", None) if alb is not None else None
    if rd:
        return rd.year
    y = getattr(alb, "year", None) if alb is not None else None
    return int(y) if isinstance(y, int) or (isinstance(y, str) and y.isdigit()) else None


def _hires(*objs):
    return any("HIRES_LOSSLESS" in (getattr(o, "media_metadata_tags", None) or []) for o in objs if o is not None)


def _titulo(t):
    name = (t.name or "").strip()
    ver = (getattr(t, "version", None) or "").strip()
    return f"{name} ({ver})" if ver and ver.lower() not in name.lower() else name


def faixa_json(t):
    alb = getattr(t, "album", None)
    arts = [a.name for a in (getattr(t, "artists", None) or []) if getattr(a, "name", None)]
    if not arts and getattr(t, "artist", None) is not None:
        arts = [t.artist.name]
    return {"id": int(t.id), "titulo": _titulo(t), "artistas": arts, "album": getattr(alb, "name", None) or "",
            "album_id": int(alb.id) if alb is not None and getattr(alb, "id", None) else None, "ano": _ano(alb),
            "duracao_s": int(getattr(t, "duration", 0) or 0), "hires": _hires(t), "capa": _img(alb),
            "url": f"https://tidal.com/browse/track/{t.id}"}


def album_json(a):
    tipo = str(getattr(a, "type", None) or "ALBUM").lower()
    return {"id": int(a.id), "titulo": a.name, "artista": getattr(getattr(a, "artist", None), "name", None) or "",
            "ano": _ano(a), "n_faixas": int(getattr(a, "num_tracks", 0) or 0), "duracao_s": int(getattr(a, "duration", 0) or 0),
            "hires": _hires(a), "tipo": tipo if tipo in ("album", "ep", "single") else "album", "capa": _img(a),
            "url": f"https://tidal.com/browse/album/{a.id}"}


def artista_json(a):
    return {"id": int(a.id), "nome": a.name, "foto": _img(a), "url": f"https://tidal.com/browse/artist/{a.id}"}


def playlist_json(p):
    criador = getattr(getattr(p, "creator", None), "name", None)
    return {"id": str(p.id), "titulo": p.name, "n_faixas": int(getattr(p, "num_tracks", 0) or 0),
            "duracao_s": int(getattr(p, "duration", 0) or 0), "autor": criador or None, "capa": _img(p),
            "url": f"https://tidal.com/browse/playlist/{p.id}"}


_TIPO_TOP = {"Track": "faixa", "Album": "album", "Artist": "artista", "Playlist": "playlist", "UserPlaylist": "playlist"}


def busca_json(r, q):
    """Pura sobre o objeto do tidalapi (testável com objetos falsos). Vídeos ficam de fora."""
    so = lambda nome, lst: [x for x in (lst or []) if type(x).__name__ in nome]  # noqa: E731
    top = r.get("top_hit")
    tipo_top = _TIPO_TOP.get(type(top).__name__) if top is not None else None
    return {"q": q, "top": {"tipo": tipo_top, "id": str(top.id)} if tipo_top else None,
            "faixas": [faixa_json(t) for t in so(("Track",), r.get("tracks"))][:10],
            "albuns": [album_json(a) for a in so(("Album",), r.get("albums"))][:10],
            "artistas": [artista_json(a) for a in so(("Artist",), r.get("artists"))][:10],
            "playlists": [playlist_json(p) for p in so(("Playlist", "UserPlaylist"), r.get("playlists"))][:10]}


def api_busca(q):
    q = re.sub(r"\s+", " ", q or "").strip()
    if len(q) < 2:
        raise TidalErro(400, "digite ao menos 2 caracteres")
    return com_cache(("busca", q.lower()), lambda s: busca_json(s.search(q[:100], limit=10), q))


def api_artista(ident):
    if not str(ident).isdigit():
        raise TidalErro(400, "id de artista inválido")

    def pega(s):
        a = s.artist(int(ident))
        try:
            mx = a.get_radio_mix()
            radio = {"mix_id": str(mx.id), "n_faixas": len([i for i in mx.items() if type(i).__name__ == "Track"])}
        except Exception:
            radio = None
        return {**artista_json(a), "populares": [faixa_json(t) for t in a.get_top_tracks(limit=10)],
                "albuns": [album_json(x) for x in a.get_albums()], "eps_singles": [album_json(x) for x in a.get_ep_singles()],
                "radio": radio}

    return com_cache(("artista", str(ident)), pega)


_PREVIA_RE = re.compile(r"(mix|playlist|album|faixa|radio-faixa):([A-Za-z0-9-]+)")
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_LINK_RE = re.compile(r"tidal\.com/(?:browse/)?(mix|playlist|album|track)/([A-Za-z0-9-]+)")


def ref_da_previa(ref):
    """Pura. Link da Tidal ou `tipo:id` -> forma canônica `tipo:id` (tipo em mix|playlist|album|faixa|radio-faixa).
    TidalErro 400 se não reconhecer."""
    ref = (ref or "").strip()
    m = _PREVIA_RE.fullmatch(ref)
    if m:
        kind, ident = m.group(1), m.group(2)
    else:
        mt = re.search(r"tidal\.com/.*?/track/(\d+)", ref)
        ml = _LINK_RE.search(ref)
        if mt:
            kind, ident = "faixa", mt.group(1)
        elif ml:
            kind, ident = {"track": "faixa"}.get(ml.group(1), ml.group(1)), ml.group(2)
        else:
            raise TidalErro(400, "referência não reconhecida: use um link da Tidal ou mix:/playlist:/album:/radio-faixa:<id>")
    if kind in ("album", "faixa", "radio-faixa") and not ident.isdigit():
        raise TidalErro(400, f"id inválido para {kind}")
    if kind == "playlist" and not _UUID_RE.fullmatch(ident):
        raise TidalErro(400, "id de playlist inválido")
    return f"{kind}:{ident}"


def _todas(fn, total, passo=100, teto=500):
    """Página por página até `total` (playlist grande: a API não devolve tudo de uma vez)."""
    out = []
    while len(out) < min(total or teto, teto):
        lote = fn(limit=passo, offset=len(out))
        if not lote:
            break
        out.extend(lote)
    return out


def api_previa(ref):
    canon = ref_da_previa(ref)
    kind, ident = canon.split(":", 1)

    def pega(s):
        if kind == "mix":
            mx = s.mix(ident)
            mt = getattr(mx, "mix_type", None)
            mt = str(getattr(mt, "value", mt) or "")  # enum MixType: o valor é "ARTIST_MIX", "TRACK_MIX"...
            tipo = "radio" if ("ARTIST" in mt or "TRACK" in mt) else "mix"
            titulo = getattr(mx, "title", None) or "Mix"
            titulo, itens = (f"Rádio de {titulo}" if tipo == "radio" else titulo), mx.items()
        elif kind == "playlist":
            pl = s.playlist(ident)
            tipo, titulo, itens = "playlist", pl.name, _todas(pl.tracks, getattr(pl, "num_tracks", 0))
        elif kind == "album":
            alb = s.album(int(ident))
            tipo, titulo, itens = "album", f"{alb.artist.name} - {alb.name}", alb.tracks()
        elif kind == "faixa":
            t = s.track(int(ident))
            tipo, titulo, itens = "faixa", f"{t.artist.name} - {t.name}", [t]
        else:
            t = s.track(int(ident))
            mx = t.get_radio_mix()
            tipo, titulo, itens = "radio", f"Rádio de {t.name}", mx.items()
        faixas = [faixa_json(t) for t in itens if type(t).__name__ == "Track"]
        return {"tipo": tipo, "titulo": titulo, "ref": canon, "faixas": faixas, "duracao_s": sum(f["duracao_s"] for f in faixas)}

    return com_cache(("previa", canon), pega)


def api_get(rota, query):
    """Roteia o GET da API da Tidal. Devolve (código, corpo). Pura sobre a sessão (testes trocam tidal_session)."""
    try:
        if rota == "busca":
            return 200, api_busca((query.get("q") or [""])[0])
        if rota.startswith("artista/"):
            return 200, api_artista(rota.split("/", 1)[1])
        if rota == "previa":
            return 200, api_previa((query.get("ref") or [""])[0])
    except TidalErro as e:
        return e.code, {"error": e.msg}
    return 404, {"error": "rota desconhecida"}


def api_post_fila(body):
    """POST da fila: o de link `{url, playlist}` ou o de seleção `{faixas, titulo, origem, playlist}`. (código, corpo)."""
    if not isinstance(body, dict):
        return 400, {"error": "JSON inválido"}
    if "faixas" in body:
        err, jid = enfileira_selecao(body)
        return (400, {"error": err}) if err else (200, {"ok": True, "id": jid})
    err = enfileira(str(body.get("url") or ""), str(body.get("playlist") or ""))
    if err:
        return 400, {"error": err}
    with LOCK:
        jobs = load_fila()
    return 200, {"ok": True, "id": jobs[-1]["id"]}


def job_publico(j):
    """O que o app recebe de um job: sem o caminho do log e com a contagem no lugar da lista de ids."""
    j = dict(j)
    j.pop("log", None)
    faixas = j.pop("faixas", None)
    if faixas:
        j["n_faixas"] = len(faixas)
    return j


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

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path, _, qs = self.path.partition("?")
        path = path.rstrip("/")
        if path == f"/{TOKEN}/api/fila":
            with LOCK:
                jobs = load_fila()
            for j in jobs:
                if j["status"] == "baixando" and not j.get("resumo"):
                    j["resumo"] = resumo_do_log(j["log"])
            return self._json({"jobs": [job_publico(j) for j in jobs[-30:]], "pastas": pastas()})
        prefixo = f"/{TOKEN}/api/"
        if path.startswith(prefixo):
            code, body = api_get(path[len(prefixo):], urllib.parse.parse_qs(qs))
            return self._json(body, code)
        if path != f"/{TOKEN}":
            return self._send(b"", 404)
        self._send(PAGE["html"].encode())

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8", "ignore")
        if path == f"/{TOKEN}/api/fila":
            try:
                body = json.loads(raw or "{}")
            except Exception:
                return self._json({"error": "JSON inválido"}, 400)
            code, resp = api_post_fila(body)
            return self._json(resp, code)
        if path != f"/{TOKEN}/fila":
            return self._send(b"", 404)
        form = urllib.parse.parse_qs(raw)
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
    ap = argparse.ArgumentParser(description="fila de downloads da Tidal (página + API do Crate)")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--bind", default=f"127.0.0.1,{TAILNET_IP}", help="IPs separados por vírgula (padrão: loopback + tailnet)")
    ap.add_argument("--out", default=str(OUT), help="pasta da fila.json, dos logs e cwd do baixador (padrão ~/tidal-out)")
    args = ap.parse_args()
    if not TOKEN:
        raise SystemExit(f"sem token em {TOKEN_FILE}")
    PORT = args.port
    OUT = Path(os.path.expanduser(args.out))
    LOGS = OUT / "logs"
    FILA = OUT / "fila.json"
    OUT.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()
    ips = [ip.strip() for ip in args.bind.split(",") if ip.strip()]
    for ip in ips[1:]:
        try:
            srv = ThreadingHTTPServer((ip, PORT), H)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        except OSError as e:
            print(f"sem bind em {ip}:{PORT}: {e!r}", flush=True)
    ThreadingHTTPServer((ips[0], PORT), H).serve_forever()
