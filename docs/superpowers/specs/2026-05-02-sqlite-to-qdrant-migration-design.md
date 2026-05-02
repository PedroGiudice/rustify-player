# SQLite → Qdrant Migration

**Data:** 2026-05-02
**Decisão:** Qdrant é a única fonte de verdade. SQLite é eliminado completamente.

## Motivação

O app mantém dual-store (SQLite + Qdrant) com sync manual entre eles.
Overhead desnecessário: Qdrant já armazena play_events e embeddings, e tem
capacidade de payload filtering + text index que cobre todas as queries do app.
Para ~1000 tracks, Qdrant responde em sub-milissegundo.

## Arquitetura Atual (SQLite-first)

```
FLAC scan → SQLite (tracks, albums, artists, genres, tags, FTS5)
              ↓ sync_embeddings()
            Qdrant (rustify_tracks: MERT vectors + payload subset)
            Qdrant (play_events: eventos com dummy vector)
```

- `db.rs`: connection pool, migrations, CRUD
- `search.rs`: ~25 funções de query, todas `fn(conn: &Connection) → ...`
- `pipeline.rs`: scan → upsert SQLite
- `play_events.rs`: insert + autoplay_next via SQLite
- `qdrant_client.rs`: sync de embeddings, play events, recommendations, mood search

## Arquitetura Nova (Qdrant-only)

```
FLAC scan → Qdrant (rustify_tracks: metadados completos + vetores)
            Qdrant (play_events: já existe, sem mudanças)
```

### Collections

#### `rustify_tracks` (expandida)

Point ID: integer sequencial (counter persistido no Qdrant via meta-point).
Cada point = 1 track com payload completo:

```json
{
  "id": 42,
  "vectors": {
    "mert": [768 floats],
    "lyrics": [1024 floats]
  },
  "payload": {
    "path": "/home/user/Music/artist/album/song.flac",
    "filename": "song.flac",
    "title": "Song Title",
    "artist": "Artist Name",
    "album_title": "Album Title",
    "album_year": 2023,
    "cover_path": "/cache/covers/abc123.jpg",
    "genre": "Rock",
    "tags": ["chill", "acoustic"],
    "track_number": 3,
    "disc_number": 1,
    "duration_ms": 240000,
    "sample_rate": 44100,
    "bit_depth": 16,
    "channels": 2,
    "rg_track_gain": -6.5,
    "rg_album_gain": -7.2,
    "rg_track_peak": 0.98,
    "rg_album_peak": 0.99,
    "embedding_status": "done",
    "play_count": 5,
    "last_played": 1714600000,
    "liked_at": 1714500000,
    "lrc_path": "/data/lyrics/song.lrc",
    "embedded_lyrics": "line1\nline2\n...",
    "mtime": 1714400000,
    "size_bytes": 35000000,
    "indexed_at": 1714400000
  }
}
```

Payload indices (criados no ensure_collection):
- `path`: keyword (unique lookup)
- `title`: text (tokenized, para busca)
- `artist`: text + keyword (busca + exact match)
- `album_title`: text + keyword
- `genre`: keyword (filtro)
- `tags`: keyword (multi-value filtro)
- `play_count`: integer (ordenação)
- `last_played`: integer (ordenação)
- `liked_at`: integer (filtro not-null)
- `embedding_status`: keyword
- `track_number`: integer (ordenação)
- `disc_number`: integer (ordenação)
- `mtime`: integer (change detection no scan)
- `indexed_at`: integer (ordenação "recently added")

Vetores: named vectors `"mert"` (768d cosine) e `"lyrics"` (1024d cosine),
ambos opcionais (tracks sem embedding têm vetor zerado ou ausente).

#### `play_events` (sem mudanças)

Já existe e funciona. Dummy vector [0.0], payload com track_id, origin,
started_at, listen_pct, etc.

#### `moods` (nova collection)

Uma collection dedicada pra mood playlists. Cada point = 1 mood:

```json
{
  "id": 1,
  "vector": [768 floats centroid MERT],
  "payload": {
    "name": "Chill Vibes",
    "track_ids": [42, 55, 78, ...],
    "accent_color": "#4a90d9",
    "cover_path": "/cache/moods/chill.jpg",
    "track_count": 25,
    "created_at": 1714400000,
    "updated_at": 1714500000
  }
}
```

### ID Strategy

IDs de track = integer sequencial. Um meta-point especial (ID = 0) na
collection `rustify_tracks` armazena o counter:

```json
{ "id": 0, "vector": { "mert": [0.0 × 768] }, "payload": { "_type": "meta", "next_id": 1001 } }
```

No scan, antes de inserir um batch, faz scroll no meta-point, incrementa,
e usa o range. Alternativa: hash do path (CRC64 ou similar) — determinístico,
sem coordenação. **Recomendação: hash do path.** Simples, idempotente,
sem race conditions.

```rust
fn path_to_id(path: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}
```

Qdrant aceita point IDs como u64. O hash é estável dentro do mesmo OS/runtime.

### Mapeamento de Queries

Cada função de `search.rs` tem equivalente em Qdrant:

| SQLite (atual) | Qdrant (novo) |
|---|---|
| `get_track(id)` | `GET /points/{id}` → parse payload em Track |
| `get_track_by_path(path)` | scroll com filter `path == "..."` |
| `list_tracks(filter)` | scroll com filters (genre, artist, album, tags) + order_by |
| `list_albums(filter)` | scroll com group_by `album_title` (ou distinct scroll) |
| `list_artists(filter)` | scroll com group_by `artist` |
| `list_genres()` | scroll com group_by `genre` |
| `search(query)` | scroll com `must: [{text_match: {field, text}}]` em title/artist/album |
| `similar(track_id, limit)` | recommend com `positive: [track_id]` no named vector `mert` |
| `shuffle(filter, seed)` | scroll com filter + random sampling client-side |
| `record_play(track_id)` | set_payload: increment play_count, set last_played |
| `list_history(limit)` | scroll order_by last_played desc, filter not-null |
| `toggle_like(track_id)` | set_payload: toggle liked_at |
| `list_liked(limit)` | scroll filter liked_at not-null, order_by liked_at desc |
| `is_liked(track_id)` | get_payload(id) → check liked_at |
| `recommendations()` | recommend API com positives (liked + most_played) |
| `list_moods()` | scroll collection `moods` |
| `list_mood_tracks(mood_id)` | get_payload do mood → track_ids → batch get tracks |
| `list_folders(root)` | scroll group_by prefix de path |
| `list_folder_tracks(folder)` | scroll filter path starts_with folder |
| `get_lyrics(track_id)` | get_payload → lrc_path/embedded_lyrics → parse |
| `insert_play_event(...)` | qdrant_client.insert_play_event (já existe) |
| `autoplay_next(seed, exclude)` | recommend API com positive [seed], negative exclude |

### Scan Pipeline

Fluxo atual: walk filesystem → parse metadata → upsert SQLite → emit events.

Fluxo novo: walk filesystem → parse metadata → upsert Qdrant → emit events.

Change detection: scroll todos os points, build HashMap<path, (mtime, size_bytes)>.
Comparar com filesystem. Upsert novos/modificados, delete removidos.

Batch upsert em chunks de 100 (já implementado em `upsert_batch`).
Tracks novos sem embedding: upsert com vetor zerado + `embedding_status: "pending"`.

### Operações de Escrita

Qdrant suporta `set_payload` pra updates parciais sem reescrever o ponto inteiro.
Usar pra: play_count increment, liked_at toggle, embedding upsert.

```
POST /collections/rustify_tracks/points/payload
{
  "payload": { "play_count": 6, "last_played": 1714600000 },
  "points": [42]
}
```

### Aggregations (Albums, Artists, Genres)

Qdrant não tem GROUP BY nativo. Duas abordagens:

**Opção A — Scroll + aggregate client-side:**
Scroll todos os points (com_payload parcial: só artist, album_title, genre, cover_path),
aggregate em HashMap no Rust. Para 1000 tracks, isso é ~100KB de payload e <10ms.

**Opção B — Facet API (Qdrant 1.13+):**
`POST /collections/rustify_tracks/facet` retorna valores distintos com contagem.
Ideal pra list_genres, list_artists. Não retorna metadados extras (cover_path do album),
então pra albums pode precisar de scroll adicional.

**Recomendação: Opção A** — scroll + aggregate. Simples, determinístico, sem
dependência de versão. Com 1000 tracks a performance é irrelevante.
Cache in-memory opcional se quiser (SharedState já existe).

### FTS / Text Search

Qdrant text index com tokenization:
```json
{ "field_name": "title", "field_schema": { "type": "text", "tokenizer": "word", "lowercase": true } }
```

Query via filter:
```json
{ "must": [{ "key": "title", "match": { "text": "beatl" } }] }
```

Prefix matching funciona com tokenizer `word`. Busca cross-field (title + artist + album)
= OR de 3 must clauses.

Sem ranking por relevância (diferente de FTS5), mas pra 1000 tracks com prefix match
o resultado é suficiente — o usuário digita e filtra, não precisa de TF-IDF.

## Módulos Afetados

### Eliminados
- `db.rs` — inteiro (connection pool, migrations, CRUD, seeds)
- `migrations/` — diretório inteiro (8 arquivos SQL)
- `seeds/genres.json` — seed de gêneros (movido pra payload ou hard-coded)
- `play_events.rs` — versão SQLite (Qdrant já tem)
- `search.rs` — inteiro (reescrito como `query.rs` baseado em Qdrant)

### Modificados
- `qdrant_client.rs` — expandido: absorve toda a lógica de query do antigo search.rs
- `pipeline.rs` — scan escreve direto no Qdrant em vez de SQLite
- `lib.rs` (library-indexer) — `IndexerHandle` usa `QdrantClient` em vez de ReadPool/WritePool
- `lib.rs` (tauri app) — remove db_path, passa qdrant_url no config
- `types.rs` — Track sem album_id/artist_id/genre_id (denormalizado)
- `error.rs` — remove `Database(rusqlite::Error)`
- `Cargo.toml` (workspace + crate) — remove rusqlite dependency

### Novos
- `query.rs` — funções de query sobre Qdrant (substitui search.rs)

## Tipos Ajustados

### Track (pós-migração)
```rust
pub struct Track {
    pub id: u64,              // era i64, agora u64 (hash do path)
    pub path: PathBuf,
    pub filename: String,
    pub title: String,
    pub track_number: Option<i32>,
    pub disc_number: i32,
    pub duration_ms: i64,
    pub album_title: Option<String>,  // era album_id + album_title
    pub album_year: Option<i32>,
    pub album_cover_path: Option<PathBuf>,
    pub artist_name: Option<String>,  // era artist_id + artist_name
    pub genre_name: Option<String>,   // era genre_id + genre_name
    pub tags: Vec<String>,
    pub sample_rate: u32,
    pub bit_depth: u16,
    pub channels: u16,
    pub rg_track_gain: Option<f32>,
    pub rg_album_gain: Option<f32>,
    pub rg_track_peak: Option<f32>,
    pub rg_album_peak: Option<f32>,
    pub embedding_status: EmbeddingStatus,
    pub play_count: u32,
    pub last_played: Option<i64>,
    pub liked_at: Option<i64>,
    pub lrc_path: Option<PathBuf>,
}
```

Campos removidos: `album_id`, `artist_id`, `genre_id`. Não fazem sentido sem
tabelas normalizadas. Filtros usam strings diretamente.

### TrackFilter (pós-migração)
```rust
pub struct TrackFilter {
    pub genre: Option<String>,     // era genre_id: Option<i64>
    pub artist: Option<String>,    // era artist_id: Option<i64>
    pub album: Option<String>,     // era album_id: Option<i64>
    pub tags: Vec<String>,         // era tag_ids: Vec<i64>
    pub limit: Option<usize>,
    pub order: TrackOrder,
}
```

### Album, Artist (pós-migração)
```rust
pub struct Album {
    pub title: String,             // sem id
    pub artist_name: Option<String>,
    pub year: Option<i32>,
    pub cover_path: Option<PathBuf>,
    pub track_count: u32,
}

pub struct Artist {
    pub name: String,              // sem id
    pub track_count: u32,
    pub album_count: u32,
}
```

### Genre simplificado
```rust
pub struct Genre {
    pub name: String,
    pub track_count: u32,
}
```

Gêneros seed: lista estática no código (ou config file). A collection
determina quais gêneros existem na prática via aggregation.

### IndexerConfig (pós-migração)
```rust
pub struct IndexerConfig {
    pub qdrant_url: String,        // era db_path: PathBuf
    pub music_root: PathBuf,
    pub cache_dir: PathBuf,
    pub embed_client: Option<EmbedClient>,
}
```

## Frontend Impact

O frontend consome dados via Tauri commands que retornam `Track`, `Album`, etc.
As mudanças nos tipos (remoção de IDs numéricos, strings como identificadores)
afetam os Tauri commands e consequentemente o frontend:

- Filtros por gênero/artista/album passam string em vez de i64
- Track IDs mudam de i64 para u64 (ou string se necessário)
- Listagens de album/artist retornam structs sem id

Os Tauri commands em `lib.rs` mantêm a mesma interface pública onde possível,
absorvendo a mudança internamente.

## Migração de Dados

Não há migração automática. O scan pipeline re-indexa tudo do filesystem.
Na primeira execução pós-migração:

1. App inicia, conecta ao Qdrant sidecar
2. Detect: collection `rustify_tracks` existe mas sem novos payload fields → full rescan
3. Walk ~/Music, parse metadata, upsert com payloads completos
4. Embeddings existentes no Qdrant são preservados (points com MERT vectors ficam)
5. Play events no Qdrant ficam intactos
6. library.db pode ser deletado pelo usuário (ou ignorado)

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Qdrant sidecar não inicia | App funciona em modo degradado (sem library) — já é assim |
| Hash collision de path | Probabilidade ~1 em 10^18 pra 1000 tracks — irrelevante |
| Perda de play_count/liked_at no rescan | set_payload é incremental, não sobrescreve campos existentes se point já existe |
| Performance de aggregation com >10k tracks | Cache in-memory com TTL — resolver quando/se necessário |

## Sequência de Implementação

1. Expandir `qdrant_client.rs` com novos métodos de query (equivalentes a search.rs)
2. Criar `query.rs` com funções que delegam pro QdrantClient
3. Reescrever `pipeline.rs` pra scan → Qdrant direto
4. Reescrever `IndexerHandle` pra usar QdrantClient em vez de pools
5. Atualizar tipos (Track, Album, Artist, Genre, filters)
6. Atualizar Tauri commands em `lib.rs`
7. Atualizar frontend pra novos tipos
8. Remover db.rs, migrations/, seeds/, play_events.rs, search.rs
9. Remover rusqlite do Cargo.toml
10. Testar scan + queries + playback end-to-end
