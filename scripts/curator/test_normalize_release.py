#!/usr/bin/env python3
"""Testes das funções puras do normalize_release.py (sem mutagen, sem ffmpeg, sem numpy).

    python3 scripts/curator/test_normalize_release.py
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from normalize_release import build_plan, describe, flac_cmd, main, loose, looks_like_url, parse_track_filename, safe_name, strip_artist_suffix  # noqa: E402


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


def test_strip_artist_suffix():
    assert strip_artist_suffix("Igrejinha - Buarky feat. PE$TE e Edge Flow", "Buarky feat. Pe$te & Edge Flow") == "Igrejinha"
    assert strip_artist_suffix("Toma de Graça - Mu540, DJ Turano e MC Larisson", "Mu540, DJ Turano & MC Larisson") == "Toma de Graça"
    # sufixo que NÃO é o artista fica
    assert strip_artist_suffix("Curtição 420 - Bad Sista feat. Lei Di Dai", "BadSista") == "Curtição 420 - Bad Sista feat. Lei Di Dai"
    assert strip_artist_suffix("Stars - Remix", None) == "Stars - Remix"
    assert loose("Pe$te & Edge") == loose("PE$TE e Edge")


def test_build_plan_track_artists():
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "src", Path(td) / "out"
        src.mkdir()
        names = ["Kioma - FUNK RAVE EP - 02 Aquecida - Kioma.flac", "kLap - FUNK RAVE EP - 04 Prime - kLap.flac"]
        _touch(src, names)
        plan = build_plan(src, out, artist="Kioma, Buarky, kLap e Mu540", release="Funk Rave EP", year=2020,
                          label="Funk na Caixa", genre="Funk Brasileiro",
                          track_artists={names[0]: "Kioma", names[1]: "kLap"})
        assert [(it.track_no, it.title, it.track_artist) for it in plan.items] == [(2, "Aquecida", "Kioma"), (4, "Prime", "kLap")]
        assert plan.tags["ALBUMARTIST"] == "Kioma, Buarky, kLap e Mu540"
        # ARTIST do arquivo igual ao albumartist não vira crédito por faixa; URL é ignorada
        plan2 = build_plan(src, out, artist="Kioma", release="X", year=None, label=None, genre="G",
                           track_artists={names[0]: "KIOMA", names[1]: "www.ripper.com"})
        assert [it.track_artist for it in plan2.items] == [None, None]
        # --flat-artist ignora tudo
        plan3 = build_plan(src, out, artist="Z", release="X", year=None, label=None, genre="G",
                           flat_artist=True, track_artists={names[0]: "Kioma"})
        assert plan3.items[0].track_artist is None


def _touch(d: Path, names):
    for n in names:
        (d / n).write_bytes(b"x")


def test_build_plan_bandcamp_layout():
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "src", Path(td) / "out"
        src.mkdir()
        _touch(src, ["OO RUBINHO - HARDFUNK - 02 COMBAL.flac", "OO RUBINHO - HARDFUNK - 01 VILÃO.flac", "cover.jpg"])
        plan = build_plan(src, out, artist="OO Rubinho", release="HARDFUNK", year=2022,
                          label="Business Casual", genre="Funk Brasileiro", track_artists={})
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
                          genre="Funk Brasileiro")
        # sem número: ordem alfabética, numera de 1
        assert [it.dest_name for it in plan.items] == ["01 Conflito.flac", "02 Zaffe.flac"]
        assert "DATE" not in plan.tags


def test_build_plan_lossy_na_origem_e_erro_sem_escape():
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "src", Path(td) / "out"
        src.mkdir()
        _touch(src, ["01 Faixa.mp3", "02 Outra.flac"])
        try:
            build_plan(src, out, artist="X", release="Y", year=None, label=None, genre="G", track_artists={})
            assert False, "devia recusar lossy na origem"
        except ValueError as e:
            msg = str(e)
            assert "lossy não entra" in msg and "01 Faixa.mp3" in msg
            assert "--allow-lossy" not in msg and "02 Outra.flac" not in msg
        # a flag de escape não existe mais
        try:
            main(["--src", str(src), "--out", str(out), "--artist", "X", "--release", "Y", "--allow-lossy"])
            assert False
        except SystemExit as e:
            assert e.code == 2
        # todos os formatos lossy
        for ext in (".m4a", ".aac", ".ogg", ".opus"):
            (src / "01 Faixa.mp3").unlink(missing_ok=True)
            _touch(src, [f"03 Z{ext}"])
            try:
                build_plan(src, out, artist="X", release="Y", year=None, label=None, genre="G", track_artists={})
                assert False, ext
            except ValueError as e:
                assert f"03 Z{ext}" in str(e)
            (src / f"03 Z{ext}").unlink()


def test_build_plan_faixa_recusada_fica_fora():
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "src", Path(td) / "out"
        src.mkdir()
        names = ["A - EP - 01 Boa.flac", "A - EP - 02 Falsa.flac", "A - EP - 03 Outra.wav"]
        _touch(src, names)
        why = "lossy por dentro, corte 16,0 kHz"
        plan = build_plan(src, out, artist="A", release="EP", year=None, label=None, genre="G",
                          track_artists={}, refused={names[1]: why})
        assert [it.dest_name for it in plan.items] == ["01 Boa.flac", "03 Outra.flac"]
        assert plan.refused == [(names[1], why)]
        assert plan.tags["TRACKTOTAL"] == "3"  # total do release, com os números originais
        txt = describe(plan)
        assert f"RECUSADA ({why})  <- {names[1]}" in txt
        # todas recusadas: plano vazio (o CLI sai com código 3), sem exceção
        plan2 = build_plan(src, out, artist="A", release="EP", year=None, label=None, genre="G",
                           track_artists={}, refused={n: why for n in names})
        assert plan2.items == [] and len(plan2.refused) == 3


def test_main_todas_recusadas_sai_com_codigo_3():
    import normalize_release as nr
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "src", Path(td) / "out"
        src.mkdir()
        _touch(src, ["01 Falsa.flac"])
        orig = nr.screen_sources
        nr.screen_sources = lambda _src: {"01 Falsa.flac": "lossy por dentro, corte 16,0 kHz"}
        try:
            rc = main(["--src", str(src), "--out", str(out), "--artist", "X", "--release", "Y", "--dry-run"])
        finally:
            nr.screen_sources = orig
        assert rc == 3
        assert not out.exists()


def test_build_plan_single_with_title():
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "src", Path(td) / "out"
        src.mkdir()
        _touch(src, ["FESTA DO PENTE RALA - DJ ARANA.wav"])
        plan = build_plan(src, out, artist="DJ Arana", release="Festa do Pente Rala", year=2024, label=None,
                          genre="Funk Brasileiro", track_artists={}, title="Festa do Pente Rala")
        assert [it.dest_name for it in plan.items] == ["01 Festa do Pente Rala.flac"]
        _touch(src, ["outra.wav"])
        try:
            build_plan(src, out, artist="X", release="Y", year=None, label=None, genre="G",
                       track_artists={}, title="Z")
            assert False
        except ValueError as e:
            assert "1 faixa" in str(e)


def test_build_plan_rejects_url_artist():
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "src", Path(td) / "out"
        src.mkdir()
        _touch(src, ["01 Faixa.flac"])
        try:
            build_plan(src, out, artist="www.ftpdjemilio.com", release="Y", year=None, label=None, genre="G")
            assert False
        except ValueError as e:
            assert "URL" in str(e)


def test_flac_cmd_sem_ramo_de_lossy():
    # só origem lossless chega ao ffmpeg: sem reamostragem/dither, qualquer extensão
    for ext in (".wav", ".aiff", ".mp3"):
        cmd = flac_cmd(Path("a" + ext), Path("b.flac"))
        assert not any("aresample" in c for c in cmd), cmd
        assert cmd[-3:] == ["-compression_level", "8", "b.flac"] and "flac" in cmd


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} testes passaram")
