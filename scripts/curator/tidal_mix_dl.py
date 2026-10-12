#!/usr/bin/env python3
"""Baixa todas as faixas de um mix ou playlist da Tidal em qualidade máxima, direto para
~/Music/<playlist>/<Artista do álbum>/<Álbum> [tidal]/NN Título.flac, com tags da Tidal e capa.
A marca " [tidal]" no nome da pasta é o que mantém tudo isso fora do share do slskd.

Roda NA cmr-auto:
  ~/.local/bin/uv run --with tidalapi --with mutagen python3 tidal_mix_dl.py <mix_id> --list
  ~/.local/bin/uv run --with tidalapi --with mutagen python3 tidal_mix_dl.py <mix_id> [--playlist "Funk Brasileiro"]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import tidalapi

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize_release import _prepare_cover, _write_tags, loose, safe_name  # noqa: E402

SECRET = os.path.expanduser("~/.secrets/tidal-pkce.json")
MUSIC = Path(os.path.expanduser("~/Music"))
WORK = Path(os.path.expanduser("~/.cache/tidal-spike/mixwork"))
QDRANT = "http://127.0.0.1:6333"
GENRE = "Funk Brasileiro"
PAUSE_S = 2


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


def library_keys() -> set[tuple[str, str]]:
    """(título, artista) soltos de tudo que já está no acervo, para não baixar de novo."""
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mix_id")
    ap.add_argument("--playlist", default=GENRE, help="pasta de 1º nível em ~/Music")
    ap.add_argument("--list", action="store_true", help="só lista o mix, não baixa")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    WORK.mkdir(parents=True, exist_ok=True)
    sess = load_session()
    try:
        mix = sess.mix(args.mix_id)
        items = mix.items()
        mix_title = getattr(mix, "title", args.mix_id)
    except Exception:
        pl = sess.playlist(args.mix_id)
        items = pl.tracks()
        mix_title = pl.name
    tracks = [i for i in items if isinstance(i, tidalapi.Track)]
    print(f"MIX: {mix_title} | {len(tracks)} faixas", flush=True)

    albums: dict[int, tidalapi.Album] = {}

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
            print(f"{i:3d} {title[:45]:45s} JÁ BAIXADA", flush=True)
            report["skipped"].append({"i": i, "title": title, "artists": arts, "why": "existe"})
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
                "TRACKNUMBER": str(t.track_num or i), "TRACKTOTAL": str(alb.num_tracks or ""), "GENRE": GENRE,
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
            report["new"].append({"i": i, "title": title, "artists": arts, "album": alb.name, "album_artist": album_artist,
                                  "year": year, "path": str(dest), **info})
            print(f"{i:3d} {title[:45]:45s} | {', '.join(arts)[:30]:30s} | {info['quality']} {info['bits']}/{info['sr']} "
                  f"{info['bytes'] / 1e6:.1f} MB em {time.time() - t0:.1f}s -> {dest.relative_to(MUSIC)}", flush=True)
        except Exception as e:
            print(f"{i:3d} {title} FALHOU: {e!r}", flush=True)
            report["failed"].append({"i": i, "title": title, "artists": arts, "err": repr(e)})
            for p in (dest, dest.with_name(dest.name + ".part")):
                p.unlink(missing_ok=True)
        time.sleep(PAUSE_S)

    out = Path(os.path.expanduser(f"~/.cache/tidal-spike/mix_{args.mix_id}.json"))
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(f"NOVAS {len(report['new'])} | PULADAS {len(report['skipped'])} | FALHAS {len(report['failed'])} | relatório {out}", flush=True)
    if new_files:
        time.sleep(10)
        for p in new_files:
            p.touch()
        print(f"touch em {len(new_files)} arquivos (race do watcher)", flush=True)
    print("FIM", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
