#!/usr/bin/env python3
"""Testes das funções puras do normalize_release.py (sem mutagen, sem ffmpeg).

    python3 scripts/curator/test_normalize_release.py
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from normalize_release import build_plan, looks_like_url, parse_track_filename, safe_name  # noqa: E402


def test_safe_name():
    assert safe_name('TABOO | TA13OO') == "TABOO _ TA13OO"
    assert safe_name("Stars (DJ Caio Prince & Adame DJ remix)") == "Stars (DJ Caio Prince & Adame DJ remix)"
    assert safe_name('Músicas para ouvir antes do rolê: vol. 2?') == "Músicas para ouvir antes do rolê_ vol. 2"
    assert safe_name("  ..a/b\\c  ") == "a_b_c"
    assert safe_name("") == "_"


def test_looks_like_url():
    assert looks_like_url("www.ftpdjemilio.com")
    assert looks_like_url("https://soundcloud.com/x")
    assert not looks_like_url("DJ Anderson do Paraíso")
    assert not looks_like_url("Business Casual")


def test_parse_track_filename():
    assert parse_track_filename("OO RUBINHO - HARDFUNK - 03 AVISO", "OO RUBINHO", "HARDFUNK") == (3, "AVISO")
    assert parse_track_filename("01 Conflito") == (1, "Conflito")
    assert parse_track_filename("07 - Até de Manhã") == (7, "Até de Manhã")
    assert parse_track_filename("12. Zaffe") == (12, "Zaffe")
    assert parse_track_filename("DJ K - Bruxaria Infinita", "DJ K", "") == (None, "Bruxaria Infinita")
    assert parse_track_filename("Faixa Solta") == (None, "Faixa Solta")
    # número de BPM no título não vira número de faixa quando há prefixo artista
    assert parse_track_filename("DJ K - 150 BPM PESADÃO", "DJ K", "") == (None, "150 BPM PESADÃO")


def _touch(d: Path, names):
    for n in names:
        (d / n).write_bytes(b"x")


def test_build_plan_bandcamp_layout():
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "src", Path(td) / "out"
        src.mkdir()
        _touch(src, ["OO RUBINHO - HARDFUNK - 02 COMBAL.flac", "OO RUBINHO - HARDFUNK - 01 VILÃO.flac", "cover.jpg"])
        plan = build_plan(src, out, artist="OO Rubinho", release="HARDFUNK", year=2022,
                          label="Business Casual", genre="Funk Brasileiro", allow_lossy=False)
        assert plan.dest_dir == out / "Funk Brasileiro" / "OO Rubinho" / "HARDFUNK"
        assert [it.dest_name for it in plan.items] == ["01 VILÃO.flac", "02 COMBAL.flac"]
        assert plan.cover and plan.cover.name == "cover.jpg"
        assert plan.tags["DATE"] == "2022" and plan.tags["TRACKTOTAL"] == "2" and plan.tags["LABEL"] == "Business Casual"


def test_build_plan_unnumbered_and_wav():
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "src", Path(td) / "out"
        src.mkdir()
        _touch(src, ["Zaffe.wav", "Conflito.wav"])
        plan = build_plan(src, out, artist="Adame DJ", release="EP", year=None, label=None,
                          genre="Funk Brasileiro", allow_lossy=False)
        # sem número: ordem alfabética, numera de 1
        assert [it.dest_name for it in plan.items] == ["01 Conflito.flac", "02 Zaffe.flac"]
        assert all(it.lossy_source is None for it in plan.items)
        assert "DATE" not in plan.tags


def test_build_plan_lossy_guard():
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "src", Path(td) / "out"
        src.mkdir()
        _touch(src, ["01 Faixa.mp3"])
        try:
            build_plan(src, out, artist="X", release="Y", year=None, label=None, genre="G", allow_lossy=False)
            assert False, "devia recusar lossy sem --allow-lossy"
        except ValueError as e:
            assert "lossy" in str(e)
        plan = build_plan(src, out, artist="X", release="Y", year=None, label=None, genre="G", allow_lossy=True)
        assert plan.items[0].lossy_source == "mp3"


def test_build_plan_rejects_url_artist():
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "src", Path(td) / "out"
        src.mkdir()
        _touch(src, ["01 Faixa.flac"])
        try:
            build_plan(src, out, artist="www.ftpdjemilio.com", release="Y", year=None, label=None, genre="G", allow_lossy=False)
            assert False
        except ValueError as e:
            assert "URL" in str(e)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} testes passaram")
