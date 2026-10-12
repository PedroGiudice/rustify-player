#!/usr/bin/env python3
"""Normaliza um release baixado (Bandcamp, SoundCloud) para o layout do acervo.

Entrada: uma pasta com os arquivos de áudio de UM release (FLAC/WAV/AIFF; MP3
só com --allow-lossy) e, opcionalmente, uma capa. Saída: a pasta canônica

    <out>/Funk Brasileiro/<Artista>/<Release>/NN Título.flac  (+ cover.jpg)

com tags reescritas a partir dos metadados passados na linha de comando
(fonte da verdade é a página do release, não a tag que veio no arquivo —
funk BR costuma chegar com artista = URL do ripper, álbum vazio, ano errado).

Regras:
- Nome de pasta/arquivo sem  : " * ? < > | \\ /  (o storage do Android recusa;
  ver scripts/android/phone_sync_encode.py::safe_rel). `_` no lugar.
- WAV/AIFF vira FLAC (lossless). MP3/M4A só com --allow-lossy: vira FLAC para
  o indexer aceitar (só lê .flac) e recebe COMMENT "source: lossy <fmt>" para
  não fingir qualidade.
- Capa: --cover <arquivo>, ou cover.jpg/folder.jpg/*.jpg|png na pasta de
  origem; embutida em cada FLAC e copiada como cover.jpg.
- Número de faixa: lido do nome do arquivo (padrões Bandcamp
  "Artista - Álbum - 01 Título", "01 Título", "01 - Título", "01. Título");
  sem número, segue a ordem alfabética e numera a partir de 1.
- Nunca grava valor com aparência de URL em campo nenhum.

Uso (na VM; mutagen via uv):
    uv run --with mutagen scripts/curator/normalize_release.py \
        --src /tmp/dl/hardfunk --out /tmp/staging \
        --artist "OO Rubinho" --release "HARDFUNK" --year 2022 \
        --label "Business Casual" [--genre "Funk Brasileiro"] [--cover capa.jpg] \
        [--allow-lossy] [--dry-run]
Testes: python3 scripts/curator/test_normalize_release.py
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

LOSSLESS = {".flac", ".wav", ".aiff", ".aif"}
LOSSY = {".mp3", ".m4a", ".aac", ".ogg", ".opus"}
COVER_NAMES = ("cover", "folder", "front", "capa", "artwork")
IMG_EXT = {".jpg", ".jpeg", ".png"}

_UNSAFE = re.compile(r'[:"*?<>|\\/]')
_WS = re.compile(r"\s+")
_URL = re.compile(r"(https?://|www\.|\.com\b|\.net\b|\.org\b|\.br\b)", re.I)
_TRACK_PATTERNS = (
    # "Artista - Álbum - 01 Título" (padrão Bandcamp)
    re.compile(r"^(?P<prefix>.+? - .+? - )(?P<num>\d{1,3})\s+(?P<title>.+)$"),
    re.compile(r"^(?P<num>\d{1,3})\s*[-.]\s*(?P<title>.+)$"),
    re.compile(r"^(?P<num>\d{1,3})\s+(?P<title>.+)$"),
)


def safe_name(s: str) -> str:
    """Nome de pasta/arquivo aceito pelo Android e pelo ext4, sem lixo."""
    s = _UNSAFE.sub("_", s or "")
    s = _WS.sub(" ", s).strip(" ._")
    return s or "_"


def looks_like_url(s: str | None) -> bool:
    return bool(s) and bool(_URL.search(s))


def parse_track_filename(stem: str, artist: str = "", release: str = "") -> tuple[int | None, str]:
    """(número, título) a partir do nome do arquivo sem extensão."""
    s = stem.strip()
    for pat in _TRACK_PATTERNS:
        m = pat.match(s)
        if m:
            title = m.group("title").strip()
            return int(m.group("num")), title
    # "Artista - Título" sem número
    for prefix in (f"{artist} - {release} - ", f"{artist} - "):
        if artist and s.lower().startswith(prefix.lower()):
            return None, s[len(prefix):].strip()
    return None, s


@dataclass
class Item:
    src: Path
    track_no: int
    title: str
    lossy_source: str | None  # ex.: "mp3" quando convertido de lossy

    @property
    def dest_name(self) -> str:
        return f"{self.track_no:02d} {safe_name(self.title)}.flac"


@dataclass
class Plan:
    dest_dir: Path
    items: list[Item]
    cover: Path | None
    tags: dict[str, str] = field(default_factory=dict)


def find_cover(src: Path, explicit: Path | None) -> Path | None:
    if explicit:
        return explicit
    imgs = [p for p in src.iterdir() if p.suffix.lower() in IMG_EXT]
    for name in COVER_NAMES:
        for p in imgs:
            if p.stem.lower() == name:
                return p
    return max(imgs, key=lambda p: p.stat().st_size) if imgs else None


def build_plan(src: Path, out: Path, *, artist: str, release: str, year: int | None,
               label: str | None, genre: str, allow_lossy: bool,
               cover: Path | None = None) -> Plan:
    for v in (artist, release, label or ""):
        if looks_like_url(v):
            raise ValueError(f"valor com aparência de URL recusado: {v!r}")
    audio = sorted(p for p in src.iterdir() if p.suffix.lower() in LOSSLESS | LOSSY)
    if not audio:
        raise ValueError(f"nenhum áudio em {src}")
    lossy = [p for p in audio if p.suffix.lower() in LOSSY]
    if lossy and not allow_lossy:
        raise ValueError(
            f"{len(lossy)} arquivo(s) lossy ({', '.join(sorted({p.suffix for p in lossy}))}); "
            "passe --allow-lossy para converter com COMMENT de origem"
        )
    parsed = [(p, *parse_track_filename(p.stem, artist, release)) for p in audio]
    numbered = all(n is not None for _, n, _ in parsed) and len({n for _, n, _ in parsed}) == len(parsed)
    items = []
    for i, (p, n, title) in enumerate(parsed, start=1):
        ext = p.suffix.lower()
        items.append(Item(src=p, track_no=n if numbered else i, title=title,
                          lossy_source=ext.lstrip(".") if ext in LOSSY else None))
    items.sort(key=lambda it: it.track_no)
    tags = {
        "ARTIST": artist, "ALBUMARTIST": artist, "ALBUM": release, "GENRE": genre,
        "TRACKTOTAL": str(len(items)),
    }
    if year:
        tags["DATE"] = str(year)
    if label:
        tags["LABEL"] = label
        tags["ORGANIZATION"] = label
    dest_dir = out / genre / safe_name(artist) / safe_name(release)
    return Plan(dest_dir=dest_dir, items=items, cover=find_cover(src, cover), tags=tags)


def describe(plan: Plan) -> str:
    lines = [f"-> {plan.dest_dir}  ({len(plan.items)} faixas; capa: {plan.cover.name if plan.cover else 'nenhuma'})"]
    for it in plan.items:
        flag = f"  [lossy:{it.lossy_source}]" if it.lossy_source else ""
        lines.append(f"   {it.dest_name}  <- {it.src.name}{flag}")
    return "\n".join(lines)


def _to_flac(src: Path, dest: Path) -> None:
    if src.suffix.lower() == ".flac":
        shutil.copy2(src, dest)
        return
    # -map_metadata -1: as tags são reescritas abaixo; -vn descarta capa embutida (reembutida depois)
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-vn",
         "-map_metadata", "-1", "-c:a", "flac", "-compression_level", "8", str(dest)],
        check=True,
    )


def _write_tags(path: Path, tags: dict[str, str], cover: Path | None) -> None:
    from mutagen.flac import FLAC, Picture  # import tardio: só o apply precisa do mutagen

    f = FLAC(path)
    f.delete()  # zera tags herdadas (artista=URL do ripper etc.)
    for k, v in tags.items():
        f[k] = v
    f.clear_pictures()
    if cover:
        pic = Picture()
        pic.type = 3
        pic.mime = "image/png" if cover.suffix.lower() == ".png" else "image/jpeg"
        pic.data = cover.read_bytes()
        f.add_picture(pic)
    f.save()


def apply(plan: Plan) -> None:
    plan.dest_dir.mkdir(parents=True, exist_ok=True)
    for it in plan.items:
        dest = plan.dest_dir / it.dest_name
        _to_flac(it.src, dest)
        tags = dict(plan.tags, TITLE=it.title, TRACKNUMBER=str(it.track_no))
        if it.lossy_source:
            tags["COMMENT"] = f"source: lossy {it.lossy_source}"
        _write_tags(dest, tags, plan.cover)
    if plan.cover:
        shutil.copy2(plan.cover, plan.dest_dir / "cover.jpg")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--artist", required=True)
    ap.add_argument("--release", required=True)
    ap.add_argument("--year", type=int)
    ap.add_argument("--label")
    ap.add_argument("--genre", default="Funk Brasileiro")
    ap.add_argument("--cover", type=Path)
    ap.add_argument("--allow-lossy", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    try:
        plan = build_plan(a.src, a.out, artist=a.artist, release=a.release, year=a.year,
                          label=a.label, genre=a.genre, allow_lossy=a.allow_lossy, cover=a.cover)
    except ValueError as e:
        print(f"erro: {e}", file=sys.stderr)
        return 2
    print(describe(plan))
    if a.dry_run:
        return 0
    apply(plan)
    print(f"ok: {len(plan.items)} faixas em {plan.dest_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
