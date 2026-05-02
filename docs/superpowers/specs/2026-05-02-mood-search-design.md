# Mood Search via Qdrant Payload Filters

**Data:** 2026-05-02
**Status:** Draft

## Contexto

As 983 tracks no Qdrant agora possuem payloads de mood anotados pelo Gemini:
- `mood_tags`: lista de strings (energético, melancólico, romântico, etc.)
- `activity_tags`: lista de strings (malhar, relaxar, dirigir, etc.)
- `energy`: float 0.0-1.0
- `valence`: float 0.0-1.0

Nenhum código no app consome esses payloads. Esta spec define o mecanismo de busca por mood na search bar existente.

## Design

### Fluxo

```
User digita "funk triste pra dirigir" na search bar (Ctrl+K)
  → Frontend dispara 3 buscas em paralelo:
    1. lib_search (textual FTS5) — existente
    2. lib_semantic_search (lyrics embedding) — existente
    3. lib_mood_search (payload filter) — NOVO
  → Resultados renderizados em 3 seções: Tracks, By Lyrics, By Mood
  → Deduplicação: By Mood remove tracks já presentes em Tracks e By Lyrics
```

### Backend: Query Parser

O parser extrai filtros de uma query em linguagem natural. Cada keyword reconhecido vira um filtro Qdrant. Múltiplos filtros combinam com AND.

**Mapa de keywords → filtros:**

| Categoria | Keywords (PT-BR + EN) | Filtro Qdrant |
|-----------|----------------------|---------------|
| Activity | malhar, treino, workout, academia | `activity_tags` match "malhar" |
| Activity | relaxar, relax, chill, calmo | `activity_tags` match "relaxar" |
| Activity | dirigir, drive, carro | `activity_tags` match "dirigir" |
| Activity | estudar, study, foco, focus | `activity_tags` match "estudar" |
| Activity | festa, party | `activity_tags` match "festa" |
| Activity | correr, run, running | `activity_tags` match "correr" |
| Activity | dançar, dance, dancing | `activity_tags` match "dançar" |
| Activity | acordar, morning, manhã | `activity_tags` match "acordar" |
| Activity | dormir, sleep | `activity_tags` match "dormir" |
| Activity | meditar, meditation | `activity_tags` match "meditar" |
| Activity | road trip, viagem | `activity_tags` match "road_trip" |
| Activity | churrasco, bbq | `activity_tags` match "churrasco" |
| Activity | cozinhar, cooking | `activity_tags` match "cozinhar" |
| Activity | trabalhar, work | `activity_tags` match "trabalhar" |
| Mood | triste, sad | `mood_tags` match "melancólico" |
| Mood | alegre, happy, feliz | `mood_tags` match "alegre" |
| Mood | animado, energia, energetic, energy | `mood_tags` match "energético" |
| Mood | agressivo, aggressive, pesado, heavy | `mood_tags` match "agressivo" |
| Mood | romântico, romantic, amor, love | `mood_tags` match "romântico" |
| Mood | sombrio, dark | `mood_tags` match "sombrio" |
| Mood | nostálgico, nostalgia | `mood_tags` match "nostálgico" |
| Mood | misterioso, mystery | `mood_tags` match "misterioso" |
| Mood | rebelde, rebel | `mood_tags` match "rebelde" |
| Mood | sensual, sexy | `mood_tags` match "sensual" |
| Mood | empoderador, empowering | `mood_tags` match "empoderador" |
| Energy | alta energia, high energy, intenso | `energy` >= 0.7 |
| Energy | baixa energia, low energy, suave, soft | `energy` <= 0.3 |
| Valence | positivo, upbeat, pra cima | `valence` >= 0.7 |
| Valence | negativo, down, pra baixo | `valence` <= 0.3 |
| Genre | funk, funk br | `genre` match "Funk Brasileiro" |
| Genre | rock | `genre` match "Rock" |
| Genre | mpb | `genre` match "MPB" |
| Genre | rap, hip hop, hip-hop | `genre` match "Rap & Hip-Hop" |
| Genre | eletrônica, eletronica, electronic | `genre` match "Eletrônica" |
| Genre | soul, funk soul | `genre` match "Funk & Soul" |
| Genre | trance | `genre` match "Trance" |

**Parsing:** tokeniza a query, itera tokens (e bigramas para termos compostos como "road trip", "hip hop", "alta energia"), acumula filtros. Tokens não reconhecidos são ignorados.

**Exemplo:** "funk triste pra dirigir"
- "funk" → genre "Funk Brasileiro"
- "triste" → mood "melancólico"
- "pra" → ignorado
- "dirigir" → activity "dirigir"
- Resultado: `must: [genre match, mood match, activity match]`

### Backend: Qdrant Scroll com Filter

Novo método `mood_search` no `QdrantClient`:

```rust
pub fn mood_search(&self, filters: &MoodFilters, limit: usize) -> Result<Vec<i64>, IndexerError>
```

Monta um Qdrant scroll request com `filter.must` contendo as condições. Retorna track IDs (sem score — filtro binário, não ranking).

```rust
pub struct MoodFilters {
    pub mood_tags: Vec<String>,
    pub activity_tags: Vec<String>,
    pub genre: Option<String>,
    pub energy_min: Option<f32>,
    pub energy_max: Option<f32>,
    pub valence_min: Option<f32>,
    pub valence_max: Option<f32>,
}
```

### Backend: Tauri Command

```rust
#[tauri::command]
fn lib_mood_search(
    lib: State<Library>,
    qdrant: State<Qdrant>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Track>, String>
```

1. Parsea query em `MoodFilters`
2. Se nenhum filtro extraído → retorna `Vec` vazio (sem fallback)
3. Chama `client.mood_search(&filters, limit)`
4. Resolve tracks via `lib.handle.track(id)`
5. Retorna `Vec<Track>`

### Frontend: search-bar.js

No `handleQuery` do contexto "global":

```javascript
const [results, semantic, mood] = await Promise.all([
    invoke("lib_search", { query: q, limit: 8 }),
    invoke("lib_semantic_search", { query: q, limit: 5 }).catch(() => []),
    invoke("lib_mood_search", { query: q, limit: 10 }).catch(() => []),
]);
renderGlobalResults(results, semantic, mood);
```

Na `renderGlobalResults`, nova seção "By Mood" após "By Lyrics". Deduplicação: remove IDs já presentes em tracks textuais e semânticos.

## Fora de Escopo

- Ollama como fallback para queries sem keyword match
- UI dedicada em Stations
- Ranking/scoring dos resultados de mood (filtro binário por agora)
- Criação de payload indexes no Qdrant (scroll funciona sem index para 983 pontos)
