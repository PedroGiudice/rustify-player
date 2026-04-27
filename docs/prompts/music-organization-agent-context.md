# Contexto: Organizacao de Biblioteca Musical — Rustify Player

## Objetivo

Organizar a biblioteca de musica do usuario (FLACs em `~/Music/`) usando os embeddings MERT ja computados no banco SQLite. O agente pode: reorganizar pastas, regenerar mood playlists (stations), criar novas categorias, sugerir re-classificacoes.

---

## Onde fica tudo (cmr-auto, paths locais)

| O que | Path |
|-------|------|
| Musicas (FLAC) | `~/Music/<Genre>/<Artist>/<YYYY - Album>/NN - Title.flac` |
| Banco SQLite | `~/.local/share/dev.cmr.rustifyplayer/library.db` |
| Cover art cache | `~/.local/share/dev.cmr.rustifyplayer/covers/` |
| Script de mood/stations | `~/rustify-player/scripts/gemini_mood_classifier.py` |

O banco usa WAL mode. Se o app estiver aberto, leituras sao seguras. Escritas diretas no DB devem ser feitas com o app fechado (ou via IPC do app).

---

## Como a biblioteca funciona

### Estrutura de pastas = metadado

```
~/Music/<Genre>/<Artist>/<YYYY - Album>/NN - Title.flac
```

- **Primeiro nivel** abaixo de `~/Music/` = genre (literal, nome da pasta)
- **Segundo nivel** = artist
- **Terceiro nivel** = album (formato `YYYY - Nome`)
- **Filename** = `NN - Title.flac` (track number + titulo)

O indexer (Rust, roda dentro do app) escaneia `~/Music/` recursivamente e extrai genre/artist/album da hierarquia de pastas. Tags FLAC (vorbis comments) sao lidas para titulo, track number, disc number, sample rate, bit depth, ReplayGain.

### Playlists = pastas

Nao existe tabela de playlists no banco. O app agrupa tracks pelo `dirname(path)` — qualquer pasta que contenha FLACs aparece como "playlist" na UI. Mover um arquivo de pasta = mudar de playlist.

### Stations (mood radios) = tabela no banco

Stations sao playlists geradas por IA, separadas das playlists de pasta. Vivem nas tabelas `mood_playlists` e `mood_playlist_tracks`. Sao apresentadas como "radios" na UI, nao misturadas com playlists do usuario.

---

## Schema SQLite (resumo)

```sql
-- Genres (15 seeds, extensivel)
CREATE TABLE genres (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, display_order INTEGER);

-- Artists
CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT);

-- Albums
CREATE TABLE albums (id INTEGER PRIMARY KEY, title TEXT NOT NULL, album_artist_id INTEGER, year INTEGER, cover_path TEXT);

-- Tracks (coração do schema)
CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,        -- path absoluto do FLAC
    filename TEXT NOT NULL,
    title TEXT NOT NULL,
    track_number INTEGER,
    disc_number INTEGER DEFAULT 1,
    duration_ms INTEGER NOT NULL,
    album_id INTEGER,                 -- FK albums
    artist_id INTEGER,                -- FK artists
    genre_id INTEGER,                 -- FK genres
    sample_rate INTEGER NOT NULL,
    bit_depth INTEGER NOT NULL,
    channels INTEGER NOT NULL,
    rg_track_gain REAL,               -- ReplayGain
    rg_album_gain REAL,
    embedding BLOB,                   -- MERT 768d, f32 little-endian, L2-normalized
    embedding_status TEXT DEFAULT 'pending',  -- 'pending' | 'done' | 'failed'
    play_count INTEGER DEFAULT 0,
    last_played INTEGER,
    liked_at INTEGER,                 -- timestamp se curtida, NULL se nao
    -- Colunas denormalizadas pra FTS5 content-sync:
    album_title TEXT DEFAULT '',
    artist_name TEXT DEFAULT '',
    tags TEXT DEFAULT ''
);

-- Tags (many-to-many)
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE track_tags (track_id INTEGER, tag_id INTEGER, PRIMARY KEY (track_id, tag_id));

-- Mood playlists (stations)
CREATE TABLE mood_playlists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    centroid BLOB,                    -- centroide do cluster (768d f32)
    track_count INTEGER DEFAULT 0,
    accent_color TEXT,                -- hex ex: '#E87040'
    cover_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE mood_playlist_tracks (
    mood_playlist_id INTEGER,
    track_id INTEGER,
    distance REAL,                    -- distancia ao centroide
    PRIMARY KEY (mood_playlist_id, track_id)
);

-- FTS5 (busca full-text, content-synced com tracks)
CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title, album_title, artist_name, tags,
    content='tracks', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);
```

---

## Embeddings MERT

- **Modelo:** MERT-v1-95M (Music Understanding, HuggingFace m-a-p/MERT-v1-95M)
- **Dimensao:** 768 floats (f32 little-endian)
- **Normalizacao:** L2-normalized no ingest (cosine similarity = dot product)
- **Servico:** `rustify-embed` rodando na VM Contabo (porta 8448, Tailscale)
- **Cobertura:** ~981 tracks, maioria com `embedding_status = 'done'`

### Como ler embeddings do SQLite em Python

```python
import sqlite3
import numpy as np

conn = sqlite3.connect("~/.local/share/dev.cmr.rustifyplayer/library.db")

rows = conn.execute("""
    SELECT t.id, t.title, ar.name as artist, g.name as genre,
           al.title as album, t.embedding
    FROM tracks t
    LEFT JOIN artists ar ON ar.id = t.artist_id
    LEFT JOIN genres g ON g.id = t.genre_id
    LEFT JOIN albums al ON al.id = t.album_id
    WHERE t.embedding_status = 'done' AND t.embedding IS NOT NULL
""").fetchall()

tracks = []
embeddings = []
for row in rows:
    tid, title, artist, genre, album, blob = row
    vec = np.frombuffer(blob, dtype=np.float32)  # 768d
    tracks.append({"id": tid, "title": title, "artist": artist, "genre": genre, "album": album})
    embeddings.append(vec)

X = np.stack(embeddings)  # shape: (N, 768)

# Similarity entre track 0 e todas as outras:
sims = X @ X[0]  # dot product = cosine (ja L2-normalized)
```

### Como calcular similaridade

Os vetores ja sao L2-normalized. Cosine similarity = dot product direto:

```python
similarity = np.dot(vec_a, vec_b)  # float entre -1 e 1, tipicamente 0.3-0.9
```

Para clustering:
```python
from sklearn.cluster import KMeans

kmeans = KMeans(n_clusters=10, random_state=42, n_init=10)
labels = kmeans.fit_predict(X)
centroids = kmeans.cluster_centers_
```

---

## Stations atuais (8, geradas 2026-04-26)

| Nome | Tracks | Accent Color |
|------|--------|-------------|
| Poesia e Brasilidade | 86 | #D4A054 |
| Ritmo e Groove | 104 | #E87040 |
| Rimas Pesadas | 158 | #C43C3C |
| Baile Automotivo | 168 | #E0E020 |
| Pista Sintetica | 84 | #7B68EE |
| Transe Psicodelico | 82 | #00CED1 |
| Atmosfera Eletronica | 30 | #4682B4 |
| Lendas do Rock | 37 | #808080 |

Pipeline hibrido: k-means (k=10) nos embeddings 768d → Gemini Pro nomeia e refina (merge/split).

---

## Script existente: gemini_mood_classifier.py

```bash
# Preview (dry run):
python3 scripts/gemini_mood_classifier.py --db ~/.local/share/dev.cmr.rustifyplayer/library.db

# Escrever no banco:
python3 scripts/gemini_mood_classifier.py --db ~/.local/share/dev.cmr.rustifyplayer/library.db --write

# Custom k:
python3 scripts/gemini_mood_classifier.py --db ... --moods 12
```

Requer `GEMINI_API_KEY` no `.env` ou env var. Usa `google-genai` SDK.

---

## O que o agente pode fazer

### 1. Reorganizar pastas fisicas

Mover FLACs entre pastas em `~/Music/` para corrigir generos, artistas, ou criar novas categorias. Apos mover, rodar rescan no app (Settings > Rescan) para o indexer reprocessar.

**Cuidado:** mover arquivos quebra os `path` no banco. O rescan detecta tracks removidas (path antigo) e tracks novas (path novo), mas perde play_count, liked_at, e embedding associados ao path antigo. Para preservar dados, atualizar o `path` no banco apos o mv:

```sql
UPDATE tracks SET path = '/new/path/file.flac' WHERE path = '/old/path/file.flac';
```

### 2. Regenerar stations com parametros diferentes

Rodar o script de mood com mais/menos clusters, ou customizar o prompt do Gemini para vibes diferentes.

### 3. Criar stations manuais via SQL

```sql
INSERT INTO mood_playlists (name, track_count, accent_color, created_at, updated_at)
VALUES ('Minha Station', 0, '#FF6B35', unixepoch(), unixepoch());

-- Pegar o ID:
SELECT last_insert_rowid();

-- Adicionar tracks:
INSERT INTO mood_playlist_tracks (mood_playlist_id, track_id, distance)
SELECT 9, id, 0.0 FROM tracks WHERE artist_name LIKE '%Artista%';

-- Atualizar contagem:
UPDATE mood_playlists SET track_count = (
    SELECT COUNT(*) FROM mood_playlist_tracks WHERE mood_playlist_id = 9
) WHERE id = 9;
```

### 4. Analisar a biblioteca via embeddings

- Encontrar outliers (tracks que nao se encaixam em nenhum cluster)
- Encontrar duplicatas sonoras (tracks com cosine > 0.95)
- Mapear a "distancia" entre generos pela media dos embeddings
- Sugerir re-classificacao de genero baseada em similaridade
- Identificar artistas que deveriam estar em generos diferentes

### 5. Queries uteis

```sql
-- Tracks sem embedding
SELECT count(*) FROM tracks WHERE embedding_status != 'done';

-- Generos e contagem
SELECT g.name, count(*) as n FROM tracks t JOIN genres g ON g.id=t.genre_id GROUP BY g.name ORDER BY n DESC;

-- Top artistas
SELECT ar.name, count(*) as n FROM tracks t JOIN artists ar ON ar.id=t.artist_id GROUP BY ar.name ORDER BY n DESC LIMIT 20;

-- Tracks curtidas
SELECT t.title, ar.name FROM tracks t JOIN artists ar ON ar.id=t.artist_id WHERE t.liked_at IS NOT NULL;

-- Tracks mais tocadas
SELECT t.title, ar.name, t.play_count FROM tracks t JOIN artists ar ON ar.id=t.artist_id WHERE t.play_count > 0 ORDER BY t.play_count DESC LIMIT 20;

-- Tracks de uma station
SELECT t.title, ar.name, mpt.distance
FROM mood_playlist_tracks mpt
JOIN tracks t ON t.id = mpt.track_id
JOIN artists ar ON ar.id = t.artist_id
WHERE mpt.mood_playlist_id = ?
ORDER BY mpt.distance;
```

---

## Restricoes

- **Formato:** so FLAC. O indexer ignora mp3/m4a/ogg.
- **Estrutura de pastas:** `~/Music/<Genre>/<Artist>/<YYYY - Album>/` e a convencao. Desviar dela confunde o parser de genero.
- **Embeddings:** MERT 768d. Nao sao text embeddings — capturam timbre, ritmo, harmonia, energia do audio. Dois tracks podem ter titulos/artistas completamente diferentes mas embeddings muito proximos se soam parecidos.
- **App precisa de rescan** apos qualquer mudanca no filesystem. Rescan e idempotente (upsert por path + mtime).
- **DB path canonico:** `~/.local/share/dev.cmr.rustifyplayer/library.db`
