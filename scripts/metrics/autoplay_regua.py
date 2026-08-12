#!/usr/bin/env python3
"""Régua do autoplay — medição automática contra a meta (CMR-123).

Roda semanalmente via systemd timer (rustify-regua.timer na VM) e pode ser
rodado à mão. Computa skip-rate por origin e streak de aceitação do autoplay
por semana ISO, marca o corte da v0.2.66 (2026-08-12, sinal v3 — origins
mudaram de significado; não comparar cru com o período anterior) e escreve:

- docs/metrics/regua-autoplay.jsonl  (histórico append-only, 1 linha/run)
- docs/metrics/regua-latest.md       (último veredito; injetado como
                                      contexto no início de toda sessão
                                      Claude deste repo via hook SessionStart)

Pré-requisito: túnel SSH pro Qdrant da cmr-auto (idempotente; o script
tenta subir se a porta não responde). cmr-auto offline = registra e sai 0.
"""

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

QDRANT = "http://127.0.0.1:16333"
TUNNEL_CMD = [
    "ssh", "-f", "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-L", "16333:localhost:6333",
    "cmr-auto@100.102.249.9",
]
REPO = Path(__file__).resolve().parents[2]
OUT_DIR = REPO / "docs" / "metrics"
# Corte do sinal v3 (v0.2.66): origins ganharam significado novo.
V3_CUTOFF = 1786500000  # 2026-08-12 ~02:00 UTC
META_SKIP = 0.55
SESSION_GAP_S = 30 * 60


def qdrant_ok() -> bool:
    try:
        with urllib.request.urlopen(f"{QDRANT}/collections", timeout=5):
            return True
    except (urllib.error.URLError, OSError):
        return False


def ensure_tunnel() -> bool:
    if qdrant_ok():
        return True
    subprocess.run(TUNNEL_CMD, capture_output=True, timeout=30, check=False)
    time.sleep(1)
    return qdrant_ok()


def scroll_events():
    pts, offset = [], None
    while True:
        body = {"limit": 1000, "with_payload": True, "with_vector": False}
        if offset is not None:
            body["offset"] = offset
        req = urllib.request.Request(
            f"{QDRANT}/collections/play_events/points/scroll",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            res = json.load(r)["result"]
        pts.extend(p.get("payload") or {} for p in res["points"])
        offset = res.get("next_page_offset")
        if offset is None:
            return pts


def week_of(ts: int) -> str:
    d = datetime.fromtimestamp(ts, tz=timezone.utc).isocalendar()
    return f"{d.year}-W{d.week:02d}"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(tz=timezone.utc)
    if not ensure_tunnel():
        (OUT_DIR / "regua-latest.md").write_text(
            f"# Régua do autoplay — {now:%Y-%m-%d}\n\n"
            "cmr-auto OFFLINE no horário da medição — sem dados novos. "
            "O timer re-tenta na próxima semana; pra medir agora: "
            "`python3 scripts/metrics/autoplay_regua.py`.\n"
        )
        return 0

    events = [
        e for e in scroll_events()
        if e.get("event_type") in ("track_ended", "track_skipped")
    ]
    for e in events:
        e["_ts"] = e.get("timestamp") or e.get("started_at") or 0

    pos_v3 = [e for e in events if e["_ts"] >= V3_CUTOFF]

    def stats(evs):
        n = len(evs)
        if n == 0:
            return {"n": 0}
        skips = sum(1 for e in evs if e["event_type"] == "track_skipped")
        early = sum(1 for e in evs if (e.get("listen_pct") or 0) < 0.1)
        return {
            "n": n,
            "skip_rate": round(skips / n, 3),
            "early_rate": round(early / n, 3),
        }

    by_origin = {}
    for origin in ("autoplay", "station", "queue", "playlist", "manual", "album_seq", "repeat"):
        by_origin[origin] = stats([e for e in pos_v3 if e.get("origin") == origin])

    # Streak de aceitação: dentro de sessões (gap 30min), quantas tracks de
    # autoplay seguidas terminam (ended) antes de um skip.
    ap = sorted(
        (e for e in pos_v3 if e.get("origin") == "autoplay"),
        key=lambda e: e["_ts"],
    )
    streaks, cur, last_ts = [], 0, 0
    for e in ap:
        if last_ts and e["_ts"] - last_ts > SESSION_GAP_S and cur >= 0:
            streaks.append(cur)
            cur = 0
        if e["event_type"] == "track_ended":
            cur += 1
        else:
            streaks.append(cur)
            cur = 0
        last_ts = e["_ts"]
    if cur:
        streaks.append(cur)

    weekly = {}
    for e in pos_v3:
        if e.get("origin") == "autoplay":
            w = weekly.setdefault(week_of(e["_ts"]), [0, 0])
            w[0] += 1
            w[1] += 1 if e["event_type"] == "track_skipped" else 0

    record = {
        "measured_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "events_pos_v3": len(pos_v3),
        "by_origin": by_origin,
        "autoplay_weekly": {
            k: {"n": v[0], "skip_rate": round(v[1] / v[0], 3)}
            for k, v in sorted(weekly.items())
        },
        "streaks": {
            "count": len(streaks),
            "mean": round(sum(streaks) / len(streaks), 2) if streaks else None,
            "max": max(streaks) if streaks else None,
        },
        "meta_skip": META_SKIP,
    }
    with open(OUT_DIR / "regua-autoplay.jsonl", "a") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    ap_stats = by_origin["autoplay"]
    if ap_stats["n"] == 0:
        veredito = "SEM DADOS de autoplay pós-v3 ainda."
    elif ap_stats["n"] < 50:
        veredito = (
            f"AMOSTRA PEQUENA (n={ap_stats['n']}) — skip {ap_stats['skip_rate']:.0%}; "
            "aguardar mais uso antes de concluir."
        )
    elif ap_stats["skip_rate"] <= META_SKIP:
        veredito = (
            f"META BATIDA: skip {ap_stats['skip_rate']:.0%} <= {META_SKIP:.0%} "
            f"(n={ap_stats['n']})."
        )
    else:
        veredito = (
            f"META NÃO batida: skip {ap_stats['skip_rate']:.0%} > {META_SKIP:.0%} "
            f"(n={ap_stats['n']}) — revisar tunables do sinal v3 "
            "(HALF_LIFE_DAYS, PASSIVE_WEIGHT, thresholds em qdrant_client.rs)."
        )

    weeks_md = "\n".join(
        f"- {k}: n={v[0]}, skip {v[1] / v[0]:.0%}"
        for k, v in sorted(weekly.items())
    ) or "- (sem semanas com autoplay ainda)"

    (OUT_DIR / "regua-latest.md").write_text(
        f"# Régua do autoplay — medição {now:%Y-%m-%d}\n\n"
        f"**Veredito: {veredito}**\n\n"
        f"Eventos pós-sinal-v3 (>= 2026-08-12): {len(pos_v3)}. Meta: skip do "
        f"autoplay <= {META_SKIP:.0%} (CMR-123). Streak de aceitação: média "
        f"{record['streaks']['mean']}, max {record['streaks']['max']} "
        f"({record['streaks']['count']} ciclos).\n\n"
        "Skip por origin (pós-v3): "
        + ", ".join(
            f"{o} {s['skip_rate']:.0%} (n={s['n']})"
            for o, s in by_origin.items()
            if s["n"] > 0
        )
        + "\n\nAutoplay por semana:\n" + weeks_md + "\n\n"
        "Histórico completo: docs/metrics/regua-autoplay.jsonl. "
        "Medir à mão: `python3 scripts/metrics/autoplay_regua.py`.\n"
    )
    print(veredito)
    return 0


if __name__ == "__main__":
    sys.exit(main())
