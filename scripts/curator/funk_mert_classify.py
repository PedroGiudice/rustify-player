#!/usr/bin/env python3
"""Classificação da pasta Funk Brasileiro por SOM (vizinhança MERT), CMR-299.

O CEO rejeitou a proposta feita por nome de artista + pesquisa web
(`docs/contexto/13102026-funk-classificacao-proposta.json`) e pediu a separação pelo
som. Este script usa os vetores `mert` (768d) que o app já tem no Qdrant da cmr-auto:

1. Lê (só leitura) todas as faixas do Qdrant pelo túnel 16333.
2. Âncoras = faixas cobertas por linhas `alta` da proposta (aprovadas pelo CEO),
   faixas das linhas `media` de Techfunk (âncoras PROVISÓRIAS: a classe não tem linha
   `alta`) e as faixas das playlists externas de destino (Eletrônica, MPB,
   Rap & Hip-Hop, Country & Folk).
3. Cada faixa não-âncora é classificada por k-NN cosseno (k=7) contra as âncoras, com
   voto ponderado pela similaridade; a confiança vem da margem entre o 1º e o 2º
   destino. O resultado é agregado por `artist_dir`/`album_dir`, como na proposta.
4. Validação: leave-one-ARTIST-out nas âncoras (todas as faixas do mesmo artista saem
   juntas; leave-one-track-out vaza porque faixas do mesmo artista são vizinhas).

Saída: JSON no formato da proposta (lido por `funk_split_plan.py`) com campos extras.
Não move nada e não escreve no Qdrant.

Uso:
  python3 scripts/curator/funk_mert_classify.py \
      --proposta docs/contexto/13102026-funk-classificacao-proposta.json \
      --out docs/contexto/14102026-funk-mert-classificacao.json \
      [--report /tmp/relatorio.json] [--k 7] [--qdrant http://127.0.0.1:16333]
"""
from __future__ import annotations

import argparse
import json
import unicodedata
import urllib.request
from collections import Counter, defaultdict

import numpy as np

MUSIC = "/home/cmr-auto/Music/"
FUNK = "Funk Brasileiro"
SRC = MUSIC + FUNK + "/"
EXTERNOS = ["Eletrônica", "MPB", "Rap & Hip-Hop", "Country & Folk"]
TECHFUNK = "Techfunk"
# Confiança vem da margem, mas o limiar NÃO é fixo: é calibrado na validação
# leave-one-artist-out das âncoras aprovadas do funk. "alta" = menor margem a partir da
# qual o acerto é >= 95%; "media" = >= 80% (mínimo de 10 âncoras acima do limiar). Se
# nenhuma margem atinge a meta, não existe "alta"/"media": tudo sai "baixa".
META_ALTA = 0.95
META_MEDIA = 0.80
MIN_N_CALIB = 10


# ---------------------------------------------------------------- funções puras

def norm_key(s: str) -> str:
    """Chave de artista para agrupar: sem acento, minúsculas, espaços colapsados."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return " ".join(s.casefold().split())


def weighted_vote(sims: np.ndarray, labels: list[str], k: int,
                  prior: dict[str, int] | None = None) -> dict[str, float]:
    """Soma da similaridade dos k vizinhos mais próximos, por rótulo.

    Similaridade negativa vira peso ~0 (vizinho que nem se parece não vota). Com
    `prior`, o voto é dividido pelo tamanho da classe (variante balanceada, diagnóstico)."""
    k = min(k, len(sims))
    idx = np.argpartition(-sims, k - 1)[:k]
    scores: dict[str, float] = defaultdict(float)
    for i in idx:
        w = max(float(sims[i]), 1e-6)
        scores[labels[i]] += w / prior[labels[i]] if prior else w
    return dict(scores)


def vote_margin(scores: dict[str, float]) -> tuple[str, str | None, float, dict[str, float]]:
    """(1º destino, 2º destino, margem, participação normalizada).

    margem = participação do 1º menos a do 2º, em [0, 1]: 1.0 = unânime."""
    total = sum(scores.values())
    share = {d: v / total for d, v in scores.items()} if total > 0 else {}
    ordem = sorted(share.items(), key=lambda kv: (-kv[1], kv[0]))
    if not ordem:
        return "", None, 0.0, {}
    best, s1 = ordem[0]
    second, s2 = (ordem[1] if len(ordem) > 1 else (None, 0.0))
    return best, second, s1 - s2, share


def calibrate_thresholds(margins: list[float], correct: list[bool], meta_alta: float = META_ALTA,
                         meta_media: float = META_MEDIA, min_n: int = MIN_N_CALIB
                         ) -> tuple[float | None, float | None]:
    """Menor limiar t tal que o acerto das validações com margem >= t atinge a meta
    (com pelo menos `min_n` casos). None = meta inalcançável em qualquer limiar."""
    pares = sorted(zip(margins, correct))
    out = []
    for meta in (meta_alta, meta_media):
        achado = None
        for t in sorted({m for m, _ in pares}):
            sel = [c for m, c in pares if m >= t]
            if len(sel) >= min_n and sum(sel) / len(sel) >= meta:
                achado = t
                break
        out.append(achado)
    return out[0], out[1]


def confidence_of(margin: float, t_alta: float | None, t_media: float | None) -> str:
    if t_alta is not None and margin >= t_alta:
        return "alta"
    if t_media is not None and margin >= t_media:
        return "media"
    return "baixa"


def classify(queries: np.ndarray, anchors: np.ndarray, labels: list[str], k: int,
             exclude: np.ndarray | None = None, balanced: bool = False
             ) -> list[tuple[str, str | None, float, dict[str, float]]]:
    """k-NN ponderado de cada query contra as âncoras. `exclude[i, j]` True tira a
    âncora j da vizinhança da query i (usado no leave-one-artist-out)."""
    sims = queries @ anchors.T
    if exclude is not None:
        sims = np.where(exclude, -np.inf, sims)
    prior = Counter(labels) if balanced else None
    out = []
    for row in sims:
        ok = np.isfinite(row)
        lab = [labels[j] for j in np.flatnonzero(ok)]
        out.append(vote_margin(weighted_vote(row[ok], lab, k, prior)))
    return out


def leave_one_group_out(vecs: np.ndarray, labels: list[str], groups: list[str], k: int,
                        balanced: bool = False):
    """Prediz cada âncora sem nenhuma âncora do MESMO grupo (artista) na vizinhança."""
    g = np.array(groups, dtype=object)
    exclude = g[:, None] == g[None, :]
    return classify(vecs, vecs, labels, k, exclude=exclude, balanced=balanced)


def centroid_loao(vecs: np.ndarray, labels: list[str], groups: list[str]) -> list[str]:
    """Variante diagnóstica: centroide por classe sem o artista da faixa avaliada."""
    lab = np.array(labels, dtype=object); g = np.array(groups, dtype=object)
    classes = sorted(set(labels)); pred = []
    for j in range(len(labels)):
        best, bs = "", -np.inf
        for c in classes:
            m = (lab == c) & (g != g[j])
            if not m.any():
                continue
            cen = vecs[m].mean(axis=0)
            s = float(vecs[j] @ cen) / float(np.linalg.norm(cen))
            if s > bs:
                best, bs = c, s
        pred.append(best)
    return pred


def confusion(true: list[str], pred: list[str]) -> dict[str, dict[str, int]]:
    m: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for t, p in zip(true, pred):
        m[t][p] += 1
    return {t: dict(r) for t, r in m.items()}


def accuracy_by_class(true: list[str], pred: list[str]) -> dict[str, tuple[int, int]]:
    acc: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for t, p in zip(true, pred):
        acc[t][1] += 1
        acc[t][0] += int(t == p)
    return {t: (a, n) for t, (a, n) in acc.items()}


def aggregate(track_results: list[tuple[str, float, dict[str, float]]]) -> dict:
    """Agrega faixas de um diretório: soma das participações de cada faixa (cada faixa
    pesa 1). Devolve destino, margem do diretório e a divisão faixa a faixa."""
    tot: dict[str, float] = defaultdict(float)
    for _best, _m, share in track_results:
        for d, v in share.items():
            tot[d] += v
    n = len(track_results)
    ordem = sorted(tot.items(), key=lambda kv: (-kv[1], kv[0]))
    best, s1 = ordem[0]
    s2 = ordem[1][1] if len(ordem) > 1 else 0.0
    split = Counter(b for b, _m, _s in track_results)
    return {"dest": best, "margin": round((s1 - s2) / n, 3), "n_tracks": n,
            "split": dict(split.most_common()), "dividido": len(split) > 1}


def assign_rows(rows: list[dict], paths: list[str]) -> list[int | None]:
    """Linha da proposta que cobre cada caminho, com a precedência do funk_split_plan:
    linha de álbum específico vence a linha "todos" do artista."""
    ordem = sorted(range(len(rows)), key=lambda i: 0 if rows[i].get("album_dir") else 1)
    prefixes = [(i, SRC + rows[i]["artist_dir"] + "/" +
                 (rows[i]["album_dir"] + "/" if rows[i].get("album_dir") else "")) for i in ordem]
    out: list[int | None] = []
    for p in paths:
        out.append(next((i for i, pre in prefixes if p.startswith(pre)), None))
    return out


def rel_dirs(path: str) -> tuple[str, str | None]:
    """(artist_dir, album_dir) relativos a SRC; album_dir None se a faixa está solta."""
    parts = path[len(SRC):].split("/")
    return parts[0], (parts[1] if len(parts) >= 3 else None)


# ---------------------------------------------------------------- Qdrant (só leitura)

def scroll_all(qdrant: str) -> list[dict]:
    out, off = [], None
    while True:
        body = {"limit": 500, "with_payload": ["path", "artist", "title", "album_title"],
                "with_vector": ["mert"]}
        if off is not None:
            body["offset"] = off
        req = urllib.request.Request(f"{qdrant}/collections/rustify_tracks/points/scroll",
                                     data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        res = json.load(urllib.request.urlopen(req, timeout=120))["result"]
        out += res["points"]  # ids como int Python (u64 sem perda)
        off = res.get("next_page_offset")
        if off is None:
            return out


# ---------------------------------------------------------------- pipeline

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proposta", default="docs/contexto/13102026-funk-classificacao-proposta.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", help="JSON de diagnóstico (validação, Techfunk, divergências)")
    ap.add_argument("--k", type=int, default=7)
    ap.add_argument("--no-center", action="store_true", help="não subtrair a média do acervo")
    ap.add_argument("--qdrant", default="http://127.0.0.1:16333")
    a = ap.parse_args()

    rows = json.load(open(a.proposta))
    pts = scroll_all(a.qdrant)

    sem_vetor, faixas = [], []
    for p in pts:
        path = p["payload"].get("path", "")
        v = (p.get("vector") or {}).get("mert")
        if not path.startswith(MUSIC):
            continue
        if not v:
            if path.startswith(SRC) or path.split("/")[4] in EXTERNOS:
                sem_vetor.append({"id": str(p["id"]), "path": path})
            continue
        faixas.append((p["id"], path, v, p["payload"]))

    X0 = np.array([f[2] for f in faixas], dtype=np.float64)
    X_cru = X0 / np.linalg.norm(X0, axis=1, keepdims=True)
    # O MERT é anisotrópico (cosseno médio ~0,8 entre faixas quaisquer): subtrair a média
    # do acervo inteiro tira a direção comum e deixa a vizinhança decidir pelo resto.
    X_cen = X0 - X0.mean(axis=0)
    X_cen /= np.linalg.norm(X_cen, axis=1, keepdims=True)
    X = X_cru if a.no_center else X_cen

    funk_idx = [i for i, f in enumerate(faixas) if f[1].startswith(SRC)]
    funk_rows = assign_rows(rows, [faixas[i][1] for i in funk_idx])
    row_of = dict(zip(funk_idx, funk_rows))

    anc_idx, anc_lab, anc_grp, anc_tipo = [], [], [], []
    for i in funk_idx:
        r = row_of[i]
        if r is None:
            continue
        row = rows[r]
        if row["confidence"] == "alta":
            tipo = "ancora"
        elif row["dest"] == TECHFUNK and row["confidence"] in ("media", "média"):
            tipo = "ancora_provisoria"
        else:
            continue
        anc_idx.append(i); anc_lab.append(row["dest"]); anc_tipo.append(tipo)
        anc_grp.append(norm_key(rel_dirs(faixas[i][1])[0]))
    for i, f in enumerate(faixas):
        parts = f[1].split("/")
        if parts[4] in EXTERNOS:
            anc_idx.append(i); anc_lab.append(parts[4]); anc_tipo.append("externa")
            artista = parts[5] if len(parts) > 6 else (f[3].get("artist") or parts[5])
            anc_grp.append(norm_key(artista))

    A = X[anc_idx]
    anc_set = set(anc_idx)

    # ---- validação leave-one-artist-out
    loao = leave_one_group_out(A, anc_lab, anc_grp, a.k)
    loao_pred = [r[0] for r in loao]
    val = {}
    for nome, filtro in [("todas", lambda t: True),
                         ("funk_aprovadas", lambda t: t == "ancora"),
                         ("externas", lambda t: t == "externa"),
                         ("techfunk_provisorias", lambda t: t == "ancora_provisoria")]:
        sel = [j for j, t in enumerate(anc_tipo) if filtro(t)]
        tr = [anc_lab[j] for j in sel]; pr = [loao_pred[j] for j in sel]
        ok = sum(t == p for t, p in zip(tr, pr))
        val[nome] = {"acertos": ok, "n": len(sel), "acuracia": round(ok / len(sel), 4) if sel else None,
                     "por_destino": {d: {"acertos": x, "n": n} for d, (x, n) in accuracy_by_class(tr, pr).items()},
                     "confusao": confusion(tr, pr)}
    # acurácia por faixa de margem (calibra os limiares de confiança)
    faixas_margem = []
    for lo, hi in [(0.0, 0.15), (0.15, 0.3), (0.3, 0.45), (0.45, 0.6), (0.6, 0.8), (0.8, 1.01)]:
        sel = [j for j, r in enumerate(loao) if lo <= r[2] < hi and anc_tipo[j] == "ancora"]
        ok = sum(anc_lab[j] == loao_pred[j] for j in sel)
        faixas_margem.append({"margem": f"[{lo:.2f}, {min(hi, 1.0):.2f})", "n": len(sel),
                              "acuracia": round(ok / len(sel), 4) if sel else None})
    aprov = [j for j, t in enumerate(anc_tipo) if t == "ancora"]
    t_alta, t_media = calibrate_thresholds([loao[j][2] for j in aprov],
                                           [anc_lab[j] == loao_pred[j] for j in aprov])

    def acc_aprov(pred: list[str], sel: list[int] | None = None) -> dict:
        sel = aprov if sel is None else sel
        pc = accuracy_by_class([anc_lab[j] for j in sel], [pred[j] for j in sel])
        ok = sum(x for x, _ in pc.values()); n = sum(n for _, n in pc.values())
        return {"acuracia": round(ok / n, 4), "balanceada": round(float(np.mean([x / n_ for x, n_ in pc.values()])), 4),
                "por_destino": {d: f"{x}/{n_}" for d, (x, n_) in pc.items()}}

    # sensibilidade a k (diagnóstico; o k usado é o de --k)
    sens_k = {kk: acc_aprov([r[0] for r in leave_one_group_out(A, anc_lab, anc_grp, kk)])["acuracia"]
              for kk in (3, 5, 7, 11, 15)}
    # variantes registradas (mesma divisão leave-one-artist-out, avaliadas nas aprovadas do funk)
    A_cru = X_cru[anc_idx]
    so_funk = [j for j, l in enumerate(anc_lab) if anc_tipo[j] == "ancora" and l in (FUNK, "Eletrofunk", "Mega Funk")]
    sub = lambda xs: [xs[j] for j in so_funk]
    pred_sub = [r[0] for r in leave_one_group_out(A[so_funk], sub(anc_lab), sub(anc_grp), a.k)]
    pred_sub_b = [r[0] for r in leave_one_group_out(A[so_funk], sub(anc_lab), sub(anc_grp), a.k, balanced=True)]
    full = [None] * len(anc_lab); full_b = [None] * len(anc_lab)
    for jj, j in enumerate(so_funk):
        full[j] = pred_sub[jj]; full_b[j] = pred_sub_b[jj]
    variantes = {
        f"knn{a.k}_centrado_com_externas (método usado)": acc_aprov(loao_pred),
        f"knn{a.k}_cru_com_externas": acc_aprov([r[0] for r in leave_one_group_out(A_cru, anc_lab, anc_grp, a.k)]),
        f"knn{a.k}_balanceado_com_externas": acc_aprov([r[0] for r in leave_one_group_out(A, anc_lab, anc_grp, a.k, balanced=True)]),
        "centroide_com_externas": acc_aprov(centroid_loao(A, anc_lab, anc_grp)),
        f"knn{a.k}_so_subgeneros_do_funk": acc_aprov(full, so_funk),
        f"knn{a.k}_balanceado_so_subgeneros_do_funk": acc_aprov(full_b, so_funk),
    }
    # Sanidade do vetor: separa as playlists grandes do acervo entre si (mesmo protocolo)?
    grandes = [i for i, f in enumerate(faixas) if f[1].split("/")[4] not in ("Ambient", "Blues", "Country & Folk", "Clássica")]
    gl = [faixas[i][1].split("/")[4] for i in grandes]
    gg = [norm_key("/".join(faixas[i][1].split("/")[4:6])) for i in grandes]
    gp = [r[0] for r in leave_one_group_out(X[grandes], gl, gg, a.k)]
    sanidade = {d: f"{x}/{n}" for d, (x, n) in sorted(accuracy_by_class(gl, gp).items(), key=lambda kv: -kv[1][1])}

    # ---- classificação das não-âncoras do funk
    q_idx = [i for i in funk_idx if i not in anc_set]
    q_res = classify(X[q_idx], A, anc_lab, a.k) if q_idx else []
    res_por_faixa: dict[int, tuple[str, float, dict[str, float]]] = {}
    for i, (b, _s, m, sh) in zip(q_idx, q_res):
        res_por_faixa[i] = (b, m, sh)
    loao_por_faixa = {}
    for j, i in enumerate(anc_idx):
        if i in row_of:
            b, _s, m, sh = loao[j]
            loao_por_faixa[i] = (b, m, sh)

    # ---- Techfunk: a classe se sustenta?
    tf = [j for j, t in enumerate(anc_tipo) if t == "ancora_provisoria"]
    techfunk = {}
    if tf:
        def mean_sim(js, mask):
            S = A[js] @ A[mask].T if np.any(mask) else np.zeros((len(js), 0))
            return float(S.mean()) if S.size else None
        lab_arr = np.array(anc_lab, dtype=object); grp_arr = np.array(anc_grp, dtype=object)
        tf_grps = sorted({anc_grp[j] for j in tf})
        intra_outro_artista = []
        for j in tf:
            m = (lab_arr == TECHFUNK) & (grp_arr != anc_grp[j])
            if np.any(m):
                intra_outro_artista.append(float((A[j] @ A[m].T).mean()))
        techfunk = {
            "artistas": tf_grps, "n_faixas": len(tf),
            "sim_media_techfunk_outro_artista": round(float(np.mean(intra_outro_artista)), 4) if intra_outro_artista else None,
            "sim_media_por_destino": {d: round(mean_sim(tf, lab_arr == d), 4) for d in sorted(set(anc_lab)) if d != TECHFUNK},
            "loao_pred": dict(Counter(loao_pred[j] for j in tf)),
        }
        # Referência acústica de "techno/trance de fato": a playlist Trance (não é destino).
        tr_idx = [i for i, f in enumerate(faixas) if f[1].split("/")[4] == "Trance"]
        if tr_idx:
            techfunk["sim_media_trance_ref"] = round(float((A[tf] @ X[tr_idx].T).mean()), 4)
            fb = [j for j, l in enumerate(anc_lab) if l == FUNK]
            techfunk["sim_media_funk_aprovado_vs_trance_ref"] = round(float((A[fb] @ X[tr_idx].T).mean()), 4)
        # vizinhança de cada faixa provisória (fora do próprio artista)
        viz = []
        for j in tf:
            s = A @ A[j]
            s = np.where(grp_arr == anc_grp[j], -np.inf, s)
            top = np.argsort(-s)[: a.k]
            viz.append({"faixa": faixas[anc_idx[j]][1][len(SRC):],
                        "vizinhos": dict(Counter(anc_lab[t] for t in top))})
        techfunk["vizinhanca"] = viz

    # ---- agregação por linha da proposta (+ diretórios sem linha)
    por_linha: dict[int | None, list[int]] = defaultdict(list)
    for i in funk_idx:
        por_linha[row_of[i]].append(i)
    out_rows, divergencias, divididos, extras = [], [], [], []

    def track_res(i):
        return res_por_faixa.get(i) or loao_por_faixa.get(i)

    for r, row in enumerate(rows):
        idxs = por_linha.get(r, [])
        base = {"artist_dir": row["artist_dir"], "album_dir": row.get("album_dir"),
                "canonical_artist": row.get("canonical_artist"),
                "proposta_dest": row["dest"], "proposta_confidence": row["confidence"]}
        if not idxs:
            out_rows.append({**base, "dest": row["dest"], "confidence": "baixa", "mert_dest": None,
                             "margin": None, "n_tracks": 0, "split": {}, "papel": "sem_faixas"})
            continue
        ag = aggregate([track_res(i) for i in idxs])
        is_anchor = all(i in anc_set for i in idxs)
        tipo = anc_tipo[anc_idx.index(idxs[0])] if is_anchor else "classificada"
        if tipo == "ancora":
            dest, conf = row["dest"], "alta"  # aprovada pelo CEO; mert_dest é só conferência
        elif tipo == "ancora_provisoria":
            dest, conf = ag["dest"], "baixa"  # classe não validada: decisão do CEO
        else:
            dest, conf = ag["dest"], confidence_of(ag["margin"], t_alta, t_media)
        rec = {**base, "dest": dest, "confidence": conf, "mert_dest": ag["dest"],
               "margin": ag["margin"], "n_tracks": ag["n_tracks"], "split": ag["split"], "papel": tipo}
        out_rows.append(rec)
        if ag["dest"] != row["dest"]:
            divergencias.append(rec)
        if ag["dividido"]:
            # faixas que votaram fora do destino do diretório
            fora = []
            for i in idxs:
                b, m, _ = track_res(i)
                if b != ag["dest"]:
                    fora.append({"faixa": faixas[i][1][len(SRC):], "mert_dest": b, "margin": round(m, 3)})
            divididos.append({**rec, "faixas_fora": fora})
        # álbum que diverge do resto do artista (só linhas "todos" classificadas)
        if tipo == "classificada" and not row.get("album_dir"):
            por_album: dict[str, list[int]] = defaultdict(list)
            for i in idxs:
                alb = rel_dirs(faixas[i][1])[1]
                if alb:
                    por_album[alb].append(i)
            if len(por_album) > 1:
                for alb, ii in sorted(por_album.items()):
                    aga = aggregate([track_res(i) for i in ii])
                    if aga["dest"] != ag["dest"] and confidence_of(aga["margin"], t_alta, t_media) != "baixa":
                        extras.append({"artist_dir": row["artist_dir"], "album_dir": alb,
                                       "canonical_artist": row.get("canonical_artist"),
                                       "proposta_dest": row["dest"], "proposta_confidence": row["confidence"],
                                       "dest": aga["dest"], "confidence": confidence_of(aga["margin"], t_alta, t_media),
                                       "mert_dest": aga["dest"], "margin": aga["margin"],
                                       "n_tracks": aga["n_tracks"], "split": aga["split"],
                                       "papel": "album_divergente"})

    sem_linha = defaultdict(list)
    for i in por_linha.get(None, []):
        sem_linha[rel_dirs(faixas[i][1])[0]].append(i)
    for artist_dir, idxs in sorted(sem_linha.items()):
        ag = aggregate([track_res(i) for i in idxs])
        extras.append({"artist_dir": artist_dir, "album_dir": None, "canonical_artist": artist_dir,
                       "proposta_dest": None, "proposta_confidence": None, "dest": ag["dest"],
                       "confidence": confidence_of(ag["margin"], t_alta, t_media), "mert_dest": ag["dest"],
                       "margin": ag["margin"], "n_tracks": ag["n_tracks"], "split": ag["split"],
                       "papel": "sem_linha_na_proposta"})

    final = out_rows + extras
    json.dump(final, open(a.out, "w"), ensure_ascii=False, indent=1)

    cont_mert = Counter(); cont_prop = Counter()
    for i in funk_idx:
        r = row_of[i]
        cont_prop[rows[r]["dest"] if r is not None else "(sem linha)"] += 1
    # contagem final por faixa: dest efetivo (linha de álbum vence a do artista)
    alvo = assign_rows(final, [faixas[i][1] for i in funk_idx])
    for i, r in zip(funk_idx, alvo):
        cont_mert[final[r]["dest"] if r is not None else "(sem linha)"] += 1

    rep = {"k": a.k, "centrado": not a.no_center, "n_faixas_funk": len(funk_idx),
           "n_ancoras": Counter(anc_tipo), "ancoras_por_destino": Counter(anc_lab),
           "n_classificadas": len(q_idx), "sem_vetor_mert": sem_vetor,
           "validacao_loao": val, "acuracia_por_margem_funk_aprovadas": faixas_margem,
           "sensibilidade_k_funk_aprovadas": sens_k, "limiares_confianca": {"alta": t_alta, "media": t_media},
           "variantes_loao_funk_aprovadas": variantes, "sanidade_playlists_do_acervo": sanidade, "techfunk": techfunk,
           "contagem_faixas": {"mert": dict(cont_mert), "proposta": dict(cont_prop)},
           "divergencias": divergencias, "divididos": divididos, "extras": extras,
           "faixas_classificadas": [{"faixa": faixas[i][1][len(SRC):], "mert_dest": res_por_faixa[i][0],
                                     "margin": round(res_por_faixa[i][1], 3)} for i in q_idx]}
    if a.report:
        json.dump(rep, open(a.report, "w"), ensure_ascii=False, indent=1, default=str)

    print(f"faixas no funk: {len(funk_idx)} | âncoras: {dict(Counter(anc_tipo))} | classificadas: {len(q_idx)}")
    print(f"sem vetor mert: {len(sem_vetor)}")
    for nome, v in val.items():
        print(f"LOAO {nome}: {v['acertos']}/{v['n']} = {v['acuracia']}")
    print(f"sensibilidade k (funk aprovadas): {sens_k}")
    print(f"limiares de confiança calibrados: alta={t_alta} media={t_media}")
    for nome, v in variantes.items():
        print(f"  variante {nome}: {v}")
    print(f"sanidade (playlists do acervo, LOAO): {sanidade}")
    print("contagem por destino (faixas)  MERT | proposta")
    for d in sorted(set(cont_mert) | set(cont_prop)):
        print(f"  {d}: {cont_mert.get(d, 0)} | {cont_prop.get(d, 0)}")
    print(f"divergências: {len(divergencias)} | divididos: {len(divididos)} | linhas extras: {len(extras)}")


if __name__ == "__main__":
    main()
