#!/usr/bin/env python3
"""Normaliza um release baixado (Bandcamp, SoundCloud) para o layout do acervo.

Entrada: uma pasta com os arquivos de áudio de UM release (FLAC/WAV/AIFF) e,
opcionalmente, uma capa. Saída: a pasta canônica

    <out>/Funk Brasileiro/<Artista>/<Release>/NN Título.flac  (+ cover.jpg)

com tags reescritas a partir dos metadados passados na linha de comando
(fonte da verdade é a página do release, não a tag que veio no arquivo —
funk BR costuma chegar com artista = URL do ripper, álbum vazio, ano errado).

Regras:
- Nome de pasta/arquivo sem  : " * ? < > | \\ /  (o storage do Android recusa;
  ver scripts/android/phone_sync_encode.py::safe_rel). `_` no lugar.
- WAV/AIFF vira FLAC (lossless).
- Só entra lossless de verdade (decisão do CEO, 15/10/2026), medido pelo CONTEÚDO:
  MP3/M4A/AAC/OGG/OPUS na pasta de origem é erro (lossy não entra, nem 320), e
  cada WAV/FLAC/AIFF passa pelo detector de corte espectral (quality_audit.py,
  via lossless_gate.py) ANTES de converter. Corte de lossy = a faixa é RECUSADA
  (não converte, não copia) e o resumo lista "RECUSADA (lossy por dentro, corte
  X,X kHz)". As outras seguem; se TODAS forem recusadas, sai com código 3. Falha
  da análise não bloqueia: a faixa entra e o motivo é impresso. Precisa de numpy
  e ffmpeg (a análise roda também no --dry-run).
- Capa: --cover <arquivo>, ou cover.jpg/folder.jpg/*.jpg|png na pasta de
  origem; embutida em cada FLAC e copiada como cover.jpg.
- Número de faixa: lido do nome do arquivo (padrões Bandcamp
  "Artista - Álbum - 01 Título", "01 Título", "01 - Título", "01. Título");
  sem número, segue a ordem alfabética e numera a partir de 1.
- Artista por faixa: se o arquivo traz ARTIST próprio (sem cara de URL), ele é
  preservado em ARTIST; ALBUMARTIST recebe sempre o --artist. Serve para EP de
  vários artistas (Funk na Caixa) sem perder o crédito. --flat-artist desliga.
- Título com o artista repetido no fim ("Igrejinha - Buarky feat. X") perde o
  sufixo quando ele é o próprio artista da faixa.
- Capa convertida para JPEG de até 1500 px antes de embutir (PNG de 8 MB em
  cada faixa é desperdício) e salva como cover.jpg.
- Nunca grava valor com aparência de URL em campo nenhum.

Uso (na VM; mutagen via uv):
    uv run --with mutagen --with numpy scripts/curator/normalize_release.py \
        --src /tmp/dl/hardfunk --out /tmp/staging \
        --artist "OO Rubinho" --release "HARDFUNK" --year 2022 \
        --label "Business Casual" [--genre "Funk Brasileiro"] [--cover capa.jpg] \
        [--dry-run]
Testes: uv run --with numpy python3 scripts/curator/test_normalize_release.py
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


_LOOSE = re.compile(r"[^a-z0-9]+")


def loose(s: str) -> str:
    """Comparação frouxa de créditos: caixa, pontuação e '&' vs 'e' não contam."""
    return _LOOSE.sub("", (s or "").lower().replace("&", " e ").replace(" and ", " e "))


def strip_artist_suffix(title: str, track_artist: str | None) -> str:
    """'Igrejinha - Buarky feat. X' com artista 'Buarky feat. X' -> 'Igrejinha'."""
    if not track_artist or " - " not in title:
        return title
    head, _, tail = title.rpartition(" - ")
    return head.strip() if head and loose(tail) == loose(track_artist) else title


def read_track_artist(path: Path) -> str | None:
    """ARTIST gravado no arquivo, quando existe e não parece URL (só FLAC; o resto vira None)."""
    if path.suffix.lower() != ".flac":
        return None
    try:
        from mutagen.flac import FLAC
        v = (FLAC(path).tags or {}).get("artist") or []
    except Exception:
        return None
    a = (v[0] if v else "").strip()
    return a if a and not looks_like_url(a) else None


@dataclass
class Item:
    src: Path
    track_no: int
    title: str
    track_artist: str | None = None  # crédito por faixa; None = usa o albumartist

    @property
    def dest_name(self) -> str:
        return f"{self.track_no:02d} {safe_name(self.title)}.flac"


@dataclass
class Plan:
    dest_dir: Path
    items: list[Item]
    cover: Path | None
    tags: dict[str, str] = field(default_factory=dict)
    refused: list[tuple[str, str]] = field(default_factory=list)  # (nome do arquivo, motivo): não entram


def find_cover(src: Path, explicit: Path | None) -> Path | None:
    if explicit:
        return explicit
    imgs = [p for p in src.iterdir() if p.suffix.lower() in IMG_EXT]
    for name in COVER_NAMES:
        for p in imgs:
            if p.stem.lower() == name:
                return p
    return max(imgs, key=lambda p: p.stat().st_size) if imgs else None


def list_audio(src: Path) -> list[Path]:
    """Áudios lossless da pasta, em ordem. Lossy (mp3/m4a/aac/ogg/opus) é erro: não entra no acervo."""
    audio = sorted(p for p in src.iterdir() if p.suffix.lower() in LOSSLESS | LOSSY)
    if not audio:
        raise ValueError(f"nenhum áudio em {src}")
    lossy = [p for p in audio if p.suffix.lower() in LOSSY]
    if lossy:
        raise ValueError(
            f"lossy não entra no acervo (só lossless de verdade; nem MP3 320). "
            f"{len(lossy)} arquivo(s) lossy em {src}: " + ", ".join(p.name for p in lossy)
        )
    return audio


def screen_sources(src: Path) -> dict[str, str]:
    """Mede o corte espectral de cada áudio de ORIGEM (antes de converter) e devolve
    {nome do arquivo: motivo} dos recusados. Falha da análise não bloqueia: a faixa entra
    e o motivo vai para o stderr."""
    from lossless_gate import check_file

    refused: dict[str, str] = {}
    for p in list_audio(src):
        v = check_file(p)
        if v.error:
            print(f"aviso: análise espectral falhou em {p.name} ({v.error}); a faixa entra", file=sys.stderr)
        elif v.refused:
            refused[p.name] = v.reason
    return refused


def build_plan(src: Path, out: Path, *, artist: str, release: str, year: int | None,
               label: str | None, genre: str,
               cover: Path | None = None, flat_artist: bool = False,
               track_artists: dict[str, str] | None = None, title: str | None = None,
               refused: dict[str, str] | None = None) -> Plan:
    """track_artists: {nome do arquivo: ARTIST} já lido (os testes injetam; o CLI lê das tags).
    refused: {nome do arquivo: motivo} das faixas que o detector espectral recusou (ver
    screen_sources); elas ficam fora do plano e aparecem em Plan.refused.
    title: título explícito, só para release de UMA faixa (single do SoundCloud: o nome do
    upload vem em caixa alta e com o artista repetido)."""
    for v in (artist, release, label or ""):
        if looks_like_url(v):
            raise ValueError(f"valor com aparência de URL recusado: {v!r}")
    refused = refused or {}
    everything = list_audio(src)
    if title and len(everything) != 1:
        raise ValueError(f"--title só vale para release de 1 faixa (há {len(everything)})")
    audio = [p for p in everything if p.name not in refused]
    parsed = [(p, *parse_track_filename(p.stem, artist, release)) for p in audio]
    if title and audio:
        parsed = [(audio[0], 1, title)]
    numbered = all(n is not None for _, n, _ in parsed) and len({n for _, n, _ in parsed}) == len(parsed)
    items = []
    for i, (p, n, title) in enumerate(parsed, start=1):
        ta = None
        if not flat_artist:
            ta = (track_artists or {}).get(p.name) if track_artists is not None else read_track_artist(p)
            if ta and (loose(ta) == loose(artist) or looks_like_url(ta)):
                ta = None
        title = strip_artist_suffix(title, ta or artist)
        items.append(Item(src=p, track_no=n if numbered else i, title=title, track_artist=ta))
    items.sort(key=lambda it: it.track_no)
    tags = {
        "ARTIST": artist, "ALBUMARTIST": artist, "ALBUM": release, "GENRE": genre,
        # com números do release e faixas recusadas, o total continua sendo o do release
        "TRACKTOTAL": str(len(everything) if numbered else len(items)),
    }
    if year:
        tags["DATE"] = str(year)
    if label:
        tags["LABEL"] = label
        tags["ORGANIZATION"] = label
    dest_dir = out / genre / safe_name(artist) / safe_name(release)
    return Plan(dest_dir=dest_dir, items=items, cover=find_cover(src, cover), tags=tags,
                refused=[(p.name, refused[p.name]) for p in everything if p.name in refused])


def describe(plan: Plan) -> str:
    lines = [f"-> {plan.dest_dir}  ({len(plan.items)} faixas; capa: {plan.cover.name if plan.cover else 'nenhuma'})"]
    for it in plan.items:
        who = f"  (artist: {it.track_artist})" if it.track_artist else ""
        lines.append(f"   {it.dest_name}{who}  <- {it.src.name}")
    for name, why in plan.refused:
        lines.append(f"   RECUSADA ({why})  <- {name}")
    return "\n".join(lines)


def flac_cmd(src: Path, dest: Path) -> list[str]:
    """Comando ffmpeg da conversão. -map_metadata -1: as tags são reescritas depois;
    -vn descarta a capa embutida (reembutida depois). Só origem lossless chega aqui
    (lossy é recusado em list_audio), então não há reamostragem nem dither."""
    return ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-vn", "-map_metadata", "-1",
            "-c:a", "flac", "-compression_level", "8", str(dest)]


def _to_flac(src: Path, dest: Path) -> None:
    if src.suffix.lower() == ".flac":
        shutil.copy2(src, dest)
        return
    subprocess.run(flac_cmd(src, dest), check=True)


def _prepare_cover(cover: Path | None, workdir: Path) -> Path | None:
    """JPEG q2 de até 1500 px no lado maior; PNG/JPEG grandes não vão inteiros para cada faixa."""
    if not cover:
        return None
    out = workdir / ".cover-normalized.jpg"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(cover),
         "-vf", "scale='min(1500,iw)':'min(1500,ih)':force_original_aspect_ratio=decrease",
         "-frames:v", "1", "-q:v", "2", str(out)],
        check=True,
    )
    return out


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
        pic.mime = "image/jpeg"
        pic.data = cover.read_bytes()
        f.add_picture(pic)
    f.save()


def apply(plan: Plan) -> None:
    plan.dest_dir.mkdir(parents=True, exist_ok=True)
    cover = _prepare_cover(plan.cover, plan.dest_dir)
    for it in plan.items:
        dest = plan.dest_dir / it.dest_name
        _to_flac(it.src, dest)
        tags = dict(plan.tags, TITLE=it.title, TRACKNUMBER=str(it.track_no))
        if it.track_artist:
            tags["ARTIST"] = it.track_artist
        _write_tags(dest, tags, cover)
    if cover:
        cover.replace(plan.dest_dir / "cover.jpg")


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
    ap.add_argument("--flat-artist", action="store_true", help="ignora o ARTIST por faixa dos arquivos")
    ap.add_argument("--title", help="título da faixa (só para release de 1 faixa)")
    ap.add_argument("--dry-run", action="store_true", help="mede e mostra o plano (inclusive as recusadas), sem gravar")
    a = ap.parse_args(argv)
    try:
        refused = screen_sources(a.src)
        plan = build_plan(a.src, a.out, artist=a.artist, release=a.release, year=a.year,
                          label=a.label, genre=a.genre, cover=a.cover,
                          flat_artist=a.flat_artist, title=a.title, refused=refused)
    except ValueError as e:
        print(f"erro: {e}", file=sys.stderr)
        return 2
    print(describe(plan))
    if not plan.items:
        print(f"erro: todas as {len(plan.refused)} faixas foram recusadas (lossy por dentro); nada entra", file=sys.stderr)
        return 3
    if a.dry_run:
        return 0
    apply(plan)
    print(f"ok: {len(plan.items)} faixas em {plan.dest_dir}" + (f"; {len(plan.refused)} RECUSADAS" if plan.refused else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
