#!/usr/bin/env python3
"""Auditoria de qualidade do acervo: quantas faixas "FLAC" são lossy por dentro.

Para cada FLAC: profundidade e taxa declaradas, origem declarada nas tags
(COMMENT etc.) e o CORTE ESPECTRAL — a frequência onde a energia despenca
num degrau. Codificador lossy (MP3, AAC) joga fora tudo acima de um
passa-baixa fixo (MP3 128 corta por volta de 16-17 kHz, 320 por volta de
20 kHz); gravação lossless em 44,1 kHz vai até perto de 22 kHz e cai aos
poucos, sem degrau. O degrau sobrevive à conversão para FLAC, por isso
denuncia o MP3 "disfarçado".

Mede 3 janelas de 20 s (20%, 45% e 70% da faixa; a faixa inteira se for
curta), L e R somados, quadros de silêncio fora.

Uso (na cmr-auto, onde está o acervo; numpy do python3 do sistema):
  nice -n 19 python3 quality_audit.py scan ~/Music --out audit.jsonl --workers 2
  python3 quality_audit.py summary audit.jsonl            # tabela por classe
  python3 quality_audit.py one arquivo.flac               # um arquivo, verboso

O scan retoma: caminhos já presentes no --out são pulados.
Testes das funções puras: python3 test_quality_audit.py
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

WINDOW_S = 20.0
WINDOW_AT = (0.20, 0.45, 0.70)
# Degrau mínimo (dB) entre a faixa logo abaixo e a logo acima do corte.
DROP_DB = 20.0
# Meia-largura das faixas comparadas em volta do candidato (Hz) e folga do centro.
SIDE_HZ = 500.0
GAP_HZ = 100.0
# Abaixo disto nenhum corte é procurado (conteúdo musical legítimo some antes).
SCAN_FROM_HZ = 10_000.0
# Quadro com energia 60 dB abaixo do mais forte da janela = silêncio, fora da média.
SILENCE_DB = 60.0

# Fronteiras das classes pelo corte (Hz), calibradas em 2026-10-15 com faixas
# lossless conhecidas (Tidal fora do funk, rips de CD, hi-res) e com MP3/AAC/Opus
# gerados a partir delas (relatório em docs/contexto/15102026-qualidade-soundcloud.md).
# O corte NÃO revela o bitrate: o LAME zera o que passa de 16 kHz nos quadros
# calmos até em 320 kbps, e o percentil 10 acha esse degrau.
CUT_LOSSY = 19_500.0   # abaixo: lossy (MP3 de qualquer taxa, AAC 160, stream do SoundCloud)
CUT_HIGH = 20_600.0    # abaixo: provável lossy (MP3 320, Opus, AAC alto; raro: resampler)
# Hi-res (taxa > 48 kHz) sem nada acima disto veio de 44,1/48 kHz.
HIRES_REAL_HZ = 24_500.0

SOURCE_KEYS = ("comment", "description", "encoder", "encoded_by", "url", "purl", "source", "www")
SOURCE_WORDS = ("tidal", "lossy", "lucida", "soundcloud", "bandcamp", "qobuz", "deezer", "youtube", "spotify")


def fft_size(sr: int) -> int:
    """~10,8 Hz por bin em 44,1 kHz; dobra o tamanho com a taxa."""
    n = 4096
    while sr / n > 12.0:
        n *= 2
    return n


def frame_spectra(x: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """x: (amostras, canais) float. Espectro de cada quadro (L+R somados), em dB
    RELATIVO à média de 2-8 kHz do próprio quadro. Quadros 60 dB abaixo do mais
    forte (silêncio, fade) ficam fora. Devolve (freqs, matriz quadros x bins)."""
    n = fft_size(sr)
    hop = n // 2
    freqs = np.fft.rfftfreq(n, 1 / sr)
    if x.ndim == 1:
        x = x[:, None]
    if x.shape[0] < n:
        return freqs, np.zeros((0, n // 2 + 1), np.float32)
    win = np.hanning(n).astype(np.float32)
    nfr = 1 + (x.shape[0] - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(nfr)[:, None]
    p = np.zeros((nfr, n // 2 + 1), np.float32)
    for c in range(x.shape[1]):
        p += np.abs(np.fft.rfft(x[idx, c] * win, axis=1)) ** 2
    e = p.sum(axis=1)
    if e.max() <= 0:
        return freqs, np.zeros((0, n // 2 + 1), np.float32)
    p = p[10 * np.log10(e / e.max() + 1e-30) > -SILENCE_DB]
    db = 10 * np.log10(p + 1e-20)
    ref = db[:, (freqs >= 2000) & (freqs <= 8000)].mean(axis=1, keepdims=True)
    return freqs, (db - ref).astype(np.float32)


def smooth(db: np.ndarray, bins: int) -> np.ndarray:
    if bins <= 1:
        return db
    pad = bins // 2
    e = np.concatenate([np.full(pad, db[0]), db, np.full(bins - 1 - pad, db[-1])])
    return np.convolve(e, np.ones(bins) / bins, mode="valid")


def find_cliff(freqs: np.ndarray, db: np.ndarray) -> tuple[int | None, float]:
    """Maior degrau de um espectro em dB acima de SCAN_FROM_HZ.

    drop(f) = média(dB em [f-SIDE-GAP, f-GAP]) - média(dB em [f+GAP, f+SIDE+GAP]).
    Devolve (f do maior drop, drop) se drop >= DROP_DB, senão (None, drop).
    Com a faixa de cima precisando caber abaixo de Nyquist, o degrau do filtro do
    conversor de 44,1 kHz aparece por volta de 21,4 kHz e cai em "sem corte".
    """
    df = freqs[1] - freqs[0]
    db = smooth(db.astype(np.float64), max(1, int(round(150 / df))))
    side = int(round(SIDE_HZ / df))
    gap = int(round(GAP_HZ / df))
    cs = np.concatenate([[0.0], np.cumsum(db)])
    lo = max(int(SCAN_FROM_HZ / df), side + gap)
    hi = len(db) - side - gap - 1
    if hi <= lo:
        return None, 0.0
    i = np.arange(lo, hi)
    below = (cs[i - gap] - cs[i - gap - side]) / side
    above = (cs[i + gap + side + 1] - cs[i + gap + 1]) / side
    d = below - above
    k = int(np.argmax(d))
    drop = float(d[k])
    return (int(round(freqs[i[k]])) if drop >= DROP_DB else None), round(drop, 1)


def find_cutoff(freqs: np.ndarray, rel: np.ndarray) -> dict:
    """Corte da faixa a partir dos espectros por quadro.

    Olha o quadro TÍPICO (mediana) e os quadros calmos (percentil 10), não a
    média: em master no talo, o MP3 decodificado satura e os quadros saturados
    espalham ruído largo acima do corte, que na média apaga o degrau. Vale o
    degrau mais forte dos dois.
    """
    nyq = freqs[-1]
    med = np.median(rel, axis=0)
    p10 = np.percentile(rel, 10, axis=0)
    c_med, d_med = find_cliff(freqs, med)
    c_p10, d_p10 = find_cliff(freqs, p10)
    found = [(d, c) for d, c in ((d_med, c_med), (d_p10, c_p10)) if c is not None]
    cut = max(found)[1] if found else None
    band = lambda a, b: round(float(np.mean(med[(freqs >= a) & (freqs < min(b, nyq))])), 1) if a < nyq else None
    return {
        "cutoff_hz": cut,
        "cut_med": c_med, "drop_med": d_med,
        "cut_p10": c_p10, "drop_p10": d_p10,
        # Nível típico (mediana, dB) das bandas altas contra 2-8 kHz: apoio à leitura.
        "hf_16_19_db": band(16_000, 19_000),
        "hf_19_21_db": band(19_000, 21_000),
    }


def classify(sr: int, cutoff_hz: int | None, declared_lossy: bool) -> str:
    """Classe da faixa pelo corte. Acima de CUT_HIGH o degrau é o filtro do
    conversor (normal em lossless); em hi-res (> 48 kHz) um degrau antes de
    HIRES_REAL_HZ denuncia upsample de 44,1/48 kHz."""
    if declared_lossy:
        return "lossy_declarado"
    if cutoff_hz is None:
        return "sem_corte"
    if cutoff_hz < CUT_LOSSY:
        return "lossy"
    if cutoff_hz < CUT_HIGH:
        return "provavel_lossy"
    if sr > 48_000 and cutoff_hz < HIRES_REAL_HZ:
        return "hires_de_cd"
    return "sem_corte"


def source_hint(tags: dict) -> str:
    vals = " ".join(str(v) for k, v in tags.items() if k.lower() in SOURCE_KEYS).lower()
    hits = [w for w in SOURCE_WORDS if w in vals]
    return ",".join(hits)


# ── E/S (ffprobe/ffmpeg) ──────────────────────────────────────────────

def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample:format=duration:format_tags",
         "-of", "json", str(path)],
        capture_output=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode(errors="replace")[-200:])
    j = json.loads(out.stdout)
    s = j["streams"][0]
    bits = int(s.get("bits_per_raw_sample") or s.get("bits_per_sample") or 0)
    tags = {k.lower(): v for k, v in (j.get("format", {}).get("tags") or {}).items()}
    return {
        "codec": s.get("codec_name", ""),
        "sr": int(s.get("sample_rate", 0)),
        "ch": int(s.get("channels", 2)),
        "bits": bits,
        "dur": float(j.get("format", {}).get("duration") or 0),
        "tags": tags,
    }


def decode(path: Path, start: float, length: float, ch: int) -> tuple[np.ndarray, str]:
    """PCM float da janela + avisos do decodificador (o ffmpeg sai 0 mesmo
    com frame corrompido: "invalid sync code", "decode_frame() failed")."""
    ch = max(1, min(ch, 2))
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{start:.2f}", "-t", f"{length:.2f}", "-i", str(path),
         "-map", "0:a:0", "-ac", str(ch), "-f", "f32le", "-acodec", "pcm_f32le", "-"],
        capture_output=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode(errors="replace")[-200:])
    return np.frombuffer(out.stdout, dtype=np.float32).reshape(-1, ch), out.stderr.decode(errors="replace").strip()


def decode_gst(path: Path, ch: int) -> np.ndarray:
    """Faixa inteira pelo GStreamer, que resincroniza no primeiro quadro válido.
    Resgate para FLAC com lixo antes do primeiro quadro: o ffmpeg não devolve
    nada e o app (GStreamer) toca normalmente (mesmo caso do phone_sync_encode)."""
    ch = max(1, min(ch, 2))
    out = subprocess.run(
        ["gst-launch-1.0", "-q", "filesrc", f"location={path}", "!", "decodebin", "!", "audioconvert",
         "!", f"audio/x-raw,format=F32LE,layout=interleaved,channels={ch}", "!", "fdsink", "fd=1"],
        capture_output=True, timeout=300,
    )
    if out.returncode != 0:
        raise RuntimeError("gstreamer: " + out.stderr.decode(errors="replace")[-200:])
    return np.frombuffer(out.stdout, dtype=np.float32).reshape(-1, ch)


def analyze(path: Path) -> dict:
    t0 = time.monotonic()
    info = probe(path)
    sr, dur = info["sr"], info["dur"]
    if dur >= 3 * WINDOW_S + 10:
        spans = [(dur * a, WINDOW_S) for a in WINDOW_AT]
    else:
        spans = [(0.0, min(dur, 3 * WINDOW_S))]
    parts, freqs, warns = [], None, []
    for start, length in spans:
        x, warn = decode(path, start, length, info["ch"])
        if warn:
            warns.append(warn.splitlines()[0])
        freqs, rel = frame_spectra(x, sr)
        parts.append(rel)
    rel = np.concatenate(parts) if parts else np.zeros((0, 1))
    decoder = "ffmpeg"
    if rel.shape[0] < 20:
        whole = decode_gst(path, info["ch"])
        decoder = "gstreamer"
        parts = []
        for start, length in spans:
            a = int(start * sr)
            freqs, r = frame_spectra(whole[a:a + int(length * sr)], sr)
            parts.append(r)
        rel = np.concatenate(parts)
    frames = int(rel.shape[0])
    if frames < 20:
        raise RuntimeError(f"só {frames} quadros com som")
    cut = find_cutoff(freqs, rel)
    tags = info["tags"]
    comment = str(tags.get("comment", ""))
    declared_lossy = "lossy" in comment.lower()
    return {
        "codec": info["codec"], "sr": sr, "bits": info["bits"], "dur": round(dur, 1),
        "comment": comment[:120], "encoder": str(tags.get("encoder", ""))[:60],
        "source": source_hint(tags), "frames": frames, "decoder": decoder, **cut,
        "decode_warn": warns[0][:150] if warns else "", "decode_warn_windows": len(warns),
        "class": classify(sr, cut["cutoff_hz"], declared_lossy),
        "elapsed": round(time.monotonic() - t0, 2),
    }


def _job(root: str, rel: str) -> dict:
    try:
        r = analyze(Path(root) / rel)
    except Exception as e:  # noqa: BLE001 — relatório registra e segue
        r = {"error": str(e)[:200], "class": "erro"}
    r["path"] = rel
    r["playlist"] = rel.split("/", 1)[0]
    return r


def cmd_scan(a) -> None:
    root = Path(a.root).expanduser().resolve()
    out = Path(a.out)
    done = set()
    if out.exists():
        for line in out.read_text().splitlines():
            try:
                done.add(json.loads(line)["path"])
            except (json.JSONDecodeError, KeyError):
                pass
    files = sorted(str(p.relative_to(root)) for p in root.rglob("*.flac")
                   if not any(part.startswith(".") for part in p.relative_to(root).parts))
    if a.only:
        files = [f for f in files if f.startswith(a.only)]
    todo = [f for f in files if f not in done]
    print(f"{len(files)} FLAC, {len(done)} já medidos, {len(todo)} a medir", file=sys.stderr)
    t0 = time.monotonic()
    with out.open("a") as fh, ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(_job, str(root), f) for f in todo]
        for i, fu in enumerate(as_completed(futs), 1):
            fh.write(json.dumps(fu.result(), ensure_ascii=False) + "\n")
            fh.flush()
            if i % 50 == 0:
                el = time.monotonic() - t0
                print(f"{i}/{len(todo)}  {el:.0f}s  ({el / i:.2f}s/faixa)", file=sys.stderr)


CLASS_ORDER = ["sem_corte", "provavel_lossy", "lossy", "lossy_declarado", "hires_de_cd", "erro"]


def cmd_summary(a) -> None:
    rows = [json.loads(l) for l in Path(a.jsonl).read_text().splitlines() if l.strip()]
    by_pl: dict[str, dict[str, int]] = {}
    for r in rows:
        by_pl.setdefault(r["playlist"], {}).setdefault(r["class"], 0)
        by_pl[r["playlist"]][r["class"]] += 1
    cols = CLASS_ORDER
    print("| playlist | total | " + " | ".join(cols) + " |")
    print("|---" * (len(cols) + 2) + "|")
    tot = {c: 0 for c in cols}
    for pl in sorted(by_pl):
        d = by_pl[pl]
        n = sum(d.values())
        print(f"| {pl} | {n} | " + " | ".join(str(d.get(c, 0) or "") for c in cols) + " |")
        for c in cols:
            tot[c] += d.get(c, 0)
    print(f"| **total** | {len(rows)} | " + " | ".join(str(tot[c]) for c in cols) + " |")


def cmd_one(a) -> None:
    r = analyze(Path(a.file))
    print(json.dumps(r, ensure_ascii=False, indent=1))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan")
    s.add_argument("root")
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=2)
    s.add_argument("--only", help="prefixo do caminho relativo (ex.: 'Funk Brasileiro/')")
    s.set_defaults(fn=cmd_scan)
    s = sub.add_parser("summary")
    s.add_argument("jsonl")
    s.set_defaults(fn=cmd_summary)
    s = sub.add_parser("one")
    s.add_argument("file")
    s.set_defaults(fn=cmd_one)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
