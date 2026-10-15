#!/usr/bin/env python3
"""Baixa todas as faixas de um mix ou playlist da Tidal em qualidade máxima, direto para
~/Music/<playlist>/<Artista do álbum>/<Álbum> [tidal]/NN Título.flac, com tags da Tidal e capa.
A marca " [tidal]" no nome da pasta é o que mantém tudo isso fora do share do slskd.

Roda NA cmr-auto (acervo local) ou NA VM (staging + envio para a cmr-auto):
  uv run --with tidalapi --with mutagen --with numpy python3 tidal_mix_dl.py <link> --list
  uv run --with tidalapi --with mutagen --with numpy python3 tidal_mix_dl.py <link> [--playlist "Funk Brasileiro"] [--genre G]
  uv run --with tidalapi --with mutagen --with numpy python3 tidal_mix_dl.py --ids 1,2,3 --titulo "Rádio Orochi" --origem mix:<id>
O modo --ids (seleção da prévia do Crate) baixa exatamente essas faixas pelo mesmo caminho do link
(dedup, envio, .lrc, rc=2) e grava COMMENT "source: tidal <tier>; selecao <origem>".
Na VM (hostname extractlab) o envio é AUTOMÁTICO, sem flag: staging em ~/tidal-out, dedup pelo túnel
16333 (aberto sozinho se estiver caído), cada faixa vai por rsync para cmr-auto:~/Music assim que fica
pronta (3 tentativas), a cópia local é apagada depois que chegou, e no fim um `touch` remoto acorda o
watcher. Se a cmr-auto não responder, o script aborta ANTES de baixar. TIDAL_PUSH=off ou --no-push
desligam; TIDAL_PUSH=<host:dir> troca o destino. A sessão PKCE (~/.secrets/tidal-pkce.json) é a mesma
nas duas máquinas; o refresh não rotaciona o token.

Portão de qualidade (decisão do CEO, 15/10/2026: só entra lossless de verdade, medido pelo CONTEÚDO):
depois de remuxar para FLAC e ANTES de renomear para o destino (o watcher e o rsync nunca veem o arquivo),
o detector de corte espectral (quality_audit.py via lossless_gate.py; precisa de numpy) mede a faixa.
Corte de lossy = linha `RECUSADA (lossy por dentro, corte X,X kHz)`: o arquivo é apagado, nada é enviado,
a faixa vai para `recusadas` no relatório mix_<id>.json e para o cache de recusas (JSON no staging,
`~/tidal-out/recusadas.json` na VM, `~/.cache/tidal-spike/recusadas.json` fora dela; TIDAL_REFUSED_CACHE
troca), chave = id da faixa na Tidal, para não baixar de novo a cada execução (`JÁ RECUSADA`). Apagar a
entrada (ou o arquivo) força a reavaliação. Recusada NÃO é falha: rc continua 0 (rc=2 é só "não enviadas");
o resumo final traz `RECUSADAS n (lossy por dentro)`. Falha da análise não bloqueia: a faixa entra e o
motivo é impresso.
"""
import argparse
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

import tidalapi

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lossless_gate import Verdict, check_file, require  # noqa: E402
from normalize_release import _prepare_cover, _write_tags, loose, safe_name  # noqa: E402

SECRET = os.path.expanduser("~/.secrets/tidal-pkce.json")
WORK = Path(os.path.expanduser("~/.cache/tidal-spike/mixwork"))
GENRE = "Funk Brasileiro"
PAUSE_S = 2
VM_HOSTNAME = "extractlab"
CMR_SSH = "cmr-auto@100.102.249.9"
TUNNEL_PORT = 16333
PUSH_RETRY_S = (5, 20, 60)


def vm_defaults(hostname: str, env: dict) -> dict:
    """Decide onde é o acervo, qual Qdrant dedupa e para onde enviar. Pura, para teste.
    Na VM o envio é o padrão: staging ~/tidal-out, Qdrant pelo túnel 16333, rsync para a cmr-auto.
    Na cmr-auto (ou em qualquer outra máquina) o acervo é local e não há envio."""
    on_vm = hostname == VM_HOSTNAME
    music = env.get("TIDAL_MUSIC_ROOT") or ("~/tidal-out" if on_vm else "~/Music")
    qdrant = env.get("TIDAL_QDRANT") or (f"http://127.0.0.1:{TUNNEL_PORT}" if on_vm else "http://127.0.0.1:6333")
    push = env.get("TIDAL_PUSH")
    if push is None:
        push = f"{CMR_SSH}:Music" if on_vm else ""
    if push.strip().lower() in ("off", "0", "no", "none"):
        push = ""
    refused = env.get("TIDAL_REFUSED_CACHE") or ("~/tidal-out/recusadas.json" if on_vm else "~/.cache/tidal-spike/recusadas.json")
    return {"music": music, "qdrant": qdrant, "push": push, "on_vm": on_vm, "refused": refused}


_DEF = vm_defaults(socket.gethostname(), os.environ)
MUSIC = Path(os.path.expanduser(_DEF["music"]))
QDRANT = _DEF["qdrant"]
REFUSED_CACHE = Path(os.path.expanduser(_DEF["refused"]))


def load_session() -> tidalapi.Session:
    """Sessão PKCE (formato do tidalapi). O login por device code (OAuth) só entrega HIGH/AAC
    para faixas sem hi-res (python-tidal #404); o PKCE entrega LOSSLESS e HI_RES_LOSSLESS em DASH/FLAC."""
    p = Path(SECRET)
    sess = tidalapi.Session()
    assert sess.load_session_from_file(p) and sess.check_login(), "sessão PKCE inválida: rode tidal_login_pkce.py"
    sess.save_session_to_file(p)  # persiste o token renovado
    os.chmod(p, 0o600)
    sess.audio_quality = tidalapi.Quality.hi_res_lossless
    return sess


def fetch(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        while True:
            b = r.read(1 << 18)
            if not b:
                break
            f.write(b)


# O que NÃO é marca de versão e pode sair do título antes de comparar: créditos ("feat.") e "Remastered".
# Remix, live, ao vivo, acústico, versão, edit, mix, instrumental continuam distinguindo a faixa.
# A tela (src/lib/tidalSearch.ts, `titleKey`) usa a mesma regra: manter as duas iguais.
_CREDITO = re.compile(r"(?:feat|ft|featuring|prod|part|participacao)\b\.?.*")
_NEUTRO = re.compile(r"(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?|explicit|bonus track")


def title_key(title: str) -> str:
    """Pura. Chave frouxa do título para o 'JÁ NO ACERVO': sem acentos, sem créditos/remaster, sem pontuação."""
    t = unicodedata.normalize("NFD", title or "")
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()

    def neutro(inner: str) -> bool:
        inner = inner.strip()
        return bool(_CREDITO.fullmatch(inner) or _NEUTRO.fullmatch(inner))

    t = re.sub(r"\(([^()]*)\)|\[([^\[\]]*)\]", lambda m: " " if neutro(m.group(1) if m.group(1) is not None else m.group(2)) else m.group(0), t)
    t = re.sub(r"\s+-\s+(.*)$", lambda m: " " if neutro(m.group(1)) else m.group(0), t)
    t = re.sub(r"\s+(?:feat\.?|ft\.?|featuring)\s+.*$", " ", t)
    return loose(t)


def split_artists(s: str) -> list[str]:
    parts = re.split(r",|&| e | feat\.? | ft\.? | x ", s, flags=re.I)
    return [loose(p) for p in parts if loose(p)]


def qdrant_alive() -> bool:
    try:
        with urllib.request.urlopen(f"{QDRANT}/collections/rustify_tracks", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def ensure_tunnel() -> None:
    """Na VM o Qdrant da cmr-auto só existe pelo túnel SSH (loopback-only desde o hardening 2026-07-17).
    Idempotente: se a porta já responde, não faz nada; senão abre o túnel e espera ele responder."""
    if qdrant_alive():
        return
    if not _DEF["on_vm"]:
        raise SystemExit(f"Qdrant não responde em {QDRANT}; o app precisa estar aberto (sidecar) ou TIDAL_QDRANT errado")
    print(f"túnel {TUNNEL_PORT} caído, abrindo para {CMR_SSH}...", flush=True)
    subprocess.run(["ssh", "-f", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=15",
                    "-L", f"{TUNNEL_PORT}:localhost:6333", CMR_SSH])
    for _ in range(10):
        if qdrant_alive():
            return
        time.sleep(1)
    raise SystemExit(f"Qdrant da cmr-auto não respondeu pelo túnel {TUNNEL_PORT}: a cmr-auto está ligada e o app aberto?")


def remote_rels(push: str) -> set[str]:
    """Caminhos relativos dos FLAC [tidal] já na cmr-auto: cobre a janela entre o rsync e a indexação
    (app fechado = Qdrant ainda não conhece a faixa) e prova, antes de baixar, que a cmr-auto responde."""
    host, _, remote_dir = push.partition(":")
    cmd = f"cd {shlex.quote(remote_dir)} && find . -type f -name '*.flac' -path '*[[]tidal[]]*'"
    out = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, cmd],
                         capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise SystemExit(f"cmr-auto não respondeu ({host}, rc={out.returncode}): {out.stderr.strip()[:200]} -- nada baixado")
    return {l[2:] if l.startswith("./") else l for l in out.stdout.splitlines() if l.strip()}


def library_keys() -> set[tuple[str, str]]:
    """(título, artista) soltos de tudo que já está no acervo, para não baixar de novo."""
    ensure_tunnel()
    keys: set[tuple[str, str]] = set()
    offset = None
    while True:
        body = {"limit": 1000, "with_payload": ["title", "artist", "album_artist"], "with_vector": False}
        if offset is not None:
            body["offset"] = offset
        req = urllib.request.Request(f"{QDRANT}/collections/rustify_tracks/points/scroll", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            res = json.load(r)["result"]
        for p in res["points"]:
            pl = p.get("payload") or {}
            t = title_key(str(pl.get("title") or ""))
            if not t:  # título sem letra latina: a chave vazia casaria qualquer faixa do artista
                continue
            for a in split_artists(str(pl.get("artist") or "")) + split_artists(str(pl.get("album_artist") or "")):
                keys.add((t, a))
        offset = res.get("next_page_offset")
        if offset is None:
            break
    return keys


MAX_IDS = 200
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
# Forma curta "tipo:id" usada pela fila (prévia e origem de seleção); "faixa" e "radio-faixa"
# são os nomes em PT-BR que a tela usa.
_PREFIX = {"mix": "mix", "playlist": "playlist", "album": "album", "faixa": "track", "track": "track",
           "radio-faixa": "radio-track"}


def parse_ref(ref: str) -> tuple[str, str]:
    """Pura. Link da Tidal (mix, playlist, álbum, faixa), forma curta `tipo:id` ou id cru ->
    (kind, ident), kind em mix|playlist|album|track|radio-track. ValueError se não reconhecer."""
    ref = ref.strip()
    mp = re.fullmatch(r"(mix|playlist|album|faixa|track|radio-faixa):([A-Za-z0-9-]+)", ref)
    mt = re.search(r"tidal\.com/.*?/track/(\d+)", ref)  # "album/<a>/track/<t>" = compartilhar faixa: só a faixa
    m = re.search(r"tidal\.com/(?:browse/)?(mix|playlist|album|track)/([A-Za-z0-9-]+)", ref)
    if mp:
        kind, ident = _PREFIX[mp.group(1)], mp.group(2)
    elif mt:
        kind, ident = "track", mt.group(1)
    elif m:
        kind, ident = m.group(1), m.group(2)
    elif re.fullmatch(_UUID, ref):
        kind, ident = "playlist", ref
    elif re.fullmatch(r"[0-9a-f]{20,40}", ref):
        kind, ident = "mix", ref
    elif re.fullmatch(r"[0-9]+", ref):
        kind, ident = "album", ref
    else:
        raise ValueError(f"referência não reconhecida: {ref}")
    if kind in ("album", "track", "radio-track") and not re.fullmatch(r"\d{1,19}", ident, re.ASCII):
        raise ValueError(f"id inválido para {kind}: {ident}")
    if kind == "playlist" and not re.fullmatch(_UUID, ident):
        raise ValueError(f"id de playlist inválido: {ident}")
    return kind, ident


def parse_ids(raw: str) -> list[int]:
    """Pura. "1,2, 3" -> [1, 2, 3], sem repetidos e na ordem dada; 1 a MAX_IDS ids numéricos."""
    out: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if not re.fullmatch(r"\d{1,19}", part, re.ASCII):  # isdigit() aceitaria "²" e "١٢٣"
            raise ValueError(f"id de faixa inválido: {part!r}")
        n = int(part)
        if n not in out:
            out.append(n)
    if not out:
        raise ValueError("nenhum id de faixa")
    if len(out) > MAX_IDS:
        raise ValueError(f"no máximo {MAX_IDS} faixas por pedido ({len(out)})")
    return out


def load_refused(path: Path) -> dict[str, dict]:
    """Cache de recusas {id da faixa na Tidal (str): {titulo, artista, cutoff_hz, quando}}.
    Ausente ou corrompido = vazio (pior caso: mede a faixa de novo)."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {str(k): v for k, v in data.items() if isinstance(v, dict)} if isinstance(data, dict) else {}


def save_refused(path: Path, cache: dict[str, dict]) -> None:
    """Grava por arquivo temporário + rename: queda no meio não deixa JSON pela metade."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def is_refused(cache: dict[str, dict], track_id) -> bool:
    return str(track_id) in cache


def record_refused(cache: dict[str, dict], track_id, titulo: str, artista: str, cutoff_hz: int | None) -> None:
    cache[str(track_id)] = {"titulo": titulo, "artista": artista, "cutoff_hz": cutoff_hz,
                            "quando": time.strftime("%Y-%m-%d %H:%M:%S")}


def comment_for(quality: str, mix_ref: str | None, origem: str | None) -> str:
    """Pura. COMMENT gravado no FLAC: de onde a faixa veio (mix/link inteiro ou seleção)."""
    if mix_ref:
        return f"source: tidal {quality.lower()}; mix {mix_ref}"
    return f"source: tidal {quality.lower()}; selecao {origem or 'manual'}"


def resolve_items(sess: tidalapi.Session, ref: str):
    """Aceita link da Tidal (mix, playlist, álbum ou faixa), `tipo:id` ou o id cru. Devolve (título, itens)."""
    try:
        kind, ident = parse_ref(ref)
    except ValueError as e:
        raise SystemExit(str(e))
    if kind == "mix":
        mix = sess.mix(ident)
        return getattr(mix, "title", ident), mix.items()
    if kind == "playlist":
        pl = sess.playlist(ident)
        return pl.name, pl.tracks()
    if kind == "album":
        alb = sess.album(int(ident))
        return f"{alb.artist.name} - {alb.name}", alb.tracks()
    t = sess.track(int(ident))
    if kind == "radio-track":
        mix = t.get_radio_mix()
        return f"Rádio de {t.name}", mix.items()
    return f"{t.artist.name} - {t.name}", [t]


def resolve_ids(sess: tidalapi.Session, ids: list[int]):
    """Modo seleção: as faixas exatamente como o CEO marcou. Id que a Tidal não devolve vira
    linha FALHOU (conta no resumo da fila) em vez de derrubar o lote."""
    out, failed = [], []
    for i, tid in enumerate(ids, 1):
        try:
            out.append(sess.track(tid))
        except Exception as e:
            print(f"{i:3d} faixa {tid} FALHOU (não achada na Tidal): {e!r}", flush=True)
            failed.append({"i": i, "title": str(tid), "err": repr(e)})
    return out, failed


def track_title(t) -> str:
    name = t.name.strip()
    ver = (getattr(t, "version", None) or "").strip()
    if ver and ver.lower() not in name.lower():
        name = f"{name} ({ver})"
    return name


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                          "stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample:format=format_name,duration",
                          "-of", "json", str(path)], capture_output=True, text=True)
    pj = json.loads(out.stdout or "{}")
    s = (pj.get("streams") or [{}])[0]
    return {"codec": s.get("codec_name"), "bits": s.get("bits_per_raw_sample") or s.get("bits_per_sample"),
            "sr": s.get("sample_rate"), "dur": (pj.get("format") or {}).get("duration")}


def download_flac(t, dest: Path, gate=check_file) -> dict:
    """Baixa a faixa (DASH fMP4 ou arquivo direto), remuxa para FLAC sem recodificar, grava em dest.
    Antes do rename final passa o FLAC pelo portão de qualidade (`gate(Path) -> Verdict`): se o
    conteúdo é lossy, apaga o temporário, NÃO cria dest e devolve info["verdict"] com a recusa."""
    st = t.get_stream()
    man = st.get_stream_manifest()
    urls = man.get_urls() if hasattr(man, "get_urls") else [man.get_stream_url()]
    mime = str(getattr(man, "mime_type", getattr(st, "manifest_mime_type", "")))
    WORK.mkdir(parents=True, exist_ok=True)
    raw = WORK / f"{t.id}.raw"
    if len(urls) == 1 and "dash" not in mime.lower():
        fetch(urls[0], raw)
    else:
        with open(raw, "wb") as f:
            for u in urls:
                req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    f.write(r.read())
    info = probe(raw)
    if info["codec"] != "flac":
        raw.unlink(missing_ok=True)
        raise RuntimeError(f"stream não é FLAC: {info} (qualidade {getattr(st, 'audio_quality', '?')})")
    tmp = dest.with_name(dest.name + ".part")
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(raw), "-vn", "-c:a", "copy",
                    "-f", "flac", str(tmp)], check=True)
    raw.unlink(missing_ok=True)
    info["quality"] = str(getattr(st, "audio_quality", "?"))
    verdict = gate(tmp)
    info["verdict"] = verdict
    if verdict.refused:
        tmp.unlink(missing_ok=True)
        return info
    if verdict.error:
        print(f"    aviso: análise espectral falhou ({verdict.error}); a faixa entra", flush=True)
    tmp.rename(dest)
    info["bytes"] = dest.stat().st_size
    return info


LRCLIB = "https://lrclib.net/api"
LRC_TS = re.compile(r"\[\d{1,2}:\d{2}")


def fetch_lrc(title: str, artist: str, album: str, dur_s: int) -> str | None:
    """Letra SINCRONIZADA do lrclib para a faixa recem-baixada (mesma fonte do Crate). Devolve o
    texto LRC ou None. Letra sem tempo NAO vira sidecar (a aba de letra depende dos timestamps);
    essa fica para o sync_lyrics.py diario, que grava `lyrics_text` no payload."""
    hdr = {"User-Agent": "RustifyPlayer/0.1.0 (https://github.com/PedroGiudice/rustify-player)"}
    tries = [f"{LRCLIB}/get?" + urllib.parse.urlencode({"track_name": title, "artist_name": artist,
                                                        "album_name": album, "duration": dur_s}),
             f"{LRCLIB}/search?" + urllib.parse.urlencode({"q": f"{artist} {title}"})]
    for url in tries:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=12) as r:
                data = json.loads(r.read())
        except Exception:
            continue
        if isinstance(data, list):
            data = data[0] if data else None
        lrc = (data or {}).get("syncedLyrics") or ""
        if lrc and LRC_TS.search(lrc):
            return lrc
    return None


def sidecar_for(dest: Path) -> Path:
    return dest.with_suffix(".lrc")


def rsync_rels(rels: list[str], push: str) -> int:
    host, _, remote_dir = push.partition(":")
    listing = WORK / "push-list.txt"
    listing.write_text("".join(r + "\n" for r in rels))
    return subprocess.run(["rsync", "-a", "--ignore-existing", "--timeout=120", "--files-from", str(listing),
                           str(MUSIC) + "/", f"{host}:{remote_dir}/"]).returncode


def push_one(dest: Path, push: str) -> bool:
    """rsync da faixa e da capa da pasta para a cmr-auto, mantendo o caminho relativo ao acervo.
    Até len(PUSH_RETRY_S)+1 tentativas; o rsync grava em temporário e renomeia, então o watcher
    da cmr-auto nunca vê arquivo pela metade. Devolve True se a faixa chegou."""
    rel = str(dest.relative_to(MUSIC))
    items = [rel]
    cov = dest.parent / "cover.jpg"
    if cov.exists():
        items.append(str(cov.relative_to(MUSIC)))
    if sidecar_for(dest).exists():
        items.append(str(sidecar_for(dest).relative_to(MUSIC)))
    for n, wait in enumerate((0,) + PUSH_RETRY_S):
        if wait:
            print(f"    rsync tentativa {n + 1} em {wait}s para {rel}", flush=True)
            time.sleep(wait)
        if rsync_rels(items, push) == 0:
            return True
    print(f"    rsync FALHOU em {len(PUSH_RETRY_S) + 1} tentativas para {rel}; fica no staging", flush=True)
    return False


def remote_touch(rels: list[str], push: str) -> None:
    """Acorda o watcher da cmr-auto (race em subpasta nova). 10 s depois do último rsync."""
    host, _, remote_dir = push.partition(":")
    time.sleep(10)
    quoted = " ".join(shlex.quote(remote_dir.rstrip("/") + "/" + r) for r in rels)
    rc = subprocess.run(["ssh", "-o", "BatchMode=yes", host, f"touch {quoted}"]).returncode
    print(f"touch remoto em {len(rels)} arquivos (race do watcher): rc={rc}", flush=True)


def drop_local(dest: Path) -> None:
    """Apaga a cópia do staging depois que a faixa chegou; capa e pastas vazias saem junto quando sobra nada."""
    dest.unlink(missing_ok=True)
    sidecar_for(dest).unlink(missing_ok=True)
    clean_album_dir(dest.parent)


def clean_album_dir(d: Path) -> None:
    """Pasta de álbum sem nenhum FLAC: some a capa e as pastas vazias (álbum, artista)."""
    if d.is_dir() and not any(q.suffix == ".flac" for q in d.iterdir() if q.is_file()):
        (d / "cover.jpg").unlink(missing_ok=True)
        for x in (d, d.parent):
            try:
                x.rmdir()
            except OSError:
                break


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    ap.add_argument("mix_id", nargs="?", help="link da Tidal (mix, playlist, álbum ou faixa), `tipo:id` ou id")
    ap.add_argument("--ids", help="modo seleção: ids de faixa separados por vírgula (máx. 200), no lugar do link")
    ap.add_argument("--titulo", default="Seleção", help="título do lote no modo seleção (aparece no resumo da fila)")
    ap.add_argument("--origem", default=None, help="de onde veio a seleção (ex.: mix:<id>, album:<id>, busca); vai no COMMENT")
    ap.add_argument("--playlist", default=GENRE, help="pasta de 1º nível em ~/Music")
    ap.add_argument("--list", action="store_true", help="só lista o mix, não baixa")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--genre", default=None, help="tag GENRE (padrão: o nome da playlist)")
    ap.add_argument("--push", default=_DEF["push"] or None,
                    help="destino rsync (padrão na VM: %(default)s); copia cada faixa assim que fica pronta, "
                         "apaga a cópia local e dá touch remoto no fim (race do watcher)")
    ap.add_argument("--no-push", action="store_true", help="não enviar (fica no acervo/staging local)")
    return ap


def main() -> int:
    ap = build_parser()
    args = ap.parse_args()
    if args.no_push:
        args.push = None
    if bool(args.ids) == bool(args.mix_id):
        ap.error("informe um link/id OU --ids")
    try:
        ids = parse_ids(args.ids) if args.ids else None
    except ValueError as e:
        ap.error(str(e))
    require()  # sem numpy, cai aqui (rc != 0, fila "falhou") antes de baixar qualquer coisa

    WORK.mkdir(parents=True, exist_ok=True)
    sess = load_session()
    pre_failed: list[dict] = []
    if ids:
        mix_title = args.titulo.strip() or "Seleção"
        print(f"MIX: {mix_title} | {len(ids)} faixas (seleção, origem {args.origem or 'manual'})", flush=True)
        tracks, pre_failed = resolve_ids(sess, ids)
    else:
        mix_title, items = resolve_items(sess, args.mix_id)
        tracks = [i for i in items if isinstance(i, tidalapi.Track)]
        print(f"MIX: {mix_title} | {len(tracks)} faixas", flush=True)
    remote: set[str] = set()
    if args.push and not args.list:
        remote = remote_rels(args.push)
        print(f"envio para {args.push}: {len(remote)} faixas [tidal] já lá", flush=True)

    albums: dict[int, tidalapi.Album] = {}
    pushed: list[Path] = []
    unsent: list[Path] = []

    def album_of(t):
        aid = t.album.id
        if aid not in albums:
            albums[aid] = sess.album(aid)
        return albums[aid]

    if args.list:
        for i, t in enumerate(tracks, 1):
            alb = album_of(t)
            arts = ", ".join(a.name for a in t.artists)
            y = alb.release_date.year if getattr(alb, "release_date", None) else "?"
            print(f"{i:3d} {track_title(t)[:45]:45s} | {arts[:40]:40s} | {alb.artist.name[:25]:25s} / {alb.name[:35]:35s} ({y}) "
                  f"#{t.track_num}/{alb.num_tracks} {getattr(alb, 'audio_quality', '?')}", flush=True)
        return 0

    lib = library_keys()
    print(f"acervo: {len(lib)} chaves título/artista", flush=True)
    refused_cache = load_refused(REFUSED_CACHE)
    print(f"cache de recusas: {len(refused_cache)} faixas lossy por dentro ({REFUSED_CACHE})", flush=True)
    touched_dirs: set[Path] = set()
    dest_root = MUSIC / safe_name(args.playlist)
    genre = args.genre or args.playlist
    report_key = args.mix_id or f"selecao-{time.strftime('%Y%m%d-%H%M%S')}"
    report = {"mix": report_key, "title": mix_title, "origem": args.origem, "new": [], "skipped": [], "failed": pre_failed, "recusadas": []}
    new_files: list[Path] = []
    covers: dict[int, Path | None] = {}
    for i, t in enumerate(tracks, 1):
        if args.limit and len(report["new"]) >= args.limit:
            break
        title = track_title(t)
        arts = [a.name for a in t.artists] or [t.artist.name]
        try:
            alb = album_of(t)
        except Exception as e:
            print(f"{i:3d} {title} FALHOU (álbum): {e!r}", flush=True)
            report["failed"].append({"i": i, "title": title, "err": repr(e)})
            continue
        album_artist = alb.artist.name
        year = alb.release_date.year if getattr(alb, "release_date", None) else None
        tk = title_key(title)
        keys = {(tk, a) for a in split_artists(", ".join(arts)) + split_artists(album_artist)} if tk else set()
        dup = keys & lib
        dest_dir = dest_root / safe_name(album_artist) / (safe_name(alb.name) + " [tidal]")
        dest = dest_dir / f"{int(t.track_num or i):02d} {safe_name(title)}.flac"
        if dup:
            print(f"{i:3d} {title[:45]:45s} JÁ NO ACERVO ({sorted(dup)[0][1]})", flush=True)
            report["skipped"].append({"i": i, "title": title, "artists": arts, "why": "acervo"})
            continue
        if is_refused(refused_cache, t.id):
            c = refused_cache[str(t.id)]
            print(f"{i:3d} {title[:45]:45s} JÁ RECUSADA (lossy por dentro)", flush=True)
            report["recusadas"].append({"id": t.id, "titulo": title, "artista": ", ".join(arts),
                                        "cutoff_hz": c.get("cutoff_hz"), "cache": True})
            continue
        if dest.exists():
            if args.push and str(dest.relative_to(MUSIC)) not in remote:  # sobra de envio que falhou
                # A sobra pode ser de antes do portão (15/10): mede antes de enviar.
                verdict = check_file(dest)
                if verdict.refused:
                    print(f"{i:3d} {title[:45]:45s} RECUSADA ({verdict.reason})", flush=True)
                    record_refused(refused_cache, t.id, title, ", ".join(arts), verdict.cutoff_hz)
                    save_refused(REFUSED_CACHE, refused_cache)
                    report["recusadas"].append({"id": t.id, "titulo": title, "artista": ", ".join(arts),
                                                "cutoff_hz": verdict.cutoff_hz})
                    drop_local(dest)
                    continue
                print(f"{i:3d} {title[:45]:45s} JÁ BAIXADA, reenviando", flush=True)
                (pushed if push_one(dest, args.push) else unsent).append(dest)
            else:
                print(f"{i:3d} {title[:45]:45s} JÁ BAIXADA", flush=True)
            report["skipped"].append({"i": i, "title": title, "artists": arts, "why": "existe"})
            continue
        if str(dest.relative_to(MUSIC)) in remote:
            print(f"{i:3d} {title[:45]:45s} JÁ NA CMR-AUTO (fora do índice)", flush=True)
            report["skipped"].append({"i": i, "title": title, "artists": arts, "why": "cmr-auto"})
            continue
        t0 = time.time()
        try:
            dest_dir.mkdir(parents=True, exist_ok=True)
            if alb.id not in covers:
                cov = dest_dir / "cover.jpg"
                if not cov.exists():
                    try:
                        urllib.request.urlretrieve(alb.image(1280), cov)
                    except Exception as e:
                        print(f"    capa falhou: {e!r}", flush=True)
                covers[alb.id] = _prepare_cover(cov, WORK) if cov.exists() else None
                if covers[alb.id]:
                    covers[alb.id] = covers[alb.id].rename(WORK / f"cover-{alb.id}.jpg")
            touched_dirs.add(dest_dir)
            info = download_flac(t, dest)
            verdict: Verdict = info.pop("verdict")  # fora de `info`: ele vai inteiro para o relatório JSON
            if verdict.refused:
                print(f"{i:3d} {title[:45]:45s} RECUSADA ({verdict.reason})", flush=True)
                record_refused(refused_cache, t.id, title, ", ".join(arts), verdict.cutoff_hz)
                save_refused(REFUSED_CACHE, refused_cache)
                report["recusadas"].append({"id": t.id, "titulo": title, "artista": ", ".join(arts),
                                            "cutoff_hz": verdict.cutoff_hz})
                time.sleep(PAUSE_S)
                continue
            tags = {
                "ARTIST": ", ".join(arts), "ALBUMARTIST": album_artist, "ALBUM": alb.name, "TITLE": title,
                "TRACKNUMBER": str(t.track_num or i), "TRACKTOTAL": str(alb.num_tracks or ""), "GENRE": genre,
                "COMMENT": comment_for(info["quality"], args.mix_id, args.origem),
            }
            if year:
                tags["DATE"] = str(year)
            if getattr(alb, "num_volumes", 1) and alb.num_volumes > 1:
                tags["DISCNUMBER"] = str(t.volume_num or 1)
                tags["DISCTOTAL"] = str(alb.num_volumes)
            if getattr(t, "isrc", None):
                tags["ISRC"] = t.isrc
            if getattr(alb, "copyright", None):
                tags["COPYRIGHT"] = alb.copyright
            _write_tags(dest, {k: v for k, v in tags.items() if v}, covers.get(alb.id))
            lrc = fetch_lrc(title, ", ".join(arts), alb.name, int(float(info.get("dur") or 0)))
            if lrc:
                sidecar_for(dest).write_text(lrc, encoding="utf-8")
                report.setdefault("lyrics", 0)
                report["lyrics"] += 1
            new_files.append(dest)
            sent = push_one(dest, args.push) if args.push else False
            if sent:
                pushed.append(dest)
            elif args.push:
                unsent.append(dest)
            report["new"].append({"i": i, "title": title, "artists": arts, "album": alb.name, "album_artist": album_artist,
                                  "year": year, "path": str(dest), "pushed": sent, **info})
            print(f"{i:3d} {title[:45]:45s} | {', '.join(arts)[:30]:30s} | {info['quality']} {info['bits']}/{info['sr']} "
                  f"{info['bytes'] / 1e6:.1f} MB em {time.time() - t0:.1f}s{' +letra' if lrc else ''} -> {dest.relative_to(MUSIC)}", flush=True)
        except Exception as e:
            print(f"{i:3d} {title} FALHOU: {e!r}", flush=True)
            report["failed"].append({"i": i, "title": title, "artists": arts, "err": repr(e)})
            for p in (dest, dest.with_name(dest.name + ".part")):
                p.unlink(missing_ok=True)
        time.sleep(PAUSE_S)

    for d in touched_dirs:  # álbum onde só houve recusadas: sem FLAC, a capa e as pastas vazias saem
        clean_album_dir(d)
    out = Path(os.path.expanduser(f"~/.cache/tidal-spike/mix_{re.sub(r'[^A-Za-z0-9-]+', '_', report_key)[-40:]}.json"))
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(f"NOVAS {len(report['new'])} | PULADAS {len(report['skipped'])} | FALHAS {len(report['failed'])} | LETRAS {report.get('lyrics', 0)} | relatório {out}", flush=True)
    print(f"RECUSADAS {len(report['recusadas'])} (lossy por dentro)", flush=True)
    if args.push:
        if unsent:  # última chance, em lote, para o que falhou no meio
            print(f"reenviando {len(unsent)} faixas que falharam...", flush=True)
            time.sleep(30)
            rels = [str(p.relative_to(MUSIC)) for p in unsent]
            covers_rel = [d + "/cover.jpg" for d in sorted({str(Path(r).parent) for r in rels}) if (MUSIC / d / "cover.jpg").exists()]
            lrc_rel = [str(sidecar_for(p).relative_to(MUSIC)) for p in unsent if sidecar_for(p).exists()]
            if rsync_rels(rels + covers_rel + lrc_rel, args.push) == 0:
                pushed.extend(unsent)
                unsent = []
        if pushed:
            remote_touch([str(p.relative_to(MUSIC)) for p in pushed], args.push)
            for p in pushed:
                drop_local(p)
            print(f"ENVIADAS {len(pushed)} para {args.push}; staging limpo", flush=True)
        if unsent:
            print(f"NÃO ENVIADAS {len(unsent)} (ficaram em {MUSIC}): rode de novo com o mesmo link para reenviar", flush=True)
            for p in unsent:
                print(f"    {p.relative_to(MUSIC)}", flush=True)
    elif new_files:
        time.sleep(10)
        for p in new_files:
            p.touch()
        print(f"touch em {len(new_files)} arquivos (race do watcher)", flush=True)
    print("FIM", flush=True)
    return 2 if unsent else 0


if __name__ == "__main__":
    sys.exit(main())
