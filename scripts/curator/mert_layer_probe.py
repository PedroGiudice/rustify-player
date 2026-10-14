#!/usr/bin/env python3
"""Sonda de camadas do MERT para ESTILO (CMR-299).

O app guarda a média no tempo da ÚLTIMA camada do MERT-v1-95M. A medição anterior
(`funk_mert_classify.py`) mostrou que essa camada quase não separa subgêneros do funk.
O cartão do modelo diz que as 13 camadas servem a tarefas diferentes. Esta sonda mede
cada camada (0 a 12) e a média das 13, com o MESMO áudio do app.

Janela de áudio: o app decodifica só ~60 s e toma os 30 s centrais desse trecho (15 s a 45 s);
a sonda reproduz isso (`window_start_seconds`). Etapas (cada uma grava em --work e pode ser repetida):
  select   monta o conjunto (âncoras do funk + amostra das playlists externas) e guarda
           os vetores `mert` do Qdrant (só leitura) para a prova de fidelidade;
  extract  na cmr-auto, ffmpeg tira a janela central de 30 s (24 kHz mono f32) e traz
           para a VM; apaga o temporário remoto;
  infer    DENTRO do container `rustify-embed` (sem reiniciar nem editar nada): mesmo
           processor e modelo do app.py, `output_hidden_states=True`, média no tempo de
           cada camada -> 13x768 por faixa;
  evaluatefidelidade (camada 12 x vetor do Qdrant) e avaliação por camada;
  all      select, extract, infer, evaluate.

Uso:
  python3 scripts/curator/mert_layer_probe.py all --work <dir> [--per-playlist 50]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
from collections import Counter, defaultdict

SR = 24_000
WIN_S = 30
# O app para de decodificar com ~60 s de áudio de origem (`decode_flac`, "early termination")
# e só então toma o centro: a janela real é o centro dos PRIMEIROS 60 s (15 s a 45 s).
HEAD_S = 60
MAX_SAMPLES = SR * WIN_S
N_LAYERS = 13
MUSIC = "/home/cmr-auto/Music/"
FUNK_DIR = "Funk Brasileiro"
SRC = MUSIC + FUNK_DIR + "/"
EXTERNAS = ["Rap & Hip-Hop", "Eletrônica", "MPB", "Jazz", "Rock", "Trance", "Funk & Soul"]
SUBGENEROS = ["Funk Brasileiro", "Eletrofunk", "Mega Funk"]
REMOTE = "cmr-auto@100.102.249.9"
CONTAINER = "rustify-embed"
SSH_OPTS = ["-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/mertprobe-ssh-%C",
            "-o", "ControlPersist=600"]


# ---------------------------------------------------------------- funções puras

def window_start(n_total: int, max_samples: int = MAX_SAMPLES) -> int:
    """Índice inicial da janela central (mesma conta do `take_center_window` do app)."""
    return 0 if n_total <= max_samples else (n_total - max_samples) // 2


def center_window(samples, max_samples: int = MAX_SAMPLES):
    """Janela central de `max_samples`; faixa menor volta inteira."""
    s = window_start(len(samples), max_samples)
    return samples[s:s + max_samples]


def window_start_seconds(duration_s: float, win_s: float = WIN_S, head_s: float = HEAD_S) -> float:
    """Início (s) da janela do app: centro dos primeiros `head_s` segundos da faixa;
    0 se a faixa cabe na janela. Faixa de 200 s -> 15 s, não 85 s."""
    return 0.0 if duration_s <= win_s else (min(duration_s, head_s) - win_s) / 2.0


def balanced_accuracy(true: list[str], pred: list[str]) -> tuple[float, dict[str, float]]:
    """(média dos recalls por classe, recall por classe). A classe grande não engana."""
    tot: dict[str, int] = defaultdict(int)
    ok: dict[str, int] = defaultdict(int)
    for t, p in zip(true, pred):
        tot[t] += 1
        ok[t] += int(t == p)
    recall = {c: ok[c] / tot[c] for c in tot}
    return (sum(recall.values()) / len(recall) if recall else 0.0), recall


def plain_accuracy(true: list[str], pred: list[str]) -> float:
    return sum(t == p for t, p in zip(true, pred)) / len(true) if true else 0.0


def sample_by_artist(items: list[dict], n: int, per_artist: int, seed: int) -> list[dict]:
    """Até `n` itens, no máximo `per_artist` por chave `artist_dir`, ordem embaralhada
    com semente fixa (mesma entrada e semente dão a mesma amostra)."""
    ordered = sorted(items, key=lambda d: d["path"])
    random.Random(seed).shuffle(ordered)
    cont: Counter = Counter()
    out = []
    for it in ordered:
        if len(out) >= n:
            break
        if cont[it["artist_dir"]] >= per_artist:
            continue
        cont[it["artist_dir"]] += 1
        out.append(it)
    return out


def cosine_gaps(X, labels: list[str], groups: list[str]) -> dict[str, float | None]:
    """Cosseno médio entre pares: mesmo artista / mesmo rótulo e outro artista / rótulos
    diferentes. `gap_estilo` = segundo menos terceiro. X já normalizado."""
    import numpy as np
    S = X @ X.T
    lab = np.array(labels, dtype=object)
    grp = np.array(groups, dtype=object)
    same_l = lab[:, None] == lab[None, :]
    same_g = grp[:, None] == grp[None, :]
    eye = np.eye(len(labels), dtype=bool)
    masks = {"mesmo_artista": same_g & ~eye, "mesmo_rotulo_outro_artista": same_l & ~same_g,
             "rotulos_diferentes": ~same_l}
    out: dict[str, float | None] = {k: (float(S[m].mean()) if m.any() else None)
                                    for k, m in masks.items()}
    a, b = out["mesmo_rotulo_outro_artista"], out["rotulos_diferentes"]
    out["gap_estilo"] = (a - b) if a is not None and b is not None else None
    return out


def center_normalize(V):
    """Subtrai a média do conjunto e normaliza (L2) cada linha."""
    import numpy as np
    V = np.asarray(V, dtype=np.float64)
    C = V - V.mean(axis=0)
    return C / np.linalg.norm(C, axis=1, keepdims=True)


def l2(V):
    import numpy as np
    V = np.asarray(V, dtype=np.float64)
    return V / np.linalg.norm(V, axis=1, keepdims=True)


# ---------------------------------------------------------------- select

def build_set(points: list[dict], proposta: list[dict], per_playlist: int, per_artist: int,
              seed: int) -> list[dict]:
    """Conjunto da sonda. Cada item: id (int), path, set ('funk'|'ext'), label,
    artist_dir, artist_key."""
    from funk_mert_classify import assign_rows, norm_key, rel_dirs
    com_vetor = [p for p in points
                 if p["payload"].get("path", "").startswith(MUSIC) and (p.get("vector") or {}).get("mert")]
    funk = sorted((p for p in com_vetor if p["payload"]["path"].startswith(SRC)),
                  key=lambda p: p["payload"]["path"])
    rows_of = assign_rows(proposta, [p["payload"]["path"] for p in funk])
    out: list[dict] = []
    for p, r in zip(funk, rows_of):
        if r is None or proposta[r]["confidence"] != "alta":
            continue
        path = p["payload"]["path"]
        ad = rel_dirs(path)[0]
        out.append({"id": p["id"], "path": path, "set": "funk", "label": proposta[r]["dest"],
                    "artist_dir": ad, "artist_key": norm_key(ad)})
    for pl in EXTERNAS:
        cand = []
        for p in com_vetor:
            parts = p["payload"]["path"].split("/")
            if len(parts) < 6 or parts[4] != pl:
                continue
            ad = parts[5] if len(parts) > 6 else (p["payload"].get("artist") or parts[5])
            cand.append({"id": p["id"], "path": p["payload"]["path"], "set": "ext", "label": pl,
                         "artist_dir": ad, "artist_key": norm_key(ad)})
        out += sample_by_artist(cand, per_playlist, per_artist, seed)
    return out


def stage_select(a) -> None:
    import numpy as np
    from funk_mert_classify import scroll_all
    proposta = json.load(open(a.proposta))
    pts = scroll_all(a.qdrant)
    itens = build_set(pts, proposta, a.per_playlist, a.per_artist, a.seed)
    por_id = {p["id"]: p for p in pts}
    for it in itens:
        assert isinstance(it["id"], int)
    os.makedirs(a.work, exist_ok=True)
    json.dump(itens, open(f"{a.work}/set.json", "w"), ensure_ascii=False, indent=1)
    np.save(f"{a.work}/qdrant_mert.npy",
            np.array([por_id[it["id"]]["vector"]["mert"] for it in itens], dtype=np.float32))
    print("conjunto:", len(itens), dict(Counter((i["set"], i["label"]) for i in itens)))


# ---------------------------------------------------------------- extract (cmr-auto)

REMOTE_SCRIPT = r'''
import json, os, subprocess, sys
lista, saida = sys.argv[1], sys.argv[2]
os.makedirs(saida, exist_ok=True)
falhas = []


def via_ffmpeg(path, dest):
    dur = float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path]).decode().strip())
    ini = 0.0 if dur <= 30 else (min(dur, 60.0) - 30) / 2.0
    subprocess.check_call(["ffmpeg", "-v", "error", "-y", "-ss", f"{ini:.4f}", "-i", path,
                           "-t", "30", "-vn", "-ac", "1", "-ar", "24000", "-f", "f32le", dest])


def via_gstreamer(path, dest):
    # Em alguns FLAC (imagem embutida grande) o demuxer do ffmpeg não entrega pacotes.
    # Decodifica tudo com o GStreamer e recorta o centro, com a mesma conta do app.
    tmp = dest + ".full"
    subprocess.check_call(["gst-launch-1.0", "-q", "filesrc", "location=" + path, "!", "decodebin",
                           "!", "audioconvert", "!", "audioresample", "!",
                           "audio/x-raw,rate=24000,channels=1,format=F32LE", "!",
                           "filesink", "location=" + tmp])
    n = min(os.path.getsize(tmp) // 4, 1440000)  # o app só decodifica ~60 s
    ini = 0 if n <= 720000 else (n - 720000) // 2
    with open(tmp, "rb") as f:
        f.seek(ini * 4)
        dados = f.read(720000 * 4)
    open(dest, "wb").write(dados)
    os.remove(tmp)


for i, path in json.load(open(lista)):
    dest = f"{saida}/{i:04d}.f32"
    try:
        via_ffmpeg(path, dest)
        if os.path.getsize(dest) == 0:
            via_gstreamer(path, dest)
            falhas.append([i, path, "ffmpeg vazio; usado gstreamer"])
    except Exception as e:
        falhas.append([i, path, str(e)])
json.dump(falhas, open(saida + "/falhas.json", "w"))
'''


def pendentes(audio: str, n: int) -> list[int]:
    """Índices sem janela (arquivo ausente ou vazio): permite retomar a extração."""
    out = []
    for i in range(n):
        f = f"{audio}/{i:04d}.f32"
        if not os.path.exists(f) or os.path.getsize(f) == 0:
            out.append(i)
    return out


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kw)


def stage_extract(a) -> None:
    itens = json.load(open(f"{a.work}/set.json"))
    audio = f"{a.work}/audio"
    os.makedirs(audio, exist_ok=True)
    falta = pendentes(audio, len(itens))
    if not falta:
        print("nada a extrair")
        return
    tmp = f"/tmp/mertprobe-{os.getpid()}"
    ssh = ["ssh", *SSH_OPTS, REMOTE]
    caminhos = f"{a.work}/paths.json"
    json.dump([[i, itens[i]["path"]] for i in falta], open(caminhos, "w"), ensure_ascii=False)
    rs = f"{a.work}/remote_extract.py"
    open(rs, "w").write(REMOTE_SCRIPT)
    try:
        sh([*ssh, f"mkdir -p {tmp}"])
        sh(["scp", *SSH_OPTS, caminhos, rs, f"{REMOTE}:{tmp}/"])
        t0 = time.time()
        sh([*ssh, f"cd {tmp} && python3 remote_extract.py paths.json out"])
        print(f"extração remota de {len(falta)} faixas: {time.time() - t0:.0f}s")
        # tar | ssh: mais rápido que rsync para volume
        sh(f"{' '.join(ssh)} 'tar -C {tmp}/out -cf - .' | tar -C {audio} -xf -", shell=True)
    finally:
        subprocess.run([*ssh, f"rm -rf {tmp}"])
    falhas = json.load(open(f"{audio}/falhas.json"))
    print(f"ainda sem janela: {pendentes(audio, len(itens))}; avisos: {falhas}")


# ---------------------------------------------------------------- infer (no container)

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
    for n, f in enumerate(arqs):
        audio = np.fromfile(f"{audio_dir}/{f}", dtype="<f4").astype(np.float32)[:MAX_SAMPLES]
        t0 = time.time()
        inputs = proc(audio, sampling_rate=SR, return_tensors="pt")
        with torch.no_grad():
            out = model(**inputs, output_hidden_states=True)
        hs = torch.stack(out.hidden_states, dim=0).squeeze(1)  # [13, T, 768]
        vecs.append(hs.mean(dim=1).cpu().numpy().astype(np.float32))
        tempos.append(time.time() - t0)
        idx.append(int(f.split(".")[0]))
        if n % 25 == 0:
            print(f"{n + 1}/{len(arqs)} {tempos[-1]:.2f}s", flush=True)
    np.savez(out_npz, idx=np.array(idx), layers=np.stack(vecs), tempos=np.array(tempos))
    print("pronto", len(idx), "média s/faixa", float(np.mean(tempos)), flush=True)


def stage_infer(a) -> None:
    audio = os.path.abspath(f"{a.work}/audio")
    d = "/tmp/mertprobe"
    me = os.path.abspath(__file__)
    try:
        sh(["docker", "exec", CONTAINER, "mkdir", "-p", d])
        sh(["docker", "cp", me, f"{CONTAINER}:{d}/probe.py"])
        sh(f"tar -C {audio} -cf - . | docker exec -i {CONTAINER} tar -C {d} -xf -",
           shell=True)
        sh(["docker", "exec", CONTAINER, "python", f"{d}/probe.py", "_container", "--audio", d,
            "--out", f"{d}/layers.npz", "--threads", str(a.threads)])
        sh(["docker", "cp", f"{CONTAINER}:{d}/layers.npz", f"{a.work}/layers.npz"])
    finally:
        subprocess.run(["docker", "exec", CONTAINER, "rm", "-rf", d])


# ---------------------------------------------------------------- eval

def stage_eval(a) -> dict:
    import numpy as np
    from funk_mert_classify import leave_one_group_out
    itens = json.load(open(f"{a.work}/set.json"))
    z = np.load(f"{a.work}/layers.npz")
    qd = np.load(f"{a.work}/qdrant_mert.npy").astype(np.float64)
    idx, L, tempos = z["idx"], z["layers"].astype(np.float64), z["tempos"]
    ordem = np.argsort(idx)
    idx, L, tempos = idx[ordem], L[ordem], tempos[ordem]
    itens = [itens[i] for i in idx]
    qd = qd[idx]

    # ---- fidelidade
    cos = np.einsum("ij,ij->i", l2(L[:, 12]), l2(qd))
    fid = {"n": len(cos), "minimo": float(cos.min()), "mediana": float(np.median(cos)),
           "media": float(cos.mean()), "abaixo_099": int((cos <= 0.99).sum())}
    print("fidelidade:", fid)
    piores = np.argsort(cos)[:5]
    fid["piores"] = [{"path": itens[i]["path"], "cos": float(cos[i])} for i in piores]

    # ---- representações: camadas 0..12, média bruta, média das camadas normalizadas
    reps = {f"camada_{k:02d}": L[:, k] for k in range(N_LAYERS)}
    reps["media_13_bruta"] = L.mean(axis=1)

    # ---- conjuntos de avaliação
    sel_f = [i for i, it in enumerate(itens) if it["set"] == "funk" and it["label"] in SUBGENEROS]
    sel_e = [i for i, it in enumerate(itens) if it["set"] == "ext"]
    lab_f = [itens[i]["label"] for i in sel_f]; grp_f = [itens[i]["artist_key"] for i in sel_f]
    lab_e = [itens[i]["label"] for i in sel_e]; grp_e = [itens[i]["artist_key"] for i in sel_e]
    # média das 13 com cada camada centrada+normalizada ANTES (cada uma pesa igual); o
    # centro é do conjunto de avaliação, então é calculada por conjunto
    def prep(nome: str, sel: list[int]):
        if nome == "media_13_norm":
            return center_normalize(np.mean([center_normalize(L[sel, k]) for k in range(N_LAYERS)], axis=0))
        return center_normalize(reps[nome][sel])

    res: dict[str, dict] = {}
    for nome in [*reps, "media_13_norm"]:
        r: dict = {}
        for tag, sel, lab, grp in (("funk", sel_f, lab_f, grp_f), ("ext", sel_e, lab_e, grp_e)):
            X = prep(nome, sel)
            pred = [p[0] for p in leave_one_group_out(X, lab, grp, a.k)]
            bal, rec = balanced_accuracy(lab, pred)
            r[tag] = {"acuracia": plain_accuracy(lab, pred), "balanceada": bal, "recall": rec,
                      **cosine_gaps(X, lab, grp)}
        res[nome] = r
    out = {"fidelidade": fid, "k": a.k, "n_funk": len(sel_f), "n_ext": len(sel_e),
           "classes_funk": dict(Counter(lab_f)), "classes_ext": dict(Counter(lab_e)),
           "tempo_medio_s": float(tempos.mean()), "tempo_total_s": float(tempos.sum()),
           "camadas": res}
    json.dump(out, open(f"{a.work}/resultados.json", "w"), indent=1, ensure_ascii=False)
    print(f"{'representação':<16} {'funk_bal':>8} {'funk_acc':>8} {'ext_bal':>8} "
          f"{'gap_funk':>9} {'gap_ext':>8}")
    for nome, r in res.items():
        print(f"{nome:<16} {r['funk']['balanceada']:8.3f} {r['funk']['acuracia']:8.3f} "
              f"{r['ext']['balanceada']:8.3f} {r['funk']['gap_estilo']:9.3f} {r['ext']['gap_estilo']:8.3f}")
    return out


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["select", "extract", "infer", "evaluate", "all", "_container"])
    ap.add_argument("--work", help="diretório de trabalho (fora do repo)")
    ap.add_argument("--proposta", default="docs/contexto/13102026-funk-classificacao-proposta.json")
    ap.add_argument("--qdrant", default="http://127.0.0.1:16333")
    ap.add_argument("--per-playlist", type=int, default=50)
    ap.add_argument("--per-artist", type=int, default=3)
    ap.add_argument("--seed", type=int, default=20261014)
    ap.add_argument("--k", type=int, default=7)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--audio"); ap.add_argument("--out")
    a = ap.parse_args()
    if a.stage == "_container":
        container_infer(a.audio, a.out, a.threads)
        return
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    stages = {"select": stage_select, "extract": stage_extract, "infer": stage_infer,
              "evaluate": stage_eval}
    for s in (["select", "extract", "infer", "evaluate"] if a.stage == "all" else [a.stage]):
        stages[s](a)


if __name__ == "__main__":
    main()
