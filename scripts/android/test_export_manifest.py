#!/usr/bin/env python3
"""Testes das funções puras de export_manifest (sem Qdrant).

Sem pytest: asserts puros + runner, no padrão de scripts/curator/
test_discover_tracks.py. Cobre o estado do like no manifest (CMR-220):
  - build_manifest emite `liked_at`/`like_updated_at` por track — presente
    quando o desktop tem o like, `null` quando ausente (e nas chamadas antigas
    sem like_state).
  - fetch_like_state pagina o scroll de track_enrichments e mapeia por
    track_id string (qpost substituído por um fake em memória).
E as capas por álbum-key (CMR-212):
  - cover_rel troca `covers/<sha1>.webp` (cache do desktop) por
    `covers/<sha1>.jpg` (relativo a `.rustify/` no aparelho).
  - build_manifest emite `cover` por track (mesmo cover_path → mesmo cover).
  - cover_jobs separa a primeira capa por pasta (cover.jpg de fallback) do
    conjunto de capas DISTINTAS (uma conversão por álbum-key).
E o job remoto de capas (CMR-212, revisão do ce61a30):
  - covers_job_source compila e carrega os marcadores da idempotência
    (tmp + rename, pronto = > 0 bytes, cópia na fase b).
  - o job EXECUTADO num staging temporário com um ffmpeg de mentira: jpg
    truncado é refeito, falha não deixa dst nem .tmp, a fase (b) copia o que
    a fase (a) converteu, a 2ª rodada só re-tenta o que falhou, .tmp órfãos
    de aborts anteriores são varridos e o stderr do ffmpeg sobe com o nome
    da origem (antes a falha era só um contador).
  - report_covers_job ecoa stdout, roteia stderr e aborta com rc != 0.

Rodar: python3 scripts/android/test_export_manifest.py
É gate DE FATO do release Android: scripts/release_android.sh roda este
arquivo antes do build e aborta se falhar.
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import export_manifest as E


def check(name, got, want):
    status = "ok" if got == want else "FAIL"
    if got != want:
        check.failed += 1
        print(f"  [{status}] {name}\n        got:  {got!r}\n        want: {want!r}")
    else:
        print(f"  [{status}] {name}")


check.failed = 0


def point(tid, rel):
    return {"id": tid, "payload": {"path": E.MUSIC_ROOT + rel, "title": f"t{tid}",
                                   "duration_ms": 1000}}


def test_build_manifest_like_state():
    print("build_manifest (liked_at/like_updated_at):")
    points = [point(1, "A/a.flac"), point(2, "A/b.flac"), point(3, "A/c.flac")]
    like_state = {
        "1": (1_700_000_000, 1_700_000_100),   # curtida
        "3": (None, 1_700_000_200),            # descurtida (LWW precisa do carimbo)
    }
    m = E.build_manifest(points, like_state)
    by_id = {t["track_id"]: t for t in m["tracks"]}
    check("curtida: liked_at + like_updated_at",
          (by_id["1"]["liked_at"], by_id["1"]["like_updated_at"]),
          (1_700_000_000, 1_700_000_100))
    check("ausente: os dois null",
          (by_id["2"]["liked_at"], by_id["2"]["like_updated_at"]), (None, None))
    check("descurtida: liked_at null, like_updated_at presente",
          (by_id["3"]["liked_at"], by_id["3"]["like_updated_at"]),
          (None, 1_700_000_200))
    # chamada antiga (sem like_state): as chaves EXISTEM e são null — o
    # ManifestTrack do Rust tolera ausência, mas o shape fica estável.
    m2 = E.build_manifest(points)
    check("sem like_state: chaves presentes e null",
          all("liked_at" in t and "like_updated_at" in t
              and t["liked_at"] is None and t["like_updated_at"] is None
              for t in m2["tracks"]), True)
    check("track_id continua string", type(m["tracks"][0]["track_id"]), str)


def test_fetch_like_state_pagina_e_mapeia():
    print("fetch_like_state:")
    pages = [
        {"points": [
            {"id": 1, "payload": {"liked_at": 10, "like_updated_at": 11}},
            {"id": 2, "payload": {"liked_at": 20}},                # sem carimbo
            {"id": "uuid-nao-u64", "payload": {"liked_at": 30}},  # id fora do acervo
        ], "next_page_offset": 3},
        {"points": [
            {"id": 3, "payload": {"like_updated_at": 31}},         # unlike
            {"id": 4, "payload": {}},                              # sem nada: fora
        ], "next_page_offset": None},
    ]
    calls = []

    def fake_qpost(base_url, path, body):
        calls.append((path, body.get("offset")))
        return pages[len(calls) - 1]

    real = E.qpost
    E.qpost = fake_qpost
    try:
        state = E.fetch_like_state("http://fake")
    finally:
        E.qpost = real
    check("duas páginas, offset da 2ª = next_page_offset da 1ª",
          [c[1] for c in calls], [None, 3])
    check("scroll na collection de enrichments",
          all(c[0] == f"/collections/{E.ENRICHMENTS}/points/scroll" for c in calls), True)
    check("curtida com carimbo", state.get("1"), (10, 11))
    check("curtida sem carimbo", state.get("2"), (20, None))
    check("unlike: só o carimbo", state.get("3"), (None, 31))
    check("id não-inteiro ignorado", "uuid-nao-u64" in state, False)
    check("ponto sem like nem carimbo fica fora", "4" in state, False)
    check("chaves são string", all(isinstance(k, str) for k in state), True)


def point_cover(tid, rel, cover):
    p = point(tid, rel)
    if cover is not None:
        p["payload"]["cover_path"] = cover
    return p


def test_cover_rel_troca_webp_por_jpg():
    print("cover_rel:")
    sha = "a" * 40
    check("webp do cache vira jpg relativo a .rustify/",
          E.cover_rel(f"covers/{sha}.webp"), f"covers/{sha}.jpg")
    check("vazio → None", E.cover_rel(""), None)
    check("None → None", E.cover_rel(None), None)


def test_build_manifest_emite_cover_por_track():
    print("build_manifest (cover):")
    sha_x, sha_y = "x" * 40, "y" * 40
    points = [
        point_cover(1, "A/a.flac", f"covers/{sha_x}.webp"),
        point_cover(2, "A/b.flac", f"covers/{sha_x}.webp"),   # mesmo álbum-key
        point_cover(3, "B/c.flac", f"covers/{sha_y}.webp"),
        point_cover(4, "B/d.flac", None),                     # sem capa no desktop
    ]
    m = E.build_manifest(points, {"1": (1_700_000_000, 1_700_000_100)})
    by_id = {t["track_id"]: t for t in m["tracks"]}
    check("cover relativo a .rustify/", by_id["1"]["cover"], f"covers/{sha_x}.jpg")
    check("mesmo cover_path → mesmo cover", by_id["1"]["cover"], by_id["2"]["cover"])
    check("álbum-key distinto → cover distinto", by_id["3"]["cover"], f"covers/{sha_y}.jpg")
    check("sem cover_path → null", by_id["4"]["cover"], None)
    check("os campos do CMR-220 continuam",
          (by_id["1"]["liked_at"], by_id["1"]["like_updated_at"], by_id["4"]["liked_at"]),
          (1_700_000_000, 1_700_000_100, None))


def test_cover_jobs_deduplica_capas_e_mantem_primeira_por_pasta():
    print("cover_jobs:")
    sha_x, sha_y = "x" * 40, "y" * 40
    points = [
        point_cover(1, "A/a.flac", f"covers/{sha_x}.webp"),
        point_cover(2, "A/b.flac", f"covers/{sha_y}.webp"),   # 2ª capa na mesma pasta
        point_cover(3, "B/c.flac", f"covers/{sha_x}.webp"),   # capa repetida, outra pasta
        point_cover(4, "C/d.flac", None),                     # sem capa: fora dos dois mapas
        {"id": 5, "payload": {"path": "/outro/root/e.flac", "cover_path": f"covers/{sha_y}.webp"}},
    ]
    dir_cover, distinct = E.cover_jobs(points)
    check("pasta fica com a PRIMEIRA capa (setdefault)",
          dir_cover, {"A": f"covers/{sha_x}.webp", "B": f"covers/{sha_x}.webp"})
    check("capas distintas deduplicadas, jpg → webp do cache",
          distinct, {f"{sha_x}.jpg": f"covers/{sha_x}.webp", f"{sha_y}.jpg": f"covers/{sha_y}.webp"})


def test_covers_job_source_compila_e_carrega_os_marcadores():
    print("covers_job_source:")
    src = E.covers_job_source()
    try:
        compile(src, "<covers-job>", "exec")
        compiles = True
    except SyntaxError as e:
        compiles = f"SyntaxError: {e}"
    check("compila", compiles, True)
    check("caminhos da cmr-auto injetados", E.STAGING in src and E.COVER_CACHE in src, True)
    check("escreve via tmp + rename", ".tmp" in src and ".replace(" in src, True)
    check("pronto = arquivo com > 0 bytes", "st_size > 0" in src, True)
    check("fase (b) copia o que a fase (a) converteu", "copyfile" in src, True)
    check("ffmpeg recebe o formato explícito (.tmp não tem extensão de imagem)",
          '"-f", "image2"' in src and '"-c:v", "mjpeg"' in src, True)
    staged = E.covers_job_source("/x/staging", "/x/cache")
    check("staging/cache parametrizáveis (o teste executa num tmp)",
          "'/x/staging'" in staged and "'/x/cache'" in staged, True)


# ffmpeg de mentira: copia o `-i SRC` pro último argumento (o destino).
# Origem com conteúdo FAIL escreve lixo parcial, reclama no stderr (como o
# ffmpeg real) e falha — simula o abort no meio da conversão. Cada chamada
# registra "SRC -> DST" em $FAKE_FFMPEG_LOG.
FAKE_FFMPEG = """#!/bin/sh
src=""; prev=""
for a in "$@"; do [ "$prev" = "-i" ] && src="$a"; prev="$a"; done
for a in "$@"; do dst="$a"; done
echo "$src -> $dst" >> "$FAKE_FFMPEG_LOG"
if [ "$(cat "$src")" = "FAIL" ]; then
  printf 'partial' > "$dst"
  echo "fake ffmpeg: Invalid data found when processing input" >&2
  exit 1
fi
cp "$src" "$dst"
"""


def run_covers_job(tmp: Path, mapping: dict):
    """Executa o job remoto localmente: script em arquivo (como o ssh faz),
    mapa no stdin, ffmpeg de mentira na frente do PATH. Devolve o processo e
    a lista de chamadas do ffmpeg desta rodada."""
    script = tmp / "covers-job.py"
    script.write_text(E.covers_job_source(str(tmp / "staging"), str(tmp / "cache")))
    log = tmp / "ffmpeg.log"
    log.write_text("")
    env = dict(os.environ, PATH=f"{tmp / 'bin'}:{os.environ.get('PATH', '')}",
               FAKE_FFMPEG_LOG=str(log))
    proc = subprocess.run([sys.executable, str(script)], input=json.dumps(mapping),
                          capture_output=True, text=True, env=env, timeout=60)
    return proc, log.read_text().splitlines()


def test_covers_job_idempotente_e_atomico():
    print("covers-job executado (ffmpeg de mentira):")
    sha_a, sha_b, sha_c, sha_d = "a" * 40, "b" * 40, "c" * 40, "d" * 40
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        (bin_dir / "ffmpeg").write_text(FAKE_FFMPEG)
        (bin_dir / "ffmpeg").chmod(0o755)
        cache = tmp / "cache" / "covers"
        cache.mkdir(parents=True)
        (cache / f"{sha_a}.webp").write_bytes(b"A")
        (cache / f"{sha_b}.webp").write_bytes(b"B")
        (cache / f"{sha_c}.webp").write_bytes(b"FAIL")   # ffmpeg aborta no meio
        # sha_d: sem origem no cache
        staging = tmp / "staging"
        covers_dir = staging / ".rustify" / "covers"
        covers_dir.mkdir(parents=True)
        (covers_dir / f"{sha_b}.jpg").write_bytes(b"")     # truncada por abort anterior
        # .tmp órfãos de um abort anterior (ffmpeg morto no meio): não estão
        # no mapa, então só a varredura do job os remove.
        (covers_dir / f"{sha_a}.jpg.tmp").write_bytes(b"lixo")
        (covers_dir / "orfao.jpg.tmp").write_bytes(b"lixo")
        (staging / "P1").mkdir()
        (staging / "P1" / "cover.jpg.tmp").write_bytes(b"lixo")   # pasta ainda sem capa
        (staging / "P2").mkdir()
        (staging / "P2" / "cover.jpg").write_bytes(b"old")  # já pronta
        (staging / "P2" / "cover.jpg.tmp").write_bytes(b"lixo")   # órfão ao lado da pronta
        (staging / "P4").mkdir()
        # P3 não existe no staging
        mapping = {
            "distinct": {f"{s}.jpg": f"covers/{s}.webp" for s in (sha_a, sha_b, sha_c, sha_d)},
            "dirs": {"P1": f"covers/{sha_a}.webp", "P2": f"covers/{sha_b}.webp",
                     "P3": f"covers/{sha_a}.webp", "P4": f"covers/{sha_c}.webp"},
        }

        proc, calls = run_covers_job(tmp, mapping)
        check("rc 0 (falha de capa é contador, não abort)", proc.returncode, 0)
        check("A convertida: dst com o conteúdo da origem",
              (covers_dir / f"{sha_a}.jpg").read_bytes(), b"A")
        check("B truncada (0 bytes) NÃO conta como pronta: reconvertida",
              (covers_dir / f"{sha_b}.jpg").read_bytes(), b"B")
        check("C falhou: nem dst nem .tmp sobram",
              sorted(p.name for p in covers_dir.iterdir() if sha_c in p.name), [])
        check("D sem origem: ausente", (covers_dir / f"{sha_d}.jpg").exists(), False)
        check("ffmpeg escreve sempre no .tmp, nunca no destino final",
              all(line.endswith(".jpg.tmp") for line in calls) and bool(calls), True)
        check("(b) P1: copiada de covers/, sem ffmpeg",
              (staging / "P1" / "cover.jpg").read_bytes(), b"A")
        check("(b) P2 pronta: intocada", (staging / "P2" / "cover.jpg").read_bytes(), b"old")
        check("(b) P4 sem jpg em covers/: cai no ffmpeg, falha limpa",
              sorted(p.name for p in (staging / "P4").iterdir()), [])
        check("ffmpeg: A, B, C na fase (a) + C de novo na (b) = 4 chamadas", len(calls), 4)
        check("nenhum .tmp sobrou no staging (inclusive os órfãos de antes)",
              [str(p.relative_to(staging)) for p in staging.rglob("*.tmp")], [])
        check("órfão em covers/ removido mesmo fora do mapa",
              (covers_dir / "orfao.jpg.tmp").exists(), False)
        check("órfão ao lado de cover.jpg pronta removido sem tocar na capa",
              ((staging / "P2" / "cover.jpg.tmp").exists(),
               (staging / "P2" / "cover.jpg").read_bytes()), (False, b"old"))
        check("stderr do ffmpeg chega ao stderr do job, com o nome da origem (fase a + fase b)",
              proc.stderr.count(f"ffmpeg {sha_c}.webp: fake ffmpeg: Invalid data"), 2)
        check("contadores da fase (a)",
              "covers/: 2 convertidas, 0 já existiam, 1 sem origem, 1 falhas (4 distintas)"
              in proc.stdout, True)
        check("contadores da fase (b)",
              "cover.jpg por pasta: 0 convertidas, 1 copiadas de covers/, 1 já existiam, "
              "1 sem origem/pasta, 1 falhas" in proc.stdout, True)

        proc2, calls2 = run_covers_job(tmp, mapping)
        check("2ª rodada: só as falhas (C) re-tentadas", len(calls2), 2)
        check("2ª rodada: A e B já existiam",
              "covers/: 0 convertidas, 2 já existiam, 1 sem origem, 1 falhas" in proc2.stdout, True)
        check("2ª rodada: P1 e P2 já existiam",
              "cover.jpg por pasta: 0 convertidas, 0 copiadas de covers/, 2 já existiam, "
              "1 sem origem/pasta, 1 falhas" in proc2.stdout, True)


def test_report_covers_job_ecoa_roteia_e_aborta():
    print("report_covers_job:")
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        E.report_covers_job(0, "covers/: 1 convertidas\n", "")
    check("rc 0: stdout ecoado, stderr vazio",
          (out.getvalue().strip(), err.getvalue()), ("covers/: 1 convertidas", ""))

    out, err = io.StringIO(), io.StringIO()
    raised = None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            E.report_covers_job(1, "covers/: 3 convertidas\n",
                                "Traceback (most recent call last):\nKeyError: 'dirs'\n")
        except SystemExit as e:
            raised = str(e)
    check("rc != 0 aborta com o rc na mensagem", raised, "covers-job falhou rc=1")
    check("stdout parcial ainda ecoado", "3 convertidas" in out.getvalue(), True)
    check("stderr do job vai pro stderr local (não some atrás do stdout)",
          "KeyError" in err.getvalue() and "KeyError" not in out.getvalue(), True)


def main():
    for t in (test_build_manifest_like_state, test_fetch_like_state_pagina_e_mapeia,
              test_cover_rel_troca_webp_por_jpg, test_build_manifest_emite_cover_por_track,
              test_cover_jobs_deduplica_capas_e_mantem_primeira_por_pasta,
              test_covers_job_source_compila_e_carrega_os_marcadores,
              test_covers_job_idempotente_e_atomico,
              test_report_covers_job_ecoa_roteia_e_aborta):
        t()
    print()
    if check.failed:
        print(f"FALHOU: {check.failed} assercao(oes)")
        sys.exit(1)
    print("todos os testes passaram")


if __name__ == "__main__":
    main()
