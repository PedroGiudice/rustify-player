#!/usr/bin/env python3
"""Forense do autoplay: o que separa a faixa que o CEO aceita da que ele pula (CMR-123).

Só leitura no Qdrant da cmr-auto (túnel 16333). Nada no app nem no banco muda.

Regras herdadas, sem reinventar:
- skip/aceite, corte pós-sinal-v3 e origens: `scripts/metrics/autoplay_regua.py`
  (aceite = `track_ended`, pulo = `track_skipped`; `signal_schema >= 3`, legado por data);
- sessão (mesmo aparelho, intervalo < 30 min), semente (última faixa ACEITA antes, na
  mesma sessão) e bootstrap por sessão: `scripts/curator/mert_autoplay_eval.py`;
- era do rádio: `app_version >= 0.2.75` (consciência de sessão no rádio, 18/08/2026).

Playlist NA DATA do evento: o caminho atual da faixa dá a pasta de 1º nível de HOJE. As
faixas movidas em 14/10/2026 (rap e funk; `docs/contexto/14102026-*-lote-executado.json`)
estavam em outra pasta antes da mudança; para eventos anteriores ao lote, vale a pasta
`de` do lote. Moves anteriores a 14/10 não têm registro e não são reconstruídos.

Uso:
  uv run --with numpy python3 scripts/metrics/autoplay_forense.py --report /tmp/forense.json
"""
from __future__ import annotations

import argparse
import bisect
import json
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "curator"))
import mert_autoplay_eval as M  # noqa: E402  (regras de sessão, semente, corte e bootstrap)

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
QDRANT = "http://127.0.0.1:16333"
MUSIC_ROOT = "/home/cmr-auto/Music/"
LOTES = (
    ("docs/contexto/14102026-rap-br-lote-executado.json", "2026-10-14T03:37:00+00:00"),
    # O lote do funk não traz hora; foi executado depois do rap no mesmo dia. Nenhum
    # play_event tem data em 14/10 (o último é de 12/10), então a hora exata não importa.
    ("docs/contexto/14102026-funk-lote-executado.json", "2026-10-14T03:37:00+00:00"),
)
TZ = ZoneInfo("America/Sao_Paulo")
NAV_SKIP_MS = 5_000
TOP_SESSOES = 5
DIA = 86_400
ORIGENS = ("autoplay", "station")


# ---------------------------------------------------------------- funções puras

def top_folder(path: str, root: str = MUSIC_ROOT) -> str | None:
    """Pasta de 1º nível (= playlist) de um caminho absoluto do acervo; None fora dele."""
    if not path or not path.startswith(root):
        return None
    rest = path[len(root):]
    return rest.split("/", 1)[0] if "/" in rest else None


def rel_sem_playlist(path: str, root: str = MUSIC_ROOT) -> str | None:
    """Caminho relativo SEM a pasta de 1º nível (chave dos lotes de 14/10)."""
    if not path or not path.startswith(root):
        return None
    rest = path[len(root):]
    return rest.split("/", 1)[1] if "/" in rest else None


def load_moves(lotes) -> dict[tuple[str, str], tuple[str, int]]:
    """{(rel, pasta_nova): (pasta_antiga, ts_do_lote)} a partir dos registros de lote."""
    out = {}
    for arq, quando in lotes:
        ts = int(datetime.fromisoformat(quando).timestamp())
        d = json.load(open(os.path.join(REPO, arq)))
        for f in d["faixas"]:
            out[(f["rel"], f["para"])] = (f["de"], ts)
    return out


def folder_at(path: str, ts: int, moves: dict) -> str | None:
    """Playlist da faixa no instante `ts`: a pasta de hoje, ou a `de` do lote se o evento é
    anterior à mudança."""
    atual = top_folder(path)
    rel = rel_sem_playlist(path)
    m = moves.get((rel, atual))
    if m and ts < m[1]:
        return m[0]
    return atual


_SEP = re.compile(r"\s*(?:,|&|;|/|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bx\b|\be\b|\bwith\b)\s*",
                  re.IGNORECASE)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9$]+", "", s.lower())


def artist_set(s: str) -> set[str]:
    """Nomes de artista normalizados de um campo que pode trazer colaboração
    ('A & B feat. C' -> {a, b, c}). Vazio para 'Various Artists'."""
    partes = {norm(p) for p in _SEP.split(s or "")}
    partes.discard("")
    partes.discard("variousartists")
    return partes


def same_artist(a: str, b: str) -> bool:
    """Algum artista em comum (colaboração conta)."""
    return bool(artist_set(a) & artist_set(b))


def index_by_track(events: list[dict]) -> dict[int, list[int]]:
    """{track_id: [ts ordenados]}."""
    out: dict[int, list[int]] = defaultdict(list)
    for e in events:
        out[e["track_id"]].append(M.event_ts(e))
    for v in out.values():
        v.sort()
    return out


def count_before(idx: dict, tid: int, ts: int, window_s: int | None = None) -> int:
    """Quantos registros da faixa estão em [ts - window, ts) (sem janela: todos antes de ts)."""
    v = idx.get(tid, [])
    hi = bisect.bisect_left(v, ts)
    lo = 0 if window_s is None else bisect.bisect_left(v, ts - window_s)
    return hi - lo


def session_features(events: list[dict]) -> dict[int, dict]:
    """Por evento (chave id()), posição na sessão (1 = primeiro evento de play da sessão),
    vezes que a mesma faixa já apareceu antes na sessão e a duração total da sessão (min).
    Espera `M.assign_sessions` antes (ordem por aparelho e tempo)."""
    por: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        por[e["_sess"]].append(e)
    out = {}
    for evs in por.values():
        ini = min(int(e.get("started_at") or M.event_ts(e)) for e in evs)
        fim = max(M.event_ts(e) for e in evs)
        vistos: Counter = Counter()
        for i, e in enumerate(evs):
            out[id(e)] = {"pos": i + 1, "rep_sessao": vistos[e["track_id"]],
                          "dur_sessao_min": (fim - ini) / 60.0, "n_sessao": len(evs)}
            vistos[e["track_id"]] += 1
    return out


def local_hour_dow(ts: int) -> tuple[int, int]:
    """Hora local (São Paulo) e dia da semana (0 = segunda)."""
    d = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(TZ)
    return d.hour, d.weekday()


def hour_bin(h: int) -> str:
    return "madrugada" if h < 6 else "manha" if h < 12 else "tarde" if h < 18 else "noite"


def is_nav_skip(e: dict, limite_ms: int = NAV_SKIP_MS) -> bool:
    """Pulo nos primeiros `limite_ms` (quase navegação)."""
    return e.get("event_type") == "track_skipped" and (e.get("end_position_ms") or 0) <= limite_ms


def auc_fast(scores, labels) -> float:
    """AUC de Mann-Whitney vetorizada (empates = 1/2). Mesmo valor de `M.auc`."""
    import numpy as np
    s = np.asarray(scores, dtype=np.float64)
    y = np.asarray(labels, dtype=bool)
    n1, n0 = int(y.sum()), int((~y).sum())
    if n1 == 0 or n0 == 0:
        return float("nan")
    _, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    start = np.concatenate([[0], np.cumsum(cnt)[:-1]])
    ranks = (start + (cnt + 1) / 2.0)[inv]
    return float((ranks[y].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0))


def rate_diff(flag, labels) -> float:
    """Taxa de aceite com a característica menos a taxa sem ela. NaN se um grupo vazio."""
    import numpy as np
    f = np.asarray(flag, dtype=bool)
    y = np.asarray(labels, dtype=bool)
    if f.sum() == 0 or (~f).sum() == 0:
        return float("nan")
    return float(y[f].mean() - y[~f].mean())


def ci(stat, args, resamples) -> list[float]:
    """IC 95% por percentis de `stat(*[a[ix] for a in args])` nas reamostras."""
    import numpy as np
    v = np.array([stat(*[a[ix] for a in args]) for ix in resamples])
    v = v[~np.isnan(v)]
    if len(v) == 0:
        return [float("nan"), float("nan")]
    return [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]


def burst_lengths(rows: list[dict]) -> list[int]:
    """Para cada linha (na ordem da sessão), o tamanho da rajada de pulos-navegação
    (`nav_skip`) consecutivos na mesma sessão a que ela pertence; 0 se não é pulo-navegação."""
    out = [0] * len(rows)
    i = 0
    while i < len(rows):
        if not rows[i]["nav_skip"]:
            i += 1
            continue
        j = i
        while j + 1 < len(rows) and rows[j + 1]["nav_skip"] and rows[j + 1]["sess"] == rows[i]["sess"]:
            j += 1
        for k in range(i, j + 1):
            out[k] = j - i + 1
        i = j + 1
    return out


def drop_top_sessions(evs: list[dict], k: int = TOP_SESSOES) -> tuple[list[dict], list[str]]:
    """Remove as `k` sessões com mais eventos no recorte."""
    c = Counter(e["sess"] for e in evs)
    top = [s for s, _ in c.most_common(k)]
    return [e for e in evs if e["sess"] not in set(top)], top


# ---------------------------------------------------------------- montagem dos eventos

def build_rows(plays, tracks, enr, moves):
    """Eventos de autoplay/station pós-v3 com as características de cada hipótese."""
    ev = M.assign_sessions(plays)
    sfeat = session_features(ev)
    alvos = M.seeds_by_session(ev, ORIGENS)
    # seeds_by_session copia o dict; reencontro a posição pela ordem (mesma sequência)
    orig = [e for e in ev if e.get("origin") in ORIGENS]
    idx_all = index_by_track(ev)
    idx_motor = index_by_track(orig)
    idx_ok = index_by_track([e for e in ev if M.is_accept(e)])
    rows = []
    for e, o in zip(alvos, orig):
        assert e["track_id"] == o["track_id"] and M.event_ts(e) == M.event_ts(o)
        if not M.is_pos_v3(e):
            continue
        t = M.event_ts(e)
        tid = e["track_id"]
        tr = tracks.get(tid, {})
        en = enr.get(tid, {})
        seed = e["seed"]
        st = tracks.get(seed, {}) if seed is not None else {}
        se = enr.get(seed, {}) if seed is not None else {}
        sf = sfeat[id(o)]
        h, dow = local_hour_dow(t)
        r = {
            "ts": t, "sess": e["_sess"], "origin": e["origin"],
            "era": "desde_0275" if M.is_pos_radio_fix(e) else "antes_0275",
            "aceite": M.is_accept(e), "track_id": tid, "seed": seed,
            "end_ms": e.get("end_position_ms"), "listen_pct": e.get("listen_pct"),
            "no_acervo": tid in tracks,
            "nav_skip": is_nav_skip(e),
            "device": "s24" if e.get("device_id") == "s24" else "desktop",
            "plays_antes": count_before(idx_all, tid, t),
            "aceites_antes": count_before(idx_ok, tid, t),
            "servida_7d": count_before(idx_motor, tid, t, 7 * DIA),
            "servida_30d": count_before(idx_motor, tid, t, 30 * DIA),
            "rep_sessao": sf["rep_sessao"],
            "pos_sessao": sf["pos"], "dur_sessao_min": sf["dur_sessao_min"],
            "dur_faixa_min": (e.get("duration_ms") or tr.get("duration_ms") or 0) / 60000.0 or None,
            "hora": h, "dow": dow,
            "liked": bool(en.get("liked_at")) and int(en["liked_at"]) < t,
            "energy": en.get("energy"), "valence": en.get("valence"),
        }
        if seed is not None and st:
            r["mesmo_artista"] = same_artist(tr.get("artist", ""), st.get("artist", "")) if tr else None
            fa = folder_at(tr.get("path", ""), t, moves) if tr else None
            fs = folder_at(st.get("path", ""), t, moves)
            r["mesma_playlist"] = (fa == fs) if fa and fs else None
            r["playlist"], r["playlist_semente"] = fa, fs
        if seed is not None and en.get("energy") is not None and se.get("energy") is not None:
            r["d_energy"] = abs(en["energy"] - se["energy"])
        if seed is not None and en.get("valence") is not None and se.get("valence") is not None:
            r["d_valence"] = abs(en["valence"] - se["valence"])
        rows.append(r)
    return rows


# Hipóteses: (chave, tipo, rótulo). bin = característica sim/não; cont = número.
HIPOTESES = [
    ("d_energy", "cont", "1. diferença de energia semente->faixa"),
    ("d_valence", "cont", "1. diferença de valência semente->faixa"),
    ("energy", "cont", "1. energia da faixa (extra)"),
    ("valence", "cont", "1. valência da faixa (extra)"),
    ("mesmo_artista", "bin", "2. mesmo artista da semente"),
    ("mesma_playlist", "bin", "3. mesma playlist da semente"),
    ("nova", "bin", "4. faixa nunca tocada antes"),
    ("plays_antes", "cont", "4. nº de plays anteriores"),
    ("aceites_antes", "cont", "4. nº de vezes ouvida até o fim antes (extra)"),
    ("liked", "bin", "5. faixa curtida antes"),
    ("servida_7d", "cont", "6. vezes servida pelo motor nos 7 dias anteriores"),
    ("servida_30d", "cont", "6. vezes servida pelo motor nos 30 dias anteriores"),
    ("rep_na_sessao", "bin", "6. já tocou na mesma sessão (extra)"),
    ("dur_faixa_min", "cont", "7. duração da faixa (min)"),
    ("pos_sessao", "cont", "8. posição na sessão"),
    ("dur_sessao_min", "cont", "8. duração da sessão (min)"),
    ("noite", "bin", "9. 18h-24h (contra o resto)"),
    ("madrugada", "bin", "9. 0h-6h (contra o resto)"),
    ("fim_de_semana", "bin", "9. sábado/domingo"),
    ("s24", "bin", "10. celular (S24) contra desktop"),
]


FAIXAS_ACEITES = (("0", 0, 0), ("1-2", 1, 2), ("3-9", 3, 9), ("10+", 10, 10**9))


def derived(r: dict) -> dict:
    """Características derivadas das brutas (binárias da tabela)."""
    return {**r, "nova": r["plays_antes"] == 0, "rep_na_sessao": r["rep_sessao"] > 0,
            "noite": r["hora"] >= 18, "madrugada": r["hora"] < 6,
            "fim_de_semana": r["dow"] >= 5, "s24": r["device"] == "s24"}


def medir(rows: list[dict], boot: int, seed: int) -> dict:
    import numpy as np
    out: dict = {"n": len(rows), "aceites": sum(r["aceite"] for r in rows),
                 "sessoes": len({r["sess"] for r in rows}), "h": {}}
    if not rows:
        return out
    out["skip"] = 1 - out["aceites"] / len(rows)
    for chave, tipo, rot in HIPOTESES:
        u = [r for r in rows if r.get(chave) is not None]
        if len(u) < 10:
            out["h"][chave] = {"n": len(u), "rotulo": rot, "tipo": tipo}
            continue
        y = np.array([r["aceite"] for r in u], dtype=bool)
        x = np.array([float(r[chave]) for r in u])
        rs = M.session_resamples([r["sess"] for r in u], boot, seed)
        d = {"n": len(u), "rotulo": rot, "tipo": tipo, "aceites": int(y.sum()),
             "auc": auc_fast(x, y), "auc_ic95": ci(auc_fast, (x, y), rs)}
        if tipo == "bin":
            f = x.astype(bool)
            d.update({"n_sim": int(f.sum()),
                      "aceite_sim": float(y[f].mean()) if f.any() else None,
                      "aceite_nao": float(y[~f].mean()) if (~f).any() else None,
                      "dif": rate_diff(f, y), "dif_ic95": ci(rate_diff, (f, y), rs)})
        else:
            med = float(np.median(x))
            baixo = x <= med
            d.update({"mediana": med,
                      "media_aceite": float(x[y].mean()) if y.any() else None,
                      "media_pulo": float(x[~y].mean()) if (~y).any() else None,
                      "aceite_ate_mediana": float(y[baixo].mean()) if baixo.any() else None,
                      "aceite_acima_mediana": float(y[~baixo].mean()) if (~baixo).any() else None})
        out["h"][chave] = d
    # hora em faixas, aceite por faixa (descritivo)
    out["por_hora"] = {b: _taxa([r for r in rows if hour_bin(r["hora"]) == b])
                       for b in ("madrugada", "manha", "tarde", "noite")}
    out["por_aceites_antes"] = {rot: _taxa([r for r in rows if lo <= r["aceites_antes"] <= hi])
                                for rot, lo, hi in FAIXAS_ACEITES}
    return out


def _taxa(rs: list[dict]) -> dict:
    return {"n": len(rs), "aceite": (sum(r["aceite"] for r in rs) / len(rs)) if rs else None}


def tempo_de_pulo(rows: list[dict]) -> dict:
    """Distribuição do tempo ouvido antes do pulo (s)."""
    import numpy as np
    sk = np.array([(r["end_ms"] or 0) / 1000.0 for r in rows if not r["aceite"]])
    if len(sk) == 0:
        return {"n_pulos": 0}
    bl = burst_lengths(rows)
    return {"n_pulos": int(len(sk)),
            "pulos_em_rajada_de_3_ou_mais": int(sum(1 for b in bl if b >= 3)),
            "pulos_em_rajada_de_10_ou_mais": int(sum(1 for b in bl if b >= 10)),
            "pulos_com_listen_pct_ge_0_5": int(sum(1 for r in rows if not r["aceite"]
                                                   and (r["listen_pct"] or 0) >= 0.5)),
            "quantis_s": {q: float(np.percentile(sk, q)) for q in (10, 25, 50, 75, 90)},
            "ate_1s": float((sk <= 1).mean()), "ate_5s": float((sk <= 5).mean()),
            "ate_10s": float((sk <= 10).mean()), "ate_30s": float((sk <= 30).mean()),
            "ate_60s": float((sk <= 60).mean()),
            "skip_com_tudo": float(1 - np.mean([r["aceite"] for r in rows])),
            "skip_sem_ate_5s": float(1 - np.mean([r["aceite"] for r in rows if not r["nav_skip"]]))}


def anomalias(plays, rows, tracks) -> dict:
    sk = [r for r in rows if not r["aceite"]]
    ac = [r for r in rows if r["aceite"]]
    return {
        "eventos_fora_do_acervo": sum(1 for r in rows if not r["no_acervo"]),
        "pulos_com_listen_pct_ge_0_9": sum(1 for r in sk if (r["listen_pct"] or 0) >= 0.9),
        "aceites_com_listen_pct_lt_0_5": sum(1 for r in ac if (r["listen_pct"] or 0) < 0.5),
        "sem_semente": sum(1 for r in rows if r["seed"] is None),
        "semente_fora_do_acervo": sum(1 for r in rows if r["seed"] is not None and r["seed"] not in tracks),
        "ultimo_evento_utc": datetime.fromtimestamp(max(M.event_ts(e) for e in plays), timezone.utc).isoformat(),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--qdrant", default=QDRANT)
    ap.add_argument("--boot", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=20261014)
    ap.add_argument("--report", required=True)
    a = ap.parse_args()

    raw = [p.get("payload") or {} for p in
           M.scroll("play_events", {"with_payload": True, "with_vector": False}, a.qdrant)]
    # 11 eventos legados (search_click/queue_add) têm track_id em texto: ficam fora pelo tipo.
    plays = [e for e in raw if e.get("event_type") in M.PLAY_TYPES and isinstance(e.get("track_id"), int)]
    tracks = {p["id"]: p.get("payload") or {} for p in
              M.scroll("rustify_tracks", {"with_payload": ["path", "artist", "duration_ms"],
                                          "with_vector": False}, a.qdrant)}
    enr = {p["id"]: p.get("payload") or {} for p in
           M.scroll("track_enrichments", {"with_payload": ["energy", "valence", "liked_at"],
                                          "with_vector": False}, a.qdrant)}
    moves = load_moves(LOTES)
    rows = [derived(r) for r in build_rows(plays, tracks, enr, moves)]

    rep: dict = {"anomalias": anomalias(plays, rows, tracks), "recortes": {}}
    for origem in ORIGENS:
        for era in ("desde_0275", "antes_0275"):
            base = [r for r in rows if r["origin"] == origem and r["era"] == era]
            chave = f"{origem}/{era}"
            rec = {"todos": medir(base, a.boot, a.seed), "tempo_de_pulo": tempo_de_pulo(base),
                   "por_device": {d: _taxa([r for r in base if r["device"] == d]) for d in ("desktop", "s24")}}
            if era == "desde_0275":
                sem_top, top = drop_top_sessions(base)
                rec["top_sessoes"] = {s: sum(1 for r in base if r["sess"] == s) for s in top}
                rec["sem_top5"] = medir(sem_top, a.boot, a.seed)
                rec["sem_pulos_5s"] = medir([r for r in base if not r["nav_skip"]], a.boot, a.seed)
            rep["recortes"][chave] = rec
    json.dump(rep, open(a.report, "w"), indent=1, ensure_ascii=False)
    imprimir(rep)


def imprimir(rep: dict) -> None:
    print("anomalias:", json.dumps(rep["anomalias"], ensure_ascii=False))
    for k, rec in rep["recortes"].items():
        for var in ("todos", "sem_top5", "sem_pulos_5s"):
            m = rec.get(var)
            if not m or not m.get("n"):
                continue
            print(f"\n== {k} [{var}] n={m['n']} aceites={m['aceites']} sessões={m['sessoes']} "
                  f"skip={m['skip']:.1%}")
            for ch, d in m["h"].items():
                if "auc" not in d:
                    print(f"  {d['rotulo']}: n={d['n']} (insuficiente)")
                    continue
                lo, hi = d["auc_ic95"]
                s = f"  {d['rotulo']:<52} n={d['n']:<5} AUC {d['auc']:.3f} [{lo:.3f}; {hi:.3f}]"
                if d["tipo"] == "bin":
                    dl, dh = d["dif_ic95"]
                    s += (f"  sim={d['n_sim']} aceite {_p(d['aceite_sim'])} x {_p(d['aceite_nao'])}"
                          f"  dif {d['dif']:+.3f} [{dl:+.3f}; {dh:+.3f}]")
                else:
                    s += (f"  méd aceite {d['media_aceite']:.2f} pulo {d['media_pulo']:.2f}"
                          f"  aceite <=med {_p(d['aceite_ate_mediana'])} >med {_p(d['aceite_acima_mediana'])}")
                print(s)
            if var == "todos":
                print("  por hora:", {b: (v["n"], _p(v["aceite"])) for b, v in m["por_hora"].items()})
                print("  por device:", rec["por_device"])
                print("  por vezes ouvida até o fim antes:",
                      {b: (v["n"], _p(v["aceite"])) for b, v in m["por_aceites_antes"].items()})
                print("  tempo de pulo:", json.dumps(rec["tempo_de_pulo"]))
                if "top_sessoes" in rec:
                    print("  top sessões:", rec["top_sessoes"])


def _p(v) -> str:
    return "—" if v is None else f"{v:.1%}"


if __name__ == "__main__":
    main()
