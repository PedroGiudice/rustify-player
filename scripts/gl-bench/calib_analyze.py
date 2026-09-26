"""Análise do sinal real gravado no app (fixture fft-real-2609.json).

Decodifica a gravação, reporta por faixa a distribuição do raw
low/mid/high e simula a cadeia ATUAL do motor WebGL (stepGlSignal,
src/gl/signal.ts + expandKick, src/lib/beatPll.ts) com a cfg de
referência do CEO e com os DEFAULTS, medindo o fator de amplitude do
Relevo F = (5.5+5*uLow+3*uBeat)/5.5 e a onda |6*uMid|.

Uso: uv run --with numpy scripts/gl-bench/calib_analyze.py
"""
import base64, json, math, pathlib
import numpy as np

FIX = pathlib.Path(__file__).resolve().parents[2] / "src/gl/__fixtures__/fft-real-2609.json"
ENV_TAU_MIN, ENV_TAU_MAX, DT_MAX = 0.1, 0.8, 0.1
KICK_FLOOR, KICK_CEIL, BEAT_TAU = 0.1, 0.6, 0.09

MIN_SEG_S = 15.0
SCREENS = {"Playlists", "Rap & Hip-Hop", "Library", "Albums", "Artists", "Search", "Crate", "Signal", "Settings", "Home", "Stations", "Tweaks"}

CFGS = {
    "ref-CEO": dict(bass=0.30, mid=0.15, treble=0.10, smoothing=1.0, beat="pulse"),
    "defaults": dict(bass=1.0, mid=1.0, treble=0.8, smoothing=0.3, beat="speed"),
}


def load():
    d = json.loads(FIX.read_text())
    v = np.frombuffer(base64.b64decode(d["v_b64"]), np.uint8).astype(float) / 255
    dt = np.frombuffer(base64.b64decode(d["dt_b64"]), np.uint8).astype(float) / 1000
    assert v.size == 3 * d["n"] and dt.size == d["n"]
    return v.reshape(-1, 3), dt, d["marks"]


def simulate(raw, dt, c):
    tau = ENV_TAU_MIN + min(max(c["smoothing"], 0), 1) * (ENV_TAU_MAX - ENV_TAU_MIN)
    lo = mi = be = 0.0
    out = np.zeros((len(dt), 3))
    for i, (r, d) in enumerate(zip(raw, dt)):
        d = min(DT_MAX, max(0.0, d))
        k = 1 - math.exp(-d / tau)
        lo += (min(1, r[0] * c["bass"]) - lo) * k
        mi += (min(1, r[1] * c["mid"]) - mi) * k
        kick = min(1, max(0, (r[0] - KICK_FLOOR) / (KICK_CEIL - KICK_FLOOR)))
        tb = kick if c["beat"] != "off" else 0
        be += (tb - be) * (1 - math.exp(-d / BEAT_TAU))
        out[i] = lo, mi, be
    return out


def pct(x, ps=(5, 50, 95)):
    return " ".join(f"{np.percentile(x, p):.2f}" for p in ps) + f" max {x.max():.2f}"


def main():
    raw, dt, marks = load()
    n = len(dt)
    # marks vêm do <h1>: nomes de tela/playlist não são faixa => continuação
    tracks = [(i, t) for i, t in marks if t not in SCREENS]
    segs = [(tracks[j][0], tracks[j + 1][0] if j + 1 < len(tracks) else n, tracks[j][1]) for j in range(len(tracks))]
    sims = {k: simulate(raw, dt, c) for k, c in CFGS.items()}
    print(f"eventos {n}, duração {dt.sum():.1f}s, taxa média {n / dt.sum():.1f} Hz, marks {len(marks)}, segmentos {len(segs)}")
    print("marks ignorados (tela):", sorted({t for _, t in marks if t in SCREENS}))
    by = {}
    for a, b, title in segs:
        if dt[a:b].sum() < MIN_SEG_S:  # pulo rápido: fica na fixture, fora da estatística
            continue
        by.setdefault(title, []).append(np.arange(a, b))
    print(f"faixas com >= {MIN_SEG_S:.0f}s: {len(by)}")
    for title, idx in by.items():
        ix = np.concatenate(idx)
        r = raw[ix]
        print(f"\n== {title}  ({len(idx)} seg) {dt[ix].sum():.1f}s")
        for j, nm in enumerate(("low", "mid", "high")):
            print(f"  raw {nm:4s} p5/p50/p95: {pct(r[:, j])}")
        for k, s in sims.items():
            s = s[ix]
            F = (5.5 + 5 * s[:, 0] + 3 * s[:, 2]) / 5.5
            w = np.abs(6 * s[:, 1])
            print(f"  [{k:8s}] F p5/p50/p95: {pct(F)} | |6*uMid| p50 {np.percentile(w, 50):.2f} p95 {np.percentile(w, 95):.2f}")


if __name__ == "__main__":
    main()
