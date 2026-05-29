# Migração Lyrics Embedding TEI→cogmem + Embedding das Músicas Novas

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrar todo o embedding de lyrics do TEI morto (porta 8080) para o daemon cogmem (`/api/embed`, porta 3939), consertar a busca semântica quebrada no app, e popular os embeddings (MERT + lyrics) das ~30 músicas novas baixadas via Soulseek.

**Architecture:** O embedding de lyrics tem duas vias independentes que ambas apontam pro TEI morto: (1) o app Rust (`LyricsEmbedClient` em `lib_semantic_search`) e (2) o script standalone `scripts/embed_lyrics.py`. Ambos passam a usar o cogmem, que serve BGE-M3 ONNX 1024d via `/api/embed`. O MERT (768d, serviço `rustify-embed` em Docker na VM:8448) está intacto e funcionando — o embedding das músicas novas acontece automaticamente quando o app escaneia a biblioteca; nenhuma mudança de código MERT é necessária.

**Tech Stack:** Rust (Tauri 2.x, crate `library-indexer`, `ureq` HTTP client, `serde`), Python 3.13 (script de embedding), cogmem daemon (Rust ONNX, HTTP axum :3939), Qdrant (named vectors `mert` 768d + `lyrics` 1024d na collection `rustify_tracks`).

---

## Estado verificado (29/05/2026)

Levantado nesta sessão, não presumir — re-verificar se a execução for em outra data:

| Componente | Status | Evidência |
|---|---|---|
| MERT `rustify-embed` VM:8448 | VIVO | `curl :8448/health` → `{"model":"mert-v1-95m","status":"ok"}`; embed real 768d OK |
| TEI BGE :8080 | MORTO | porta não escuta; decomissionado 17/05 |
| cogmem `/api/embed` VM:3939 | VIVO | `curl :3939/api/health` → `{"dim":1024,"models":["bge-m3","qwen3"],"status":"ok"}` |
| App `LyricsEmbedClient` lib.rs:257 | QUEBRADO | hardcoded `http://100.123.73.128:8080` |
| `scripts/embed_lyrics.py` | QUEBRADO | default `--tei-url http://localhost:8080` |
| Qdrant cmr-auto :6333 | SIDECAR | só UP quando o app Tauri está aberto |
| Download Soulseek | 30/52 enqueued | 22 falhas = rap BR sem FLAC na rede (aceito, "só FLAC sempre") |

**Contrato do cogmem `/api/embed`:**
- Request: `POST http://100.123.73.128:3939/api/embed`, body `{"inputs": ["texto1", "texto2"]}` (array de strings, suporta batch)
- Response: `{"dim": 1024, "embeddings": [[...1024 floats...], ...], "model": "bge-m3"}`
- Param opcional `"model": "bge-m3"` (default já é bge-m3; passar explícito por robustez)
- Health: `GET /api/health`

**Endereços por máquina:**
- App Rust roda na cmr-auto → cogmem em `http://100.123.73.128:3939` (Tailscale)
- `embed_lyrics.py` roda na cmr-auto → cogmem em `http://100.123.73.128:3939`
- Qdrant sempre `http://localhost:6333` (sidecar local do app na cmr-auto)
- library.db: `~/.local/share/rustify-player/library.db` na cmr-auto

---

## File Structure

| Arquivo | Responsabilidade | Mudança |
|---|---|---|
| `src-tauri/crates/library-indexer/src/embed_client.rs` | Client HTTP do embedding de lyrics | Reescrever corpo de `embed_text` + `is_healthy` do `LyricsEmbedClient` para o protocolo cogmem. Assinaturas NÃO mudam. |
| `src-tauri/src/lib.rs:257` | Construção do client em `lib_semantic_search` | Trocar URL `:8080` → `:3939` |
| `src-tauri/crates/library-indexer/tests/lyrics_embed.rs` | Teste de integração do client | Criar (novo) |
| `scripts/embed_lyrics.py` | Script standalone de embedding de lyrics | Trocar protocolo TEI → cogmem |

**Nota de escopo:** a assinatura `embed_text(&self, text: &str) -> Result<Vec<f32>, IndexerError>` permanece idêntica. Único consumidor é `lib_semantic_search`. Nenhum outro call site. `is_healthy` do `LyricsEmbedClient` não é chamado em produção (os `is_healthy` em lib.rs:385/2227 são do `QdrantClient`), mas será migrado por consistência.

---

## Task 1: Migrar `LyricsEmbedClient` para o protocolo cogmem

**Files:**
- Modify: `src-tauri/crates/library-indexer/src/embed_client.rs:163-205`

- [ ] **Step 1: Ler o estado atual do bloco a substituir**

Run: `sed -n '163,205p' src-tauri/crates/library-indexer/src/embed_client.rs`
Expected: ver a doc comment "Client for TEI...", a struct `LyricsEmbedClient`, e os métodos `new`, `embed_text`, `is_healthy` com o protocolo TEI.

- [ ] **Step 2: Substituir o bloco inteiro (linha 163 até o fim de `is_healthy`)**

Substituir de `/// Client for TEI (Text Embeddings Inference) running BGE-M3.` até o `}` que fecha o `impl LyricsEmbedClient` (linha ~205) por:

```rust
/// Client for the cogmem embedding daemon running BGE-M3 (ONNX, 1024d).
/// Embeds lyrics text into 1024d dense vectors for semantic search.
///
/// Replaces the decommissioned TEI service (was port 8080). cogmem serves
/// the same BGE-M3 family (CLS pooling, L2-normalized) via /api/embed.
#[derive(Clone, Debug)]
pub struct LyricsEmbedClient {
    agent: ureq::Agent,
    base_url: String,
}

/// cogmem /api/embed response envelope: {"dim":1024,"embeddings":[[..]],"model":".."}
#[derive(Deserialize)]
struct CogmemEmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

impl LyricsEmbedClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout_read(Duration::from_secs(30))
            .build();
        Self {
            agent,
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    pub fn embed_text(&self, text: &str) -> Result<Vec<f32>, IndexerError> {
        // cogmem expects inputs as an array of strings; we send one.
        // Cap at 8000 chars to match the previous TEI truncation behavior.
        let truncated: String = text.chars().take(8000).collect();
        let body = serde_json::json!({
            "inputs": [truncated],
            "model": "bge-m3"
        });
        let resp: CogmemEmbedResponse = self
            .agent
            .post(&format!("{}/api/embed", self.base_url))
            .send_json(&body)
            .map_err(|e| IndexerError::Embedding(format!("cogmem embed: {e}")))?
            .into_json()
            .map_err(|e| IndexerError::Embedding(format!("cogmem json: {e}")))?;

        resp.embeddings
            .into_iter()
            .next()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| IndexerError::Embedding("cogmem returned empty vector".into()))
    }

    pub fn is_healthy(&self) -> bool {
        self.agent
            .get(&format!("{}/api/health", self.base_url))
            .call()
            .is_ok()
    }
}
```

- [ ] **Step 3: Validar sintaxe**

Run: `cargo check --manifest-path src-tauri/Cargo.toml -p library-indexer 2>&1 | tail -20`
Expected: compila sem erros. `CogmemEmbedResponse` usa `Deserialize` já importado em embed_client.rs:15.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/crates/library-indexer/src/embed_client.rs
git commit -m "refactor(lyrics): migrate LyricsEmbedClient from dead TEI to cogmem /api/embed"
```

---

## Task 2: Atualizar URL do client em `lib_semantic_search`

**Files:**
- Modify: `src-tauri/src/lib.rs:257`

- [ ] **Step 1: Confirmar a linha exata**

Run: `sed -n '256,259p' src-tauri/src/lib.rs`
Expected:
```rust
    let client = lib.handle.client();
    let tei = library_indexer::LyricsEmbedClient::new("http://100.123.73.128:8080");
    let vector = tei.embed_text(&query).map_err(err)?;
```

- [ ] **Step 2: Substituir a linha 257**

Trocar:
```rust
    let tei = library_indexer::LyricsEmbedClient::new("http://100.123.73.128:8080");
    let vector = tei.embed_text(&query).map_err(err)?;
```
Por:
```rust
    let embedder = library_indexer::LyricsEmbedClient::new("http://100.123.73.128:3939");
    let vector = embedder.embed_text(&query).map_err(err)?;
```

(Renomeia `tei` → `embedder` pra não deixar referência ao serviço morto no nome da variável.)

- [ ] **Step 3: Validar sintaxe**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: compila sem erros, sem warning de variável não usada.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix(search): point lib_semantic_search at cogmem instead of dead TEI"
```

---

## Task 3: Teste de integração do client (TDD, condicional)

**Files:**
- Create: `src-tauri/crates/library-indexer/tests/lyrics_embed.rs`

Segue o padrão de `tests/qdrant_client.rs:12` (skip se o serviço não estiver disponível, pra não quebrar CI offline).

- [ ] **Step 1: Escrever o teste**

```rust
use library_indexer::LyricsEmbedClient;

const COGMEM_URL: &str = "http://100.123.73.128:3939";

#[test]
fn lyrics_embed_returns_1024d_vector() {
    let client = LyricsEmbedClient::new(COGMEM_URL);
    if !client.is_healthy() {
        eprintln!("cogmem not reachable at {COGMEM_URL}, skipping");
        return;
    }
    let vec = client
        .embed_text("a melodia triste da saudade no fim da tarde")
        .expect("embed should succeed");
    assert_eq!(vec.len(), 1024, "BGE-M3 dense dimensionality");

    // BGE-M3 output is L2-normalized → norm ~= 1.0
    let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!(
        (norm - 1.0).abs() < 0.05,
        "expected L2-normalized vector, got norm={norm}"
    );
}
```

- [ ] **Step 2: Rodar o teste**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p library-indexer --test lyrics_embed -- --nocapture`
Expected: PASS se cogmem acessível da máquina de build (VM tem acesso direto; cmr-auto via Tailscale). Se rodar na VM, `100.123.73.128:3939` é a própria VM — OK.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/library-indexer/tests/lyrics_embed.rs
git commit -m "test(lyrics): integration test for cogmem embed client"
```

---

## Task 4: Build e release

**Files:** nenhum (build).

- [ ] **Step 1: cargo check final (workspace inteiro)**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: limpo, sem erros nem warnings novos.

- [ ] **Step 2: Rodar release**

Run: `./scripts/release.sh`
Expected: build release + geração do `.deb` + publicação no GitHub release. Anotar a versão publicada (ex: `0.2.x`).

- [ ] **Step 3: Confirmar o asset publicado**

Run: `gh release view -R PedroGiudice/rustify-player --json assets -q '.assets[].name'`
Expected: lista contém `rustify-player_<versao>_amd64.deb`.

---

## Task 5: Deploy na cmr-auto + MERT scan automático

**Files:** nenhum (operação na cmr-auto). Comandos rodados PELO USUÁRIO na cmr-auto (ou via SSH `cmr-auto@100.102.249.9`).

- [ ] **Step 1: Baixar e instalar o .deb na cmr-auto**

```bash
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_*_amd64.deb
```
Expected: instala sem erro de dependência.

- [ ] **Step 2: Abrir o app**

O usuário abre o Rustify Player na cmr-auto. Ao abrir:
- O Qdrant sidecar sobe (porta 6333 fica disponível)
- O library-indexer escaneia `~/Music`, detecta os FLACs novos baixados via Soulseek
- Pra cada track nova sem embedding "done": decodifica → envia waveform zstd pro `rustify-embed` (VM:8448) → recebe vetor MERT 768d → upsert no Qdrant como named vector `mert`

- [ ] **Step 3: Verificar que o MERT das novas foi populado**

Após o scan terminar (acompanhar logs do app ou esperar ~1-2 min), rodar da VM:
```bash
curl -sS http://100.102.249.9:6333/collections/rustify_tracks | python3 -c "import json,sys; d=json.load(sys.stdin); print('points:', d['result']['points_count'])"
```
Expected: `points_count` maior que o baseline anterior (1096) pelo número de tracks novas indexadas.

Verificar cobertura MERT via scroll:
```bash
curl -sS -X POST http://100.102.249.9:6333/collections/rustify_tracks/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit":2000,"with_payload":false,"with_vector":["mert"]}' | \
  python3 -c "import json,sys; d=json.load(sys.stdin); pts=d['result']['points']; m=sum(1 for p in pts if isinstance(p.get('vector'),dict) and p['vector'].get('mert')); print(f'{m}/{len(pts)} com MERT')"
```
Expected: cobertura MERT próxima de 100% das tracks (as novas incluídas).

---

## Task 6: Migrar `scripts/embed_lyrics.py` para cogmem

**Files:**
- Modify: `scripts/embed_lyrics.py`

- [ ] **Step 1: Substituir a função `embed_text` (linhas 79-89)**

Trocar:
```python
def embed_text(tei_url: str, text: str) -> list[float]:
    text = text[:8000]
    payload = json.dumps({"inputs": text, "truncate": True}).encode()
    req = urllib.request.Request(
        f"{tei_url}/embed",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    return result[0]
```
Por:
```python
def embed_text(cogmem_url: str, text: str) -> list[float]:
    text = text[:8000]
    payload = json.dumps({"inputs": [text], "model": "bge-m3"}).encode()
    req = urllib.request.Request(
        f"{cogmem_url}/api/embed",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    return result["embeddings"][0]
```

- [ ] **Step 2: Atualizar o arg `--tei-url` para `--cogmem-url` (linhas 108 e 4-7 docstring)**

Na função `main`, trocar:
```python
    parser.add_argument("--tei-url", default="http://localhost:8080")
```
Por:
```python
    parser.add_argument("--cogmem-url", default="http://100.123.73.128:3939")
```

E atualizar a chamada (linha 129) de `embed_text(args.tei_url, lyrics)` para `embed_text(args.cogmem_url, lyrics)`.

Atualizar a docstring do topo (linhas 1-8) trocando `--tei-url http://localhost:8080` por `--cogmem-url http://100.123.73.128:3939` e "via TEI BGE-M3" por "via cogmem BGE-M3".

- [ ] **Step 3: Smoke test local (sem upsert) — confirmar o embed**

Run (na VM, onde cogmem é local):
```bash
python3 -c "
import sys; sys.argv=['x']
import importlib.util
spec = importlib.util.spec_from_file_location('el', 'scripts/embed_lyrics.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
v = m.embed_text('http://localhost:3939', 'teste de letra triste')
print('dim:', len(v), '| norm ~', round(sum(x*x for x in v)**0.5, 3))
"
```
Expected: `dim: 1024 | norm ~ 1.0`

- [ ] **Step 4: Commit**

```bash
git add scripts/embed_lyrics.py
git commit -m "refactor(lyrics): migrate embed_lyrics.py from dead TEI to cogmem"
```

---

## Task 7: Re-embeddar todas as lyrics via cogmem

**Files:** nenhum (operação na cmr-auto, com app aberto pra Qdrant estar UP).

**Pré-requisito:** Task 5 concluída (app aberto, Qdrant :6333 UP na cmr-auto). O script precisa rodar na cmr-auto (onde estão library.db e os LRCs). cogmem acessível via `http://100.123.73.128:3939`.

- [ ] **Step 1: Transferir o script atualizado pra cmr-auto**

Run (da VM):
```bash
scp scripts/embed_lyrics.py cmr-auto@100.102.249.9:/home/cmr-auto/embed_lyrics.py
```

- [ ] **Step 2: Rodar com --force (re-embeda TODAS as lyrics)**

Justificativa do `--force`: a migração TEI→ONNX troca a fonte do embedding. Re-embeddar tudo garante que os ~430 lyrics existentes e os novos fiquem no mesmo espaço vetorial (sem drift entre TEI mean-pool e cogmem CLS-pool). É barato (~430 textos, cogmem embeda rápido).

Run (na cmr-auto, app aberto):
```bash
python3 /home/cmr-auto/embed_lyrics.py \
  --db ~/.local/share/rustify-player/library.db \
  --cogmem-url http://100.123.73.128:3939 \
  --qdrant-url http://localhost:6333 \
  --force
```
Expected: `Tracks with lyrics: N` (N ~430+), depois upserts em batches de 50, terminando com `Done. Embedded N lyrics, skipped 0.`

- [ ] **Step 3: Verificar cobertura lyrics no Qdrant**

Run (da VM):
```bash
curl -sS -X POST http://100.102.249.9:6333/collections/rustify_tracks/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit":2000,"with_payload":false,"with_vector":["lyrics"]}' | \
  python3 -c "import json,sys; d=json.load(sys.stdin); pts=d['result']['points']; l=sum(1 for p in pts if isinstance(p.get('vector'),dict) and p['vector'].get('lyrics')); print(f'{l}/{len(pts)} com lyrics')"
```
Expected: contagem de lyrics igual ao N reportado pelo script.

---

## Task 8: Verificar lyrics nas músicas novas + busca semântica end-to-end

**Files:** nenhum (verificação).

- [ ] **Step 1: Checar se algum download do Soulseek trouxe LRC ou embedded lyrics**

As tracks novas vieram do Soulseek (só FLAC). Lyrics normalmente vêm do pipeline de scraping/alignment, não do Soulseek. Confirmar empiricamente — rodar na cmr-auto:
```bash
python3 -c "
import sqlite3
c = sqlite3.connect('/home/cmr-auto/.local/share/rustify-player/library.db')
c.execute('PRAGMA query_only=ON')
rows = c.execute('SELECT id, title, lrc_path, length(embedded_lyrics) FROM tracks ORDER BY indexed_at DESC LIMIT 40').fetchall()
for r in rows:
    has_lrc = bool(r[2]); has_emb = bool(r[3] and r[3] > 20)
    if has_lrc or has_emb:
        print(f'  id={r[0]} {r[1][:40]:40s} lrc={has_lrc} emb={has_emb}')
print('(tracks novas com lyrics listadas acima; vazio = nenhuma trouxe lyrics)')
"
```
Expected: a maioria das 30 novas SEM lyrics (esperado — Soulseek não traz LRC). As que tiverem já foram cobertas pelo `--force` da Task 7.

- [ ] **Step 2: Testar a busca semântica no app (end-to-end, valida o fix do Rust)**

No app aberto na cmr-auto, usar a feature de busca semântica (lyrics) com uma query em linguagem natural (ex: "música sobre superação e luta"). Confirmar que retorna resultados — antes do fix isso falhava silenciosamente (TEI morto → erro).

Alternativa via IPC/log: confirmar que `lib_semantic_search` não loga erro de conexão.

Expected: resultados retornados, sem erro de embedding.

- [ ] **Step 3: Documentar o estado final**

Atualizar (se ainda apontar pro TEI) qualquer doc que mencione o pipeline de lyrics embedding. Verificar:
```bash
grep -rn "8080\|TEI\|tei-url" CLAUDE.md docs/ scripts/ --include="*.md" --include="*.py" 2>/dev/null | grep -iv "cogmem"
```
Expected: nenhuma referência ativa ao TEI 8080 sobrando (fora de docs históricos de planos).

---

## Self-Review

**Spec coverage:**
- Migrar lyrics embed TEI→cogmem (app Rust): Task 1, 2, 3 ✓
- Consertar busca semântica quebrada: Task 2 + validação Task 8.2 ✓
- Embeddar MERT das músicas novas: Task 5 (scan automático) ✓
- Migrar script de lyrics: Task 6 ✓
- Re-embeddar lyrics consistente: Task 7 ✓
- Verificar quais novas têm lyrics: Task 8.1 ✓

**Notas de risco:**
- O `--force` da Task 7 re-embeda tudo; se preferir incremental (só novas), omitir `--force` — mas aí TEI-era e cogmem-era coexistem no Qdrant (drift potencial). Recomendado: `--force`.
- Qdrant é sidecar: Tasks 5.3, 7, 8 exigem o app aberto na cmr-auto. Se rodar com app fechado, `localhost:6333` recusa conexão.
- Kendrick "N95" e as 22 tracks BR sem FLAC ficam fora do escopo deste plano (decisão "só FLAC sempre"). N95 merece investigação de query à parte — não bloqueia este plano.

**Type consistency:** `embed_text(&str) -> Result<Vec<f32>, IndexerError>` mantém assinatura em todas as tasks. `CogmemEmbedResponse.embeddings: Vec<Vec<f32>>` consistente com o parsing. Python `embed_text(url, text) -> list[float]` retorna `result["embeddings"][0]` consistente com o contrato cogmem.
