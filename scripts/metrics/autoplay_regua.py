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
# Desde a v0.2.72 cada evento carrega `signal_schema` (estampado no backend,
# spec 2026-08-13-event-provenance) e o corte é auto-descritivo; o timestamp
# abaixo fica APENAS como fallback pros eventos legados sem o campo.
V3_CUTOFF = 1786500000  # 2026-08-12 ~02:00 UTC
SIGNAL_SCHEMA_V3 = 3


def is_pos_v3(e: dict) -> bool:
    """Evento gerado sob a semântica v3 dos sinais/origins.

    `signal_schema` é a autoridade quando presente; eventos anteriores à
    v0.2.72 não têm o campo e caem no fallback por timestamp.
    """
    schema = e.get("signal_schema")
    if schema is not None:
        return schema >= SIGNAL_SCHEMA_V3
    return e["_ts"] >= V3_CUTOFF
META_SKIP = 0.55
SESSION_GAP_S = 30 * 60

# Aceite e pulo: a definição única da régua. O motor (familiarity.rs) replica
# a mesma regra; a fixture scripts/metrics/fixtures/familiaridade.json trava a
# equivalência nos testes dos dois lados.
ACEITE = "track_ended"
PULO = "track_skipped"
# Pulo até 5 s é quase navegação ("próxima, próxima"): 77% dos pulos do
# autoplay desde a v0.2.75 (forense 14/10). Recorte complementar, não muda o
# veredito.
NAV_SKIP_MS = 5_000
# Primeira versão com familiaridade + mistura 2:1 no autoplay. O recorte por
# versão mede a mudança sem misturar com o período anterior.
VERSAO_MISTURA = "0.2.92"
# Familiaridade (mesmos limiares do motor, familiarity.rs).
KNOWN_MIN_ENDED = 3
NEVER_ENDS_MIN_ATTEMPTS = 3
# Tentativa sem fim só conta para o nunca-termina com escuta abaixo disto
# (pulo aos 95% não é rejeição).
NEVER_ENDS_MAX_LISTEN = 0.5
MOTOR_ORIGINS = ("autoplay", "station")
UNPLAYABLE_SUSPECT_DEVICE = "s24"


def is_accept(e: dict) -> bool:
    return e.get("event_type") == ACEITE


def is_skip(e: dict) -> bool:
    return e.get("event_type") == PULO


def is_nav_skip(e: dict, limite_ms: int = NAV_SKIP_MS) -> bool:
    """Pulo nos primeiros `limite_ms` (mesma regra da forense)."""
    return is_skip(e) and (e.get("end_position_ms") or 0) <= limite_ms


def version_tuple(v: str) -> tuple:
    """'0.2.92' -> (0, 2, 92); vazio ou malformado -> () (menor que tudo)."""
    try:
        return tuple(int(x) for x in v.split("."))
    except (AttributeError, ValueError):
        return ()


def desde_versao(e: dict, versao: str = VERSAO_MISTURA) -> bool:
    return version_tuple(e.get("app_version") or "") >= version_tuple(versao)


def listen_fraction(e: dict):
    """Fração ouvida: listen_pct gravado; sem ele, end_position_ms/duration_ms.
    Duração 0 = desconhecida mesmo com listen_pct (os builders gravam 0.0 sem
    duração). Desconhecida = None. Mesma regra do motor (listen_fraction)."""
    dur = e.get("duration_ms")
    if dur == 0:
        return None
    lp = e.get("listen_pct")
    if isinstance(lp, (int, float)) and not isinstance(lp, bool):
        return float(lp)
    end = e.get("end_position_ms")
    if isinstance(end, (int, float)) and isinstance(dur, (int, float)) and dur > 0:
        return end / dur
    return None


def familiaridade(events) -> dict:
    """{track_id: {"ended", "motor_attempts", "early_skips"}} — referência do
    índice do motor.

    ended = vezes ouvida até o fim (qualquer origem, todo o histórico);
    motor_attempts = vezes servida pelo autoplay/station, sem os pulos em 0 ms
    do S24 (suspeitos de arquivo que não toca); early_skips = das tentativas,
    os pulos com escuta conhecida abaixo de NEVER_ENDS_MAX_LISTEN. track_id
    que não é inteiro (11 eventos legados em texto) fica fora.
    """
    out: dict = {}
    for e in events:
        tid = e.get("track_id")
        if not isinstance(tid, int) or isinstance(tid, bool):
            continue
        aceite = is_accept(e)
        tentativa = (
            (aceite or is_skip(e))
            and e.get("origin") in MOTOR_ORIGINS
            and not (is_skip(e) and e.get("device_id") == UNPLAYABLE_SUSPECT_DEVICE
                     and e.get("end_position_ms") == 0)
        )
        if not aceite and not tentativa:
            continue
        frac = listen_fraction(e)
        cedo = tentativa and is_skip(e) and frac is not None and frac < NEVER_ENDS_MAX_LISTEN
        f = out.setdefault(tid, {"ended": 0, "motor_attempts": 0, "early_skips": 0})
        f["ended"] += 1 if aceite else 0
        f["motor_attempts"] += 1 if tentativa else 0
        f["early_skips"] += 1 if cedo else 0
    return out


def is_known(f: dict, liked: bool) -> bool:
    return liked or f["ended"] >= KNOWN_MIN_ENDED


def never_ends(f: dict, liked: bool) -> bool:
    return not liked and f["ended"] == 0 and f["early_skips"] >= NEVER_ENDS_MIN_ATTEMPTS


def stats(evs) -> dict:
    """Pulo e pulo cedo (<10%) de um recorte de eventos ended/skipped."""
    n = len(evs)
    if n == 0:
        return {"n": 0}
    skips = sum(1 for e in evs if is_skip(e))
    early = sum(1 for e in evs if (e.get("listen_pct") or 0) < 0.1)
    return {
        "n": n,
        "skip_rate": round(skips / n, 3),
        "early_rate": round(early / n, 3),
    }


def recortes_autoplay(autoplay_pos_v3) -> dict:
    """Recortes complementares do autoplay (não entram no veredito):
    - sem_pulos_5s: tira os pulos de até NAV_SKIP_MS (rajadas de navegação);
    - desde_<VERSAO_MISTURA>: só eventos da versão com a mistura 2:1.
    """
    desde = [e for e in autoplay_pos_v3 if desde_versao(e)]
    return {
        "sem_pulos_5s": stats([e for e in autoplay_pos_v3 if not is_nav_skip(e)]),
        f"desde_{VERSAO_MISTURA}": stats(desde),
        f"desde_{VERSAO_MISTURA}_sem_pulos_5s": stats([e for e in desde if not is_nav_skip(e)]),
    }


def recortes_md(rec: dict) -> str:
    def fmt(s):
        return "sem eventos" if s["n"] == 0 else f"skip {s['skip_rate']:.0%} (n={s['n']})"
    return (
        "Recortes do autoplay (não mudam o veredito): "
        f"sem os pulos de até {NAV_SKIP_MS // 1000} s, {fmt(rec['sem_pulos_5s'])}; "
        f"desde a v{VERSAO_MISTURA} (mistura conhecida/descoberta), "
        f"{fmt(rec[f'desde_{VERSAO_MISTURA}'])}; "
        f"desde a v{VERSAO_MISTURA} sem os pulos de até {NAV_SKIP_MS // 1000} s, "
        f"{fmt(rec[f'desde_{VERSAO_MISTURA}_sem_pulos_5s'])}.\n\n"
    )


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


def count(collection: str, body: dict) -> int:
    """POST /points/count — 0 se a collection não responder."""
    try:
        req = urllib.request.Request(
            f"{QDRANT}/collections/{collection}/points/count",
            data=json.dumps({"exact": True, **body}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)["result"]["count"]
    except (urllib.error.URLError, OSError, KeyError):
        return 0


def coverage() -> dict:
    """Cobertura do motor: uma faixa sem vetor não é recomendável, e sem vibe
    compete com 0.5 neutro no re-rank. O gap REABRE a cada leva nova do Crate
    (a anotação de vibe ainda é batch manual — CMR-178), então a régua diária
    é o único lugar onde a regressão aparece sem alguém ir procurar.
    """
    total = count("rustify_tracks", {})
    return {
        "tracks": total,
        "mert": count("rustify_tracks", {"filter": {"must": [{"has_vector": "mert"}]}}),
        "lyrics": count("rustify_tracks", {"filter": {"must": [{"has_vector": "lyrics"}]}}),
        # Faixas sem letra conhecida: miss do lrclib ou instrumental. Não são
        # defeito — separá-las evita perseguir uma cobertura de 100% impossível.
        "lyrics_sem_fonte": count(
            "rustify_tracks",
            {"filter": {"must": [{"key": "lyrics_status", "match": {"any": ["none", "instrumental"]}}]}},
        ),
        "vibe": count(
            "track_enrichments",
            {"filter": {"must_not": [{"is_empty": {"key": "energy"}}]}},
        ),
    }


def cobertura_md(cov: dict) -> str:
    """Bloco de cobertura do relatório. Faixa sem vetor/vibe é buraco no motor,
    não estatística: por isso vem com o número absoluto do que falta."""
    total = cov["tracks"] or 1
    faltam_mert = cov["tracks"] - cov["mert"]
    faltam_vibe = cov["tracks"] - cov["vibe"]
    # Alcançável = total menos as que comprovadamente não têm letra em lugar
    # nenhum (instrumental ou miss definitivo do lrclib).
    alcancavel = max(cov["tracks"] - cov["lyrics_sem_fonte"], 1)
    faltam_letra = alcancavel - cov["lyrics"]
    linhas = [
        "Cobertura do motor (faixa sem vetor não é recomendável; sem vibe entra neutra no re-rank):",
        f"- MERT (áudio): {cov['mert']}/{cov['tracks']} ({cov['mert'] / total:.0%})"
        + (f" — faltam {faltam_mert}" if faltam_mert > 0 else ""),
        f"- Letra: {cov['lyrics']}/{alcancavel} das alcançáveis ({cov['lyrics'] / alcancavel:.0%})"
        + (f" — faltam {faltam_letra}" if faltam_letra > 0 else "")
        + f"; {cov['lyrics_sem_fonte']} sem letra em lugar nenhum (instrumental/miss).",
        f"- Vibe: {cov['vibe']}/{cov['tracks']} ({cov['vibe'] / total:.0%})"
        + (f" — faltam {faltam_vibe} (anotação ainda é batch manual, CMR-178)" if faltam_vibe > 0 else ""),
    ]
    return "\n".join(linhas) + "\n"


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

    pos_v3 = [e for e in events if is_pos_v3(e)]

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

    # Proveniência: segmentação por dispositivo. Linha morta enquanto só a
    # cmr-auto gera eventos; ganha vida no primeiro dispositivo novo.
    by_device = {}
    for e in pos_v3:
        d = e.get("device_id") or "(legado)"
        by_device.setdefault(d, []).append(e)
    by_device = {d: stats(evs) for d, evs in by_device.items()}

    rec_ap = recortes_autoplay([e for e in pos_v3 if e.get("origin") == "autoplay"])
    cov = coverage()
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
        "by_device": by_device,
        "autoplay_recortes": rec_ap,
        "coverage": cov,
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
        f"Eventos pós-sinal-v3 (signal_schema>=3; legado por data): {len(pos_v3)}. Meta: skip do "
        f"autoplay <= {META_SKIP:.0%} (CMR-123). Streak de aceitação: média "
        f"{record['streaks']['mean']}, max {record['streaks']['max']} "
        f"({record['streaks']['count']} ciclos).\n\n"
        "Skip por origin (pós-v3): "
        + ", ".join(
            f"{o} {s['skip_rate']:.0%} (n={s['n']})"
            for o, s in by_origin.items()
            if s["n"] > 0
        )
        + (
            "\n\nPor dispositivo: "
            + ", ".join(
                f"{d} skip {s['skip_rate']:.0%} (n={s['n']})"
                for d, s in sorted(by_device.items())
                if s["n"] > 0
            )
            if len(by_device) >= 2
            else ""
        )
        + "\n\n" + recortes_md(rec_ap)
        + "Autoplay por semana:\n" + weeks_md + "\n\n"
        + cobertura_md(cov) + "\n"
        "Histórico completo: docs/metrics/regua-autoplay.jsonl. "
        "Medir à mão: `python3 scripts/metrics/autoplay_regua.py`.\n"
    )
    print(veredito)
    return 0


if __name__ == "__main__":
    sys.exit(main())
