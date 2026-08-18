// Inteligência local do mobile (CMR-190) — consome os artefatos exportados
// pelo desktop (scripts/android/export_manifest.py) em `<MUSIC_ROOT>/.rustify/`:
//
//   vectors.bin    mert 768d f32 L2-normalizados (dot == cosine)
//   taste.json     snapshot de gosto (positives/negatives com pesos)
//   stations.json  stations do desktop + pool precomputado por station
//
// Decisão CMR-190 (14/08/2026): brute-force em Rust puro, sem Qdrant Edge —
// 1746×768d ≈ 5,4MB, top-K em microssegundos. Derivação pesada fica no
// desktop; aqui só leitura + ranking. Tudo função pura testável no host.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ─────────────────────────────────────────────────────────────────────────────
// vectors.bin
// ─────────────────────────────────────────────────────────────────────────────

const VEC_MAGIC: &[u8; 8] = b"RSTFVEC1";

pub struct VectorIndex {
    dim: usize,
    ids: Vec<u64>,
    /// matriz row-major `ids.len() × dim`, alinhada com `ids`.
    data: Vec<f32>,
    row_of: HashMap<u64, usize>,
}

impl VectorIndex {
    /// Parse do formato do export: magic + u32 dim + u32 count +
    /// count × (u64 id LE + dim × f32 LE). Erro em qualquer truncamento.
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 16 || &bytes[..8] != VEC_MAGIC {
            return Err("vectors.bin: magic inválido".into());
        }
        let dim = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let count = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        let rec = 8 + dim * 4;
        let expected = 16 + count * rec;
        if dim == 0 || bytes.len() < expected {
            return Err(format!(
                "vectors.bin: truncado ({} bytes, esperado {expected})",
                bytes.len()
            ));
        }
        let mut ids = Vec::with_capacity(count);
        let mut data = Vec::with_capacity(count * dim);
        let mut row_of = HashMap::with_capacity(count);
        for i in 0..count {
            let off = 16 + i * rec;
            let id = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());
            row_of.insert(id, ids.len());
            ids.push(id);
            for j in 0..dim {
                let o = off + 8 + j * 4;
                data.push(f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()));
            }
        }
        Ok(Self { dim, ids, data, row_of })
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    fn row(&self, id: u64) -> Option<&[f32]> {
        self.row_of
            .get(&id)
            .map(|&r| &self.data[r * self.dim..(r + 1) * self.dim])
    }

    /// Dot product == cosine (vetores normalizados no export).
    pub fn cos(&self, a: u64, b: u64) -> Option<f32> {
        let (va, vb) = (self.row(a)?, self.row(b)?);
        Some(va.iter().zip(vb).map(|(x, y)| x * y).sum())
    }

    /// Top-K por similaridade à track `id`, excluindo a própria e `exclude`.
    pub fn similar(&self, id: u64, k: usize, exclude: &HashSet<u64>) -> Vec<(u64, f32)> {
        let Some(q) = self.row(id) else { return Vec::new() };
        let mut scored: Vec<(u64, f32)> = self
            .ids
            .iter()
            .enumerate()
            .filter(|(_, &tid)| tid != id && !exclude.contains(&tid))
            .map(|(r, &tid)| {
                let v = &self.data[r * self.dim..(r + 1) * self.dim];
                (tid, q.iter().zip(v).map(|(x, y)| x * y).sum())
            })
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(k);
        scored
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// taste.json
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TasteEntry {
    track_id: String,
    #[allow(dead_code)]
    weight: Option<f64>,
}

#[derive(Deserialize)]
struct TasteFile {
    #[serde(default)]
    positives: Vec<TasteEntry>,
    #[serde(default)]
    negatives: Vec<TasteEntry>,
}

#[derive(Clone, Default)]
pub struct Taste {
    pub positives: Vec<u64>,
    pub negatives: Vec<u64>,
}

impl Taste {
    pub fn parse(json: &[u8]) -> Result<Self, String> {
        let f: TasteFile = serde_json::from_slice(json).map_err(|e| e.to_string())?;
        let ids = |v: Vec<TasteEntry>| {
            v.into_iter()
                .filter_map(|e| e.track_id.parse::<u64>().ok())
                .collect()
        };
        Ok(Self { positives: ids(f.positives), negatives: ids(f.negatives) })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// stations.json
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct StationsFile {
    #[serde(default)]
    stations: Vec<StationDef>,
}

#[derive(Deserialize)]
pub struct StationDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub tone: String,
    #[serde(default)]
    pub desc: String,
    pub kind: String,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub seed_track_ids: Vec<String>,
    #[serde(default)]
    pub pool: Vec<String>,
}

/// Metadados que a UI enxerga (pool fica interno; `pool_size` orienta a UI a
/// esconder/desabilitar station vazia).
#[derive(Clone, Serialize)]
pub struct StationMeta {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub tone: String,
    pub desc: String,
    pub kind: String,
    pub query: Option<String>,
    pub pool_size: usize,
}

pub struct Station {
    pub meta: StationMeta,
    pub pool: Vec<u64>,
}

pub fn parse_stations(json: &[u8]) -> Result<Vec<Station>, String> {
    let f: StationsFile = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    Ok(f.stations
        .into_iter()
        .map(|d| {
            let pool: Vec<u64> = d.pool.iter().filter_map(|s| s.parse().ok()).collect();
            Station {
                meta: StationMeta {
                    id: d.id,
                    name: d.name,
                    icon: d.icon,
                    tone: d.tone,
                    desc: d.desc,
                    kind: d.kind,
                    query: d.query,
                    pool_size: pool.len(),
                },
                pool,
            }
        })
        .collect())
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking de pool por gosto
// ─────────────────────────────────────────────────────────────────────────────

/// Re-rank local do pool de uma station: score = max cos com os positives
/// − 0.5 × max cos com os negatives (espírito do best_score do Qdrant que o
/// desktop usa). Negatives do gosto são EXCLUÍDOS (não só penalizados) —
/// no aparelho o pool é pequeno e sugerir skip conhecido é desperdício.
/// Candidato sem vetor cai pro fim preservando a ordem do pool.
///
/// `session_negatives` é o que foi largado cedo NA SESSÃO CORRENTE: o id
/// exato sai do pool (reaparecer logo depois de ser pulado é o pior defeito
/// possível), e a vizinhança dele é penalizada com o mesmo peso do gosto —
/// pular é sinal fresco e específico, mas não é uma sentença sobre o timbre.
pub fn rank_pool(
    pool: &[u64],
    taste: &Taste,
    vectors: Option<&VectorIndex>,
    session_negatives: &[u64],
) -> Vec<u64> {
    let mut neg_set: HashSet<u64> = taste.negatives.iter().copied().collect();
    neg_set.extend(session_negatives.iter().copied());
    let candidates: Vec<u64> = pool.iter().copied().filter(|t| !neg_set.contains(t)).collect();
    let Some(vx) = vectors else { return candidates };
    if taste.positives.is_empty() {
        return candidates;
    }
    let mut scored: Vec<(usize, u64, Option<f32>)> = candidates
        .iter()
        .enumerate()
        .map(|(i, &tid)| {
            let best = |ids: &[u64]| -> Option<f32> {
                ids.iter()
                    .filter_map(|&p| vx.cos(tid, p))
                    .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            };
            let score = best(&taste.positives).map(|pos| {
                pos - 0.5 * best(&taste.negatives).unwrap_or(0.0)
                    - 0.5 * best(session_negatives).unwrap_or(0.0)
            });
            (i, tid, score)
        })
        .collect();
    scored.sort_by(|a, b| match (a.2, b.2) {
        (Some(x), Some(y)) => y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.0.cmp(&b.0),
    });
    scored.into_iter().map(|(_, tid, _)| tid).collect()
}

/// Máximo de faixas do mesmo artista no TOPO de um lote de rádio (espelha o
/// desktop). O excedente não é descartado — desce pro fim da lista.
pub const MAX_PER_ARTIST: usize = 2;
/// Quantos candidatos o pool duplo busca antes dos cortes.
pub const POOL_FETCH: usize = 60;

/// Reordena preservando o rank: os primeiros `max` de cada artista ficam onde
/// estão, o excedente desce pro fim (nunca é descartado — num acervo pequeno,
/// jogar candidato fora é secar o rádio à toa). `None` de artista não conta
/// pro teto: metadado ausente não pode punir a faixa.
pub fn cap_per_artist<F>(ranked: Vec<u64>, artist_of: F, max: usize) -> Vec<u64>
where
    F: Fn(u64) -> Option<String>,
{
    let mut count: HashMap<String, usize> = HashMap::new();
    let mut head = Vec::with_capacity(ranked.len());
    let mut tail = Vec::new();
    for id in ranked {
        match artist_of(id) {
            Some(artist) => {
                let c = count.entry(artist).or_insert(0);
                if *c < max {
                    *c += 1;
                    head.push(id);
                } else {
                    tail.push(id);
                }
            }
            None => head.push(id),
        }
    }
    head.extend(tail);
    head
}

/// Pool duplo do rádio: a vizinhança da SEMENTE unida à vizinhança do GOSTO
/// (os primeiros positives do snapshot, que já vem ordenado por peso). Só a
/// semente produz "mais do mesmo timbre"; só o gosto ignora onde a sessão
/// está. O rank final trata a semente como positivo honorário — afinidade com
/// ela e com o gosto entram na mesma régua — e o [`rank_pool`] já exclui os
/// negatives do gosto e aplica os da sessão.
pub fn autoplay_pool(
    seed: u64,
    taste: &Taste,
    vectors: &VectorIndex,
    exclude: &HashSet<u64>,
    fetch: usize,
    session_negatives: &[u64],
) -> Vec<u64> {
    const TASTE_SEEDS: usize = 6;
    let mut ex = exclude.clone();
    ex.insert(seed);
    let mut pool: Vec<u64> = vectors.similar(seed, fetch, &ex).into_iter().map(|(t, _)| t).collect();
    let mut seen: HashSet<u64> = pool.iter().copied().collect();
    for &p in taste.positives.iter().take(TASTE_SEEDS) {
        for (t, _) in vectors.similar(p, fetch / TASTE_SEEDS, &ex) {
            if seen.insert(t) {
                pool.push(t);
            }
        }
    }
    let mut com_seed = taste.clone();
    com_seed.positives.insert(0, seed);
    rank_pool(&pool, &com_seed, Some(vectors), session_negatives)
}

/// Xorshift* — o mesmo gerador do [`weighted_pick_prefix`], extraído para os
/// dois sorteios compartilharem a fonte de aleatoriedade determinística.
fn rand01_from(seed: u64) -> impl FnMut() -> f64 {
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    move || -> f64 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Embaralhamento UNIFORME (Fisher-Yates). É o certo para os fallbacks do
/// rádio: ali não há ranking a preservar, e o peso geométrico do
/// [`weighted_pick_prefix`] faria pior que nada — r^i vira 0 por underflow
/// depois de ~200 posições, então a cauda de um acervo de 1700 faixas nunca
/// seria sorteada e o "shuffle" tocaria sempre o mesmo começo.
pub fn shuffle<T>(items: &mut [T], seed: u64) {
    if items.len() < 2 {
        return;
    }
    let mut rand01 = rand01_from(seed);
    for i in (1..items.len()).rev() {
        let j = (rand01() * (i + 1) as f64) as usize;
        items.swap(i, j.min(i));
    }
}

/// Sorteio ponderado geométrico sobre os primeiros `prefix` elementos —
/// mesma matemática do desktop (desktop.rs weighted_pick_prefix): amostragem
/// sem reposição com peso r^i (r = 0.7), xorshift* inline. Variedade entre
/// chamadas sem achatar o re-rank.
pub fn weighted_pick_prefix<T>(items: &mut Vec<T>, prefix: usize, seed: u64) {
    const R: f64 = 0.7;
    let n = prefix.min(items.len());
    if n < 2 {
        return;
    }
    let mut rand01 = rand01_from(seed);
    let mut pool: Vec<(usize, f64)> = (0..n).map(|i| (i, R.powi(i as i32))).collect();
    let mut order: Vec<usize> = Vec::with_capacity(n);
    while pool.len() > 1 {
        let total: f64 = pool.iter().map(|(_, w)| w).sum();
        let mut target = rand01() * total;
        let mut chosen = pool.len() - 1;
        for (k, (_, w)) in pool.iter().enumerate() {
            if target < *w {
                chosen = k;
                break;
            }
            target -= *w;
        }
        order.push(pool.remove(chosen).0);
    }
    order.push(pool[0].0);

    let mut head: Vec<Option<T>> = items.drain(..n).map(Some).collect();
    let mut out: Vec<T> = order
        .into_iter()
        .map(|i| head[i].take().expect("indice sorteado unico"))
        .collect();
    out.extend(items.drain(..));
    *items = out;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Monta um vectors.bin sintético com vetores normalizados.
    fn bin(dim: usize, entries: &[(u64, Vec<f32>)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(VEC_MAGIC);
        out.extend_from_slice(&(dim as u32).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (id, vec) in entries {
            out.extend_from_slice(&id.to_le_bytes());
            let norm = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
            for x in vec {
                out.extend_from_slice(&(x / norm).to_le_bytes());
            }
        }
        out
    }

    fn idx() -> VectorIndex {
        // eixos quase-ortogonais: 1↔2 próximos, 3 ortogonal, 4 oposto de 1
        VectorIndex::parse(&bin(3, &[
            (1, vec![1.0, 0.0, 0.0]),
            (2, vec![0.9, 0.1, 0.0]),
            (3, vec![0.0, 0.0, 1.0]),
            (4, vec![-1.0, 0.0, 0.0]),
        ]))
        .unwrap()
    }

    #[test]
    fn parse_rejeita_lixo() {
        assert!(VectorIndex::parse(b"nope").is_err());
        let mut truncado = bin(3, &[(1, vec![1.0, 0.0, 0.0])]);
        truncado.truncate(truncado.len() - 2);
        assert!(VectorIndex::parse(&truncado).is_err());
    }

    #[test]
    fn similar_ordena_por_cosine_e_exclui() {
        let vx = idx();
        let top = vx.similar(1, 3, &HashSet::new());
        assert_eq!(top[0].0, 2); // vizinho mais próximo
        assert_eq!(top.last().unwrap().0, 4); // oposto por último
        // ids > 2^53 sobrevivem intactos (u64, sem JS no caminho)
        let grande = 18_400_000_000_000_000_001_u64;
        let vx2 = VectorIndex::parse(&bin(2, &[
            (grande, vec![1.0, 0.0]),
            (7, vec![1.0, 0.1]),
        ]))
        .unwrap();
        assert_eq!(vx2.similar(7, 1, &HashSet::new())[0].0, grande);
        // exclude respeitado
        let ex: HashSet<u64> = [2].into();
        assert_eq!(vx.similar(1, 1, &ex)[0].0, 3);
    }

    #[test]
    fn taste_parse_ids_string() {
        let t = Taste::parse(
            br#"{"positives":[{"track_id":"18400000000000000001","weight":1.2}],
                 "negatives":[{"track_id":"4","weight":-0.6}]}"#,
        )
        .unwrap();
        assert_eq!(t.positives, vec![18_400_000_000_000_000_001]);
        assert_eq!(t.negatives, vec![4]);
    }

    #[test]
    fn rank_pool_exclui_negatives_e_prioriza_proximos_do_gosto() {
        let vx = idx();
        let taste = Taste { positives: vec![1], negatives: vec![3] };
        // pool na ordem "errada": oposto primeiro, vizinho depois, negative junto
        let ranked = rank_pool(&[4, 3, 2], &taste, Some(&vx), &[]);
        assert_eq!(ranked, vec![2, 4]); // 3 excluído; 2 (cos≈1) antes de 4 (cos=-1)
    }

    #[test]
    fn rank_pool_sem_vetores_preserva_ordem_sem_negatives() {
        let taste = Taste { positives: vec![1], negatives: vec![9] };
        assert_eq!(rank_pool(&[9, 5, 6], &taste, None, &[]), vec![5, 6]);
    }

    #[test]
    fn negativo_de_sessao_rebaixa_a_vizinhanca_sem_exclui_la() {
        // 10 = gosto. 11 e 12 estão IGUALMENTE perto dele (cos 0.6 os dois),
        // mas 11 é vizinho do que acabou de ser pulado (13) e 12 não é. Sem a
        // penalidade, o desempate seria só a ordem do pool.
        let vx = VectorIndex::parse(&bin(3, &[
            (10, vec![1.0, 0.0, 0.0]),
            (11, vec![0.6, 0.8, 0.0]),
            (12, vec![0.6, 0.0, 0.8]),
            (13, vec![0.0, 1.0, 0.0]),
        ]))
        .unwrap();
        let taste = Taste { positives: vec![10], negatives: vec![] };
        assert_eq!(rank_pool(&[11, 12], &taste, Some(&vx), &[]), vec![11, 12]);
        // pulou 13 → 11 cai atrás de 12, mas continua no pool
        assert_eq!(rank_pool(&[11, 12], &taste, Some(&vx), &[13]), vec![12, 11]);
    }

    #[test]
    fn cap_por_artista_empurra_o_excedente_sem_perder_ninguem() {
        // 6 faixas do mesmo artista + 1 de outro no fim do rank
        let artista = |id: u64| Some(if id < 7 { "A".to_string() } else { "B".to_string() });
        let capped = cap_per_artist(vec![1, 2, 3, 4, 5, 6, 7], artista, 2);
        assert_eq!(capped.len(), 7, "ninguém é descartado");
        // topo: 2 do artista A, depois o B (subiu por causa do cap)
        assert_eq!(&capped[..3], &[1, 2, 7]);
        // o excedente desce na ordem original
        assert_eq!(&capped[3..], &[3, 4, 5, 6]);
    }

    #[test]
    fn cap_ignora_faixa_sem_artista() {
        let capped = cap_per_artist(vec![1, 2, 3], |_| None, 1);
        assert_eq!(capped, vec![1, 2, 3]);
    }

    #[test]
    fn autoplay_pool_une_semente_e_gosto_sem_negatives_nem_semente() {
        let vx = idx(); // 1↔2 próximos, 3 ortogonal, 4 oposto de 1
        let taste = Taste { positives: vec![3], negatives: vec![4] };
        let pool = autoplay_pool(1, &taste, &vx, &HashSet::new(), 10, &[]);
        // vizinhança da semente (2) E do gosto (3 é positivo, mas positivo
        // não entra como candidato de si mesmo — a vizinhança dele sim)
        assert!(pool.contains(&2), "vizinho da semente entra");
        assert!(!pool.contains(&1), "a própria semente nunca");
        assert!(!pool.contains(&4), "negative do gosto é excluído");
    }

    #[test]
    fn autoplay_pool_deduplica_mantendo_um_so() {
        let vx = idx();
        // 2 é vizinho da semente 1 E do positive 1 (mesmo id) — não duplica
        let taste = Taste { positives: vec![1], negatives: vec![] };
        let pool = autoplay_pool(1, &taste, &vx, &HashSet::new(), 10, &[]);
        let ocorrencias = pool.iter().filter(|&&t| t == 2).count();
        assert_eq!(ocorrencias, 1);
    }

    #[test]
    fn faixa_pulada_nao_volta_no_lote_seguinte() {
        let vx = idx();
        let taste = Taste { positives: vec![1], negatives: vec![] };
        let ranked = rank_pool(&[2, 3, 4], &taste, Some(&vx), &[2]);
        assert!(!ranked.contains(&2));
    }

    #[test]
    fn weighted_pick_mesma_seed_mesma_ordem() {
        let mut a: Vec<u32> = (0..10).collect();
        let mut b = a.clone();
        weighted_pick_prefix(&mut a, 8, 42);
        weighted_pick_prefix(&mut b, 8, 42);
        assert_eq!(a, b);
        let mut c: Vec<u32> = (0..10).collect();
        weighted_pick_prefix(&mut c, 8, 43);
        // cauda além do prefixo intocada
        assert_eq!(&a[8..], &[8, 9]);
        assert_eq!(&c[8..], &[8, 9]);
    }
}
