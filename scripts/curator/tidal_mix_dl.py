#!/usr/bin/env python3
"""Baixa todas as faixas de um mix ou playlist da Tidal em qualidade máxima, direto para
~/Music/<playlist>/<Artista do álbum>/<Álbum> [tidal]/NN Título.flac, com tags da Tidal e capa.
A marca " [tidal]" no nome da pasta é o que mantém tudo isso fora do share do slskd.

Roda NA cmr-auto (acervo local) ou NA VM (staging + envio para a cmr-auto):
  uv run --with tidalapi --with mutagen python3 tidal_mix_dl.py <link> --list
  uv run --with tidalapi --with mutagen python3 tidal_mix_dl.py <link> [--playlist "Funk Brasileiro"] [--genre G]
Na VM (hostname extractlab) o envio é AUTOMÁTICO, sem flag: staging em ~/tidal-out, dedup pelo túnel
16333 (aberto sozinho se estiver caído), cada faixa vai por rsync para cmr-auto:~/Music assim que fica
pronta (3 tentativas), a cópia local é apagada depois que chegou, e no fim um `touch` remoto acorda o
watcher. Se a cmr-auto não responder, o script aborta ANTES de baixar. TIDAL_PUSH=off ou --no-push
desligam; TIDAL_PUSH=<host:dir> troca o destino. A sessão PKCE (~/.secrets/tidal-pkce.json) é a mesma
nas duas máquinas; o refresh não rotaciona o token.
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
import urllib.request
from pathlib import Path

import tidalapi

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
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
    return {"music": music, "qdrant": qdrant, "push": push, "on_vm": on_vm}


_DEF = vm_defaults(socket.gethostname(), os.environ)
MUSIC = Path(os.path.expanduser(_DEF["music"]))
QDRANT = _DEF["qdrant"]


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
            t = loose(str(pl.get("title") or ""))
            for a in split_artists(str(pl.get("artist") or "")) + split_artists(str(pl.get("album_artist") or "")):
                keys.add((t, a))
        offset = res.get("next_page_offset")
        if offset is None:
            break
    return keys


def resolve_items(sess: tidalapi.Session, ref: str):
    """Aceita link da Tidal (mix, playlist, álbum ou faixa) ou o id cru. Devolve (título, itens)."""
    mt = re.search(r"tidal\.com/.*?/track/(\d+)", ref)  # "album/<a>/track/<t>" = compartilhar faixa: só a faixa
    m = re.search(r"tidal\.com/(?:browse/)?(mix|playlist|album|track)/([A-Za-z0-9-]+)", ref)
    if mt:
        kind, ident = "track", mt.group(1)
    elif m:
        kind, ident = m.group(1), m.group(2)
    elif re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", ref):
        kind, ident = "playlist", ref
    elif re.fullmatch(r"[0-9a-f]{20,40}", ref):
        kind, ident = "mix", ref
    elif re.fullmatch(r"[0-9]+", ref):
        kind, ident = "album", ref
    else:
        raise SystemExit(f"referência não reconhecida: {ref}")
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
    return f"{t.artist.name} - {t.name}", [t]


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


def download_flac(t, dest: Path) -> dict:
    """Baixa a faixa (DASH fMP4 ou arquivo direto), remuxa para FLAC sem recodificar, grava em dest."""
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
    tmp.rename(dest)
    info["quality"] = str(getattr(st, "audio_quality", "?"))
    info["bytes"] = dest.stat().st_size
    return info


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
    d = dest.parent
    if not any(q.suffix == ".flac" for q in d.iterdir() if q.is_file()):
        (d / "cover.jpg").unlink(missing_ok=True)
        for x in (d, d.parent):
            try:
                x.rmdir()
            except OSError:
                break


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mix_id", help="link da Tidal (mix, playlist, álbum ou faixa) ou id")
    ap.add_argument("--playlist", default=GENRE, help="pasta de 1º nível em ~/Music")
    ap.add_argument("--list", action="store_true", help="só lista o mix, não baixa")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--genre", default=None, help="tag GENRE (padrão: o nome da playlist)")
    ap.add_argument("--push", default=_DEF["push"] or None,
                    help="destino rsync (padrão na VM: %(default)s); copia cada faixa assim que fica pronta, "
                         "apaga a cópia local e dá touch remoto no fim (race do watcher)")
    ap.add_argument("--no-push", action="store_true", help="não enviar (fica no acervo/staging local)")
    args = ap.parse_args()
    if args.no_push:
        args.push = None

    WORK.mkdir(parents=True, exist_ok=True)
    sess = load_session()
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
    dest_root = MUSIC / safe_name(args.playlist)
    genre = args.genre or args.playlist
    report = {"mix": args.mix_id, "title": mix_title, "new": [], "skipped": [], "failed": []}
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
        keys = {(loose(title), a) for a in split_artists(", ".join(arts)) + split_artists(album_artist)}
        dup = keys & lib
        dest_dir = dest_root / safe_name(album_artist) / (safe_name(alb.name) + " [tidal]")
        dest = dest_dir / f"{int(t.track_num or i):02d} {safe_name(title)}.flac"
        if dup:
            print(f"{i:3d} {title[:45]:45s} JÁ NO ACERVO ({sorted(dup)[0][1]})", flush=True)
            report["skipped"].append({"i": i, "title": title, "artists": arts, "why": "acervo"})
            continue
        if dest.exists():
            if args.push and str(dest.relative_to(MUSIC)) not in remote:  # sobra de envio que falhou
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
            info = download_flac(t, dest)
            tags = {
                "ARTIST": ", ".join(arts), "ALBUMARTIST": album_artist, "ALBUM": alb.name, "TITLE": title,
                "TRACKNUMBER": str(t.track_num or i), "TRACKTOTAL": str(alb.num_tracks or ""), "GENRE": genre,
                "COMMENT": f"source: tidal {info['quality'].lower()}; mix {args.mix_id}",
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
            new_files.append(dest)
            sent = push_one(dest, args.push) if args.push else False
            if sent:
                pushed.append(dest)
            elif args.push:
                unsent.append(dest)
            report["new"].append({"i": i, "title": title, "artists": arts, "album": alb.name, "album_artist": album_artist,
                                  "year": year, "path": str(dest), "pushed": sent, **info})
            print(f"{i:3d} {title[:45]:45s} | {', '.join(arts)[:30]:30s} | {info['quality']} {info['bits']}/{info['sr']} "
                  f"{info['bytes'] / 1e6:.1f} MB em {time.time() - t0:.1f}s -> {dest.relative_to(MUSIC)}", flush=True)
        except Exception as e:
            print(f"{i:3d} {title} FALHOU: {e!r}", flush=True)
            report["failed"].append({"i": i, "title": title, "artists": arts, "err": repr(e)})
            for p in (dest, dest.with_name(dest.name + ".part")):
                p.unlink(missing_ok=True)
        time.sleep(PAUSE_S)

    out = Path(os.path.expanduser(f"~/.cache/tidal-spike/mix_{re.sub(r'[^A-Za-z0-9-]+', '_', args.mix_id)[-40:]}.json"))
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(f"NOVAS {len(report['new'])} | PULADAS {len(report['skipped'])} | FALHAS {len(report['failed'])} | relatório {out}", flush=True)
    if args.push:
        if unsent:  # última chance, em lote, para o que falhou no meio
            print(f"reenviando {len(unsent)} faixas que falharam...", flush=True)
            time.sleep(30)
            rels = [str(p.relative_to(MUSIC)) for p in unsent]
            covers_rel = [d + "/cover.jpg" for d in sorted({str(Path(r).parent) for r in rels}) if (MUSIC / d / "cover.jpg").exists()]
            if rsync_rels(rels + covers_rel, args.push) == 0:
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
