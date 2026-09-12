#!/usr/bin/env python3
"""Transcode do acervo pra staging do celular: FLAC -> Opus 192k VBR.

Tags via ffmpeg (-map_metadata), capas re-embutidas via mutagen (ffmpeg nao
escreve METADATA_BLOCK_PICTURE em ogg/opus). Nao-FLAC de audio copia as-is
(ja lossy; re-encodar degradaria). Idempotente: pula dst mais novo que src.

Roda na cmr-auto (onde vive o acervo). Copia canonica e esta, no repo; a de
`~/phone_sync_encode.py` e deploy. Depois da leva, `phone_push_retry.sh`.

Por que o resultado e VALIDADO por duracao, e nao por tamanho > 0: parte do
acervo tem FLAC com lixo entre o fim dos metadados e o primeiro frame de
audio (bloco PADDING com tamanho declarado errado). O GStreamer resincroniza
e toca — por isso essas faixas funcionam no desktop. O ffmpeg NAO: aborta a
leitura, **sai com codigo 0** e escreve um .opus de ~200 bytes, sem uma
amostra. A capa re-embutida depois inflava esse natimorto pra ~470 KB, ele
passava no teste de tamanho, ia pro celular e aparecia na lista com titulo e
capa certos — sem nada pra tocar. Dai as duas defesas aqui: `playable()`
compara duracao com a origem, e o fallback `gst_encode()` recupera a faixa
decodificando pelo GStreamer.
"""

import base64
import hashlib
import json
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from mutagen.flac import FLAC
from mutagen.oggopus import OggOpus

SRC = Path.home() / "Music"
DST = Path.home() / ".cache" / "phone-sync" / "Music"
LOG_EVERY = 50
WORKERS = 6
COPY_EXTS = {".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".lrc",
             ".jpg", ".jpeg", ".png"}
SKIP_DIRS = {".git", ".claude", ".rustify-incoming", "scripts"}
# Gatilho do fallback: encode limpo bate a origem quase exato (mediana medida
# no acervo: 1.00003). Ficar abaixo disso significa que o ffmpeg parou cedo.
MIN_DURATION_RATIO = 0.98
# Aceitacao de faixa RECUPERADA: o GStreamer entra depois do lixo e perde os
# primeiros segundos (5-6% nos casos vistos). Exigir 0.98 aqui reprovava
# recuperacao boa — e o resultado seria a faixa sumir. O piso so precisa
# separar "tem musica" de natimorto (0.0) e truncamento grosseiro.
RECOVERED_MIN_RATIO = 0.5
# O armazenamento do Android recusa estes chars no nome: o `adb push` responde
# "Operation not permitted", perde a conexao e DERRUBA A LEVA INTEIRA (um
# `:` do Otis Redding queimou as 40 tentativas do retry). Sanitizar aqui e
# seguro: o app casa manifest x arquivo por stem canonico, e `canon_stem`
# (mobile_library.rs) normaliza `_` e `:` os dois pra espaco.
ILLEGAL_CHARS = '"*:<>?\\|'
SAFE_CHAR = "_"
# Nomes que o app trata como capa de pasta (COVER_NAMES em mobile_library.rs).
# O `--deploy` do export os escreve fora de `.rustify/`; o purge nao pode
# confundi-los com orfao.
COVER_NAMES = {"cover.jpg", "cover.jpeg", "cover.png", "folder.jpg"}

_cover_ok: dict[str, bool] = {}


def safe_rel(rel: Path) -> Path:
    """Caminho de destino aceitavel pelo celular, componente a componente."""
    return Path(*[
        "".join(SAFE_CHAR if c in ILLEGAL_CHARS else c for c in part)
        for part in rel.parts
    ])


def gather():
    jobs = []
    for p in SRC.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(SRC)
        if any(part in SKIP_DIRS or part.startswith(".") for part in rel.parts[:-1]):
            continue
        if rel.name.startswith("."):
            continue
        ext = p.suffix.lower()
        if ext == ".flac":
            jobs.append(("encode", p, DST / safe_rel(rel.with_suffix(".opus"))))
        elif ext in COPY_EXTS:
            jobs.append(("copy", p, DST / safe_rel(rel)))
    return jobs


def purge_illegal() -> list[str]:
    """Remove destino gerado antes da sanitizacao. O nome novo nasce no
    gather; o velho precisa sair ou o push volta a travar nele."""
    removidos = []
    for p in DST.rglob("*"):
        if p.is_file() and any(c in ILLEGAL_CHARS for c in str(p.relative_to(DST))):
            removidos.append(str(p.relative_to(DST)))
            p.unlink()
    prune_empty_dirs()
    return removidos


def purge_orphans(expected: set) -> list[str]:
    """Destino cuja origem sumiu ou mudou de nome. O gather so olha a origem,
    entao esse arquivo ficaria no staging pra sempre e iria pro celular como
    duplicata (as duas versoes colapsam no mesmo stem canonico e uma vence).

    Dois grupos de artefato NAO sao do encode e ficam de fora:
    - `.rustify/` (manifest, vetores, taste, stations, covers/) — do
      export_manifest.py.
    - `cover.jpg`/`folder.jpg` nas pastas de album: o `--deploy` do export
      escreve ~556 deles como fallback do `resolve_cover`, e o gather so
      espera os que existem no acervo (39). Tratar como orfao apagava a
      capa que o export acabou de pôr — e o proximo export a recriava, num
      ciclo que nao terminava. Sao preservados enquanto a pasta ainda tiver
      algum arquivo esperado; de album que saiu do acervo, saem tambem."""
    dirs_vivos = {d.parent for d in expected}
    removidos = []
    for p in DST.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(DST)
        if any(part.startswith(".") for part in rel.parts[:-1]):
            continue
        if p in expected:
            continue
        if p.name.lower() in COVER_NAMES and p.parent in dirs_vivos:
            continue
        removidos.append(str(rel))
        p.unlink()
    prune_empty_dirs()
    return removidos


def report_purge(rotulo: str, removidos: list[str], amostra: int = 20):
    """Operacao destrutiva tem que dizer O QUE apagou, nao so quantos. Em
    10/09 sairam 571 arquivos com contagem e sem lista — a pergunta "o que
    eram?" ficou sem resposta possivel. Lista completa vai pro .DONE."""
    if not removidos:
        return
    print(f"removidos do staging ({rotulo}): {len(removidos)}", flush=True)
    for r in sorted(removidos)[:amostra]:
        print(f"  - {r}", flush=True)
    if len(removidos) > amostra:
        print(f"  ... +{len(removidos) - amostra} (lista completa em "
              f"phone-sync.DONE)", flush=True)


def prune_empty_dirs():
    for d in sorted((d for d in DST.rglob("*") if d.is_dir()),
                    key=lambda x: -len(x.parts)):
        try:
            d.rmdir()  # so remove se ficou vazio
        except OSError:
            pass


def probe_duration(path: Path) -> float:
    """Duracao em segundos pelo container; 0.0 se ilegivel."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, timeout=60,
        )
        return float(r.stdout.decode().strip())
    except (subprocess.SubprocessError, ValueError):
        return 0.0


def src_duration(path: Path) -> float:
    """Duracao da origem pelo STREAMINFO — sem subprocess."""
    try:
        return float(FLAC(path).info.length)
    except Exception:  # noqa: BLE001 — origem ilegivel vira "sem referencia"
        return 0.0


def duration_ok(want: float, got: float, ratio: float) -> bool:
    """Aceita o destino: precisa ter audio e cobrir a origem (quando ha ref)."""
    if got <= 0:
        return False
    return want <= 0 or got >= want * ratio


def playable(src: Path, dst: Path, ratio: float = RECOVERED_MIN_RATIO) -> bool:
    """Default permissivo de proposito: e o teste de "da pra tocar isso?",
    usado tambem pelo `fresh()`. Faixa recuperada tem que passar aqui, senao
    seria re-encodada em toda leva e nunca aceita."""
    return duration_ok(src_duration(src), probe_duration(dst), ratio)


def gst_encode(src: Path, tmp: Path):
    """Recupera FLAC que o ffmpeg nao consegue ler: decodifica com GStreamer
    (resincroniza no primeiro frame valido) e reencoda do PCM, puxando as
    tags do arquivo original."""
    wav = tmp.with_suffix(".wav")
    try:
        subprocess.run(
            ["gst-launch-1.0", "-q", "filesrc", f"location={src}",
             "!", "decodebin", "!", "audioconvert", "!", "audioresample",
             "!", "wavenc", "!", "filesink", f"location={wav}"],
            check=True, capture_output=True, timeout=900,
        )
        subprocess.run(
            ["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(wav),
             "-i", str(src), "-map", "0:a:0", "-map_metadata", "1",
             "-c:a", "libopus", "-b:a", "192k", str(tmp)],
            check=True, capture_output=True, timeout=900,
        )
    finally:
        wav.unlink(missing_ok=True)


def encode(src: Path, tmp: Path):
    base = ["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(src),
            "-vn", "-map_metadata", "0", "-c:a", "libopus", "-b:a", "192k"]
    try:
        subprocess.run([*base, str(tmp)], check=True,
                       capture_output=True, timeout=300)
    except subprocess.CalledProcessError:
        # Rips multicanal (5.1) — libopus rejeita o layout sem remap;
        # celular+Bluetooth é estereo de qualquer forma.
        subprocess.run([*base[:-2], "-ac", "2", *base[-2:], str(tmp)],
                       check=True, capture_output=True, timeout=600)
    if playable(src, tmp, MIN_DURATION_RATIO):
        return None
    gst_encode(src, tmp)
    if not playable(src, tmp):
        raise RuntimeError("sem audio decodificavel (ffmpeg e gstreamer)")
    want, got = src_duration(src), probe_duration(tmp)
    return f"recuperado via gstreamer: {got:.0f}s de {want:.0f}s"


def cover_ok(pic) -> bool:
    """Capa que o decoder nao abre derruba a faixa inteira no player. Valida
    uma vez por imagem (a mesma se repete no album todo)."""
    key = hashlib.sha1(pic.data).hexdigest()
    cached = _cover_ok.get(key)
    if cached is not None:
        return cached
    try:
        r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", "pipe:0",
                            "-f", "null", "-"],
                           input=pic.data, capture_output=True, timeout=60)
        ok = r.returncode == 0 and not r.stderr.strip()
    except subprocess.SubprocessError:
        ok = False
    _cover_ok[key] = ok
    return ok


def embed_pictures(src: Path, dst: Path):
    pics = [p for p in FLAC(src).pictures if cover_ok(p)]
    if not pics:
        return
    o = OggOpus(dst)
    o["metadata_block_picture"] = [
        base64.b64encode(p.write()).decode() for p in pics
    ]
    o.save()


def fresh(src: Path, dst: Path) -> bool:
    try:
        st = dst.stat()
    except OSError:
        return False
    if st.st_size == 0 or st.st_mtime < src.stat().st_mtime:
        return False
    # Destino .opus so conta como pronto se tiver audio de verdade: e o unico
    # jeito de reprocessar os natimortos que ja foram parar no staging.
    return dst.suffix.lower() != ".opus" or playable(src, dst)


def run(job):
    """-> None | ("NOTA"|"ERRO", mensagem)."""
    kind, src, dst = job
    if fresh(src, dst):
        return None
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp.opus")
    try:
        if kind == "copy":
            shutil.copy2(src, dst)
            return None
        note = encode(src, tmp)
        embed_pictures(src, tmp)
        tmp.rename(dst)
        return ("NOTA", f"{src.relative_to(SRC)}: {note}") if note else None
    except Exception as e:  # noqa: BLE001 — coleta e segue; falha una nao para a leva
        if kind == "encode":
            tmp.unlink(missing_ok=True)
            # Destino velho e intocavel derrubaria a faixa no player, com
            # titulo e capa certos e nada pra tocar. Sem arquivo, o app a
            # descarta da biblioteca — sumir e melhor que fantasma.
            if dst.exists() and not playable(src, dst):
                dst.unlink(missing_ok=True)
        return ("ERRO", f"{src.relative_to(SRC)}: {type(e).__name__}: {e}")


def main():
    purged = purge_illegal()
    report_purge("nome recusado pelo Android", purged)
    jobs = gather()
    orphans = purge_orphans({d for _, _, d in jobs})
    report_purge("origem sumiu/renomeada", orphans)
    print(f"jobs: {len(jobs)}", flush=True)
    errors, notes, done = [], [], 0
    with ThreadPoolExecutor(WORKERS) as ex:
        for res in ex.map(run, jobs):
            done += 1
            if res:
                tag, msg = res
                (errors if tag == "ERRO" else notes).append(msg)
                print(f"{tag} {msg}", flush=True)
            if done % LOG_EVERY == 0:
                print(f"{done}/{len(jobs)}", flush=True)
    summary = {"total": len(jobs), "errors": errors, "recovered": notes,
               "purged_illegal": purged, "purged_orphans": orphans}
    (Path.home() / "phone-sync.DONE").write_text(json.dumps(summary, ensure_ascii=False))
    print(f"DONE total={len(jobs)} errors={len(errors)} recuperadas={len(notes)}",
          flush=True)


if __name__ == "__main__":
    sys.exit(main())
