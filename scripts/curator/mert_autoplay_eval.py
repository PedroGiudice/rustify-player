#!/usr/bin/env python3
"""Avaliação offline das camadas do MERT nas escolhas do autoplay (CMR-302).

Pergunta: uma representação de som melhor (camada do meio, janela no meio real da faixa)
prevê melhor o que o CEO aceitou e o que pulou nas escolhas do motor? Nada no app nem no
banco muda: só leitura no Qdrant da cmr-auto (túnel 16333) e na cmr-auto.

Etapas:
  extract   lista as faixas ATUAIS do Qdrant e extrai, para cada track_id ainda sem vetor
            salvo, as 13 camadas do MERT-v1-95M (média no tempo) sobre os 30 s centrais da
            duração TOTAL da faixa (24 kHz mono). Áudio cortado na cmr-auto (ffmpeg; GStreamer
            se o ffmpeg sair vazio), inferência DENTRO do container `rustify-embed` (sem
            reiniciar nem editar nada). Retomável: um arquivo por lote em <out>/batches/;
            rodar de novo só extrai os ids que faltam (inclusive ids novos de faixa movida).
            Faixa que sumiu do caminho no meio do caminho vira "pulada", sem abortar.
  evaluate  junta os vetores salvos com os eventos reais (`play_events`) e mede a AUC da
            similaridade semente->faixa e gosto->faixa para prever ACEITE, por representação
            e por origem (autoplay, station). Ids que não existem mais no Qdrant são ignorados.

Representações: app (vetor `mert` do Qdrant: camada 12, janela 15-45 s), L12c, L6c, L7c e
mid58c (média das camadas 5 a 8), as quatro últimas com a janela central.

Uso:
  uv run --with numpy python3 scripts/curator/mert_autoplay_eval.py extract
  uv run --with numpy python3 scripts/curator/mert_autoplay_eval.py evaluate --report <json>
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

SR = 24_000
WIN_S = 30
MAX_SAMPLES = SR * WIN_S
N_LAYERS = 13
REMOTE = "cmr-auto@100.102.249.9"
CONTAINER = "rustify-embed"
SSH_OPTS = ["-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/mertae-ssh-%C",
            "-o", "ControlPersist=600", "-o", "BatchMode=yes"]
QDRANT = "http://127.0.0.1:16333"
OUT_DEFAULT = os.path.expanduser("~/.local/share/rustify-curator/mert-layers-20261014")

# Régua (scripts/metrics/autoplay_regua.py): mesmas constantes e mesma regra.
V3_CUTOFF = 1786500000
SIGNAL_SCHEMA_V3 = 3
SESSION_GAP_S = 30 * 60
PLAY_TYPES = ("track_ended", "track_skipped")

# derive_behavioral_signals (qdrant_client.rs), só o essencial.
HALF_LIFE_DAYS = 14.0
POSITIVE_MIN_LISTEN_PCT = 0.30
POSITIVE_RAMP_SPAN = 0.50
NEGATIVE_WEIGHT_FLOOR = -0.6
FULL_ATTENTION_MS = 90_000.0
PASSIVE_ORIGINS = ("autoplay", "station", "playlist")
PASSIVE_WEIGHT = 0.6
QUALIFY_FLOOR = 0.55
MAX_BEHAVIORAL_POSITIVES = 25
MAX_TOTAL_POSITIVES = 35
MAX_LIKES = 10

REPS = ("app", "L12c", "L6c", "L7c", "mid58c")


# ---------------------------------------------------------------- funções puras

def center_start_seconds(duration_s: float, win_s: float = WIN_S) -> float:
    """Início (s) da janela no MEIO REAL da faixa; 0 se a faixa cabe na janela."""
    return 0.0 if duration_s <= win_s else (duration_s - win_s) / 2.0


def center_start_samples(n_total: int, max_samples: int = MAX_SAMPLES) -> int:
    """Mesma conta em amostras (caminho do GStreamer, que decodifica a faixa inteira)."""
    return 0 if n_total <= max_samples else (n_total - max_samples) // 2


def event_ts(e: dict) -> int:
    """Tempo do evento como na régua: `timestamp`, senão `started_at`."""
    return int(e.get("timestamp") or e.get("started_at") or 0)


def is_pos_v3(e: dict) -> bool:
    """Corte da régua: `signal_schema` manda quando existe; legado cai na data."""
    s = e.get("signal_schema")
    if s is not None:
        return s >= SIGNAL_SCHEMA_V3
    return event_ts(e) >= V3_CUTOFF


# v0.2.75 (18/08): o rádio passou a semear o re-fetch pós-skip pela última faixa ACEITA.
# Antes, semeava pela rejeitada, e a fila caminhava para longe do último aceite NO ESPAÇO
# DO VETOR `app` (o próprio espaço de busca do motor): isso cria uma vantagem mecânica do
# `app` na leitura semente->faixa que não é qualidade de representação. Daí a leitura por era.
RADIO_FIX_VERSION = (0, 2, 75)


def version_tuple(v) -> tuple:
    """'0.2.82' -> (0, 2, 82); ausente/inválido (evento legado) -> (0,)."""
    try:
        return tuple(int(x) for x in str(v).split("."))
    except (TypeError, ValueError):
        return (0,)


def is_pos_radio_fix(e: dict) -> bool:
    return version_tuple(e.get("app_version") or "") >= RADIO_FIX_VERSION


def is_accept(e: dict) -> bool:
    """Régua: skip = `track_skipped`; aceite = `track_ended`."""
    return e.get("event_type") == "track_ended"


def assign_sessions(events: list[dict], gap_s: int = SESSION_GAP_S) -> list[dict]:
    """Ordena por (dispositivo, tempo) e marca `_sess` = "<device>#<n>". Sessão nova quando
    o intervalo entre eventos consecutivos do mesmo dispositivo passa de `gap_s`. Evento sem
    device_id (legado, só a cmr-auto gerava) vai para o dispositivo "(legado)"."""
    out = sorted(events, key=lambda e: (e.get("device_id") or "(legado)", event_ts(e)))
    last: dict[str, int] = {}
    n: dict[str, int] = defaultdict(int)
    for e in out:
        d = e.get("device_id") or "(legado)"
        t = event_ts(e)
        if d in last and t - last[d] > gap_s:
            n[d] += 1
        last[d] = t
        e["_sess"] = f"{d}#{n[d]}"
    return out


def seeds_by_session(events: list[dict], origins=("autoplay", "station")) -> list[dict]:
    """Para cada evento de origem em `origins`, a semente é a última faixa ACEITA (track_ended,
    de qualquer origem) antes dele na mesma sessão, desde que diferente da própria faixa.
    É o `lastAcceptedId` do rádio (radioSession.ts). Sem aceite anterior na sessão (primeiro
    evento da sessão ou só skips antes), `seed` = None. Espera `assign_sessions` antes."""
    out = []
    last_ok: dict[str, int] = {}
    for e in events:
        s = e["_sess"]
        if e.get("origin") in origins:
            seed = last_ok.get(s)
            if seed == e.get("track_id"):
                seed = None
            out.append({**e, "seed": seed})
        if is_accept(e) and e.get("track_id") is not None:
            last_ok[s] = e["track_id"]
    return out


def auc(scores, labels) -> float:
    """AUC (Mann-Whitney, empates contam 1/2): chance de um aceite ter score maior que um
    skip. NaN se faltar uma das classes."""
    import numpy as np
    s = np.asarray(scores, dtype=np.float64)
    y = np.asarray(labels, dtype=bool)
    n1, n0 = int(y.sum()), int((~y).sum())
    if n1 == 0 or n0 == 0:
        return float("nan")
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s), dtype=np.float64)
    ss = s[order]
    i = 0
    while i < len(ss):
        j = i
        while j + 1 < len(ss) and ss[j + 1] == ss[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return float((ranks[y].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0))


def session_resamples(sessions, n_boot: int = 1000, seed: int = 20261014):
    """Lista de índices de eventos por reamostra: sessões sorteadas com reposição (bloco =
    sessão inteira, porque eventos da mesma sessão não são independentes)."""
    import numpy as np
    rng = np.random.default_rng(seed)
    grupos: dict = defaultdict(list)
    for i, s in enumerate(sessions):
        grupos[s].append(i)
    chaves = list(grupos)
    blocos = [np.array(grupos[k]) for k in chaves]
    out = []
    for _ in range(n_boot):
        pick = rng.integers(0, len(chaves), len(chaves))
        out.append(np.concatenate([blocos[k] for k in pick]))
    return out


def bootstrap_auc(scores, labels, resamples) -> tuple[float, float]:
    """IC 95% (percentis 2,5 e 97,5) da AUC sobre reamostras dadas."""
    import numpy as np
    s = np.asarray(scores, dtype=np.float64)
    y = np.asarray(labels, dtype=bool)
    v = np.array([auc(s[ix], y[ix]) for ix in resamples])
    v = v[~np.isnan(v)]
    return float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))


def bootstrap_diff(scores_a, scores_b, labels, resamples) -> tuple[float, float, float]:
    """IC 95% de AUC(a) - AUC(b) nas MESMAS reamostras (pareado) e fração das reamostras em
    que a diferença é <= 0."""
    import numpy as np
    a = np.asarray(scores_a, dtype=np.float64)
    b = np.asarray(scores_b, dtype=np.float64)
    y = np.asarray(labels, dtype=bool)
    d = np.array([auc(a[ix], y[ix]) - auc(b[ix], y[ix]) for ix in resamples])
    d = d[~np.isnan(d)]
    return float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5)), float((d <= 0).mean())


def taste_positives(history: list[dict], likes: list[tuple[int, int]], now: int) -> list[int]:
    """Positivos do gosto NO MOMENTO `now`, só com o que aconteceu antes (sem vazar o evento
    avaliado). Reproduz o essencial de `derive_behavioral_signals`: peso contínuo
    clamp((lp-0,30)/0,50, -0,6, 1), piso de atenção 90 s e desconto 0,6 de origem passiva no
    lado positivo, decay de meia-vida 14 dias sobre tudo, positivo = peso positivo acumulado
    >= 0,55 e saldo > 0, top 25 por saldo; depois os likes (liked_at < now, mais recentes
    primeiro, até 10) que não estejam entre os negativos (saldo <= -0,30), teto 35."""
    acc: dict[int, list[float]] = {}
    for p in history:
        if event_ts(p) >= now or p.get("track_id") is None:
            continue
        tid = p["track_id"]
        started = int(p.get("started_at") or event_ts(p))
        decay = 0.5 ** (max(now - started, 0) / 86400.0 / HALF_LIFE_DAYS)
        lp = float(p.get("listen_pct") or 0.0)
        w = min(max((lp - POSITIVE_MIN_LISTEN_PCT) / POSITIVE_RAMP_SPAN, NEGATIVE_WEIGHT_FLOOR), 1.0)
        a = acc.setdefault(tid, [0.0, 0.0, started])
        if w > 0:
            ms = p.get("end_position_ms")
            if ms is None and p.get("duration_ms") is not None:
                ms = p["duration_ms"] * lp
            att = 1.0 if ms is None else min(ms / FULL_ATTENTION_MS, 1.0)
            w = w * att * (PASSIVE_WEIGHT if p.get("origin") in PASSIVE_ORIGINS else 1.0)
            a[0] += w * decay
            a[1] += w
        else:
            a[0] += w * decay
        a[2] = max(a[2], started)
    qual = [(t, a[0], a[2]) for t, a in acc.items() if a[1] >= QUALIFY_FLOOR and a[0] > 0]
    qual.sort(key=lambda x: (-x[1], -x[2], x[0]))
    pos = [t for t, *_ in qual[:MAX_BEHAVIORAL_POSITIVES]]
    neg = {t for t, a in acc.items() if a[0] <= -0.30}
    vistos = set(pos)
    recentes = sorted((l for l in likes if l[1] < now), key=lambda l: -l[1])[:MAX_LIKES]
    for t, _ in recentes:
        if len(pos) >= MAX_TOTAL_POSITIVES:
            break
        if t not in neg and t not in vistos:
            pos.append(t)
            vistos.add(t)
    return pos


def center_normalize(V):
    import numpy as np
    V = np.asarray(V, dtype=np.float64)
    C = V - V.mean(axis=0)
    return C / np.linalg.norm(C, axis=1, keepdims=True)


def build_reps(app, layers) -> dict:
    """Matrizes [n, 768] centradas pela média do acervo e normalizadas, por representação.
    `app` = vetores do Qdrant [n,768]; `layers` = [n,13,768] (janela central)."""
    L = layers.astype("float64")
    return {"app": center_normalize(app), "L12c": center_normalize(L[:, 12]),
            "L6c": center_normalize(L[:, 6]), "L7c": center_normalize(L[:, 7]),
            "mid58c": center_normalize(L[:, 5:9].mean(axis=1))}


# ---------------------------------------------------------------- Qdrant (só leitura)

def scroll(collection: str, body_extra: dict, qdrant: str = QDRANT) -> list[dict]:
    out, off = [], None
    while True:
        body = {"limit": 1000, **body_extra}
        if off is not None:
            body["offset"] = off
        req = urllib.request.Request(f"{qdrant}/collections/{collection}/points/scroll",
                                     data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        res = json.load(urllib.request.urlopen(req, timeout=180))["result"]
        out += res["points"]  # json do Python lê u64 como int sem perda
        off = res.get("next_page_offset")
        if off is None:
            return out


# ---------------------------------------------------------------- extract

REMOTE_SCRIPT = r'''
import json, os, subprocess, sys
lista, saida = sys.argv[1], sys.argv[2]
os.makedirs(saida, exist_ok=True)
info = {}


def via_ffmpeg(path, dest):
    dur = float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path]).decode().strip())
    ini = 0.0 if dur <= 30 else (dur - 30) / 2.0
    subprocess.check_call(["ffmpeg", "-v", "error", "-y", "-ss", f"{ini:.4f}", "-i", path,
                           "-t", "30", "-vn", "-ac", "1", "-ar", "24000", "-f", "f32le", dest])
    return dur


def via_gstreamer(path, dest):
    # FLAC em que o demuxer do ffmpeg não entrega pacotes: decodifica tudo e recorta o centro.
    tmp = dest + ".full"
    subprocess.check_call(["gst-launch-1.0", "-q", "filesrc", "location=" + path, "!", "decodebin",
                           "!", "audioconvert", "!", "audioresample", "!",
                           "audio/x-raw,rate=24000,channels=1,format=F32LE", "!",
                           "filesink", "location=" + tmp])
    n = os.path.getsize(tmp) // 4
    ini = 0 if n <= 720000 else (n - 720000) // 2
    with open(tmp, "rb") as f:
        f.seek(ini * 4)
        dados = f.read(720000 * 4)
    open(dest, "wb").write(dados)
    os.remove(tmp)
    return n / 24000.0


for i, path in json.load(open(lista)):
    dest = f"{saida}/{i:04d}.f32"
    if not os.path.exists(path):
        info[i] = {"erro": "sumiu do caminho"}
        continue
    try:
        dur = via_ffmpeg(path, dest)
        nota = None
        if os.path.getsize(dest) == 0:
            dur = via_gstreamer(path, dest)
            nota = "ffmpeg vazio; usado gstreamer"
        if os.path.getsize(dest) == 0:
            os.remove(dest)
            info[i] = {"erro": "áudio vazio"}
        else:
            info[i] = {"dur": dur, "nota": nota}
    except Exception as e:
        if os.path.exists(dest):
            os.remove(dest)
        info[i] = {"erro": str(e)[:300]}
json.dump(info, open(saida + "/info.json", "w"))
'''


def container_infer(audio_dir: str, out_npz: str, threads: int) -> None:
    """Roda DENTRO do container. Mesmo processor/modelo do app.py da rustify-embed."""
    import numpy as np
    import torch
    from transformers import AutoModel, Wav2Vec2FeatureExtractor
    torch.set_num_threads(threads)
    model_id = os.environ.get("RUSTIFY_EMBED_MODEL", "m-a-p/MERT-v1-95M")
    proc = Wav2Vec2FeatureExtractor.from_pretrained(model_id, trust_remote_code=True)
    model = AutoModel.from_pretrained(model_id, trust_remote_code=True)
    model.eval()
    arqs = sorted(f for f in os.listdir(audio_dir) if f.endswith(".f32"))
    idx, vecs, tempos = [], [], []
    for f in arqs:
        audio = np.fromfile(f"{audio_dir}/{f}", dtype="<f4").astype(np.float32)[:MAX_SAMPLES]
        t0 = time.time()
        inputs = proc(audio, sampling_rate=SR, return_tensors="pt")
        with torch.no_grad():
            out = model(**inputs, output_hidden_states=True)
        hs = torch.stack(out.hidden_states, dim=0).squeeze(1)  # [13, T, 768]
        vecs.append(hs.mean(dim=1).cpu().numpy().astype(np.float32))
        tempos.append(time.time() - t0)
        idx.append(int(f.split(".")[0]))
    np.savez(out_npz, idx=np.array(idx, dtype=np.int64),
             layers=np.stack(vecs) if vecs else np.zeros((0, N_LAYERS, 768), np.float32),
             tempos=np.array(tempos))


def done_ids(out: str) -> set[str]:
    """Ids (string) que já têm vetor salvo em algum lote, mais os pulados definitivos."""
    import numpy as np
    feitos: set[str] = set()
    bd = f"{out}/batches"
    if not os.path.isdir(bd):
        return feitos
    for f in os.listdir(bd):
        if f.endswith(".npz"):
            feitos.update(str(x) for x in np.load(f"{bd}/{f}")["ids"])
    return feitos


def plan_batches(tracks: list[dict], feitos: set[str], size: int, start: int) -> list[tuple[int, list[dict]]]:
    """Lotes numerados a partir de `start` com as faixas ainda sem vetor (ordem por caminho)."""
    falta = sorted((t for t in tracks if str(t["id"]) not in feitos), key=lambda t: t["path"])
    return [(start + k, falta[i:i + size]) for k, i in enumerate(range(0, len(falta), size))]


def sh(cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


_lock = threading.Lock()


def log(out: str, msg: str) -> None:
    with _lock:
        with open(f"{out}/extract.log", "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")


def run_batch(out: str, num: int, itens: list[dict], threads: int) -> dict:
    import numpy as np
    tag = f"mertae-{os.getpid()}-{num}"
    rtmp = f"/tmp/{tag}"
    ltmp = f"{out}/staging/{num:05d}"
    ctmp = f"/tmp/{tag}"
    ssh = ["ssh", *SSH_OPTS, REMOTE]
    os.makedirs(ltmp, exist_ok=True)
    t0 = time.time()
    try:
        json.dump([[i, it["path"]] for i, it in enumerate(itens)],
                  open(f"{ltmp}/paths.json", "w"), ensure_ascii=False)
        open(f"{ltmp}/remote_extract.py", "w").write(REMOTE_SCRIPT)
        sh([*ssh, f"mkdir -p {rtmp}"])
        sh(["scp", "-q", *SSH_OPTS, f"{ltmp}/paths.json", f"{ltmp}/remote_extract.py", f"{REMOTE}:{rtmp}/"])
        sh([*ssh, f"cd {rtmp} && python3 remote_extract.py paths.json audio"])
        os.makedirs(f"{ltmp}/audio", exist_ok=True)
        sh(f"{' '.join(ssh)} 'tar -C {rtmp}/audio -cf - .' | tar -C {ltmp}/audio -xf -", shell=True)
        t_ext = time.time() - t0
        info = {int(k): v for k, v in json.load(open(f"{ltmp}/audio/info.json")).items()}
        sh(["docker", "exec", CONTAINER, "mkdir", "-p", f"{ctmp}/audio"])
        sh(["docker", "cp", os.path.abspath(__file__), f"{CONTAINER}:{ctmp}/eval.py"])
        sh(f"tar -C {ltmp}/audio -cf - --exclude info.json . | docker exec -i {CONTAINER} tar -C {ctmp}/audio -xf -",
           shell=True)
        sh(["docker", "exec", "-e", "HF_HUB_OFFLINE=1", CONTAINER, "python", f"{ctmp}/eval.py", "_container", "--audio",
            f"{ctmp}/audio", "--npz", f"{ctmp}/layers.npz", "--threads", str(threads)],
           stdout=subprocess.DEVNULL)
        sh(["docker", "cp", f"{CONTAINER}:{ctmp}/layers.npz", f"{ltmp}/layers.npz"])
        z = np.load(f"{ltmp}/layers.npz")
        idx = [int(i) for i in z["idx"]]
        ids = np.array([str(itens[i]["id"]) for i in idx])
        paths = np.array([itens[i]["path"] for i in idx])
        durs = np.array([float(info.get(i, {}).get("dur") or 0) for i in idx])
        dest = f"{out}/batches/b{num:05d}.npz"
        np.savez(dest + ".tmp.npz", ids=ids, paths=paths, durs=durs,
                 layers=z["layers"].astype(np.float16), tempos=z["tempos"])
        os.replace(dest + ".tmp.npz", dest)
        puladas = [{"id": str(itens[i]["id"]), "path": itens[i]["path"], **info.get(i, {"erro": "sem info"})}
                   for i in range(len(itens)) if i not in set(idx)]
        notas = [{"id": str(itens[i]["id"]), "nota": info[i]["nota"]} for i in idx if info.get(i, {}).get("nota")]
        json.dump({"puladas": puladas, "notas": notas, "t_extracao": t_ext,
                   "t_total": time.time() - t0, "n": len(idx)},
                  open(f"{out}/batches/b{num:05d}.json", "w"), ensure_ascii=False)
        log(out, f"lote {num}: {len(idx)} ok, {len(puladas)} puladas, {time.time() - t0:.0f}s")
        return {"n": len(idx), "puladas": len(puladas)}
    finally:
        subprocess.run([*ssh, f"rm -rf {rtmp}"], capture_output=True)
        subprocess.run(["docker", "exec", CONTAINER, "rm", "-rf", ctmp], capture_output=True)
        subprocess.run(["rm", "-rf", ltmp])


def stage_extract(a) -> None:
    out = a.out
    os.makedirs(f"{out}/batches", exist_ok=True)
    pts = scroll("rustify_tracks", {"with_payload": ["path"], "with_vector": False}, a.qdrant)
    tracks = [{"id": p["id"], "path": p["payload"]["path"]} for p in pts if p["payload"].get("path")]
    for t in tracks:
        assert isinstance(t["id"], int)
    feitos = done_ids(out)
    nums = [int(f[1:6]) for f in os.listdir(f"{out}/batches") if f.endswith(".npz")]
    plano = plan_batches(tracks, feitos, a.batch, (max(nums) + 1) if nums else 0)
    if a.limit:  # teste de fumaça
        plano = plano[:a.limit]
    total = sum(len(b) for _, b in plano)
    log(out, f"início: {len(tracks)} faixas no Qdrant, {len(feitos)} já salvas, {total} a extrair "
             f"em {len(plano)} lotes, {a.workers} workers x {a.threads} threads")
    t0 = time.time()
    feito = {"n": 0, "puladas": 0, "lotes": 0}

    def um(b):
        num, itens = b
        try:
            r = run_batch(out, num, itens, a.threads)
        except Exception as e:  # lote falho: fica para a próxima rodada
            log(out, f"lote {num} FALHOU: {e}")
            r = {"n": 0, "puladas": 0}
        with _lock:
            feito["n"] += r["n"]
            feito["puladas"] += r["puladas"]
            feito["lotes"] += 1
            el = time.time() - t0
            json.dump({"lotes_feitos": feito["lotes"], "lotes": len(plano), "faixas_ok": feito["n"],
                       "puladas": feito["puladas"], "a_extrair": total, "decorrido_s": round(el),
                       "s_por_faixa_parede": round(el / max(feito["n"], 1), 2),
                       "atualizado": time.strftime("%Y-%m-%d %H:%M:%S")},
                      open(f"{out}/progress.json", "w"), indent=1)

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        list(ex.map(um, plano))
    log(out, f"fim: {feito['n']} ok, {feito['puladas']} puladas, {time.time() - t0:.0f}s")


# ---------------------------------------------------------------- evaluate

def load_layers(out: str):
    """{id string: (layers float16 [13,768], path)} de todos os lotes."""
    import numpy as np
    res = {}
    bd = f"{out}/batches"
    for f in sorted(os.listdir(bd)):
        if f.endswith(".npz"):
            z = np.load(f"{bd}/{f}")
            for i, tid in enumerate(z["ids"]):
                res[str(tid)] = (z["layers"][i], str(z["paths"][i]))
    return res


def stage_eval(a) -> dict:
    import numpy as np
    saved = load_layers(a.out)
    pts = scroll("rustify_tracks", {"with_payload": ["path"], "with_vector": ["mert"]}, a.qdrant)
    ids, app, lay = [], [], []
    sem_mert = sem_camadas = 0
    for p in pts:
        v = (p.get("vector") or {}).get("mert")
        if not v:
            sem_mert += 1
            continue
        s = saved.get(str(p["id"]))
        if s is None:
            sem_camadas += 1
            continue
        ids.append(p["id"]); app.append(v); lay.append(s[0])
    reps = build_reps(np.array(app), np.stack(lay))
    row = {t: i for i, t in enumerate(ids)}
    orfas = len(set(saved) - {str(t) for t in ids})

    raw = [p.get("payload") or {} for p in scroll("play_events",
                                                   {"with_payload": True, "with_vector": False}, a.qdrant)]
    plays = [e for e in raw if e.get("event_type") in PLAY_TYPES and e.get("track_id") is not None]
    ev = assign_sessions(plays)
    alvos = [e for e in seeds_by_session(ev) if is_pos_v3(e)]
    likes = [(p["id"], int(p["payload"]["liked_at"])) for p in
             scroll("track_enrichments", {"with_payload": ["liked_at"], "with_vector": False,
                                          "filter": {"must_not": [{"is_empty": {"key": "liked_at"}}]}},
                    a.qdrant) if p["payload"].get("liked_at")]

    res: dict = {"vetores": {"no_qdrant": len(pts), "sem_mert": sem_mert, "sem_camadas": sem_camadas,
                             "usadas": len(ids), "salvas_orfas_ignoradas": orfas},
                 "origens": {}}
    for origem in ("autoplay", "station"):
        evs = [e for e in alvos if e.get("origin") == origem]
        cont = {"eventos": len(evs), "aceites": sum(map(is_accept, evs)),
                "sem_semente": sum(1 for e in evs if e["seed"] is None),
                "sem_vetor": sum(1 for e in evs if e["track_id"] not in row)}
        r: dict = {"contagem": cont}
        # leitura 1: semente -> faixa
        u = [e for e in evs if e["seed"] is not None and e["seed"] in row and e["track_id"] in row]
        sim = lambda R, e: float(R[row[e["seed"]]] @ R[row[e["track_id"]]])
        r["semente"] = medir(u, reps, sim, a)
        r["semente_antes_0275"] = medir([e for e in u if not is_pos_radio_fix(e)], reps, sim, a)
        r["semente_desde_0275"] = medir([e for e in u if is_pos_radio_fix(e)], reps, sim, a)
        # leitura 2: gosto -> faixa (positivos do momento do evento)
        g, cents = [], []
        for e in evs:
            if e["track_id"] not in row:
                continue
            pos = [t for t in taste_positives(plays, likes, event_ts(e)) if t in row]
            if pos:
                g.append(e); cents.append([row[t] for t in pos])
        cmap = {id(e): c for e, c in zip(g, cents)}

        def gosto(R, e):
            c = R[cmap[id(e)]].mean(axis=0)
            return float(R[row[e["track_id"]]] @ c / np.linalg.norm(c))
        r["gosto"] = medir(g, reps, gosto, a)
        res["origens"][origem] = r
    json.dump(res, open(a.report, "w"), indent=1, ensure_ascii=False)
    imprimir(res)
    return res


def medir(evs: list[dict], reps: dict, score, a) -> dict:
    if not evs:
        return {"n": 0}
    y = [is_accept(e) for e in evs]
    sess = [e["_sess"] for e in evs]
    rs = session_resamples(sess, a.boot, a.seed)
    sc = {k: [score(R, e) for e in evs] for k, R in reps.items()}
    out = {"n": len(evs), "aceites": int(sum(y)), "sessoes": len(set(sess)), "rep": {}}
    for k in REPS:
        lo, hi = bootstrap_auc(sc[k], y, rs)
        d = {"auc": auc(sc[k], y), "ic95": [lo, hi]}
        if k != "app":
            dlo, dhi, p0 = bootstrap_diff(sc[k], sc["app"], y, rs)
            d["dif_vs_app_ic95"] = [dlo, dhi]
            d["frac_dif_le_0"] = p0
        out["rep"][k] = d
    lo, hi, p0 = bootstrap_diff(sc["L6c"], sc["L12c"], y, rs)
    out["camada_L6c_vs_L12c"] = {"ic95": [lo, hi], "frac_dif_le_0": p0}
    lo, hi, p0 = bootstrap_diff(sc["L12c"], sc["app"], y, rs)
    out["janela_L12c_vs_app"] = {"ic95": [lo, hi], "frac_dif_le_0": p0}
    return out


def imprimir(res: dict) -> None:
    print(json.dumps(res["vetores"]))
    for o, r in res["origens"].items():
        print(f"== {o}: {r['contagem']}")
        for leitura in ("semente", "semente_antes_0275", "semente_desde_0275", "gosto"):
            m = r[leitura]
            if not m.get("n"):
                print(f"  {leitura}: sem eventos")
                continue
            print(f"  {leitura}: n={m['n']} aceites={m['aceites']} sessões={m['sessoes']}")
            for k, d in m["rep"].items():
                extra = (f"  dif vs app [{d['dif_vs_app_ic95'][0]:+.3f}, {d['dif_vs_app_ic95'][1]:+.3f}]"
                         if "dif_vs_app_ic95" in d else "")
                print(f"    {k:<7} AUC {d['auc']:.3f} [{d['ic95'][0]:.3f}, {d['ic95'][1]:.3f}]{extra}")


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["extract", "evaluate", "_container"])
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--qdrant", default=QDRANT)
    ap.add_argument("--batch", type=int, default=40)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--threads", type=int, default=7)
    ap.add_argument("--boot", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=20261014)
    ap.add_argument("--limit", type=int, default=0, help="só os primeiros N lotes (fumaça)")
    ap.add_argument("--report")
    ap.add_argument("--audio"); ap.add_argument("--npz")
    a = ap.parse_args()
    if a.stage == "_container":
        container_infer(a.audio, a.npz, a.threads)
    elif a.stage == "extract":
        stage_extract(a)
    else:
        a.report = a.report or f"{a.out}/avaliacao.json"
        stage_eval(a)


if __name__ == "__main__":
    main()
