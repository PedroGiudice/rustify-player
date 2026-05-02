# Retomada: Integração Ollama para Natural Language Music Selection

## Contexto rápido

Na sessão anterior implementamos 4 features no Rustify Player: (1) implicit feedback via Qdrant play_events collection, (2) fix de EOS no audio engine (GStreamer signal em vez de polling), (3) smart station "Your Mix" com playback infinito, (4) semantic search por lyrics embeddings na search bar.

A semantic search funciona para queries de conteúdo ("música sobre saudade") mas falha para queries de mood/contexto ("músicas pra começar o dia") — o BGE-M3 compara semântica literal entre query e letras, não entende intenção.

O próximo passo é integrar o Ollama (rodando na VM Contabo, porta 11434 no IP 100.123.73.128) para resolver queries de mood/contexto. O design foi discutido e está claro:

**O modelo recebe o catálogo de tracks como contexto e retorna um array JSON de track IDs.** Sem tool calling, sem parsing complexo. O app monta queue e toca.

## Arquivos principais

- `src-tauri/crates/library-indexer/src/qdrant_client.rs` — todos os métodos Qdrant (semantic_search, behavioral_signals, play_events)
- `src-tauri/crates/library-indexer/src/embed_client.rs` — LyricsEmbedClient (TEI BGE-M3)
- `src-tauri/src/lib.rs` — Tauri commands, event loop, estado do app
- `src/js/components/search-bar.js` — frontend da busca (textual + semântica em paralelo)
- `src/js/components/player-bar.js` — queue management, smart station, autoplay
- `docs/contexto/02052026-implicit-feedback-smart-station-semantic-search.md` — contexto detalhado

## Próximos passos (por prioridade)

### 1. Criar OllamaClient no library-indexer
**Onde:** `src-tauri/crates/library-indexer/src/ollama_client.rs` (novo arquivo)
**O que:** HTTP client síncrono (ureq, mesmo padrão do QdrantClient) para Ollama API. Um método: `generate(system_prompt: &str, user_prompt: &str, model: &str) -> Result<String, IndexerError>`. Endpoint: POST `http://100.123.73.128:11434/api/generate` com `{"model": "qwen3:4b-nothink", "prompt": ..., "system": ..., "stream": false}`.
**Por que:** Isola a comunicação com Ollama num módulo dedicado, reutilizável.
**Verificar:** `cargo check --manifest-path src-tauri/Cargo.toml`

### 2. Criar Tauri command lib_ai_search
**Onde:** `src-tauri/src/lib.rs`
**O que:** Novo command que: (a) faz scroll no Qdrant pra pegar catálogo (ID|título|artista|gênero|duração), (b) opcionalmente pré-filtra com embedding match (top 50), (c) monta prompt com catálogo + query do usuário, (d) chama OllamaClient, (e) parseia array JSON de IDs, (f) resolve tracks e retorna Vec<Track>.
**Por que:** Separa a lógica de AI search do semantic search existente.
**Verificar:** `cargo check --manifest-path src-tauri/Cargo.toml`

### 3. Integrar no frontend (search-bar.js)
**Onde:** `src/js/components/search-bar.js`
**O que:** Adicionar terceira busca em paralelo: `invoke("lib_ai_search", { query: q, limit: 10 })`. Mostrar como seção "AI Picks" nos resultados. Latência maior (~3-5s) — mostrar indicador de loading na seção.
**Por que:** O usuário vê resultados textuais e semânticos instantaneamente, e depois de ~3s a seção AI aparece.
**Verificar:** Abrir app, Ctrl+K, digitar "músicas pra começar o dia", verificar que seção "AI Picks" aparece

### 4. Formato do prompt e output
**Onde:** Dentro do Tauri command lib_ai_search
**O que:** System prompt define o modelo como assistente musical. Catálogo formatado como linhas `ID|Título|Artista|Gênero|Duração`. User prompt é a query. Output esperado: `[42, 156, 789]`. Parse com `serde_json::from_str::<Vec<i64>>`.
**Por que:** Formato simples, sem tool calling, parse trivial.
**Verificar:** Testar com queries variadas: mood ("pra relaxar"), gênero ("rock pesado"), atividade ("pra malhar")

## Dados relevantes

- **Ollama endpoint:** `http://100.123.73.128:11434` (VM Contabo, Tailscale IP)
- **Modelo recomendado:** `qwen3:4b-nothink` (Q4_K_M, ~2.5GB, sem chain-of-thought)
- **Catálogo:** 983 tracks, ~20 tokens/linha, ~20K tokens total. Cabe no contexto de 32K do qwen3:4b.
- **Alternativa se prompt ficar grande:** pré-filtrar com embedding match (top 50 candidatas → ~1K tokens)
- **Gêneros disponíveis:** Eletrônica (27%), Rap & Hip-Hop (25%), Funk BR (17%), Funk & Soul (10%), Rock (10%), MPB (9%), Country & Folk (1%), Jazz (1%), Clássica (<1%), Trance (<1%)

## Como verificar

```bash
# Build compila
cargo check --manifest-path src-tauri/Cargo.toml

# Ollama acessível
curl -s http://100.123.73.128:11434/api/tags | python3 -c "import json,sys; [print(m['name']) for m in json.load(sys.stdin)['models']]"

# TEI acessível (pra semantic search existente)
curl -s http://100.123.73.128:8080/health

# Qdrant acessível na cmr-auto (via app sidecar)
# Verificar no app: Ctrl+K, buscar algo, seção "By Lyrics" aparece
```
