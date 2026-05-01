# Rustify Player — Spec: Autoplay Inteligente + Features Derivadas

**Data:** 2026-05-01
**Status:** Design consolidado — nenhum codigo escrito
**Origem:** 2 sessoes de brainstorming (abr-mai 2026)
**Dependencias:** library-indexer, audio-engine, rustify-embed (todos existentes)

---

## Arquitetura geral

```
┌─────────────────────────────────────────────────────┐
│  cmr-auto (app local)                               │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ audio-   │  │ library- │  │ SQLite            │  │
│  │ engine   │  │ indexer  │  │ ├ tracks           │  │
│  │          │  │          │  │ ├ play_events      │  │
│  │          │  │          │  │ ├ track_recommend.  │  │
│  │          │  │          │  │ └ embeddings(BLOB)  │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│       │              │              ▲                │
│       │ play/skip    │ index        │ SELECT         │
│       ▼              ▼              │                │
│  ┌──────────────────────────────────┘                │
│  │  autoplay: proximo = query SQLite local           │
│  └──────────────────────────────────────────────────┘│
│                        │ sync (quando ha rede)       │
└────────────────────────┼────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────┐
│  Contabo VM                                         │
│  ┌──────────────┐  ┌─────────────────────────────┐  │
│  │ rustify-embed│  │ Qdrant Server               │  │
│  │ (MERT-95M)   │  │ collection: rustify_tracks   │  │
│  │ (BGE-M3)*    │  │ ├ vec "mert" (768d, Cosine)  │  │
│  │              │  │ ├ vec "lyrics" (1024d, Cos)*  │  │
│  │              │  │ ├ sparse "lyrics_sparse"*     │  │
│  │              │  │ └ payload {track_id,genre,...} │  │
│  └──────────────┘  └─────────────────────────────┘  │
│                         │                           │
│                         │ Recommendations API       │
│                         │ + Nearest neighbor query   │
│                         ▼                           │
│                    resultados → app                  │
└─────────────────────────────────────────────────────┘

* BGE-M3 e vetores lyrics = fase 2 (stations tematicas)
```

**Decisao central:** Qdrant nunca roda localmente. Nenhuma dependencia nova
no app. Autoplay em runtime e um SELECT no SQLite. Offline-first por design.

---

## Decisoes tomadas e descartadas

### Por que nao Qdrant Edge local

- Beta (v0.6.0), API pode mudar.
- Sem Recommendations API nativa — reimplementacao manual.
- Sem Hybrid Queries (prefetch/fusion) — merge manual de scores.
- Sem background optimizer — `optimize()` manual.
- Sem REST/gRPC — sem Web UI pra debug.
- Overhead de ~20-40MB no processo Tauri pra ~5000 pontos.
- **Desnecessario:** os resultados do Qdrant podem ser pre-computados
  e cacheados como dados SQLite. O Edge resolveria latencia de rede
  em runtime, mas o cache elimina a rede em runtime completamente.

### Por que nao sqlite-vec

- Resolve KNN brute-force rapido (<1ms pra 5000 vetores de 768d).
- Integra no SQLite existente via rusqlite + crate `sqlite-vec`.
- Mas: sem sparse vectors, sem named vectors, sem recommendations.
- Seria reimplementar toda a inteligencia do Qdrant em SQL.
- Se necessario no futuro, migracao e trivial (vetores sao BLOBs).

### Por que nao banco vetorial especializado em musica

Nao existe. Todos os papers e projetos de audio similarity usam
bancos vetoriais genericos (Qdrant, Milvus, Pinecone, FAISS) com
embeddings de audio (MERT, VGGish, OpenL3). O modelo entende musica;
o banco so armazena e busca vetores, agnostico ao dominio.

### Por que Qdrant no Contabo

- Ja roda (Suite Dialetica). Collection nova, zero infra adicional.
- Recommendations API com positivos/negativos = autoplay pronto.
- Named vectors (MERT + lyrics futuro) nativos.
- Sparse vectors (BGE-M3 lexical) nativos.
- Hybrid Queries com prefetch + RRF/DBSF fusion nativos.
- Web UI pra debug e inspecao visual do espaco vetorial.
- Payload filtering (genero, artista) integrado na busca.

---

## Pipeline A — Play Events (local, passiva)

### Schema

```sql
CREATE TABLE play_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id        INTEGER NOT NULL REFERENCES tracks(id),
    origin          TEXT NOT NULL,
    started_at      TEXT NOT NULL,   -- ISO 8601
    ended_at        TEXT,            -- NULL se app fechou mid-track
    end_position_ms INTEGER,
    duration_ms     INTEGER NOT NULL,
    completed       INTEGER GENERATED ALWAYS AS (
                      CASE WHEN end_position_ms >= duration_ms * 0.9
                           THEN 1 ELSE 0 END
                    ) STORED
);

CREATE INDEX idx_pe_track ON play_events(track_id);
CREATE INDEX idx_pe_time  ON play_events(started_at);
```

### Valores de `origin`

`manual` | `album_seq` | `shuffle` | `autoplay` | `station` | `queue`

### Integracao

- `player_play` IPC ganha campo `origin: String`. Frontend sabe a origem.
- `PlayerSnapshot` ganha `current_origin: Option<String>`.
- Quando `TrackEnded` dispara, monta play_event completo e INSERT.
- Overhead: 1 INSERT por transicao. ~200 bytes/row. Desprezivel.

### Sinais comportamentais

| Sinal | Peso |
|-------|------|
| `completed=1` + `origin='manual'` | Positivo forte |
| `completed=1` + `origin='autoplay'` | Autoplay acertou — reforco |
| `completed=0` + `end_position_ms < 5000` | Rejeicao — negativo |
| `completed=0` + `origin='album_seq'` | Ruido (inercia, nao intencao) |
| Mesmo track_id 2x em <10min | Replay — positivo muito forte |

---

## Pipeline B — Qdrant Recommendations (remota, batch)

### Quando roda

Sync ocorre quando ha rede. Pode ser on-startup, manual (botao),
ou periodico. Nao e critico — o app funciona com dados stale.

### Etapas do sync

1. **Upsert pontos novos.** Tracks com MERT embedding no SQLite que
   ainda nao estao no Qdrant. Vetores como BLOB → Qdrant upsert.

2. **Envio de play_events.** App manda eventos acumulados desde
   ultimo sync pro Contabo. Script/servico no Contabo processa
   e seleciona positivos/negativos pra cada cenario de recommend.

3. **Batch recommendations.** Pra cada track com play_events
   suficientes:
   ```
   POST /collections/rustify_tracks/points/recommend
   {
     "positive": [<tracks completadas recentemente>],
     "negative": [<tracks skipadas recentemente>],
     "using": "mert",
     "limit": 20
   }
   ```

4. **Download de resultados → SQLite local.**

### Tabela `track_recommendations`

```sql
CREATE TABLE track_recommendations (
    seed_track_id        INTEGER NOT NULL,
    recommended_track_id INTEGER NOT NULL,
    rank                 INTEGER NOT NULL,
    score                REAL NOT NULL,
    strategy             TEXT NOT NULL,   -- 'mert' | 'lyrics' | 'hybrid'
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (seed_track_id, recommended_track_id, strategy)
);

CREATE INDEX idx_rec_seed ON track_recommendations(
    seed_track_id, strategy, rank
);
```

### Evolucao organica

Nao ha threshold de maturidade. O sistema e gradual:

- **Semana 1:** recommend por nearest neighbor puro (sem play_events
  como positivos/negativos). Funcional mas generico.
- **Mes 1:** ~200 play_events acumulados. Positivos/negativos rasos
  mas ja personalizados.
- **Mes 3+:** ~1000+ play_events. Cobertura ampla, recommendations
  densas e personalizadas.

Nenhuma mudanca de codigo entre fases — so os dados de input do
recommend ficam mais ricos.

---

## Autoplay — consumo local

```
track termina
  → SELECT recommended_track_id
    FROM track_recommendations
    WHERE seed_track_id = ?
      AND strategy = 'mert'
    ORDER BY rank
    LIMIT 5
  → filtra tracks tocadas recentemente (anti-repeat)
  → enqueue top-1
  → player_play(path, origin='autoplay')
```

100% offline. Query SQLite em <1ms. Se `track_recommendations` vazio
pra seed atual, fallback pro `similar()` brute-force via MERT embedding
local (ja implementado).

---

## Fase 2 — Lyrics Embeddings (BGE-M3) e Stations Tematicas

### O que muda

BGE-M3 nao enriquece o autoplay. MERT captura som (timbre, ritmo,
harmonia). Lyrics captura texto (tema, narrativa, emocao verbal).
Misturar os dois no autoplay causaria quebras de textura sonora
porque o tema lirico coincide — indesejavel.

BGE-M3 habilita uma feature que MERT nao consegue: **busca por
conceito textual.**

### Como funciona

BGE-M3 foi treinado em bilhoes de textos. Textos sobre solidao —
independente de vocabulario, idioma, estilo — compartilham padroes
semanticos e aterrissam na mesma regiao do espaco vetorial.

Ninguem classifica. Ninguem rotula "essa musica e sobre solidao".
A inteligencia esta na geometria do espaco, nao num classificador.

Dense vector (1024d): captura semantica. "Madrugada sozinho na
cidade" fica proximo de "noite insone andando pelas ruas" mesmo
sem palavras em comum.

Sparse vector: captura lexical. Busca por "chuva" retorna musicas
que mencionam "chuva" literalmente.

Hybrid (dense + sparse via RRF): cobre intencao E literal.

### Stations tematicas

```
usuario digita "madrugada sozinho na cidade"
  (ou seleciona prompt pre-definido)

→ BGE-M3 embeda a frase no mesmo espaco das letras
→ Qdrant: nearest neighbors do query vector no named vector "lyrics"
→ resultados = tracks cujas letras sao semanticamente proximas
→ station gerada, sem curadoria manual, sem tags, sem taxonomia
```

### Prerequisitos

- Fonte de letras (API? local? scraping? copyright?). Bloqueio
  principal — nao existe fonte limpa e gratuita.
- BGE-M3 no rustify-embed (endpoint adicional ou servico separado).
- Pipeline de extracao: track → letras → embed → upsert Qdrant.
- Frontend: input de prompt + view de station.

### Posicao no roadmap

Fase 2. Depende de resolver fonte de letras. Nao bloqueia autoplay
(fase 1 e 100% MERT). Spec separado quando chegar la.

---

## Fase 3 — Animacoes visuais (independente)

### Cor dominante da artwork

Extraida no `cover.rs` durante indexacao. Histogram binning nas cores
do cover art → cor dominante armazenada como campo no `albums`.

Metodo: converter pixels pra HSL, agrupar em bins, pegar o bin com
mais pixels ignorando pretos/brancos/cinzas (saturacao < 15%).

### Animacao CSS por genero

Gradientes radiais animados via `@keyframes` na compositor thread.
Sem JS no render loop. Genero determina o tipo de animacao (pulsante
pra eletronica, ondulante pra ambient, estatico pra classica). Cor
dominante do album alimenta os stops do gradiente.

```css
.now-playing[data-genre="electronic"] .album-glow {
  animation: pulse-glow 4s ease-in-out infinite;
  background: radial-gradient(
    circle at 50% 50%,
    var(--album-dominant-color) 0%,
    transparent 70%
  );
}
```

Overhead: zero. CSS animations rodam na compositor thread, nao
bloqueiam main thread.

---

## O que NAO muda no app existente

| Componente | Impacto |
|---|---|
| audio-engine | Zero. Continua recebendo path e tocando. |
| library-indexer | +2 tabelas via migration. Pipeline MERT identico. |
| rustify-embed | Inalterado na fase 1. BGE-M3 endpoint na fase 2. |
| Frontend | `player_play` ganha campo `origin`. Autoplay chama `player_play(path, 'autoplay')`. |
| Dependencias do app | Nenhuma nova. Qdrant e remoto. |

---

## Ordem de implementacao sugerida

| Passo | O que | Bloqueado por |
|-------|-------|---------------|
| 1 | Tabela `play_events` + INSERT no engine event handler | Nada |
| 2 | Campo `origin` no `player_play` IPC | Passo 1 |
| 3 | Collection `rustify_tracks` no Qdrant Contabo | Nada |
| 4 | Script de sync: upsert embeddings MERT → Qdrant | Passo 3 |
| 5 | Script de batch recommend: play_events → positivos/negativos → resultados | Passos 1,3,4 |
| 6 | Tabela `track_recommendations` + autoplay consumer | Passo 5 |
| 7 | Cor dominante no cover.rs + CSS animations | Nada |
| 8 | BGE-M3 lyrics (fase 2) | Fonte de letras |
| 9 | Stations tematicas (fase 2) | Passo 8 |
