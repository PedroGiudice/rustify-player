# Crate — busca e download Soulseek dentro do Rustify (spec)

**Data:** 2026-08-07
**Status:** Design APROVADO pelo usuário em 2026-08-07 ("escreve, planeja e executa. approved."). Spike da API (§3.1) EXECUTADO — resultados no adendo abaixo. Implementação autorizada.
**Método:** workflow multi-agente (3 propostas independentes: produto, engenharia, minimal × 3 juízes: engenharia, produto, risco × síntese). Vereditos: engenharia venceu 2–1; UX enxertada da proposta produto; guard-rails e degradação da minimal.

## Adendo — spike da API executado (2026-08-07, slskd 0.25.1 real da cmr-auto)

Fixtures reais em `docs/soulseek/api-fixtures/{spike-responses,spike-transfers}.json`. As quatro perguntas do §3.1, respondidas:

1. **`web.authentication.apiKeys` EXISTE** (objeto vazio hoje). v1: JWT com re-login single-shot (funciona sem tocar o yml); `RUSTIFY_SLSKD_API_KEY` passa a valer quando alguém configurar uma key no slskd.yml. Token JWT de sessão tem ~536 chars.
2. **Shape de `responses[]`:** `{username, fileCount, files[], hasFreeUploadSlot, lockedFileCount, lockedFiles[], queueLength, token, uploadSpeed}`. `files[]`: `{filename, size, extension, bitDepth, sampleRate, length, code, isLocked}`. **`filename` remoto usa BACKSLASH** (`VARIETY\Robert Miles\EP\(1995) Soundtracks\01 - Children.flac`) — todo parse de basename/diretório em `rank.rs` e `stage.rs` divide por `\` E `/`.
3. **Estados reais observados em `/transfers/downloads`:** `"Completed, Succeeded"`, `"Completed, Errored"`, `"Completed, Aborted"`, e (dos logs de runs) `"Queued, Remotely"` — composição `"<fase>, <detalhe>"`; `classify_transfer_state` por substring confirmada como abordagem certa. Campos úteis diretos: `percentComplete`, `bytesTransferred`, `averageSpeed`, `bytesRemaining`, `exception` (motivo legível), `requestedAt/enqueuedAt/startedAt/endedAt`. Transfer file tem `id` próprio (UUID).
4. **NÃO há campo de path local no transfer.** Porém a regra local do slskd é determinística e foi confirmada nos dados: **pasta local = última componente de diretório do path remoto** (`...\(1995) Soundtracks\01 - Children.flac` → `~/slskd_dados/downloads/(1995) Soundtracks/01 - Children.flac`). §5.2 fica: degrau 1 = predição determinística (última-pasta + basename); degrau 2 = varredura `mtime > started_at` + basename case-insensitive; degrau 3 = `Manual`. `container_prefix` da config fica reservado (não necessário no layout atual — bind mount 1:1).

---

## Resumo executivo

Busca e download da rede Soulseek viram uma feature do app: uma view nova (**Crate**, rota `/crate`), um crate Rust novo (`slskd-client`, protocolo puro e testável offline), um módulo de orquestração no app (`src-tauri/src/slsk/`) e um pipeline de staging que absorve o `scripts/curator/stage_downloads.py` inteiro em Rust.

O laço fecha dentro do app: **digitar → escolher a faixa → um clique → a linha vira `▸ Tocar`**. Sem terminal, sem CSV, sem Claude.

Três decisões carregam o desenho:

1. **A view mostra faixas, não arquivos.** Resultados agregados por `(artista, título)`, os N peers escondidos atrás de uma escolha automática revisável. É o que faz a feature parecer nativa em vez de um Nicotine colado na lateral.
2. **Staging em pasta oculta sob `~/Music` + `rename` atômico.** `scan.rs:58` (`filter_entry(|e| e.depth() == 0 || !is_hidden(e.path()))`) e `watch.rs:163` (`!has_hidden_component(p)`) já ignoram componentes com ponto — a race de arquivo parcial deixa de existir por construção, não por timing.
3. **Indexação determinística via `IndexerCommand::IngestPaths` com reply channel.** O enum hoje é literalmente `{ Rescan, Shutdown }` (`types.rs:164`). A variante nova devolve `Result<u64, String>` por path — a diferença entre "a faixa aparece, eventualmente" e "a faixa está tocável, e eu sei disso".

Nenhuma dependência nova: `ureq`, `serde`, `serde_json`, `thiserror`, `tracing`, `crossbeam-channel`, `strsim`, `tempfile` já estão em `[workspace.dependencies]`.

---

## Decisão e racional

**Vencedora agregada: proposta `engenharia`** (juiz-engenharia e juiz-risco votaram nela; juiz-produto votou em `produto`). Maioria 2–1.

Os três vereditos convergem no mesmo desenho de entrega, e é o que este documento implementa:

- O juiz-produto, ao votar contra a engenharia, escreveu explicitamente a receita: *"v1 = UX, ranking, dedup-como-delight, sugestão de destino, ⌘K e fases da PRODUTO; backend de staging/ingest/persistência da ENGENHARIA; e da MINIMAL a localização do arquivo baixado + estado `Manual`, o probe de decode antes de mover e a quarentena oculta."*
- O juiz-risco confirmou o mesmo do outro lado: *"ela NÃO é entregável sem os enxertos 1-3 da minimal, especialmente o do path de container, que é blocker de day-one."*
- O juiz-engenharia validou o núcleo da vencedora contra o código (`.rustify-incoming`, `IngestPaths`, `subscribe()` como MPMC, `canonical_dest` de 4 níveis) e localizou as fraquezas que este doc resolve uma a uma.

**Base:** arquitetura, staging e indexação da `engenharia`.
**Enxertado de `produto`:** a camada de UX inteira — agregação por faixa, `suggested_dest`, ⌘K, ranking lexicográfico, `dup` como delight, mapeamento de CSS, fundamento da CSP.
**Enxertado de `minimal`:** `Pacer` com cold-down, sweep de searches no primeiro uso, decode probe antes de mover, quarentena oculta, localização do arquivo com estado `Manual`, tabela de cortes com gatilho de reabertura.

### Fraquezas apontadas — resolução

| # | Fraqueza (juiz) | Resolução |
|---|---|---|
| E1 | **Path de container Docker não endereçado** (blocker) | §5.2: campo local da API como fonte primária + tradução de prefixo configurável + fallback de varredura `mtime`+basename + estado terminal `Manual`. |
| E2 | `slsk_search` async de 8s com `ureq` bloqueante | §3.4: comando fire-and-forget devolve `search_id` em <5ms; worker faz o poll; frontend faz poll de `slsk_results` → resultados progressivos de graça. |
| E3 | Guard-rail sem cold-down | §6: `Pacer` da minimal com `empty_streak`/`cold_until`, mas com override (`force`) — resolvendo também a fraqueza da minimal (lock punitivo de 15 min). |
| E4 | Validação só `parse_flac` | §5.3: decode probe real (symphonia, primeiro packet) antes de mover. |
| E5 | Exagero "Rescan é descartado" | Corrigido no texto: `IndexerCommand::Rescan` chega por `cmd_tx` **unbounded e nunca é descartado**; o descarte (`"watch: scan already running, skipping"`, `pipeline.rs:250`) é só do canal do watcher. O ganho real do `IngestPaths` é custo, correlação path→track_id e observabilidade — não drop-risk. |
| E6 | `is_acceptable` derrubando 24/192 por kB/s | §4.4: filtro duro passa a ser por tamanho absoluto (2 MB–300 MB); coerência bytes/s vira **bônus de score**, não veto. |
| E7 | Evento `slsk:jobs` fora da convenção | Renomeado para `slsk-jobs` (kebab, como `player-state`, `theme-changed`, `audio-fft`). |
| E8 | `slsk_check_owned` redundante | Cortado do v1. |
| E9 | UX magra | Substituída pela da `produto` (§4). |
| E10 | `library_indexer::metadata` é `mod` privado (`lib.rs:17`) | Declarado: vira `pub mod metadata;` + `pub use metadata::{parse_flac, ParsedFlacMetadata};`. Mudança de superfície pública, explícita. |
| E11 | Sem auto-retry em job travado | §5.6: **1** retry automático de troca de fonte. Troca de fonte é `enqueue`, não `search` — não alimenta throttle. |
| E12 | v1 grande demais | Persistência reduzida ao mínimo irredutível (§3.6): só o mapa `job → dest` que o slskd não sabe. O estado vem da reconciliação. |
| P1 | **Produto validava depois de mover** | Resolvido por E4 — nada não-tocável encosta em `~/Music`. |
| P2 | Destino de 3 níveis reproduzindo `artist = www.ftpdjemilio.com` | §5.4: `canonical_dest` de 4 níveis. `extract_path_parts` (`scan.rs:151-152`) lê `dir_comps.first()` como genre e `.get(1)` como album_artist. |
| P3 | Teste de paridade mirando `query::norm` | §5.1: `query::norm` (`query.rs:326`) é `trim+lowercase+strip_accent` — normalização de **busca**. O dedup usa `dedup.rs` próprio (portado do Python: parênteses, `feat|ft|featuring|with|prod`). O teste compara o ranker com o `OwnedIndex`, nunca com o scorer de busca. |
| P4 | `.badge-fmt` só existe sob `.np__cover` | §4.2: extrair a regra base de `.badge-fmt` (`extractor-lab.css:650`) para uso genérico. `.dot--free`/`.dot--used` também são escopados (`.res-legend`, linhas 3091-3092) — não são reusáveis; o status usa `.sig-stat__dot` com `data-on`. |
| P5 | `playTrack` recebe `Track`, não id | §4.5: `Ready` guarda `track_id`; o botão faz `libGetTrack(id)` → `playTrack(track)`, ou `playerPlay(path, "crate", trackId)` (`tauri.ts:85`) quando só o path importa. |
| M1 | **Minimal perde o mapeamento job→playlist ao fechar o app** | Resolvido por E12: mapa persistido + reconciliação no boot. |
| M2 | Dedup raso (vaza em colaboração) | §5.1: `lookup_collab_aware`. |
| M3 | `rename` direto pro caminho final | Resolvido por `.rustify-incoming` (§5.4). |
| M4 | Cold lock de 15 min punitivo | §6.2: banner + "buscar mesmo assim", penalidade inicial de 10 min, escalonada só se reincidir. |
| M5 | `sk_download(group: SkGroup)` devolvendo o grupo inteiro pelo IPC | §3.5: o backend guarda o `ResultGroup` no `SearchStore`; o comando manda `search_id` + `group_key` + `source_id`. |
| M6 | Polling contra o padrão de eventos do repo | §3.5: **híbrido justificado** — busca por poll (ciclo de vida curto, atado à view), fila por evento `slsk-jobs` + `slsk_jobs()` no mount (ciclo longo, atravessa views, alimenta o badge com a view desmontada). |

---

## Arquitetura

### 3.1 Passo 0 — bloqueante antes de escrever o coordinator

Os nomes de campo da API v0 do slskd abaixo são a assunção de trabalho e **precisam ser confirmados contra a instância real** antes de qualquer parser. Meia hora que evita um dia de retrabalho, e as respostas viram as fixtures dos testes.

```bash
ssh cmr-auto@100.102.249.9 'bash -lc "
  T=\$(curl -s -X POST localhost:5030/api/v0/session \
      -H \"Content-Type: application/json\" \
      -d \"{\\\"username\\\":\\\"slskd\\\",\\\"password\\\":\\\"slskd\\\"}\" | jq -r .token)
  curl -s -H \"Authorization: Bearer \$T\" localhost:5030/api/v0/searches | jq \".[0]\"
  curl -s -H \"Authorization: Bearer \$T\" localhost:5030/api/v0/transfers/downloads | jq \".[0]\"
  curl -s -H \"Authorization: Bearer \$T\" localhost:5030/api/v0/options | jq \".web.authentication\"
"'
```

Quatro perguntas que o spike tem de responder, porque cada uma muda uma decisão:

1. `web.authentication.api_keys` existe? → API key (header estático) vence JWT (refresh + replay).
2. Shape de `responses[].files[]` — quais campos vêm `null` na prática (`bitDepth`, `sampleRate`, `length`).
3. Conjunto real de strings de `state` em `/transfers/downloads`.
4. **`GET /transfers/downloads` reporta o caminho LOCAL do arquivo baixado?** Se sim, é a fonte primária de §5.2 e a varredura vira só fallback.

Saída: `src-tauri/crates/slskd-client/tests/fixtures/*.json`.

### 3.2 Onde o código mora

```
src-tauri/
  Cargo.toml                          # members += "crates/slskd-client"
  crates/
    slskd-client/                     # NOVO — protocolo puro. Sem Tauri, sem Qdrant.
      src/
        lib.rs                        # trait SlskdApi + HttpSlskd (ureq)
        wire.rs                       # tipos serde — ÚNICO ponto de acoplamento à API
        auth.rs                       # API key ou JWT em memória; re-login single-shot
        rank.rs                       # PURO: group_key, score, filtros, guess_artist_title
        pacing.rs                     # PURO: Pacer (rate limit + cold-down), clock injetável
        stage_plan.rs                 # PURO: canonical_dest, sanitize_component
        error.rs
    library-indexer/src/
      lib.rs                          # `pub mod metadata;` + re-export parse_flac
      dedup.rs                        # NOVO — norm/artist_main/OwnedIndex (porta do Python)
      scan.rs                         # + pub fn entry_for_path(root, path) -> Option<FileEntry>
      types.rs                        # + IndexerCommand::IngestPaths { paths, reply }
      pipeline.rs                     # + braço no coordinator_loop
  src/
    lib.rs                            # + mod slsk;  + 9 entradas no generate_handler
    slsk/                             # NOVO — política. Conhece slskd + Qdrant + Tauri.
      mod.rs                          # State Slsk, #[tauri::command]s
      coordinator.rs                  # thread única: busca, transfers, stall, staging
      board.rs                        # JobBoard (RwLock, escritor único) + snapshot()
      stage.rs                        # incoming oculto, decode probe, move, quarentena
      config.rs                       # SlskConfig (env > arquivo > default)
src/
  views/Crate.tsx                     # NOVO
  store/crate.ts                      # NOVO — board + badge
  tauri.ts, router.tsx
  components/Sidebar.tsx, CommandPalette.tsx, Icon.tsx
  styles/extractor-lab.css            # ~130 linhas novas (components.css é órfão — não tocar)
```

Crate novo para o protocolo, módulo no app para a política. O crate segue o precedente literal do `library-indexer` (*"The crate has no dependency on Tauri"*, `lib.rs:6`) e permite `cargo test -p slskd-client` em segundos — `src-tauri/src/lib.rs` tem 4286 linhas e compilá-lo para testar um ranker é imposto de ciclo.

Nome do módulo Rust é `slsk` (não `crate`, que é keyword). O rótulo de UI é **Crate**.

### 3.3 Descoberta e autenticação

```rust
// slsk/config.rs
pub struct SlskConfig {
    pub base_url: String,             // default "http://127.0.0.1:5030"
    pub auth: SlskAuth,               // ApiKey | Password { user, pass }
    pub downloads_dir: PathBuf,       // default $HOME/slskd_dados/downloads
    pub container_prefix: Option<String>,  // ex.: "/downloads" -> downloads_dir
}
```

Precedência: env (`RUSTIFY_SLSKD_URL`, `_API_KEY`, `_USER`, `_PASS`, `_DOWNLOADS`) > `~/.local/share/rustify-player/slsk.json` (0600) > defaults `slskd/slskd`. Mesmo `data_dir` de themes e stations. Parse falho = default + `status.error`; **nunca panic** — o padrão de `panic!("Qdrant sidecar at {qdrant_url} did not become healthy within 30s")` (`lib.rs:2694`) é deliberadamente **não** repetido aqui: slskd fora do ar é um badge, nunca um boot quebrado.

Credencial e JWT vivem **só em memória** (`RwLock<Option<(String, Instant)>>`), nunca em disco, log ou `localStorage`. `Debug` de `SlskAuth` implementado à mão redigindo a senha.

**Nada disso passa pelo webview.** O `connect-src` em `tauri.conf.json` é `'self' ipc: http://ipc.localhost http://127.0.0.1:19876` — `:5030` não está lá e **não entra**. Todo tráfego slskd passa pelo Rust. Preserva o hardening de 2026-07-17 sem exceção.

Três estados distinguíveis (colapsá-los gera ticket de suporte):

| Estado | Mensagem | Ação do usuário |
|---|---|---|
| `reachable: false` | "o daemon Soulseek não responde em 127.0.0.1:5030" | subir o container |
| `reachable, !logged_in` | "credenciais do slskd recusadas" | conferir config |
| `logged_in, network != Connected` | "slskd de pé, mas fora da rede Soulseek" | esperar / conferir a conta `cmr-auto-rp` |

### 3.4 Estado no backend

```rust
// slsk/mod.rs
pub struct Slsk {
    cfg:      Arc<SlskConfig>,        // imutável pós-boot -> sem lock
    api:      Arc<dyn SlskdApi>,      // único estado mutável é o TokenCell (RwLock)
    board:    Arc<JobBoard>,          // RwLock, ESCRITOR ÚNICO (coordinator)
    searches: Arc<RwLock<SearchStore>>,   // search_id -> SearchSnapshot
    owned:    Arc<OwnedCache>,        // índice de dedup, TTL 60s
    pacer:    Arc<Mutex<Pacer>>,      // rate limit + cold-down
    cmd_tx:   Sender<SlskTask>,       // -> coordinator
}
```

Invariantes de concorrência, explícitas para a review:

1. **Nenhum comando IPC bloqueia.** Todo `#[tauri::command]` é leitura de lock ou `send` no canal — <5 ms. Toda I/O de rede vive na thread `slsk-coord`. Isso mata a fraqueza E2 na raiz: `ureq` bloqueante nunca roda dentro de um handler.
2. **Escritor único no board.** Comando muta estado só via `SlskTask`. Deadlock por ordem de locks é estruturalmente impossível — nenhum caminho adquire um segundo lock com o primeiro na mão. `upsert`/`transition` são `pub(crate)`.
3. **Uma thread para o app inteiro**, nome `slsk-coord` (mesmo padrão de `library-indexer-coord`, `media-controls`, `spectrum-emitter`). `select!` sobre `(cmd_rx, tick)`.

Cadência adaptativa:

```rust
const POLL_ACTIVE:  Duration = Duration::from_millis(1000);  // >=1 job ativo
const POLL_IDLE:    Duration = Duration::from_secs(5);       // jobs, nenhum ativo
// board vazio -> recv() bloqueante no cmd_rx: zero wakeup, zero CPU
const SEARCH_POLL:  Duration = Duration::from_millis(700);
const SEARCH_WINDOW:Duration = Duration::from_secs(25);
```

Polling e não SignalR: os hubs do slskd exigem handshake de negotiate + protocolo próprio, não há cliente maduro em Rust, e o alvo é um socket **loopback** com JSON de poucos KB. Semanas de trabalho para economizar ruído estatístico.

**`JobId` é determinístico**: `DefaultHasher` sobre `"{username}\u{1}{remote_filename}"` em hex — mesma filosofia de `path_to_id` (`types.rs:224`). Enfileirar o mesmo arquivo do mesmo peer duas vezes é idempotente.

### 3.5 Contratos IPC

Convenção do repo: comando `snake_case` prefixado por domínio (`lib_*`, `player_*`, `dsp_*`, `norm_*`) → **`slsk_`**. Argumentos em `camelCase` no `invoke` (Tauri converte); campos do payload em `snake_case`. **IDs u64 sempre string** (`serialize_u64_as_string`, `types.rs:214`).

```rust
// ── Status ──────────────────────────────────────────────────────────────
#[tauri::command] fn slsk_status(sl: State<Slsk>) -> SlskStatus;

// ── Busca (fire-and-forget; o coordinator dirige) ───────────────────────
#[tauri::command] fn slsk_search(
    sl: State<Slsk>, query: String, force: bool,
) -> Result<String, String>;
//  Ok(search_id) | Err("cooldown:8") | Err("cold:540") | Err("offline") | Err("busy")

#[tauri::command] fn slsk_results(sl: State<Slsk>, searchId: String) -> SearchSnapshot;
#[tauri::command] fn slsk_cancel_search(sl: State<Slsk>, searchId: String) -> Result<(), String>;

// ── Dedup pré-download (camada confiável: a string que o usuário digitou) ─
#[tauri::command] fn slsk_dedup_probe(lib: State<Library>, query: String) -> Vec<Track>;

// ── Download ────────────────────────────────────────────────────────────
#[tauri::command] fn slsk_download(
    sl: State<Slsk>, searchId: String, groupKey: String,
    sourceId: String, destPlaylist: String,
) -> Result<String, String>;                                     // job_id

#[tauri::command] fn slsk_jobs(sl: State<Slsk>) -> Vec<DownloadJob>;
#[tauri::command] fn slsk_try_other_source(sl: State<Slsk>, jobId: String) -> Result<String, String>;
#[tauri::command] fn slsk_cancel(sl: State<Slsk>, jobId: String) -> Result<(), String>;
#[tauri::command] fn slsk_clear_finished(sl: State<Slsk>) -> u32;
```

Nove comandos. `slsk_download` manda **referências** (`search_id` + `group_key` + `source_id`) — o `ResultGroup` completo já está no `SearchStore` do backend, o que resolve M5 e mantém os `alternates` disponíveis para `slsk_try_other_source` sem confiar num objeto vindo do webview.

Um evento só:

```rust
app.emit("slsk-jobs", board.snapshot());   // throttle 500ms, só quando dirty
```

Board inteiro, não diffs incrementais: dezenas de entradas, não milhares. Elimina a classe "UI dessincronizada porque perdeu um evento". Precedente direto: `PlayerSnapshot` + `get_state`.

**Híbrido busca-por-poll / fila-por-evento (resolve M6), justificado:** a busca tem ciclo de vida curto e atado à view — `setInterval` de 800 ms em `onMount`, morto em `onCleanup`, com resultados progressivos de graça. A fila tem ciclo longo, atravessa views e precisa alimentar o badge da sidebar com a view desmontada — evento + `slsk_jobs()` no mount para re-hidratar. O repo já tem o padrão de listener (`onPlayerState`, `onThemeChanged`, `onFft` em `tauri.ts:237-328`).

Tipos no wire:

```rust
#[derive(Serialize)] #[serde(rename_all = "snake_case")]
pub struct SearchSnapshot {
    pub state: SearchState,          // running | done | empty | failed | canceled
    pub elapsed_ms: u64,
    pub responses_seen: u32,
    pub groups: Vec<ResultGroup>,
    pub note: Option<String>,        // "a rede não devolveu nada — pode ser throttle"
}

#[derive(Serialize, Clone)] #[serde(rename_all = "snake_case")]
pub struct ResultGroup {
    pub group_key: String,
    pub display_title: String,
    pub display_artist: Option<String>,
    pub album_hint: Option<String>,
    pub duration_secs: Option<u32>,
    pub quality_label: String,       // "FLAC 24/96"
    pub owned: Option<OwnedVerdict>, // { track_id, title, artist } — dedup advisory
    pub suggested_dest: Option<String>,
    pub best: Candidate,
    pub alternates: Vec<Candidate>,  // ordenadas por score desc
}

#[derive(Serialize, Clone)] #[serde(rename_all = "snake_case")]
pub struct Candidate {
    pub id: String,                  // hash(username + filename)
    pub username: String,
    pub filename: String,            // caminho remoto completo (visível só na expansão)
    pub directory: String,           // habilita "baixar álbum" na fase 2, sem mudar contrato
    pub size: u64,
    pub bit_depth: Option<u16>,
    pub sample_rate: Option<u32>,
    pub bit_rate: Option<u32>,
    pub length_secs: Option<u32>,
    pub free_slot: bool,
    pub upload_speed: u64,
    pub queue_length: u32,
    pub score: i32,
    pub warn: Option<String>,        // "32-bit" | "parece live" | "duração destoa"
}

#[derive(Serialize, Clone)] #[serde(rename_all = "snake_case", tag = "kind")]
pub enum JobState {
    Queued,                                   // aceito localmente, aguardando slot
    Enqueued { queue_position: Option<u32> }, // slskd aceitou; fila do peer
    Downloading { pct: f32, bps: u64, eta_s: Option<u32> },
    Stalled { since_secs: u64 },
    Processing,                               // localizar + parse + decode probe + move
    Indexing,
    Ready { track_id: String },               // tocável AGORA
    Rejected { reason: RejectReason },        // decisão, não erro
    Manual { path: String, why: String },     // baixou; não deu pra mover — está AQUI
    Failed { reason: String, retryable: bool },
    Canceled,
}

#[derive(Serialize, Clone)] #[serde(rename_all = "snake_case")]
pub enum RejectReason {
    AlreadyOwned { track_id: String },
    Bit32Unsupported,
    NotFlac,
    Corrupt,
}
```

`Rejected` separado de `Failed` é deliberado: `AlreadyOwned` e `Bit32Unsupported` são decisões, não falhas. Colapsar em "erro" faria o usuário dar retry em coisa que nunca vai passar.

Onze estados soam muito para um v1 — mas `Processing` já colapsa três passos, e cada estado restante mapeia numa **ação diferente** do usuário. A UI agrupa em quatro cores (em voo / pronto / atenção / erro).

Wrappers em `src/tauri.ts` no padrão do arquivo:

```ts
export const slskStatus = () => invoke<SlskStatus>("slsk_status");
export const slskSearch  = (query: string, force = false) =>
  invoke<string>("slsk_search", { query, force });
export const slskResults = (searchId: string) =>
  invoke<SearchSnapshot>("slsk_results", { searchId });
export const slskDownload = (
  searchId: string, groupKey: string, sourceId: string, destPlaylist: string,
) => invoke<string>("slsk_download", { searchId, groupKey, sourceId, destPlaylist });
export const slskJobs = () => invoke<DownloadJob[]>("slsk_jobs");
export const onSlskJobs = (cb: (jobs: DownloadJob[]) => void) =>
  listen<DownloadJob[]>("slsk-jobs", (e) => cb(e.payload));
```

### 3.6 Persistência mínima e reconciliação

`~/.local/share/rustify-player/slsk_jobs.json` guarda **só o que o slskd não sabe**:

```json
[{ "job_id": "...", "username": "...", "remote_filename": "...",
   "dest_playlist": "Rap & Hip-Hop", "alternates": [...], "created_at": 1754... }]
```

O **estado** vem da reconciliação: no boot, cruza esse mapa com `GET /api/v0/transfers/downloads`. Isso resolve o buraco real das outras duas propostas (fechar o app com 12 downloads em voo perdia o destino e os arquivos ficavam órfãos em `~/slskd_dados/downloads` para sempre) sem carregar a máquina de estados inteira em disco — que era a crítica correta da `minimal` ("restaurar estado de staging parcial é uma classe inteira de bug").

Parse falho → mapa vazio + `warn!`, nunca panic (padrão de `persistence.rs`). Entradas terminais com mais de 7 dias são podadas no boot.

---

## UX e fluxo

### 4.1 Nome, lugar e portas de entrada

**Crate** — vocabulário de *crate digging*, nativo da cultura do acervo, coerente com a marca (logo cassete, tipografia editorial). "Downloads" ou "Soulseek" seriam nomes de utilitário.

Sidebar, em `PRIMARY` (`Sidebar.tsx:22-26`), logo abaixo de Search — porque **é** busca, só que além do acervo:

```
  Home
  Search           ⌘K
▸ Crate             3      ← badge de jobs ativos
  Library
```

Ícone: `lucide:package-open` em `ICONS` (`Icon.tsx:33`). A coleção lucide inteira já é bundlada offline (`src/icons-offline.ts` → `addCollection(lucide)`), então custo zero.

O badge `3` ocupa o slot visual do `⌘K` — classe nova `.nav-item__badge`, ~8 linhas herdando `--blue-bg`/`--blue-fg`. Some quando a fila esvazia. É o único elemento de Crate fora da view: feedback ambiente sem poluição.

**A porta que mais importa: ⌘K.** `CommandPalette.tsx` já tem `interface ActionItem { kind, id, title, sub, icon, run }` e `items()` já concatena `...actions()` no fim. Um `ActionItem` novo, sempre presente com query, promovido ao topo quando `tracks + albums + artists === 0` (o cômputo já existe em `hasResults()`):

```
  Procurar "sicko mode" na rede →        ⏎
```

`run: () => { navigate(`/crate/${encodeURIComponent(q)}`); close(); }`. O regex do router (`router.tsx:41`, `^(\/[a-z-]+)(?:\/(.+))?$`) já entrega `param` via `<Dynamic component={view()} param={route().param} />` — a view dispara a busca no mount. ~15 linhas, e é o gancho de descoberta inteiro: o usuário procura, não tem, e a saída está exatamente ali.

### 4.2 A view

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Crate                                          1.312 no acervo · 3 baixando     │
│  Busque na rede e traga pro acervo.                                              │
├──────────────────────────────────────────────────────────────────────────────────┤
│  [ Buscar 14 ]  [ Fila 3 ]                                                       │
├──────────────────────────────────────────────────────────────────────────────────┤
│  ⌕ travis scott astroworld               [ Buscar ]  ● rede ok   → Rap & Hip-Hop ▾│
│                                                                                  │
│  ⓘ Já tens no acervo: Travis Scott — STARGAZING (ASTROWORLD)          [▸ Tocar]  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ ⭳  SICKO MODE                    FLAC 16/44   7 fontes ▾   → Rap & Hip-Hop ▾ 5:12│
│    Travis Scott · ASTROWORLD                                          [ Baixar ] │
│                                                                                  │
│ ✓  STARGAZING                    no acervo                                  4:30│
│    Travis Scott · ASTROWORLD                                          [▸ Tocar]  │
│                                                                                  │
│ ⏱  R.I.P. SCREW                  FLAC 24/96   2 fontes ▾   fila do peer: 43     │
│    Travis Scott · ASTROWORLD                                    [ Trocar fonte ] │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Reaproveitamento verificado em `src/styles/extractor-lab.css`:

| Elemento | Classe | Linha |
|---|---|---|
| Header + hint + stats | `.view` `.view__head` `.view__head-hint` `.view__stats` | 397, 410, 411 |
| Abas com contador | `.tabs` `.tab` `.tab__count` | 893, 899, 912 |
| Busca | `.coll-toolbar` `.coll-search` | 2370, 2377 |
| Botão primário | `.pl-action-btn` (+ `--primary`) | 3173 |
| Lista | `.row-list` (grid próprio na linha, ver abaixo) | 562 |
| Chips | `.chip` / `.chip.active` | 915, 926 |
| Progresso | `.progress` `.progress__fill` | 1077, 1083 |
| Vazio | `.empty-state__title` `.empty-state__hint` | 440 |
| Mono (caminho remoto) | `.mono` | 163 |

Correções sobre o mapeamento original (P4): `.badge-fmt` só existe sob `.np__cover .badge-fmt` (linha 650) — extrair a regra base. `.dot--free`/`.dot--used` são escopados em `.res-legend` (3091-3092) e **não** são reusáveis; o status da rede usa `.sig-stat__dot` (1630) com `data-on` no pai. `.row` é grid de 5 colunas fixas (`40px 1fr 220px 120px 60px`, linha 563) — a linha do Crate precisa de grid próprio.

CSS novo (~130 linhas, bloco com section-comment no fim de `extractor-lab.css`): `.crate-row`, `.crate-row__sources`, `.crate-job`, `.crate-banner`, `.nav-item__badge`, `.badge-fmt` desacoplado.

Estados por `data-state` no elemento raiz da linha, pintados **só com tokens de tema** (`--blue-fg/bg` em voo, `--tone-butter-*` atenção, `--tone-mint-*` pronto). Nenhum hex literal — os 12+ temas seguem válidos e o checker WCAG do `load_theme` continua passando.

### 4.3 O fluxo, contado em cliques

**Caminho feliz — 2 cliques do zero à faixa tocável:**

1. `⌘K` → "sicko mode" → sem resultado local → `⏎` em "Procurar na rede"
2. `[ Baixar ]` na linha
3. — nada. `⏳ na fila` → `⭳ 34% · 1.2 MB/s` → `⚙ organizando` → `✓ na biblioteca [▸ Tocar]`

O passo 3 não tem clique. Se ele estiver noutra view, o badge conta; ao voltar, a linha já está verde.

**Teclado**, paridade com o palette: `⏎` busca; `↑↓` navega; `⏎` baixa (ou toca, se dup); `→` expande fontes; `⌫` cancela o job selecionado; `Esc` limpa.

**Busca nunca dispara on-input** — nem com debounce. Search-as-you-type contra a rede Soulseek é uma máquina de rajada. Não-negociável.

### 4.4 Agregação e ranking (`rank.rs`, puro)

Agregação:

1. Extrai `artist`/`title` de tags quando vierem, senão parse do filename (`.../Artist - Album/03 - Title.flac` e as variantes `03. Title`, `Artist - Title`) via `guess_artist_title`.
2. `group_key = dedup::norm(artist) + \u{1} + dedup::norm(title)` + bucket de duração de 5 s. **A mesma chave do `OwnedIndex`** — se divergirem, o dedup falha em silêncio (§9 tem o teste dedicado).
3. **Só `.flac`.** `is_flac` (`scan.rs:108`) é o gate do indexer; oferecer MP3 seria vender faixa que nunca entra na biblioteca. Chip informativo `só FLAC` na toolbar.
4. `duration_secs` = mediana; fontes fora de ±15 % ganham `warn: "duração destoa"` — sinal barato de live/extended.

**Filtros duros** (antes do score):

| Filtro | Motivo |
|---|---|
| extensão ≠ `flac` | o indexer não lê |
| `bit_depth == Some(32)` | symphonia não decodifica; o indexer pula em silêncio |
| `size < 2 MB` ou `> 300 MB` | sample/truncado, ou álbum inteiro num arquivo |

Correção de E6: coerência bytes/s **não** é filtro. FLAC 24/192 estéreo passa dos 800 kB/s com facilidade; como veto, derrubaria fonte legítima invisivelmente. Vira bônus.

**Score lexicográfico** (não soma ponderada — mais previsível e explicável na UI), pesos como `const` nomeadas:

| Critério | Peso |
|---|---|
| `bit_depth == 32` (quando escapa do filtro por vir `None`… nunca é `best`) | `-10_000` |
| filename casa `/(live\|remix\|extended\|instrumental\|sped.?up\|nightcore)/i` **e o termo não está na query** | `-5_000` |
| `free_slot` | `+3_000` |
| `queue_length` (saturado em 50) | `-20` cada |
| `bit_depth >= 24 && sample_rate >= 88_200` | `+400` |
| bytes/s coerente com duração (700–1500 kbps) | `+200` |
| `upload_speed` (+1 por 50 KB/s, teto `+600`) | desempate |
| similaridade título×query (`strsim`, já é workspace dep) | `+0..300` |

**Disponibilidade ganha de qualidade**, e é decisão de produto: 24/96 num peer com 43 na fila é uma faixa que ele não vai ouvir hoje. A expansão `▾ 7 fontes` inverte em um clique.

```
   ▾ 7 fontes
   ● slsk_user42   FLAC 16/44 · 38 MB · livre · 1.2 MB/s   …/ASTROWORLD/03 Sicko Mode.flac  [Usar]
   ○ dj_crates     FLAC 24/96 · 91 MB · fila 3 · 340 KB/s  …/Astroworld [24-96]/…           [Usar]
   ⚠ bootlegs_br   FLAC 16/44 · 52 MB · 7:41 — parece live                                  [Usar]
```

O caminho remoto completo aparece aqui, e só aqui. Válvula de escape do usuário experiente sem custo pro caminho normal — e é o ganho central da feature sobre o script: **ele escolhe a versão**.

### 4.5 Destino da playlist — o clique que some

Playlist = pasta de 1º nível de `~/Music` (`query::list_folders`, `query.rs:702`, exposto por `lib_list_folders`/`libListFolders`). O app já sabe onde cada artista mora.

`suggest_dest(artist, &owned_index)` roda **no mesmo passe do dedup**, custo zero, e chega pronto em `ResultGroup.suggested_dest`. Precedência:

1. **Override da busca** — o chip `→ Rap & Hip-Hop ▾` na toolbar define o destino de todas as linhas. É o `--map` do `stage_downloads.py` virando um clique por leva.
2. **Artista já no acervo** → a pasta onde ele está.
3. **Último destino usado** (`localStorage kv-crate-dest`).
4. **Nenhum** → chip `→ escolher ▾` em âmbar, e `[ Baixar ]` **abre o seletor em vez de baixar**.

O caso 4 herda a política `sem_mapa` do script ("melhor sobrar em downloads do que cair na playlist errada"): um clique a mais é mais barato que corrigir depois — e corrigir depois custa terminal, que é o que a feature veio abolir.

### 4.6 Estados visíveis

| Estado | A linha mostra | Ação primária |
|---|---|---|
| `idle` | `FLAC 16/44 · 7 fontes ▾ · → Rap & Hip-Hop ▾` | `[ Baixar ]` |
| `owned` | chip `no acervo` + a faixa local | `[▸ Tocar]` (menu `▾` mantém "baixar mesmo assim") |
| `queued` | `aguardando vaga` | `[ Cancelar ]` |
| `enqueued` | `na fila do peer · posição 4` | `[ Cancelar ]` `[ Trocar fonte ]` |
| `downloading` | `.progress` + `34% · 1.2 MB/s · ~40s` | `[ Cancelar ]` |
| `stalled` | âmbar · `sem progresso há 2 min · fila do peer: 43` | `[ Trocar fonte ]` |
| `processing` / `indexing` | `organizando e indexando…` | — |
| `ready` | verde · `em Rap & Hip-Hop` (+ sub-chip `analisando…` enquanto MERT pendente) | `[▸ Tocar]` |
| `rejected: already_owned` | `já tinhas — o arquivo ficou em downloads` | `[ Ir pra faixa ]` |
| `rejected: bit32` | `FLAC 32-bit — o player não decodifica` + caminho da quarentena | `[ Trocar fonte ]` |
| `rejected: not_flac/corrupt` | `arquivo inválido` | `[ Trocar fonte ]` |
| `manual` | `baixou, mas não achei o arquivo pra mover — está em <caminho>` | `[ Abrir pasta ]` |
| `failed` | `falhou: <motivo>` | `[ Tentar outra fonte ]` |

Duas escolhas de produto:

- **`owned` nunca bloqueia.** Remaster, versão alternativa e metadata errada existem. Dedup é aviso com default seguro.
- **`manual` existe.** Nunca perde o arquivo, sempre diz onde está.

O `[▸ Tocar]` do `ready`: `libGetTrack(track_id)` → `playTrack(track)` (`PlayerBar.tsx`), ou `playerPlay(path, "crate", trackId)` (`tauri.ts:85`) quando só o path importa.

---

## Pipeline pós-download e dedup

O `stage_downloads.py` deixa de ser passo manual e vira o final de cada job — **por job, não em lote**. Isso elimina de saída o bug que o próprio script documenta no docstring: no segundo `--apply`, o par de pior bitrate de um `dup_interno` vira `novo` (o melhor já saiu) e move duplicado. Aqui não há reclassificação do filesystem: cada job decide uma vez.

### 5.1 Dedup — duas camadas

`library-indexer/src/dedup.rs` (novo, `pub mod`), porta direta do Python:

```rust
pub fn norm(s: &str) -> String;          // lower, tira (..)[..], feat|ft|featuring|with|prod, pontuação
pub fn artist_main(s: &str) -> String;   // primeiro artista antes de & , x /

pub struct OwnedIndex { /* (artist_main, norm_title) -> track_id + folder */ }
impl OwnedIndex {
    pub fn build(client: &QdrantClient, music_root: &Path) -> Result<Self, IndexerError>;
    pub fn lookup(&self, artist: &str, title: &str) -> Option<OwnedVerdict>;
    pub fn lookup_collab_aware(&self, artist: &str, title: &str) -> Option<OwnedVerdict>;
    pub fn folder_for_artist(&self, artist: &str) -> Option<&str>;   // -> suggested_dest
}
```

`build` = `client.scroll_all_payloads(&["artist", "title", "path"])` (`qdrant_client.rs:787`) — ~1300 pontos, três campos, <200 ms. Cache `OwnedCache` com TTL 60 s + **invalidação explícita** após cada ingest bem-sucedido.

`lookup_collab_aware` reproduz o `is_owned` do `discover_tracks.py`: casa título + **interseção** de artistas, para que "family ties — Baby Keem & Kendrick Lamar" bata com o acervo que só tem "Baby Keem". Sem isso o dedup vaza em colaboração, que é metade do rap.

**Por que módulo próprio e não `query::norm` (P3):** `query::norm` (`query.rs:326`) é `trim + lowercase + strip_accent` e `squish` (`query.rs:334`) filtra alfanuméricos — normalização de **busca**, para casar o que o usuário digita. Reusá-la para dedup faria "Money Trees (feat. Jay Rock)" **não** casar com "Money Trees" no acervo — dedup mais fraco que o do script que estamos substituindo. São problemas diferentes; o teste de paridade compara o ranker com o `OwnedIndex`, nunca com o scorer de busca.

**Camada 1 (confiável), antes de baixar:** `slsk_dedup_probe(query)` reusa `query::search` com a string que o **usuário** digitou. Vira o banner "Já tens no acervo: X — Y" com `[▸ Tocar]`. Custo: uma chamada local, zero rede. Pega o caso real ("achei que não tinha, tinha") sem depender de parsear nome de arquivo remoto.

**Camada 2 (advisory), por grupo:** `guess_artist_title(filename)` → `OwnedIndex` → `ResultGroup.owned`. Já vem embutido no payload da busca (zero round-trip por linha, o que permite renderizar 40 resultados sem cascata de IPC). Parsing de filename da rede erra: falso positivo que **impede** o download é pior que falso negativo que gasta 30 MB. Por isso é aviso, nunca veto.

### 5.2 Localizar o arquivo baixado (o blocker de day-one)

O slskd roda em **Docker**, sanitiza nomes e reporta path de namespace de container. Prever o caminho local falha. Cascata de três degraus:

1. **Campo local da API** (`GET /api/v0/transfers/downloads`), se o spike confirmar que existe → traduzir o prefixo de container via `cfg.container_prefix` (ex.: `/downloads` → `~/slskd_dados/downloads`). Caminho determinístico, preferido.
2. **Fallback**: varredura de `cfg.downloads_dir` por `.flac` com `mtime > job.started_at` e basename casando (case-insensitive) com o basename remoto. Retenta por 30 s.
3. **`Manual { path: downloads_dir, why }`** se nada casar — estado terminal com o caminho na tela. Nunca perde o arquivo.

### 5.3 Verificar ANTES de mover

Nada não-tocável encosta em `~/Music`.

```rust
let md = library_indexer::parse_flac(&local)?;   // pub mod metadata + re-export
```

Uma chamada resolve quatro perguntas: (a) é FLAC de verdade? (erro → `Rejected{NotFlac|Corrupt}`); (b) `bit_depth == 32`? (→ `Rejected{Bit32Unsupported}`); (c) artista/título reais → `lookup_collab_aware` → `Rejected{AlreadyOwned}`; (d) destino canônico a partir das tags.

**Mais o decode probe** (enxerto da `minimal`): abrir com symphonia e decodificar o primeiro packet. `parse_flac` lê header e tags; o probe pega o arquivo que o peer mentiu ou que quebra no meio. É a diferença entre confiar no `bit_depth` reportado e verificar.

Rejeitados vão para `~/Music/.rustify-quarentena/<YYYY-MM-DD>/`. Diretório oculto → invisível para `walk_music_root` (`scan.rs:58`) e para o watcher (`watch.rs:163`), como o próprio teste `walk_skips_hidden_dirs` (`scan.rs:299`) já demonstra com `.quarentena`. Fica perto do acervo, fora do índice.

### 5.4 Destino canônico e move atômico

`scan.rs:151` deriva `genre` **exclusivamente do path** (`dir_comps.first()`) e `build_track_payload` (`pipeline.rs`) faz `let genre = entry.genre_from_path.clone().unwrap_or_default()`. Consequência dura: **a pasta de 1º nível escolhida na UI vira o `genre_name` da faixa.** E `dir_comps.get(1)` vira `album_artist_from_path` — é exatamente por isso que `~/Music/<Playlist>/<pasta-do-peer>/arquivo.flac` (o layout do script) produz `artist = www.ftpdjemilio.com`, o lixo documentado no CLAUDE.md.

Corrigido na origem, pelo mesmo custo de código:

```rust
// slskd-client/src/stage_plan.rs — PURO
pub fn canonical_dest(music_root: &Path, playlist: &str, md: &ParsedFlacMetadata) -> PathBuf;
//  <music_root>/<Playlist>/<Artist>/<YYYY - Album>/<NN - Title>.flac
//  fallbacks: sem album -> <Artist>/Singles ; sem artist -> _Compilations
pub fn sanitize_component(s: &str) -> String;   // / e \0 fora, trim, colapso, cap 120 bytes
```

É o layout que `scan.rs:7` documenta como canônico e que `parse_album_folder` já sabe ler. Ganho lateral: capa e agrupamento de álbum funcionam sem intervenção.

Move em três passos:

1. **Incoming oculto**: `music_root/.rustify-incoming/<job_id>.flac`. `rename` se mesma FS; `EXDEV` (`raw_os_error() == Some(18)`) → `fs::copy` + `File::sync_all()`. O arquivo pode ficar meio-escrito ali por minutos sem que watcher ou scan o vejam.
2. `create_dir_all(dest.parent())`.
3. `fs::rename(incoming, dest)` — **atômico garantido**, porque origem e destino estão sob `music_root`, mesma FS por construção. O arquivo materializa completo, num evento de inode.

Colisão em `dest`: **nunca sobrescreve**. Mesmo tamanho → `Rejected{AlreadyOwned}`. Tamanho diferente → sufixo ` (2)`. Nada é deletado, nunca — política herdada do script.

No boot, `.rustify-incoming/` é varrida e órfãos sem job vivo são apagados.

### 5.5 Indexação determinística

`IndexerCommand` ganha uma variante com reply channel:

```rust
// library-indexer/src/types.rs
pub enum IndexerCommand {
    Rescan,
    IngestPaths { paths: Vec<PathBuf>, reply: Sender<Vec<IngestOutcome>> },   // NOVO
    Shutdown,
}
pub struct IngestOutcome { pub path: PathBuf, pub result: Result<u64, String> }
```

**Por que reply channel e não `subscribe()` + escutar `TrackAdded`:** `IndexerHandle::subscribe()` (`lib.rs:114`) devolve `self.inner.evt_rx.clone()` — um clone de `Receiver` crossbeam, que é **MPMC**. Clones são consumidores **competidores**, não broadcast; dois assinantes roubariam eventos um do outro.

Braço novo no `coordinator_loop`, reusando tudo (`build_track_payload` + `path_to_id` + `upsert_tracks` + `EmbedJob` é exatamente o que `run_scan` faz por arquivo):

```rust
Ok(IndexerCommand::IngestPaths { paths, reply }) => {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        let r = scan::entry_for_path(&config.music_root, &p)
            .ok_or_else(|| "not a flac under music_root".to_string())
            .and_then(|e| build_track_payload(&config, &e).map(|pl| (e, pl)).map_err(|x| x.to_string()))
            .and_then(|(e, pl)| {
                let id = path_to_id(&e.path);
                client.upsert_tracks(&[(id, pl, None)]).map_err(|x| x.to_string())?;
                let _ = embed_job_tx.send(EmbedJob { track_id: id, path: e.path.clone() });
                Ok(id)
            });
        out.push(IngestOutcome { path: p, result: r });
    }
    state.refresh(&client);
    let _ = reply.send(out);
}
```

`scan::entry_for_path` é refactor mecânico: `extract_path_parts` já é função livre; o corpo do closure de `walk_music_root` vira `entry_for_path` e o walk passa a chamá-la. Sem duplicação.

**Ganho real (corrigido, E5):**

| | `Rescan` | `IngestPaths` |
|---|---|---|
| Custo por faixa | `WalkDir` na árvore inteira + `scroll_all_payloads` de ~1300 pontos | 1 `parse_flac` + 1 upsert |
| Correlação path→track_id | não (exige poll de `get_track_by_path` com timeout) | `Result<u64, String>` por path |
| 30 faixas de um álbum | 30 scans completos (ou 1 com debounce) | 1 comando, 30 outcomes |

O comando `Rescan` em si **nunca é descartado** — chega pelo `cmd_tx` unbounded. O descarte (`pipeline.rs:250`) é só do canal do **watcher** quando há scan em curso.

O coordinator do Crate agrupa por 3 s de ociosidade: um álbum inteiro vira um `IngestPaths` só.

O watcher continua sendo a rede de segurança para arquivos que chegam por fora do app (`rsync`, `mv` manual). Só deixa de ser o caminho crítico.

**MERT** roda async como já roda (`embedding_status: pending → done`). A faixa toca antes de estar embeddada; a linha `ready` mostra um sub-chip `analisando…` que some sozinho — expectativa gerenciada sem bloquear nada.

### 5.6 Falhas e travadas

| Situação | Detecção | Ação |
|---|---|---|
| Fila remota longa | `Enqueued` >300 s sem `queue_position` decrescer | `Stalled` + `[Trocar fonte]` |
| Peer para no meio | `bytes_done` parado 120 s em estado ativo | `Stalled` + `[Trocar fonte]` |
| slskd reporta erro | `state` contém `Errored`/`TimedOut` | **1** retry automático na próxima fonte não tentada; a 2ª falha vira `Failed` visível |
| slskd cai | poll → connection refused | jobs ativos → `Failed{retryable}`, badge offline, banner |
| App fecha com download em voo | — | slskd continua; boot reconcilia (§3.6) |
| Qdrant fora no ingest | `IngestOutcome::Err` | fica em `Indexing` com `retry_after`; 5 tentativas a cada 30 s |

Teto de **1** retry automático por job. `tried_source_ids` no job impede repetir a mesma fonte. Troca de fonte é `enqueue`, não `search` — não alimenta o throttle de busca.

Arquivos parciais em `~/slskd_dados/incomplete/` são do slskd; não mexemos.

---

## Guard-rails de rede

Todos vivem em `pacing.rs` (puro, clock injetável) e são aplicados **no backend, não na UI** — a UI é substituível e o MCP bridge chama comandos direto; guard-rail em UI seria decorativo.

```rust
const SEARCH_MIN_INTERVAL: Duration = Duration::from_secs(4);
const SEARCH_BURST:        u32      = 2;
const SEARCH_MAX_PER_HOUR: usize    = 40;
const EMPTY_STREAK_TRIP:   u8       = 3;
const COLD_BASE:           Duration = Duration::from_secs(10 * 60);   // dobra ao reincidir, teto 60min
const SEARCH_WINDOW:       Duration = Duration::from_secs(25);
const SEARCH_HISTORY_CAP:  usize    = 50;
const MAX_ACTIVE_TRANSFERS:usize    = 3;
const JOBS_RETAINED:       usize    = 50;   // terminais, FIFO
```

### 6.1 Pacing

- **Uma busca em voo por vez.** Campo desabilita, botão vira spinner com **barra determinada** contra a janela de 25 s — progresso honesto em vez de spinner infinito.
- **Intervalo mínimo de 4 s**, exibido como anel de progresso preenchendo no botão. Nunca um toast de erro: é micro-espera visível, não repreensão.
- **Zero busca automática.** Sem on-type, sem re-busca ao abrir a view, sem retry automático de busca. Toda busca tem um clique humano atrás.
- Sair da view cancela a busca (`DELETE` no slskd).

### 6.2 Detector de rede fria (com escape)

Três buscas seguidas com **zero** responses (termo ≥3 chars, slskd `Connected/LoggedIn`) → `cold_until = now + COLD_BASE`, banner âmbar:

> A rede Soulseek parou de responder (3 buscas seguidas em branco). Pausado por 9 min — **isso é da rede, não do app**.
> `[ Buscar mesmo assim ]`

Este é o guard-rail de maior valor por linha. O modo de falha do Soulseek é o **silêncio**, indistinguível de bug: sem essa mensagem o CEO conclui que a rede é pobre e abandona a feature.

O botão `[ Buscar mesmo assim ]` → `slsk_search(query, force: true)`, que ignora o cold mas **não** o `MIN_INTERVAL`. Resolve M4: três queries legitimamente obscuras em sequência (cenário real em curadoria de deep cut) não trancam a feature. Se a busca forçada também vier vazia, a penalidade dobra (10 → 20 → 40, teto 60 min).

### 6.3 Higiene de searches (mata o 409 na raiz)

Três camadas, e a terceira é a que herda o passivo:

1. **`DELETE /api/v0/searches/{id}` sempre após colher**, inclusive nos caminhos de erro e timeout — guard RAII (`struct SearchGuard(Arc<dyn SlskdApi>, String)` com `Drop`), mesmo padrão do `ScanGuard` (`pipeline.rs:274`).
2. **Sweep no primeiro uso da sessão** (não só no boot — se o app subiu antes do slskd, o sweep de boot passa em branco): `GET /api/v0/searches` → deleta tudo além das 50 mais recentes ou com mais de 1 h. Herda as 1270 buscas acumuladas do incidente de 17/07 sem intervenção humana.
3. **Recuperação de 409**: prune agressivo + **1** retry. Só depois vira mensagem, e nunca como número HTTP: "o slskd estava com o histórico cheio — limpei o que deu, tenta em instantes".

Restart do container não limpa (persiste em disco). O app limpa.

### 6.4 Downloads

Cap de **3** concorrentes, fila FIFO local; o resto fica `Queued` no board. Protege contra burst e mantém a ETA honesta. Jobs terminais retidos em memória: 50 (FIFO) — o board não cresce sem limite numa sessão longa.

---

## Fases de entrega

### v1 — o valor inteiro

Ordem de implementação:

0. **Spike da API** (§3.1) → fixtures.
1. `crates/slskd-client`: `SlskdApi` + `HttpSlskd`, `wire`, `auth`, `rank`, `pacing`, `stage_plan`.
2. `library-indexer`: `pub mod metadata`, `dedup.rs`, `scan::entry_for_path`, `IndexerCommand::IngestPaths`.
3. `src-tauri/src/slsk/`: config, board, stage, coordinator, 9 comandos, persistência mínima + reconciliação.
4. `src/views/Crate.tsx`, `store/crate.ts`, wrappers em `tauri.ts`, CSS.
5. Rota `/crate`, item de sidebar com badge, `ActionItem` no `CommandPalette`.

Cobre ponta a ponta: conexão automática + status → busca com pacing → resultados agregados por faixa, FLAC-only, ranqueados → dedup pré-download (banner + hint) → destino sugerido por artista + override global → download com escolha de fonte → fila com progresso, stall e troca de fonte → localizar → verificar (parse + decode probe) → dedup pós-download com tags reais → move atômico → `IngestPaths` → **`▸ Tocar`**.

Estimativa honesta: **~1500 linhas Rust, ~550 TSX, ~130 CSS**. O grosso é o coordinator e a view.

### FORA do v1 — corte explícito, com gatilho de reabertura

| Corte | Por quê | Gatilho |
|---|---|---|
| Baixar **álbum/pasta inteira** | Multiplica o risco (N transfers, N staging, N falhas parciais). `Candidate.directory` já vai no wire, então o custo depois é só UI. | v1 estável na mão do usuário |
| **Escolha de peer como fluxo primário** | O ganho é escolher a *versão*; qual peer serve é decisão de máquina. A expansão `▾` já cobre o caso manual. | reclamação recorrente de fonte ruim |
| MP3 / M4A / qualquer não-FLAC | `scan.rs:108` só aceita `.flac`. Aceitar exigiria mexer no indexer — outra feature. | decisão de produto sobre mp3 |
| **Transcode** de FLAC 32-bit → 24-bit | Exige ffmpeg como dep de runtime. v1 rejeita com motivo visível. | se doer na prática |
| **UI de credenciais** do slskd (host/porta/senha) | Uma máquina, um slskd; defaults + env resolvem. Settings mostra só status + "Testar conexão". | segunda instalação |
| Wishlist / busca agendada / auto-download | Automação recorrente é o padrão que já queimou a rede. | — |
| Browse de pasta de peer (nicotine-style) | Superfície de API inteira nova, zero sinal de demanda. | — |
| Integração do **`music-curator`** dentro do app | Depende do v1 estabilizado. Quando vier, é barato: o curator só precisa produzir `DownloadPick[]`. | v1 validado |
| Multi-seleção, "baixar tudo", drag-and-drop | YAGNI. | pedido explícito |
| Rating/blacklist de peers, download de capa, notificação de desktop | YAGNI. | — |
| Supervisão/auto-start do slskd | Docker/systemd é dono do ciclo de vida. | provavelmente nunca |

### Fase 2 — álbum e multi-seleção

O peer serve pastas e `Candidate.directory` já está no payload: agrupar por diretório do peer e oferecer `▾ baixar álbum (12 faixas)` quando ≥4 FLACs compartilham diretório e tag de álbum. Um `POST` com a lista inteira. Resolve o caso Travis/Astroworld sem MusicBrainz e sem CSV — absorve o `expand_albums.py`. Junto: `⇧+click` e botões "buscar mais deste artista na rede" em Artist/Album.

### Fase 3 — o Crate fica esperto

Wishlist com pacing (o que não achou hoje procura amanhã, respeitando o cold). Curator dentro do app: sugestões do subagente chegam como linhas prontas do Crate, aprovação por clique. Re-encode de 32-bit. Aí o app substitui o pipeline de terminal inteiro.

---

## Riscos e mitigações

| # | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | **Schema da API do slskd diferente do assumido** | Alta | Médio | Spike bloqueante (§3.1) → fixtures. Todo wire type com `#[serde(default)]`, sem `deny_unknown_fields`. Estados de transfer classificados por substring em `classify_transfer_state(&str)` — função pura, ajustável em 1 linha. |
| R2 | **Path de container Docker** | Alta | Alto | Cascata de 3 degraus (§5.2) terminando em `Manual` com o caminho na tela. |
| R3 | Throttle da rede → resultados vazios silenciosos | Alta | Alto (parece bug) | §6.2: cold-down com banner nomeando a causa **e** escape por `force`. |
| R4 | 409 por histórico cheio | Média | Alto | §6.3: guard RAII + sweep no 1º uso + retry. Estrutural, não operacional. |
| R5 | Peer que enfileira para sempre | Alta | Médio | Stall detector + 1 retry automático + `[Trocar fonte]`. |
| R6 | Fuzzy trazendo live/remix | Alta | Baixo | Derank por keyword (só quando o termo não está na query) + `warn` de duração destoante + caminho remoto visível. Não elimina — mas o usuário **escolhe**, que é o ganho central. |
| R7 | FLAC 32-bit indexado em silêncio (**bug de hoje**) | Certa | Alto | Filtro duro + decode probe antes de mover + `Rejected{Bit32Unsupported}` + quarentena oculta. |
| R8 | Race do watcher perdendo subpasta nova | Média | Alto | `.rustify-incoming` + rename atômico + `IngestPaths` explícito. Watcher é best-effort. |
| R9 | `rename` cross-device | Baixa | Alto | Detecção de `EXDEV` + copy+`sync_all`. Testado com `tempfile`. |
| R10 | Dedup falso-positivo (remaster/versão) | Média | Baixo | Aviso, não bloqueio; "baixar mesmo assim" no menu. |
| R11 | Custo do `OwnedIndex` por busca | Média | Baixo | ~1300 pontos, 3 campos, cache 60 s. Reavaliar acima de 20k faixas. |
| R12 | Board persistido corrompido | Baixa | Baixo | Parse falho → mapa vazio + `warn!`. Nunca panic. |
| R13 | `IndexerCommand` ganha variante → quebra `match` | Certa | Trivial | Intencional: o compilador aponta o único call-site. Enum interno, não serializado. |
| R14 | Vazamento do `evt_rx` (**pré-existente**) | Baixa, crescente | Baixo | Achado colateral: o único `subscribe()` em `src-tauri/src/lib.rs` é `engine.subscribe()` (linha 2862) — ninguém drena o `evt_rx` do indexer, que é unbounded e acumula desde o boot. **Não** introduzido aqui, e o desenho evita agravar (reply channel, não `subscribe()`). Corrigir em commit separado. |
| R15 | Superfície de rede | Baixa | Médio | Nada novo escuta. O app é **cliente** de `127.0.0.1:5030`. CSP inalterada. Credencial nunca em log. |
| R16 | Segundo `--apply` re-move duplicata (gotcha do script) | — | — | Não existe: cada job decide uma vez, contra o índice atual. Sem passada em lote sobre diretório. |

---

## Testes

### Sem rede, sem slskd, sem Qdrant (o grosso)

**`cargo test -p slskd-client`** — sobre as fixtures do spike:

- `rank::aggregate_collapses_same_track_across_peers` — 40 responses → N faixas
- `rank::aggregate_drops_non_flac`
- `rank::score_prefers_free_slot_over_hi_res`
- `rank::score_never_elects_32bit_as_best` (mantém na lista com `warn`)
- `rank::score_deranks_live_unless_query_asks_for_live`
- `rank::filters_reject_by_absolute_size_not_bytes_per_second` — 24/192 legítimo **passa** (regressão de E6)
- `rank::guess_artist_title` — `01 - Smino - Anita.flac` → (Smino, Anita); `Anita.flac` → None
- `pacing::cooldown_with_injected_clock`; `pacing::41st_search_in_hour_blocked`; `pacing::three_empty_trips_cold`; `pacing::force_bypasses_cold_not_min_interval`; `pacing::cold_penalty_doubles_on_reincidence`
- `stage_plan::canonical_dest_builds_four_level_path`; `..._suffixes_on_collision`; `sanitize_component` (barra no álbum, título vazio, unicode, cap)
- `classify_transfer_state` — tabela string → `JobState`
- `can_transition` — matriz de transições legais/ilegais
- Sobre `FakeSlskd` (impl do trait, respostas roteirizadas): `401 → re-login → ok`; `401 duplo → erro`; `409 → sweep → retry → ok`; **`search_guard_deletes_even_on_error_path`** (o teste que garante que o incidente do 409 não volta); `job_transitions_queued_downloading_ready`; `job_marks_stalled_after_120s` (relógio injetado, sem `sleep`); `job_auto_retries_once_then_fails`; `max_active_transfers_holds_fourth_in_queued`; `boot_reconciliation_restores_dest_playlist`

**`cargo test -p library-indexer`**:

- `dedup::norm` / `artist_main` — casos do Python portados como tabela (parênteses, `feat.`, acentos)
- `dedup::lookup_collab_aware_matches_partial_artist` — "Baby Keem & Kendrick Lamar" bate com acervo só-Baby-Keem
- **`dedup_key_matches_owned_index_key`** — o teste crítico: a chave que `rank::group_key` gera é a mesma que `OwnedIndex::build` indexa. Regressão que quebraria o dedup em silêncio. Compara os dois lados do `dedup.rs`, **nunca** com `query::norm`.
- `scan::entry_for_path_matches_walk_music_root` — o helper novo produz o mesmo `FileEntry` que o walk
- `ingest_paths_returns_track_id_per_path` / `..._reports_error_for_non_flac`

**Com `tempfile`** (já é dev-dep):

- `stage_file_same_fs_renames_atomically`
- `stage_file_cross_device_falls_back_to_copy_sync`
- `stage_file_collision_same_size_rejects` / `different_size_suffixes`
- **`rustify_incoming_is_invisible_to_walk_music_root`** — assert contra a função **real**, não um mock
- `quarantine_dir_is_invisible_to_walk_music_root`
- `boot_cleans_orphan_incoming_files`

**Frontend** (`vitest` + `@solidjs/testing-library`, padrão de `Stations.test.tsx` / `Settings.test.tsx`, com `vi.mock("../tauri")`) — `src/views/Crate.test.tsx`:

- renderiza uma linha por `ResultGroup`, com badge de formato e chip de fontes
- linha `owned` mostra "no acervo" + Tocar, e **não** mostra Baixar
- linha sem `suggested_dest` mostra "escolher" e clicar em Baixar **abre o seletor** em vez de chamar `slskDownload`
- Enter dispara `slskSearch`; **digitar não dispara** (guarda contra regressão do on-type)
- banner de cooldown aparece com `slskSearch` mockado devolvendo `Err("cooldown:8")`; `[Buscar mesmo assim]` chama `slskSearch(q, true)`
- evento `slsk-jobs` transiciona a linha para `ready` e habilita `▸`
- override de destino na toolbar propaga para todas as linhas; persiste em `kv-crate-dest`
- poll de resultados para no `onCleanup` (spy de `clearInterval`)

### Só com slskd de verdade (manual, roteirizado)

`docs/soulseek/manual-qa.md`, rodado uma vez por release da feature: busca com resultado; busca vazia; download completo até tocar; faixa que já está no acervo; troca de fonte num peer com fila; slskd derrubado no meio; leva de 20 faixas. Probes via túnel SSH (`ssh -f -N -L 9223:localhost:9223 cmr-auto@100.102.249.9`).

### Portões antes de commitar

`npm run typecheck` · `npm test` · `cargo check --manifest-path src-tauri/Cargo.toml` · `cargo test`. `cargo check` pontual durante o trabalho; **uma única** compilação de release ao final via `./scripts/release.sh`, conforme a regra do projeto.

---

## Fora de escopo (do design inteiro, não só do v1)

- Substituir ou gerenciar o slskd (shares, uploads, config da conta `cmr-auto-rp`, ciclo de vida do container).
- Qualquer formato que o indexer não leia — a barreira é `scan.rs:108`, e mudá-la é outra feature com outro design.
- Reorganizar o acervo existente. `canonical_dest` de 4 níveis vale para **o que a feature escreve**; migrar o que já está lá é decisão separada do usuário.
- Alterar a política de embedding/MERT. A faixa entra `pending` e o worker existente resolve.
- Expor qualquer porta nova. O app segue cliente loopback; o hardening de 2026-07-17 não é tocado.
- Substituir o `music-curator`. Ele continua sendo o motor de **descoberta**; o Crate é o de **aquisição**. A ponte entre os dois é fase 3.

---

**Arquivos-chave lidos e verificados para este design:** `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs` (23, 617-684, 2640-2760, 2862, 3178+), `src-tauri/crates/library-indexer/src/{lib.rs,types.rs,scan.rs,watch.rs,pipeline.rs,query.rs,metadata.rs,retry.rs,qdrant_client.rs}`, `src/{tauri.ts,router.tsx}`, `src/components/{Sidebar.tsx,CommandPalette.tsx,Icon.tsx}`, `src/icons-offline.ts`, `src/styles/extractor-lab.css`, `scripts/curator/stage_downloads.py`, `vitest.config.ts`, `package.json`.