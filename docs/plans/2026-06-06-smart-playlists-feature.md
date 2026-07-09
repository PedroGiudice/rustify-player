# Smart Playlists — Plano de Implementação TDD

> **Para o executor:** SKILL OBRIGATÓRIA: use `superpowers:executing-plans` antes de tocar qualquer arquivo.

**Goal:** Implementar smart playlists como feature real — regras avaliadas dinamicamente sobre o payload Qdrant — substituindo o mock visual hardcoded em `Playlists.tsx:99-103`.

**Arquitetura:**
- Persistência: diretório `~/.local/share/rustify-player/smart-playlists/` (um JSON por playlist), espelhando o padrão de `stations/` já estabelecido em `lib.rs:2939`.
- Avaliação: **lazy** — a lista de track IDs é computada no momento do `open` via scroll Qdrant com filtro range/match, não materializada em disco. Com 983 tracks e queries simples, a latência é < 100 ms.
- Predicados MVP: `play_count`, `last_played`, `indexed_at` (campo real confirmado em `pipeline.rs:601`), `liked_at` — todos presentes no payload Qdrant. Campo `indexed_at` não está no tipo `Track` do Rust (apenas no payload JSON); precisa ser adicionado ao tipo para queries.
- **Campo `date_added`/`added_at` NÃO existe** — o equivalente é `indexed_at` (i64 Unix timestamp em segundos). A regra "Recently added" usa `indexed_at`.

---

## Decisões de Design

### 1. Modelo de Regra

Campos confirmados no payload Qdrant (verificados em `pipeline.rs:573-602` e `query.rs:22-63`):

| Campo Qdrant | Tipo | Disponível no Track Rust? | Notas |
|---|---|---|---|
| `play_count` | u64 | Sim (`track.play_count`) | Na collection principal |
| `last_played` | i64 (Unix s) | Sim (`track.last_played`) | Na `track_enrichments` |
| `indexed_at` | i64 (Unix s) | **Não** (só no payload) | Precisa ser adicionado ao `Track` |
| `liked_at` | i64 (Unix s) | Sim (`track.liked_at`) | Na `track_enrichments` |
| `genre` | String | Sim (`track.genre_name`) | Campo Qdrant: `"genre"` |
| `album_year` | i64 | Sim (`track.album_year`) | Campo Qdrant: `"album_year"` |
| `duration_ms` | i64 | Sim (`track.duration_ms`) | |

Predicados MVP (Fase 1 — as 3 regras pre-definidas do mock):

```
"recently_added"  : indexed_at >= (now - N * 86400)   // "added >= N days"
"heavy_rotation"  : play_count >= K                    // "play_count >= K in library"
"never_played"    : play_count == 0 AND indexed_at >= (now - M * 86400)
```

Nota: `play_count` e `last_played` ficam na collection `rustify_tracks` principal (o `payload_to_track` lê de lá em `query.rs:58-60`). A função `resolve_tracks_with_enrichments` sobrescreve com dados da `track_enrichments` quando disponível. Para o MVP, as smart playlists lêem `play_count` direto da collection principal (suficiente — o `record_play` em `query.rs:388` atualiza a enrichments, mas o pipeline também persiste na track principal via `play_count` no payload).

### 2. Persistência

JSON por arquivo em `~/.local/share/rustify-player/smart-playlists/<id>.json`, padrão idêntico ao das stations. Justificativa: sem banco, sem migração, leitura trivial, backup fácil, o diretório `data_dir` já é gerenciado pelo app.

```json
{
  "id": "heavy-rotation-1717700000",
  "name": "Heavy rotation",
  "icon": "lucide:flame",
  "rule": {
    "kind": "play_count_gte",
    "threshold": 6
  },
  "created_at": 1717700000
}
```

Tipos de regra no MVP: `play_count_gte`, `recently_added_days`, `never_played_days`, `liked`. Fase 2 pode adicionar `genre_match`, `year_range`, etc.

### 3. Avaliação (Lazy)

No `lib_eval_smart_playlist(id)`:
1. Ler o JSON da playlist.
2. Converter a regra em filtro Qdrant (`{"must": [{"key": "play_count", "range": {"gte": 6}}]}`).
3. `scroll_all_with_filter(filter, &["path", "title", "artist", ...])`.
4. Retornar `Vec<Track>` (cobrindo cover path resolve).

Com 983 tracks e scroll paginado de 1000, uma passagem basta. Sem cache em disco — recomputar sempre é correto e barato. Se a biblioteca crescer para > 10k tracks, adicionar limit opcional.

### 4. Destino do Mock Durante Desenvolvimento

O mock visual (`SMART_PLAYLISTS`, `Playlists.tsx:99-103`) é **substituído gradualmente**:
- **Fase 1 concluída:** a table exibe dados reais das 3 playlists pre-definidas (criadas pelo backend na inicialização se o diretório estiver vazio).
- Durante o desenvolvimento (entre tasks), o mock fica como esqueleto gateado por uma flag — não convive com dados reais para evitar duplicação confusa.

### 5. Editor de Regra (Fase 2 — escopo mínimo)

Fase 2 entrega um editor simples: dropdown de campo + operador + valor numérico. Sem composer visual livre (isso seria Fase 3, dependente de decisão de produto). A UI de Fase 2 é um `<dialog>` modal com 3 controles inline, suficiente para criar/editar regras além das 3 pre-definidas.

---

## Faseamento

| Fase | Escopo | Testável? |
|------|--------|-----------|
| **Fase 1** | Backend: tipos Rust + 3 comandos + seeding das 3 defaults. Frontend: table real + click para abrir playlist. | Sim — testes de unidade Rust + render Solid |
| **Fase 2** | Editor modal de regra (campo + op + valor). Criar nova smart playlist pela UI. | Sim — testes de interação do editor |
| **Fase 3** | Predicados compostos (AND/OR), mais campos (genre, year, liked), ordenação. | Sim — testes de avaliação de filtros compostos |

Este plano cobre **Fase 1 completa** e **Fase 2** com código exato. Fase 3 é roadmap e não está detalhada aqui.

---

## Tasks

### Task 1 — Adicionar `indexed_at` ao tipo `Track` no Rust

**Arquivos:** `src-tauri/crates/library-indexer/src/types.rs`, `src-tauri/crates/library-indexer/src/query.rs`

**Por que:** `indexed_at` existe no payload Qdrant (`pipeline.rs:601`) mas não está no struct `Track` (confirmado em `types.rs:67-108`). Sem expor o campo não é possível filtrar por "recently added" sem scan caro.

**Steps:**

1. Escrever teste de unidade em `src-tauri/crates/library-indexer/src/query.rs` (módulo `#[cfg(test)]`) que verifica que `payload_to_track` lê o campo `indexed_at`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn payload_to_track_lê_indexed_at() {
        let p = json!({
            "path": "/music/foo.flac",
            "filename": "foo.flac",
            "title": "Foo",
            "disc_number": 1,
            "duration_ms": 180000,
            "sample_rate": 44100,
            "bit_depth": 16,
            "channels": 2,
            "embedding_status": "done",
            "indexed_at": 1717700000_i64
        });
        let t = payload_to_track(42, &p);
        assert_eq!(t.indexed_at, Some(1717700000));
    }
}
```

2. Rodar `cargo test -p library-indexer 2>&1 | tail -5` — deve falhar porque `Track` não tem `indexed_at`.

3. Em `src-tauri/crates/library-indexer/src/types.rs`, adicionar campo após `liked_at` (linha 105):

```rust
    pub liked_at: Option<i64>,

    /// Timestamp Unix (segundos) em que a track foi indexada pela primeira vez.
    /// Corresponde ao campo `indexed_at` do payload Qdrant.
    pub indexed_at: Option<i64>,

    pub lrc_path: Option<PathBuf>,
```

4. Em `src-tauri/crates/library-indexer/src/query.rs`, dentro de `payload_to_track`, adicionar após `liked_at:` (antes de `lrc_path:`):

```rust
        liked_at: p["liked_at"].as_i64(),
        indexed_at: p["indexed_at"].as_i64(),
        lrc_path: lrc_str,
```

5. Rodar `cargo test -p library-indexer 2>&1 | tail -5` — deve passar.

6. Rodar `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | grep "^error" | head -20` para verificar que nenhum outro código quebrou (o campo é aditivo, `..Default` não existe, mas o struct usa inicialização completa em todos os usos).

7. Se o passo 6 mostrar erros de inicialização incompleta do struct (ex: em testes internos que constroem `Track` literal), corrigir cada um adicionando `indexed_at: None`.

8. Commit: `feat(library-indexer): expõe indexed_at no tipo Track`.

---

### Task 2 — Tipos e persistência Rust para SmartPlaylist

**Arquivos:** `src-tauri/src/lib.rs`

**Steps:**

1. Escrever teste inline no `lib.rs` (módulo `#[cfg(test)]`) para validar serialização/deserialização do tipo `SmartPlaylist`:

```rust
#[cfg(test)]
mod smart_playlist_tests {
    use super::*;

    #[test]
    fn round_trip_json_play_count_gte() {
        let sp = SmartPlaylist {
            id: "heavy-rotation-1".to_string(),
            name: "Heavy rotation".to_string(),
            icon: "lucide:flame".to_string(),
            rule: SmartRule::PlayCountGte { threshold: 6 },
            created_at: 1717700000,
        };
        let json = serde_json::to_string(&sp).unwrap();
        let back: SmartPlaylist = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "heavy-rotation-1");
        match back.rule {
            SmartRule::PlayCountGte { threshold } => assert_eq!(threshold, 6),
            _ => panic!("wrong rule variant"),
        }
    }

    #[test]
    fn round_trip_json_recently_added() {
        let sp = SmartPlaylist {
            id: "recent-1".to_string(),
            name: "Recently added".to_string(),
            icon: "lucide:sparkles".to_string(),
            rule: SmartRule::RecentlyAddedDays { days: 14 },
            created_at: 1717700001,
        };
        let json = serde_json::to_string(&sp).unwrap();
        let back: SmartPlaylist = serde_json::from_str(&json).unwrap();
        match back.rule {
            SmartRule::RecentlyAddedDays { days } => assert_eq!(days, 14),
            _ => panic!("wrong rule variant"),
        }
    }
}
```

2. Rodar `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep "smart_playlist"` — deve falhar (tipos não existem).

3. Adicionar os tipos em `src-tauri/src/lib.rs`, após a seção de Station (após linha ~2937, antes de `stations_dir`). Inserir:

```rust
// ---------------------------------------------------------------------------
// Smart Playlists — tipos e I/O
// ---------------------------------------------------------------------------

/// Regra de avaliação de uma smart playlist.
/// `#[serde(tag = "kind", content = "params")]` permite JSON discriminado:
/// {"kind":"play_count_gte","params":{"threshold":6}}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SmartRule {
    PlayCountGte { threshold: u32 },
    RecentlyAddedDays { days: u32 },
    NeverPlayedDays { days: u32 },
    Liked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartPlaylist {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub rule: SmartRule,
    pub created_at: i64,
}

fn smart_playlists_dir(data_dir: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let dir = data_dir.join("smart-playlists");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn read_all_smart_playlists(data_dir: &std::path::Path) -> Vec<SmartPlaylist> {
    let dir = match smart_playlists_dir(data_dir) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(txt) = std::fs::read_to_string(&path) {
                if let Ok(sp) = serde_json::from_str::<SmartPlaylist>(&txt) {
                    result.push(sp);
                }
            }
        }
    }
    result.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    result
}

fn write_smart_playlist(data_dir: &std::path::Path, sp: &SmartPlaylist) -> Result<(), String> {
    let dir = smart_playlists_dir(data_dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", sp.id));
    let json = serde_json::to_string_pretty(sp).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Garante que as 3 playlists padrão existam (cria apenas se o diretório
/// estiver vazio, preservando customizações do usuário).
fn seed_default_smart_playlists(data_dir: &std::path::Path) {
    let existing = read_all_smart_playlists(data_dir);
    if !existing.is_empty() {
        return;
    }
    let defaults = [
        SmartPlaylist {
            id: "recently-added".to_string(),
            name: "Recently added".to_string(),
            icon: "lucide:sparkles".to_string(),
            rule: SmartRule::RecentlyAddedDays { days: 14 },
            created_at: 1,
        },
        SmartPlaylist {
            id: "heavy-rotation".to_string(),
            name: "Heavy rotation".to_string(),
            icon: "lucide:flame".to_string(),
            rule: SmartRule::PlayCountGte { threshold: 6 },
            created_at: 2,
        },
        SmartPlaylist {
            id: "never-played".to_string(),
            name: "Never played".to_string(),
            icon: "lucide:flask-conical".to_string(),
            rule: SmartRule::NeverPlayedDays { days: 60 },
            created_at: 3,
        },
    ];
    for sp in &defaults {
        let _ = write_smart_playlist(data_dir, sp);
    }
}
```

4. Rodar `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "smart_playlist|PASSED|FAILED"` — deve passar.

5. Rodar `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | grep "^error" | head -10`.

6. Commit: `feat(lib): tipos SmartPlaylist + persistência JSON (leitura/escrita/seed)`.

---

### Task 3 — Lógica de avaliação de regra (filtro Qdrant)

**Arquivos:** `src-tauri/src/lib.rs`

**Steps:**

1. Adicionar teste para a função de conversão de regra em filtro Qdrant:

```rust
// Dentro do mod smart_playlist_tests existente (Task 2):

    #[test]
    fn rule_para_qdrant_filter_play_count_gte() {
        let rule = SmartRule::PlayCountGte { threshold: 6 };
        let f = smart_rule_to_qdrant_filter(&rule, now_unix());
        let s = serde_json::to_string(&f).unwrap();
        assert!(s.contains("\"play_count\""), "deve filtrar por play_count");
        assert!(s.contains("\"gte\"") || s.contains("\"gt\""), "deve ter range gte/gt");
    }

    #[test]
    fn rule_para_qdrant_filter_recently_added() {
        let rule = SmartRule::RecentlyAddedDays { days: 14 };
        let now = 1717700000_i64;
        let f = smart_rule_to_qdrant_filter(&rule, now);
        let s = serde_json::to_string(&f).unwrap();
        assert!(s.contains("\"indexed_at\""), "deve filtrar por indexed_at");
        let expected_cutoff = now - (14 * 86400);
        assert!(s.contains(&expected_cutoff.to_string()), "cutoff deve ser now - 14d");
    }

    #[test]
    fn rule_para_qdrant_filter_never_played() {
        let rule = SmartRule::NeverPlayedDays { days: 60 };
        let now = 1717700000_i64;
        let f = smart_rule_to_qdrant_filter(&rule, now);
        let s = serde_json::to_string(&f).unwrap();
        assert!(s.contains("\"play_count\""), "deve incluir play_count == 0");
        assert!(s.contains("\"indexed_at\""), "deve incluir indexed_at");
    }

    #[test]
    fn rule_para_qdrant_filter_liked() {
        let rule = SmartRule::Liked;
        let f = smart_rule_to_qdrant_filter(&rule, now_unix());
        let s = serde_json::to_string(&f).unwrap();
        assert!(s.contains("\"liked_at\""), "deve filtrar por liked_at");
    }
```

2. Rodar `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "rule_para|FAILED"` — deve falhar.

3. Adicionar a função `smart_rule_to_qdrant_filter` em `src-tauri/src/lib.rs`, dentro da seção Smart Playlists (após `seed_default_smart_playlists`):

```rust
/// Converte uma SmartRule em filtro Qdrant (formato JSON da REST API).
/// `now_secs` é Unix timestamp em segundos (parametrizado para testabilidade).
fn smart_rule_to_qdrant_filter(rule: &SmartRule, now_secs: i64) -> serde_json::Value {
    use serde_json::json;
    match rule {
        SmartRule::PlayCountGte { threshold } => json!({
            "must": [
                { "key": "play_count", "range": { "gte": threshold } }
            ]
        }),
        SmartRule::RecentlyAddedDays { days } => {
            let cutoff = now_secs - (*days as i64 * 86400);
            json!({
                "must": [
                    { "key": "indexed_at", "range": { "gte": cutoff } }
                ]
            })
        }
        SmartRule::NeverPlayedDays { days } => {
            let cutoff = now_secs - (*days as i64 * 86400);
            json!({
                "must": [
                    { "key": "play_count", "match": { "value": 0 } },
                    { "key": "indexed_at", "range": { "gte": cutoff } }
                ]
            })
        }
        SmartRule::Liked => json!({
            "must": [
                { "key": "liked_at", "range": { "gt": 0 } }
            ]
        }),
    }
}
```

4. Rodar `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "smart_playlist|rule_para|PASSED|FAILED"` — deve passar.

5. Commit: `feat(lib): smart_rule_to_qdrant_filter com 4 predicados MVP`.

---

### Task 4 — Comandos Tauri: list, eval, create, delete

**Arquivos:** `src-tauri/src/lib.rs`

**Steps:**

1. Adicionar os 4 comandos após a seção de funções helper (após `smart_rule_to_qdrant_filter`):

```rust
// ── Commands de smart playlists ──────────────────────────────────────────────

#[tauri::command]
fn lib_list_smart_playlists(lib: State<Library>) -> Vec<SmartPlaylist> {
    seed_default_smart_playlists(&lib.data_dir);
    read_all_smart_playlists(&lib.data_dir)
}

#[tauri::command]
fn lib_eval_smart_playlist(
    lib: State<Library>,
    id: String,
) -> Result<Vec<Track>, String> {
    let playlists = read_all_smart_playlists(&lib.data_dir);
    let sp = playlists
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("smart playlist '{id}' não encontrada"))?;

    let now = now_unix();
    let filter = smart_rule_to_qdrant_filter(&sp.rule, now);
    let client = lib.handle.client();

    // Campos mínimos necessários para payload_to_track
    let fields = &[
        "path", "filename", "title", "track_number", "disc_number",
        "duration_ms", "album_title", "album_year", "cover_path",
        "artist", "genre", "tags", "sample_rate", "bit_depth", "channels",
        "rg_track_gain", "rg_album_gain", "rg_track_peak", "rg_album_peak",
        "lufs_integrated", "embedding_status", "play_count", "last_played",
        "liked_at", "indexed_at", "lrc_path",
    ];

    let results = client
        .scroll_all_with_filter(filter, fields)
        .map_err(|e| e.to_string())?;

    let mut tracks: Vec<Track> = results
        .iter()
        .map(|(id, payload)| library_indexer::payload_to_track(*id, payload))
        .collect();

    // Resolve caminhos absolutos de cover
    for track in &mut tracks {
        if let Some(rel) = &track.album_cover_path {
            track.album_cover_path = Some(lib.cache_dir.join(rel));
        }
    }

    Ok(tracks)
}

#[tauri::command]
fn lib_create_smart_playlist(
    lib: State<Library>,
    name: String,
    icon: Option<String>,
    rule_kind: String,
    rule_threshold: Option<u32>,
    rule_days: Option<u32>,
) -> Result<SmartPlaylist, String> {
    let rule = match rule_kind.as_str() {
        "play_count_gte" => SmartRule::PlayCountGte {
            threshold: rule_threshold.unwrap_or(5),
        },
        "recently_added_days" => SmartRule::RecentlyAddedDays {
            days: rule_days.unwrap_or(30),
        },
        "never_played_days" => SmartRule::NeverPlayedDays {
            days: rule_days.unwrap_or(60),
        },
        "liked" => SmartRule::Liked,
        other => return Err(format!("rule_kind inválido: '{other}'")),
    };

    let slug: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let ts = now_unix();
    let id = format!("{slug}-{ts}");

    let sp = SmartPlaylist {
        id,
        name,
        icon: icon.unwrap_or_else(|| "lucide:sparkles".to_string()),
        rule,
        created_at: ts,
    };
    write_smart_playlist(&lib.data_dir, &sp)?;
    Ok(sp)
}

#[tauri::command]
fn lib_delete_smart_playlist(lib: State<Library>, id: String) -> Result<bool, String> {
    let dir = smart_playlists_dir(&lib.data_dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        Ok(true)
    } else {
        Ok(false)
    }
}
```

2. Registrar os 4 comandos no `generate_handler!` em `lib.rs:2888` (após `lib_play_station`):

```rust
            lib_list_smart_playlists,
            lib_eval_smart_playlist,
            lib_create_smart_playlist,
            lib_delete_smart_playlist,
```

3. O `payload_to_track` em `library-indexer` é pub(crate). Para usá-lo no lib.rs, verificar se `IndexerHandle` expõe um método de avaliação ou se precisamos expor `payload_to_track` como `pub`. Verificar com:

```bash
grep -n "pub.*payload_to_track\|pub(crate).*payload_to_track" src-tauri/crates/library-indexer/src/query.rs
```

Se for `pub(crate)`, adicionar ao `lib.rs` da crate `library-indexer` uma função pública wrapper, em `src-tauri/crates/library-indexer/src/lib.rs`:

```rust
pub use crate::query::payload_to_track;
```

4. Rodar `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | grep "^error" | head -20`.

5. Corrigir erros de visibilidade conforme necessário.

6. Commit: `feat(lib): comandos lib_list/eval/create/delete_smart_playlist`.

---

### Task 5 — Wrappers TypeScript em tauri.ts

**Arquivos:** `src/tauri.ts`

**Steps:**

1. Adicionar os tipos e wrappers após a seção de Stations (após linha ~373 em `src/tauri.ts`):

```typescript
// ── Smart Playlists ───────────────────────────────────────────────────────────

export type SmartRuleKind =
  | "play_count_gte"
  | "recently_added_days"
  | "never_played_days"
  | "liked";

export interface SmartRule {
  kind: SmartRuleKind;
  // play_count_gte
  threshold?: number;
  // recently_added_days | never_played_days
  days?: number;
}

export interface SmartPlaylist {
  id: string;
  name: string;
  icon: string;
  rule: SmartRule;
  created_at: number;
}

export const libListSmartPlaylists = () =>
  invoke<SmartPlaylist[]>("lib_list_smart_playlists");

export const libEvalSmartPlaylist = (id: string) =>
  invoke<Track[]>("lib_eval_smart_playlist", { id });

export const libCreateSmartPlaylist = (params: {
  name: string;
  icon?: string;
  ruleKind: SmartRuleKind;
  ruleThreshold?: number;
  ruleDays?: number;
}) =>
  invoke<SmartPlaylist>("lib_create_smart_playlist", {
    name: params.name,
    icon: params.icon,
    ruleKind: params.ruleKind,
    ruleThreshold: params.ruleThreshold,
    ruleDays: params.ruleDays,
  });

export const libDeleteSmartPlaylist = (id: string) =>
  invoke<boolean>("lib_delete_smart_playlist", { id });
```

2. Não há teste unitário para este arquivo (é só wrappers de invoke). A cobertura vem do teste de integração da view (Task 6).

3. Commit: `feat(tauri.ts): wrappers SmartPlaylist (list/eval/create/delete)`.

---

### Task 6 — Frontend: substituir mock por dados reais em Playlists.tsx

**Arquivos:** `src/views/Playlists.tsx`, `src/views/Playlists.test.tsx`

**Objetivo:** substituir `SMART_PLAYLISTS` hardcoded por `createResource` + `libListSmartPlaylists`. A tabela continua com o mesmo layout CSS (`smart-tbl`); os dados vêm do backend.

**Steps:**

1. Escrever testes atualizados em `src/views/Playlists.test.tsx`. Substituir o arquivo inteiro:

```tsx
/* ============================================================
   Playlists.test.tsx — Testes da view com smart playlists reais.
   ============================================================ */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

const MOCK_SMART: import("../tauri").SmartPlaylist[] = [
  {
    id: "recently-added",
    name: "Recently added",
    icon: "lucide:sparkles",
    rule: { kind: "recently_added_days", days: 14 },
    created_at: 1,
  },
  {
    id: "heavy-rotation",
    name: "Heavy rotation",
    icon: "lucide:flame",
    rule: { kind: "play_count_gte", threshold: 6 },
    created_at: 2,
  },
  {
    id: "never-played",
    name: "Never played",
    icon: "lucide:flask-conical",
    rule: { kind: "never_played_days", days: 60 },
    created_at: 3,
  },
];

vi.mock("../tauri", () => ({
  libListFolders: vi.fn().mockResolvedValue([]),
  libListSmartPlaylists: vi.fn().mockResolvedValue(MOCK_SMART),
  libEvalSmartPlaylist: vi.fn().mockResolvedValue([]),
  libCreateSmartPlaylist: vi.fn().mockResolvedValue(MOCK_SMART[0]),
}));

import { isPinned, togglePin, pins } from "../store/pins";
vi.mock("../store/pins", () => ({
  isPinned: vi.fn().mockReturnValue(false),
  togglePin: vi.fn(),
  pins: vi.fn().mockReturnValue([]),
}));

vi.mock("../router", () => ({ navigate: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import Playlists from "./Playlists";

describe("Playlists view", () => {
  it("renderiza heading e subtitle", () => {
    const { getByText } = render(() => <Playlists />);
    expect(getByText("Playlists")).toBeTruthy();
  });

  it("renderiza toolbar com search input e 3 botões", () => {
    const { container, getByPlaceholderText } = render(() => <Playlists />);
    expect(container.querySelector(".coll-toolbar")).toBeTruthy();
    expect(getByPlaceholderText("Filter playlists…")).toBeTruthy();
    const buttons = container.querySelectorAll(".coll-toolbar .sig-pbtn");
    expect(buttons.length).toBe(3);
  });

  it("renderiza Smart playlists table com dados do backend (3 rows)", async () => {
    const { container } = render(() => <Playlists />);
    // Aguarda resolução do createResource
    await new Promise((r) => setTimeout(r, 0));
    const tbl = container.querySelector(".smart-tbl");
    expect(tbl).toBeTruthy();
    const rows = tbl!.querySelectorAll(".smart-tbl__row");
    expect(rows.length).toBe(3);
    expect(rows[0].querySelector(".smart-tbl__name")!.textContent).toBe(
      "Recently added"
    );
  });

  it("renderiza All playlists section com card pl-card--new", () => {
    const { container } = render(() => <Playlists />);
    const allSection = Array.from(
      container.querySelectorAll(".section__title")
    ).find((h) => (h.textContent ?? "").toLowerCase().startsWith("all playlists"));
    expect(allSection).toBeTruthy();
    const newCard = allSection!
      .closest("section")
      ?.querySelector(".pl-card--new");
    expect(newCard).toBeTruthy();
  });

  it("exibe descrição textual da regra na coluna Rule", async () => {
    const { container } = render(() => <Playlists />);
    await new Promise((r) => setTimeout(r, 0));
    const rules = container.querySelectorAll(".smart-tbl__rule");
    expect(rules.length).toBe(3);
    // A regra da first row deve conter algo legível
    expect(rules[0].textContent!.length).toBeGreaterThan(0);
  });
});
```

2. Rodar `bun test src/views/Playlists.test.tsx 2>&1 | tail -20` — deve falhar porque `Playlists.tsx` ainda usa o mock.

3. Reescrever `src/views/Playlists.tsx`. Substituir o bloco mock (linhas 90-103) e atualizar as importações e a section de Smart Playlists. A seção de Smart Playlists da view passa a ser:

```tsx
import {
  createMemo, createResource, createSignal, For, Show
} from "solid-js";
import {
  libListFolders, libListSmartPlaylists, libEvalSmartPlaylist,
  coverUrl,
  type FolderPlaylist, type SmartPlaylist, type SmartRuleKind,
} from "../tauri";
import { isPinned, togglePin, pins } from "../store/pins";
import { navigate } from "../router";
```

Função auxiliar para descrição textual da regra (adicionar após os helpers de tone):

```tsx
function ruleDescription(sp: SmartPlaylist): string {
  const r = sp.rule;
  switch (r.kind) {
    case "play_count_gte":
      return `play_count >= ${r.threshold ?? 1}`;
    case "recently_added_days":
      return `added >= ${r.days ?? 14} days · sort by date desc`;
    case "never_played_days":
      return `play_count == 0 · added < ${r.days ?? 60} days`;
    case "liked":
      return "liked_at is set";
    default:
      return "";
  }
}
```

Na função `Playlists()`, substituir o `SMART_PLAYLISTS` mock por resource real:

```tsx
const [smartPlaylists] = createResource(
  () => libListSmartPlaylists().catch(() => [] as SmartPlaylist[])
);
```

E atualizar o `totalSmart`:

```tsx
const totalSmart = () => (smartPlaylists() ?? []).length;
```

Na seção Smart Playlists do JSX, substituir o `<For each={SMART_PLAYLISTS}>` por:

```tsx
<section>
  <div class="section__head">
    <h2 class="section__title">
      Smart playlists · rule-based
    </h2>
    <a class="section__action" onClick={() => {/* Fase 2: abre editor */}}>
      New smart playlist +
    </a>
  </div>
  <Show when={!smartPlaylists.loading} fallback={
    <p style={{ color: "var(--fg-5)", "font-size": "13px" }}>Carregando…</p>
  }>
    <table class="smart-tbl">
      <thead>
        <tr>
          <th class="smart-tbl__head" aria-label="icon"></th>
          <th class="smart-tbl__head">Name</th>
          <th class="smart-tbl__head">Rule</th>
          <th class="smart-tbl__head smart-tbl__head--num">Tracks</th>
        </tr>
      </thead>
      <tbody>
        <For each={smartPlaylists() ?? []}>
          {(sp) => (
            <SmartPlaylistRow playlist={sp} cacheDir={lib.cache_dir} />
          )}
        </For>
      </tbody>
    </table>
  </Show>
</section>
```

Componente `SmartPlaylistRow` (lazy eval ao clicar — não avalia todas ao carregar a view):

```tsx
function SmartPlaylistRow(props: { playlist: SmartPlaylist }) {
  const [tracks, setTracks] = createSignal<import("../tauri").Track[] | null>(null);
  const [loading, setLoading] = createSignal(false);

  async function handleClick() {
    if (tracks() !== null) return; // já carregado
    setLoading(true);
    try {
      const t = await libEvalSmartPlaylist(props.playlist.id);
      setTracks(t);
    } finally {
      setLoading(false);
    }
  }

  return (
    <tr
      class="smart-tbl__row"
      style={{ cursor: "pointer" }}
      onClick={handleClick}
    >
      <td class="smart-tbl__icon">
        {/* @ts-ignore */}
        <iconify-icon icon={props.playlist.icon} noobserver />
      </td>
      <td class="smart-tbl__name">{props.playlist.name}</td>
      <td class="smart-tbl__rule">{ruleDescription(props.playlist)}</td>
      <td class="smart-tbl__count">
        {loading()
          ? "…"
          : tracks() !== null
          ? tracks()!.length
          : "—"}
      </td>
    </tr>
  );
}
```

Nota: a coluna "Updated" e "Length" do mock são removidas por enquanto (não há dado real disponível sem eval). A tabela fica com 4 colunas. Atualizar o CSS se necessário (remover `.smart-tbl__head--num` extra se quebrar layout — verificar em `dist/assets/*.css` após build).

4. Rodar `bun test src/views/Playlists.test.tsx 2>&1 | tail -20` — deve passar.

5. Verificar que o teste de Smart playlists não referencia mais as colunas "Updated" / "Length" que foram removidas. Ajustar o teste se necessário.

6. Commit: `feat(ui): Playlists.tsx exibe smart playlists reais via lib_list_smart_playlists`.

---

### Task 7 — Inicialização: seed das 3 defaults no boot do app

**Arquivos:** `src-tauri/src/lib.rs`

**Objetivo:** chamar `seed_default_smart_playlists` uma vez no boot para que o usuário já encontre as 3 playlists na primeira abertura, sem precisar criá-las manualmente.

**Steps:**

1. Localizar onde o app é inicializado em `lib.rs`. A inicialização está em `tauri::Builder::default()...setup(|app| { ... })`. Buscar:

```bash
grep -n "setup\|data_dir\|QdrantProcess\|seed" src-tauri/src/lib.rs | head -30
```

2. No bloco `setup`, após a linha que cria `data_dir` (linha ~2255), adicionar:

```rust
// Garante que as 3 smart playlists padrão existam.
seed_default_smart_playlists(&data_dir);
```

3. Rodar `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | grep "^error" | head -10`.

4. Verificar que o `lib_list_smart_playlists` também chama `seed_default_smart_playlists` internamente (já está na Task 4) — assim o seed ocorre mesmo se o setup falhar silenciosamente ou for chamado fora de ordem.

5. Commit: `feat(boot): seed_default_smart_playlists no setup do app`.

---

### Task 8 — Verificação pós-build de CSS

**Arquivos:** build (verificação, não edita código)

**Steps:**

1. Confirmar que as classes CSS da tabela (`smart-tbl`, `smart-tbl__row`, `smart-tbl__name`, `smart-tbl__rule`, `smart-tbl__icon`, `smart-tbl__count`) existem em `src/styles/extractor-lab.css`:

```bash
grep -n "smart-tbl" /home/opc/rustify-player/src/styles/extractor-lab.css | head -20
```

2. Se as classes CSS não existirem no arquivo (foram definidas apenas inline ou em `components.css` órfão), adicioná-las em `src/styles/extractor-lab.css`. O CSS mínimo necessário (se ausente):

```css
/* ── Smart playlist table ─────────────────────────────── */
.smart-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.smart-tbl__head {
  text-align: left;
  padding: 4px 8px;
  color: var(--fg-5);
  font-weight: 500;
  border-bottom: 1px solid var(--border);
}
.smart-tbl__head--num { text-align: right; }
.smart-tbl__row { border-bottom: 1px solid var(--border-faint, var(--border)); }
.smart-tbl__row:hover { background: var(--hover-bg, rgba(255,255,255,0.04)); }
.smart-tbl__icon { padding: 8px; width: 32px; color: var(--fg-4); }
.smart-tbl__name { padding: 8px; font-weight: 500; }
.smart-tbl__rule { padding: 8px; color: var(--fg-5); font-family: var(--font-mono); font-size: 11px; }
.smart-tbl__count { padding: 8px; text-align: right; color: var(--fg-4); }
```

3. Após qualquer adição de CSS, rodar o build e verificar:

```bash
# Após ./scripts/release.sh ou equivalente de build frontend:
rg "smart-tbl" dist/assets/*.css
```

Se vazio: o arquivo `components.css` foi acidentalmente referenciado. Confirmar que `extractor-lab.css` é o arquivo correto importado por `main.tsx`.

4. Commit se CSS foi adicionado: `style(css): smart-tbl classes em extractor-lab.css`.

---

### Task 9 — Fase 2: Editor modal de nova smart playlist (escopo mínimo)

> Esta task implementa a Fase 2 — editor simples para criar playlists além das 3 defaults.

**Arquivos:** `src/views/Playlists.tsx`, `src/styles/extractor-lab.css`

**Steps:**

1. Adicionar teste para o editor em `src/views/Playlists.test.tsx`:

```tsx
  it("clicar em 'New smart playlist' abre o modal editor", async () => {
    const { container, getByText } = render(() => <Playlists />);
    await new Promise((r) => setTimeout(r, 0));
    const btn = getByText(/New smart playlist/i);
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    const dialog = container.querySelector(".smart-editor-dialog");
    expect(dialog).toBeTruthy();
  });

  it("form de criação valida campos antes de submeter", async () => {
    const libCreate = vi.mocked(
      (await import("../tauri")).libCreateSmartPlaylist
    );
    const { container, getByText } = render(() => <Playlists />);
    await new Promise((r) => setTimeout(r, 0));
    getByText(/New smart playlist/i).click();
    await new Promise((r) => setTimeout(r, 0));
    // Submit sem nome deve não chamar libCreateSmartPlaylist
    const submitBtn = container.querySelector(".smart-editor-dialog [type=submit]");
    submitBtn?.click();
    expect(libCreate).not.toHaveBeenCalled();
  });
```

2. Rodar `bun test src/views/Playlists.test.tsx 2>&1 | tail -15` — deve falhar.

3. Implementar o componente `SmartPlaylistEditor` em `src/views/Playlists.tsx`:

```tsx
function SmartPlaylistEditor(props: { onClose: () => void; onCreated: (sp: SmartPlaylist) => void }) {
  const [name, setName] = createSignal("");
  const [ruleKind, setRuleKind] = createSignal<SmartRuleKind>("play_count_gte");
  const [threshold, setThreshold] = createSignal(5);
  const [days, setDays] = createSignal(30);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!name().trim()) {
      setError("Nome obrigatório.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const sp = await libCreateSmartPlaylist({
        name: name().trim(),
        ruleKind: ruleKind(),
        ruleThreshold: ruleKind() === "play_count_gte" ? threshold() : undefined,
        ruleDays: (ruleKind() === "recently_added_days" || ruleKind() === "never_played_days")
          ? days()
          : undefined,
      });
      props.onCreated(sp);
      props.onClose();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="smart-editor-overlay" onClick={props.onClose}>
      <form
        class="smart-editor-dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 style={{ margin: "0 0 12px" }}>Nova smart playlist</h3>

        <label class="smart-editor-label">
          Nome
          <input
            class="smart-editor-input"
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="Ex: Favoritos recentes"
            required
          />
        </label>

        <label class="smart-editor-label">
          Regra
          <select
            class="smart-editor-select"
            value={ruleKind()}
            onChange={(e) => setRuleKind(e.currentTarget.value as SmartRuleKind)}
          >
            <option value="play_count_gte">Play count ≥ N</option>
            <option value="recently_added_days">Adicionada nos últimos N dias</option>
            <option value="never_played_days">Nunca tocada (adicionada < N dias)</option>
            <option value="liked">Curtida</option>
          </select>
        </label>

        <Show when={ruleKind() === "play_count_gte"}>
          <label class="smart-editor-label">
            Mínimo de plays
            <input
              class="smart-editor-input"
              type="number"
              min="1"
              max="999"
              value={threshold()}
              onInput={(e) => setThreshold(parseInt(e.currentTarget.value) || 1)}
            />
          </label>
        </Show>

        <Show when={ruleKind() === "recently_added_days" || ruleKind() === "never_played_days"}>
          <label class="smart-editor-label">
            Janela de dias
            <input
              class="smart-editor-input"
              type="number"
              min="1"
              max="3650"
              value={days()}
              onInput={(e) => setDays(parseInt(e.currentTarget.value) || 1)}
            />
          </label>
        </Show>

        <Show when={error()}>
          <p style={{ color: "var(--accent-red, red)", "font-size": "12px" }}>{error()}</p>
        </Show>

        <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end", "margin-top": "16px" }}>
          <button type="button" class="sig-pbtn" onClick={props.onClose}>
            Cancelar
          </button>
          <button type="submit" class="sig-pbtn sig-pbtn--primary" disabled={saving()}>
            {saving() ? "Criando…" : "Criar"}
          </button>
        </div>
      </form>
    </div>
  );
}
```

4. Em `Playlists()`, adicionar signal de controle do editor:

```tsx
const [showEditor, setShowEditor] = createSignal(false);
const [smartPlaylists, { refetch: refetchSmart }] = createResource(
  () => libListSmartPlaylists().catch(() => [] as SmartPlaylist[])
);
```

Alterar o botão "New smart playlist" para:

```tsx
<button class="sig-pbtn" type="button" onClick={() => setShowEditor(true)}>
  {/* @ts-ignore */}
  <iconify-icon icon="lucide:sparkles" noobserver />
  New smart playlist
</button>
```

Adicionar o modal ao JSX (fora do `<article>`, usando portal ou inline antes do `</article>`):

```tsx
<Show when={showEditor()}>
  <SmartPlaylistEditor
    onClose={() => setShowEditor(false)}
    onCreated={() => { refetchSmart(); setShowEditor(false); }}
  />
</Show>
```

5. Adicionar CSS do editor em `src/styles/extractor-lab.css`:

```css
/* ── Smart playlist editor modal ─────────────────────────── */
.smart-editor-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.smart-editor-dialog {
  background: var(--bg-surface, var(--bg-1));
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px 24px;
  width: 340px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.smart-editor-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--fg-4);
}
.smart-editor-input,
.smart-editor-select {
  background: var(--bg-2, var(--bg-1));
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-1);
  font-size: 13px;
  padding: 5px 8px;
}
.smart-editor-input:focus,
.smart-editor-select:focus {
  outline: 1px solid var(--accent);
}
```

6. Verificar CSS no bundle:

```bash
rg "smart-editor-dialog" dist/assets/*.css
```

7. Rodar `bun test src/views/Playlists.test.tsx 2>&1 | tail -20` — deve passar.

8. Commit: `feat(ui): editor modal de nova smart playlist (Fase 2)`.

---

## Critérios de Aceite (por fase)

### Fase 1 (Tasks 1-8 exceto Task 9)

- `cargo test -p library-indexer` passa sem erros.
- `cargo test --manifest-path src-tauri/Cargo.toml` passa sem erros.
- `bun test src/views/Playlists.test.tsx` passa (4 testes).
- A view `Playlists` exibe 3 smart playlists reais ao abrir.
- Clicar em uma row avalia a playlist e exibe a contagem de tracks.
- `rg "SMART_PLAYLISTS" src/views/Playlists.tsx` retorna zero — mock hardcoded removido.
- `rg "smart-tbl" dist/assets/*.css` retorna ao menos 1 match — CSS no bundle.

### Fase 2 (Task 9)

- `bun test src/views/Playlists.test.tsx` passa (6 testes).
- Clicar em "New smart playlist" abre o modal.
- Criar uma playlist com play_count_gte:3 a persiste em `~/.local/share/rustify-player/smart-playlists/` e a exibe na table.
- Fechar o modal sem preencher o nome não chama o backend.

---

## Ordem de Execução

```
Task 1 (indexed_at no tipo Track)
  └─ Task 2 (tipos SmartPlaylist + persistência)
       └─ Task 3 (smart_rule_to_qdrant_filter)
            └─ Task 4 (comandos Tauri)
                 └─ Task 5 (wrappers TS)
                      └─ Task 6 (frontend — view real)
                           └─ Task 7 (seed no boot)
                                └─ Task 8 (verificação CSS)
                                     └─ Task 9 (Fase 2 — editor)
```

Todas as tasks são sequenciais (cada uma depende da anterior). Não paralelizar.

---

## Riscos

1. **`payload_to_track` é `pub(crate)`**: o `lib_eval_smart_playlist` em `src-tauri/src/lib.rs` precisa chamá-lo. Se não for reexportado pela crate `library-indexer`, é necessário adicionar `pub use crate::query::payload_to_track;` em `src-tauri/crates/library-indexer/src/lib.rs`. Task 4 inclui verificação explícita desse ponto.

2. **`play_count` na collection principal vs enrichments**: o `payload_to_track` lê `play_count` do payload da collection `rustify_tracks`. O `record_play` atualiza a `track_enrichments`. Pode haver dessincronização. Para o MVP isso é aceitável; se for problema, `lib_eval_smart_playlist` pode cruzar com enrichments — mas isso complica a query e não é necessário agora.

3. **`indexed_at` ausente em tracks antigas**: tracks indexadas antes da landing do campo (pipeline.rs:601 introduziu `indexed_at`) não terão o campo no payload. O filtro Qdrant range em campo ausente retorna 0 resultados para essas tracks — comportamento correto (elas não têm data de indexação conhecida). Não é bug, é dado incompleto.

4. **CSS `components.css` órfão**: se o CSS da tabela estiver apenas em `components.css`, as classes somem do bundle. Task 8 verifica explicitamente com `rg "smart-tbl" dist/assets/*.css`.

---

## Open Questions (para o CEO)

1. **Faz sentido implementar a Fase 2 (editor) agora?** As 3 playlists pre-definidas cobrem os casos mais comuns. Se a biblioteca for estável, o usuário pode não precisar criar novas regras. A Fase 1 pode ser suficiente por enquanto.

2. **Quais predicados além dos 4 do MVP têm prioridade?** Candidatos: `genre_match`, `year_range` (ex: "álbuns de 2020-2024"), `artist_match`, `duration_gte/lte`. Qual deles faz mais sentido para a coleção atual (~983 tracks)?

3. **Clicar na row da smart playlist deve abrir uma view dedicada (como `/playlist/<name>`)** ou apenas exibir a contagem inline e tocar a playlist diretamente? A Fase 1 só avalia e exibe a contagem; navegar para uma view de tracks exigiria uma rota nova.

4. **O threshold de "Heavy rotation" (play_count >= 6) e a janela de "Recently added" (14 dias) são os valores corretos para a sua biblioteca?** São os valores do mock original — confirmar se representam o comportamento esperado antes de fazer o seed.
